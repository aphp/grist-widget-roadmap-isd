/**
 * Vue Tableau : une ligne par tâche (sous-tâches comprises), tri, export CSV. Fonctions pures (spec §4.4).
 * La hiérarchie projet → chantier se lit dans le Gantt ; le tableau est une liste à plat, triée par défaut par
 * projet, chantier puis date de début, et triable sur toute colonne.
 */
import { formatDateFr, isoOfDay } from './dates.js';
import { ETP_SPLIT, taskEtp, taskEtpByRole, taskPaths, taskPeopleRows, taskPriority } from './kanban-data.js';
import { declaredTags } from './tags-edit.js';
import { displayRole } from './team-directory.js';
import { label, statusLabel } from '../labels.js';

/** Colonnes, dans l'ordre d'affichage (« Sous-tâche » ne sert qu'à l'export CSV). */
export const COLUMNS = Object.freeze([
  'tache',
  'chantier',
  'projet',
  'status',
  'priority',
  'people',
  'start',
  'end',
  'etp',
  'etpPO',
  'etpDA',
  'etpDS',
  'etpDE',
  'etpMgmt',
  'etpOther',
  'categorie',
  'requester',
  'tags',
  'sousTache',
]);

/** Colonnes ETP par profil (clé de colonne → clé de taskEtpByRole). « ETP Mgmt » : Management de l'équipe ISD ;
 * « ETP autre » : personnes hors ISD et Management des autres domaines. */
const ROLE_COLUMNS = Object.freeze({
  etpPO: 'PO',
  etpDA: 'DA',
  etpDS: 'DS',
  etpDE: 'DE',
  etpMgmt: 'Mgmt',
  etpOther: 'Autre',
});
/** Colonnes ETP par profil : la colonne « ETP » montre déjà la ventilation en pastilles, elles restent en option. */
export const ROLE_ETP_COLUMNS = Object.freeze(['etpPO', 'etpDA', 'etpDS', 'etpDE']);
/** Hiérarchie complète, toujours exportée en tête du CSV. */
export const HIERARCHY_COLUMNS = Object.freeze(['categorie', 'projet', 'chantier', 'tache', 'sousTache']);
/**
 * Colonnes proposées dans le sélecteur : toutes sauf « Tâche » (toujours affichée, elle porte le bouton qui ouvre
 * la fiche) et « Sous-tâche » (une sous-tâche est une ligne à part entière, marquée « ↳ »).
 */
export const DISPLAY_COLUMNS = Object.freeze(COLUMNS.filter((c) => c !== 'tache' && c !== 'sousTache'));
/** Colonnes visibles par défaut (Catégorie, Demandeur, Tags et ETP par profil : via le menu Colonnes). */
export const DEFAULT_COLUMNS = Object.freeze([
  'tache',
  'chantier',
  'projet',
  'status',
  'priority',
  'people',
  'start',
  'end',
  'etp',
]);

/** Colonnes triées par valeur numérique (absence toujours en dernier). */
const NUMERIC = new Set(['start', 'end', 'etp', ...Object.keys(ROLE_COLUMNS)]);
/** Séparateur des sous-tâches intermédiaires. */
const SEP = ' › ';
const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
const etpFormat = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** ETP à une décimale (« 0,6 »). */
export const formatEtp = (n) => etpFormat.format(n);

/** Remonte les nœuds ancêtres de l'arbre (le plus proche d'abord). */
function ancestors(model, node) {
  const out = [];
  for (let k = node.parentKey, i = 0; k && i < 20; i++) {
    const n = model.nodes.get(k);
    if (!n) break;
    out.push(n);
    k = n.parentKey;
  }
  return out;
}

/** Rang de priorité (1 = la plus urgente) : premier chiffre du texte, borné de 1 à 4 ; null sans chiffre. */
export function priorityRank(text) {
  const m = /\d+/.exec(String(text ?? ''));
  return m ? Math.min(4, Math.max(1, Number(m[0]))) : null;
}

/** Initiales d'une personne : première lettre du premier et du dernier mot ; « ? » sans nom. */
export function personInitials(nom) {
  const words = String(nom ?? '')
    .split(/[\s-]+/)
    .filter(Boolean);
  if (!words.length) return '?';
  const first = [...words[0]][0];
  const last = words.length > 1 ? [...words.at(-1)][0] : '';
  return `${first}${last}`.toLocaleUpperCase('fr-FR');
}

