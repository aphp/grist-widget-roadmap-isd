/**
 * Fenêtres de création (lot 2c) : « Nouvelle tâche », « Sous-tâche », « Nouveau chantier », et changement de
 * chantier d'une tâche (ses sous-tâches suivent). Valeurs par défaut tirées du contexte (filtres projet et chantier,
 * statut filtré, « Je suis… », tâche parente), validation, valeurs à créer. Fonctions pures, sans écriture.
 */
import {
  CHANTIER_NAME_MAX,
  DEFAULT_CHANTIER_STATUS,
  descendantsIn,
  taskLinksFromModel,
  validateChantier,
} from './chantier-form.js';
import { dateMaxError, overMaxDay } from './dates.js';
import { chargeMaxOf, chargeRows, periodFte, readChargesCell } from './charges-edit.js';
import { TITLE_MAX, chantierOf } from './task-form.js';

/** Champs de la fenêtre « Nouvelle tâche » : obligatoires d'abord, puis « Plus d'options ». */
export const NEW_TASK_MAIN = Object.freeze([
  'titre',
  'cible',
  'statut',
  'type',
  'dateDebut',
  'dateEcheance',
  'assignees',
  'charges',
]);
export const NEW_TASK_MORE = Object.freeze(['Responsable', 'priorite', 'description']);
/** Champs de la fenêtre « Nouveau chantier ». */
export const NEW_CHANTIER_MAIN = Object.freeze(['Nom_du_chantier', 'Projets', 'Statut', 'Debut', 'Fin', 'Responsable']);
export const NEW_CHANTIER_MORE = Object.freeze(['Contributeurs', 'Description']);

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
const byTitle = (a, b) => collator.compare(a.title, b.title);

/**
 * Valeur de Cree_par (Q11 A) : partie locale de l'e-mail de la personne « Je suis… », au format des valeurs de la
 * Feuille (« margaux.ghilardi »). null si la personne est inconnue ou son e-mail inexploitable.
 */
export function creePar(model, meId) {
  const email = model.people.get(meId)?.email ?? '';
  const m = /^([^\s@]{1,100})@[^\s@]+$/.exec(email.trim());
  return m ? m[1] : null;
}

/** Valeur d'option « chantier dans un projet » des listes de rattachement (un chantier partagé apparaît par projet). */
export const targetValue = (chantierId, projectId) => (chantierId && projectId ? `${chantierId}:${projectId}` : '');

/** Chantier et projet d'une valeur d'option ({chantierId:null, projectId:null} si vide ou invalide). */
export function parseTarget(value) {
  const m = /^(\d+):(\d+)$/.exec(String(value ?? ''));
  return m ? { chantierId: Number(m[1]), projectId: Number(m[2]) } : { chantierId: null, projectId: null };
}

/**
 * Chantiers proposés au rattachement : sous chaque projet du périmètre ISD (par titre), ses chantiers (par titre).
 * @returns {{project:{id:number, title:string}, chantiers:{id:number, title:string}[]}[]}
 */
export function chantierOptions(model) {
  return [...model.projects.values()]
    .filter((p) => p.inScope)
    .sort(byTitle)
    .map((p) => ({
      project: { id: p.id, title: p.title },
      chantiers: [...model.chantiers.values()]
        .filter((c) => c.projectIds.includes(p.id))
        .sort(byTitle)
        .map((c) => ({ id: c.id, title: c.title })),
    }))
    .filter((g) => g.chantiers.length);
}

/** Projets du périmètre ISD proposés pour un nouveau chantier, par titre. */
export function projectOptions(model) {
  return [...model.projects.values()]
    .filter((p) => p.inScope)
    .sort(byTitle)
    .map((p) => ({ id: p.id, title: p.title }));
}

/**
 * Contexte de préremplissage depuis les filtres actifs : chantier et projet choisis, statut s'il n'y en a qu'un,
 * « Je suis… ».
 * @returns {{chantierId:number|null, projectId:number|null, status:string|null, me:number|null}}
 */
