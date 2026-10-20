import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import {
  applyFilters,
  DEFAULT_FILTERS,
  DEFAULT_PREFS,
  loadPrefs,
  savePrefs,
  normalize,
  activeFilterChips,
  filterChoices,
  validFilters,
} from '../widget/js/core/filters.js';
import { feuille } from './fixtures/feuille.js';
import { COLUMNS, DEFAULT_COLUMNS } from '../widget/js/core/table-data.js';

const m = buildModel(feuille());
const run = (f = {}, p = {}) => applyFilters(m, { ...DEFAULT_FILTERS, ...f }, { ...DEFAULT_PREFS, ...p });

test('sans filtre : toutes les tâches du périmètre, chacune une fois', () => {
  const r = run();
  assert.deepEqual([...r.taskIds].sort(), [1000, 1001, 1002, 1500, 2000, 2001, 2010, 3000]);
});

test('hors périmètre et projets masqués', () => {
  assert.equal(run({}, { hiddenProjects: [30] }).taskIds.has(3000), false);
  assert.equal(run({}, { hiddenProjects: [30] }).taskIds.has(2010), true); // toujours visible sous ChatDPI
});

test('personne, profil ; ancien périmètre « Mes tâches » sans effet sur le filtrage', () => {
  assert.deepEqual([...run({ person: 5 }).taskIds].sort(), [2001, 2010]);
  assert.deepEqual([...run({ profile: 'PO' }).taskIds].sort(), [1001]);
  assert.equal(run({ scope: 'tasks' }, { me: 1 }).taskIds.size, 8);
});

test('périmètre « Mes chantiers » : responsable ou contributeur, ou une tâche du chantier ; toutes ses tâches', () => {
  const chantiers = (r) => r.tree.flatMap((c) => c.children.flatMap((p) => p.children.map((ch) => ch.title)));
  // Bob (2) est responsable du chantier 100 (toutes ses tâches, même celles sans lui) et du projet ChatDPI (20) :
  // tous les chantiers et toutes les tâches du projet comptent comme les siens
  assert.deepEqual([...run({ scope: 'chantiers' }, { me: 2 }).taskIds].sort(), [1000, 1001, 1002, 2000, 2001, 2010]);
  // Alice (1) : responsable de WP1, et assignée et chargée sur une sous-tâche du chantier 100 → les deux chantiers,
  // avec toutes leurs tâches (1000 et 1001 ne la concernent pas)
  const alice = run({ scope: 'chantiers' }, { me: 1 });
  assert.deepEqual([...alice.taskIds].sort(), [1000, 1001, 1002, 2000]);
  assert.deepEqual(chantiers(alice), ['Produit de Données Patient', 'WP1 : Modèle LLM']);
  // Eve (5) : assignée sur une tâche du chantier partagé (retenu sous chacun de ses projets), et chargée sur une
  // tâche sans chantier (2001), gardée sous « (sans chantier) » : passer à « Mes chantiers » ne masque aucune de
  // ses tâches
  const eve = run({ scope: 'chantiers' }, { me: 5 });
  assert.deepEqual([...eve.taskIds].sort(), [2001, 2010]);
  assert.deepEqual(chantiers(eve), ['Chantier partagé', 'Chantier partagé', '(sans chantier)']);
  // Contributeur seul : Fanny (6) ajoutée aux contributeurs du chantier partagé
  const model = buildModel(feuille());
  model.chantiers.get(201).contributeurs.push(6);
  const scoped = (mo, me) => applyFilters(mo, { ...DEFAULT_FILTERS, scope: 'chantiers' }, { ...DEFAULT_PREFS, me });
  assert.deepEqual([...scoped(model, 6).taskIds], [2010]);
  // Responsable d'une tâche seulement : Gus (7) responsable de la tâche 3000 → tout le chantier Reporting
  model.tasks.get(3000).responsable = 7;
  assert.deepEqual([...scoped(model, 7).taskIds], [3000]);
  // Chargé seulement (sans assignation) sur une tâche d'un chantier : chantier retenu
  model.tasks.get(2000).charges.push({ personId: 3, heures: 7 });
  assert.deepEqual([...scoped(model, 3).taskIds], [2000]);
  // Personne sans chantier ni tâche : rien ; sans « Je suis… » : sans effet
  assert.equal(run({ scope: 'chantiers' }, { me: 6 }).taskIds.size, 0);
  assert.equal(run({ scope: 'chantiers' }, { me: null }).taskIds.size, 8);
  // Étiquettes de filtre actif : seul « Mes chantiers » existe encore
  assert.deepEqual(activeFilterChips({ ...DEFAULT_FILTERS, scope: 'chantiers' }, m), [
    { field: 'scope', label: 'Mes chantiers' },
  ]);
  assert.deepEqual(activeFilterChips({ ...DEFAULT_FILTERS, scope: 'tasks' }, m), []);
});

