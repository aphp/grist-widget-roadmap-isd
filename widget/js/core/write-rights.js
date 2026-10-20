/**
 * Droits relus au moment d'agir (pas seulement au rendu) : boutons et menus des formulaires, envoi des fenêtres,
 * statut rapide, suppression. Fonctions pures sur le writer (core/grist-writer.js : mode, can, canAdd, canRemove) ;
 * aucune écriture ici.
 * Le writer refait de toute façon son contrôle strict avant l'envoi : ces relectures évitent qu'un bouton resté
 * affiché après un passage en lecture modifie la saisie ou lance un envoi voué au refus.
 */
import { moveChangesProjet } from './create-form.js';
import { changedFields } from './write-encode.js';

const OFF = Object.freeze({ ok: false, reason: 'off' });
const usable = (w) => Boolean(w) && w.mode !== 'off';

/**
 * Modification du brouillon d'un formulaire (fiche tâche, chantier, personne) : permise si le writer est actif,
 * la session n'est pas verrouillée et chaque colonne touchée est modifiable.
 * @param {object|null} writer
 * @param {{locked?:*, can(col:string):{ok:boolean, reason:string}}} st état du formulaire
 * @returns {{ok:boolean, reason:string, cols:string[]}}
 */
export function draftChangeRight(writer, st, before, after) {
  const cols = changedFields(before, after);
  if (!usable(writer)) return { ...OFF, cols };
  if (st.locked) return { ok: false, reason: String(st.locked), cols };
  const refused = cols.map((c) => st.can(c)).find((r) => !r.ok);
  return refused ? { ok: false, reason: refused.reason, cols } : { ok: true, reason: 'ok', cols };
}

/**
 * Fenêtres de création et de changement de chantier : ajout possible dans la table ; changement de chantier :
 * colonne Chantier, et projet seulement si le plan change aussi le projet.
 * @param {'task'|'subtask'|'chantier'|'move'} kind
 * @param {object|null} [plan] plan du changement de chantier (movePlan), null à l'ouverture
 */
export function createDialogRight(writer, kind, table, plan = null) {
  if (!usable(writer)) return OFF;
  if (kind !== 'move') return writer.canAdd(table);
  const c = writer.can('Tasks', 'Chantier');
  return c.ok && plan && moveChangesProjet(plan) ? writer.can('Tasks', 'projet') : c;
}

/**
 * Fenêtres des personnes : ajout d'une personne ou d'une indisponibilité, désactivation (Team.actif),
 * modification d'une indisponibilité.
 * @param {'add'|'unav-add'|'unav-edit'|'off'} kind
 */
export function personDialogRight(writer, kind) {
  if (!usable(writer)) return OFF;
  if (kind === 'add') return writer.canAdd('Team');
  if (kind === 'unav-add') return writer.canAdd('Disponibilites');
  return kind === 'off' ? writer.can('Team', 'actif') : writer.can('Disponibilites', 'dateDebut');
}

/** Statut rapide d'une tâche (statut) ou d'un chantier (Statut). */
export function quickStatusRight(writer, table) {
  if (!usable(writer)) return OFF;
  return writer.can(table, table === 'Chantiers' ? 'Statut' : 'statut');
}

/** Suppression depuis la fiche (tâche avec ses sous-tâches, chantier vide) : droit de suppression du writer. */
export function deleteRight(writer, table) {
  if (!usable(writer)) return OFF;
  return writer.canRemove?.(table) ?? { ok: false, reason: 'table' };
}

/**
 * Échec à afficher quand un droit relu juste avant l'envoi manque, d'après sa raison : session en lecture
 * (viewer, flags), règle d'accès (acl), édition coupée, table ou colonne hors du widget, sinon colonne retirée
 * (absente, formule, type changé).
 * @param {string} reason
 * @returns {{kind:'session'|'acl'|'refused', message:string}}
 */
export function rightFailure(reason) {
  if (reason === 'viewer' || reason === 'flags') return { kind: 'session', message: reason };
  if (reason === 'acl') return { kind: 'acl', message: '' };
  if (['off', 'table', 'colonne'].includes(reason)) return { kind: 'refused', message: reason };
  return { kind: 'refused', message: 'colonne-retiree' };
}
