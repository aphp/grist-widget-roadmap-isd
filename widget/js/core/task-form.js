/**
 * Formulaire d'une tâche ou sous-tâche (lot 2a) : brouillon, différences, statut rapide, jalon, validation,
 * candidats des sélecteurs, droit de modifier. Fonctions pures, sans écriture (l'envoi est grist-writer.js).
 *
 * Le brouillon contient les valeurs du modèle des colonnes modifiables : jours (dates), identifiants (Ref),
 * listes d'identifiants (RefList), textes et nombre (progression).
 */
import {
  chargeRows,
  mergeCharges,
  periodFte,
  periodState,
  readChargesCell,
  sameCharges,
  withPeopleFrom,
} from './charges-edit.js';
import { dateMaxError, overMaxDay } from './dates.js';
import { chantierInScope } from './chantier-form.js';
import { safeLink } from './detail-data.js';
import { personInScope } from './person-form.js';
import { mergeTags } from './tags-edit.js';
import { pickerGroups } from './team-directory.js';
import { sameValue } from './write-encode.js';

/** Champs visibles par défaut, puis ceux de « Plus de champs ». */
export const MAIN_FIELDS = Object.freeze([
  'titre',
  'statut',
  'type',
  'dateDebut',
  'dateEcheance',
  'priorite',
  'Responsable',
  'assignees',
  'charges',
  'tags',
]);
export const MORE_FIELDS = Object.freeze([
  'description',
  'Commentaire',
  'Lien_utile',
  'progression',
  'parentTask',
  'dependDe',
  'dateCloture',
]);
export const FORM_FIELDS = Object.freeze([...MAIN_FIELDS, ...MORE_FIELDS]);

export const TITLE_MAX = 300;
export const PRIORITIES = Object.freeze(['1', '2', '3', '4']);
export const DONE_STATUS = 'done';
const MAX_DEPTH = 50;

/** Égalité de deux valeurs d'un champ : sur les valeurs JSON pour les charges, stricte pour le reste. */
export const sameField = (f, a, b) => (f === 'charges' ? sameCharges(a, b) : sameValue(a, b));

/** Brouillon initial (copie) depuis les valeurs relues de la ligne. */
export function draftFrom(base) {
  return Object.fromEntries(FORM_FIELDS.map((f) => [f, Array.isArray(base[f]) ? [...base[f]] : base[f]]));
}

/** Champs texte dont les espaces de début et de fin sont retirés à l'enregistrement. */
const TRIMMED = Object.freeze(['titre', 'Lien_utile']);

/**
 * Colonnes modifiées : seules celles-ci sont envoyées. Le titre et le lien saisis sont nettoyés de leurs espaces
 * de bord ; une valeur non touchée n'est jamais retouchée (pas d'écriture fantôme).
 */
export function diffDraft(base, draft) {
  const out = {};
  for (const f of FORM_FIELDS) {
    if (!(f in draft) || sameField(f, base[f], draft[f])) continue;
    const v = TRIMMED.includes(f) && typeof draft[f] === 'string' ? draft[f].trim() : draft[f];
    if (!sameField(f, base[f], v)) out[f] = v;
  }
  return out;
}

/**
 * Charges du brouillon rebasées sur une cellule relue. typed : personnes saisies dans le formulaire, seules
 * comptées comme « miennes » (les autres, recalculées ou non, repartent de la base ; l'appelant les recalcule
 * depuis la cellule relue) ; sans typed, tout le brouillon. Personne en conflit : sa saisie est gardée dans raw.
 * @param {string|null} oldRaw cellule de la base
 * @param {string|null} draftRaw cellule du brouillon
 * @param {string|null} freshRaw cellule relue
 * @param {Set<number>|null} [typed]
 * @returns {{raw:string|null, conflicts:number[]}|null} null : cellule illisible (le brouillon est gardé)
 */
export function rebaseCharges(oldRaw, draftRaw, freshRaw, typed = null) {
  const mine = typed ? withPeopleFrom(oldRaw, draftRaw, typed) : draftRaw;
  if (mine === null) return null;
  if (sameCharges(oldRaw, mine)) return { raw: freshRaw, conflicts: [] };
  const m = mergeCharges(oldRaw, mine, freshRaw);
  return m.ok ? { raw: m.raw, conflicts: m.conflicts } : null;
}

/**
 * Nouvelle base (ligne relue) : les champs que l'utilisateur n'a pas touchés suivent la Feuille, pour qu'un
 * nouvel essai n'écrase jamais la modification de quelqu'un d'autre ; les champs saisis sont conservés. Les
 * charges sont fusionnées personne par personne avec la cellule relue (rebaseCharges ; une personne en conflit
 * garde sa saisie) ; les tags saisis (ajouts, retraits) sont appliqués à la cellule relue.
 * @param {{typed?:Set<number>|null}} [opts] typed : personnes dont la charge a été saisie dans le formulaire
 */
