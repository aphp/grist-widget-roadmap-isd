/** Filtres (toutes vues) et préférences locales (navigateur). Voir spec §4.3 et §5. */
import { GROUPS, SORTS } from './kanban-data.js';
import { COLUMNS, DEFAULT_COLUMNS, ROLE_ETP_COLUMNS } from './table-data.js';
import { COLOR_BY, DEFAULT_LEVEL, GANTT_LEVELS, MAX_EXPANDED, SCALES } from './gantt-data.js';
import { PORTFOLIO_MONTHS, PORTFOLIO_TABS } from './portfolio-data.js';
import { dayOfIso, isoOfDay } from './dates.js';
import { normalize } from './text.js';
import { defaultScope, firstChoicePrefs, SCOPES } from './home-view.js';

export { normalize };

export const PREFS_KEY = 'roadmap-isd:prefs';
export const DEFAULT_FILTERS = Object.freeze({
  search: '',
  categorie: '',
  projet: '',
  chantier: '',
  person: null,
  profile: null,
  statuses: [],
  /** Périmètre : « all » (tout), « tasks » (Mes tâches) ou « chantiers » (Mes chantiers) ; sans effet sans « Je suis… ». */
  scope: 'all',
  includeOutOfScope: false,
  /** Filtres repliés sous « + Filtres » : responsable (projet, chantier ou tâche) et demandeur (projet). */
  responsable: null,
  demandeur: '',
});
/** Filtres repliés sous « + Filtres » (comptés à part sur ce bouton). */
export const EXTRA_FILTERS = Object.freeze(['responsable', 'demandeur']);
export const DEFAULT_PREFS = Object.freeze({
  me: null,
  /** Vrai une fois l'invite « Qui êtes-vous ? » traitée (personne choisie ou « Passer ») : elle ne revient plus. */
  mePrompted: false,
  hiddenProjects: [],
  theme: 'auto',
  view: 'kanban',
  /** Vue d'accueil (onglet ouvert au démarrage) ou « last » (dernière vue) ; null tant qu'aucune personne n'a été choisie. */
  homeView: null,
  kanbanGroup: 'status',
  kanbanSort: 'due',
  kanbanCollapsed: [],
  tableColumns: DEFAULT_COLUMNS,
  /**
   * Version du format de tableColumns : 2 = colonnes ETP par profil visibles par défaut ; 3 = ventilation en
   * pastilles dans « ETP », colonnes par profil en option.
   */
  tableColumnsV: 3,
  /** Tri choisi ; null = ordre par défaut (projet, chantier, début). */
  tableSort: null,
  ganttScale: 'month',
  ganttColorBy: 'phase',
  /** Niveau d'ouverture du Gantt (GANTT_LEVELS), ou « custom » : dépliage ligne par ligne (ganttExpanded). */
  ganttLevel: DEFAULT_LEVEL,
  /** Clés des nœuds dépliés, lues seulement si ganttLevel = « custom ». */
  ganttExpanded: null,
  portfolioTab: 'projets',
  /** Début des frises (AAAA-MM-JJ) ; null = premier jour du mois courant. */
  portfolioStart: null,
  portfolioMonths: 12,
  filters: DEFAULT_FILTERS,
});

/**
 * Demandeurs d'un projet : `Projects.Commanditaires` est un texte libre, découpé sur « , », « ; », « & » et les
 * retours à la ligne (« DSN & DST » → DSN, DST). Doublons retirés, accents et casse ignorés.
 * @param {string} text
 * @returns {string[]}
 */
export function splitDemandeurs(text) {
  const out = new Map();
  for (const part of String(text ?? '').split(/[,;&\n]/)) {
    const v = part.trim().replace(/\s+/g, ' ');
    if (v && !out.has(normalize(v))) out.set(normalize(v), v);
  }
  return [...out.values()];
}

const hasDemandeur = (project, wanted) =>
  splitDemandeurs(project?.demandeur).some((d) => normalize(d) === normalize(wanted));

