/**
 * Capacité (jours ouvrés, fériés, congés, ralentissements) et charge (heures réparties sur les jours d'une tâche au
 * prorata de la capacité standard, hoursSharer).
 * Spec §4.5. 1 ETP sur une période = capacité d'une personne standard à temps plein (35 h, sans indisponibilité)
 * sur cette période (fteHours) : même formule que le plan de charge, pour les tâches comme pour les vues.
 */
import { monthRange, weekday, monthKey } from './dates.js';

/** Quotité par défaut d'une personne de Team (capacité hebdomadaire vide) et de la personne standard. */
export const HOURS_PER_FTE_WEEK = 35;
export const DEFAULT_LEAVE_DAYS = 44;
/** Ralentissements par mois (part de la capacité) : ponts de mai, été, fêtes de fin d'année. */
export const SLOWDOWN = Object.freeze({ '05': 0.8, '07': 0.6, '08': 0.5, 12: 0.8 });
const DAY = (y, m, d) => Date.UTC(y, m - 1, d) / 86400000;

/** Dimanche de Pâques (Meeus / Jones / Butcher), en jour UTC. */
export function easterSunday(year) {
  const a = year % 19,
    b = Math.floor(year / 100),
    c = year % 100,
    d = Math.floor(b / 4),
    e = b % 4;
  const f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4),
    k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31),
    day = ((h + l - 7 * m + 114) % 31) + 1;
  return DAY(year, month, day);
}

const holidayCache = new Map();
export function frenchHolidays(year) {
  if (!holidayCache.has(year)) {
    const e = easterSunday(year);
    holidayCache.set(
      year,
      new Set([
        DAY(year, 1, 1),
        e + 1,
        DAY(year, 5, 1),
        DAY(year, 5, 8),
        e + 39,
        e + 50,
        DAY(year, 7, 14),
        DAY(year, 8, 15),
        DAY(year, 11, 1),
        DAY(year, 11, 11),
        DAY(year, 12, 25),
      ]),
    );
  }
  return holidayCache.get(year);
}

export function isWorkday(day) {
  const w = weekday(day);
  if (w === 0 || w === 6) return false;
  return !frenchHolidays(new Date(day * 86400000).getUTCFullYear()).has(day);
}

export function workdaysBetween(a, b) {
  let n = 0;
  for (let d = a; d <= b; d++) if (isWorkday(d)) n++;
  return n;
}

const yearCache = new Map();
export function workdaysInYear(year) {
  if (!yearCache.has(year)) yearCache.set(year, workdaysBetween(DAY(year, 1, 1), DAY(year, 12, 31)));
  return yearCache.get(year);
}

/**
 * Répartit des heures sur les mois de [start, end] au prorata de la capacité standard de chaque jour (hoursSharer) :
 * une tâche à 1 ETP compte 1 ETP chaque mois. Clés : chaque mois touché par la période (0 compris), valeurs
 * arrondies à 1e-6 ; null si dates absentes ou incohérentes.
 */
export function spreadHours(heures, start, end) {
  const share = hoursSharer(start, end);
  if (!share) return null;
  const out = new Map();
  for (let d = start; d <= end; ) {
    const k = monthKey(d);
    const last = Math.min(monthRange(k).end, end);
    out.set(k, Math.round(share(heures, d, last) * 1e6) / 1e6);
    d = last + 1;
  }
  return out;
}

/**
 * ETP équivalent à des heures sur une période dont 1 ETP vaut `fte` heures (fteHours) ; 0 si fte n'est pas > 0.
 * @param {number} hours
 * @param {number|null} fte
 */
export function hoursToEtp(hours, fte) {
  return fte > 0 ? hours / fte : 0;
}

/** Heures équivalentes à un ETP sur une période dont 1 ETP vaut `fte` heures (fteHours). */
export function etpToHours(etp, fte) {
  return etp * fte;
}

/** Heures disponibles d'une personne sur un mois 'YYYY-MM'. */
export function personMonthCapacity(person, ym) {
  const { start, end } = monthRange(ym);
  const year = Number(ym.slice(0, 4));
  const weekly = person.capaciteHebdo > 0 ? person.capaciteHebdo : HOURS_PER_FTE_WEEK;
  const factor =
    (weekly / 5) * Math.max(0, 1 - DEFAULT_LEAVE_DAYS / workdaysInYear(year)) * (SLOWDOWN[ym.slice(5)] ?? 1);
  let days = workdaysBetween(start, end);
  for (const u of person.unavailability ?? []) {
    const a = Math.max(u.start, start),
      b = Math.min(u.end, end);
    if (a <= b) days -= workdaysBetween(a, b) * (1 - u.dispo);
  }
  return Math.max(0, days * factor);
}

/**
 * Heures disponibles d'une personne un jour donné : même formule que personMonthCapacity, jour par jour
 * (la somme des jours d'un mois redonne la capacité du mois). 0 le week-end et les jours fériés.
 * @param {{capaciteHebdo:number, unavailability?:{start:number,end:number,dispo:number}[]}} person
 * @param {number} day
 */
