/** Gantt : lignes de l'arbre, échelles de temps, géométrie des barres, étapes et retards. Fonctions pures (spec §5). */
import { DAY_MS, MONTHS_FR, formatDateFr, isoOfDay, weekday } from './dates.js';
import { normalize } from './text.js';
import { label } from '../labels.js';

export const SCALES = Object.freeze(['week', 'month', 'year', '2y']);
export const COLOR_BY = Object.freeze(['phase', 'status']);
export const PHASES = Object.freeze(['instruction', 'realisation', 'mep']);
/** Statuts colorés en mode « statut » ; tout autre statut prend la couleur neutre « autre ». */
export const STATUS_COLORS = Object.freeze(['todo', 'inprogress', 'review', 'done']);

const WEEKS = 12;
/** Nombre maximal de nœuds dépliés mémorisés dans le navigateur. */
export const MAX_EXPANDED = 2000;

/**
 * Dépliage à enregistrer : seulement les clés encore dépliables (nœuds existants ayant des enfants), bornées.
 * @param {Iterable<string>} expanded
 * @param {Set<string>} validKeys
 * @returns {string[]}
 */
export function prunedExpanded(expanded, validKeys) {
  return [...expanded].filter((k) => validKeys.has(k)).slice(0, MAX_EXPANDED);
}

/**
 * Étape d'un élément, détectée sur son titre (accents et casse ignorés).
 * « MEP » ou « mise en production » l'emportent : « Préparation de la réalisation MEP » est une préparation MEP.
 * @param {string|null|undefined} title
 * @returns {'instruction'|'realisation'|'mep'|null}
 */
export function phaseOf(title) {
  const t = normalize(title);
  if (!t) return null;
  if (/\bmep\b|mise en prod/.test(t)) return 'mep';
  if (/\binstruction/.test(t)) return 'instruction';
  if (/\brealisation/.test(t)) return 'realisation';
  return null;
}

/**
 * Lignes visibles : chaque nœud, puis ses enfants s'il est déplié.
 * @param {object[]} tree arbre filtré (catégories)
 * @param {Set<string>} expandedKeys
 * @returns {{key:string, depth:number, node:object, hasChildren:boolean, expanded:boolean}[]}
 */
export function ganttRows(tree, expandedKeys) {
  const out = [];
  const walk = (n, depth, posinset, setsize) => {
    const hasChildren = n.children.length > 0;
    const expanded = hasChildren && expandedKeys.has(n.key);
    out.push({ key: n.key, depth, node: n, hasChildren, expanded, posinset, setsize });
    if (expanded) n.children.forEach((c, i) => walk(c, depth + 1, i + 1, n.children.length));
  };
  tree.forEach((f, i) => walk(f, 0, i + 1, tree.length));
  return out;
}

/** Niveaux d'affichage du Gantt : le plus profond niveau visible (les niveaux au-dessus sont dépliés). */
export const GANTT_LEVELS = Object.freeze(['projet', 'chantier', 'tache', 'sous-tache']);
/** Niveau d'ouverture par défaut ; « custom » = dépliage choisi ligne par ligne (mémorisé à part). */
export const DEFAULT_LEVEL = 'chantier';

/**
 * Largeur de la colonne des noms (px), réglable à la poignée et au curseur « Largeur des noms » : bornes, pas au
 * clavier (Maj : grand pas), part maximale de la largeur de la vue. Sans réglage, largeur par défaut de la
 * largeur d'écran (identique au CSS : 320 px, 256 px sous 1280 px).
 */
export const LABEL_WIDTH = Object.freeze({ min: 160, step: 16, bigStep: 64, maxShare: 0.6, wide: 320, medium: 256 });
/** Borne absolue (px) d'une largeur enregistrée, quel que soit l'écran. */
const LABEL_WIDTH_CAP = 4000;

/** Largeur par défaut de la colonne des noms pour une fenêtre de cette largeur. */
export function defaultLabelWidth(windowWidth) {
  return windowWidth > 0 && windowWidth < 1280 ? LABEL_WIDTH.medium : LABEL_WIDTH.wide;
}