/**
 * Choix d'une personne dans « Je suis… » (invite ou liste de l'en-tête) : la personne est enregistrée, l'invite ne
 * revient plus. Quand on passe de personne à quelqu'un, le périmètre du profil est posé (Mes tâches pour DE, DS,
 * DA ; Mes chantiers pour PO ; tout pour le Management) ; changer de personne garde le périmètre choisi, qui suit
 * la nouvelle personne. Sans personne, le périmètre revient à « Tout ». Au tout premier choix, la vue d'accueil du
 * profil est enregistrée et ouverte (firstChoicePrefs).
 * @param {object} prefs
 * @param {number|null} id
 * @param {object|null} [person] la personne choisie (model.people), pour son profil
 * @returns {object} nouvelles préférences
 */
export function choosePerson(prefs, id, person = null) {
  const me = Number.isFinite(id) ? id : null;
  if (me === null) return { ...prefs, me, mePrompted: true, filters: { ...prefs.filters, scope: 'all' } };
  const scope = prefs.me === null ? defaultScope(person) : prefs.filters.scope;
  return { ...prefs, ...firstChoicePrefs(prefs, person), me, mePrompted: true, filters: { ...prefs.filters, scope } };
}

/** Invite « Qui êtes-vous ? » : seulement tant qu'aucune personne n'est enregistrée et qu'elle n'a pas été passée. */
export function shouldPromptMe(prefs) {
  return prefs.me === null && prefs.mePrompted !== true;
}

function involved(task) {
  return new Set([...task.assignees, task.responsable, ...task.charges.map((c) => c.personId)].filter(Boolean));
}

/** Vrai si la personne est responsable ou contributrice du chantier (Chantiers.Responsable, Chantiers.Contributeurs). */
const onChantier = (c, id) => Boolean(c) && (c.responsable === id || c.contributeurs.includes(id));

/** Vrai si la personne est responsable, sponsor ou contributrice clé du projet (Projects). */
const onProject = (p, id) =>
  Boolean(p) && (p.responsable === id || p.sponsor.includes(id) || p.contributeursCles.includes(id));

/** Personnes ciblées par le périmètre (Mes tâches, Mes chantiers) et le filtre Personne. */
const targetOf = (f, prefs) => [f.scope !== 'all' ? prefs.me : null, f.person].filter(Boolean);

/** Vrai si le projet est proposé : non masqué, et dans le périmètre ISD sauf case « hors périmètre » cochée. */
function projetShown(model, p, f, hidden, who = []) {
  if (hidden.has(p.projectId)) return false;
  if (f.includeOutOfScope || model.projects.get(p.projectId)?.inScope === true) return true;
  return who.length > 0 && projectInvolves(model, p, who);
}

/**
 * Vrai si une des personnes est responsable, sponsor ou contributrice clé du projet, responsable ou
 * contributrice d'un de ses chantiers, ou assignée, responsable ou chargée sur une de ses tâches. Garde visible
 * un projet hors périmètre ISD (aucune personne active de l'équipe ISD) quand on cible une personne.
 */
function projectInvolves(model, node, who) {
  if (node.ref?.table === 'Projects' && who.some((id) => onProject(model.projects.get(node.ref.id), id))) return true;
  if (node.ref?.table === 'Chantiers' && who.some((id) => onChantier(model.chantiers.get(node.ref.id), id)))
    return true;
  if (node.taskId) {
    const t = model.tasks.get(node.taskId);
    return t ? who.some((id) => involved(t).has(id)) : false;
  }
  return node.children.some((c) => projectInvolves(model, c, who));
}

/**
 * Prédicat « ce nœud chantier correspond au chantier choisi » : même ligne Chantiers (un chantier partagé est
 * retenu sous chacun de ses projets) ; un chantier virtuel « (sans chantier) » ne correspond qu'à lui-même.
 */
function chantierMatcher(model, key) {
  const sel = model.nodes.get(key);
  if (!sel?.ref) return (c) => c.key === key;
  return (c) => c.ref?.table === sel.ref.table && c.ref.id === sel.ref.id;
}

/**
 * Arbre filtré (catégorie → projet → chantier → tâche → sous-tâche) et tâches retenues.
 * @returns {{tree:object[], taskIds:Set<number>}}
 */