test('Mes chantiers, « (sans chantier) » : seules mes tâches, ni celles des autres ni ce chantier sans tâche à moi', () => {
  const raw = feuille();
  const t = raw.tables.Tasks;
  // Deux tâches sans chantier dans le projet de 2001 : une à Eve (sous-tâche d'une tâche de Bob), une à personne
  const add = (row) => Object.keys(t).forEach((k) => t[k].push(k in row ? row[k] : null));
  add({
    id: 2002,
    titre: 'Sans chantier, Bob',
    Chantier: 0,
    projet: 20,
    parentTask: 0,
    statut: 'todo',
    assignees: ['L', 2],
  });
  add({
    id: 2003,
    titre: 'Sous-tâche d’Eve',
    Chantier: 0,
    projet: 20,
    parentTask: 2002,
    statut: 'todo',
    assignees: ['L', 5],
  });
  add({ id: 2004, titre: 'Sans chantier, personne', Chantier: 0, projet: 20, parentTask: 0, statut: 'todo' });
  const model = buildModel(raw);
  const scoped = (me, f = {}) =>
    applyFilters(model, { ...DEFAULT_FILTERS, scope: 'chantiers', ...f }, { ...DEFAULT_PREFS, me });
  // Eve : 2001 et sa sous-tâche 2003 (la tâche de Bob 2002 reste affichée comme parent, sans être comptée)
  const eve = scoped(5);
  assert.deepEqual([...eve.taskIds].sort(), [2001, 2003, 2010]);
  const loose = eve.tree.flatMap((c) => c.children.flatMap((p) => p.children)).find((c) => !c.ref);
  const kids = Object.fromEntries(loose.children.map((n) => [n.taskId, n.children.map((x) => x.taskId)]));
  assert.deepEqual(kids, { 2001: [], 2002: [2003] });
  // Bob : responsable du projet ChatDPI (20), tout le projet est à lui, « (sans chantier) » compris
  assert.ok(scoped(2).taskIds.has(2002));
  assert.ok(scoped(2).taskIds.has(2004));
  // Alice, responsable du seul chantier WP1 du projet : aucune tâche sans chantier
  assert.ok(![...scoped(1).taskIds].some((id) => id >= 2002 && id <= 2004));
  // Recherche dans « Mes chantiers » : la règle « seulement mes tâches » tient toujours
  assert.deepEqual([...scoped(5, { search: 'sans chantier' }).taskIds].sort(), [2001, 2003]);
  // Sans « Mes chantiers » : toutes les tâches sans chantier
  assert.ok(applyFilters(model, DEFAULT_FILTERS, DEFAULT_PREFS).taskIds.has(2004));
});

test('Mes chantiers : une tâche terminée ne rend pas un chantier « mien » ; responsable ou contributeur, si', () => {
  const raw = feuille();
  const t = raw.tables.Tasks;
  t.statut[t.id.indexOf(1002)] = 'done';
  const model = buildModel(raw);
  const scoped = (me) => applyFilters(model, { ...DEFAULT_FILTERS, scope: 'chantiers' }, { ...DEFAULT_PREFS, me });
  // Alice (1) n'était dans le chantier 100 que par la tâche 1002, terminée : seul WP1 (dont elle est responsable)
  assert.deepEqual([...scoped(1).taskIds], [2000]);
  // Bob (2), responsable du chantier 100 : toujours retenu, tâches terminées comprises (plus son projet ChatDPI)
  assert.deepEqual([...scoped(2).taskIds].sort(), [1000, 1001, 1002, 2000, 2001, 2010]);
});

