/** Portfolio : indicateurs, éléments des frises, échelle en mois, charge et capacité hebdomadaires par profil. Fonctions pures (spec §4.5, §5). */
import { DAY_MS, MONTHS_FR, weekday } from './dates.js';
import { fteHours, hoursShare, personWeekCapacity } from './capacity.js';
import { PROFILE_KEYS, profileKey } from './kanban-data.js';
import { normalize } from './text.js';

/** Sous-onglets, dans l'ordre affiché. */
export const PORTFOLIO_TABS = Object.freeze(['projets', 'chantiers', 'taches', 'load']);
/** Durées proposées (mois). */
export const PORTFOLIO_MONTHS = Object.freeze([6, 12, 18]);
/** Sous-onglet → genres de nœuds de l'arbre (l'onglet Tâches comprend les sous-tâches). */
export const TAB_KIND = Object.freeze({
  projets: Object.freeze(['projet']),
  chantiers: Object.freeze(['chantier']),
  taches: Object.freeze(['tache', 'sous-tache']),
});
/** Seuils du taux de charge (spec §4.5). */
export const RATE_TENSION = 0.85;

const SEP = ' › ';
const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
const refKey = (ref) => `${ref.table}:${ref.id}`;
const ymd = (day) => {
  const x = new Date(day * DAY_MS);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate() };
};
const dayOfYmd = (y, m, d = 1) => Date.UTC(y, m, d) / DAY_MS;
const mondayOf = (day) => day - ((weekday(day) + 6) % 7);

/** Parcourt l'arbre filtré : fn(nœud, titres des ancêtres sans la catégorie, titre de la catégorie). */
function walk(tree, fn) {
  const go = (n, path, categorie) => {
    fn(n, path, categorie);
    const next = n.kind === 'categorie' ? path : [...path, n.title];
    n.children.forEach((c) => go(c, next, categorie));
  };
  tree.forEach((f) => go(f, [], f.title));
}

/**
 * Indicateurs de l'en-tête : projets, chantiers (hors « (sans chantier) ») et tâches visibles (sous-tâches
 * comprises), chacun compté une fois même s'il apparaît sous plusieurs projets ; personnes actives de l'équipe ISD
 * (profils ISD et Management ISD) assignées, responsables ou chargées sur une tâche visible, par profil.
 * @param {object} model
 * @param {{tree:object[], taskIds:Set<number>}} view résultat de applyFilters
 * @returns {{projets:number, chantiers:number, taches:number, personnes:{total:number, PO:number, DA:number, DS:number, DE:number, Mgmt:number}}}
 */
export function portfolioKpis(model, view) {
  const seen = { projet: new Set(), chantier: new Set(), tache: new Set() };
  walk(view.tree, (n) => {
    const kind = n.kind === 'sous-tache' ? 'tache' : n.kind;
    if (n.ref && seen[kind]) seen[kind].add(refKey(n.ref));
  });
  const people = new Map();
  for (const id of view.taskIds) {
    const t = model.tasks.get(id);
    if (!t) continue;
    for (const p of [...t.assignees, t.responsable, ...t.charges.map((c) => c.personId)]) {
      const key = profileKey(model.people.get(p), model);
      if (key) people.set(p, key);
    }
  }
  const personnes = { total: people.size, PO: 0, DA: 0, DS: 0, DE: 0, Mgmt: 0 };
  for (const key of people.values()) personnes[key]++;
  return {
    projets: seen.projet.size,
    chantiers: seen.chantier.size,
    taches: seen.tache.size,
    personnes,
  };
}

/** Période d'un nœud : ses dates si les deux existent, sinon son étendue (« déduite »), sinon null. */
function barOf(n) {
  if (n.start !== null && n.end !== null)
    return { start: Math.min(n.start, n.end), end: Math.max(n.start, n.end), deduced: false };
  if (n.span)
    return { start: Math.min(n.span.start, n.span.end), end: Math.max(n.span.start, n.span.end), deduced: true };
  return null;
}

