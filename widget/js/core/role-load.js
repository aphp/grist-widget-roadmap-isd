/**
 * Charge par profil (Statistiques) : charge, capacité et taux par profil et par mois, synthèse, tâches d'un
 * segment du graphique et déplacement au clavier entre segments. Fonctions pures (spec §4.5).
 * 1 ETP = capacité standard du mois (fteHours) ; la capacité d'un profil est celle du plan de charge
 * (personMonthCapacity : quotité, congés, ralentissements et indisponibilités de chaque personne active du profil).
 */
import { monthKey, monthRange, monthsFrom } from './dates.js';
import { fteHours, hoursToEtp, personMonthCapacity, spreadHours } from './capacity.js';
import { ETP_ROLES, ETP_SPLIT, PROFILE_KEYS, profileKey } from './kanban-data.js';
import { TENSION_FROM, rateLevel } from './team-data.js';
import { shiftMonth } from './stats-data.js';

/** Seuil de tension du taux de charge (spec §4.5) : 85 % ; au-delà de 100 %, dépassement. */
export const RATE_TENSION = TENSION_FROM / 100;

/** Fenêtre de la charge par profil : 3 mois passés, le mois courant et 8 mois à venir (12 mois). */
export const ROLE_WINDOW = Object.freeze({ before: 3, after: 8 });

const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** Tri de paires [identifiant, heures] : heures décroissantes, puis identifiant croissant (plan de charge aussi). */
export const byHoursDesc = (a, b) => b[1] - a[1] || a[0] - b[0];

/**
 * Taux de charge et niveau, même règle que le plan de charge (rateLevel, sur le pourcentage arrondi affiché) :
 * < 85 % ok, 85 à 100 % tension, > 100 % dépassement (« over ») ; capacité nulle : dépassement s'il y a de la
 * charge, sinon « none ».
 * @returns {{rate:number|null, level:'ok'|'tension'|'over'|'none'}}
 */
export function loadRate(load, capacity) {
  if (!(capacity > 0)) return { rate: null, level: load > 0 ? 'over' : 'none' };
  return { rate: Math.round((load / capacity) * 1e4) / 1e4, level: rateLevel(load / capacity, load) };
}

const known = (model, taskIds) => [...new Set(taskIds)].filter((id) => model.tasks.has(id)).sort((a, b) => a - b);

/**
 * Parcourt les heures des charges des tâches, mois par mois (spreadHours : au prorata de la capacité standard des
 * jours de la tâche) : fn(taskId, personId, clé de profil (profileKey, sinon « Autre »), mois, heures > 0), mois de `wanted` seulement.
 * Tâches inconnues, doublons et tâches sans dates valides ignorés.
 */
function eachCharge(model, taskIds, wanted, fn) {
  for (const id of known(model, taskIds)) {
    const t = model.tasks.get(id);
    for (const c of t.charges) {
      const spread = spreadHours(c.heures, t.start, t.end);
      if (!spread) continue;
      let key = null;
      for (const [m, h] of spread) {
        if (!wanted.has(m) || !(h > 0)) continue;
        key ??= profileKey(model.people.get(c.personId), model) ?? 'Autre';
        fn(id, c.personId, key, m, h);
      }
    }
  }
}

/** Personnes actives de l'équipe ISD qui ont un profil (profileKey), avec ce profil. */
function profiled(model) {
  return [...model.people.values()].map((p) => ({ p, key: profileKey(p, model) })).filter((x) => x.key);
}

/**
 * Nombre de personnes dont la capacité compte, par profil (PO, DA, DS, DE, Mgmt).
 * @returns {Record<'PO'|'DA'|'DS'|'DE'|'Mgmt', number>}
 */
export function profileHeadcount(model) {
  const out = Object.fromEntries(PROFILE_KEYS.map((k) => [k, 0]));
  for (const { key } of profiled(model)) out[key]++;
  return out;
}

