/** Kanban : regroupement, tri, ETP et chemin des cartes. Fonctions pures (spec §4.4). */
import { fteHours, hoursToEtp } from './capacity.js';
import { NO_CHANTIER } from './model.js';
import { inIsdTeam, isdDomain } from './team-directory.js';
import { normalize } from './text.js';
import { label, statusLabel } from '../labels.js';

export const GROUPS = Object.freeze(['status', 'priority', 'chantier']);
export const SORTS = Object.freeze(['title-asc', 'title-desc', 'due']);

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
const byTitle = (model) => (a, b) => collator.compare(model.tasks.get(a).title, model.tasks.get(b).title);

/** ETP total de la tâche = Σ heures ÷ heures de 1 ETP sur sa période (fteHours) ; null sans période exploitable. */
export function taskEtp(task) {
  const fte = fteHours(task.start, task.end);
  if (!fte) return null;
  const hours = task.charges.reduce((s, c) => s + c.heures, 0);
  return hoursToEtp(hours, fte);
}

/** Profils ISD ventilés (ordre d'affichage) ; le reste est regroupé sous « Autre ». */
export const ETP_ROLES = Object.freeze(['PO', 'DA', 'DS', 'DE']);
/** Ventilation de l'ETP d'une tâche (ordre d'affichage) : profils ISD, Management de l'équipe ISD, puis « Autre ». */
export const ETP_SPLIT = Object.freeze([...ETP_ROLES, 'Mgmt', 'Autre']);

/**
 * Profils de l'équipe ISD (filtre Profil, charge et capacité par profil, plan de charge) : profils ISD, puis
 * Management de l'équipe ISD (« Mgmt »).
 */
export const PROFILE_KEYS = Object.freeze([...ETP_ROLES, 'Mgmt']);

/**
 * Clé de la ventilation d'une personne : profil ISD, « Mgmt » (Management de l'équipe ISD), sinon « Autre ».
 * Un Management ISD inactif reste « Mgmt » (sans contrôle de actif, contrairement à profileKey) : les charges
 * sont historiques, une personne partie garde la part qu'elle portait sur ses tâches.
 */
export function etpRoleKey(person, model) {
  if (person?.isd && ETP_ROLES.includes(person.role)) return person.role;
  if (person?.roleText === 'Management' && inIsdTeam(person, isdDomain(model))) return 'Mgmt';
  return 'Autre';
}

/** Profil d'une personne active de l'équipe ISD (PO, DA, DS, DE ou Mgmt) ; null sinon (inactive, hors ISD, sans rôle). */
export function profileKey(person, model) {
  if (!person?.isdTeam) return null;
  const key = etpRoleKey(person, model);
  return key === 'Autre' ? null : key;
}

/**
 * ETP total et par profil (même formule que taskEtp, charge par charge). Une charge appartient à la personne
 * (teamId) : son rôle ISD donne le profil ; hors ISD ou sans rôle, elle compte dans le total et dans « Autre » ; le Management de l'équipe ISD
 * (rôle Management, Domaine ISD) compte dans « Mgmt », celui des autres domaines dans « Autre ».
 * @returns {{total:number, PO:number, DA:number, DS:number, DE:number, Mgmt:number, Autre:number}|null} null sans
 *   période exploitable (dates absentes, inversées ou sans jour ouvré)
 */
export function taskEtpByRole(task, model) {
  const fte = fteHours(task.start, task.end);
  if (!fte) return null;
  const out = { total: 0, PO: 0, DA: 0, DS: 0, DE: 0, Mgmt: 0, Autre: 0 };
  for (const c of task.charges) {
    const person = model.people.get(c.personId);
    const key = etpRoleKey(person, model);
    const etp = hoursToEtp(c.heures, fte);
    out[key] += etp;
    out.total += etp;
  }
  return out;
}

const etpFormat = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const ZERO = etpFormat.format(0);