/** Ligne d'une tâche placée au nœud `node` de l'arbre. */
function rowOf(model, node, task) {
  const title = (n) => n?.title || label('common.untitled');
  const byRole = taskEtpByRole(task, model);
  const path = [...ancestors(model, node).reverse(), node];
  const at = (kind) => path.find((n) => n.kind === kind);
  const people = taskPeopleRows(model, task).filter((r) => r.person);
  const declared = declaredTags(model, 'Tasks');
  return {
    taskId: task.id,
    key: node.key,
    categorie: at('categorie')?.title ?? '',
    projet: at('projet') ? title(at('projet')) : '',
    chantier: at('chantier') ? title(at('chantier')) : '',
    tache: at('tache') ? title(at('tache')) : '',
    sousTache: path
      .filter((n) => n.kind === 'sous-tache')
      .map(title)
      .join(SEP),
    level: node.kind,
    own: title(node),
    parents: path
      .filter((n) => n.kind === 'sous-tache' && n !== node)
      .map(title)
      .join(SEP),
    status: task.status,
    start: task.start,
    end: task.end,
    people: people.map((r) => r.person.nom).join(', '),
    persons: people.map((r) => ({
      nom: r.person.nom,
      role: displayRole(model, r.person),
      assigned: r.assigned,
      etp: r.etp,
    })),
    etp: taskEtp(task) || null,
    byRole,
    ...Object.fromEntries(Object.entries(ROLE_COLUMNS).map(([col, role]) => [col, byRole?.[role] || null])),
    priority: taskPriority(model, task),
    milestone: task.type === 'jalon',
    requester: model.projects.get(task.projectId)?.demandeur ?? '',
    tags: (task.tags ?? []).join(', '),
    tagItems: (task.tags ?? []).map((value) => ({ value, declared: declared.includes(value) })),
  };
}

/**
 * Une ligne par tâche retenue par les filtres, dans l'ordre de la hiérarchie, à sa place dans l'arbre (spec §4.2) :
 * catégorie, projet, chantier, tâche (premier niveau), sous-tâche (vide pour une tâche ; pour une sous-tâche
 * profonde, les sous-tâches intermédiaires précèdent son titre, séparées par « › »). Un chantier partagé
 * n'apparaît que sous son premier projet.
 * `level` est le niveau de la ligne ('tache' ou 'sous-tache'), `own` son propre titre et `parents` les sous-tâches
 * intermédiaires (affichage seulement) ; `persons`, `byRole` et `milestone` servent aux pictogrammes.
 */
export function tableRows(model, view) {
  const rows = [];
  for (const [taskId, { node }] of taskPaths(view.tree)) {
    if (!view.taskIds.has(taskId)) continue;
    const task = model.tasks.get(taskId);
    if (task) rows.push(rowOf(model, node, task));
  }
  return rows;
}

/** Tâche en retard : échéance passée et statut autre que « Terminé ». */
export const isLate = (r, today) => r.end !== null && r.end !== undefined && r.end < today && r.status !== 'done';

/** Colonnes du CSV : la hiérarchie complète, puis les colonnes de données visibles (une ligne par tâche). */
export function csvColumns(visible) {
  return [...HIERARCHY_COLUMNS, ...COLUMNS.filter((c) => !HIERARCHY_COLUMNS.includes(c) && visible.includes(c))];
}

/** Valeur de tri d'une cellule : le libellé affiché pour le statut, le nombre pour les dates et les ETP. */
const sortValue = (r, key) => (key === 'status' ? statusLabel(r.status) : r[key]);

const empty = (v) => v === null || v === undefined || v === '';

/** Comparateur de lignes sur une colonne (0 à égalité) ; les valeurs absentes restent en fin, quel que soit le sens. */
function rowComparator(key, dir) {
  const sign = dir === 'desc' ? -1 : 1;
  const numeric = NUMERIC.has(key);
  return (a, b) => {
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    if (empty(x) || empty(y)) return empty(x) && empty(y) ? 0 : empty(x) ? 1 : -1;
    return (numeric ? x - y : collator.compare(x, y)) * sign;
  };
}

const byProjet = rowComparator('projet', 'asc');
const byChantier = rowComparator('chantier', 'asc');
const byStart = rowComparator('start', 'asc');

/**
 * Ordre par défaut : projet, puis chantier, puis date de début (sans date en dernier) ; à égalité, l'ordre de la
 * hiérarchie (une sous-tâche sans date suit sa tâche).
 */
export function defaultOrder(rows) {
  return rows
    .map((r, i) => [r, i])
    .sort(([a, i], [b, j]) => byProjet(a, b) || byChantier(a, b) || byStart(a, b) || i - j)
    .map(([r]) => r);
}

/**
 * Tâche parente d'une ligne de sous-tâche (dernière sous-tâche intermédiaire, sinon la tâche) ; chaîne vide
 * pour une tâche.
 */
export const parentTitle = (r) => (r.level === 'sous-tache' ? r.parents.split(SEP).at(-1) || r.tache : '');

/** Copie triée (ou les mêmes lignes si aucune colonne). Les valeurs absentes restent en fin, quel que soit le sens. */
export function sortRows(rows, key, dir = 'asc') {
  if (!COLUMNS.includes(key)) return rows;
  const compare = rowComparator(key, dir);
  return rows
    .map((r, i) => [r, i])
    .sort(([a, i], [b, j]) => compare(a, b) || i - j)
    .map(([r]) => r);
}

