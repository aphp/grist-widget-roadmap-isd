/** Statistiques : qualité des données et agrégations sur les tâches visibles. Fonctions pures (spec §4.4). */
import { monthKey, monthsFrom } from './dates.js';
import { priorityText, taskPeople, taskPriority } from './kanban-data.js';
import { breadcrumb, detailLevel } from './detail-data.js';
import { label, statusLabel } from '../labels.js';

/** Types d'anomalies du modèle portant sur une tâche, dans l'ordre d'affichage. */
export const ISSUE_KINDS = Object.freeze([
  'charges-invalides',
  'charge-personne-inconnue',
  'charge-sans-dates',
  'dates-incoherentes',
  'tache-orpheline',
  'parent-introuvable',
]);
export const EXTRA_KINDS = Object.freeze(['sans-dates', 'isd-sans-charge']);
export const CHANTIER_KIND = 'chantier-sans-responsable';
export const PROJECT_KIND = 'projet-sans-responsable';

function visibleIds(tree, kind, table) {
  const out = new Set();
  const walk = (n) => {
    if (n.kind === kind && n.ref?.table === table) out.add(n.ref.id);
    n.children.forEach(walk);
  };
  tree.forEach(walk);
  return [...out];
}

/** Identifiants des chantiers (table Chantiers) présents dans l'arbre filtré, sans doublon. */
export const visibleChantierIds = (tree) => visibleIds(tree, 'chantier', 'Chantiers');
/** Identifiants des projets (table Projects) présents dans l'arbre filtré, sans doublon. */
export const visibleProjectIds = (tree) => visibleIds(tree, 'projet', 'Projects');

const TABLE_OF = Object.freeze({ Tasks: 'tasks', Chantiers: 'chantiers', Projects: 'projects' });

/**
 * Élément d'une liste « à compléter » : titre, niveau (tâche, sous-tâche, chantier, projet), emplacement
 * (projet › chantier › tâche parente) et possibilité d'ouvrir sa fiche (ligne encore présente dans le modèle).
 * @param {object} model
 * @param {{table:'Tasks'|'Chantiers'|'Projects', id:number}} ref
 * @returns {{table:string, id:number, title:string, level:string|null, context:string, openable:boolean}}
 */
export function todoItem(model, ref) {
  const item = model[TABLE_OF[ref.table]]?.get(ref.id);
  const level = item ? detailLevel(model, ref) : null;
  const context = item
    ? breadcrumb(model, ref)
        .filter((c) => c.kind !== 'categorie')
        .map((c) => c.title || label('common.untitled'))
        .join(' › ')
    : '';
  return {
    table: ref.table,
    id: ref.id,
    title: item?.title || label('common.untitled'),
    level,
    context,
    openable: Boolean(level),
  };
}

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
const known = (model, taskIds) => [...new Set(taskIds)].filter((id) => model.tasks.has(id)).sort((a, b) => a - b);

/**
 * Anomalies restreintes aux tâches (et chantiers) visibles, plus « sans dates » et « ISD sans charge » (tâches non
 * terminées). Une tâche aux charges invalides peut figurer à la fois dans « charges illisibles » et « ISD sans charge ».
 * Les types sans élément sont omis.
 * @param {number[]} [chantierIds] chantiers visibles (pour « chantier sans responsable »)
 * @param {number[]} [projectIds] projets visibles (pour « projet sans responsable »)
 * @returns {{kind:string, label:string, taskIds:number[], items:ReturnType<typeof todoItem>[]}[]}
 */