export function applyFilters(model, f, prefs) {
  const q = normalize(f.search);
  const me = f.scope === 'tasks' ? prefs.me : null;
  // Mes chantiers : chantiers dont la personne est responsable ou contributrice, avec toutes leurs tâches, et
  // projets dont elle est responsable, sponsor ou contributrice clé, avec tous leurs chantiers (même sans tâche)
  const myChantiers = f.scope === 'chantiers' && prefs.me ? prefs.me : null;
  const chantierMine = myChantiers
    ? (c) => c.ref?.table === 'Chantiers' && onChantier(model.chantiers.get(c.ref.id), myChantiers)
    : null;
  const mine = (p) => {
    if (onProject(model.projects.get(p.projectId), myChantiers)) return p;
    const children = p.children.filter(chantierMine);
    return children.length ? { ...p, children } : null;
  };
  const hidden = new Set(prefs.hiddenProjects);
  const taskIds = new Set();
  const target = targetOf(f, prefs);
  const taskLevel = Boolean(f.person || f.profile || f.statuses.length || me || f.responsable);
  const chantierOk = f.chantier ? chantierMatcher(model, f.chantier) : null;

  const taskOk = (task, respHit) => {
    if (f.responsable && !respHit) return false;
    const who = involved(task);
    if (f.person && !who.has(f.person)) return false;
    if (f.profile && ![...who].some((id) => model.people.get(id)?.isd && model.people.get(id).role === f.profile))
      return false;
    if (me && !who.has(me)) return false;
    if (f.statuses.length && !f.statuses.includes(task.status)) return false;
    return true;
  };
  // Responsable : le projet, le chantier ou la tâche (ou un de leurs ancêtres) a ce responsable
  const isResp = (n) => {
    if (!f.responsable) return false;
    if (n.taskId) return model.tasks.get(n.taskId)?.responsable === f.responsable;
    if (n.ref?.table === 'Projects') return model.projects.get(n.ref.id)?.responsable === f.responsable;
    return n.ref?.table === 'Chantiers' && model.chantiers.get(n.ref.id)?.responsable === f.responsable;
  };
  // Recherche : le nœud ou un de ses ancêtres contient le texte
  const prune = (n, ancestorHit, ancestorResp = false) => {
    const hit = ancestorHit || (q !== '' && normalize(n.title).includes(q));
    const resp = ancestorResp || isResp(n);
    const kids = n.children.map((c) => prune(c, hit, resp)).filter(Boolean);
    let keep = kids.length > 0;
    if (n.taskId) {
      const ok = taskOk(model.tasks.get(n.taskId), resp) && (q === '' || hit);
      if (ok) taskIds.add(n.taskId);
      keep = keep || ok;
    } else if (!taskLevel && (q === '' || hit)) {
      keep = true;
    }
    return keep ? { ...n, children: kids } : null;
  };
  // La recherche voit aussi les titres de la catégorie et du projet
  const catHit = (cat) => q !== '' && normalize(cat.title).includes(q);

  const tree = model.tree
    .filter((cat) => !f.categorie || cat.key === f.categorie)
    .map((cat) => {
      const projets = cat.children
        .filter((p) => !f.projet || p.key === f.projet)
        .filter((p) => projetShown(model, p, f, hidden, target))
        .filter((p) => !f.demandeur || hasDemandeur(model.projects.get(p.projectId), f.demandeur))
        .map((p) => (chantierOk ? { ...p, children: p.children.filter(chantierOk) } : p))
        .filter((p) => !chantierOk || p.children.length)
        .map((p) => (chantierMine ? mine(p) : p))
        .filter(Boolean)
        .map((p) => prune(p, catHit(cat)))
        .filter(Boolean);
      return projets.length ? { ...cat, children: projets } : null;
    })
    .filter(Boolean);
  return { tree, taskIds };
}

/**
 * Choix des listes Catégorie, Projet (selon la catégorie) et Chantier (selon le projet, sinon la catégorie),
 * limités aux projets proposés (périmètre ISD sauf case cochée, hors projets masqués).
 * @returns {{categories:object[], projets:{group:object, items:object[]}[], chantiers:{group:object, items:object[]}[]}}
 */
export function filterChoices(model, f, prefs) {
  const hidden = new Set(prefs.hiddenProjects);
  const projets = model.tree
    .filter((cat) => !f.categorie || cat.key === f.categorie)
    .map((cat) => ({
      group: cat,
      items: cat.children.filter((p) => projetShown(model, p, f, hidden, targetOf(f, prefs))),
    }))
    .filter((g) => g.items.length);
  const chantiers = projets
    .flatMap((g) => g.items)
    .filter((p) => !f.projet || p.key === f.projet)
    .map((p) => ({ group: p, items: p.children.filter((c) => c.kind === 'chantier') }))
    .filter((g) => g.items.length);
  return { categories: model.tree, projets, chantiers, ...extraChoices(model, projets) };
}