/**
 * Lignes d'une frise : un élément par ligne source (premier emplacement dans l'arbre), éléments virtuels exclus,
 * filtrés par la recherche locale (titre, accents et casse ignorés), triés par début (sans dates en dernier) puis titre.
 * @param {object} model
 * @param {object[]} tree arbre filtré
 * @param {string|readonly string[]} kinds genre(s) de nœuds retenus (voir TAB_KIND)
 * @param {string} query recherche locale
 * @returns {{key:string, ref:{table:string,id:number}, node:object, title:string, context:string, status:string, bar:{start:number,end:number,deduced:boolean}|null}[]}
 */
export function portfolioItems(model, tree, kinds, query) {
  const q = normalize(query);
  const wanted = new Set([kinds].flat());
  const out = new Map();
  walk(tree, (n, path, categorie) => {
    if (!wanted.has(n.kind) || !n.ref || out.has(refKey(n.ref))) return;
    if (q && !normalize(n.title).includes(q)) return;
    out.set(refKey(n.ref), {
      key: n.key,
      ref: n.ref,
      node: n,
      title: n.title,
      context: n.kind === 'projet' ? categorie : path.join(SEP),
      status: n.status,
      bar: barOf(n),
    });
  });
  return [...out.values()].sort((a, b) => {
    if (a.bar && b.bar && a.bar.start !== b.bar.start) return a.bar.start - b.bar.start;
    if (Boolean(a.bar) !== Boolean(b.bar)) return a.bar ? -1 : 1;
    return collator.compare(a.title, b.title);
  });
}

/** Premier jour du mois de `today` (début par défaut des frises). */
export function defaultStart(today) {
  const { y, m } = ymd(today);
  return dayOfYmd(y, m);
}

/** Dernier jour de la période : même quantième N mois plus tard, moins un jour (borné à la fin du mois). */
function periodEnd(start, months) {
  const { y, m, d } = ymd(start);
  const last = dayOfYmd(y, m + months + 1, 0);
  return Math.min(dayOfYmd(y, m + months, d), last + 1) - 1;
}

/**
 * Fenêtre d'une frise : de `start` à N mois plus tard, colonnes mensuelles (la première et la dernière
 * peuvent être partielles), groupes par année. Même forme que timeScale (gantt-data.js).
 * @param {number} start
 * @param {number} months
 */
export function portfolioScale(start, months) {
  const end = periodEnd(start, months);
  const columns = [];
  for (let s = start; s <= end; ) {
    const { y, m } = ymd(s);
    const e = Math.min(dayOfYmd(y, m + 1) - 1, end);
    columns.push({ label: MONTHS_FR[m], title: `${MONTHS_FR[m]} ${y}`, start: s, end: e });
    s = e + 1;
  }
  const groups = [];
  for (const c of columns) {
    const year = String(ymd(c.start).y);
    if (groups.at(-1)?.label === year) groups.at(-1).end = c.end;
    else groups.push({ label: year, start: c.start, end: c.end });
  }
  return { mode: 'portfolio', start, end, days: end - start + 1, columns, groups };
}

/** Nombre de semaines (du lundi de `start` à la fin de la période de N mois). */
export function weekCount(start, months) {
  return Math.ceil((periodEnd(start, months) - mondayOf(start) + 1) / 7);
}

const round = (x) => Math.round(x * 1e6) / 1e6;

/**
 * Charge et capacité hebdomadaires par profil, en heures, sur `weeks` semaines à partir du lundi de `startDay`.
 * Profils : PO, DA, DS, DE et Mgmt (Management de l'équipe ISD), personnes actives (profileKey).
 * Charge : heures de ces personnes réparties sur les jours de chaque tâche au prorata de la capacité standard
 * (hoursShare ; chaque tâche une fois).
 * Capacité : toutes les personnes actives du profil (spec §4.5, jour par jour : capacité hebdomadaire ou 35 h,
 * jours fériés, indisponibilités). fte : heures de 1 ETP sur la semaine (fteHours, conversion en ETP).
 * @param {object} model
 * @param {Iterable<number>} taskIds
 * @param {number} startDay
 * @param {number} weeks
 * @returns {{weekStart:number, fte:number|null, PO:number, DA:number, DS:number, DE:number, Mgmt:number,
 *   capacity:Record<string, number>}[]}
 */
