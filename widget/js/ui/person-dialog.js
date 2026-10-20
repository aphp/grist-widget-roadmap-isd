/**
 * Fenêtres de l'onglet Équipe (lot 2d) : « Ajouter une personne », « Indisponibilité » (création ou modification)
 * et « Désactiver » (confirmation). Les valeurs viennent de core/person-form.js, les envois de core/task-session.js
 * (runCreate, runSave, runSetActive) et donc du writer : aucune action Grist n'est construite ici. Une personne
 * n'est jamais supprimée. La saisie est conservée en cas de refus ; Échap demande confirmation s'il reste une saisie.
 */
import {
  diffUnav,
  newPersonDraft,
  newPersonFields,
  newUnavFields,
  rebaseUnav,
  shareFromPercent,
  unavDraftFrom,
  validatePerson,
  validateUnav,
} from '../core/person-form.js';
import { conflictBatch, failureKind, runCreate, runSave, runSetActive } from '../core/task-session.js';
import { personDialogRight, rightFailure } from '../core/write-rights.js';
import { EncodeError, dayFromInput, parseNumberFr } from '../core/write-encode.js';
import { label } from '../labels.js';
import { openDialog } from './dialog.js';
import { activeBody, personAddBody, personDialogFoot, unavBody } from '../views/person-form.js';
import { fieldLabel, valueText } from '../views/task-form.js';

const TITLES = Object.freeze({
  add: 'personAdd.title',
  'unav-add': 'unav.add.title',
  'unav-edit': 'unav.edit.title',
  off: 'active.off.title',
});
const FIRST = Object.freeze({
  add: 'pf-nom',
  'unav-add': 'pf-dateDebut',
  'unav-edit': 'pf-dateDebut',
  // Confirmation d'une action à conséquence : focus sur l'action sûre (« Annuler »), motif Alert Dialog de l'APG
  off: 'pf-cancel',
});
const ORDER = Object.freeze(['nom', 'email', 'role', 'capaciteHebdo', 'n_1', 'dateDebut', 'dateFin', 'dispo', 'type']);
const TEXT = new Set(['nom', 'email', 'type', 'commentaire']);

/**
 * @param {{getModel():object, getWriter():object|null, getBase(table:string, id:number):object|null, toast:{show:Function},
 *   onWritten(entry:object):void, onUndo():void, onSessionReadOnly(reason:string):void, afterCreate(ref:object):void,
 *   fetchRow(table:string, id:number):Promise<object|null>, onUnknown():void, timeoutMs():number,
 *   onAddRefused?():void}} deps
 */