export function prefillFromFilters(model, filters = {}, prefs = {}) {
  const node = (k) => (k ? model.nodes.get(k) : null);
  const ch = node(filters.chantier);
  const pr = node(filters.projet);
  return {
    chantierId: ch?.ref?.table === 'Chantiers' ? ch.ref.id : null,
    projectId: ch?.projectId ?? (pr?.ref?.table === 'Projects' ? pr.ref.id : null),
    status: filters.statuses?.length === 1 ? filters.statuses[0] : null,
    me: Number.isInteger(prefs.me) ? prefs.me : null,
  };
}

/** Projet de rattachement d'une tâche du chantier : celui demandé s'il en fait partie, sinon le premier ISD. */
function projectFor(model, chantier, wanted) {
  if (!chantier) return null;
  if (wanted && chantier.projectIds.includes(wanted)) return wanted;
  return chantier.projectIds.find((p) => model.projects.get(p)?.inScope) ?? chantier.projectIds[0] ?? null;
}

/**
 * Brouillon d'une nouvelle tâche ou sous-tâche.
 * - Sous-tâche (parentId) : chantier et projet copiés du parent, dates du parent proposées.
 * - Sinon : chantier et projet du contexte (filtres), statut du contexte, sinon « todo ».
 * - Bloc « Personnes » : « Je suis… » assigné par défaut, charge vide (aucune entrée).
 * @param {object} model
 * @param {{chantierId?:number|null, projectId?:number|null, parentId?:number|null, status?:string|null,
 *          me?:number|null, statuses?:string[]}} ctx
 */
export function newTaskDraft(model, ctx = {}) {
  const statuses = ctx.statuses ?? model.statuses?.tasks ?? [];
  const parent = ctx.parentId ? model.tasks.get(ctx.parentId) : null;
  const chantierId = parent
    ? chantierOf(model, parent)
    : ctx.chantierId && model.chantiers.has(ctx.chantierId)
      ? ctx.chantierId
      : null;
  const chantier = chantierId ? model.chantiers.get(chantierId) : null;
  const projet =
    parent?.projectId && chantier?.projectIds.includes(parent.projectId)
      ? parent.projectId
      : projectFor(model, chantier, ctx.projectId ?? null);
  const fallback = statuses.includes('todo') ? 'todo' : (statuses[0] ?? 'todo');
  return {
    titre: '',
    Chantier: chantierId,
    projet,
    parentTask: parent ? parent.id : null,
    statut: ctx.status && statuses.includes(ctx.status) ? ctx.status : fallback,
    type: 'tache',
    dateDebut: parent?.start ?? null,
    dateEcheance: parent?.end ?? null,
    assignees: ctx.me && model.people.has(ctx.me) ? [ctx.me] : [],
    charges: '',
    Responsable: null,
    priorite: '',
    description: '',
  };
}

/** Case « Jalon » de la fenêtre de création : une seule date (début = échéance). */
export function setNewMilestone(draft, on) {
  if (!on) return { ...draft, type: 'tache' };
  const date = draft.dateEcheance ?? draft.dateDebut;
  return { ...draft, type: 'jalon', dateDebut: date, dateEcheance: date };
}

/**
 * Règles de la fenêtre « Nouvelle tâche » (ou « Sous-tâche »). Erreurs bloquantes, avertissements non bloquants.
 * @returns {{errors:Record<string,{key:string, vars?:object}>, warnings:{field:string, key:string, vars?:object}[]}}
 */
