/**
 * Vue « Mes tâches » : tâches et sous-tâches d'une personne (assignée, responsable ou chargée), non terminées,
 * groupées par échéance sur des semaines du lundi au dimanche. Fonctions pures.
 */
import { hoursToEtp, HOURS_PER_FTE_WEEK, personWeekCapacity } from './capacity.js';
import { weekStart } from './dates.js';

/** Groupes, dans l'ordre d'affichage. */
export const PERIODS = Object.freeze(['late', 'thisWeek', 'nextWeek', 'later', 'noDate']);
/** Lignes affichées d'abord dans chaque groupe, puis par tranche avec « Afficher plus ». */
export const PAGE_SIZE = 20;
/** Profondeur maximale suivie en remontant les tâches parentes (protège d'un cycle dans la Feuille). */
const MAX_DEPTH = 20;

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

/**
 * Groupe d'une échéance : passée (« En retard »), dans la semaine en cours, la semaine suivante, plus tard, ou
 * absente. Une échéance aujourd'hui n'est pas en retard.
 * @param {number|null} end échéance (jour)
 * @param {number} today
 * @returns {'late'|'thisWeek'|'nextWeek'|'later'|'noDate'}
 */
export function periodOf(end, today) {
  if (end === null || end === undefined) return 'noDate';
  if (end < today) return 'late';
  const sunday = weekStart(today) + 6;
  if (end <= sunday) return 'thisWeek';
  if (end <= sunday + 7) return 'nextWeek';
  return 'later';
}

/** Rôles de la personne sur la tâche : assignée, responsable, chargée (ligne de charge, même à 0 h). */
function rolesOf(task, personId) {
  const roles = [];
  if (task.assignees.includes(personId)) roles.push('assignee');
  if (task.responsable === personId) roles.push('responsable');
  if (task.charges.some((c) => c.personId === personId)) roles.push('charge');
  return roles;
}

/**
 * Chantier, projet et tâche parente d'une tâche : une sous-tâche sans chantier ni projet propres hérite de
 * ceux de sa tâche parente (à toute profondeur).
 * @returns {{chantier:string|null, projet:string|null, projectId:number|null, parent:string|null}}
 */
export function placeOf(model, task) {
  const parent = task.parentId ? model.tasks.get(task.parentId) : null;
  let t = task;
  for (let i = 0; i < MAX_DEPTH && !t.chantierId && !t.projectId && t.parentId; i++) {
    const up = model.tasks.get(t.parentId);
    if (!up) break;
    t = up;
  }
  const chantier = t.chantierId ? (model.chantiers.get(t.chantierId) ?? null) : null;
  const projectId = t.projectId ?? chantier?.projectIds[0] ?? null;
  return {
    chantier: chantier?.title ?? null,
    projet: projectId ? (model.projects.get(projectId)?.title ?? null) : null,
    projectId,
    parent: parent?.title ?? null,
  };
}

const byDue = (a, b) =>
  (a.end ?? Infinity) - (b.end ?? Infinity) ||
  (a.start ?? Infinity) - (b.start ?? Infinity) ||
  collator.compare(a.title, b.title) ||
  a.id - b.id;

/**
 * Tâches non terminées de la personne, triées par échéance, puis début, puis titre. Les tâches des projets
 * masqués (Préférences) sont écartées ; les autres filtres du widget ne s'appliquent pas.
 * @param {object} model
 * @param {number|null} personId
 * @param {number} today
 * @param {{hiddenProjects?:number[]}} [opts]
 * @returns {{id:number, title:string, status:string, start:number|null, end:number|null, subtask:boolean,
 *   period:string, lateDays:number, roles:string[], hours:number, etp:number|null, chantier:string|null,
 *   projet:string|null, parent:string|null}[]}
 */
export function myTasks(model, personId, today, { hiddenProjects = [] } = {}) {
  if (personId === null || personId === undefined) return [];
  const hidden = new Set(hiddenProjects);
  const out = [];
  for (const t of model.tasks.values()) {
    if (t.done) continue;
    const roles = rolesOf(t, personId);
    if (!roles.length) continue;
    const place = placeOf(model, t);
    if (place.projectId !== null && hidden.has(place.projectId)) continue;
    const hours = t.charges.filter((c) => c.personId === personId).reduce((s, c) => s + c.heures, 0);
    const days = t.start !== null && t.end !== null && t.end >= t.start ? t.end - t.start + 1 : 0;
    const period = periodOf(t.end, today);
    out.push({
      id: t.id,
      title: t.title,
      status: t.status,
      start: t.start,
      end: t.end,
      subtask: Boolean(t.parentId),
      period,
      lateDays: period === 'late' ? today - t.end : 0,
      roles,
      hours,
      etp: hours > 0 && days ? hoursToEtp(hours, days) : null,
      chantier: place.chantier,
      projet: place.projet,
      parent: place.parent,
    });
  }
  return out.sort(byDue);
}

/**
 * Tâches réparties dans les groupes de PERIODS (tous présents, même vides), dans l'ordre de la liste reçue.
 * @param {{period:string}[]} items
 * @returns {{period:string, items:object[]}[]}
 */
export function groupByPeriod(items) {
  const groups = new Map(PERIODS.map((p) => [p, []]));
  for (const it of items) groups.get(it.period)?.push(it);
  return PERIODS.map((period) => ({ period, items: groups.get(period) }));
}

/**
 * Nombre de lignes visibles après `clicks` appuis sur « Afficher plus » (jamais plus que le total).
 * @param {number} total
 * @param {number} clicks
 */
export function visibleCount(total, clicks = 0) {
  return Math.min(total, PAGE_SIZE * (1 + Math.max(0, clicks)));
}

/**
 * Charge de la personne sur la semaine (lundi à dimanche) qui contient `today` : ses heures de chaque tâche
 * datée, réparties sur les jours calendaires de la tâche (comme le plan de charge), face à sa capacité de la
 * semaine (fériés, congés et indisponibilités déduits). Les tâches terminées comptent : la charge était prévue.
 * @returns {{start:number, hours:number, capacity:number, etp:number, capacityEtp:number}|null} null si la
 *   personne est inconnue
 */
export function weekLoad(model, personId, today) {
  const person = model.people.get(personId);
  if (!person) return null;
  const start = weekStart(today);
  const end = start + 6;
  let hours = 0;
  for (const t of model.tasks.values()) {
    if (t.start === null || t.end === null || t.end < t.start || t.end < start || t.start > end) continue;
    const h = t.charges.filter((c) => c.personId === personId).reduce((s, c) => s + c.heures, 0);
    if (!h) continue;
    const overlap = Math.min(t.end, end) - Math.max(t.start, start) + 1;
    hours += (h * overlap) / (t.end - t.start + 1);
  }
  const capacity = personWeekCapacity(person, start);
  return {
    start,
    hours,
    capacity,
    etp: hours / HOURS_PER_FTE_WEEK,
    capacityEtp: capacity / HOURS_PER_FTE_WEEK,
  };
}
