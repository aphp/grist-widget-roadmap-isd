/**
 * Couleurs des données pour l'impression (PDF, toujours en thème clair). Mêmes valeurs que les variables
 * --viz-* de css/tokens.css (thème clair) ; tests/viz-palette.test.js vérifie la cohérence.
 */
export const VIZ_PRINT = Object.freeze({
  1: '#2a78d6',
  2: '#eb6834',
  3: '#1a9e8a',
  4: '#8a5a00',
  mgmt: '#5b21b6',
  neutral: '#6e7890',
  summary: '#5b6475',
  late: '#dc2626',
  today: '#e11d48',
  /** Teintes de chantier --viz-ch-1 à 7 (mode « Chantier » du Gantt) et leurs teintes foncées (-deep). */
  chantier: Object.freeze(['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6']),
  chantierDeep: Object.freeze(['#1c5cab', '#b84a1d', '#127a55', '#9a6800', '#b8476f', '#005c00', '#4535a8']),
});
