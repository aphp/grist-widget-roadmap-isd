/**
 * Contrôleur des fiches tâche, chantier et personne en édition (lots 2a à 2d) : brouillon, validation en direct, statut
 * rapide (menu de boutons), enregistrement, erreurs de la Feuille, confirmation avant de quitter. La table de la
 * fiche (Tasks, Chantiers ou Team) choisit ses champs, ses règles et son rendu (SPECS).
 * Les enregistrements eux-mêmes sont core/task-session.js (sans DOM, testés) ; aucune action Grist n'est
 * construite ici. Chaque enregistrement travaille sur un instantané : si le formulaire change pendant l'attente,
 * le résultat est quand même annoncé et appliqué au modèle, mais le nouveau formulaire n'est pas touché.
 */
import { chargeRows, mergeDuplicates, periodDays, readChargesCell } from '../core/charges-edit.js';
import { addPersonLine, assignPerson, lineInput, removePersonLine } from '../core/task-people.js';
import { conflictBatch, failureKind, runQuickStatus, runSave } from '../core/task-session.js';
import { FORM_FIELDS, diffDraft, draftFrom, rebaseDraft, setMilestone, validateTask } from '../core/task-form.js';
import {
  CHANTIER_FIELDS,
  chantierDraftFrom,
  diffChantier,
  rebaseChantier,
  reattachPlan,
  validateChantier,
} from '../core/chantier-form.js';
import { chantierFormBody } from '../views/chantier-form.js';
import {
  CAPACITY_MAX,
  PERSON_FIELDS,
  diffPerson,
  personDraftFrom,
  rebasePerson,
  validatePerson,
} from '../core/person-form.js';
import { personFormBody } from '../views/person-form.js';
import { EncodeError, changedFields, dayFromInput, parseNumberFr } from '../core/write-encode.js';
import { label, statusLabel } from '../labels.js';
import {
  chargeEqText,
  chargeRowMsgs,
  chargesFootHtml,
  peopleBlockHtml,
  peopleCtx,
  depResultsHtml,
  fieldLabel,
  messagesHtml,
  refusedText,
  taskFormBody,
  taskFormFoot,
  valueText,
} from '../views/task-form.js';

const TEXT_FIELDS = new Set([
  'titre',
  'description',
  'Commentaire',
  'Lien_utile',
  'Nom_du_chantier',
  'Description',
  'Objectifs_resultats_attendus',
  'Criteres_de_succes',
  'nom',
  'email',
]);
const DATE_FIELDS = new Set(['dateDebut', 'dateEcheance', 'dateCloture', 'Debut', 'Fin']);

/** Champs, différences, règles et rendu de chaque fiche modifiable. */
const SPECS = Object.freeze({
  Tasks: {
    fields: FORM_FIELDS,
    diff: diffDraft,
    draftFrom,
    rebase: rebaseDraft,
    focus: 'tf-titre',
    validate: (st, model) =>
      validateTask(st.draft, {
        model,
        taskId: st.ref.id,
        statuses: model.statuses.tasks,
        priorities: model.choices?.['Tasks.priorite'] ?? [],
      }),
    body: (st, model) => taskFormBody(st, model),
  },
  Chantiers: {
    fields: CHANTIER_FIELDS,
    diff: diffChantier,
    draftFrom: chantierDraftFrom,
    rebase: rebaseChantier,
    focus: 'tf-Nom_du_chantier',
    validate: (st, model) =>
      validateChantier(st.draft, { model, chantierId: st.ref.id, statuses: model.statuses.chantiers }),
    body: (st, model) => chantierFormBody(st, model),
  },
  // Lot 2d : fiche personne (équipe ISD) ; l'actif se change par « Désactiver » / « Réactiver »
  Team: {
    fields: PERSON_FIELDS,
    diff: diffPerson,
    draftFrom: personDraftFrom,
    rebase: rebasePerson,
    focus: 'tf-nom',
    validate: (st, model) => validatePerson(st.draft, { model, personId: st.ref.id, domaine: st.base.Domaine ?? '' }),
    body: (st, model) => personFormBody(st, model),
  },
});
const spec = (s) => SPECS[s.ref.table];
const MORE_KEY = 'roadmap-isd.formMore';
const UNIT_KEY = 'roadmap-isd.chargesUnit';