/** Largeur posée sur la grille des pas (minimum + n × pas), comme le curseur de type range. */
const onStep = (w) => LABEL_WIDTH.min + Math.round((w - LABEL_WIDTH.min) / LABEL_WIDTH.step) * LABEL_WIDTH.step;

/**
 * Largeur maximale de la colonne des noms : 60 % de la vue, ramenée au pas inférieur (jamais sous le minimum ;
 * vue inconnue : borne absolue).
 */
export function labelWidthMax(viewWidth) {
  const cap = viewWidth > 0 ? viewWidth * LABEL_WIDTH.maxShare : LABEL_WIDTH_CAP;
  return LABEL_WIDTH.min + Math.max(0, Math.floor((cap - LABEL_WIDTH.min) / LABEL_WIDTH.step)) * LABEL_WIDTH.step;
}

/** Largeur bornée et posée sur le pas (px) ; une valeur illisible donne fallback (par défaut 320 px). */
export function clampLabelWidth(width, viewWidth, fallback = LABEL_WIDTH.wide) {
  const w = Number.isFinite(width) ? width : fallback;
  return Math.min(labelWidthMax(viewWidth), Math.max(LABEL_WIDTH.min, onStep(w)));
}

/**
 * Largeur après une touche sur la poignée : ←/↓ et →/↑ d'un pas (Maj : grand pas), Début / Fin aux bornes ;
 * null pour une autre touche.
 */
export function labelWidthAfterKey(width, key, shift, viewWidth) {
  const step = shift ? LABEL_WIDTH.bigStep : LABEL_WIDTH.step;
  if (key === 'ArrowLeft' || key === 'ArrowDown') return clampLabelWidth(width - step, viewWidth);
  if (key === 'ArrowRight' || key === 'ArrowUp') return clampLabelWidth(width + step, viewWidth);
  if (key === 'Home') return LABEL_WIDTH.min;
  if (key === 'End') return labelWidthMax(viewWidth);
  return null;
}

/** Préférence enregistrée : entier entre le minimum et la borne absolue, sinon null (largeur par défaut). */
export function sanitizeLabelWidth(value) {
  return Number.isFinite(value) && value >= LABEL_WIDTH.min && value <= LABEL_WIDTH_CAP ? Math.round(value) : null;
}
const KIND_RANK = Object.freeze({ categorie: 0, projet: 1, chantier: 2, tache: 3, 'sous-tache': 4 });
const LEVEL_RANK = Object.freeze({ projet: 1, chantier: 2, tache: 3, 'sous-tache': Infinity });

/**
 * Clés à déplier pour afficher l'arbre jusqu'à un niveau : « chantier » ouvre catégories et projets,
 * « sous-tache » ouvre tout (sous-tâches imbriquées comprises).
 * @param {object[]} tree
 * @param {string} level un des GANTT_LEVELS (inconnu → niveau par défaut)
 * @returns {string[]}
 */
export function levelExpanded(tree, level) {
  const max = LEVEL_RANK[level] ?? LEVEL_RANK[DEFAULT_LEVEL];
  const out = [];
  const walk = (n) => {
    if (!n.children.length || (KIND_RANK[n.kind] ?? 4) >= max) return;
    out.push(n.key);
    n.children.forEach(walk);
  };
  tree.forEach(walk);
  return out;
}

const CHRONO_KINDS = new Set(['tache', 'sous-tache']);

/**
 * Liste chronologique (petits écrans) : tâches et sous-tâches dont la période croise la fenêtre, triées par
 * début, échéance puis titre, avec leur chemin (projet, chantier) et la géométrie de leur barre.
 * @param {object[]} tree arbre filtré
 * @param {{start:number, end:number, days:number}} scale
 * @returns {{key:string, node:object, bar:{start:number,end:number,deduced:boolean}, path:string[], geometry:object}[]}
 */
export function chronoItems(tree, scale) {
  const out = [];
  const walk = (n, path) => {
    if (CHRONO_KINDS.has(n.kind)) {
      const bar = nodeBar(n);
      if (bar) {
        const geometry = barGeometry(scale, bar.start, bar.end);
        if (!geometry.outside) out.push({ key: n.key, node: n, bar, path, geometry });
      }
    }
    const next = n.kind === 'projet' || n.kind === 'chantier' ? [...path, n.title] : path;
    n.children.forEach((c) => walk(c, next));
  };
  tree.forEach((f) => walk(f, []));
  return out.sort(
    (a, b) =>
      a.bar.start - b.bar.start ||
      a.bar.end - b.bar.end ||
      String(a.node.title ?? '').localeCompare(String(b.node.title ?? ''), 'fr'),
  );
}

