/**
 * Encodage et décodage des valeurs de cellules Grist, dans les deux sens. Fonctions pures, sans écriture.
 * - Date : secondes à minuit UTC (jour × 86 400) ; vide = null. Jamais d'heure locale ni de millisecondes.
 * - Ref : identifiant entier ; vide = 0. RefList et ChoiceList : ['L', …] ; liste vide = null.
 * - Numeric : nombre fini ; la virgule française est acceptée en saisie ; vide = null.
 */
import { dayOf, dayOfIso, isoOfDay } from './dates.js';

export const SECONDS_PER_DAY = 86400;
/** Années acceptées en saisie (attributs min et max des champs date). */
export const MIN_YEAR = 1971;
export const MAX_YEAR = 2199;

/** Valeur impossible à encoder : l'écriture est refusée avant tout envoi. */
export class EncodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EncodeError';
  }
}

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Vrai si la chaîne est une date calendaire valide au format AAAA-MM-JJ. */
export function isIsoDate(s) {
  const m = ISO_DATE.exec(String(s ?? ''));
  if (!m) return false;
  const d = new Date(`${m[0]}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === m[0];
}

/** Jour du modèle depuis la valeur d'un <input type="date"> ; '' → null ; date invalide → EncodeError. */
export function dayFromInput(s) {
  const v = String(s ?? '').trim();
  if (!v) return null;
  if (!isIsoDate(v)) throw new EncodeError(`date invalide : ${v}`);
  const year = Number(v.slice(0, 4));
  // Bornes : une date ≤ 1970-01-01 ne fait pas l'aller-retour avec dayOf (0 ou négatif = date vide)
  if (year < MIN_YEAR || year > MAX_YEAR) throw new EncodeError(`date hors bornes : ${v}`);
  return dayOfIso(v);
}

/** Valeur d'un <input type="date"> depuis un jour du modèle (null → ''). */
export function inputFromDay(day) {
  return Number.isInteger(day) ? isoOfDay(day) : '';
}

/** Jour calendaire de Paris (« aujourd'hui » des écritures), au format des jours du modèle. */
export function parisToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return dayOfIso(parts);
}

/** Nombre saisi en français (« 1,5 », « 2 ») ; '' → null ; texte non numérique → EncodeError. */
export function parseNumberFr(s) {
  if (typeof s === 'number') {
    if (!Number.isFinite(s)) throw new EncodeError('nombre invalide');
    return s;
  }
  const v = String(s ?? '')
    .trim()
    .replace(/\s/g, '')
    .replace(',', '.');
  if (!v) return null;
  if (!/^-?\d+(\.\d+)?$/.test(v)) throw new EncodeError(`nombre invalide : ${s}`);
  return Number(v);
}

/** Famille d'un type de colonne Grist (« Ref:Team » → « Ref »). */
export const typeFamily = (type) => String(type ?? '').split(':')[0];

/**
 * Valeur du modèle → valeur de cellule Grist, selon le type de la colonne.
 * @param {string} type type Grist (Text, Choice, Date, Numeric, Int, Bool, Ref:X, RefList:X, ChoiceList)
 * @param {*} value jour (Date), identifiant(s) (Ref, RefList), chaîne(s), nombre, booléen
 * @returns {*} valeur de cellule prête pour le writer
 */
export function encodeValue(type, value) {
  switch (typeFamily(type)) {
    case 'Text':
    case 'Choice':
      if (value === null || value === undefined) return '';
      if (typeof value !== 'string') throw new EncodeError(`texte attendu (${type})`);
      return value;
    case 'Date':
      if (value === null || value === undefined) return null;
      if (!Number.isInteger(value) || value <= 0) throw new EncodeError('jour entier positif attendu');
      return value * SECONDS_PER_DAY;
    case 'Numeric':
      if (value === null || value === undefined || value === '') return null;
      return parseNumberFr(value);
    case 'Int': {
      if (value === null || value === undefined || value === '') return null;
      const n = parseNumberFr(value);
      if (!Number.isInteger(n)) throw new EncodeError('entier attendu');
      return n;
    }
    case 'Bool':
      if (typeof value !== 'boolean') throw new EncodeError('booléen attendu');
      return value;
    case 'Ref':
      if (value === null || value === undefined || value === 0) return 0;
      if (!isPositiveInt(value)) throw new EncodeError('identifiant entier attendu');
      return value;
    case 'RefList':
      if (!Array.isArray(value)) throw new EncodeError('liste d’identifiants attendue');
      if (!value.every(isPositiveInt)) throw new EncodeError('identifiant entier attendu');
      return value.length ? ['L', ...value] : null;
    case 'ChoiceList':
      // Une chaîne vide déjà présente dans la cellule est recopiée telle quelle ; un nouveau choix vide est refusé
      // en amont (tags-edit.js:tagsWriteProblem)
      if (!Array.isArray(value)) throw new EncodeError('liste de choix attendue');
      if (!value.every((x) => typeof x === 'string')) throw new EncodeError('choix en texte attendu');
      return value.length ? ['L', ...value] : null;
    default:
      throw new EncodeError(`type de colonne non pris en charge : ${type}`);
  }
}

/**
 * Valeur de cellule Grist → valeur du modèle (inverse d'encodeValue) ; jamais d'exception.
 * Le texte n'est pas retouché (pas de trim) : la comparaison avec la saisie reste exacte.
 */
export function decodeValue(type, cell) {
  switch (typeFamily(type)) {
    case 'Text':
    case 'Choice':
      return typeof cell === 'string' ? cell : cell === null || cell === undefined ? '' : String(cell);
    case 'Date':
      return dayOf(cell);
    case 'Numeric':
    case 'Int':
      return typeof cell === 'number' && Number.isFinite(cell) ? cell : null;
    case 'Bool':
      return cell === true;
    case 'Ref':
      return isPositiveInt(cell) ? cell : null;
    case 'RefList':
      return Array.isArray(cell) && cell[0] === 'L' ? cell.slice(1).filter(isPositiveInt) : [];
    case 'ChoiceList':
      return Array.isArray(cell) && cell[0] === 'L' ? cell.slice(1).filter((x) => typeof x === 'string') : [];
    default:
      return cell ?? null;
  }
}

/** Égalité de deux valeurs du modèle (les listes sont comparées élément par élément, dans l'ordre). */
export function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => x === b[i]);
  }
  return a === b;
}

/** Champs dont la valeur diffère entre deux brouillons (sameValue), dans l'ordre des clés de `after`. */
export function changedFields(before, after) {
  return Object.keys(after).filter((k) => !sameValue(before?.[k], after[k]));
}