/**
 * Charge par profil et par mois, sur les 12 mois de la fenêtre (ROLE_WINDOW). Charge : heures de chaque charge
 * réparties sur les jours de la tâche (spreadHours), cumulées par profil (profileKey, comme le plan de charge : PO, DA, DS, DE, Mgmt =
 * Management de l'équipe ISD, Autre), en ETP du mois (1 ETP = fteHours du mois). Capacité : somme des capacités du
 * plan de charge (personMonthCapacity) des personnes actives du profil (profileKey), sans « Autre » ; taux = charge
 * sur capacité en heures (loadRate). Vide sans aucune charge dans la fenêtre.
 * @param {number} today jour courant
 * @returns {{month:string, fte:number, total:number, PO:number, DA:number, DS:number, DE:number, Mgmt:number,
 *   Autre:number, hours:Record<string, number>, capacity:Record<string, number>,
 *   capacityHours:Record<string, number>, rates:Record<string, {rate:number|null, level:string}>,
 *   isdCapacity:number}[]} capacity et isdCapacity (PO, DA, DS, DE, sans le Management) en ETP
 */
export function roleLoad(model, taskIds, today, { before, after } = ROLE_WINDOW) {
  const window = monthsFrom(shiftMonth(monthKey(today), -before), before + 1 + after);
  const hours = new Map(window.map((m) => [m, Object.fromEntries(ETP_SPLIT.map((k) => [k, 0]))]));
  let any = false;
  eachCharge(model, taskIds, hours, (id, person, key, m, h) => {
    hours.get(m)[key] += h;
    any = true;
  });
  if (!any) return [];
  const team = profiled(model);
  return window.map((month) => {
    const { start, end } = monthRange(month);
    const fte = fteHours(start, end);
    const capacityHours = Object.fromEntries(PROFILE_KEYS.map((k) => [k, 0]));
    for (const { p, key } of team) capacityHours[key] += personMonthCapacity(p, month);
    const row = { month, fte, total: 0, hours: {}, capacity: {}, capacityHours: {}, rates: {}, isdCapacity: 0 };
    for (const k of ETP_SPLIT) {
      const h = round6(hours.get(month)[k]);
      row.hours[k] = h;
      row[k] = hoursToEtp(h, fte);
      row.total += row[k];
    }
    for (const k of PROFILE_KEYS) {
      const c = round6(capacityHours[k]);
      row.capacityHours[k] = c;
      row.capacity[k] = hoursToEtp(c, fte);
      row.rates[k] = loadRate(row.hours[k], c);
    }
    row.isdCapacity = ETP_ROLES.reduce((s, k) => s + row.capacity[k], 0);
    return row;
  });
}

/** Profils à tracer : PO, DA, DS, DE et Mgmt toujours ; « Autre » seulement s'il a une charge dans la fenêtre. */
export function roleSeries(rows) {
  return ETP_SPLIT.filter((k) => k !== 'Autre' || rows.some((r) => r.Autre > 0));
}

/**
 * Synthèse par profil (PO, DA, DS, DE, Mgmt) du mois `from` (le mois courant) à la fin de la fenêtre, mois par mois :
 * - pic : le mois au taux le plus haut parmi les mois chargés (charge sans capacité = pic sans taux) ; son niveau
 *   donne celui du profil (« none » sans aucune charge) ;
 * - nombre de mois retenus, chargés, en dépassement et en tension ;
 * - moyenne des seuls mois chargés (charge et capacité en ETP), null sans charge.
 * @param {ReturnType<typeof roleLoad>} rows
 * @param {string} from mois 'YYYY-MM'
 */