/**
 * Choix de « + Filtres » parmi les projets proposés : responsables de projet, de chantier ou de tâche (personnes connues, par
 * nom) et demandeurs (texte des projets, découpé par splitDemandeurs), dans l'ordre alphabétique.
 */
function extraChoices(model, projetGroups) {
  const projectIds = new Set(projetGroups.flatMap((g) => g.items.map((p) => p.projectId)));
  const respIds = new Set();
  for (const id of projectIds) {
    const r = model.projects.get(id)?.responsable;
    if (r) respIds.add(r);
  }
  for (const c of model.chantiers.values())
    if (c.responsable && c.projectIds.some((id) => projectIds.has(id))) respIds.add(c.responsable);
  for (const t of model.tasks.values()) {
    const pid = t.projectId ?? model.chantiers.get(t.chantierId)?.projectIds[0] ?? null;
    if (t.responsable && (pid === null || projectIds.has(pid))) respIds.add(t.responsable);
  }
  const responsables = [...respIds]
    .map((id) => model.people.get(id))
    .filter(Boolean)
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr', { sensitivity: 'base' }));
  const dem = new Map();
  for (const id of projectIds)
    for (const d of splitDemandeurs(model.projects.get(id)?.demandeur))
      if (!dem.has(normalize(d))) dem.set(normalize(d), d);
  const demandeurs = [...dem.values()].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  return { responsables, demandeurs };
}

/**
 * Filtres cohérents avec le modèle : une catégorie, un projet ou un chantier inconnu, d'un autre niveau, ou hors
 * du niveau choisi au-dessus, est retiré (préférence ancienne, donnée supprimée, choix en cascade).
 * @returns {object} les mêmes filtres s'il n'y a rien à retirer, sinon une copie corrigée
 */
export function validFilters(model, f) {
  const at = (key, kind) => {
    const n = key ? model.nodes.get(key) : null;
    return n?.kind === kind ? n : null;
  };
  const cat = at(f.categorie, 'categorie');
  // Ancienne famille d'un produit de données (« F:<titre du projet> », devenue « C:<titre> ») sans projet ni
  // chantier choisi : c'était un projet, retrouvé par son titre
  if (!cat && f.categorie?.startsWith('C:') && !f.projet && !f.chantier) {
    const title = f.categorie.slice(2);
    const p = [...model.nodes.values()].find((n) => n.kind === 'projet' && n.title === title);
    if (p) return { ...f, categorie: '', projet: p.key };
  }
  const projet = at(f.projet, 'projet');
  const projetOk = projet && (!cat || projet.parentKey === cat.key);
  const ch = at(f.chantier, 'chantier');
  const chOk =
    ch && (projetOk ? ch.parentKey === projet.key : !cat || model.nodes.get(ch.parentKey)?.parentKey === cat.key);
  const respOk = f.responsable === null || f.responsable === undefined || model.people.has(f.responsable);
  const demOk = !f.demandeur || [...model.projects.values()].some((p) => hasDemandeur(p, f.demandeur));
  const out = {
    ...f,
    categorie: cat ? f.categorie : '',
    projet: projetOk ? f.projet : '',
    chantier: chOk ? f.chantier : '',
    ...(respOk ? {} : { responsable: null }),
    ...(demOk ? {} : { demandeur: '' }),
  };
  return out.categorie === f.categorie && out.projet === f.projet && out.chantier === f.chantier && respOk && demOk
    ? f
    : out;
}

export function activeFilterChips(f, model) {
  const chips = [];
  const node = (field) => chips.push({ field, label: model.nodes.get(f[field])?.title ?? f[field] });
  if (f.search) chips.push({ field: 'search', label: `« ${f.search} »` });
  if (f.categorie) node('categorie');
  if (f.projet) node('projet');
  if (f.chantier) node('chantier');
  if (f.person) chips.push({ field: 'person', label: model.people.get(f.person)?.nom ?? String(f.person) });
  if (f.profile) chips.push({ field: 'profile', label: f.profile });
  if (f.responsable)
    chips.push({ field: 'responsable', label: model.people.get(f.responsable)?.nom ?? String(f.responsable) });
  if (f.demandeur) chips.push({ field: 'demandeur', label: f.demandeur });
  if (f.statuses.length) chips.push({ field: 'statuses', label: f.statuses.join(', ') });
  if (f.scope === 'tasks') chips.push({ field: 'scope', label: 'Mes tâches' });
  if (f.scope === 'chantiers') chips.push({ field: 'scope', label: 'Mes chantiers' });
  if (f.includeOutOfScope) chips.push({ field: 'includeOutOfScope', label: 'Hors périmètre ISD inclus' });
  return chips;
}

