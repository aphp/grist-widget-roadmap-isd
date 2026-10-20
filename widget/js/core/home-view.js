/**
 * Vue d'accueil par profil (P-UX-2) : onglet ouvert au démarrage, choisi au premier « Je suis… » selon le profil,
 * modifiable dans les Préférences. Fonctions pures ; préférence locale (navigateur) seulement.
 */

/** Valeur de « Vue d'accueil » qui rouvre la dernière vue consultée (comportement d'avant). */
export const HOME_LAST = 'last';
/** Périmètres des filtres : tout, mes tâches (assigné, responsable ou chargé), mes chantiers (responsable ou contributeur). */
export const SCOPES = Object.freeze(['all', 'tasks', 'chantiers']);

/**
 * Profil d'une personne pour l'accueil : DE, DS, DA, PO, Management, ou null.
 * @param {{role?:string|null, roleText?:string}|null|undefined} person
 */
export function profileOf(person) {
  if (!person) return null;
  if (person.role) return person.role;
  return person.roleText === 'Management' ? 'Management' : null;
}

/** Accueil proposé : « Mes tâches » pour DE, DS, DA (et par défaut), Gantt pour PO, Synthèse pour le Management. */
export function defaultHomeView(person) {
  const p = profileOf(person);
  if (p === 'PO') return 'gantt';
  if (p === 'Management') return 'synthesis';
  return 'mytasks';
}

/** Périmètre posé au premier choix : Mes chantiers pour PO, tout pour le Management, Mes tâches sinon. */
export function defaultScope(person) {
  const p = profileOf(person);
  if (p === 'PO') return 'chantiers';
  if (p === 'Management') return 'all';
  return 'tasks';
}

/**
 * Vue d'accueil enregistrée, ramenée à une valeur connue : un onglet, HOME_LAST, ou null (pas encore choisie).
 * Préférences d'avant la vue d'accueil avec une personne déjà choisie : HOME_LAST, pour ne rien changer à
 * l'ouverture de quelqu'un qui a déjà ses habitudes (il peut choisir une vue d'accueil dans les Préférences).
 * @param {unknown} saved
 * @param {number|null} me
 * @param {readonly string[]} tabs
 */
export function sanitizeHomeView(saved, me, tabs) {
  if (saved === HOME_LAST || tabs.includes(saved)) return saved;
  return me === null || me === undefined ? null : HOME_LAST;
}

/**
 * Onglet ouvert au démarrage : la vue d'accueil si c'est un onglet, sinon la dernière vue, sinon le Kanban.
 * @param {{homeView:string|null, view:string}} prefs
 * @param {readonly string[]} tabs
 */
export function openingView(prefs, tabs) {
  if (tabs.includes(prefs.homeView)) return prefs.homeView;
  return tabs.includes(prefs.view) ? prefs.view : 'kanban';
}

/**
 * Premier choix d'une personne (aucune vue d'accueil encore enregistrée) : vue d'accueil et préférences de vue
 * du profil (le PO arrive sur le Gantt ouvert au niveau des tâches). Ensuite, rien n'est imposé.
 * @param {object} prefs
 * @param {object|null|undefined} person
 * @returns {object} préférences à fusionner (vide si la vue d'accueil existe déjà)
 */
export function firstChoicePrefs(prefs, person) {
  if (prefs.homeView !== null && prefs.homeView !== undefined) return {};
  const homeView = defaultHomeView(person);
  return { homeView, view: homeView, ...(homeView === 'gantt' ? { ganttLevel: 'tache' } : {}) };
}
