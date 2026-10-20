/** Capacité (jours ouvrés, fériés, congés, ralentissements) et charge (heures réparties sur les jours calendaires). Spec §4.5. */
import { monthRange, weekday, monthKey } from './dates.js';

export const HOURS_PER_FTE_WEEK = 35;
export const DEFAULT_LEAVE_DAYS = 44;
export const SLOWDOWN = Object.freeze({ '07': 0.6, '08': 0.5, 12: 0.8 });
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

/** Répartit uniformément des heures sur les jours calendaires [start, end] ; null si dates absentes ou incohérentes. */
export function spreadHours(heures, start, end) {
  if (start === null || end === null || start === undefined || end === undefined || end < start) return null;
  const perDay = heures / (end - start + 1);
  const out = new Map();
  for (let d = start; d <= end; d++) {
    const k = monthKey(d);
    out.set(k, (out.get(k) ?? 0) + perDay);
  }
  for (const [k, v] of out) out.set(k, Math.round(v * 1e6) / 1e6);
  return out;
}

export function hoursToEtp(hours, nDays) {
  return nDays > 0 ? hours / ((HOURS_PER_FTE_WEEK * nDays) / 7) : 0;
}

export function etpToHours(etp, nDays) {
  return (etp * HOURS_PER_FTE_WEEK * nDays) / 7;
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