const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
const textOr = (v, d) => (typeof v === 'string' ? v : d);
const idOrNull = (v) => (Number.isFinite(v) ? v : null);
const PROFILES = ['DE', 'DA', 'DS', 'PO'];

/** Anciennes clés de colonnes (avant le vocabulaire de la Feuille) → nouvelles clés. */
const RENAMED_COLUMNS = Object.freeze({ family: ['categorie'], product: ['projet'], task: ['tache', 'sousTache'] });

/** Colonnes visibles par défaut avant la version 3 (toutes sauf « ETP autre ») : un choix jamais personnalisé. */
const LEGACY_DEFAULT = Object.freeze([
  'categorie',
  'projet',
  'chantier',
  'tache',
  'sousTache',
  'status',
  'start',
  'end',
  'people',
  'etp',
  'etpPO',
  'etpDA',
  'etpDS',
  'etpDE',
  'priority',
  'requester',
]);

/**
 * Colonnes visibles : sous-ensemble connu (dans l'ordre du tableau), « Tâche » toujours comprise (elle porte le
 * bouton qui ouvre la fiche) ; sans colonne connue, les colonnes par défaut.
 * Enregistrement antérieur à la version 3 : l'ancien défaut (jamais personnalisé) devient le nouveau défaut ;
 * sinon, les quatre colonnes ETP par profil, si elles sont toutes là, sont retirées (la colonne « ETP » montre
 * la ventilation) et le reste du choix est conservé.
 */
function sanitizeColumns(saved, version) {
  if (!Array.isArray(saved)) return [...DEFAULT_COLUMNS];
  let v = saved.flatMap((c) => RENAMED_COLUMNS[c] ?? [c]).filter((c) => COLUMNS.includes(c));
  if (!v.length) return [...DEFAULT_COLUMNS];
  if (version !== 3) {
    if (LEGACY_DEFAULT.every((c) => v.includes(c))) return [...DEFAULT_COLUMNS];
    if (ROLE_ETP_COLUMNS.every((c) => v.includes(c))) v = v.filter((c) => !ROLE_ETP_COLUMNS.includes(c));
  }
  return COLUMNS.filter((c) => c === 'tache' || v.includes(c));
}

/** Tri du tableau : { key, dir } sur une colonne connue, sinon aucun (ordre de la hiérarchie). */
function sanitizeSort(v) {
  const key = isObject(v) ? (RENAMED_COLUMNS[v.key]?.[0] ?? v.key) : null;
  return COLUMNS.includes(key) ? { key, dir: v.dir === 'desc' ? 'desc' : 'asc' } : null;
}

/** Date AAAA-MM-JJ existante, sinon null. */
function isoDateOrNull(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = dayOfIso(v);
  return Number.isFinite(d) && isoOfDay(d) === v ? v : null;
}

/**
 * Dépliage du Gantt : liste de clés bornée. Les clés de l'ancien niveau « famille » (« F:X ») deviennent celles
 * de la catégorie de même titre (« C:X »), sans doublon ; une clé qui ne désigne plus rien est sans effet.
 */
function sanitizeExpanded(v) {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return null;
  const keys = [...new Set(v.map((k) => (k.startsWith('F:') ? `C:${k.slice(2)}` : k)))];
  return keys.slice(0, MAX_EXPANDED);
}

/** Anciens sous-onglets du portfolio → nouveaux. */
const RENAMED_TABS = Object.freeze({ products: 'projets', tasks: 'taches' });

/**
 * Anciens filtres « famille » et « produit » (avant le vocabulaire de la Feuille) : la famille devient la catégorie
 * de même titre ; un produit « P<id> » était un projet, un produit « P<id>/C<id> » (produit de données) un chantier.
 * Une clé qui ne correspond plus à rien est retirée par validFilters une fois le modèle chargé.
 */