test('préférences : ancien périmètre « Mes tâches » et case « mine » → « Mes chantiers » ; inconnu → tout', () => {
  const load = (v) => loadPrefs({ getItem: () => JSON.stringify(v), setItem() {} });
  assert.equal(load({ filters: { mine: true } }).filters.scope, 'chantiers');
  assert.equal(load({ filters: { scope: 'tasks' } }).filters.scope, 'chantiers');
  assert.equal(load({ filters: { scope: 'all' } }).filters.scope, 'all');
  assert.equal(load({ filters: { mine: false } }).filters.scope, 'all');
  assert.equal(load({ filters: { scope: 'chantiers', mine: true } }).filters.scope, 'chantiers');
  assert.equal(load({ filters: { scope: 'nimporte' } }).filters.scope, 'all');
  assert.equal('mine' in load({ filters: { mine: true } }).filters, false);
  // Vue d'accueil : texte gardé tel quel (validé contre les onglets au démarrage), sinon null
  assert.equal(load({ homeView: 'mytasks' }).homeView, 'mytasks');
  assert.equal(load({ homeView: 3 }).homeView, null);
  assert.equal(load({}).homeView, null);
});

test('statut et recherche (accents ignorés, ancêtres compris)', () => {
  assert.deepEqual([...run({ statuses: ['done'] }).taskIds], [1001]);
  assert.deepEqual([...run({ search: 'REALISATION' }).taskIds], [1002]);
  assert.deepEqual([...run({ search: 'modele llm' }).taskIds], [2000]); // via le titre du chantier
  assert.equal(normalize('Électricité  Ça'), 'electricite ca');
});

test('catégorie, projet et chantier ; l’arbre est élagué sans modifier le modèle', () => {
  const r = run({ categorie: 'C:Projet' });
  assert.deepEqual(
    r.tree.map((f) => f.title),
    ['Projet'],
  );
  assert.equal(m.tree.length, 3);
  assert.deepEqual([...run({ projet: 'P20' }).taskIds].sort(), [2000, 2001, 2010]);
  assert.deepEqual([...run({ projet: 'P10' }).taskIds].sort(), [1000, 1001, 1002, 1500]);
  assert.deepEqual([...run({ chantier: 'P10/C100' }).taskIds].sort(), [1000, 1001, 1002]);
  // Chantier virtuel : seulement les tâches sans chantier de ce projet
  assert.deepEqual([...run({ chantier: 'P20/C0' }).taskIds], [2001]);
});

test('chantier partagé : le filtre le retient sous chacun de ses projets', () => {
  const r = run({ chantier: 'P30/C201' });
  assert.deepEqual([...r.taskIds], [2010]);
  assert.deepEqual(r.tree.flatMap((c) => c.children.map((p) => p.title)).sort(), ['BI Gestion', 'ChatDPI']);
  // Les projets sans ce chantier disparaissent, même sans filtre de tâche
  assert.ok(r.tree.every((c) => c.children.every((p) => p.children.length === 1)));
});

