/**
 * Personne « estimation » : une ligne de Team (ex. « Data Engineer ») qui sert à estimer la charge d'une tâche dans
 * la feuille de route avant de la répartir entre des personnes réelles. Elle se désigne dans la Feuille, par son APH
 * (Team.aph = ESTIMATION_APH), jamais depuis le widget (le writer refuse de poser ou de retirer cette valeur).
 * Elle seule échappe à la borne de 1 ETP par personne, et seulement si EXACTEMENT UNE ligne de Team porte cet APH :
 * sans personne, ou avec plusieurs, personne n'est exempté. Fonctions pures.
 */

/** APH de la personne estimation (texte exact, sans espace : même règle que validAph du writer). */
export const ESTIMATION_APH = '9999999';
/**
 * Borne de bon sens de la personne estimation : 50 ETP sur la période (sans dates : 2 000 h, comme pour tous),
 * pour qu'une faute de frappe (un zéro de trop) ne passe pas.
 */
export const ESTIMATION_MAX_ETP = 50;

/** L'APH est-il exactement celui de la personne estimation ? (comparaison stricte, aucun nettoyage) */
export const isEstimationAph = (aph) => aph === ESTIMATION_APH;

/** Identifiants des lignes d'une table Team brute (colonnaire) qui portent ESTIMATION_APH. */
export function estimationHoldersOfTable(team) {
  const aph = team?.aph;
  if (!Array.isArray(aph) || !Array.isArray(team.id)) return [];
  return team.id.filter((_, i) => isEstimationAph(aph[i]));
}

/** Personne estimation d'une table Team brute : son identifiant si elle est seule à porter l'APH, sinon null. */
export function estimationIdOfTable(team) {
  const holders = estimationHoldersOfTable(team);
  return holders.length === 1 ? holders[0] : null;
}

/**
 * Personne estimation du modèle (buildModel) : { holders, id } ; id null sans titulaire ou avec plusieurs.
 * @param {Iterable<{id:number, aph?:string}>} people
 */
export function estimationOf(people) {
  const holders = [...people].filter((p) => isEstimationAph(p.aph)).map((p) => p.id);
  return { holders, id: holders.length === 1 ? holders[0] : null };
}

/** La personne (identifiant) est-elle LA personne estimation du modèle (titulaire unique) ? */
export const isEstimationPerson = (model, id) =>
  Number.isInteger(id) && model?.estimation?.id !== null && model?.estimation?.id === id;
