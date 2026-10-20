/** Texte : comparaison sans accents ni casse. Module feuille (aucune dépendance). */

/**
 * Forme normalisée d'un texte : sans accents, en minuscules, espaces réduits.
 * @param {unknown} s
 * @returns {string}
 */
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
