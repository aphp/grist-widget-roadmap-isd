/**
 * Contrôleur des fenêtres de création (« Nouvelle tâche », « Sous-tâche », « Nouveau chantier ») et du
 * changement de chantier d'une tâche (lot 2c). Les valeurs viennent de core/create-form.js, les envois de
 * core/task-session.js (runCreate, runMove) et donc du writer : aucune action Grist n'est construite ici.
 * La saisie est conservée en cas de refus ; Échap demande confirmation s'il reste une saisie. Tâches : bloc
 * « Personnes » de la fiche (ui/people-block.js), assignés et charges envoyés dans la même création.
 */
import {
  creePar,
  droppedPeople,
  movePlan,
  newChantierDraft,
  newChantierFields,
  newTaskDraft,
  newTaskFields,
  overCapTeamIds,
  parseTarget,
  setNewMilestone,
  validateNewChantier,
  validateNewTask,
} from '../core/create-form.js';
import { failureKind, runCreate, runMove } from '../core/task-session.js';
import { createDialogRight, rightFailure } from '../core/write-rights.js';
import { EncodeError, dayFromInput } from '../core/write-encode.js';
import { label } from '../labels.js';
import { openDialog } from './dialog.js';
import { dialogFoot, moveBody, newChantierBody, newTaskBody, peopleHelp } from '../views/create-form.js';
import { chargesFootHtml, fieldLabel, valueText } from '../views/task-form.js';
import { createPeopleBlock, peopleState } from './people-block.js';

const MORE_KEY = 'roadmap-isd.createMore';
const TITLES = Object.freeze({
  task: 'create.task.title',
  subtask: 'create.subtask.title',
  chantier: 'create.chantier.title',
  move: 'move.title',
});
const FIRST = Object.freeze({
  task: 'cf-titre',
  subtask: 'cf-titre',
  chantier: 'cf-Nom_du_chantier',
  move: 'cf-cible',
});
const ORDER = Object.freeze([
  'titre',
  'Nom_du_chantier',
  'cible',
  'Projets',
  'parentTask',
  'statut',
  'Statut',
  'dateDebut',
  'dateEcheance',
  'Debut',
  'Fin',
  'assignees',
  'charges',
  'Responsable',
  'Contributeurs',
]);
/** Contrôle à focaliser pour une erreur, quand ce n'est pas « cf-<champ> ». */
const FOCUS = Object.freeze({ charges: 'cf-people-title' });
const OK = Object.freeze({ ok: true, reason: 'ok' });

/**
 * @param {{getModel():object, getWriter():object|null, getPrefs():object, storage:Storage, toast:{show:Function},
 *   onWritten(entry:object):void, onUndo():void, openForm(ref:object):void, onSessionReadOnly(reason:string):void,
 *   afterMove(ref:object):void, afterCreate(entry:object):void, fetchRow(table:string, id:number):Promise<object|null>,
 *   onUnknown():void, timeoutMs():number, onAddRefused?():void, readTable?(table:string):Promise<object>}} deps
 */
