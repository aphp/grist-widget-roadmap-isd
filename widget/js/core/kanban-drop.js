/**
 * Dépôt d'une carte dans une colonne du Kanban (lot C), sans DOM : colonnes acceptées ou refusées avec la raison,
 * et colonnes de la Feuille à écrire. Seuls le statut et la priorité s'écrivent ; le regroupement par chantier
 * relève du lot D. L'écriture elle-même passe par le writer (relecture, conflits, droits y sont traités).
 */
import { priorityText, taskPriority } from './kanban-data.js';
import { label, statusLabel } from '../labels.js';
import { statusChanges } from './task-form.js';

const declaredPriorities = (model) =>
  (model.choices?.['Tasks.priorite'] ?? []).filter((v) => typeof v === 'string' && v !== '');

/**
 * Valeur déclarée de Tasks.priorite dont le libellé de colonne est `columnKey` ; plusieurs valeurs de même libellé :
 * la plus fréquente parmi les tâches (égalité : la première déclarée).
 * @returns {string|null} null si aucune valeur déclarée ne correspond
 */
export function priorityValueFor(model, columnKey) {
  const matches = declaredPriorities(model).filter((v) => priorityText(v) === columnKey);
  if (matches.length < 2) return matches[0] ?? null;
  const n = new Map(matches.map((v) => [v, 0]));
  for (const t of model.tasks.values()) if (n.has(t.priorite)) n.set(t.priorite, n.get(t.priorite) + 1);
  let best = matches[0];
  for (const v of matches) if (n.get(v) > n.get(best)) best = v;
  return best;
}

/** Priorité donnée par le chantier ou le projet, indépendamment de celle de la tâche ; '' si aucune. */
const upstreamPriority = (model, task) => taskPriority(model, { ...task, priorite: '' });

/** Vrai si la priorité affichée de la tâche vient du chantier ou du projet (la tâche n'en porte pas). */
const isInherited = (model, task) => !task.priorite && upstreamPriority(model, task) !== '';

/**
 * Pour chaque colonne : le dépôt est-il permis ?
 * @param {object} model
 * @param {number} taskId
 * @param {'status'|'priority'|'chantier'} groupBy
 * @param {{key:string}[]} columns colonnes de kanbanColumns
 * @returns {Map<string, {ok:true}|{ok:false, reason:string}>} vide si la tâche est inconnue
 */
export function dropTargets(model, taskId, groupBy, columns) {
  const out = new Map();
  const task = model.tasks.get(taskId);
  if (!task) return out;
  const refuse = (reason) => ({ ok: false, reason });
  const current =
    groupBy === 'status' ? task.status : groupBy === 'priority' ? priorityText(taskPriority(model, task)) : null;
  for (const { key } of columns) {
    if (groupBy === 'status') {
      if (key === current) out.set(key, refuse('same'));
      else if (key === '') out.set(key, refuse('empty-status'));
      else out.set(key, model.statuses.tasks.includes(key) ? { ok: true } : refuse('undeclared'));
    } else if (groupBy === 'priority') {
      if (key === current) out.set(key, refuse('same'));
      else if (key === '') out.set(key, upstreamPriority(model, task) ? refuse('inherited') : { ok: true });
      else out.set(key, priorityValueFor(model, key) === null ? refuse('undeclared') : { ok: true });
    } else out.set(key, refuse('kind'));
  }
  return out;
}

/**
 * Colonnes à écrire pour un dépôt. `inherited` : la priorité affichée venait du chantier ou du projet.
 * @param {number} today jour UTC entier (date de clôture posée par le statut « done »)
 * @returns {{changes:object, inherited:boolean}|{error:string}} error : raison de refus de dropTargets, ou 'missing'
 */
export function dropChanges(model, taskId, groupBy, columnKey, today) {
  const task = model.tasks.get(taskId);
  if (!task) return { error: 'missing' };
  const verdict = dropTargets(model, taskId, groupBy, [{ key: columnKey }]).get(columnKey);
  const inherited = isInherited(model, task);
  if (!verdict.ok && verdict.reason !== 'same') return { error: verdict.reason };
  if (groupBy === 'status')
    return {
      changes: statusChanges({ statut: task.status, dateCloture: task.closed ?? null }, columnKey, today),
      inherited: false,
    };
  const value = columnKey === '' ? '' : priorityValueFor(model, columnKey);
  return { changes: verdict.ok ? { priorite: value } : {}, inherited };
}

