/** Filtres (toutes vues) et préférences locales (navigateur). Voir spec §4.3 et §5. */
import { GROUPS, PROFILE_KEYS, SORTS, profileKey } from './kanban-data.js';
import { COLUMNS, DEFAULT_COLUMNS, ROLE_ETP_COLUMNS } from './table-data.js';
import { COLOR_BY, DEFAULT_LEVEL, GANTT_LEVELS, MAX_EXPANDED, SCALES, sanitizeLabelWidth } from './gantt-data.js';
import { normalize } from './text.js';
import { chantierInvolvesIsd, projectInvolvesIsd, taskInvolvesIsd } from './model.js';
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
  /** Périmètre : « all » (tout) ou « chantiers » (Mes chantiers) ; sans effet sans « Je suis… ». */
  scope: 'all',
  includeOutOfScope: false,
  /** Masque les chantiers et les tâches où personne de l'équipe ISD n'intervient (dans les projets affichés). */
  isdOnly: false,
  /**
   * Filtres repliés sous « + Filtres » : responsable (projet, chantier ou tâche), demandeur (projet) et tag (de la
   * tâche ou de son chantier).
   */
  responsable: null,
  demandeur: '',
  tag: '',
});
/** Filtres repliés sous « + Filtres » (comptés à part sur ce bouton). */
export const EXTRA_FILTERS = Object.freeze(['responsable', 'demandeur', 'tag']);
export const DEFAULT_PREFS = Object.freeze({
  me: null,
  /** Vrai une fois l'invite « Qui êtes-vous ? » traitée (personne choisie ou « Passer ») : elle ne revient plus. */
  mePrompted: false,
  hiddenProjects: [],
  theme: 'auto',
  view: 'gantt',
  /** Vue d'accueil choisie dans les Préférences (onglet) ; null ou « last » : le Gantt. */
  homeView: null,
  /** Version de la vue d'accueil : sans ce marqueur, la valeur enregistrée est abandonnée une fois (arrivée sur le Gantt). */
  homeViewV: 2,
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
  ganttColorBy: 'chantier',
  /** Version de ganttColorBy : 2 = depuis le mode « chantier » (avant, « phase » enregistré n'était pas un choix). */
  ganttColorByV: 2,
  /** Niveau d'ouverture du Gantt (GANTT_LEVELS), ou « custom » : dépliage ligne par ligne (ganttExpanded). */
  ganttLevel: DEFAULT_LEVEL,
  /** Clés des nœuds dépliés, lues seulement si ganttLevel = « custom ». */
  ganttExpanded: null,
  /** Largeur de la colonne des noms du Gantt (px) ; null = largeur par défaut (préférences d'avant : absente). */
  ganttLabelWidth: null,
  /** Carte « Contrôle qualité des données » des Statistiques dépliée (repliée par défaut). */
  statsQualityOpen: false,
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
 * revient plus. Quand on passe de personne à quelqu'un, le périmètre du profil est posé (Mes chantiers pour DE, DS,
 * DA et PO ; tout pour le Management) ; changer de personne garde le périmètre choisi, qui suit
 * la nouvelle personne. Sans personne, le périmètre revient à « Tout ». Au tout premier choix, seul le niveau du Gantt du PO
 * est posé (firstChoicePrefs).
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

/** Personnes ciblées par le périmètre (Mes chantiers) et le filtre Personne. */
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

/** Chantier virtuel « (sans chantier) » d'un projet (nœud chantier sans ligne Chantiers). */
const isLooseChantier = (n) => n.kind === 'chantier' && !n.ref;

/**
 * Prédicat « Mes chantiers » d'une personne :
 * - nœud d'un chantier (ligne Chantiers) dont elle est responsable ou contributrice (quel que soit l'état de ses
 *   tâches), ou qui porte au moins une tâche non terminée où elle est assignée, responsable ou chargée ; un
 *   chantier partagé est retenu sous chacun de ses projets ;
 * - chantier virtuel « (sans chantier) » d'un projet s'il porte une de ses tâches (seules ses tâches y sont
 *   ensuite gardées, voir applyFilters) : passer à « Mes chantiers » ne masque jamais une de ses tâches.
 */
function myChantierMatcher(model, me) {
  const viaTasks = new Set();
  for (const t of model.tasks.values()) if (t.chantierId && !t.done && involved(t).has(me)) viaTasks.add(t.chantierId);
  const mine = (id) => {
    const t = model.tasks.get(id);
    return Boolean(t) && involved(t).has(me);
  };
  const hasMine = (n) => (n.taskId ? mine(n.taskId) : false) || n.children.some(hasMine);
  return (c) =>
    isLooseChantier(c)
      ? hasMine(c)
      : c.ref?.table === 'Chantiers' && (viaTasks.has(c.ref.id) || onChantier(model.chantiers.get(c.ref.id), me));
}

/**
 * Mémorise, pour une application des filtres, les tâches qui impliquent l'ISD (règle partagée du modèle) :
 * chaque tâche n'est évaluée qu'une fois, que ce soit pour l'élagage de l'arbre ou pour les tâches retenues.
 */
function isdTaskTester(model) {
  const memo = new Map();
  return (taskId) => {
    if (!memo.has(taskId)) memo.set(taskId, taskInvolvesIsd(model.tasks.get(taskId), model.people));
    return memo.get(taskId);
  };
}

/**
 * « ISD seulement » : élague un projet de l'arbre. Une tâche ou sous-tâche reste si elle implique l'ISD ou si un de
 * ses descendants l'implique (le parent garde l'arbre) ; un chantier reste s'il garde une tâche ou si son
 * responsable ou un contributeur est de l'équipe ISD (alors éventuellement vide) ; « (sans chantier) » suit ses
 * tâches ; le projet reste s'il garde un chantier ou s'il est porté par l'ISD par lui-même (sans tâche).
 * @returns {object|null} le projet élagué, ou null s'il ne reste rien
 */
function isdOnlyProject(model, project, involvesIsd) {
  const task = (n) => {
    const children = n.children.map(task).filter(Boolean);
    return involvesIsd(n.taskId) || children.length ? { ...n, children } : null;
  };
  const chantier = (n) => {
    const children = n.children.map(task).filter(Boolean);
    const row = n.ref?.table === 'Chantiers' ? model.chantiers.get(n.ref.id) : null;
    return children.length || (row && chantierInvolvesIsd(row, model.people)) ? { ...n, children } : null;
  };
  const children = project.children.map(chantier).filter(Boolean);
  const own = projectInvolvesIsd(model.projects.get(project.projectId), model.people);
  return children.length || own ? { ...project, children } : null;
}

/**
 * Arbre filtré (catégorie → projet → chantier → tâche → sous-tâche) et tâches retenues.
 * @returns {{tree:object[], taskIds:Set<number>}}
 */
export function applyFilters(model, f, prefs) {
  const q = normalize(f.search);
  // Mes chantiers : chantiers dont la personne est responsable ou contributrice, ou dont une tâche en cours
  // l'implique (assignée, responsable ou chargée), avec toutes leurs tâches ; sous « (sans chantier) », ses seules
  // tâches. Projet dont elle est responsable, sponsor ou contributrice clé : tous ses chantiers et toutes ses
  // tâches, même sans tâche
  const me = f.scope === 'chantiers' && prefs.me ? prefs.me : null;
  const chantierMine = me ? myChantierMatcher(model, me) : null;
  const projectMine = (p) => Boolean(me) && onProject(model.projects.get(p.projectId), me);
  const mine = (p) => {
    if (projectMine(p)) return p;
    const children = p.children.filter(chantierMine);
    return children.length ? { ...p, children } : null;
  };
  const hidden = new Set(prefs.hiddenProjects);
  const taskIds = new Set();
  const target = targetOf(f, prefs);
  const taskLevel = Boolean(f.person || f.profile || f.statuses.length || f.responsable || f.tag);
  const chantierOk = f.chantier ? chantierMatcher(model, f.chantier) : null;

  const involvesIsd = f.isdOnly ? isdTaskTester(model) : null;
  const taskOk = (task, respHit, onlyMine, tagHit) => {
    if (involvesIsd && !involvesIsd(task.id)) return false;
    if (f.responsable && !respHit) return false;
    if (f.tag && !tagHit) return false;
    const who = involved(task);
    if (onlyMine && !who.has(me)) return false;
    if (f.person && !who.has(f.person)) return false;
    if (f.profile && ![...who].some((id) => profileKey(model.people.get(id), model) === f.profile)) return false;
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
  // Tag : la tâche, une tâche parente ou son chantier porte ce tag (les deux listes de tags sont distinctes)
  const hasTag = (n) => {
    if (!f.tag) return false;
    if (n.taskId) return Boolean(model.tasks.get(n.taskId)?.tags?.includes(f.tag));
    return n.ref?.table === 'Chantiers' && Boolean(model.chantiers.get(n.ref.id)?.tags?.includes(f.tag));
  };
  // Recherche : le nœud ou un de ses ancêtres contient le texte
  // Mes chantiers : sous « (sans chantier) », seules les tâches de la personne (onlyMine)
  const prune = (
    n,
    ancestorHit,
    ancestorResp = false,
    ancestorMine = false,
    ancestorTag = false,
    wholeProject = false,
  ) => {
    const hit = ancestorHit || (q !== '' && normalize(n.title).includes(q));
    const resp = ancestorResp || isResp(n);
    const whole = wholeProject || (n.kind === 'projet' && projectMine(n));
    const onlyMine = ancestorMine || Boolean(me && !whole && isLooseChantier(n));
    const tagged = ancestorTag || hasTag(n);
    const kids = n.children.map((c) => prune(c, hit, resp, onlyMine, tagged, whole)).filter(Boolean);
    let keep = kids.length > 0;
    if (n.taskId) {
      const ok = taskOk(model.tasks.get(n.taskId), resp, onlyMine, tagged) && (q === '' || hit);
      if (ok) taskIds.add(n.taskId);
      keep = keep || ok;
    } else if (!taskLevel && !onlyMine && (q === '' || hit)) {
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
        .map((p) => (involvesIsd ? isdOnlyProject(model, p, involvesIsd) : p))
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
  return { responsables, demandeurs, tags: usedTags(model) };
}

/** Tags utilisés par les tâches et les chantiers (les deux listes réunies), dans l'ordre alphabétique. */
export function usedTags(model) {
  const all = new Set();
  for (const t of model.tasks.values()) for (const v of t.tags ?? []) if (v) all.add(v);
  for (const c of model.chantiers.values()) for (const v of c.tags ?? []) if (v) all.add(v);
  return [...all].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base', numeric: true }));
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
  const tagOk = !f.tag || usedTags(model).includes(f.tag);
  const out = {
    ...f,
    categorie: cat ? f.categorie : '',
    projet: projetOk ? f.projet : '',
    chantier: chOk ? f.chantier : '',
    ...(respOk ? {} : { responsable: null }),
    ...(demOk ? {} : { demandeur: '' }),
    ...(tagOk ? {} : { tag: '' }),
  };
  return out.categorie === f.categorie &&
    out.projet === f.projet &&
    out.chantier === f.chantier &&
    respOk &&
    demOk &&
    tagOk
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
  if (f.tag) chips.push({ field: 'tag', label: f.tag });
  if (f.statuses.length) chips.push({ field: 'statuses', label: f.statuses.join(', ') });
  if (f.scope === 'chantiers') chips.push({ field: 'scope', label: 'Mes chantiers' });
  if (f.includeOutOfScope) chips.push({ field: 'includeOutOfScope', label: 'Hors périmètre ISD inclus' });
  if (f.isdOnly) chips.push({ field: 'isdOnly', label: 'ISD seulement' });
  return chips;
}

const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
const textOr = (v, d) => (typeof v === 'string' ? v : d);
const idOrNull = (v) => (Number.isFinite(v) ? v : null);

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

/**
 * Dépliage du Gantt : liste de clés bornée. Les clés de l'ancien niveau « famille » (« F:X ») deviennent celles
 * de la catégorie de même titre (« C:X »), sans doublon ; une clé qui ne désigne plus rien est sans effet.
 */
function sanitizeExpanded(v) {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return null;
  const keys = [...new Set(v.map((k) => (k.startsWith('F:') ? `C:${k.slice(2)}` : k)))];
  return keys.slice(0, MAX_EXPANDED);
}

/** Onglets retirés : une vue ou une vue d'accueil enregistrée sur l'un d'eux revient au Gantt (par défaut). */
const REMOVED_VIEWS = new Set(['portfolio']);
const keptView = (v, fallback) => (REMOVED_VIEWS.has(v) ? fallback : v);

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
  return {
    me: idOrNull(s.me),
    // Préférences d'avant l'invite : une personne déjà enregistrée vaut réponse
    mePrompted: s.mePrompted === true || idOrNull(s.me) !== null,
    hiddenProjects:
      Array.isArray(s.hiddenProjects) && s.hiddenProjects.every((x) => Number.isFinite(x)) ? [...s.hiddenProjects] : [],
    theme: textOr(s.theme, DEFAULT_PREFS.theme),
    view: keptView(textOr(s.view, DEFAULT_PREFS.view), DEFAULT_PREFS.view),
    // Validée contre les onglets par sanitizeHomeView (main.js)
    homeView: s.homeViewV === 2 ? keptView(textOr(s.homeView, null), null) : null,
    homeViewV: 2,
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
    // « phase » d'avant la version 2 : valeur par défaut d'alors, enregistrée avec le reste, pas un choix
    ganttColorBy:
      COLOR_BY.includes(s.ganttColorBy) && (s.ganttColorByV === 2 || s.ganttColorBy !== 'phase')
        ? s.ganttColorBy
        : DEFAULT_PREFS.ganttColorBy,
    ganttColorByV: 2,
    ganttLevel:
      GANTT_LEVELS.includes(s.ganttLevel) || s.ganttLevel === 'custom' ? s.ganttLevel : DEFAULT_PREFS.ganttLevel,
    ganttExpanded: sanitizeExpanded(s.ganttExpanded),
    ganttLabelWidth: sanitizeLabelWidth(s.ganttLabelWidth),
    statsQualityOpen: s.statsQualityOpen === true,
    filters: {
      search: textOr(f.search, ''),
      categorie: textOr(f.categorie, legacy.categorie),
      projet: textOr(f.projet, legacy.projet),
      chantier: textOr(f.chantier, legacy.chantier),
      person: idOrNull(f.person),
      profile: PROFILE_KEYS.includes(f.profile) ? f.profile : null,
      statuses: Array.isArray(f.statuses) && f.statuses.every((x) => typeof x === 'string') ? [...f.statuses] : [],
      // Ancien périmètre « Mes tâches » (tasks) et ancienne case « Mes chantiers » (mine) : « Mes chantiers », qui
      // couvre aussi les chantiers où l'on a une tâche (les tâches personnelles sont dans l'onglet « Mes tâches »)
      scope: SCOPES.includes(f.scope) ? f.scope : f.scope === 'tasks' || f.mine === true ? 'chantiers' : 'all',
      includeOutOfScope: f.includeOutOfScope === true,
      isdOnly: f.isdOnly === true,
      responsable: idOrNull(f.responsable),
      demandeur: textOr(f.demandeur, '').trim(),
      tag: textOr(f.tag, ''),
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
