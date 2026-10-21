/**
 * Dépôt d'une carte dans une colonne du Kanban (lot C), sans DOM : colonnes acceptées ou refusées avec la raison,
 * et colonnes de la Feuille à écrire. Seuls le statut et la priorité s'écrivent ; le regroupement par chantier
 * relève du lot D. L'écriture elle-même passe par le writer (relecture, conflits, droits y sont traités).
 */
import { priorityText, taskPriority } from './kanban-data.js';
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