/**
 * Colonnes qui peuvent recevoir une carte quelle qu'elle soit (calculé une fois par rendu) : statuts déclarés non
 * vides ; priorités déclarées et « Sans priorité ». Le regroupement par chantier n'en a aucune (lot D).
 * @returns {Set<string>}
 */
export function dropColumns(model, groupBy, columns) {
  const out = new Set();
  for (const { key } of columns) {
    if (groupBy === 'status' && key !== '' && model.statuses.tasks.includes(key)) out.add(key);
    else if (groupBy === 'priority' && (key === '' || priorityValueFor(model, key) !== null)) out.add(key);
  }
  return out;
}

/**
 * Vrai si la carte peut être déposée dans au moins une colonne (même verdict que dropTargets, sans le calculer pour
 * chaque colonne) : une colonne de `open` autre que la sienne, « Sans priorité » seulement sans priorité en amont.
 * @param {Set<string>} open voir dropColumns
 */
export function hasDropTarget(model, taskId, groupBy, open) {
  const task = model.tasks.get(taskId);
  if (!task || (groupBy !== 'status' && groupBy !== 'priority')) return false;
  const current = groupBy === 'status' ? task.status : priorityText(taskPriority(model, task));
  let upstream = null;
  for (const key of open) {
    if (key === current) continue;
    if (groupBy === 'priority' && key === '') {
      upstream ??= upstreamPriority(model, task);
      if (upstream) continue;
    }
    return true;
  }
  return false;
}

/**
 * Entrées du menu de priorité d'une tâche : libellés des priorités déclarées (une fois chacun, dans l'ordre
 * déclaré), la priorité affichée si elle n'en est pas, puis « Sans priorité ». Verdict de chaque entrée comme un
 * dépôt dans la colonne de ce libellé (dropTargets) : le choix passe par le même chemin que le glisser.
 * @returns {{value:string, text:string, current:boolean, ok:boolean, reason:string}[]} vide si la tâche est inconnue
 */
export function priorityMenuItems(model, taskId) {
  const task = model.tasks.get(taskId);
  if (!task) return [];
  const current = priorityText(taskPriority(model, task));
  const keys = [...new Set(declaredPriorities(model).map((v) => priorityText(v)))];
  if (current && !keys.includes(current)) keys.push(current);
  keys.push('');
  const verdicts = dropTargets(
    model,
    taskId,
    'priority',
    keys.map((key) => ({ key })),
  );
  return keys.map((key) => {
    const v = verdicts.get(key);
    return {
      value: key,
      text: key || label('kanban.noPriority'),
      current: key === current,
      ok: v.ok,
      reason: v.ok ? '' : v.reason,
    };
  });
}

/**
 * Modèle où la tâche porte déjà le statut ou la priorité déposés (carte affichée à sa nouvelle place pendant
 * l'enregistrement, Q11) ; les autres tâches et le reste du modèle sont partagés, le modèle d'origine intact.
 * @param {{statut?:string, dateCloture?:number, priorite?:string}} changes voir dropChanges
 */
export function pendingModel(model, taskId, changes) {
  const task = model.tasks.get(taskId);
  if (!task) return model;
  const next = { ...task };
  if ('statut' in changes) next.status = changes.statut;
  if ('dateCloture' in changes) next.closed = changes.dateCloture;
  if ('priorite' in changes) next.priorite = changes.priorite;
  return { ...model, tasks: new Map(model.tasks).set(taskId, next) };
}

/** Nom d'une colonne du Kanban dans les messages et annonces : statut nommé, libellé de priorité, « Sans priorité ». */
export const columnName = (group, key) => (group === 'status' ? statusLabel(key) : key || label('kanban.noPriority'));

/**
 * Vrai si le modèle porte déjà le statut ou la priorité déposés (correction locale reçue après l'écriture) : la
 * carte n'a plus besoin de l'état « Enregistrement… » pour rester à sa nouvelle place.
 */
export function isApplied(model, taskId, changes) {
  const task = model.tasks.get(taskId);
  if (!task) return false;
  if ('statut' in changes && task.status !== changes.statut) return false;
  return !('priorite' in changes) || (task.priorite ?? '') === changes.priorite;
}