export function validateNewTask(draft, { model, statuses = [], maxDay }) {
  const errors = {};
  const warnings = [];
  const title = String(draft.titre ?? '').trim();
  if (!title) errors.titre = { key: 'form.error.titleEmpty' };
  else if (title.length > TITLE_MAX) errors.titre = { key: 'form.error.titleLong', vars: { max: TITLE_MAX } };
  const chantier = draft.Chantier ? model.chantiers.get(draft.Chantier) : null;
  if (!draft.Chantier) errors.cible = { key: 'form.error.chantierRequired' };
  else if (!chantier) errors.cible = { key: 'form.error.missingRef' };
  else if (!draft.projet || !chantier.projectIds.includes(draft.projet))
    errors.cible = { key: 'form.error.projetChantier' };
  else if (
    !model.projects.get(draft.projet)?.inScope &&
    !chantier.projectIds.some((p) => model.projects.get(p)?.inScope)
  )
    errors.cible = { key: 'form.error.scope' };
  const parent = draft.parentTask ? model.tasks.get(draft.parentTask) : null;
  if (draft.parentTask && !parent) errors.parentTask = { key: 'form.error.missingRef' };
  else if (parent && chantierOf(model, parent) !== draft.Chantier)
    errors.parentTask = { key: 'form.error.parentChantier' };
  if (draft.dateDebut !== null && draft.dateEcheance !== null && draft.dateEcheance < draft.dateDebut)
    errors.dateEcheance = { key: 'form.error.endBeforeStart' };
  else {
    if (overMaxDay(draft.dateDebut, maxDay)) errors.dateDebut = dateMaxError(maxDay);
    if (overMaxDay(draft.dateEcheance, maxDay)) errors.dateEcheance = dateMaxError(maxDay);
  }
  if (draft.Responsable !== null && !model.people.has(draft.Responsable))
    errors.Responsable = { key: 'form.error.missingRef' };
  if (draft.assignees.some((a) => !model.people.has(a))) errors.assignees = { key: 'form.error.missingRef' };
  const charges = newChargesError(draft, model);
  if (charges) errors.charges = charges;

  if (title && chantier) {
    const same = [...model.tasks.values()].some(
      (t) => t.chantierId === draft.Chantier && collator.compare(t.title, title) === 0,
    );
    if (same) warnings.push({ field: 'titre', key: 'form.warn.duplicateTitle' });
  }
  if (
    parent &&
    ((parent.start !== null && draft.dateDebut !== null && draft.dateDebut < parent.start) ||
      (parent.end !== null && draft.dateEcheance !== null && draft.dateEcheance > parent.end))
  )
    warnings.push({ field: 'dateDebut', key: 'form.warn.outsideParent' });
  if (draft.statut && statuses.length && !statuses.includes(draft.statut))
    warnings.push({ field: 'statut', key: 'form.warn.choice', vars: { valeur: draft.statut } });
  return { errors, warnings };
}

/**
 * Charges d'une nouvelle tâche, avec les règles du writer à la création : chaque personne chargée est assignée et
 * existe, au plus 1 ETP sur la période des dates saisies (2 000 h sans dates), la personne estimation bornée à
 * ESTIMATION_MAX_ETP. Une charge déjà saisie qui dépasse la borne après un changement de dates bloque la création.
 * @returns {{key:string, vars?:object}|null}
 */
export function newChargesError(draft, model) {
  const cell = readChargesCell(draft.charges);
  if (!cell.ok) return { key: 'form.error.charges' };
  const { rows, invalid } = chargeRows(cell.entries);
  if (
    invalid.length ||
    rows.some((r) => r.count > 1 || !model.people.has(r.teamId) || !draft.assignees.includes(r.teamId))
  )
    return { key: 'form.error.charges' };
  const over = overCapRows(draft, model)[0];
  return over ? { key: 'create.error.chargesOver', vars: { h: over.max } } : null;
}

/** Lignes de charge au-dessus de la borne sur la période saisie : {teamId, max (h)}. */
function overCapRows(draft, model) {
  const cell = readChargesCell(draft.charges);
  if (!cell.ok) return [];
  const fte = periodFte(draft.dateDebut, draft.dateEcheance);
  const bound = chargeMaxOf(model);
  return chargeRows(cell.entries)
    .rows.map((r) => ({ teamId: r.teamId, heures: r.heures, max: bound(r.teamId, fte) }))
    .filter((r) => r.heures > r.max)
    .map(({ teamId, max }) => ({ teamId, max }));
}

/** Personnes dont la charge dépasse la borne (champs à signaler et à focaliser dans la fenêtre). */
export const overCapTeamIds = (draft, model) => overCapRows(draft, model).map((r) => r.teamId);