/**
 * @param {{root:HTMLElement, chrome:object, getModel():object, getBase(table:string, id:number):object|null,
 *   getWriter():object|null, fetchRow(table:string, id:number):Promise<object|null>, today():number,
 *   storage:Storage, toast:{show:Function}, kindOf(ref):*, titleOf(ref):string, currentRef():object|null,
 *   showRead(ref):void, onWritten(entry:object):void, onUndo():void, onSessionReadOnly(reason:string):void,
 *   onCreate?(data:object):void, onMove?(ref:object):void}} deps
 *   onCreate : bouton de création de la fiche (data-create, data-parent, data-chantier) ;
 *   onMove : « Changer » de la ligne Rattachement d'une tâche
 */
export function createTaskEditor(deps) {
  let st = null;
  let quickBusy = false;

  const model = () => deps.getModel();
  const writer = () => deps.getWriter();
  const changes = (s = st) => (s ? spec(s).diff(s.base, s.draft) : {});
  const fetchRowOf = (table) => (id) => deps.fetchRow(table, id);

  /** Tâches du chantier à rattacher au projet choisi quand un projet est retiré (même lot). */
  const reattachAlso = (s) =>
    s.ref.table === 'Chantiers' && 'Projets' in changes(s)
      ? reattachPlan(model(), s.ref.id, s.draft.Projets, s.reattachTo ?? null).also
      : [];

  function validate() {
    const v = spec(st).validate(st, model());
    for (const f of st.badDates) v.errors[f] = { key: 'form.error.date' };
    if (st.badNumber) v.errors.progression = { key: 'form.error.progression' };
    if (st.badCapacity) v.errors.capaciteHebdo = { key: 'person.error.capacity', vars: { max: CAPACITY_MAX } };
    if (st.chargeErrors.size) v.errors.charges = { key: 'form.error.charges' };
    // Saisie sur une colonne devenue non modifiable : « Rétablir » ce champ pour enregistrer le reste
    if (!st.locked)
      for (const f of Object.keys(changes()))
        if (!st.can(f).ok && !v.errors[f]) v.errors[f] = { key: 'form.error.locked' };
    st.validation = v;
  }

  const errorCount = () => Object.keys(st.validation.errors).length;

  /** Redessine tout le formulaire, en gardant le champ actif et la position de défilement. */
  function render(focusId) {
    validate();
    const active = deps.root.contains(document.activeElement) ? document.activeElement.id : '';
    const scroll = deps.root.querySelector('.drawer__body')?.scrollTop ?? 0;
    deps.chrome.openDetail(deps.kindOf(st.ref), deps.titleOf(st.ref), spec(st).body(st, model()), {
      foot: taskFormFoot(st, changes(), errorCount()),
      mode: 'edit',
      focus: focusId || active || spec(st).focus,
    });
    const body = deps.root.querySelector('.drawer__body');
    if (body) body.scrollTop = scroll;
  }

  /** Mise à jour légère pendant la frappe : messages des champs et pied, sans toucher aux contrôles. */
  function refresh() {
    validate();
    for (const f of spec(st).fields) {
      const box = document.getElementById(`tf-${f}-msgs`);
      if (box) box.innerHTML = messagesHtml(st, f).toString();
      const ctl = document.getElementById(`tf-${f}`);
      const bad = Boolean(st.validation.errors[f]);
      if (ctl) {
        if (bad) ctl.setAttribute('aria-invalid', 'true');
        else ctl.removeAttribute('aria-invalid');
        ctl.closest('.tf-field')?.classList.toggle('fr-input-group--error', bad);
      }
    }
    const chFoot = document.getElementById('tf-charges-foot');
    if (chFoot) chFoot.innerHTML = chargesFootHtml(st, model()).toString();
    const foot = deps.root.querySelector('.drawer__foot');
    if (foot) foot.innerHTML = taskFormFoot(st, changes(), errorCount()).toString();
  }

  function moreOpen() {
    try {
      return deps.storage.getItem(MORE_KEY) === '1';
    } catch {
      return false;
    }
  }

  /** Unité de saisie des charges, mémorisée dans le navigateur (ETP par défaut). */
  function chargesUnit() {
    try {
      return deps.storage.getItem(UNIT_KEY) === 'heures' ? 'heures' : 'etp';
    } catch {
      return 'etp';
    }
  }

  /** Redessine le seul bloc « Personnes » (dates ou unité changées), sans toucher au reste du formulaire. */
  function renderCharges(focusId) {
    validate();
    const box = document.getElementById('tf-people');
    if (box) box.outerHTML = peopleBlockHtml(st, model()).toString();
    refresh();
    if (focusId) document.getElementById(focusId)?.focus();
  }

  /** Champ de charge d'une ligne s'il est modifiable, sinon son bouton de retrait, sinon l'ajout. */
  function lineFocus(id) {
    const input = document.getElementById(`tf-ch-${id}`);
    if (input && !input.disabled) return input.id;
    return document.getElementById(`tf-person-${id}-remove`) ? `tf-person-${id}-remove` : 'tf-assignees';
  }

  /** Ligne du bloc « Personnes » réaffichée seule (heures, équivalent, messages), sans redessiner les champs. */
  function lineRefresh(id, days) {
    const cell = readChargesCell(st.draft.charges);
    const row = cell.ok ? chargeRows(cell.entries).rows.find((x) => x.teamId === id) : null;
    const line = {
      teamId: id,
      assigned: st.draft.assignees.includes(id),
      charged: Boolean(row),
      heures: row ? row.heures : null,
      count: row ? row.count : 0,
      known: model().people.has(id),
    };
    const eq = document.getElementById(`tf-ch-${id}-eq`);
    if (eq) eq.textContent = row && !st.chargeErrors.has(id) ? chargeEqText(st, row.heures, days) : '';
    const msg = document.getElementById(`tf-ch-${id}-msg`);
    if (msg) msg.innerHTML = chargeRowMsgs(st, model(), line, peopleCtx(st)).toString();
  }

  /**
   * Brouillon modifié par un bouton, un menu ou une saisie de charge : les droits sont relus au moment d'agir
   * (colonnes touchées, writer courant), pas seulement au rendu. Refus (session passée en lecture, colonne
   * retirée, bouton périmé) : rien ne change et le formulaire est redessiné avec les droits du moment.
   * @returns {boolean} vrai si le brouillon a été remplacé
   */
  function applyDraft(next, focusId) {
    const w = writer();
    const cols = changedFields(st.draft, next);
    if (!w || w.mode === 'off' || st.locked || !cols.every((c) => st.can(c).ok)) {
      render(focusId);
      return false;
    }
    st.draft = next;
    return true;
  }

  /** Charge saisie sur une ligne : brouillon mis à jour si la valeur est valide, sinon erreur sous la ligne. */
  function chargeInput(t) {
    const id = Number(t.dataset.chargeInput);
    const days = periodDays(st.draft.dateDebut, st.draft.dateEcheance);
    const r = lineInput(st.draft, id, t.value, st.chargesUnit, days);
    if (r.error) {
      st.chargeErrors.set(id, r.error);
      st.chargeInputs.set(id, t.value);
      t.setAttribute('aria-invalid', 'true');
    } else {
      if (!applyDraft({ ...st.draft, charges: r.charges })) return;
      st.chargeErrors.delete(id);
      st.chargeInputs.delete(id);
      st.chargeRefDays.set(id, days);
      t.removeAttribute('aria-invalid');
    }
    lineRefresh(id, days);
    refresh();
  }

  /** Ouvre le formulaire de la tâche ou du chantier ; faux si la ligne est introuvable. */
  function open(ref) {
    if (!SPECS[ref.table]) return false;
    const base = deps.getBase(ref.table, ref.id);
    const w = writer();
    if (!base || !w || w.mode === 'off') return false;
    const task = ref.table === 'Tasks' ? model().tasks.get(ref.id) : null;
    st = {
      ref,
      base,
      draft: SPECS[ref.table].draftFrom(base),
      canCreate: w.canAdd('Tasks').ok,
      canMove: Boolean(task && !task.parentId && w.can('Tasks', 'Chantier').ok && w.can('Tasks', 'projet').ok),
      reattachTo: null,
      originalType: base.type,
      busy: false,
      fail: null,
      conflict: null,
      confirmNoCheck: false,
      leave: false,
      pendingLeave: null,
      changedElsewhere: false,
      depQuery: '',
      badDates: new Set(),
      badNumber: false,
      chargeErrors: new Map(),
      chargeInputs: new Map(),
      chargeRefDays: new Map(),
      chargesUnit: chargesUnit(),
      confirmReplace: false,
      moreOpen: moreOpen(),
      mode: w.mode,
      can: (f) => w.can(ref.table, f),
      validation: { errors: {}, warnings: [] },
    };
    render(SPECS[ref.table].focus);
    return true;
  }

  /**
   * Après une écriture faite hors du formulaire (changement de chantier, sous-tâche créée) : la base suit les
   * données lues, les champs non touchés aussi, puis le formulaire est redessiné (saisie conservée).
   */
  function refreshFromModel() {
    if (!st || st.busy) return;
    const fresh = deps.getBase(st.ref.table, st.ref.id);
    if (!fresh) return;
    st.draft = spec(st).rebase(st.base, st.draft, fresh);
    st.base = fresh;
    const task = st.ref.table === 'Tasks' ? model().tasks.get(st.ref.id) : null;
    const w = writer();
    st.canMove = Boolean(task && !task.parentId && w?.can('Tasks', 'Chantier').ok && w.can('Tasks', 'projet').ok);
    render();
  }

  function close() {
    const ref = st?.ref;
    st = null;
    if (ref) deps.showRead(ref);
  }

  /** Quitter (fermer, autre fiche, Retour) : confirmation s'il reste des modifications ; rien pendant un envoi. */
  function requestLeave(next) {
    if (!st) return next();
    if (st.busy) return; // l'enregistrement en cours se termine d'abord (délai maximal : 10 s par requête)
    if (st.locked) {
      // Session en lecture : plus rien ne peut être enregistré, on sort sans confirmation
      st = null;
      return next();
    }
    if (!Object.keys(changes()).length) {
      st = null;
      return next();
    }
    st.leave = true;
    st.pendingLeave = next;
    render('btn-leave-continue');
  }

  /** Texte de la saisie, à copier quand elle ne peut pas être enregistrée. */
  function copyText(_s, ch) {
    return Object.entries(ch)
      .map(([c, v]) => `${fieldLabel(c)} : ${valueText(model(), c, v)}`)
      .join('\n');
  }

  /** Échec à afficher dans le formulaire, à partir d'un résultat de task-session. */
  function failFrom(result, ch) {
    if (result.kind === 'missing') return { kind: 'missing', message: '', copy: copyText(st, ch) };
    if (result.kind === 'reread-failed') return { kind: 'reread', message: result.error, copy: copyText(st, ch) };
    const k = failureKind(result.error);
    if (k.startsWith('refused:')) return { kind: 'refused', message: k.slice(8), copy: copyText(st, ch) };
    return { kind: k, message: String(result.error?.message ?? ''), copy: copyText(st, ch) };
  }

  /** Écriture réussie : toujours annoncée et appliquée au modèle, même si le formulaire a changé entre-temps. */
  function announce(entry, textKey, vars) {
    deps.onWritten(entry);
    deps.toast.show(label(entry.sent ? textKey : `${textKey}Dry`, vars), { onAction: deps.onUndo });
  }

  /**
   * Toute la session passe en lecture alors qu'un formulaire est ouvert : un seul message, la saisie reste
   * copiable, les champs passent en lecture, et la fiche se ferme sans confirmation.
   */
  function lockSession(reason) {
    if (!st || st.locked) return;
    st.locked = reason;
    st.can = () => ({ ok: false, reason });
    st.busy = false;
    st.leave = false;
    st.pendingLeave = null;
    st.conflict = null;
    st.confirmNoCheck = false;
    st.fail = { kind: 'session', message: reason, copy: copyText(st, changes()) };
    render('tf-alert');
  }

  /** Refus valant pour toute la session (compte lecteur, arrêt d'urgence) : la page passe en lecture. */
  function sessionReadOnly(kind) {
    const reason =
      kind === 'document' ? 'viewer' : kind === 'refused:coupe' || kind === 'refused:flags' ? 'flags' : null;
    if (!reason) return false;
    lockSession(reason);
    deps.onSessionReadOnly(reason);
    return true;
  }

  /**
   * Écriture sans réponse dans le délai : résultat inconnu. La ligne relue (si possible) devient la base, et le
   * brouillon la suit pour les champs non touchés : ce qui reste « à enregistrer » est ce qui manque vraiment.
   */
  function unknownFail(cur, result) {
    const lines = Object.entries(result.changes).map(([c, v]) => ({
      champ: fieldLabel(c),
      saisie: valueText(model(), c, v),
      feuille: result.stored ? valueText(model(), c, result.stored[c]) : null,
    }));
    if (result.stored) {
      cur.draft = spec(cur).rebase(cur.base, cur.draft, result.stored);
      cur.base = { ...cur.base, ...result.stored };
    }
    deps.onUnknown?.();
    return {
      kind: result.stored === null ? 'missing' : 'unknown',
      message: '',
      lines,
      reread: result.stored !== undefined,
      copy: copyText(cur, result.changes),
    };
  }

  /**
   * Enregistre le formulaire courant. L'instantané (cur) fixe la ligne, la base et le brouillon de cet envoi.
   * @param {{skipCheck?:boolean, changes?:object, before?:object, chargesBase?:string, chargesSeen?:string}} [opts]
   */
  async function save(opts = {}) {
    if (!st || st.busy) return;
    validate();
    if (errorCount()) {
      const first = spec(st).fields.find((f) => st.validation.errors[f]);
      st.leave = false;
      const target =
        first === 'priorite'
          ? 'tf-priorite-none'
          : first === 'charges'
            ? (document.querySelector('#tf-people [aria-invalid="true"]')?.id ?? 'tf-people-title')
            : `tf-${first}`;
      render(target);
      return;
    }
    const cur = st;
    const ch = opts.changes ?? changes(cur);
    if (!Object.keys(ch).length) return close();
    cur.busy = true;
    cur.fail = null;
    cur.conflict = null;
    cur.confirmNoCheck = false;
    render('btn-form-save');
    const result = await runSave({
      table: cur.ref.table,
      diff: spec(cur).diff,
      also: reattachAlso(cur),
      readTable: deps.readTable,
      reattachTo: cur.reattachTo,
      taskId: cur.ref.id,
      base: cur.base,
      draft: cur.draft,
      writer: writer(),
      fetchRow: fetchRowOf(cur.ref.table),
      skipCheck: opts.skipCheck,
      changes: opts.changes,
      before: opts.before,
      chargesBase: opts.chargesBase,
      chargesSeen: opts.chargesSeen,
      timeoutMs: deps.timeoutMs?.(),
    });
    cur.busy = false;
    if (result.kind === 'saved') {
      const stillHere = st === cur;
      const next = cur.pendingLeave;
      if (stillHere) st = null;
      announce(result.entry, 'toast.saved');
      if (stillHere) {
        if (next) next();
        else deps.showRead(cur.ref);
      }
      return;
    }
    if (st !== cur) return; // formulaire quitté pendant l'attente : rien d'autre à montrer
    cur.leave = false;
    cur.pendingLeave = null;
    if (result.kind === 'nothing') return close();
    if (result.kind === 'conflict') {
      cur.conflict = { cols: result.cols, fresh: result.fresh, mine: result.mine ?? {}, choices: {} };
      return render('tf-alert');
    }
    if (result.kind === 'reread-failed') {
      cur.confirmNoCheck = true;
      cur.fail = failFrom(result, ch);
      return render('tf-alert');
    }
    if (result.kind === 'unknown') {
      cur.fail = unknownFail(cur, result);
      return render('tf-alert');
    }
    if (sessionReadOnly(result.kind === 'failed' ? failureKind(result.error) : '')) return;
    cur.fail = failFrom(result, ch);
    render('tf-alert');
  }

  /** Fenêtre de conflit : la base devient la ligne relue, et les champs non touchés suivent la Feuille (I2). */
  async function applyConflicts() {
    const { cols, fresh, choices, mine } = st.conflict;
    const batch = conflictBatch(st.base, st.draft, fresh, choices, spec(st).diff);
    const draft = spec(st).rebase(st.base, st.draft, fresh);
    for (const c of cols) {
      if (choices[c] === 'theirs') draft[c] = fresh[c];
      else if (c in mine) draft[c] = mine[c];
    }
    if (choices.charges === 'theirs') {
      st.chargeErrors.clear();
      st.chargeInputs.clear();
    }
    st.draft = draft;
    st.base = { ...st.base, ...fresh };
    st.conflict = null;
    if (!Object.keys(batch.changes).length) return close();
    await save(batch);
  }

  /** Statut rapide (fiche en lecture ou formulaire) : choisi dans un menu, enregistré tout de suite. */
  async function quickStatus(ref, status) {
    const w = writer();
    if (!w || quickBusy || st?.busy) return;
    // Droit relu au moment d'agir : le menu a pu être affiché avant un passage en lecture
    if (st?.locked || !w.can(ref.table, ref.table === 'Chantiers' ? 'Statut' : 'statut').ok) return;
    quickBusy = true;
    const cur = st;
    const result = await runQuickStatus({
      table: ref.table,
      taskId: ref.id,
      status,
      localBase: cur?.base ?? deps.getBase(ref.table, ref.id),
      writer: w,
      fetchRow: fetchRowOf(ref.table),
      today: deps.today(),
      timeoutMs: deps.timeoutMs?.(),
    });
    quickBusy = false;
    if (result.kind === 'nothing') return;
    if (result.kind === 'saved') {
      const ch = result.entry.after;
      if (cur && st === cur) {
        // Le brouillon suit le statut, et la clôture seulement si elle n'a pas été saisie dans le formulaire
        const closureUntouched = cur.draft.dateCloture === cur.base.dateCloture;
        if ('Statut' in ch) cur.draft.Statut = ch.Statut;
        if ('statut' in ch) cur.draft.statut = ch.statut;
        if ('dateCloture' in ch && closureUntouched) cur.draft.dateCloture = ch.dateCloture;
        cur.base = { ...cur.base, ...ch };
      }
      announce(result.entry, 'toast.status', { statut: statusLabel(status) });
      if (cur && st === cur) render('btn-status-menu');
      return;
    }
    if (result.kind === 'unknown') {
      deps.onUnknown?.();
      const now = result.stored ? statusLabel(result.stored.statut ?? result.stored.Statut) : null;
      deps.toast.show(now ? label('toast.unknownStatus', { statut: now }) : label('toast.unknown'), { tone: 'error' });
      if (cur && st === cur) {
        if (result.stored) {
          cur.draft = spec(cur).rebase(cur.base, cur.draft, result.stored);
          cur.base = { ...cur.base, ...result.stored };
        }
        render('btn-status-menu');
      }
      return;
    }
    const kind = result.kind === 'failed' ? failureKind(result.error) : result.kind;
    if (sessionReadOnly(kind)) return;
    const text = kind.startsWith('refused:')
      ? label('form.fail.refused', { raison: refusedText(kind.slice(8)) })
      : label(`form.fail.${['acl', 'missing', 'reread'].includes(kind) ? kind : 'other'}`);
    deps.toast.show(text, { tone: 'error' });
    if (cur && st === cur) render('btn-status-menu');
  }

  /** Après une relecture des données : le formulaire n'est pas redessiné, un bandeau signale un changement. */
  function notifyReload() {
    if (!st || st.busy) return;
    const fresh = deps.getBase(st.ref.table, st.ref.id);
    if (!fresh) {
      st.fail = failFrom({ kind: 'missing' }, changes());
      return render('tf-alert');
    }
    const changed = spec(st).fields.some((f) => JSON.stringify(fresh[f]) !== JSON.stringify(st.base[f]));
    if (changed && !st.changedElsewhere) {
      st.changedElsewhere = true;
      render();
    }
  }

  function toggleStatusMenu(force) {
    const btn = document.getElementById('btn-status-menu');
    const list = document.getElementById('status-menu-list');
    if (!btn || !list) return false;
    const open = force ?? list.hidden;
    list.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) (list.querySelector('[aria-current="true"]') ?? list.querySelector('button'))?.focus();
    return true;
  }

  // ---------- Événements (délégués sur le panneau) ----------
  deps.root.addEventListener('input', (e) => {
    if (!st || st.busy) return;
    const t = e.target;
    const f = t.dataset.input;
    if (f && TEXT_FIELDS.has(f)) {
      st.draft[f] = t.value;
      refresh();
    } else if (f === 'progression') {
      try {
        st.draft.progression = parseNumberFr(t.value);
        st.badNumber = false;
      } catch (err) {
        if (!(err instanceof EncodeError)) throw err;
        st.badNumber = true;
      }
      refresh();
    } else if (f === 'capaciteHebdo') {
      // Capacité : vide = 35 h par défaut ; la saisie affichée est gardée telle quelle pendant la frappe
      st.capacityInput = t.value;
      try {
        st.draft.capaciteHebdo = parseNumberFr(t.value);
        st.badCapacity = false;
      } catch (err) {
        if (!(err instanceof EncodeError)) throw err;
        st.badCapacity = true;
      }
      refresh();
    } else if (t.dataset.chargeInput) {
      chargeInput(t);
    } else if (t.dataset.depSearch !== undefined) {
      st.depQuery = t.value;
      const box = document.getElementById('tf-dep-results');
      if (box) box.innerHTML = depResultsHtml(st, model()).toString();
    }
  });

  deps.root.addEventListener('change', (e) => {
    if (!st || st.busy) return;
    const t = e.target;
    const f = t.dataset.input;
    if (f && DATE_FIELDS.has(f)) {
      try {
        const day = dayFromInput(t.value);
        st.badDates.delete(f);
        st.draft[f] = day;
        if (st.draft.type === 'jalon' && f === 'dateEcheance') st.draft.dateDebut = day;
      } catch (err) {
        if (!(err instanceof EncodeError)) throw err;
        st.badDates.add(f);
      }
      // Q8 A : les heures (valeur stockée) sont conservées ; l'ETP et l'écart sont recalculés
      renderCharges();
    } else if (f === 'type') {
      st.draft = setMilestone(st.draft, t.checked, st.originalType);
      render('tf-type');
    } else if (f === 'priorite') {
      st.draft.priorite = t.value;
      render(t.id);
    } else if (f === 'Responsable' || f === 'parentTask' || f === 'n_1') {
      st.draft[f] = t.value ? Number(t.value) : null;
      refresh();
    } else if (f === 'role') {
      st.draft.role = t.value;
      refresh();
    } else if (t.dataset.addProjet !== undefined && t.value) {
      const id = Number(t.value);
      if (
        !st.draft.Projets.includes(id) &&
        !applyDraft({ ...st.draft, Projets: [...st.draft.Projets, id] }, 'tf-Projets')
      )
        return;
      render(`tf-Projets`);
    } else if (t.dataset.addContrib !== undefined && t.value) {
      const id = Number(t.value);
      const next = [...st.draft.Contributeurs, id];
      if (!st.draft.Contributeurs.includes(id) && !applyDraft({ ...st.draft, Contributeurs: next }, 'tf-Contributeurs'))
        return;
      render('tf-Contributeurs');
    } else if (t.dataset.reattach !== undefined) {
      st.reattachTo = Number(t.value) || null;
    } else if (t.dataset.personAdd !== undefined && t.value) {
      // « Ajouter une personne… » : elle est assignée, sa charge (facultative) est à saisir sur sa ligne
      const id = Number(t.value);
      if (!applyDraft(addPersonLine(st.draft, id), 'tf-people-title')) return;
      st.chargeRefDays.set(id, periodDays(st.draft.dateDebut, st.draft.dateEcheance));
      renderCharges();
      document.getElementById(lineFocus(id))?.focus();
    } else if (t.dataset.chargesUnit !== undefined) {
      st.chargesUnit = t.value === 'heures' ? 'heures' : 'etp';
      st.chargeErrors.clear();
      st.chargeInputs.clear();
      try {
        deps.storage.setItem(UNIT_KEY, st.chargesUnit);
      } catch {
        // stockage indisponible : le choix vaut pour la session
      }
      renderCharges(t.id);
    } else if (t.dataset.conflict && st.conflict) {
      st.conflict.choices[t.dataset.conflict] = t.value;
    }
  });

  deps.root.addEventListener(
    'toggle',
    (e) => {
      if (!st || e.target.id !== 'tf-more') return;
      st.moreOpen = e.target.open;
      try {
        deps.storage.setItem(MORE_KEY, st.moreOpen ? '1' : '0');
      } catch {
        // stockage indisponible : le choix vaut pour la session
      }
    },
    true,
  );

  deps.root.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.statusToggle !== undefined) return void toggleStatusMenu();
    if (t.dataset.setStatus !== undefined) {
      toggleStatusMenu(false);
      document.getElementById('btn-status-menu')?.focus();
      const ref = st?.ref ?? deps.currentRef();
      if (ref) quickStatus(ref, t.dataset.setStatus);
      return;
    }
    if (t.dataset.editOpen !== undefined) {
      const ref = deps.currentRef();
      if (ref) open(ref);
      return;
    }
    // Fenêtres de création (sous-tâche, tâche du chantier) et changement de chantier : main.js
    if (t.dataset.create !== undefined) {
      if (!st?.busy) deps.onCreate?.({ ...t.dataset });
      return;
    }
    if (t.dataset.moveOpen !== undefined) {
      if (st && !st.busy) deps.onMove?.(st.ref);
      return;
    }
    if (!st || st.busy) return;
    if (t.dataset.removeProjet) {
      const id = Number(t.dataset.removeProjet);
      if (!applyDraft({ ...st.draft, Projets: st.draft.Projets.filter((x) => x !== id) })) return;
      render('tf-Projets');
    } else if (t.dataset.removeContrib) {
      const id = Number(t.dataset.removeContrib);
      if (!applyDraft({ ...st.draft, Contributeurs: st.draft.Contributeurs.filter((x) => x !== id) })) return;
      render('tf-Contributeurs');
    } else if (t.dataset.personRemove) {
      // Retirer une ligne : assignation et charge de la personne, dans le même brouillon (un seul lot)
      const id = Number(t.dataset.personRemove);
      if (!applyDraft(removePersonLine(st.draft, id), 'tf-people-title')) return;
      st.chargeErrors.delete(id);
      st.chargeInputs.delete(id);
      renderCharges(document.getElementById('tf-assignees') ? 'tf-assignees' : 'tf-people-title');
    } else if (t.dataset.personAssign) {
      // Charge sans assignation : assignée seulement sur demande (jamais d'office)
      const id = Number(t.dataset.personAssign);
      if (!applyDraft(assignPerson(st.draft, id), 'tf-people-title')) return;
      renderCharges();
      document.getElementById(lineFocus(id))?.focus();
    } else if (t.dataset.removeDep) {
      const id = Number(t.dataset.removeDep);
      if (!applyDraft({ ...st.draft, dependDe: st.draft.dependDe.filter((x) => x !== id) })) return;
      render('tf-dep-search');
    } else if (t.dataset.addDep) {
      if (!applyDraft({ ...st.draft, dependDe: [...st.draft.dependDe, Number(t.dataset.addDep)] })) return;
      st.depQuery = '';
      render('tf-dep-search');
    } else if (t.dataset.chargeMerge) {
      const id = Number(t.dataset.chargeMerge);
      if (!applyDraft({ ...st.draft, charges: mergeDuplicates(st.draft.charges, id) }, 'tf-people-title')) return;
      renderCharges(`tf-ch-${id}`);
    } else if (t.dataset.charges) {
      // Cellule illisible : remplacement par une saisie vide, seulement après confirmation
      const a = t.dataset.charges;
      if (a === 'replace-confirm' && !applyDraft({ ...st.draft, charges: '[]' }, 'tf-people-title')) return;
      st.confirmReplace = a === 'replace-ask';
      renderCharges(
        a === 'replace-ask'
          ? 'tf-charges-replace-confirm'
          : a === 'replace-confirm'
            ? 'tf-assignees'
            : 'tf-charges-replace',
      );
    } else if (t.dataset.revert) {
      // Champ refusé par la Feuille : retour à la valeur d'origine, le reste peut être enregistré
      const f = t.dataset.revert;
      if (f === 'capaciteHebdo') st.badCapacity = false;
      st.draft[f] = Array.isArray(st.base[f]) ? [...st.base[f]] : st.base[f];
      st.badDates.delete(f);
      if (f === 'charges') {
        st.chargeErrors.clear();
        st.chargeInputs.clear();
      }
      render('btn-form-save');
    } else {
      const action = t.dataset.form;
      if (action === 'save' || action === 'leave-save') save();
      else if (action === 'save-nocheck') save({ skipCheck: true });
      else if (action === 'cancel') close();
      else if (action === 'clear-closure') {
        if (!applyDraft({ ...st.draft, dateCloture: null })) return;
        st.badDates.delete('dateCloture');
        render('tf-dateCloture');
      } else if (action === 'leave-continue') {
        st.leave = false;
        st.pendingLeave = null;
        render('btn-form-save');
      } else if (action === 'leave-discard') {
        const next = st.pendingLeave;
        st = null;
        next?.();
      } else if (action === 'conflict-apply') applyConflicts();
      else if (action === 'conflict-cancel' || action === 'nocheck-cancel') {
        st.conflict = null;
        st.confirmNoCheck = false;
        st.fail = null;
        render('btn-form-save');
      }
    }
  });

  deps.root.addEventListener('keydown', (e) => {
    // Échap ferme d'abord le menu de statut, sans fermer la fiche
    if (e.key === 'Escape') {
      const list = document.getElementById('status-menu-list');
      if (list && !list.hidden) {
        e.stopPropagation();
        toggleStatusMenu(false);
        document.getElementById('btn-status-menu')?.focus();
      }
      return;
    }
    if (!st || e.key !== 'Enter') return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      save();
    } else if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
      // Entrée dans un champ simple n'envoie pas le formulaire
      e.preventDefault();
    }
  });

  return {
    open,
    refreshFromModel,
    requestLeave,
    notifyReload,
    isEditing: () => st !== null,
    lockSession,
    isBusy: () => Boolean(st?.busy),
    isDirty: () => Object.keys(changes()).length > 0,
  };
}