test('choix des listes : catégories, projets selon la catégorie, chantiers selon le projet', () => {
  const p = { ...DEFAULT_PREFS };
  const all = filterChoices(m, { ...DEFAULT_FILTERS }, p);
  assert.deepEqual(
    all.categories.map((c) => c.key),
    ['C:Produit', 'C:Produit de données', 'C:Projet'],
  );
  assert.deepEqual(
    all.projets.map((g) => [g.group.title, g.items.map((x) => x.title)]),
    [
      ['Produit', ['BI Gestion']],
      ['Produit de données', ['Données Socle Commun EDS']],
      ['Projet', ['ChatDPI']],
    ],
  );
  const cat = filterChoices(m, { ...DEFAULT_FILTERS, categorie: 'C:Projet' }, p);
  assert.deepEqual(
    cat.projets.map((g) => g.group.title),
    ['Projet'],
  );
  assert.deepEqual(
    cat.chantiers.map((g) => [g.group.title, g.items.map((x) => x.key)]),
    [['ChatDPI', ['P20/C201', 'P20/C200', 'P20/C0']]],
  );
  const proj = filterChoices(m, { ...DEFAULT_FILTERS, projet: 'P10' }, p);
  assert.deepEqual(
    proj.chantiers.map((g) => g.items.map((x) => x.title)),
    [['Produit de Données Patient', '(sans chantier)']],
  );
  // Hors périmètre ISD seulement si la case est cochée ; projets masqués exclus
  assert.ok(!all.projets.some((g) => g.items.some((x) => x.key === 'P40')));
  const out = filterChoices(m, { ...DEFAULT_FILTERS, includeOutOfScope: true }, { ...p, hiddenProjects: [30] });
  assert.deepEqual(
    out.projets.find((g) => g.group.title === 'Produit').items.map((x) => x.key),
    ['P40'],
  );
});

test('filtres valides : clés inconnues ou incohérentes avec le niveau au-dessus retirées', () => {
  const v = (f) => validFilters(m, { ...DEFAULT_FILTERS, ...f });
  assert.deepEqual(v({ categorie: 'C:Projet', projet: 'P20', chantier: 'P20/C200' }), {
    ...DEFAULT_FILTERS,
    categorie: 'C:Projet',
    projet: 'P20',
    chantier: 'P20/C200',
  });
  assert.equal(v({ categorie: 'F:Projet' }).categorie, '');
  assert.equal(v({ categorie: 'P20' }).categorie, ''); // mauvais niveau
  assert.equal(v({ categorie: 'C:Produit', projet: 'P20' }).projet, '');
  assert.equal(v({ projet: 'P10/C100' }).projet, '');
  assert.equal(v({ projet: 'P10', chantier: 'P20/C200' }).chantier, '');
  assert.equal(v({ categorie: 'C:Produit', chantier: 'P20/C200' }).chantier, '');
  assert.equal(v({ chantier: 'P10/C100/T1000' }).chantier, '');
  const same = { ...DEFAULT_FILTERS };
  assert.equal(validFilters(m, same), same); // rien à retirer : même objet
});

test('étiquettes des filtres actifs', () => {
  const chips = activeFilterChips(
    {
      ...DEFAULT_FILTERS,
      person: 5,
      statuses: ['done'],
      search: 'x',
      categorie: 'C:Projet',
      projet: 'P20',
      chantier: 'P20/C0',
    },
    m,
  );
  assert.deepEqual(
    chips.map((c) => c.field),
    ['search', 'categorie', 'projet', 'chantier', 'person', 'statuses'],
  );
  assert.deepEqual(
    chips.slice(1, 5).map((c) => c.label),
    ['Projet', 'ChatDPI', '(sans chantier)', 'Eve DA'],
  );
});

test('préférences : stockage absent ou corrompu', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.deepEqual(loadPrefs(storage), DEFAULT_PREFS);
  savePrefs(storage, { ...DEFAULT_PREFS, me: 2 });
  assert.equal(loadPrefs(storage).me, 2);
  store.set('roadmap-isd:prefs', '{oops');
  assert.deepEqual(loadPrefs(storage), DEFAULT_PREFS);
  const broken = {
    getItem: () => {
      throw new Error('bloqué');
    },
    setItem: () => {
      throw new Error('bloqué');
    },
  };
  assert.deepEqual(loadPrefs(broken), DEFAULT_PREFS);
  savePrefs(broken, DEFAULT_PREFS); // ne lève pas
});

