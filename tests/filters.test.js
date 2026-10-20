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

test('personne, profil, périmètre « Mes tâches »', () => {
  assert.deepEqual([...run({ person: 5 }).taskIds].sort(), [2001, 2010]);
  assert.deepEqual([...run({ profile: 'PO' }).taskIds].sort(), [1001]);
  assert.deepEqual([...run({ scope: 'tasks' }, { me: 1 }).taskIds].sort(), [1002]);
  assert.equal(run({ scope: 'tasks' }, { me: null }).taskIds.size, 8); // sans « Je suis », le filtre est sans effet
});

test('périmètre « Mes chantiers » : chantiers dont je suis responsable ou contributeur, avec toutes leurs tâches', () => {
  // Bob (2) est responsable du chantier 100 : toutes ses tâches, même sans lui
  assert.deepEqual([...run({ scope: 'chantiers' }, { me: 2 }).taskIds].sort(), [1000, 1001, 1002]);
  // Alice (1) est responsable de WP1 (sans tâche visible ailleurs) : chantier gardé, avec ses tâches
  const alice = run({ scope: 'chantiers' }, { me: 1 });
  assert.deepEqual([...alice.taskIds].sort(), [2000]);
  assert.deepEqual(
    alice.tree.flatMap((c) => c.children.flatMap((p) => p.children.map((ch) => ch.title))),
    ['WP1 : Modèle LLM'],
  );
  // Contributeur : Eve (5) ajoutée aux contributeurs du chantier partagé
  const model = buildModel(feuille());
  model.chantiers.get(201).contributeurs.push(5);
  const eve = applyFilters(model, { ...DEFAULT_FILTERS, scope: 'chantiers' }, { ...DEFAULT_PREFS, me: 5 });
  assert.deepEqual([...eve.taskIds], [2010]);
  // Personne sans chantier : rien ; sans « Je suis… » : sans effet
  assert.equal(run({ scope: 'chantiers' }, { me: 6 }).taskIds.size, 0);
  assert.equal(run({ scope: 'chantiers' }, { me: null }).taskIds.size, 8);
  // Étiquettes de filtre actif
  assert.deepEqual(activeFilterChips({ ...DEFAULT_FILTERS, scope: 'chantiers' }, m), [
    { field: 'scope', label: 'Mes chantiers' },
  ]);
  assert.deepEqual(activeFilterChips({ ...DEFAULT_FILTERS, scope: 'tasks' }, m), [
    { field: 'scope', label: 'Mes tâches' },
  ]);
});

test('préférences : ancienne case « Mes chantiers » (mine) → périmètre « Mes tâches » ; périmètre inconnu → tout', () => {
  const load = (v) => loadPrefs({ getItem: () => JSON.stringify(v), setItem() {} });
  assert.equal(load({ filters: { mine: true } }).filters.scope, 'tasks');
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

test('Mes tâches : un projet hors périmètre ISD où la personne du Management est assignée reste visible', () => {
  const model = buildModel(feuille());
  const out = [...model.projects.values()].find((p) => !p.inScope);
  const task = [...model.tasks.values()].find((t) => model.nodes.get(`P${out.id}`) && inProject(model, out, t));
  task.assignees.push(6);
  const f = { ...DEFAULT_FILTERS, scope: 'tasks' };
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