/**
 * Saisie « Personnes » que newTaskFields n'enverrait pas (colonne non permise à la création par le writer) :
 * charges saisies, ou assignés choisis (touchés) par l'utilisateur. Sert à bloquer l'envoi plutôt que de perdre
 * la saisie sans le dire.
 * @param {object} draft
 * @param {object} fields résultat de newTaskFields (avec canAddField)
 * @param {{assigneesTouched?:boolean}} [opts]
 * @returns {{charges:boolean, assignees:boolean}}
 */
export function droppedPeople(draft, fields, opts = {}) {
  const cell = readChargesCell(draft.charges);
  const charged = cell.ok && cell.entries.length > 0;
  return {
    charges: charged && !('charges' in fields),
    assignees: Boolean(opts.assigneesTouched) && draft.assignees.length > 0 && !('assignees' in fields),
  };
}

/**
 * Valeurs de la tâche à créer (writer.add('Tasks', …)) : seules les valeurs renseignées sont envoyées ; Cree_par
 * (Q11) si connu ; une colonne que le writer ne permet pas à la création (canAddField) est omise.
 * @param {object} draft
 * @param {{creePar?:string|null, canAddField?:(col:string) => boolean}} [opts]
 */
export function newTaskFields(draft, opts = {}) {
  const ok = opts.canAddField ?? (() => true);
  const out = {
    titre: String(draft.titre ?? '').trim(),
    Chantier: draft.Chantier,
    projet: draft.projet,
    statut: draft.statut,
    type: draft.type,
  };
  if (draft.parentTask) out.parentTask = draft.parentTask;
  if (draft.dateDebut !== null) out.dateDebut = draft.dateDebut;
  if (draft.dateEcheance !== null) out.dateEcheance = draft.dateEcheance;
  if (draft.assignees.length) out.assignees = [...draft.assignees];
  // Charges (bloc « Personnes ») : seulement s'il y a au moins une entrée
  const cell = readChargesCell(draft.charges);
  if (cell.ok && cell.entries.length) out.charges = draft.charges;
  if (draft.Responsable !== null) out.Responsable = draft.Responsable;
  if (draft.priorite) out.priorite = draft.priorite;
  const desc = String(draft.description ?? '').trim();
  if (desc) out.description = desc;
  if (opts.creePar) out.Cree_par = opts.creePar;
  for (const c of Object.keys(out)) if (!['titre', 'Chantier', 'projet'].includes(c) && !ok(c)) delete out[c];
  // Charges et assignés vont ensemble : sans assignés permis, aucune charge n'est envoyée
  if (!out.assignees) delete out.charges;
  return out;
}

/** Brouillon d'un nouveau chantier : projet du contexte, statut « À cadrer », responsable « Je suis… ». */
export function newChantierDraft(model, ctx = {}) {
  const statuses = ctx.statuses ?? model.statuses?.chantiers ?? [];
  const p = ctx.projectId && model.projects.get(ctx.projectId)?.inScope ? ctx.projectId : null;
  return {
    Nom_du_chantier: '',
    Projets: p ? [p] : [],
    Statut: statuses.includes(DEFAULT_CHANTIER_STATUS)
      ? DEFAULT_CHANTIER_STATUS
      : (statuses[0] ?? DEFAULT_CHANTIER_STATUS),
    Debut: null,
    Fin: null,
    Responsable: ctx.me && model.people.has(ctx.me) ? ctx.me : null,
    Contributeurs: [],
    Description: '',
  };
}

/** Règles de la fenêtre « Nouveau chantier » (celles de la fiche chantier, sans chantier existant). */
export function validateNewChantier(draft, { model, statuses = [], maxDay }) {
  return validateChantier(draft, { model, chantierId: null, statuses, maxDay });
}