export function createCreateDialog(deps) {
  let st = null;
  let dlg = null;

  const model = () => deps.getModel();
  const writer = () => deps.getWriter();

  function moreOpen() {
    try {
      return deps.storage.getItem(MORE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function validate() {
    const m = model();
    if (st.kind === 'move') {
      const { chantierId, projectId } = parseTarget(st.target);
      const plan = chantierId ? movePlan(m, st.taskId, chantierId, projectId) : { error: 'none' };
      st.plan = plan.error ? null : plan;
      st.count = plan.error ? countSubtasks() : plan.count;
      const key =
        { none: 'form.error.chantierRequired', same: 'move.error.same' }[plan.error] ?? `move.error.${plan.error}`;
      st.validation = { errors: plan.error ? { cible: { key } } : {}, warnings: [] };
    } else if (st.kind === 'chantier')
      st.validation = validateNewChantier(st.draft, { model: m, statuses: m.statuses.chantiers });
    else {
      st.validation = validateNewTask(st.draft, { model: m, statuses: m.statuses.tasks });
      // Charges au-dessus de la borne (dates changées après la saisie) : lignes signalées et focalisables
      st.overCap = new Set(overCapTeamIds(st.draft, m));
    }
    for (const f of st.badDates) st.validation.errors[f] = { key: 'form.error.date' };
    // Charge saisie invalide sur une ligne du bloc « Personnes » : signalée tout de suite, bloque la création
    if (st.chargeErrors?.size) {
      st.validation.errors.charges = { key: 'form.error.charges' };
      st.touched.add('charges');
    }
    // Erreurs montrées : champs déjà touchés, ou toutes après une tentative d'envoi (pas d'erreur à l'ouverture)
    st.allErrors = st.validation.errors;
    st.validation.errors = Object.fromEntries(
      Object.entries(st.allErrors).filter(([f]) => st.tried || st.touched.has(f)),
    );
  }

  /** Sous-tâches qui suivront (affiché tant qu'aucun chantier d'arrivée n'est choisi). */
  function countSubtasks() {
    const seen = new Set();
    const stack = [...(model().tasks.get(st.taskId)?.childIds ?? [])];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(model().tasks.get(id)?.childIds ?? []));
    }
    return seen.size;
  }

  const errorCount = () => Object.keys(st.validation.errors).length;
  const body = () =>
    st.kind === 'move'
      ? moveBody(st, model())
      : st.kind === 'chantier'
        ? newChantierBody(st, model())
        : newTaskBody(st, model());

  function render(focusId) {
    validate();
    dlg.update(body(), dialogFoot(st, errorCount()), focusId);
  }

  /** Mise à jour légère pendant la frappe : messages et pied, sans toucher aux champs. */
  function refresh() {
    validate();
    const rendered = document.createElement('div');
    rendered.innerHTML = body().toString();
    for (const box of rendered.querySelectorAll('.tf-msgs[id]')) {
      const live = document.getElementById(box.id);
      if (live) live.innerHTML = box.innerHTML;
    }
    for (const f of ORDER) {
      const ctl = document.getElementById(`cf-${f}`);
      if (!ctl) continue;
      if (st.validation.errors[f]) ctl.setAttribute('aria-invalid', 'true');
      else ctl.removeAttribute('aria-invalid');
      ctl.closest('.tf-field')?.classList.toggle('fr-input-group--error', Boolean(st.validation.errors[f]));
    }
    // Section « Personnes » (data-field="charges") : bordure d'erreur et lignes invalides mises à jour pendant la frappe
    const box = document.getElementById('cf-people');
    box?.classList.toggle(
      'fr-input-group--error',
      Boolean(st.validation.errors.charges || st.validation.errors.assignees),
    );
    for (const input of box?.querySelectorAll('[data-charge-input]') ?? []) {
      const teamId = Number(input.dataset.chargeInput);
      if (st.chargeErrors?.has(teamId) || st.overCap?.has(teamId)) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    const chFoot = document.getElementById('cf-charges-foot');
    if (chFoot) chFoot.innerHTML = chargesFootHtml(st, model()).toString();
    refreshFoot();
  }

  /**
   * Pied mis à jour sur place : la région « aria-live » #cf-pending garde son nœud (seul son contenu change), les
   * boutons gardent le leur. Pied reconstruit seulement si sa forme change (confirmation d'abandon).
   */
  function refreshFoot() {
    const foot = dlg.root.querySelector('.cdlg__foot');
    if (!foot) return;
    const next = document.createElement('div');
    next.innerHTML = dialogFoot(st, errorCount()).toString();
    const pending = foot.querySelector('#cf-pending');
    const fresh = next.querySelector('#cf-pending');
    if (!pending || !fresh) {
      foot.innerHTML = next.innerHTML;
      return;
    }
    pending.innerHTML = fresh.innerHTML;
    for (const b of next.querySelectorAll('button[id]')) {
      const old = foot.querySelector(`#${b.id}`);
      if (old) old.disabled = b.disabled;
    }
  }

  /**
   * Bloc « Personnes » (tâche, sous-tâche) : même contrôleur que la fiche. Le brouillon n'est pas encore une ligne
   * de la Feuille : les droits sont relus à l'envoi (createDialogRight), pas à chaque modification.
   */
  const people = createPeopleBlock({
    state: () => st,
    getModel: model,
    storage: deps.storage,
    applyDraft: (next) => {
      if (!st || st.busy) return false;
      st.draft = next;
      st.touched.add('assignees');
      st.touched.add('charges');
      return true;
    },
    validate: () => validate(),
    refresh: () => refresh(),
    blockOpts: () => ({ help: peopleHelp(st) }),
  });
  const hasPeople = () => st && (st.kind === 'task' || st.kind === 'subtask');

  /** Une saisie a-t-elle été faite depuis l'ouverture ? */
  const dirty = () => JSON.stringify(st.draft ?? st.target) !== st.initial;

  function close() {
    st = null;
    dlg?.close();
    dlg = null;
  }

  function requestClose() {
    if (!st || st.busy) return;
    if (!dirty() || st.locked) return close();
    st.leave = true;
    render('cf-leave-continue');
  }

  /**
   * Ouvre une fenêtre.
   * @param {'task'|'subtask'|'chantier'|'move'} kind
   * @param {{chantierId?:number|null, projectId?:number|null, parentId?:number|null, status?:string|null,
   *          me?:number|null, taskId?:number}} ctx
   */
  function open(kind, ctx = {}) {
    const w = writer();
    if (!w || dlg) return false;
    const table = kind === 'chantier' ? 'Chantiers' : 'Tasks';
    if (!createDialogRight(w, kind, table).ok) return false;
    const m = model();
    st = {
      kind,
      table,
      prefix: 'cf',
      mode: w.mode,
      busy: false,
      fail: null,
      leave: false,
      locked: false,
      badDates: new Set(),
      touched: new Set(),
      tried: false,
      moreOpen: moreOpen(),
      // Assignés et charges : colonnes permises à la création par le writer (sinon le bloc les montre bloquées)
      can: (f) =>
        (f !== 'assignees' && f !== 'charges') || w.canAddField(table, f) ? OK : { ok: false, reason: 'colonne' },
      optional: (col) => w.canAddField(table, col),
      validation: { errors: {}, warnings: [] },
    };
    if (kind === 'move') {
      if (!m.tasks.has(ctx.taskId)) {
        st = null;
        return false;
      }
      st.taskId = ctx.taskId;
      st.target = '';
      st.initial = JSON.stringify('');
      st.count = 0;
    } else {
      st.draft =
        kind === 'chantier'
          ? newChantierDraft(m, { projectId: ctx.projectId, me: ctx.me })
          : newTaskDraft(m, { ...ctx, parentId: kind === 'subtask' ? ctx.parentId : null });
      st.me = ctx.me ?? null;
      // Bloc « Personnes » : aucune ligne d'origine (ETP de référence posé par la saisie de chaque ligne)
      if (kind !== 'chantier')
        Object.assign(st, peopleState(deps.storage), { base: { dateDebut: null, dateEcheance: null } });
      st.initial = JSON.stringify(st.draft);
    }
    validate();
    dlg = openDialog({
      title: label(TITLES[kind]),
      body: body(),
      foot: dialogFoot(st, errorCount()),
      focus: FIRST[kind],
      onRequestClose: requestClose,
    });
    bind(dlg.root);
    return true;
  }

  /** Texte de la saisie, à copier quand elle ne peut pas être enregistrée. */
  function copyText(fields) {
    return Object.entries(fields)
      .filter(([c]) => c !== 'Cree_par')
      .map(([c, v]) => `${fieldLabel(c)} : ${valueText(model(), c, v)}`)
      .join('\n');
  }

  /** Échec à afficher dans la fenêtre ; un refus valant pour toute la session met la page en lecture. */
  function failOf(result, fields) {
    const copy = copyText(fields);
    if (result.kind === 'unknown') {
      deps.onUnknown?.();
      return { kind: 'unknown', copy };
    }
    if (['changed', 'missing', 'reread-failed'].includes(result.kind)) {
      deps.onUnknown?.();
      return { kind: result.kind === 'reread-failed' ? 'reread' : result.kind, copy };
    }
    const k = failureKind(result.error);
    const session = k === 'document' ? 'viewer' : k === 'refused:coupe' || k === 'refused:flags' ? 'flags' : null;
    if (session) {
      st.locked = true;
      deps.onSessionReadOnly(session);
      return { kind: 'session', message: session, copy };
    }
    if (k.startsWith('refused:')) return { kind: 'refused', message: k.slice(8), copy };
    // Ajout refusé par une règle d'accès : les boutons de création disparaissent pour la session
    if (k === 'acl') deps.onAddRefused?.();
    return { kind: k === 'acl' ? 'acl' : 'other', message: String(result.error?.message ?? ''), copy };
  }

  /** Première charge invalide (saisie refusée, sinon au-dessus de la borne) si son champ est modifiable, sinon le titre du bloc. */
  function chargesFocus() {
    const teamId = [...(st.chargeErrors?.keys() ?? []), ...(st.overCap ?? [])][0];
    const input = teamId === undefined ? null : document.getElementById(`cf-ch-${teamId}`);
    return input && !input.disabled ? input.id : FOCUS.charges;
  }

  async function submit(andOpen) {
    if (!st || st.busy || st.locked) return;
    st.tried = true;
    validate();
    if (errorCount()) {
      const first = ORDER.find((f) => st.validation.errors[f]);
      return render(first === 'charges' ? chargesFocus() : first ? (FOCUS[first] ?? `cf-${first}`) : undefined);
    }
    const w = writer();
    // Droit relu juste avant l'envoi : la session a pu passer en lecture depuis l'ouverture
    const allowed = createDialogRight(w, st.kind, st.table, st.plan);
    if (!allowed.ok) {
      st.locked = true;
      // Saisie toujours copiable si un échec précédent l'avait proposée
      st.fail = { ...rightFailure(allowed.reason), copy: st.fail?.copy ?? '' };
      return render('cf-alert');
    }
    // Assignés ou charges saisis que le writer ne permet plus à la création : on bloque, rien n'est perdu en silence
    if (st.kind === 'task' || st.kind === 'subtask') {
      const opt = (c) => w.canAddField(st.table, c);
      const dropped = droppedPeople(st.draft, newTaskFields(st.draft, { canAddField: opt }), {
        assigneesTouched: st.touched.has('assignees'),
      });
      if (dropped.charges || dropped.assignees) {
        st.fail = { kind: 'people', copy: copyText(newTaskFields(st.draft, { creePar: creePar(model(), st.me) })) };
        return render('cf-alert');
      }
    }
    const cur = st;
    cur.busy = true;
    cur.fail = null;
    render(st.kind === 'move' ? 'cf-submit' : andOpen ? 'cf-create-open' : 'cf-create');
    let result;
    let fields;
    if (cur.kind === 'move') {
      fields = cur.plan.changes;
      result = await runMove({
        writer: w,
        taskId: cur.taskId,
        plan: cur.plan,
        fetchRow: (id) => deps.fetchRow('Tasks', id),
        readTable: deps.readTable,
        timeoutMs: deps.timeoutMs?.(),
      });
    } else {
      const opt = (c) => w.canAddField(cur.table, c);
      fields =
        cur.kind === 'chantier'
          ? newChantierFields(cur.draft, { canAddField: opt })
          : newTaskFields(cur.draft, { creePar: creePar(model(), cur.me), canAddField: opt });
      result = await runCreate({ writer: w, table: cur.table, fields });
    }
    cur.busy = false;
    if (st !== cur) return;
    if (result.kind === 'saved') {
      const entry = result.entry;
      close();
      deps.onWritten(entry);
      if (cur.kind === 'move') {
        const n = result.count ?? cur.plan.count;
        deps.toast.show(
          label(entry.sent ? 'move.toast' : 'move.toastDry', {
            suite: n ? label(n === 1 ? 'move.toast.one' : 'move.toast.many', { n }) : '',
          }),
          { onAction: deps.onUndo },
        );
        deps.afterMove?.({ table: 'Tasks', id: cur.taskId });
        return;
      }
      const key = cur.kind === 'chantier' ? 'create.toast.chantier' : 'create.toast.task';
      // Création sans réponse dans le délai mais retrouvée sans ambiguïté dans la Feuille : annulable
      const text = entry.recovered
        ? label('create.toast.recovered', { id: entry.id })
        : label(entry.sent ? key : `${key}Dry`);
      deps.toast.show(text, { onAction: deps.onUndo });
      if (andOpen) deps.openForm({ table: cur.table, id: entry.id });
      else deps.afterCreate?.(entry);
      return;
    }
    cur.fail = failOf(result, fields);
    render('cf-alert');
  }

  function setDate(f, value) {
    try {
      st.draft[f] = dayFromInput(value);
      st.badDates.delete(f);
      if (st.draft.type === 'jalon' && f === 'dateEcheance') st.draft.dateDebut = st.draft.dateEcheance;
    } catch (err) {
      if (!(err instanceof EncodeError)) throw err;
      st.badDates.add(f);
    }
  }

  function bind(root) {
    root.addEventListener('input', (e) => {
      if (!st || st.busy) return;
      if (hasPeople() && people.onInput(e.target)) return;
      const f = e.target.dataset.cf;
      if (f) st.touched.add(f);
      if (['titre', 'Nom_du_chantier', 'description', 'Description'].includes(f)) {
        st.draft[f] = e.target.value;
        refresh();
      }
    });
    root.addEventListener('change', (e) => {
      if (!st || st.busy) return;
      const t = e.target;
      const f = t.dataset.cf ?? t.dataset.input;
      if (f) st.touched.add(f);
      if (f === 'dateDebut') st.touched.add('dateEcheance');
      if (f === 'Debut') st.touched.add('Fin');
      if (t.dataset.addProjet !== undefined) st.touched.add('Projets');
      if (t.dataset.addContrib !== undefined) st.touched.add('Contributeurs');
      if (f === 'cible') {
        if (st.kind === 'move') st.target = t.value;
        else {
          const { chantierId, projectId } = parseTarget(t.value);
          st.draft.Chantier = chantierId;
          st.draft.projet = projectId;
        }
        render('cf-cible');
      } else if (['dateDebut', 'dateEcheance', 'Debut', 'Fin'].includes(f)) {
        setDate(f, t.value);
        // Tâche : l'ETP fait foi, heures des charges recalculées sur la nouvelle période
        if (hasPeople()) people.onDatesChanged();
        else refresh();
      } else if (f === 'type') {
        st.draft = setNewMilestone(st.draft, t.checked);
        if (hasPeople()) people.onDatesChanged({ render: false });
        render('cf-type');
      } else if (f === 'statut' || f === 'Statut' || f === 'priorite') {
        st.draft[f] = t.value;
        if (f === 'priorite') render(t.id);
        else refresh();
      } else if (f === 'Responsable') {
        st.draft.Responsable = t.value ? Number(t.value) : null;
        refresh();
      } else if (hasPeople() && people.onChange(t)) {
        // ajout d'une personne ou unité de saisie du bloc « Personnes »
      } else if (t.dataset.addProjet !== undefined && t.value) {
        const id = Number(t.value);
        if (!st.draft.Projets.includes(id)) st.draft.Projets = [...st.draft.Projets, id];
        render('cf-Projets');
      } else if (t.dataset.addContrib !== undefined && t.value) {
        const id = Number(t.value);
        if (!st.draft.Contributeurs.includes(id)) st.draft.Contributeurs = [...st.draft.Contributeurs, id];
        render('cf-Contributeurs');
      }
    });
    root.addEventListener(
      'toggle',
      (e) => {
        if (!st || e.target.id !== 'cf-more') return;
        st.moreOpen = e.target.open;
        try {
          deps.storage.setItem(MORE_KEY, st.moreOpen ? '1' : '0');
        } catch {
          // stockage indisponible : le choix vaut pour la session
        }
      },
      true,
    );
    root.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t || !st) return;
      const a = t.dataset.cfAction;
      if (a === 'leave-continue') {
        st.leave = false;
        return render(FIRST[st.kind]);
      }
      if (a === 'leave-discard') return close();
      if (st.busy) return;
      if (a === 'cancel') return requestClose();
      if (a === 'create' || a === 'submit') return void submit(false);
      if (a === 'create-open') return void submit(true);
      if (t.dataset.removeProjet) st.touched.add('Projets');
      if (hasPeople() && people.onClick(t)) {
        // retrait, assignation, fusion ou remplacement dans le bloc « Personnes »
      } else if (t.dataset.removeProjet) {
        const id = Number(t.dataset.removeProjet);
        st.draft.Projets = st.draft.Projets.filter((x) => x !== id);
        render('cf-Projets');
      } else if (t.dataset.removeContrib) {
        const id = Number(t.dataset.removeContrib);
        st.draft.Contributeurs = st.draft.Contributeurs.filter((x) => x !== id);
        render('cf-Contributeurs');
      }
    });
    root.addEventListener('keydown', (e) => {
      if (!st || e.key !== 'Enter') return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        submit(st.kind !== 'move');
      } else if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') e.preventDefault();
    });
  }

  return { open, isOpen: () => dlg !== null };
}
