/** Vue Équipe : capacité, charge et taux par personne ISD et par mois, total par profil. Fonctions pures (spec §4.5). */
import { personMonthCapacity, spreadHours } from './capacity.js';

/** Ordre d'affichage des profils ISD. */
export const TEAM_ROLES = Object.freeze(['PO', 'DA', 'DS', 'DE']);
export const TENSION_FROM = 85;
export const OVER_FROM = 100;

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
const round6 = (x) => Math.round(x * 1e6) / 1e6;

/**
 * Niveau d'une case d'après le pourcentage arrondi affiché, pour que la couleur et le texte concordent :
 * < 85 % ok, 85 à 100 % tension, > 100 % dépassement. Capacité nulle : « none » sans charge, dépassement sinon.
 * @param {number|null} rate charge ÷ capacité, null si la capacité est nulle
 * @param {number} [load] charge en heures (utilisée seulement quand rate est null)
 * @returns {'ok'|'tension'|'over'|'none'}
 */
export function rateLevel(rate, load = 0) {
  if (rate === null || rate === undefined) return load > 0 ? 'over' : 'none';
  const pct = Math.round(rate * 100);
  if (pct < TENSION_FROM) return 'ok';
  return pct <= OVER_FROM ? 'tension' : 'over';
}

function cellOf(ym, capacity, load, hours) {
  const rate = capacity > 0 ? load / capacity : null;
  const taskIds = Object.keys(hours)
    .map(Number)
    .sort((a, b) => hours[b] - hours[a] || a - b);
  return { ym, capacity, load, rate, level: rateLevel(rate, load), taskIds, hours };
}

/**
 * Plan de charge des personnes ISD sur les mois donnés. Chaque tâche de taskIds n'est comptée qu'une fois ;
 * les charges sur une tâche sans dates valides ou d'une personne hors ISD sont ignorées.
 * @param {object} model modèle (core/model.js)
 * @param {Iterable<number>} taskIds tâches retenues par les filtres
 * @param {string[]} months clés 'YYYY-MM'
 * @returns {{personId:number, role:string, nom:string, months:{ym:string, capacity:number, load:number,
 *   rate:number|null, level:string, taskIds:number[], hours:Record<number, number>}[]}[]}
 */
export function teamLoad(model, taskIds, months) {
  const wanted = new Set(months);
  const isd = [...model.people.values()].filter((p) => p.isd && TEAM_ROLES.includes(p.role));
  const acc = new Map(isd.map((p) => [p.id, new Map(months.map((ym) => [ym, {}]))]));
  for (const id of new Set(taskIds)) {
    const t = model.tasks.get(id);
    if (!t) continue;
    for (const c of t.charges) {
      const person = acc.get(c.personId);
      if (!person) continue;
      const spread = spreadHours(c.heures, t.start, t.end);
      if (!spread) continue;
      for (const [ym, h] of spread) {
        if (!wanted.has(ym) || h <= 0) continue;
        const hours = person.get(ym);
        hours[id] = round6((hours[id] ?? 0) + h);
      }
    }
  }
  return isd
    .sort((a, b) => TEAM_ROLES.indexOf(a.role) - TEAM_ROLES.indexOf(b.role) || collator.compare(a.nom, b.nom))
    .map((p) => ({
      personId: p.id,
      role: p.role,
      nom: p.nom,
      months: months.map((ym) => {
        const hours = acc.get(p.id).get(ym);
        const load = round6(Object.values(hours).reduce((s, h) => s + h, 0));
        return cellOf(ym, personMonthCapacity(p, ym), load, hours);
      }),
    }));
}

/**
 * Totaux par profil : sommes des capacités et des charges, taux recalculé sur les sommes.
 * @param {ReturnType<typeof teamLoad>} rows
 * @returns {{role:string, count:number, months:{ym:string, capacity:number, load:number, rate:number|null, level:string}[]}[]}
 */
export function teamTotals(rows) {
  return TEAM_ROLES.map((role) => {
    const group = rows.filter((r) => r.role === role);
    if (!group.length) return null;
    const months = group[0].months.map((first, i) => {
      const capacity = group.reduce((s, r) => s + r.months[i].capacity, 0);
      const load = round6(group.reduce((s, r) => s + r.months[i].load, 0));
      const rate = capacity > 0 ? load / capacity : null;
      return { ym: first.ym, capacity, load, rate, level: rateLevel(rate, load) };
    });
    return { role, count: group.length, months };
  }).filter(Boolean);
}
