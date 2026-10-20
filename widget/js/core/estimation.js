/**
 * Personne « estimation » : une ligne de Team (ex. « Data Engineer ») qui sert à estimer la charge d'une tâche dans
 * la feuille de route avant de la répartir entre des personnes réelles. Elle se désigne dans la Feuille, par son APH
 * (Team.aph = ESTIMATION_APH), jamais depuis le widget (le writer refuse de poser ou de retirer cette valeur).
 * Il peut y en avoir plusieurs (une par profil : « Data Engineer », « Data Scientist »…) : TOUTE ligne ACTIVE de Team
 * qui porte cet APH est une personne estimation, exemptée de la borne de 1 ETP par personne (bornée à
 * ESTIMATION_MAX_ETP). Une ligne inactive ne l'est pas. Fonctions pures.
 */

/** APH de la personne estimation (texte exact, sans espace : même règle que validAph du writer). */
export const ESTIMATION_APH = '9999999';

/**
 * APH du modèle depuis une cellule Team.aph, toujours en texte. La colonne est en Text (texte tel quel, sans
 * nettoyage) ou en Int (entier positif → ses chiffres, sans décimale ; 0, vide ou null → '') : saisir une valeur
 * dans la colonne vide de la Feuille la convertit en colonne de données dont Grist devine le type (souvent Int).
 * Tout autre contenu (nombre non entier ou négatif, liste, booléen, erreur) → '' : jamais affiché ni comparé.
 */
export function aphText(cell) {
  if (typeof cell === 'string') return cell;
  return Number.isSafeInteger(cell) && cell > 0 ? String(cell) : '';
}
/**
 * Borne de bon sens de la personne estimation : 50 ETP sur la période (sans dates : 2 000 h, comme pour tous),
 * pour qu'une faute de frappe (un zéro de trop) ne passe pas.
 */
export const ESTIMATION_MAX_ETP = 50;

/**
 * L'APH (texte du modèle ou cellule brute, Text ou Int) est-il exactement celui de la personne estimation ?
 * Comparaison stricte après aphText : '9999999' et 9999999 comptent ; ' 9999999', '09999999' ou 9999999.5 non.
 */
export const isEstimationAph = (aph) => aphText(aph) === ESTIMATION_APH;

/**
 * Personnes estimation d'une table Team brute (colonnaire) : identifiants des lignes actives (actif vrai) qui portent
 * ESTIMATION_APH. Sans colonne aph ou actif : aucune.
 * @returns {Set<number>}
 */
export function estimationIdsOfTable(team) {
  const aph = team?.aph;
  const actif = team?.actif;
  if (!Array.isArray(aph) || !Array.isArray(actif) || !Array.isArray(team.id)) return new Set();
  return new Set(team.id.filter((_, i) => actif[i] === true && isEstimationAph(aph[i])));
}

/**
 * Personnes estimation du modèle (buildModel) : { ids } = personnes actives qui portent ESTIMATION_APH.
 * @param {Iterable<{id:number, actif?:boolean, aph?:string|number}>} people
 * @returns {{ids:Set<number>}}
 */
export function estimationOf(people) {
  return { ids: new Set([...people].filter((p) => p.actif === true && isEstimationAph(p.aph)).map((p) => p.id)) };
}

/** La personne (identifiant) est-elle une personne estimation du modèle (active, APH 9999999) ? */
export const isEstimationPerson = (model, id) =>
  Number.isInteger(id) && model?.estimation?.ids instanceof Set && model.estimation.ids.has(id);