test('préférences corrompues mais JSON valide : types ramenés aux défauts, pas de plantage', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  store.set(
    'roadmap-isd:prefs',
    '{"filters":{"statuses":null,"person":"x","mine":"oui"},"hiddenProjects":5,"me":"abc","theme":7}',
  );
  const loaded = loadPrefs(storage);
  assert.deepEqual(loaded, DEFAULT_PREFS);
  assert.doesNotThrow(() => applyFilters(m, loaded.filters, loaded));
  store.set('roadmap-isd:prefs', 'null');
  assert.deepEqual(loadPrefs(storage), DEFAULT_PREFS);
});

test('préférences du tableau : colonnes et tri assainis', () => {
  const load = (json) => {
    const storage = { getItem: () => json, setItem: () => {} };
    return loadPrefs(storage);
  };
  assert.deepEqual(
    load('{"tableColumns":["etp","tache","inconnue"],"tableColumnsV":2,"tableSort":{"key":"end","dir":"desc"}}')
      .tableColumns,
    ['tache', 'etp'],
  );
  assert.deepEqual(load('{"tableSort":{"key":"end","dir":"desc"}}').tableSort, { key: 'end', dir: 'desc' });
  assert.deepEqual(load('{"tableSort":{"key":"end","dir":"bizarre"}}').tableSort, { key: 'end', dir: 'asc' });
  assert.equal(load('{"tableSort":{"key":"nimporte"}}').tableSort, null);
  assert.equal(load('{"tableSort":"end"}').tableSort, null);
  assert.deepEqual(load('{"tableColumns":[]}').tableColumns, [...DEFAULT_COLUMNS]);
  assert.deepEqual(load('{"tableColumns":["x"]}').tableColumns, [...DEFAULT_COLUMNS]);
  assert.deepEqual(load('{"tableColumns":"task"}').tableColumns, [...DEFAULT_COLUMNS]);
  // « Tâche » est toujours affichée : elle porte le bouton qui ouvre la fiche
  assert.deepEqual(load('{"tableColumns":["status"],"tableColumnsV":3}').tableColumns, ['tache', 'status']);
});

test('préférences du tableau : anciennes clés de vue groupée ignorées', () => {
  const load = (json) => loadPrefs({ getItem: () => json, setItem: () => {} });
  const p = load('{"tableMode":"groupes","tableCollapsed":["P10"],"tableSort":{"key":"end","dir":"desc"}}');
  assert.ok(!('tableMode' in p) && !('tableCollapsed' in p));
  assert.deepEqual(p.tableSort, { key: 'end', dir: 'desc' });
});

test('préférences du tableau : ancien défaut remplacé par le nouveau, choix personnalisés conservés', () => {
  const load = (json) => loadPrefs({ getItem: () => json, setItem: () => {} });
  const legacy = JSON.stringify(COLUMNS.filter((c) => c !== 'etpOther'));
  // Ancien défaut jamais personnalisé (version 2 ou sans version) : nouveau défaut
  assert.deepEqual(load(`{"tableColumns":${legacy},"tableColumnsV":2}`).tableColumns, [...DEFAULT_COLUMNS]);
  assert.deepEqual(load(`{"tableColumns":${legacy}}`).tableColumns, [...DEFAULT_COLUMNS]);
  // Choix personnalisé avec les quatre colonnes ETP par profil : elles cèdent la place aux pastilles
  const v2 = '["tache","etp","etpPO","etpDA","etpDS","etpDE","priority"]';
  assert.deepEqual(load(`{"tableColumns":${v2},"tableColumnsV":2}`).tableColumns, ['tache', 'priority', 'etp']);
  // Choix partiel ou enregistrement de version 3 : respecté (dans l'ordre du tableau)
  assert.deepEqual(load('{"tableColumns":["tache","etpDA"],"tableColumnsV":2}').tableColumns, ['tache', 'etpDA']);
  assert.deepEqual(load(`{"tableColumns":${v2},"tableColumnsV":3}`).tableColumns, [
    'tache',
    'priority',
    'etp',
    'etpPO',
    'etpDA',
    'etpDS',
    'etpDE',
  ]);
  assert.deepEqual(load('{"tableColumns":["etpOther","tache"],"tableColumnsV":2}').tableColumns, ['tache', 'etpOther']);
});