export function weeklyLoadByProfile(model, taskIds, startDay, weeks) {
  const first = mondayOf(startDay);
  const rows = Array.from({ length: weeks }, (_, i) => ({
    weekStart: first + 7 * i,
    fte: fteHours(first + 7 * i, first + 7 * i + 6),
    ...Object.fromEntries(PROFILE_KEYS.map((k) => [k, 0])),
    capacity: Object.fromEntries(PROFILE_KEYS.map((k) => [k, 0])),
  }));
  const last = first + 7 * weeks - 1;
  for (const id of new Set(taskIds)) {
    const t = model.tasks.get(id);
    if (!t || t.start === null || t.end === null || t.end < t.start || t.end < first || t.start > last) continue;
    for (const c of t.charges) {
      const key = profileKey(model.people.get(c.personId), model);
      if (!key) continue;
      for (const r of rows) r[key] += hoursShare(c.heures, t.start, t.end, r.weekStart, r.weekStart + 6);
    }
  }
  const team = [...model.people.values()].map((p) => ({ p, key: profileKey(p, model) })).filter((x) => x.key);
  for (const r of rows) {
    for (const { p, key } of team) r.capacity[key] += personWeekCapacity(p, r.weekStart);
    for (const k of PROFILE_KEYS) {
      r[k] = round(r[k]);
      r.capacity[k] = round(r.capacity[k]);
    }
  }
  return rows;
}

/**
 * Taux de charge et niveau : < 85 % ok, 85 à 100 % tension, > 100 % dépassement (« over ») ;
 * capacité nulle : dépassement s'il y a de la charge, sinon « none ».
 * @returns {{rate:number|null, level:'ok'|'tension'|'over'|'none'}}
 */
export function loadRate(load, capacity) {
  if (!(capacity > 0)) return { rate: null, level: load > 0 ? 'over' : 'none' };
  const rate = Math.round((load / capacity) * 1e4) / 1e4;
  return { rate, level: rate > 1 ? 'over' : rate >= RATE_TENSION ? 'tension' : 'ok' };
}

/**
 * Synthèse de la période par profil, semaine par semaine (une moyenne sur toute la durée masquerait les pics) :
 * - pic : la semaine au taux le plus haut parmi les semaines chargées (charge sans capacité = pic sans taux) ;
 *   son niveau donne celui du profil (« none » sans aucune charge) ;
 * - nombre de semaines chargées, en dépassement et en tension ;
 * - moyenne des seules semaines chargées (heures de charge, de capacité et de 1 ETP par semaine), null sans charge.
 * @param {{weekStart:number, PO:number, DA:number, DS:number, DE:number, capacity:object}[]} rows
 * @returns {Record<'PO'|'DA'|'DS'|'DE'|'Mgmt', {weeks:number, loadedWeeks:number, overWeeks:number, tensionWeeks:number,
 *   peak:{rate:number|null, weekStart:number, level:string}|null, level:string,
 *   avgLoaded:{load:number, capacity:number, fte:number}|null}>}
 */
export function summarizeWeeks(rows) {
  const out = {};
  for (const k of PROFILE_KEYS) {
    const s = {
      weeks: rows.length,
      loadedWeeks: 0,
      overWeeks: 0,
      tensionWeeks: 0,
      peak: null,
      level: 'none',
      avgLoaded: null,
    };
    let load = 0;
    let capacity = 0;
    let fte = 0;
    let best = -1;
    for (const r of rows) {
      if (!(r[k] > 0)) continue;
      const rate = loadRate(r[k], r.capacity[k]);
      s.loadedWeeks++;
      if (rate.level === 'over') s.overWeeks++;
      else if (rate.level === 'tension') s.tensionWeeks++;
      load += r[k];
      capacity += r.capacity[k];
      fte += r.fte ?? 0;
      const key = rate.rate === null ? Infinity : rate.rate;
      if (key > best) {
        best = key;
        s.peak = { rate: rate.rate, weekStart: r.weekStart, level: rate.level };
      }
    }
    if (s.loadedWeeks) {
      s.level = s.peak.level;
      s.avgLoaded = {
        load: round(load / s.loadedWeeks),
        capacity: round(capacity / s.loadedWeeks),
        fte: round(fte / s.loadedWeeks),
      };
    }
    out[k] = s;
  }
  return out;
}