/** Clés de tous les nœuds ayant des enfants (pour « Tout déplier »). */
export function expandableKeys(tree) {
  const out = [];
  const walk = (n) => {
    if (n.children.length) out.push(n.key);
    n.children.forEach(walk);
  };
  tree.forEach(walk);
  return out;
}

// ---------- Dates ----------
const ymd = (day) => {
  const x = new Date(day * DAY_MS);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate() };
};
const dayOfYmd = (y, m, d = 1) => Date.UTC(y, m, d) / DAY_MS;
const mondayOf = (day) => day - ((weekday(day) + 6) % 7);

/** Semaine ISO 8601 d'un jour. */
export function isoWeek(day) {
  const thursday = mondayOf(day) + 3;
  const year = ymd(thursday).y;
  return { year, week: Math.floor((thursday - dayOfYmd(year, 0, 1)) / 7) + 1 };
}

const ORDINAL = ['1er', '2e', '3e', '4e'];

/** Groupes de l'en-tête (mois ou années) découpés sur la fenêtre. */
function groupsOf(start, end, unit) {
  const groups = [];
  for (let s = start; s <= end; ) {
    const { y, m } = ymd(s);
    const next = unit === 'year' ? dayOfYmd(y + 1, 0) : dayOfYmd(y, m + 1);
    const e = Math.min(next - 1, end);
    groups.push({ label: unit === 'year' ? String(y) : `${MONTHS_FR[m]} ${y}`, start: s, end: e });
    s = e + 1;
  }
  return groups;
}

function months(y, m, count) {
  return Array.from({ length: count }, (_, i) => {
    const start = dayOfYmd(y, m + i);
    const { y: yy, m: mm } = ymd(start);
    return { label: MONTHS_FR[mm], title: `${MONTHS_FR[mm]} ${yy}`, start, end: dayOfYmd(y, m + i + 1) - 1 };
  });
}

/**
 * Fenêtre de temps d'une échelle.
 * - semaine : 12 semaines ISO depuis le lundi de l'ancre ; en-tête groupé par mois ;
 * - mois : 6 mois depuis le mois de l'ancre ; année : janvier à décembre ; 2 ans : 8 trimestres. En-tête groupé par année.
 * @param {'week'|'month'|'year'|'2y'} mode échelle (inconnue → « mois »)
 * @param {number} anchorDay
 * @returns {{mode:string, start:number, end:number, days:number, columns:{label:string,title:string,start:number,end:number}[], groups:{label:string,start:number,end:number}[]}}
 */
export function timeScale(mode, anchorDay) {
  const m = SCALES.includes(mode) ? mode : 'month';
  const { y, m: mo } = ymd(anchorDay);
  let columns;
  if (m === 'week') {
    const first = mondayOf(anchorDay);
    columns = Array.from({ length: WEEKS }, (_, i) => {
      const start = first + 7 * i;
      const { week } = isoWeek(start);
      return {
        label: `S${week}`,
        title: label('gantt.week.title', { n: week, debut: formatDateFr(start), fin: formatDateFr(start + 6) }),
        start,
        end: start + 6,
      };
    });
  } else if (m === 'month') columns = months(y, mo, 6);
  else if (m === 'year') columns = months(y, 0, 12);
  else
    columns = Array.from({ length: 8 }, (_, i) => {
      const yy = y + Math.floor(i / 4);
      const q = i % 4;
      return {
        label: `T${q + 1}`,
        title: label('gantt.quarter.title', { n: ORDINAL[q], annee: yy }),
        start: dayOfYmd(yy, q * 3),
        end: dayOfYmd(yy, q * 3 + 3) - 1,
      };
    });
  const start = columns[0].start;
  const end = columns.at(-1).end;
  return {
    mode: m,
    start,
    end,
    days: end - start + 1,
    columns,
    groups: groupsOf(start, end, m === 'week' ? 'month' : 'year'),
  };
}