/** Pagination du Tableau : lignes rendues d'emblée, puis à chaque « Afficher plus » (P-PERF-2). */
export const TABLE_PAGE = 100;

/**
 * Tranche affichée d'un Tableau paginé : les `limit` premières lignes (tri déjà appliqué sur toutes les lignes).
 * `rest` = lignes non affichées ; `next` = lignes qu'ajouterait « Afficher plus » ; `total` = toutes les lignes
 * (compteur, export CSV). Une limite absente, négative ou non numérique vaut une page.
 * @template T
 * @param {T[]} rows
 * @param {number} [limit]
 * @param {number} [page]
 * @returns {{shown:T[], total:number, rest:number, next:number}}
 */
export function pageRows(rows, limit = TABLE_PAGE, page = TABLE_PAGE) {
  const max = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : page;
  const shown = rows.length > max ? rows.slice(0, max) : rows;
  const rest = rows.length - shown.length;
  return { shown, total: rows.length, rest, next: Math.min(rest, page) };
}

/**
 * Limite après « Afficher plus » : une page de plus, sans dépasser le total (aucune limite fantôme au-delà).
 * @param {number} limit limite actuelle
 * @param {number} total nombre de lignes
 * @param {number} [page]
 */
export const nextLimit = (limit, total, page = TABLE_PAGE) => Math.min(Math.max(limit, 0) + page, Math.max(total, 0));

/** Ordre des pastilles de la colonne « Équipe (ETP) » : profils ISD, Mgmt, puis « Autre ». */
export const ETP_PART_ORDER = ETP_SPLIT;

/**
 * Colonne « Équipe (ETP) » : pastilles par profil (ordre PO, DA, DS, DE, Mgmt, Autre ; profils nuls ou arrondis à zéro
 * omis) et total. Le total suit l'affichage de cellText (le tri reste sur le nombre r.etp).
 * @returns {{parts:{role:string, text:string}[], total:string}|null} null si la tâche n'a pas d'ETP
 */
export function etpParts(r) {
  if (r.etp === null || r.etp === undefined) return null;
  const zero = etpFormat.format(0);
  const parts = r.byRole
    ? ETP_PART_ORDER.map((role) => ({ role, text: etpFormat.format(r.byRole[role] ?? 0) })).filter(
        (p) => p.text !== zero,
      )
    : [];
  return { parts, total: etpFormat.format(r.etp) };
}

/** Jour du modèle au format JJ/MM/AAAA (lisible par les tableurs français). */
const slashDate = (d) => isoOfDay(d).split('-').reverse().join('/');

/** Texte d'une cellule : affichage (« 26 oct. 2026 ») ou CSV (« 26/10/2026 »). */
export function cellText(r, key, csv = false) {
  switch (key) {
    case 'status':
      return statusLabel(r.status);
    case 'start':
    case 'end':
      return r[key] === null ? '' : csv ? slashDate(r[key]) : formatDateFr(r[key]);
    case 'etp':
    case 'etpPO':
    case 'etpDA':
    case 'etpDS':
    case 'etpDE':
    case 'etpMgmt':
    case 'etpOther':
      return r[key] === null ? '' : etpFormat.format(r[key]);
    default:
      return String(r[key] ?? '');
  }
}

/** Début de cellule interprétable comme formule : après espaces, tabulations, retours, un de = + - @ (ou pleine chasse). */
const FORMULA = /^[\s]*[=+\-@＝＋－＠]|^[\t\r\n]/;
/** Colonnes dont la valeur est produite par le widget (nombre, date) : jamais préfixées, un ETP négatif reste un nombre. */
const GENERATED = new Set(['start', 'end', 'etp', ...Object.keys(ROLE_COLUMNS)]);

/** Cellule CSV : guillemets doublés, entourée si nécessaire ; les colonnes de texte pouvant commencer comme une formule sont préfixées d'une apostrophe. */
function csvCell(text, guard = true) {
  const safe = guard && FORMULA.test(text) ? `'${text}` : text;
  return /[;"\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const BOM = String.fromCharCode(0xfeff);

/** CSV (séparateur « ; », fin de ligne CRLF, BOM UTF-8 en tête pour Excel) des colonnes demandées. */
export function toCsv(rows, columns) {
  const cols = columns.filter((c) => COLUMNS.includes(c));
  const lines = [cols.map((c) => csvCell(label(`table.col.${c}`), false)).join(';')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(cellText(r, c, true), !GENERATED.has(c))).join(';'));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** Nom du fichier exporté pour un jour ISO (AAAA-MM-JJ). */
export const csvFilename = (iso) => `roadmap-isd-${iso}.csv`;

/** Nom du fichier pour un jour du modèle. */
export const csvFilenameOfDay = (day) => csvFilename(isoOfDay(day));
