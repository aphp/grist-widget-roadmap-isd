/**
 * Statut depuis la carte et la ligne (P-UX-6), sans DOM : droit d'afficher le contrôle, entrées du menu,
 * déplacement au clavier dans le menu (les flèches ne font qu'y déplacer le focus, jamais écrire), raccourcis
 * d'ouverture et élément à focaliser après le changement. L'écriture elle-même passe par le statut rapide de la
 * fiche (core/task-session.js:runQuickStatus, via ui/task-editor.js) : relecture, date de clôture, délais, mode
 * essai et refus y sont traités une seule fois.
 */
import { editAvailability } from './task-form.js';

/**
 * Vrai si le contrôle de statut d'une tâche s'affiche : édition ouverte (edition=1 ou essai), session encore
 * modifiable, tâche du périmètre ISD et colonne statut permise par le writer. En lecture seule : rien ne change.
 * @param {object} model
 * @param {number} taskId
 * @param {{mode:string, canEdit:boolean, reason:string}} edit
 * @param {{mode:string, can(table:string, col:string):{ok:boolean}}|null} writer
 */
export function canQuickStatus(model, taskId, edit, writer) {
  return quickFields(model, taskId, edit, writer).statut;
}

/**
 * Colonnes d'une tâche modifiables depuis une vue (statut, priorité : menus et glisser du Kanban ; chantier :
 * fenêtre « Déplacer », tâche de premier niveau avec Chantier et projet permis, comme le « Changer » de la fiche),
 * mêmes conditions que canQuickStatus ; l'édition de la tâche n'est évaluée qu'une fois.
 * @returns {{statut:boolean, priorite:boolean, chantier:boolean}}
 */
export function quickFields(model, taskId, edit, writer) {
  const none = { statut: false, priorite: false, chantier: false };
  if (!model || !writer || writer.mode === 'off' || !edit) return none;
  if (!editAvailability(model, { table: 'Tasks', id: taskId }, edit).editable) return none;
  const can = (c) => Boolean(writer.can('Tasks', c)?.ok);
  return {
    statut: can('statut'),
    priorite: can('priorite'),
    chantier: !model.tasks.get(taskId)?.parentId && can('Chantier') && can('projet'),
  };
}

/**
 * Entrées du menu : les statuts de la Feuille dans leur ordre, et le statut actuel s'il n'y figure pas (valeur
 * ancienne), comme le menu de la fiche. Un statut vide n'est jamais proposé.
 * @returns {{value:string, current:boolean}[]}
 */
export function statusMenuItems(statuses, current) {
  const list = (statuses ?? []).filter((s) => s !== '' && s !== null && s !== undefined);
  if (current && !list.includes(current)) list.push(current);
  return list.map((value) => ({ value, current: value === current }));
}

/**
 * Entrée focalisée à l'ouverture : le statut actuel ; aucune (-1) si la tâche n'a pas de statut connu du menu.
 * Le focus va alors sur le menu lui-même, position neutre : Entrée n'y choisit rien.
 */
export function menuStartIndex(items) {
  return items.findIndex((it) => it.current);
}

/**
 * Faut-il ignorer cette touche dans le menu ? Entrée ou Espace répétées (touche maintenue) : jamais d'écriture
 * par auto-répétition, seulement par un appui franc.
 */
export function isRepeatedChoice(e) {
  return Boolean(e.repeat) && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar');
}

/**
 * Effet d'une touche dans un menu de choix (openChoicePopover) : Entrée ou Espace maintenues ignorées, Échap et Tab
 * ferment, flèches, Début et Fin déplacent le focus. Jamais un choix : seule l'activation franche d'une entrée
 * (son clic) choisit.
 * @returns {{action:'ignore'|'close'}|{action:'move', index:number}|null} null : touche laissée au bouton
 */
export function menuKey(e, count, index) {
  if (isRepeatedChoice(e)) return { action: 'ignore' };
  if (e.key === 'Escape' || e.key === 'Tab') return { action: 'close' };
  const next = menuMove(count, index, e.key);
  return next === null ? null : { action: 'move', index: next };
}

/**
 * Focus dans le menu : flèches haut et bas (en boucle), Début, Fin. Aucune autre touche ne déplace le focus.
 * @param {number} count nombre d'entrées
 * @param {number} index entrée focalisée (-1 : aucune)
 * @param {string} key
 * @returns {number|null} nouvelle entrée, null si la touche ne déplace rien
 */
export function menuMove(count, index, key) {
  if (count <= 0) return null;
  if (key === 'ArrowDown') return index < 0 ? 0 : (index + 1) % count;
  if (key === 'ArrowUp') return index < 0 ? count - 1 : (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * Raccourci qui ouvre le menu de statut depuis une carte du Kanban : « s » (sans modificateur), Maj+F10 ou la
 * touche Menu contextuelle. Les flèches restent au focus itinérant du plateau.
 * @param {{key:string, shiftKey?:boolean, altKey?:boolean, ctrlKey?:boolean, metaKey?:boolean}} e
 */
export function isStatusShortcut(e) {
  if (isMenuShortcut(e)) return true;
  return !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 's' || e.key === 'S');
}

/** Raccourci du menu contextuel : Maj+F10 ou la touche Menu, sans Ctrl, Alt ni Méta. */
export function isMenuShortcut(e) {
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  return e.key === 'ContextMenu' || (e.key === 'F10' && Boolean(e.shiftKey));
}

/** Raccourci du menu de priorité d'une carte du Kanban : « p » sans modificateur. */
export function isPriorityShortcut(e) {
  return !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'p' || e.key === 'P');
}

/**
 * Raccourci « déplacer vers… » d'une carte du Kanban : « m » sans modificateur (menu de la colonne du regroupement,
 * fenêtre « Déplacer » par chantier).
 */
export function isMoveShortcut(e) {
  return !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'm' || e.key === 'M');
}

/**
 * Éléments à focaliser après un changement, par ordre de préférence : l'élément de la tâche (la carte suit la
 * tâche dans sa nouvelle colonne), sinon son voisin suivant puis précédent dans la même liste (tâche sortie de la
 * vue, par exemple « Terminé » dans Mes tâches ou un filtre de statut).
 * @param {string[]} keys clés des éléments de la liste, dans l'ordre affiché
 * @param {string} key clé de la tâche changée
 * @returns {string[]}
 */
export function focusOrder(keys, key) {
  const i = keys.indexOf(key);
  if (i < 0) return [key];
  const out = [key];
  for (let d = 1; i + d < keys.length || i - d >= 0; d++) {
    if (i + d < keys.length) out.push(keys[i + d]);
    if (i - d >= 0) out.push(keys[i - d]);
  }
  return out;
}

/**
 * Nombre de lignes ou de cartes à afficher pour que la tâche changée reste visible malgré la pagination
 * (« Afficher plus ») : la page qui la contient, jamais moins que la limite actuelle.
 * @param {number} limit limite affichée
 * @param {number} index rang de la tâche dans la liste complète (-1 : absente)
 * @param {number} page taille d'une page
 */
export function limitToReveal(limit, index, page) {
  if (index < limit || index < 0) return limit;
  return Math.ceil((index + 1) / page) * page;
}