/**
 * Parts de la ventilation à afficher (PO, DA, DS, DE, Mgmt puis Autre), valeur à une décimale ; une part qui
 * s'afficherait « 0,0 » n'apporte rien et est omise.
 * @param {{PO:number, DA:number, DS:number, DE:number, Mgmt:number, Autre:number}|null} byRole résultat de taskEtpByRole
 * @returns {{key:string, text:string}[]}
 */
export function etpRoleParts(byRole) {
  if (!byRole) return [];
  return ETP_SPLIT.map((key) => ({ key, text: etpFormat.format(byRole[key] ?? 0) })).filter((p) => p.text !== ZERO);
}

/** Identifiant du chantier d'une tâche (hérité du parent si absent), ou null. */
function chantierIdOf(model, task) {
  for (let t = task, i = 0; t && i < 20; t = model.tasks.get(t.parentId), i++) if (t.chantierId) return t.chantierId;
  return null;
}

/**
 * Liste unique des personnes d'une tâche (bloc « Personnes ») : assignés dans leur ordre, puis personnes ayant une
 * charge sans être assignées ; heures cumulées par personne (null sans charge), ETP sur la période de la tâche
 * (fteHours ; null sans charge ou sans période). person : objet du modèle, ou null pour une personne absente de l'équipe.
 * @returns {{personId:number, person:object|null, assigned:boolean, hours:number|null, etp:number|null}[]}
 */
export function taskPeopleRows(model, task) {
  const fte = fteHours(task.start, task.end);
  const hours = new Map();
  for (const c of task.charges) hours.set(c.personId, (hours.get(c.personId) ?? 0) + c.heures);
  const assigned = new Set(task.assignees);
  return [...new Set([...task.assignees, ...hours.keys()])].map((personId) => {
    const h = hours.has(personId) ? Math.round(hours.get(personId) * 1e6) / 1e6 : null;
    return {
      personId,
      person: model.people.get(personId) ?? null,
      assigned: assigned.has(personId),
      hours: h,
      etp: h !== null && fte ? hoursToEtp(h, fte) : null,
    };
  });
}

/** Personnes d'une tâche : assignés puis personnes ayant une charge, sans doublon (objets du modèle). */
export function taskPeople(model, task) {
  return taskPeopleRows(model, task)
    .filter((r) => r.person)
    .map((r) => r.person);
}

/**
 * Libellé unique d'une priorité, dans toutes les vues : « Priorité 3 ». Une valeur déjà libellée (« Priorité 1 »)
 * est gardée telle quelle, « P3 » devient « Priorité 3 ». Chaîne vide sans priorité.
 * @param {unknown} value valeur brute de la Feuille
 * @returns {string}
 */
export function priorityText(value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (normalize(v).startsWith('priorite')) return v;
  const p = /^p\s*(\d+)$/i.exec(v);
  return label('priority.value', { valeur: p ? p[1] : v });
}

/** Priorité : celle de la tâche, sinon du chantier, sinon du projet ; chaîne vide si aucune. */
export function taskPriority(model, task) {
  const ch = model.chantiers.get(chantierIdOf(model, task));
  return task.priorite || ch?.priorite || model.projects.get(task.projectId)?.priorite || '';
}

/**
 * Premier nœud de chaque tâche dans l'arbre (un chantier partagé n'est compté qu'une fois) et le chemin de ses
 * ancêtres sans la catégorie : projet › chantier (› tâche pour une sous-tâche).
 */
export function taskPaths(tree) {
  const out = new Map();
  const walk = (n, path) => {
    if (n.taskId && !out.has(n.taskId)) out.set(n.taskId, { node: n, path });
    const next = n.kind === 'categorie' ? path : [...path, n.title];
    n.children.forEach((c) => walk(c, next));
  };
  tree.forEach((f) => walk(f, []));
  return out;
}