function legacyFilters(f) {
  const fam = typeof f.family === 'string' && f.family.startsWith('F:') ? `C:${f.family.slice(2)}` : '';
  const prod = typeof f.product === 'string' ? f.product : '';
  return {
    categorie: fam,
    projet: /^P\d+$/.test(prod) ? prod : '',
    chantier: /^P\d+\/C\d+$/.test(prod) ? prod : '',
  };
}

/** Ramène chaque champ à son type attendu : une préférence corrompue ne doit jamais faire planter le widget. */
function sanitizePrefs(saved) {
  const s = isObject(saved) ? saved : {};
  const f = isObject(s.filters) ? s.filters : {};
  const legacy = legacyFilters(f);
  const tab = RENAMED_TABS[s.portfolioTab] ?? s.portfolioTab;
  return {
    me: idOrNull(s.me),
    // Préférences d'avant l'invite : une personne déjà enregistrée vaut réponse
    mePrompted: s.mePrompted === true || idOrNull(s.me) !== null,
    hiddenProjects:
      Array.isArray(s.hiddenProjects) && s.hiddenProjects.every((x) => Number.isFinite(x)) ? [...s.hiddenProjects] : [],
    theme: textOr(s.theme, DEFAULT_PREFS.theme),
    view: textOr(s.view, DEFAULT_PREFS.view),
    // Validée contre les onglets par sanitizeHomeView (main.js)
    homeView: textOr(s.homeView, null),
    kanbanGroup: GROUPS.includes(s.kanbanGroup) ? s.kanbanGroup : DEFAULT_PREFS.kanbanGroup,
    kanbanSort: SORTS.includes(s.kanbanSort) ? s.kanbanSort : DEFAULT_PREFS.kanbanSort,
    kanbanCollapsed:
      Array.isArray(s.kanbanCollapsed) && s.kanbanCollapsed.every((x) => typeof x === 'string')
        ? [...s.kanbanCollapsed]
        : [],
    tableColumns: sanitizeColumns(s.tableColumns, s.tableColumnsV),
    tableColumnsV: 3,
    tableSort: sanitizeSort(s.tableSort),
    ganttScale: SCALES.includes(s.ganttScale) ? s.ganttScale : DEFAULT_PREFS.ganttScale,
    ganttColorBy: COLOR_BY.includes(s.ganttColorBy) ? s.ganttColorBy : DEFAULT_PREFS.ganttColorBy,
    ganttLevel:
      GANTT_LEVELS.includes(s.ganttLevel) || s.ganttLevel === 'custom' ? s.ganttLevel : DEFAULT_PREFS.ganttLevel,
    ganttExpanded: sanitizeExpanded(s.ganttExpanded),
    portfolioTab: PORTFOLIO_TABS.includes(tab) ? tab : DEFAULT_PREFS.portfolioTab,
    portfolioStart: isoDateOrNull(s.portfolioStart),
    portfolioMonths: PORTFOLIO_MONTHS.includes(s.portfolioMonths) ? s.portfolioMonths : DEFAULT_PREFS.portfolioMonths,
    filters: {
      search: textOr(f.search, ''),
      categorie: textOr(f.categorie, legacy.categorie),
      projet: textOr(f.projet, legacy.projet),
      chantier: textOr(f.chantier, legacy.chantier),
      person: idOrNull(f.person),
      profile: PROFILES.includes(f.profile) ? f.profile : null,
      statuses: Array.isArray(f.statuses) && f.statuses.every((x) => typeof x === 'string') ? [...f.statuses] : [],
      // Ancienne case « Mes chantiers » (mine), qui filtrait en fait les tâches : devient « Mes tâches »
      scope: SCOPES.includes(f.scope) ? f.scope : f.mine === true ? 'tasks' : 'all',
      includeOutOfScope: f.includeOutOfScope === true,
      responsable: idOrNull(f.responsable),
      demandeur: textOr(f.demandeur, '').trim(),
    },
  };
}

export function loadPrefs(storage) {
  try {
    return sanitizePrefs(JSON.parse(storage.getItem(PREFS_KEY) || '{}'));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(storage, prefs) {
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* navigation privée ou stockage bloqué : préférences non conservées */
  }
}