export function dataQuality(model, taskIds, chantierIds = [], projectIds = []) {
  const ids = known(model, taskIds);
  const visible = new Set(ids);
  const by = new Map([...ISSUE_KINDS, ...EXTRA_KINDS].map((k) => [k, new Set()]));
  for (const i of model.issues) if (by.has(i.kind) && visible.has(i.taskId)) by.get(i.kind).add(i.taskId);
  for (const id of ids) {
    const t = model.tasks.get(id);
    if (t.start === null || t.end === null) by.get('sans-dates').add(id);
    if (!t.done && !t.charges.length && taskPeople(model, t).some((p) => p.isd)) by.get('isd-sans-charge').add(id);
  }
  const task = (id) => todoItem(model, { table: 'Tasks', id });
  const rows = [...by]
    .filter(([, set]) => set.size)
    .map(([kind, set]) => {
      const list = [...set].sort((a, b) => a - b);
      return { kind, label: label(`stats.issue.${kind}`), taskIds: list, items: list.map(task) };
    });
  const shown = new Set(chantierIds);
  const bad = model.issues
    .filter((i) => i.kind === CHANTIER_KIND && shown.has(i.chantierId) && model.chantiers.has(i.chantierId))
    .map((i) => todoItem(model, { table: 'Chantiers', id: i.chantierId }));
  if (bad.length)
    rows.push({ kind: CHANTIER_KIND, label: label(`stats.issue.${CHANTIER_KIND}`), taskIds: [], items: bad });
  const projects = [...new Set(projectIds)]
    .filter((id) => model.projects.has(id) && !model.projects.get(id).responsable)
    .sort((a, b) => a - b)
    .map((id) => todoItem(model, { table: 'Projects', id }));
  if (projects.length)
    rows.push({ kind: PROJECT_KIND, label: label(`stats.issue.${PROJECT_KIND}`), taskIds: [], items: projects });
  return rows;
}

/**
 * Répartition des tâches. key : 'status', 'priority' ou 'person' (personnes actives de l'équipe ISD, Management
 * ISD compris ; une tâche compte pour chacune).
 * @returns {{key:string, label:string, value:number}[]} statuts dans l'ordre du modèle, le reste par valeur
 *   décroissante ; key = statut, priorité ('' sans priorité) ou identifiant de la personne (en texte)
 */
export function countBy(model, taskIds, key) {
  const counts = new Map();
  const add = (k, text) => {
    const c = counts.get(k) ?? { key: String(k), label: text, value: 0 };
    c.value++;
    counts.set(k, c);
  };
  for (const id of known(model, taskIds)) {
    const t = model.tasks.get(id);
    if (key === 'status') add(t.status, statusLabel(t.status));
    else if (key === 'priority') {
      const p = taskPriority(model, t);
      add(p, p ? priorityText(p) : label('kanban.noPriority')); // « Priorité 3 », comme le Kanban et le Tableau
    } else for (const p of taskPeople(model, t)) if (p.isdTeam) add(p.id, p.nom);
  }
  const rows = [...counts.entries()];
  if (key === 'status') {
    const order = [...model.statuses.tasks];
    const rank = (k) => (order.includes(k) ? order.indexOf(k) : order.length);
    rows.sort((a, b) => rank(a[0]) - rank(b[0]) || collator.compare(a[1].label, b[1].label));
  } else if (key === 'priority') {
    rows.sort((a, b) => (a[0] === '') - (b[0] === '') || collator.compare(a[1].label, b[1].label));
  } else rows.sort((a, b) => b[1].value - a[1].value || collator.compare(a[1].label, b[1].label));
  return rows.map(([, r]) => r);
}

/** Nombre de mois de la chronologie (mois courant compris). */
export const TIMELINE_MONTHS = 12;

/**
 * Tâches démarrées (dateDebut) et terminées (dateCloture) par mois, sur une fenêtre fixe : les `months` mois qui
 * finissent au mois courant (aucun mois futur). Les dates hors fenêtre sont ignorées ; sans aucune date dans la
 * fenêtre, la chronologie est vide.
 * @param {number} today jour courant
 * @returns {{month:string, started:number, closed:number}[]}
 */