export function createPersonDialog(deps) {
  let st = null;
  let dlg = null;
  const model = () => deps.getModel();
  const writer = () => deps.getWriter();
  const table = (kind) => (kind === 'add' || kind === 'off' ? 'Team' : 'Disponibilites');

  function validate() {
    const m = model();
    if (st.kind === 'off') st.validation = { errors: {}, warnings: [] };
    else if (st.kind === 'add') st.validation = validatePerson(st.draft, { model: m });
    else st.validation = validateUnav(st.draft);
    for (const f of st.bad) st.validation.errors[f] = { key: st.badKeys[f] };
    // Erreurs montrées : champs déjà touchés, ou toutes après une tentative d'envoi
    st.allErrors = st.validation.errors;
    st.validation.errors = Object.fromEntries(
      Object.entries(st.allErrors).filter(([f]) => st.tried || st.touched.has(f)),
    );
  }

  const errorCount = () => Object.keys(st.validation.errors).length;
  const body = () =>
    st.kind === 'add'
      ? personAddBody(st, model())
      : st.kind === 'off'
        ? activeBody(st, model())
        : unavBody(st, model());

  function render(focusId) {
    validate();
    dlg.update(body(), personDialogFoot(st, errorCount()), focusId);
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
      const ctl = document.getElementById(`pf-${f}`);
      if (!ctl) continue;
      if (st.validation.errors[f]) ctl.setAttribute('aria-invalid', 'true');
      else ctl.removeAttribute('aria-invalid');
      ctl.closest('.tf-field')?.classList.toggle('fr-input-group--error', Boolean(st.validation.errors[f]));
    }
    const foot = dlg.root.querySelector('.cdlg__foot');
    if (foot) foot.innerHTML = personDialogFoot(st, errorCount()).toString();
  }

  const dirty = () => st.kind !== 'off' && JSON.stringify(st.draft) !== st.initial;

  function close() {
    st = null;
    dlg?.close();
    dlg = null;
  }

  function requestClose() {
    if (!st || st.busy) return;
    if (!dirty() || st.locked) return close();
    st.leave = true;
    render('pf-leave-continue');
  }

  /**
   * Ouvre une fenêtre.
   * @param {'add'|'unav-add'|'unav-edit'|'off'} kind
   * @param {{personId?:number, unavId?:number}} [ctx]
   */
  function open(kind, ctx = {}) {
    const w = writer();
    if (!w || dlg || !TITLES[kind]) return false;
    const t = table(kind);
    if (!personDialogRight(w, kind).ok) return false;
    const m = model();
    st = {
      kind,
      table: t,
      prefix: 'pf',
      mode: w.mode,
      busy: false,
      fail: null,
      leave: false,
      locked: false,
      bad: new Set(),
      badKeys: {},
      touched: new Set(),
      tried: false,
      personId: ctx.personId ?? null,
      unavId: ctx.unavId ?? null,
      can: kind === 'unav-edit' ? (f) => w.can('Disponibilites', f) : () => ({ ok: true, reason: 'ok' }),
      optional: (col) => w.canAddField(t, col),
      validation: { errors: {}, warnings: [] },
    };
    if (kind === 'add') st.draft = newPersonDraft();
    else if (kind === 'unav-add') st.draft = unavDraftFrom(null);
    else if (kind === 'unav-edit') {
      st.base = deps.getBase('Disponibilites', st.unavId);
      if (!st.base) {
        st = null;
        return false;
      }
      st.personId = st.base.membre;
      st.draft = unavDraftFrom(st.base);
    } else if (!m.people.has(st.personId)) {
      st = null;
      return false;
    }
    st.initial = JSON.stringify(st.draft ?? null);
    validate();
    dlg = openDialog({
      title: label(TITLES[kind]),
      body: body(),
      foot: personDialogFoot(st, errorCount()),
      focus: FIRST[kind],
      onRequestClose: requestClose,
    });
    bind(dlg.root);
    return true;
  }

  /** Texte de la saisie, à copier quand elle ne peut pas être enregistrée. */
  const copyText = (fields) =>
    Object.entries(fields)
      .filter(([c]) => !['actif', 'Domaine', 'membre'].includes(c))
      .map(([c, v]) => `${fieldLabel(c, st.table)} : ${valueText(model(), c, v)}`)
      .join('\n');

  /** Échec à afficher ; un refus valant pour toute la session met la page en lecture. */
  function failOf(result, fields) {
    const copy = copyText(fields);
    if (result.kind === 'unknown') {
      deps.onUnknown?.();
      return { kind: 'unknown', reread: false, lines: [], copy };
    }
    if (result.kind === 'missing' || result.kind === 'reread-failed')
      return { kind: result.kind === 'missing' ? 'missing' : 'reread', message: '', copy };
    const k = failureKind(result.error);
    const session = k === 'document' ? 'viewer' : k === 'refused:coupe' || k === 'refused:flags' ? 'flags' : null;
    if (session) {
      st.locked = true;
      deps.onSessionReadOnly(session);
      return { kind: 'session', message: session, copy };
    }
    if (k.startsWith('refused:')) return { kind: 'refused', message: k.slice(8), copy };
    if (k === 'acl' && st.kind !== 'unav-edit') deps.onAddRefused?.();
    return { kind: k === 'acl' ? 'acl' : 'other', message: String(result.error?.message ?? ''), copy };
  }

  /** Personne : nom pour les messages. */
  const nameOf = (id) => model().people.get(id)?.nom || label('common.untitled');

  async function send(cur, opts = {}) {
    const w = writer();
    const fetchRow = (t) => (id) => deps.fetchRow(t, id);
    if (cur.kind === 'add') {
      const fields = newPersonFields(cur.draft, { model: model(), canAddField: (c) => w.canAddField('Team', c) });
      return { fields, result: await runCreate({ writer: w, table: 'Team', fields }) };
    }
    if (cur.kind === 'unav-add') {
      const fields = newUnavFields(cur.draft, cur.personId);
      return { fields, result: await runCreate({ writer: w, table: 'Disponibilites', fields }) };
    }
    if (cur.kind === 'off') {
      const fields = { actif: false };
      const result = await runSetActive({
        writer: w,
        personId: cur.personId,
        actif: false,
        localBase: deps.getBase('Team', cur.personId),
        fetchRow: fetchRow('Team'),
        timeoutMs: deps.timeoutMs?.(),
      });
      return { fields, result };
    }
    const fields = opts.changes ?? diffUnav(cur.base, cur.draft);
    const result = await runSave({
      table: 'Disponibilites',
      diff: diffUnav,
      taskId: cur.unavId,
      base: cur.base,
      draft: cur.draft,
      writer: w,
      fetchRow: fetchRow('Disponibilites'),
      changes: opts.changes,
      before: opts.before,
      timeoutMs: deps.timeoutMs?.(),
    });
    return { fields, result };
  }

  async function submit(opts = {}) {
    if (!st || st.busy || st.locked) return;
    st.tried = true;
    validate();
    if (errorCount()) {
      const first = ORDER.find((f) => st.validation.errors[f]);
      return render(first ? `pf-${first}` : undefined);
    }
    // Droit relu juste avant l'envoi : la session a pu passer en lecture depuis l'ouverture
    const allowed = personDialogRight(writer(), st.kind);
    if (!allowed.ok) {
      st.locked = true;
      // Saisie toujours copiable si un échec précédent l'avait proposée
      st.fail = { ...rightFailure(allowed.reason), copy: st.fail?.copy ?? '' };
      return render('tf-alert');
    }
    const cur = st;
    cur.busy = true;
    cur.fail = null;
    cur.unavConflict = null;
    render('pf-submit');
    const { fields, result } = await send(cur, opts);
    cur.busy = false;
    if (st !== cur) return;
    if (result.kind === 'nothing') {
      close();
      if (cur.kind === 'unav-edit') deps.toast.show(label('unav.toast.nothing'));
      return;
    }
    if (result.kind === 'saved') {
      const entry = result.entry;
      close();
      deps.onWritten(entry);
      const dry = entry.sent ? '' : 'Dry';
      if (cur.kind === 'add') {
        // Une personne créée ne s'annule pas (jamais de suppression) : pas de bouton « Annuler »
        deps.toast.show(
          entry.recovered ? label('personAdd.recovered', { id: entry.id }) : label(`personAdd.toast${dry}`),
        );
        deps.afterCreate?.({ table: 'Team', id: entry.id });
      } else if (cur.kind === 'off')
        deps.toast.show(label(`active.toast.off${dry}`, { nom: nameOf(cur.personId) }), { onAction: deps.onUndo });
      else
        deps.toast.show(label(cur.kind === 'unav-add' ? `unav.toast.add${dry}` : `unav.toast.save${dry}`), {
          onAction: deps.onUndo,
        });
      return;
    }
    if (result.kind === 'conflict') {
      cur.unavConflict = {
        cols: result.cols,
        fresh: result.fresh,
        names: result.cols.map((c) => fieldLabel(c, 'Disponibilites')).join(', '),
      };
      return render('tf-alert');
    }
    cur.fail = failOf(result, fields);
    render('tf-alert');
  }

  /** Conflit sur une indisponibilité : garder sa saisie (lot recalculé sur la ligne relue) ou reprendre la Feuille. */
  function resolveConflict(mine) {
    const { cols, fresh } = st.unavConflict;
    const choices = Object.fromEntries(cols.map((c) => [c, mine ? 'mine' : 'theirs']));
    const batch = conflictBatch(st.base, st.draft, fresh, choices, diffUnav);
    st.draft = rebaseUnav(st.base, st.draft, fresh);
    if (!mine) for (const c of cols) st.draft[c] = unavDraftFrom(fresh)[c];
    else for (const c of cols) st.draft[c] = batch.changes[c] ?? st.draft[c];
    st.base = { ...st.base, ...fresh };
    st.unavConflict = null;
    st.dispoInput = undefined;
    if (mine && Object.keys(batch.changes).length) return void submit({ changes: batch.changes, before: batch.before });
    render('pf-submit');
  }

  function setNumber(f, value) {
    try {
      const n = parseNumberFr(value);
      if (f === 'capaciteHebdo') {
        st.draft.capaciteHebdo = n;
        st.bad.delete(f);
      } else {
        const v = shareFromPercent(n);
        if (v === null) throw new EncodeError('part');
        st.draft.dispo = v;
        st.bad.delete(f);
      }
    } catch (err) {
      if (!(err instanceof EncodeError)) throw err;
      st.bad.add(f);
      st.badKeys[f] = f === 'capaciteHebdo' ? 'person.error.capacity' : 'unav.error.dispo';
    }
  }

  function bind(root) {
    root.addEventListener('input', (e) => {
      if (!st || st.busy) return;
      const f = e.target.dataset.input;
      if (!f) return;
      st.touched.add(f);
      if (TEXT.has(f)) st.draft[f] = e.target.value;
      else if (f === 'capaciteHebdo' || f === 'dispo') {
        if (f === 'capaciteHebdo') st.capacityInput = e.target.value;
        else st.dispoInput = e.target.value;
        setNumber(f, e.target.value);
      } else return;
      refresh();
    });
    root.addEventListener('change', (e) => {
      if (!st || st.busy) return;
      const t = e.target;
      const f = t.dataset.input;
      if (!f) return;
      st.touched.add(f);
      if (f === 'role') st.draft.role = t.value;
      else if (f === 'n_1') st.draft.n_1 = t.value ? Number(t.value) : null;
      else if (f === 'dateDebut' || f === 'dateFin') {
        st.touched.add('dateFin');
        try {
          st.draft[f] = dayFromInput(t.value);
          st.bad.delete(f);
        } catch (err) {
          if (!(err instanceof EncodeError)) throw err;
          st.bad.add(f);
          st.badKeys[f] = 'form.error.date';
        }
      } else return;
      refresh();
    });
    root.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t || !st) return;
      const a = t.dataset.pdAction;
      if (a === 'leave-continue') {
        st.leave = false;
        return render(FIRST[st.kind]);
      }
      if (a === 'leave-discard') return close();
      if (st.busy) return;
      if (a === 'cancel') return requestClose();
      if (a === 'submit') return void submit();
      if (a === 'conflict-mine') return resolveConflict(true);
      if (a === 'conflict-theirs') return resolveConflict(false);
    });
    root.addEventListener('keydown', (e) => {
      if (!st || e.key !== 'Enter') return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        submit();
      } else if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') e.preventDefault();
    });
  }

  return { open, isOpen: () => dlg !== null };
}
