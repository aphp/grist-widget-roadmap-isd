/**
 * Contrôle de fraîcheur avant « Enregistrer » : la ligne est relue, et toute cellule qu'on va écrire qui a été
 * modifiée par quelqu'un d'autre depuis l'ouverture du formulaire est signalée. Fonctions pures.
 */
import { mergeCharges, periodFte, sameCharges } from './charges-edit.js';
import { sameValue } from './write-encode.js';

const same = (c, a, b) => (c === 'charges' ? sameCharges(a, b) : sameValue(a, b));
const DATE_COLS = ['dateDebut', 'dateEcheance'];

/**
 * Règle d'envoi des charges recalculées (l'ETP fait foi) : un lot qui porte des charges ET une date de la période
 * est en conflit sur ses dates si la période qu'il donnerait sur la ligne relue n'a pas la même capacité (heures de
 * 1 ETP, periodFte) que celle de la saisie (date de la période changée ailleurs : heures calculées pour une autre
 * capacité). Partagée par la fiche et le glisser.
 * @param {{dateDebut?:number|null, dateEcheance?:number|null}} seen dates sur lesquelles la saisie a été faite
 * @param {{dateDebut?:number|null, dateEcheance?:number|null}} fresh ligne relue
 * @param {object} changes colonnes à écrire
 * @returns {string[]} colonnes de dates du lot à soumettre à la fenêtre de conflit (vide : rien à signaler)
 */
export function periodConflictCols(seen, fresh, changes) {
  const cols = DATE_COLS.filter((c) => c in changes);
  if (!('charges' in changes) || !cols.length) return [];
  const at = (row, c) => (c in changes ? changes[c] : row[c]);
  const fte = (row) => periodFte(at(row, 'dateDebut'), at(row, 'dateEcheance'));
  return fte(seen) === fte(fresh) ? [] : cols;
}

/**
 * Colonnes en conflit : modifiées dans la Feuille depuis l'ouverture (relue ≠ valeur d'ouverture) et pour
 * lesquelles la saisie diffère de la nouvelle valeur. Une cellule modifiée ailleurs mais non saisie ici n'est
 * pas un conflit (elle n'est pas envoyée).
 * @param {object} base valeurs à l'ouverture du formulaire
 * @param {object|null} fresh valeurs relues (null : ligne disparue)
 * @param {object} changes colonnes à écrire
 * @returns {string[]|null} null si la ligne a disparu
 */
export function detectConflicts(base, fresh, changes) {
  if (!fresh) return null;
  return Object.keys(changes).filter((c) => !same(c, base[c], fresh[c]) && !same(c, fresh[c], changes[c]));
}

/**
 * Charges modifiées ici ET dans la Feuille depuis l'ouverture : fusion personne par personne sur le JSON brut
 * (charges-edit.js:mergeCharges), pour que les modifications des autres sur d'autres entrées survivent.
 * @returns {{changes:object, conflict:boolean, mine:string|null}} changes : lot à envoyer (charges fusionnées,
 *   ou retirées si la fusion redonne la cellule relue) ; conflict : même personne modifiée des deux côtés, ou
 *   cellule illisible ; mine : cellule fusionnée où la saisie l'emporte (pour « Garder la mienne »)
 */
export function mergeChargesChange(base, fresh, changes) {
  if (!('charges' in changes) || sameCharges(base.charges, fresh.charges))
    return { changes, conflict: false, mine: null };
  const m = mergeCharges(base.charges, changes.charges, fresh.charges);
  if (!m.ok) return { changes, conflict: true, mine: changes.charges };
  if (m.conflicts.length) return { changes, conflict: true, mine: m.raw };
  const out = { ...changes, charges: m.raw };
  if (sameCharges(m.raw, fresh.charges)) delete out.charges;
  return { changes: out, conflict: false, mine: null };
}

/**
 * Applique les choix de l'utilisateur sur les conflits : « mine » garde la saisie, « theirs » prend la valeur de
 * la Feuille (la colonne n'est plus envoyée). Les valeurs d'avant (pour « Annuler ») deviennent celles relues.
 * @param {object} changes
 * @param {object} fresh
 * @param {Record<string,'mine'|'theirs'>} choices
 * @param {object} [mine] valeur « mienne » à écrire à la place de la saisie (charges fusionnées)
 * @returns {{changes:object, before:object}}
 */
export function resolveConflicts(changes, fresh, choices, mine = {}) {
  const out = {};
  for (const [c, v] of Object.entries(changes)) if (choices[c] !== 'theirs') out[c] = c in mine ? mine[c] : v;
  const before = Object.fromEntries(Object.keys(out).map((c) => [c, fresh[c]]));
  return { changes: out, before };
}
