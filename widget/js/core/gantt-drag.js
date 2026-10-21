/**
 * Gantt : déplacer une barre dans le temps. Fonctions pures, en jours entiers UTC : pas selon l'échelle,
 * décalage d'un jour, d'une semaine ou d'un mois, conversion d'un déplacement en pixels, bornes et droit de glisser.
 */
import { DAY_MS } from './dates.js';
import { isMilestone, nodeBar } from './gantt-data.js';
import { editAvailability } from './task-form.js';

/** @typedef {'day'|'week'|'month'} Unit */

/**
 * Pas d'un déplacement : au jour (Semaine, ou Maj), à la semaine (Mois, Année), au mois (2 ans).
 * @param {'week'|'month'|'year'|'2y'} scale
 * @param {boolean} shift touche Maj tenue
 * @returns {Unit}
 */
export function snapUnit(scale, shift) {
  if (shift || scale === 'week') return 'day';
  return scale === '2y' ? 'month' : 'week';
}

/**
 * Jour décalé de n pas. Pour un mois, le jour du mois est gardé, ramené au dernier jour s'il n'existe pas.
 * @param {number} day
 * @param {Unit} unit
 * @param {number} n
 */
export function shiftDay(day, unit, n) {
  if (unit === 'day') return day + n;
  if (unit === 'week') return day + 7 * n;
  const date = new Date(day * DAY_MS);
  const target = date.getUTCFullYear() * 12 + date.getUTCMonth() + n;
  const year = Math.floor(target / 12);
  const month = target - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(date.getUTCDate(), last)) / DAY_MS;
}

/**
 * Période décalée de n pas, durée gardée.
 * @returns {{start:number, end:number}}
 */
export function movedDates(start, end, unit, n) {
  const s = shiftDay(start, unit, n);
  return { start: s, end: s + (end - start) };
}

/**
 * Nombre entier de pas le plus proche d'un déplacement en pixels.
 * @param {number} dx déplacement horizontal
 * @param {number} pxPerDay largeur d'un jour
 * @param {Unit} unit
 * @param {number} originDay jour de départ (pour les pas en mois)
 */
export function stepsFromPixels(dx, pxPerDay, unit, originDay) {
  const days = dx / pxPerDay;
  if (unit === 'day') return Math.round(days);
  if (unit === 'week') return Math.round(days / 7);
  const aim = originDay + days;
  let n = Math.round(days / 30.4375);
  const dist = (k) => Math.abs(shiftDay(originDay, 'month', k) - aim);
  for (;;) {
    if (dist(n + 1) < dist(n)) n += 1;
    else if (dist(n - 1) < dist(n)) n -= 1;
    else return n;
  }
}

/**
 * Plus grand décalage, du même signe et d'au plus |n| pas, qui garde la période dans [min, max].
 * @param {number} start
 * @param {number} end
 * @param {number} n
 * @param {Unit} unit
 * @param {{min?:number, max:number}} bounds max : voir maxPlanDay
 */
export function clampShift(start, end, n, unit, { min = 1, max }) {
  const sign = Math.sign(n);
  for (let k = Math.abs(n); k > 0; k -= 1) {
    const r = movedDates(start, end, unit, sign * k);
    if (r.start >= min && r.end <= max) return sign * k;
  }
  return 0;
}

/**
 * Une barre est-elle glissable ? Tâche, sous-tâche ou chantier avec ses deux dates propres, édition ouverte,
 * dans le périmètre, colonnes de dates permises par le writer.
 * @param {object} model
 * @param {object} node nœud de l'arbre (ou copie triée : seuls ses champs comptent)
 * @param {{edit:object, writer:{can(table:string, col:string):{ok:boolean}}|null, narrow:boolean}} ctx
 *   narrow : liste chronologique (petit écran), sans barres
 * @returns {{ok:true, table:'Tasks'|'Chantiers', id:number, cols:[string,string], milestone:boolean}
 *   |{ok:false, reason:'list'|'kind'|'deduced'|'nodates'|'virtual'|'edit'|'scope'|'column'}}
 */
export function dragTarget(model, node, { edit, writer, narrow }) {
  if (narrow) return { ok: false, reason: 'list' };
  const isTask = node.kind === 'tache' || node.kind === 'sous-tache';
  if (!isTask && node.kind !== 'chantier') return { ok: false, reason: 'kind' };
  if (!node.ref) return { ok: false, reason: 'virtual' };
  const hasStart = node.start !== null && node.start !== undefined;
  const hasEnd = node.end !== null && node.end !== undefined;
  if (!hasStart || !hasEnd) return { ok: false, reason: !hasStart && !hasEnd && nodeBar(node) ? 'deduced' : 'nodates' };
  const availability = editAvailability(model, node.ref, edit);
  if (!availability.editable) return { ok: false, reason: availability.reason === 'scope' ? 'scope' : 'edit' };
  const table = isTask ? 'Tasks' : 'Chantiers';
  const cols = isTask ? ['dateDebut', 'dateEcheance'] : ['Debut', 'Fin'];
  if (!writer || !cols.every((c) => writer.can(table, c)?.ok)) return { ok: false, reason: 'column' };
  return { ok: true, table, id: node.ref.id, cols, milestone: isMilestone(model, node) };
}
