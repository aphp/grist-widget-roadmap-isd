/**
 * Bloc « Personnes » de la fiche tâche : assignés (Tasks.assignees) et charges (Tasks.charges) réunis, une ligne
 * par personne. Fonctions pures sur le brouillon ; les charges passent toujours par core/charges-edit.js (texte
 * d'origine des entrées non touchées recopié octet par octet). Rien n'est écrit ici.
 *
 * Règles (décision utilisateur) :
 * - lignes : assignés dans leur ordre, puis les personnes qui ont une charge sans être assignées, dans l'ordre de
 *   la cellule ; une personne n'apparaît qu'une fois ;
 * - ajouter une personne l'assigne, sans créer de charge (sa charge est vide jusqu'à une saisie) ;
 * - retirer une ligne retire l'assignation ET les entrées valides de la personne (les entrées invalides sont
 *   conservées telles quelles, comme partout) ;
 * - une charge sans assignation n'est jamais assignée d'office : « Assigner » le fait sur demande ;
 * - vider la charge d'une personne assignée retire son entrée ; pour une personne non assignée, c'est une erreur
 *   (« vide ») : il faut la retirer.
 */
import {
  ChargesError,
  chargeRows,
  hoursFromInput,
  inputEtp,
  readChargesCell,
  removePerson,
  setPersonHours,
} from './charges-edit.js';
import { parseNumberFr } from './write-encode.js';

/**
 * Lignes du bloc.
 * @param {{people:Map<number,object>}} model
 * @param {number[]} assignees
 * @param {string|null} chargesRaw cellule brute
 * @returns {{readable:boolean, cell:object, invalid:{index:number, text:string, teamId:number|null}[],
 *   lines:{teamId:number, assigned:boolean, charged:boolean, heures:number|null, count:number, known:boolean}[]}}
 *   readable : faux si la cellule des charges est illisible (les lignes ne viennent alors que des assignés)
 */
export function peopleLines(model, assignees, chargesRaw) {
  const cell = readChargesCell(chargesRaw);
  const { rows, invalid } = cell.ok ? chargeRows(cell.entries) : { rows: [], invalid: [] };
  const byId = new Map(rows.map((r) => [r.teamId, r]));
  const assigned = new Set(assignees);
  const ids = [...new Set([...assignees, ...rows.map((r) => r.teamId)])];
  const lines = ids.map((teamId) => {
    const r = byId.get(teamId);
    return {
      teamId,
      assigned: assigned.has(teamId),
      charged: Boolean(r),
      heures: r ? r.heures : null,
      count: r ? r.count : 0,
      known: model.people.has(teamId),
    };
  });
  return { readable: cell.ok, cell, invalid, lines };
}

/** Identifiants déjà présents dans le bloc (exclus de « Ajouter une personne… »). */
export const presentIds = (model, assignees, chargesRaw) =>
  peopleLines(model, assignees, chargesRaw).lines.map((l) => l.teamId);

/** Assigne la personne (ajout en fin de liste) ; sans effet si elle l'est déjà. Les charges ne changent pas. */
export function assignPerson(draft, teamId) {
  if (draft.assignees.includes(teamId)) return draft;
  return { ...draft, assignees: [...draft.assignees, teamId] };
}

/** « Ajouter une personne… » : elle est assignée, avec une charge vide (aucune entrée créée). */
export const addPersonLine = assignPerson;

/**
 * Retire la ligne : l'assignation (toutes ses occurrences) et les entrées valides de ses charges. Une cellule de
 * charges illisible n'est pas touchée (seule l'assignation part).
 */
export function removePersonLine(draft, teamId) {
  const assignees = draft.assignees.filter((x) => x !== teamId);
  const readable = readChargesCell(draft.charges).ok;
  const charges = readable ? removePerson(draft.charges, teamId) : draft.charges;
  return { ...draft, assignees, charges };
}

/**
 * Saisie de la charge d'une ligne (mêmes règles que la section des charges : 1 ETP au plus sauf pour la personne
 * estimation, ETP à deux décimales sous 1 et une au-delà, h/semaine à une décimale, valeur affichée ressaisie sans
 * effet, moins de 0,25 h
 * refusé…).
 * @param {object} draft brouillon (assignees, charges)
 * @param {number} teamId
 * @param {string} text valeur saisie
 * @param {'etp'|'hsem'} unit
 * @param {number|null} fte heures de 1 ETP sur la période (periodFte)
 * @param {{estimation?:boolean, shown?:number|null}} [opts] estimation : la personne est la personne estimation (pas
 *   de borne de 1 ETP) ; shown : valeur affichée dans la case (ressaisie sans effet)
 * @returns {{charges:string, heures:number|null, etp:number|null}|{error:{error:string, max?:number}}} heures
 *   null : charge vidée ; etp : ETP saisi, exact (en h/semaine : h/semaine ÷ 35) quand les heures changent, sinon
 *   null ; il fait foi si les dates changent ensuite
 */
export function lineInput(draft, teamId, text, unit, fte, { estimation = false, shown = null } = {}) {
  const cell = readChargesCell(draft.charges);
  if (!cell.ok) return { error: { error: 'nombre' } };
  const current = chargeRows(cell.entries).rows.find((r) => r.teamId === teamId) ?? null;
  if (String(text ?? '').trim() === '') {
    if (!draft.assignees.includes(teamId)) return { error: { error: 'vide' } };
    return { charges: current ? removePerson(draft.charges, teamId) : draft.charges, heures: null, etp: null };
  }
  const r = hoursFromInput(text, unit, fte, current?.heures ?? null, { estimation, shown });
  if (r.error) return { error: r };
  // Valeur déjà affichée ressaisie : rien ne change (pas de dérive des heures stockées, ni de l'ETP de référence,
  // déduit alors des heures)
  if (current && r.heures === current.heures) return { charges: draft.charges, heures: r.heures, etp: null };
  try {
    const etp = inputEtp(parseNumberFr(text), unit);
    return { charges: setPersonHours(draft.charges, teamId, r.heures), heures: r.heures, etp };
  } catch (err) {
    if (!(err instanceof ChargesError)) throw err;
    return { error: { error: 'nombre' } };
  }
}