export function rebaseDraft(oldBase, draft, fresh, { typed = null } = {}) {
  const out = { ...draft };
  for (const f of FORM_FIELDS) {
    if (!(f in fresh)) continue;
    if (sameField(f, oldBase[f], draft[f])) out[f] = Array.isArray(fresh[f]) ? [...fresh[f]] : fresh[f];
    else if (f === 'charges') {
      const r = rebaseCharges(oldBase.charges, draft.charges, fresh.charges, typed);
      if (r) out.charges = r.raw;
    } else if (f === 'tags') out.tags = mergeTags(oldBase.tags, draft.tags, fresh.tags);
  }
  return out;
}

/**
 * Changement de statut rapide (enregistré tout de suite). Passage à « done » : date de clôture = aujourd'hui si
 * elle est vide. Réouverture : la date de clôture est conservée (on propose de la vider dans la fiche).
 * @returns {object} colonnes à écrire ({} si rien ne change)
 */
export function statusChanges(base, status, today) {
  if (sameValue(base.statut, status)) return {};
  const out = { statut: status };
  if (status === DONE_STATUS && base.dateCloture === null) out.dateCloture = today;
  return out;
}

/**
 * Case « Jalon » : type = jalon, une seule date (début = échéance). Décochée : le type d'origine est rendu
 * (« tache » si c'était un jalon) ; « reunion », une valeur vide ou toute autre valeur est conservée.
 */
export function setMilestone(draft, on, originalType) {
  if (on) {
    const date = draft.dateEcheance ?? draft.dateDebut;
    return { ...draft, type: 'jalon', dateDebut: date, dateEcheance: date };
  }
  return { ...draft, type: originalType === 'jalon' ? 'tache' : (originalType ?? '') };
}

/** Ancêtres de la tâche (parent, grand-parent…), selon un parent éventuellement modifié. */
function ancestors(model, taskId, parentId) {
  const out = [];
  for (let p = parentId, i = 0; p && i < MAX_DEPTH; p = model.tasks.get(p)?.parentId, i++) {
    out.push(p);
    if (p === taskId) break;
  }
  return out;
}

/** Vrai si donner ce parent à la tâche créerait un cycle (la tâche serait son propre ancêtre). */
export function parentCycle(model, taskId, parentId) {
  return parentId !== null && ancestors(model, taskId, parentId).includes(taskId);
}

/** Vrai si ces dépendances créeraient un cycle (la tâche dépendrait, directement ou non, d'elle-même). */
export function dependCycle(model, taskId, depIds) {
  const seen = new Set();
  const stack = [...depIds];
  while (stack.length) {
    const id = stack.pop();
    if (id === taskId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(model.tasks.get(id)?.dependDe ?? []));
  }
  return false;
}

/** Sous-tâches de la tâche, à toute profondeur. */
export function descendants(model, taskId) {
  const out = new Set();
  const stack = [...(model.tasks.get(taskId)?.childIds ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(model.tasks.get(id)?.childIds ?? []));
  }
  return out;
}

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
const byTitle = (model) => (a, b) => collator.compare(model.tasks.get(a)?.title ?? '', model.tasks.get(b)?.title ?? '');

/** Chantier effectif d'une tâche (le sien, sinon celui d'un ancêtre). */
export function chantierOf(model, task) {
  for (let t = task, i = 0; t && i < MAX_DEPTH; t = model.tasks.get(t.parentId), i++)
    if (t.chantierId) return t.chantierId;
  return null;
}

/**
 * Tâches pouvant servir de parent : même chantier (ou, sans chantier, même projet et sans chantier), hors la tâche et
 * ses sous-tâches (cycle), par titre.
 */
export function parentCandidates(model, taskId) {
  const task = model.tasks.get(taskId);
  if (!task) return [];
  const ch = chantierOf(model, task);
  const banned = descendants(model, taskId);
  banned.add(taskId);
  return [...model.tasks.values()]
    .filter((t) => !banned.has(t.id))
    .filter((t) =>
      ch
        ? chantierOf(model, t) === ch
        : !chantierOf(model, t) && task.projectId !== null && t.projectId === task.projectId,
    )
    .map((t) => t.id)
    .sort(byTitle(model));
}

const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/**
 * Recherche de tâches par titre (dépendances) : la tâche elle-même et celles déjà choisies sont exclues ; les
 * tâches du même chantier passent en premier.
 * @returns {number[]}
 */