/** Ancre normalisée au début de la fenêtre de l'échelle. */
function normalizeAnchor(mode, day) {
  const { y, m } = ymd(day);
  if (mode === 'week') return mondayOf(day);
  if (mode === 'year' || mode === '2y') return dayOfYmd(y, 0);
  return dayOfYmd(y, m);
}

/**
 * Ancre après « précédent » (dir = -1) ou « suivant » (dir = 1) : 4 semaines, 3 mois ou 1 an selon l'échelle.
 * @returns {number}
 */
export function shiftAnchor(mode, anchor, dir) {
  const a = normalizeAnchor(mode, anchor);
  if (mode === 'week') return a + 28 * dir;
  const { y, m } = ymd(a);
  if (mode === 'year' || mode === '2y') return dayOfYmd(y + dir, 0);
  return dayOfYmd(y, m + 3 * dir);
}

/** Ancre de « aujourd'hui » : un peu de passé reste visible (2 semaines, 1 mois, ou le début de l'année). */
export function todayAnchor(mode, today) {
  if (mode === 'week') return mondayOf(today - 14);
  if (mode === 'month') {
    const { y, m } = ymd(today);
    return dayOfYmd(y, m - 1);
  }
  return normalizeAnchor(mode, today);
}

/** Position (en % de la fenêtre) du début d'un jour. */
export function pctOf(scale, day) {
  return ((day - scale.start) / scale.days) * 100;
}

/**
 * Géométrie d'une barre du jour `start` au jour `end` inclus, en % de la fenêtre.
 * @returns {{left:number, width:number, clipStart:boolean, clipEnd:boolean}|{outside:'before'|'after'}}
 */
export function barGeometry(scale, start, end) {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  if (b < scale.start) return { outside: 'before' };
  if (a > scale.end) return { outside: 'after' };
  const s = Math.max(a, scale.start);
  const e = Math.min(b, scale.end);
  return {
    left: pctOf(scale, s),
    width: ((e - s + 1) / scale.days) * 100,
    clipStart: a < scale.start,
    clipEnd: b > scale.end,
  };
}

/**
 * Période d'un nœud : ses dates propres si les deux existent, sinon son étendue (`span`, « période déduite »).
 * @returns {{start:number, end:number, deduced:boolean}|null}
 */
export function nodeBar(node) {
  if (node.start !== null && node.start !== undefined && node.end !== null && node.end !== undefined)
    return { start: Math.min(node.start, node.end), end: Math.max(node.start, node.end), deduced: false };
  if (node.span)
    return {
      start: Math.min(node.span.start, node.span.end),
      end: Math.max(node.span.start, node.span.end),
      deduced: true,
    };
  return null;
}

/**
 * Projet ou chantier sans tâche dans l'arbre affiché (« Aucune tâche ») : visible dans le Gantt quand il est
 * retenu (périmètre, Mes chantiers), alors que les vues centrées sur les tâches l'ignorent.
 */
export function isEmptyContainer(node) {
  return (node.kind === 'projet' || node.kind === 'chantier') && node.children.length === 0;
}

/** Tâche en retard : échéance passée (avant aujourd'hui) et non terminée. Les autres niveaux ne sont jamais en retard. */
export function isLate(model, node, today) {
  const task = node.taskId ? model.tasks.get(node.taskId) : null;
  return Boolean(task && task.end !== null && task.end < today && !task.done);
}

/** Jalon : tâche de type « jalon ». */
export function isMilestone(model, node) {
  return Boolean(node.taskId && model.tasks.get(node.taskId)?.type === 'jalon');
}

/**
 * Clé de couleur d'un nœud : étape (instruction, realisation, mep) ou statut connu ; sinon « other ».
 * @param {object} node
 * @param {'phase'|'status'} colorBy
 */
export function colorKey(node, colorBy) {
  if (colorBy === 'status') return STATUS_COLORS.includes(node.status) ? node.status : 'other';
  return phaseOf(node.title) ?? 'other';
}

/** Nom du fichier PDF d'une vue pour un jour du modèle. */
export const pdfFilenameOfDay = (vue, day) => `roadmap-isd-${vue}-${isoOfDay(day)}.pdf`;