test('préférences : anciens filtres famille / produit repris au niveau correspondant', () => {
  const load = (json) => loadPrefs({ getItem: () => json, setItem: () => {} }).filters;
  const f = load('{"filters":{"family":"F:Projet","product":"P20"}}');
  assert.deepEqual([f.categorie, f.projet, f.chantier], ['C:Projet', 'P20', '']);
  assert.ok(!('family' in f) && !('product' in f));
  // Ancien « produit » d'un produit de données : c'était un chantier
  const g = load('{"filters":{"family":"F:Données Socle Commun EDS","product":"P10/C100"}}');
  assert.deepEqual([g.categorie, g.projet, g.chantier], ['C:Données Socle Commun EDS', '', 'P10/C100']);
  // Une fois le modèle chargé, une catégorie disparue est retirée
  assert.equal(validFilters(m, g).categorie, '');
  assert.equal(validFilters(m, g).chantier, 'P10/C100');
  // Ancienne famille d'un produit de données (« F:<titre du projet> ») sans produit choisi : le projet de ce titre
  const dp = load('{"filters":{"family":"F:Données Socle Commun EDS","product":""}}');
  assert.deepEqual((({ categorie, projet, chantier }) => [categorie, projet, chantier])(validFilters(m, dp)), [
    '',
    'P10',
    '',
  ]);
  // Titre introuvable : la catégorie est simplement retirée
  const lost = load('{"filters":{"family":"F:Inconnu"}}');
  assert.deepEqual((({ categorie, projet }) => [categorie, projet])(validFilters(m, lost)), ['', '']);
  // Valeurs inattendues : ignorées
  const h = load('{"filters":{"family":3,"product":"n importe"}}');
  assert.deepEqual([h.categorie, h.projet, h.chantier], ['', '', '']);
  // Les nouvelles clés l'emportent sur les anciennes
  const n = load('{"filters":{"categorie":"C:Produit","family":"F:Projet"}}');
  assert.equal(n.categorie, 'C:Produit');
});

test('préférences du tableau : anciennes colonnes famille / produit / tâche renommées', () => {
  const load = (json) => loadPrefs({ getItem: () => json, setItem: () => {} });
  assert.deepEqual(
    load('{"tableColumns":["family","product","chantier","task","status"],"tableColumnsV":2}').tableColumns,
    ['tache', 'chantier', 'projet', 'status', 'categorie', 'sousTache'], // ordre du tableau
  );
  assert.deepEqual(load('{"tableSort":{"key":"product","dir":"desc"}}').tableSort, { key: 'projet', dir: 'desc' });
  assert.deepEqual(load('{"tableSort":{"key":"task"}}').tableSort, { key: 'tache', dir: 'asc' });
});

test('Mes chantiers : un projet hors périmètre ISD où la personne du Management est assignée reste visible', () => {
  const model = buildModel(feuille());
  const out = [...model.projects.values()].find((p) => !p.inScope);
  const task = [...model.tasks.values()].find(
    (t) => t.chantierId && model.nodes.get(`P${out.id}`) && inProject(model, out, t),
  );
  task.assignees.push(6);
  const f = { ...DEFAULT_FILTERS, scope: 'chantiers' };
  const mine = applyFilters(model, f, { ...DEFAULT_PREFS, me: 6 });
  assert.deepEqual([...mine.taskIds], [task.id]);
  // sans ciblage, le projet reste hors périmètre
  assert.equal(applyFilters(model, DEFAULT_FILTERS, DEFAULT_PREFS).taskIds.has(task.id), false);
  assert.equal(applyFilters(model, { ...DEFAULT_FILTERS, person: 6 }, DEFAULT_PREFS).taskIds.has(task.id), true);
  assert.ok(filterChoices(model, f, { ...DEFAULT_PREFS, me: 6 }).projets.length >= 1);
});

function inProject(model, project, task) {
  const walk = (n) => (n.taskId === task.id ? true : n.children.some(walk));
  return walk(model.nodes.get(`P${project.id}`));
}