export function searchTasks(model, taskId, query, exclude = [], limit = 8) {
  const q = fold(query).trim();
  if (q.length < 2) return [];
  const task = model.tasks.get(taskId);
  const ch = task ? chantierOf(model, task) : null;
  const out = new Set(exclude);
  out.add(taskId);
  const hits = [...model.tasks.values()].filter((t) => !out.has(t.id) && fold(t.title).includes(q));
  const same = (t) => (ch && chantierOf(model, t) === ch ? 0 : 1);
  return hits
    .sort((a, b) => same(a) - same(b) || collator.compare(a.title, b.title))
    .slice(0, limit)
    .map((t) => t.id);
}

/**
 * Personnes des sélecteurs : seule l'équipe ISD active est proposée à l'ajout (groupes de pickerGroups : profils
 * PO, DA, DS, DE puis Management du Domaine ISD). `kept` liste les personnes déjà choisies (`selected`) hors de
 * ces groupes (hors équipe ISD ou inactives) : elles restent affichées pour ne jamais perdre une valeur.
 * @returns {{isd:number[], kept:number[]}}
 */
export function personCandidates(model, selected = []) {
  const isd = pickerGroups(model).flatMap((g) => g.people.map((p) => p.id));
  const kept = selected.filter((id, i) => !isd.includes(id) && selected.indexOf(id) === i);
  return { isd, kept };
}

/** La tâche appartient-elle au périmètre ISD (un de ses projets, ou ceux de son chantier, est dans le périmètre) ? */
export function taskInScope(model, task) {
  for (let t = task, i = 0; t && i < MAX_DEPTH; t = model.tasks.get(t.parentId), i++) {
    if (model.projects.get(t.projectId)?.inScope) return true;
    const ch = model.chantiers.get(t.chantierId);
    if (ch?.projectIds.some((p) => model.projects.get(p)?.inScope)) return true;
  }
  return false;
}

/**
 * Peut-on modifier cet élément dans le widget ?
 * @param {object} model
 * @param {{table:string, id:number}} ref
 * @param {{mode:string, canEdit:boolean, reason:string}} edit état d'édition de la session (edit-switch.js)
 * @returns {{editable:boolean, reason:string}} reason : 'ok', 'off', 'flags', 'doc', 'viewer', 'scope',
 *   'projet', 'autre'
 */
export function editAvailability(model, ref, edit) {
  if (ref.table === 'Projects') return { editable: false, reason: 'projet' };
  const known =
    ref.table === 'Tasks'
      ? model.tasks.has(ref.id)
      : ref.table === 'Chantiers'
        ? model.chantiers.has(ref.id)
        : ref.table === 'Team' && model.people.has(ref.id);
  if (!known) return { editable: false, reason: 'autre' };
  if (edit.mode === 'off') return { editable: false, reason: edit.reason };
  if (!edit.canEdit) return { editable: false, reason: edit.reason };
  const inScope =
    ref.table === 'Tasks'
      ? taskInScope(model, model.tasks.get(ref.id))
      : ref.table === 'Team'
        ? personInScope(model, model.people.get(ref.id))
        : chantierInScope(model, model.chantiers.get(ref.id));
  if (!inScope) return { editable: false, reason: 'scope' };
  return { editable: true, reason: 'ok' };
}

/**
 * Règles du formulaire. Les erreurs bloquent l'enregistrement ; les avertissements non.
 * @param {object} draft brouillon
 * @param {{model:object, taskId:number, statuses?:string[], priorities?:string[],
 *   base?:{dateDebut:number|null, dateEcheance:number|null}, keptOver?:Set<number>, notRescaled?:boolean,
 *   maxDay?:number}} ctx maxDay : dernier jour de planification (une date plus tardive est refusée, sauf valeur
 *   d'origine) ; base : période de la tâche à l'ouverture ; keptOver : personnes dont les heures n'ont pas été
 *   recalculées après un changement de dates (au-dessus de la borne), signalées si les dates diffèrent de la base ;
 *   notRescaled : recalcul des charges refusé par les droits (signalé)
 * @returns {{errors:Record<string,{key:string, vars?:object}>, warnings:{field:string, key:string, vars?:object}[]}}
 */