/** Valeurs du chantier à créer (writer.add('Chantiers', …)) : seules les valeurs renseignées sont envoyées. */
export function newChantierFields(draft, opts = {}) {
  const ok = opts.canAddField ?? (() => true);
  const out = {
    Nom_du_chantier: String(draft.Nom_du_chantier ?? '')
      .trim()
      .slice(0, CHANTIER_NAME_MAX),
    Projets: [...draft.Projets],
  };
  if (draft.Statut) out.Statut = draft.Statut;
  if (draft.Debut !== null) out.Debut = draft.Debut;
  if (draft.Fin !== null) out.Fin = draft.Fin;
  if (draft.Responsable !== null) out.Responsable = draft.Responsable;
  if (draft.Contributeurs.length) out.Contributeurs = [...draft.Contributeurs];
  const desc = String(draft.Description ?? '').trim();
  if (desc) out.Description = desc;
  for (const c of Object.keys(out)) if (!['Nom_du_chantier', 'Projets'].includes(c) && !ok(c)) delete out[c];
  return out;
}

/**
 * Changement de chantier d'une tâche de premier niveau : Chantier et projet écrits sur la tâche ET sur toutes ses
 * sous-tâches, à toute profondeur, dans un seul lot (§2.3). Une sous-tâche ne change pas de chantier seule : elle
 * suit sa tâche parente.
 * @returns {{error:string}|{changes:{Chantier:number, projet:number}, before:object,
 *   also:{table:'Tasks', id:number, changes:object, before:object}[], count:number}}
 *   error : 'missing', 'subtask', 'chantier', 'projet', 'scope', 'same'
 */
export function movePlan(model, taskId, chantierId, projectId) {
  const error = moveRefusal(model, taskId, chantierId, projectId);
  if (error) return { error };
  const task = model.tasks.get(taskId);
  const changes = { Chantier: chantierId, projet: projectId };
  const also = moveRows(taskLinksFromModel(model), taskId, changes);
  return { changes, before: { Chantier: task.chantierId, projet: task.projectId }, also, count: also.length };
}

/**
 * Raison de refus d'un changement de chantier (contrôles de movePlan, sans parcourir les sous-tâches : verdict de
 * chaque colonne du Kanban par chantier), chaîne vide s'il est permis.
 * @returns {''|'missing'|'subtask'|'chantier'|'projet'|'scope'|'same'}
 */
export function moveRefusal(model, taskId, chantierId, projectId) {
  const task = model.tasks.get(taskId);
  if (!task) return 'missing';
  if (task.parentId) return 'subtask';
  const chantier = model.chantiers.get(chantierId);
  if (!chantier) return 'chantier';
  const projects = chantier.projectIds ?? [];
  if (!projects.includes(projectId) || !model.projects.has(projectId)) return 'projet';
  if (!model.projects.get(projectId).inScope && !projects.some((p) => model.projects.get(p)?.inScope)) return 'scope';
  if (task.chantierId === chantierId && task.projectId === projectId) return 'same';
  return '';
}

/**
 * Cible présélectionnée de la fenêtre « Déplacer » (dépôt d'une carte sur un chantier du Kanban) : gardée si elle
 * figure parmi les options proposées (chantierOptions), sinon vide (l'utilisateur choisit).
 * @param {string} [target] valeur targetValue
 */
export function moveTarget(model, target) {
  const { chantierId, projectId } = parseTarget(target);
  if (!chantierId || !model.projects.get(projectId)?.inScope) return '';
  return model.chantiers.get(chantierId)?.projectIds.includes(projectId) ? targetValue(chantierId, projectId) : '';
}

/**
 * Sous-tâches qui suivent un changement de chantier, à toute profondeur, dans des liens de hiérarchie : ceux du
 * modèle chargé pour l'affichage, ceux de la table relue juste avant l'envoi réel (sous-tâche ajoutée entre-temps).
 */
export function moveRows(links, taskId, changes) {
  const byId = new Map(links.map((l) => [l.id, l]));
  return descendantsIn(links, taskId).map((id) => ({
    table: 'Tasks',
    id,
    changes: { ...changes },
    before: { Chantier: byId.get(id).chantierId, projet: byId.get(id).projectId },
  }));
}

/** Le changement de chantier modifie-t-il aussi le projet (de la tâche ou d'une sous-tâche qui suit) ? */
export function moveChangesProjet(plan) {
  const to = plan.changes.projet;
  return plan.before.projet !== to || plan.also.some((a) => a.before?.projet !== to);
}