export function summarizeMonths(rows, from) {
  const kept = rows.filter((r) => r.month >= from);
  const out = {};
  for (const k of PROFILE_KEYS) {
    const s = {
      months: kept.length,
      loadedMonths: 0,
      overMonths: 0,
      tensionMonths: 0,
      peak: null,
      level: 'none',
      avgLoaded: null,
    };
    let load = 0;
    let capacity = 0;
    let best = -1;
    for (const r of kept) {
      if (!(r.hours[k] > 0)) continue;
      const rate = loadRate(r.hours[k], r.capacityHours[k]);
      s.loadedMonths++;
      if (rate.level === 'over') s.overMonths++;
      else if (rate.level === 'tension') s.tensionMonths++;
      load += r[k];
      capacity += r.capacity[k];
      const score = rate.rate === null ? Infinity : rate.rate;
      if (score > best) {
        best = score;
        s.peak = { rate: rate.rate, month: r.month, level: rate.level };
      }
    }
    if (s.loadedMonths) {
      s.level = s.peak.level;
      s.avgLoaded = { load: load / s.loadedMonths, capacity: capacity / s.loadedMonths };
    }
    out[k] = s;
  }
  return out;
}

/**
 * Tâches d'un segment du graphique (un profil, un mois) : celles dont une charge de ce profil tombe sur le mois,
 * avec les heures du profil sur le mois et les personnes concernées, mêmes règles que roleLoad (la somme des
 * heures redonne celles du segment). Tri par heures décroissantes, puis identifiant ; personnes de même.
 * @param {string} key PO, DA, DS, DE, Mgmt ou Autre
 * @param {string} month 'YYYY-MM'
 * @returns {{hours:number, tasks:{taskId:number, hours:number, people:{personId:number, nom:string, hours:number}[]}[]}}
 */
export function segmentTasks(model, taskIds, key, month) {
  const byTask = new Map();
  eachCharge(model, taskIds, new Set([month]), (id, person, k, m, h) => {
    if (k !== key) return;
    const people = byTask.get(id) ?? new Map();
    people.set(person, (people.get(person) ?? 0) + h);
    byTask.set(id, people);
  });
  let total = 0;
  const tasks = [...byTask].map(([taskId, people]) => {
    const list = [...people]
      .map(([personId, h]) => [personId, round6(h)])
      .sort(byHoursDesc)
      .map(([personId, h]) => ({ personId, nom: model.people.get(personId)?.nom ?? '', hours: h }));
    const hours = round6(list.reduce((s, p) => s + p.hours, 0));
    total += hours;
    return { taskId, hours, people: list };
  });
  tasks.sort((a, b) => byHoursDesc([a.taskId, a.hours], [b.taskId, b.hours]));
  return { hours: round6(total), tasks };
}

/**
 * Focus itinérant des segments : position suivante pour une touche, ou null si la touche ne déplace rien.
 * ←/→ : profil précédent ou suivant du même mois ; ↑/↓ : mois précédent ou suivant qui a des segments, même profil
 * s'il y est, sinon le segment de même rang (ou le dernier) ; Début et Fin : premier et dernier profil du mois.
 * @param {string[][]} grid profils tracés de chaque mois, dans l'ordre affiché
 * @param {{row:number, col:number}} pos
 * @param {string} key
 * @returns {{row:number, col:number}|null}
 */
export function segmentMove(grid, pos, key) {
  const { row, col } = pos;
  const cells = grid[row] ?? [];
  if (key === 'ArrowRight') return col + 1 < cells.length ? { row, col: col + 1 } : null;
  if (key === 'ArrowLeft') return col > 0 ? { row, col: col - 1 } : null;
  if (key === 'Home') return cells.length && col !== 0 ? { row, col: 0 } : null;
  if (key === 'End') return cells.length && col !== cells.length - 1 ? { row, col: cells.length - 1 } : null;
  const step = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
  if (!step) return null;
  for (let r = row + step; r >= 0 && r < grid.length; r += step) {
    if (!grid[r].length) continue;
    const same = grid[r].indexOf(cells[col]);
    return { row: r, col: same >= 0 ? same : Math.min(col, grid[r].length - 1) };
  }
  return null;
}