/**
 * Ordre du cycle de vie des statuts dans le Kanban (clés de la Feuille, comparées sans accents ni casse) ; les
 * statuts absents de cette liste suivent dans leur ordre d'origine, « Sans statut » toujours en dernier.
 */
export const STATUS_LIFECYCLE = Object.freeze([
  'Pré-cadrage',
  'Cadrage',
  'todo',
  'inprogress',
  'review',
  'En attente externe',
  'Bloqué',
  'done',
]);
const LIFECYCLE_RANK = new Map(STATUS_LIFECYCLE.map((s, i) => [normalize(s), i]));

/**
 * Statuts triés selon le cycle de vie (tri stable pour les autres).
 * @param {string[]} statuses
 * @returns {string[]}
 */
export function lifecycleOrder(statuses) {
  const rank = (s) => (s ? (LIFECYCLE_RANK.get(normalize(s)) ?? STATUS_LIFECYCLE.length) : Infinity);
  return statuses
    .map((s, i) => ({ s, i, r: rank(s) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.s);
}

/**
 * Colonne repliée ? Une colonne vide l'est par défaut ; `saved` (préférence kanbanCollapsed) contient les colonnes
 * repliées à la main (« clé ») et les colonnes vides dépliées à la main (« +clé »).
 * @param {string[]} saved
 * @param {string} key clé de colonne (« groupe:valeur »)
 * @param {boolean} empty
 */
export function isColumnCollapsed(saved, key, empty) {
  if (saved.includes(key)) return true;
  return empty && !saved.includes(`+${key}`);
}

/**
 * Bascule une colonne et renvoie la nouvelle préférence (n'enregistre que l'écart à l'état par défaut).
 * @param {string[]} saved
 * @param {string} key
 * @param {boolean} empty
 * @returns {string[]}
 */
export function toggleColumn(saved, key, empty) {
  const rest = saved.filter((k) => k !== key && k !== `+${key}`);
  if (isColumnCollapsed(saved, key, empty)) return empty ? [...rest, `+${key}`] : rest;
  return empty ? rest : [...rest, key];
}

/**
 * Focus itinérant du plateau : position suivante pour une touche, ou null si la touche ne déplace rien.
 * @param {number[]} counts nombre de cartes affichées par colonne (0 : colonne vide ou repliée, sautée)
 * @param {{col:number, row:number}} pos position courante
 * @param {string} key ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home ou End
 * @returns {{col:number, row:number}|null}
 */
export function rovingMove(counts, pos, key) {
  const { col, row } = pos;
  const n = counts[col] ?? 0;
  if (key === 'ArrowDown') return row + 1 < n ? { col, row: row + 1 } : null;
  if (key === 'ArrowUp') return row > 0 ? { col, row: row - 1 } : null;
  if (key === 'Home') return n && row !== 0 ? { col, row: 0 } : null;
  if (key === 'End') return n && row !== n - 1 ? { col, row: n - 1 } : null;
  const step = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
  if (!step) return null;
  for (let c = col + step; c >= 0 && c < counts.length; c += step)
    if (counts[c] > 0) return { col: c, row: Math.min(row, counts[c] - 1) };
  return null;
}

/** Initiale suivie d'un point (« C. ») ; vide sans lettre. */
const initialOf = (word) => {
  const ch = [...(word ?? '')][0];
  return ch ? `${ch.toLocaleUpperCase('fr-FR')}.` : '';
};
/** « GERMAIN » ou « le gall » → « Germain », « Le Gall » (tirets et apostrophes conservés). */
const titleCase = (s) =>
  s.toLocaleLowerCase('fr-FR').replace(/(^|[\s'’-])(\p{L})/gu, (m, a, b) => a + b.toLocaleUpperCase('fr-FR'));
const isUpperWord = (w) => /\p{L}{2}/u.test(w) && w === w.toLocaleUpperCase('fr-FR');

/**
 * Nom court d'une personne, « Nom P. » : le nom de famille est la partie en capitales (« Caroline GERMAIN » →
 * « Germain C. »), sinon le dernier mot (« Caroline Germain » → « Germain C. »). Un seul mot reste tel quel.
 * @param {string} nom
 * @returns {string}
 */
export function shortName(nom) {
  const words = String(nom ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 2) return words[0] ?? '';
  const upper = words.filter(isUpperWord);
  const family = upper.length && upper.length < words.length ? upper : [words.at(-1)];
  const given = words.filter((w) => !family.includes(w));
  return `${titleCase(family.join(' '))} ${initialOf(given[0])}`.trim();
}

/** Au-delà de ce nombre de personnes, la carte passe aux initiales. */
export const NAMED_PEOPLE = 2;
/** Initiales affichées avant « +n ». */
export const MAX_INITIALS = 3;

/**
 * Présentation des personnes d'une carte : noms courts pour une ou deux personnes, sinon initiales des trois
 * premières et le nombre restant.
 * @template T
 * @param {T[]} people
 * @returns {{named:boolean, shown:T[], more:number}}
 */
export function peopleDisplay(people) {
  if (people.length <= NAMED_PEOPLE) return { named: true, shown: people, more: 0 };
  const shown = people.slice(0, MAX_INITIALS);
  return { named: false, shown, more: people.length - shown.length };
}

function sorter(model, sort) {
  const title = byTitle(model);
  if (sort === 'title-desc') return (a, b) => title(b, a);
  if (sort === 'due')
    return (a, b) => {
      const x = model.tasks.get(a).end;
      const y = model.tasks.get(b).end;
      if (x === y) return title(a, b);
      if (x === null) return 1;
      if (y === null) return -1;
      return x - y;
    };
  return title;
}

/**
 * @param {object} model
 * @param {Iterable<number>} taskIds
 * @param {'status'|'priority'|'chantier'} groupBy
 * @param {'title-asc'|'title-desc'|'due'} sort
 * @returns {{key: string, label: string, tasks: number[]}[]}
 */
export function kanbanColumns(model, taskIds, groupBy, sort) {
  const ids = [...new Set(taskIds)].filter((id) => model.tasks.has(id));
  const cmp = sorter(model, sort);
  const cols = new Map();
  const col = (key, text) => {
    if (!cols.has(key)) cols.set(key, { key, label: text, tasks: [] });
    return cols.get(key);
  };
  const last = [];

  if (groupBy === 'status') {
    const observed = ids.map((id) => model.tasks.get(id).status);
    for (const s of lifecycleOrder([...new Set([...model.statuses.tasks, ...observed])])) col(s, statusLabel(s));
    for (const id of ids) {
      const s = model.tasks.get(id).status;
      col(s, statusLabel(s)).tasks.push(id);
    }
  } else if (groupBy === 'priority') {
    for (const id of ids) {
      // Regroupement sur le libellé : « 1 », « P1 » et « Priorité 1 » forment une seule colonne « Priorité 1 »
      const p = priorityText(taskPriority(model, model.tasks.get(id)));
      col(p, p || label('kanban.noPriority')).tasks.push(id);
    }
    if (cols.has('')) last.push(['', cols.get('')]);
  } else {
    for (const id of ids) {
      const cid = chantierIdOf(model, model.tasks.get(id));
      const ch = model.chantiers.get(cid);
      col(cid ? `C${cid}` : '', ch ? ch.title || label('common.untitled') : NO_CHANTIER).tasks.push(id);
    }
    if (cols.has('')) last.push(['', cols.get('')]);
  }

  let out = [...cols.values()];
  if (groupBy !== 'status') {
    const tail = last.map(([, c]) => c);
    out = out.filter((c) => !tail.includes(c)).sort((a, b) => collator.compare(a.label, b.label));
    out.push(...tail);
  }
  for (const c of out) c.tasks.sort(cmp);
  return out;
}