export function personDayCapacity(person, day) {
  if (!isWorkday(day)) return 0;
  const ym = monthKey(day);
  const weekly = person.capaciteHebdo > 0 ? person.capaciteHebdo : HOURS_PER_FTE_WEEK;
  const factor =
    (weekly / 5) *
    Math.max(0, 1 - DEFAULT_LEAVE_DAYS / workdaysInYear(Number(ym.slice(0, 4)))) *
    (SLOWDOWN[ym.slice(5)] ?? 1);
  let part = 1;
  for (const u of person.unavailability ?? []) if (day >= u.start && day <= u.end) part -= 1 - u.dispo;
  return Math.max(0, part) * factor;
}

/** Heures disponibles d'une personne sur les 7 jours commençant à `start`. */
export function personWeekCapacity(person, start) {
  let h = 0;
  for (let d = start; d < start + 7; d++) h += personDayCapacity(person, d);
  return h;
}

export function loadByPersonMonth(tasks) {
  const out = new Map();
  for (const t of tasks) {
    for (const c of t.charges) {
      const spread = spreadHours(c.heures, t.start, t.end);
      if (!spread) continue;
      if (!out.has(c.personId)) out.set(c.personId, new Map());
      const m = out.get(c.personId);
      for (const [k, v] of spread) m.set(k, Math.round(((m.get(k) ?? 0) + v) * 1e6) / 1e6);
    }
  }
  return out;
}

const STANDARD = Object.freeze({ capaciteHebdo: HOURS_PER_FTE_WEEK });

/** Heures d'une personne standard (35 h, sans indisponibilité) un jour donné : 0 le week-end et les jours fériés. */
export const standardDayHours = (day) => personDayCapacity(STANDARD, day);

/** Année UTC d'un jour, sans objet Date (estimation puis correction d'un an au plus). */
function yearOf(day) {
  const y = 1970 + Math.floor(day / 365.2425);
  if (day < DAY(y, 1, 1)) return y - 1;
  return day >= DAY(y + 1, 1, 1) ? y + 1 : y;
}
const cumulCache = new Map();
/** Sommes cumulées de standardDayHours sur une année : c[i] = heures du 1er janvier au jour i − 1 (en cache). */
function cumulOf(year) {
  let c = cumulCache.get(year);
  if (!c) {
    const first = DAY(year, 1, 1);
    const n = DAY(year + 1, 1, 1) - first;
    c = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) c[i + 1] = c[i] + standardDayHours(first + i);
    cumulCache.set(year, c);
  }
  return c;
}

/** Heures standard du 1er janvier de l'année de `day` jusqu'à `day` exclu (inclus avec `inclusive`). */
function sinceNewYear(day, inclusive = false) {
  const y = yearOf(day);
  return cumulOf(y)[day - DAY(y, 1, 1) + (inclusive ? 1 : 0)];
}
const yearTotal = (year) => cumulOf(year).at(-1);

/**
 * Heures de 1 ETP sur [start, end] (jours UTC entiers, bornes incluses) : capacité d'une personne standard
 * (standardDayHours), arrondie à 1e-6. Coût constant par appel (sommes cumulées par année, en cache).
 * @param {number|null|undefined} start
 * @param {number|null|undefined} end
 * @returns {number|null} null si les dates sont absentes, non entières, inversées, ou sans aucun jour ouvré
 */
export function fteHours(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
  const h = Math.round(standardBetween(start, end) * 1e6) / 1e6;
  return h > 0 ? h : null;
}

/** Heures standard sur [a, b], sans arrondi (0 si b < a). */
function standardBetween(a, b) {
  if (b < a) return 0;
  let sum = sinceNewYear(b, true) - sinceNewYear(a);
  for (let y = yearOf(a); y < yearOf(b); y++) sum += yearTotal(y);
  return sum;
}

/**
 * Répartition des heures d'une tâche [start, end] : rend share(heures, a, b), part des heures qui tombe sur [a, b],
 * au prorata de la capacité standard des jours (standardDayHours), pour qu'une charge de 1 ETP fasse 1 ETP sur
 * chaque mois et chaque semaine. Période sans jour ouvré (fteHours null) : au prorata des jours calendaires, pour
 * que ses heures ne se perdent pas. Capacité de la tâche calculée une fois ; chaque part, à coût constant.
 * @param {number|null} start
 * @param {number|null} end
 * @returns {((heures:number, a:number, b:number) => number)|null} null si dates absentes ou incohérentes ; la part
 *   vaut 0 hors de la période
 */
export function hoursSharer(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
  const total = standardBetween(start, end);
  const calendar = Math.round(total * 1e6) <= 0;
  const days = end - start + 1;
  return (heures, a, b) => {
    const lo = Math.max(a, start);
    const hi = Math.min(b, end);
    if (hi < lo) return 0;
    return calendar ? (heures * (hi - lo + 1)) / days : (heures * standardBetween(lo, hi)) / total;
  };
}