export function timeline(model, taskIds, today, months = TIMELINE_MONTHS) {
  const cur = monthKey(today);
  const y = Number(cur.slice(0, 4));
  const mo = Number(cur.slice(5)) - (months - 1);
  const first = `${y + Math.floor((mo - 1) / 12)}-${String(((((mo - 1) % 12) + 12) % 12) + 1).padStart(2, '0')}`;
  const window = monthsFrom(first, months);
  const inWindow = new Set(window);
  const started = new Map();
  const closed = new Map();
  const bump = (m, d) => {
    if (d === null) return;
    const k = monthKey(d);
    if (inWindow.has(k)) m.set(k, (m.get(k) ?? 0) + 1);
  };
  for (const id of known(model, taskIds)) {
    const t = model.tasks.get(id);
    bump(started, t.start);
    bump(closed, t.closed);
  }
  if (!started.size && !closed.size) return [];
  return window.map((month) => ({ month, started: started.get(month) ?? 0, closed: closed.get(month) ?? 0 }));
}

export const DELAY_BUCKETS = Object.freeze(['early', 'onTime', 'w1', 'w4', 'more']);

/**
 * Délais des tâches clôturées ayant une échéance : date de clôture − échéance (jours, négatif = en avance).
 * @returns {{count:number, mean:number|null, buckets:{key:string, label:string, value:number}[]}}
 */
export function delays(model, taskIds) {
  const diffs = [];
  for (const id of known(model, taskIds)) {
    const t = model.tasks.get(id);
    if (t.end !== null && t.closed !== null) diffs.push(t.closed - t.end);
  }
  const bucket = (d) => (d < 0 ? 'early' : d === 0 ? 'onTime' : d <= 7 ? 'w1' : d <= 30 ? 'w4' : 'more');
  const counts = Object.fromEntries(DELAY_BUCKETS.map((k) => [k, 0]));
  for (const d of diffs) counts[bucket(d)]++;
  return {
    count: diffs.length,
    mean: diffs.length ? diffs.reduce((s, d) => s + d, 0) / diffs.length : null,
    buckets: DELAY_BUCKETS.map((key) => ({ key, label: label(`stats.delay.${key}`), value: counts[key] })),
  };
}

const STATUS_TONES = new Set(['todo', 'inprogress', 'review', 'done']);

/** Couleur d'un statut (familles des badges) : statuts connus, sinon « other ». */
export function statusTone(status) {
  return STATUS_TONES.has(status) ? status : 'other';
}

export const PRIORITY_STEPS = 4;

/**
 * Couleur de chaque ligne de countBy(…, 'priority') : rampe prio-1 (la première priorité triée, la plus urgente)
 * à prio-4 (et au-delà), « none » pour les tâches sans priorité.
 * @param {{key:string}[]} rows
 * @returns {string[]} une couleur par ligne, dans le même ordre
 */
export function priorityTones(rows) {
  let rank = 0;
  return rows.map((r) => (r.key === '' ? 'none' : `prio-${Math.min(++rank, PRIORITY_STEPS)}`));
}

/**
 * Les n premières lignes, et le nombre de lignes masquées.
 * @template T
 * @param {T[]} rows
 * @param {number} n
 * @returns {{shown:T[], hidden:number}}
 */
export function topN(rows, n) {
  return { shown: rows.slice(0, n), hidden: Math.max(0, rows.length - n) };
}

/**
 * Longueur d'une barre en % du maximum (au moins 1 % pour une valeur non nulle, pour qu'elle reste visible).
 * @param {number} value
 * @param {number} max
 */
export function barPercent(value, max) {
  if (!(max > 0) || !(value > 0) || !Number.isFinite(max)) return 0;
  return Math.min(100, Math.max(1, (value / max) * 100));
}

/** Ordre d'affichage de toutes les anomalies de « Données à compléter ». */
export const QUALITY_KINDS = Object.freeze([...ISSUE_KINDS, ...EXTRA_KINDS, CHANTIER_KIND, PROJECT_KIND]);

/**
 * Toutes les lignes de « Données à compléter », y compris celles sans élément (affichées « ✓ »), dans l'ordre
 * de QUALITY_KINDS.
 * @param {ReturnType<typeof dataQuality>} rows résultat de dataQuality
 */
export function qualityRows(rows) {
  const by = new Map(rows.map((r) => [r.kind, r]));
  return QUALITY_KINDS.map(
    (kind) => by.get(kind) ?? { kind, label: label(`stats.issue.${kind}`), taskIds: [], items: [] },
  );
}
