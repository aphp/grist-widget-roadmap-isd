/**
 * Règle de périmètre des écritures (Q15 B, Q14 A), fonctions pures : main.js les passe au writer
 * (canWriteRow, canWriteValues), qui les contrôle avant chaque envoi. Tâches et chantiers : un de leurs projets est
 * dans le périmètre ISD (model.js, Projects.inScope) ; personnes : équipe ISD (person-form.js:personInScope).
 */
import { taskInScope } from './task-form.js';
import { chantierInScope } from './chantier-form.js';
import { personInScope, teamValuesInScope } from './person-form.js';

/**
 * Une ligne existante peut-elle être écrite ?
 * @param {object|null} model
 * @param {string} table
 * @param {number} id
 * @param {(id:number) => number|null} [membreOf] membre (Team) d'une ligne Disponibilites, lu dans les données
 */
export function canWriteRowIn(model, table, id, membreOf = () => null) {
  if (!model) return false;
  // Personnes (Q14 A) : équipe ISD affichée par l'onglet, inactives comprises ; indisponibilités de ces personnes
  if (table === 'Team') return personInScope(model, model.people.get(id));
  if (table === 'Disponibilites') return personInScope(model, model.people.get(membreOf(id)));
  if (table === 'Chantiers') return model.chantiers.has(id) && chantierInScope(model, model.chantiers.get(id));
  const task = table === 'Tasks' ? model.tasks.get(id) : null;
  return Boolean(task && taskInScope(model, task));
}

/**
 * Même règle sur les valeurs d'une ligne créée ou rattachée ailleurs (projet, chantier, projets du chantier).
 * @param {object|null} model
 * @param {string} table
 * @param {object} v valeurs du modèle (ids des références)
 * @param {{add?:boolean}} [opts] add : création d'une personne
 */
export function canWriteValuesIn(model, table, v, opts = {}) {
  if (!model) return false;
  // Valeurs d'arrivée d'une personne : elle reste dans l'équipe ISD (création : Domaine ISD, rôle ISD ou Management)
  if (table === 'Team') return teamValuesInScope(model, v, opts);
  if (table === 'Disponibilites') return personInScope(model, model.people.get(v.membre));
  const inScope = (p) => model.projects.get(p)?.inScope === true;
  if (table === 'Chantiers') return (v.Projets ?? []).some(inScope);
  if (table !== 'Tasks') return false;
  return inScope(v.projet) || (model.chantiers.get(v.Chantier)?.projectIds ?? []).some(inScope);
}
