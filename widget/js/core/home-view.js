/**
 * Vue d'accueil : onglet ouvert au démarrage, choisi dans les Préférences (jamais posé automatiquement). Fonctions pures ; préférence locale (navigateur) seulement.
 */

/** Valeur de « Vue d'accueil » par défaut (ancienne « dernière vue ») : ouvre le Gantt. */
export const HOME_LAST = 'last';
/**
 * Périmètres des filtres : tout, ou mes chantiers (responsable ou contributeur du chantier, ou impliqué sur une de
 * ses tâches ; responsable, sponsor ou contributeur clé du projet ; avec toutes leurs tâches). Les tâches
 * personnelles sont dans l'onglet « Mes tâches ».
 */
export const SCOPES = Object.freeze(['all', 'chantiers']);

/**
 * Profil d'une personne pour l'accueil : DE, DS, DA, PO, Management, ou null.
 * @param {{role?:string|null, roleText?:string}|null|undefined} person
 */
export function profileOf(person) {
  if (!person) return null;
  if (person.role) return person.role;
  return person.roleText === 'Management' ? 'Management' : null;
}

/** Périmètre posé au premier choix : tout pour le Management, Mes chantiers sinon. */
export function defaultScope(person) {
  return profileOf(person) === 'Management' ? 'all' : 'chantiers';
}

/**
 * Vue d'accueil enregistrée, ramenée à une valeur connue : un onglet, HOME_LAST (ouvre le Gantt), ou null.
 * @param {unknown} saved
 * @param {readonly string[]} tabs
 */
export function sanitizeHomeView(saved, tabs) {
  return saved === HOME_LAST || tabs.includes(saved) ? saved : null;
}

/** Onglet d'arrivée du widget : le Gantt. */
export const LANDING_VIEW = 'gantt';

/**
 * Onglet ouvert au démarrage : le paramètre d'adresse vue=<onglet> s'il nomme un onglet, sinon la vue d'accueil
 * choisie dans les Préférences si c'est un onglet, sinon le Gantt. La dernière vue consultée n'est jamais
 * restaurée (« Dernière vue » ouvre donc aussi le Gantt).
 * @param {{homeView:string|null}} prefs
 * @param {string|URLSearchParams|null|undefined} search chaîne de requête de la page du widget
 * @param {readonly string[]} tabs
 */
export function initialView(prefs, search, tabs) {
  let asked = '';
  try {
    asked = (new URLSearchParams(search ?? '').get('vue') ?? '').trim();
  } catch {
    asked = '';
  }
  if (tabs.includes(asked)) return asked;
  return tabs.includes(prefs.homeView) ? prefs.homeView : LANDING_VIEW;
}

/**
 * Premier choix d'une personne : aucune vue d'accueil n'est posée (le widget arrive sur le Gantt) ; le PO ouvre
 * le Gantt au niveau des tâches. Ensuite, rien n'est imposé.
 * @param {{me?:number|null, mePrompted?:boolean}} prefs
 * @param {object|null|undefined} person
 * @returns {object} préférences à fusionner (vide hors premier choix)
 */
export function firstChoicePrefs(prefs, person) {
  const first = (prefs.me ?? null) === null && !prefs.mePrompted;
  return first && profileOf(person) === 'PO' ? { ganttLevel: 'tache' } : {};
}