export function validateTask(
  draft,
  { model, taskId, statuses = [], priorities = [], base = null, keptOver = new Set(), notRescaled = false, maxDay },
) {
  const errors = {};
  const warnings = [];
  const title = String(draft.titre ?? '').trim();
  if (!title) errors.titre = { key: 'form.error.titleEmpty' };
  else if (title.length > TITLE_MAX) errors.titre = { key: 'form.error.titleLong', vars: { max: TITLE_MAX } };
  if (draft.dateDebut !== null && draft.dateEcheance !== null && draft.dateEcheance < draft.dateDebut)
    errors.dateEcheance = { key: 'form.error.endBeforeStart' };
  else {
    const orig = base ?? model.tasks.get(taskId);
    if (overMaxDay(draft.dateDebut, maxDay, orig?.dateDebut ?? orig?.start ?? null))
      errors.dateDebut = dateMaxError(maxDay);
    if (overMaxDay(draft.dateEcheance, maxDay, orig?.dateEcheance ?? orig?.end ?? null))
      errors.dateEcheance = dateMaxError(maxDay);
  }
  const link = String(draft.Lien_utile ?? '').trim();
  if (link && !safeLink(link)) errors.Lien_utile = { key: 'form.error.link' };
  if (
    draft.progression !== null &&
    (!Number.isFinite(draft.progression) || draft.progression < 0 || draft.progression > 100)
  )
    errors.progression = { key: 'form.error.progression' };
  if (draft.parentTask !== null) {
    if (!model.tasks.has(draft.parentTask)) errors.parentTask = { key: 'form.error.missingRef' };
    else if (parentCycle(model, taskId, draft.parentTask)) errors.parentTask = { key: 'form.error.parentCycle' };
  }
  if (draft.dependDe.some((d) => !model.tasks.has(d))) errors.dependDe = { key: 'form.error.missingRef' };
  else if (dependCycle(model, taskId, draft.dependDe)) errors.dependDe = { key: 'form.error.dependCycle' };
  if (draft.Responsable !== null && !model.people.has(draft.Responsable))
    errors.Responsable = { key: 'form.error.missingRef' };
  if (draft.assignees.some((a) => !model.people.has(a))) errors.assignees = { key: 'form.error.missingRef' };

  const parent = draft.parentTask !== null ? model.tasks.get(draft.parentTask) : null;
  if (
    parent &&
    ((parent.start !== null && draft.dateDebut !== null && draft.dateDebut < parent.start) ||
      (parent.end !== null && draft.dateEcheance !== null && draft.dateEcheance > parent.end))
  )
    warnings.push({ field: 'dateDebut', key: 'form.warn.outsideParent' });
  const cell = readChargesCell(draft.charges);
  const { rows } = cell.ok ? chargeRows(cell.entries) : { rows: [] };
  if (rows.some((r) => r.heures > 0) && (draft.dateDebut === null || draft.dateEcheance === null))
    warnings.push({ field: 'dateDebut', key: 'form.warn.chargesNoDates' });
  // Période sans jour ouvré : comme sans dates, l'ETP n'est pas calculable
  else if (rows.some((r) => r.heures > 0) && periodState(draft.dateDebut, draft.dateEcheance) === 'noWorkday')
    warnings.push({ field: 'dateDebut', key: 'form.warn.chargesNoWorkdays' });
  const dup = rows.filter((r) => r.count > 1).length;
  if (dup) warnings.push({ field: 'charges', key: 'form.warn.chargesDuplicate', vars: { n: dup } });
  // Dates ajoutées ou modifiées : l'ETP fait foi et les heures sont recalculées (people-block.js) ; les charges qui
  // dépasseraient la borne sur la nouvelle période sont laissées telles quelles (keptOver) et signalées ici
  const fte = periodFte(draft.dateDebut, draft.dateEcheance);
  if (base && fte && fte !== periodFte(base.dateDebut, base.dateEcheance)) {
    const over = rows.filter((r) => keptOver.has(r.teamId)).length;
    if (over) warnings.push({ field: 'charges', key: 'form.warn.chargesOverDates', vars: { n: over } });
  }
  // Recalcul refusé (colonne des charges non modifiable) : heures inchangées, leur ETP suit la nouvelle période
  if (notRescaled) warnings.push({ field: 'charges', key: 'form.warn.chargesNotRescaled' });
  const unknown = rows.filter((r) => !model.people.has(r.teamId)).length;
  if (unknown) warnings.push({ field: 'charges', key: 'form.warn.chargesUnknown', vars: { n: unknown } });
  if (draft.statut === DONE_STATUS && draft.dateCloture === null)
    warnings.push({ field: 'dateCloture', key: 'form.warn.doneNoClosure' });
  if (draft.statut !== DONE_STATUS && draft.dateCloture !== null)
    warnings.push({ field: 'dateCloture', key: 'form.warn.reopened' });
  if (draft.statut && statuses.length && !statuses.includes(draft.statut))
    warnings.push({ field: 'statut', key: 'form.warn.choice', vars: { valeur: draft.statut } });
  if (draft.priorite && priorities.length && !priorities.includes(draft.priorite))
    warnings.push({ field: 'priorite', key: 'form.warn.choice', vars: { valeur: draft.priorite } });
  return { errors, warnings };
}

/** Vrai si une erreur bloque l'enregistrement. */
export const hasErrors = (v) => Object.keys(v.errors).length > 0;
