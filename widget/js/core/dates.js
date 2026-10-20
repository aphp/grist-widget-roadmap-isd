/** Dates Grist (secondes depuis 1970, colonnes Date) ↔ jours entiers UTC. */
export const DAY_MS = 86400000;
export const MONTHS_FR = [
  'janv.',
  'févr.',
  'mars',
  'avr.',
  'mai',
  'juin',
  'juil.',
  'août',
  'sept.',
  'oct.',
  'nov.',
  'déc.',
];

/** Jour (entier, jours depuis le 1970-01-01 UTC) d'une date Grist ; +12 h neutralise minuit Paris / UTC. 0 ou négatif = date vide. */
export function dayOf(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return null;
  return Math.floor((ts + 43200) / 86400);
}

export function isoOfDay(d) {
  return new Date(d * DAY_MS).toISOString().slice(0, 10);
}

export function dayOfIso(s) {
  return Math.floor(Date.parse(`${s}T00:00:00Z`) / DAY_MS);
}

/** Dernier jour de planification permis : le 31 décembre de l'année (UTC) de `today` + 1. */
export function maxPlanDay(today) {
  return dayOfIso(`${new Date(today * DAY_MS).getUTCFullYear() + 1}-12-31`);
}

/**
 * Une date de planification dépasse-t-elle la borne ? Une valeur déjà présente (`unchanged`) n'est pas une saisie.
 * @param {number|null} value
 * @param {number|null|undefined} maxDay borne (absente : aucune)
 * @param {number|null} [unchanged] valeur d'origine de la colonne
 */
export function overMaxDay(value, maxDay, unchanged = null) {
  return typeof maxDay === 'number' && value !== null && value > maxDay && value !== unchanged;
}

/** Erreur de formulaire d'une date au-delà de la borne (clé de labels.js et variables). */
export const dateMaxError = (maxDay) => ({ key: 'form.error.dateMax', vars: { date: formatDateFr(maxDay) } });

export function monthKey(d) {
  return isoOfDay(d).slice(0, 7);
}

export function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1) / DAY_MS;
  const end = Date.UTC(y, m, 1) / DAY_MS - 1;
  return { start, end, n: end - start + 1 };
}

export function monthsFrom(ym, count) {
  const [y, m] = ym.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    return d.toISOString().slice(0, 7);
  });
}

export function weekday(d) {
  return new Date(d * DAY_MS).getUTCDay();
}

export function formatDateFr(d) {
  if (d === null || d === undefined) return '—';
  const x = new Date(d * DAY_MS);
  return `${x.getUTCDate()} ${MONTHS_FR[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
}

const zoneFormats = new Map();
/**
 * Jour calendaire (au format des jours du modèle) d'un instant, dans un fuseau donné : à Paris, le
 * 2026-10-25T22:30Z est déjà le 26 octobre. Ne dépend pas du fuseau du navigateur.
 * @param {Date|number} instant
 * @param {string} [timeZone]
 * @returns {number}
 */
export function dayInZone(instant, timeZone = 'Europe/Paris') {
  if (!zoneFormats.has(timeZone))
    zoneFormats.set(
      timeZone,
      new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }),
    );
  const parts = Object.fromEntries(
    zoneFormats
      .get(timeZone)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return dayOfIso(`${parts.year}-${parts.month}-${parts.day}`);
}

/** Lundi de la semaine (semaines du lundi au dimanche) qui contient le jour. */
export function weekStart(day) {
  return day - ((weekday(day) + 6) % 7);
}

/** Date courte : « 3 nov. », avec l'année si elle diffère de celle du jour de référence (« 3 nov. 2027 »). */
export function formatDayShort(d, refDay) {
  if (d === null || d === undefined) return '—';
  const x = new Date(d * DAY_MS);
  const sameYear = refDay !== undefined && new Date(refDay * DAY_MS).getUTCFullYear() === x.getUTCFullYear();
  return `${x.getUTCDate()} ${MONTHS_FR[x.getUTCMonth()]}${sameYear ? '' : ` ${x.getUTCFullYear()}`}`;
}
