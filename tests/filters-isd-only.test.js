/** Filtre « ISD seulement » : masque chantiers et tâches où personne de l'équipe ISD n'intervient. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, chantierInvolvesIsd, projectInvolvesIsd, taskInvolvesIsd } from '../widget/js/core/model.js';
import {
  activeFilterChips,
  applyFilters,
  DEFAULT_FILTERS,
  DEFAULT_PREFS,
  loadPrefs,
  PREFS_KEY,
} from '../widget/js/core/filters.js';
import { feuille } from './fixtures/feuille.js';

/** Ajoute une ligne à une table colonnaire (colonnes absentes à null). */
function addRow(table, row) {
  const n = table.id.length;
  for (const c of Object.keys(row)) if (!(c in table)) table[c] = Array(n).fill(null);
  for (const c of Object.keys(table)) table[c].push(c in row ? row[c] : null);
}
const L = (...ids) => ['L', ...ids];

/**
 * Feuille de test + dans le projet 20 (ChatDPI, dans le périmètre) :
 * - chantier 202 (responsable Dora, hors ISD) : 2100 (Dora), 2101 (Dora) avec sous-tâches 2102 (Alice) et 2103
 *   (Dora), 2104 (Dora) dont la sous-tâche 2105 (Dora) a une petite-fille 2106 (Alice), 2300 (Carl, inactif),
 *   2500 (Fanny, Management ISD), 2600 (charge d'Alice seulement), 2700 (responsable Eve, sans assigné) ;
 * - chantier 203 (responsable Fanny) : 2200 (Dora) ; chantier 204 (contributeur Alice) sans tâche ;
 * - projet 80 (responsable Fanny) sans tâche ; projet 90 (responsable Dora, tâche d'Alice).
 */
function build() {
  const raw = feuille();
  const t = raw.tables;
  addRow(t.Chantiers, { id: 202, Nom_du_chantier: 'Chantier sans ISD', Projets: L(20), Responsable: 4 });
  addRow(t.Chantiers, { id: 203, Nom_du_chantier: 'Chantier du Management', Projets: L(20), Responsable: 6 });
  addRow(t.Chantiers, { id: 204, Nom_du_chantier: 'Chantier à contributeur', Projets: L(20), Responsable: 4 });
  t.Chantiers.Contributeurs = t.Chantiers.id.map((id) => (id === 204 ? L(1) : null));
  const task = (id, extra) =>
    addRow(t.Tasks, { id, titre: `T${id}`, Chantier: 202, projet: 20, parentTask: 0, statut: 'todo', ...extra });
  task(2100, { assignees: L(4) });
  task(2101, { assignees: L(4) });
  task(2102, { parentTask: 2101, assignees: L(1) });
  task(2103, { parentTask: 2101, assignees: L(4) });
  task(2104, { assignees: L(4) });
  task(2105, { parentTask: 2104, assignees: L(4) });
  task(2106, { parentTask: 2105, assignees: L(1) });
  task(2300, { assignees: L(3) });
  task(2500, { assignees: L(6) });
  task(2600, { assignees: L(4), charges: '[{"teamId":1,"heures":7}]' });
  task(2700, { Responsable: 5 });
  task(2200, { Chantier: 203, assignees: L(4) });
  addRow(t.Projects, { id: 80, nom: 'Projet du Management', Categorie: 'Projet', responsable: 6 });
  addRow(t.Projects, { id: 90, nom: 'Projet de Dora', Categorie: 'Projet', responsable: 4 });
  addRow(t.Chantiers, { id: 900, Nom_du_chantier: 'Chantier de Dora', Projets: L(90), Responsable: 4 });
  addRow(t.Tasks, {
    id: 9000,
    titre: 'T9000',
    Chantier: 900,
    projet: 90,
    parentTask: 0,
    statut: 'todo',
    assignees: L(1),
  });
  return buildModel(raw);
}
const m = build();
const run = (f = {}, p = {}) => applyFilters(m, { ...DEFAULT_FILTERS, ...f }, { ...DEFAULT_PREFS, ...p });
const ids = (r) => [...r.taskIds].sort((a, b) => a - b);
const chantiersOf = (tree) =>
  tree.flatMap((c) => c.children.flatMap((p) => p.children.map((ch) => ch.ref?.id ?? ch.title)));
const projectsOf = (tree) => tree.flatMap((c) => c.children.map((p) => p.projectId));
const node = (tree, taskId) => {
  const find = (n) => (n.taskId === taskId ? n : n.children.map(find).find(Boolean));
  return tree.map(find).find(Boolean);
};

test('règle partagée : tâche, chantier et projet impliquant l’ISD (Management compris, inactifs exclus)', () => {
  const task = (id) => m.tasks.get(id);
  assert.equal(taskInvolvesIsd(task(2100), m.people), false); // Dora, hors ISD
  assert.equal(taskInvolvesIsd(task(2102), m.people), true); // Alice
  assert.equal(taskInvolvesIsd(task(2500), m.people), true); // Fanny, Management ISD
  assert.equal(taskInvolvesIsd(task(2300), m.people), false); // Carl, inactif
  assert.equal(taskInvolvesIsd(task(2600), m.people), true); // charge d'Alice seulement
  assert.equal(taskInvolvesIsd(task(2700), m.people), true); // responsable Eve
  assert.equal(chantierInvolvesIsd(m.chantiers.get(202), m.people), false);
  assert.equal(chantierInvolvesIsd(m.chantiers.get(203), m.people), true); // responsable Management ISD
  assert.equal(chantierInvolvesIsd(m.chantiers.get(204), m.people), true); // contributeur Alice
  assert.equal(projectInvolvesIsd(m.projects.get(80), m.people), true);
  assert.equal(projectInvolvesIsd(m.projects.get(90), m.people), false);
});

test('ISD seulement : sans la case, rien ne change', () => {
  const all = run();
  assert.deepEqual(ids(run({ isdOnly: false })), ids(all));
  assert.ok(all.taskIds.has(2100));
  assert.equal(DEFAULT_FILTERS.isdOnly, false);
});

test('ISD seulement : une tâche sans personne ISD est masquée, une avec Management, charge ou responsable reste', () => {
  const r = run({ isdOnly: true });
  for (const id of [2100, 2300, 2200]) assert.equal(r.taskIds.has(id), false, `tâche ${id}`);
  for (const id of [2500, 2600, 2700, 2010, 2001]) assert.equal(r.taskIds.has(id), true, `tâche ${id}`);
});

test('ISD seulement : une tâche garde sa branche si une sous-tâche implique l’ISD, sans les sous-tâches sans ISD', () => {
  const r = run({ isdOnly: true });
  assert.equal(r.taskIds.has(2101), false); // la tâche elle-même n'est pas comptée parmi les tâches retenues
  const parent = node(r.tree, 2101);
  assert.ok(parent, 'le parent reste dans l’arbre');
  assert.deepEqual(
    parent.children.map((c) => c.taskId),
    [2102],
  );
  // Toute profondeur : 2104 > 2105 > 2106 (Alice)
  assert.ok(node(r.tree, 2104) && node(r.tree, 2105) && node(r.tree, 2106));
  assert.equal(r.taskIds.has(2106), true);
  assert.equal(node(r.tree, 2103), undefined);
  assert.equal(node(r.tree, 2100), undefined);
});

test('ISD seulement : un chantier reste par son responsable ou contributeur ISD, vide sans tâche ISD', () => {
  const r = run({ isdOnly: true });
  const chs = chantiersOf(r.tree);
  assert.ok(chs.includes(203)); // responsable Fanny, sa seule tâche (Dora) masquée
  assert.ok(chs.includes(204)); // contributeur Alice, aucune tâche
  assert.ok(chs.includes(202)); // a des tâches ISD
  const c203 = r.tree.flatMap((c) => c.children.flatMap((p) => p.children)).find((c) => c.ref?.id === 203);
  assert.deepEqual(c203.children, []);
  assert.ok(!chs.includes(300)); // Reporting, hors ISD
});

test('ISD seulement : chantier sans ISD ni tâche ISD disparaît ; « (sans chantier) » suit ses tâches', () => {
  const raw = feuille();
  addRow(raw.tables.Tasks, {
    id: 7000,
    titre: 'Loin de l’ISD',
    Chantier: 0,
    projet: 20,
    parentTask: 0,
    statut: 'todo',
    assignees: L(4),
  });
  const mm = buildModel(raw);
  const f = { ...DEFAULT_FILTERS, isdOnly: true };
  const names = (tree) => tree.flatMap((c) => c.children.flatMap((p) => p.children.map((ch) => ch.title)));
  const before = names(applyFilters(mm, { ...DEFAULT_FILTERS }, DEFAULT_PREFS).tree);
  assert.ok(before.includes('(sans chantier)'));
  const r = applyFilters(mm, f, DEFAULT_PREFS);
  // Chantier 202 (responsable Dora) : l'ajout de tâches ISD le garderait ; ici aucune de ses tâches n'est ISD
  const raw2 = feuille();
  addRow(raw2.tables.Chantiers, { id: 202, Nom_du_chantier: 'Chantier sans ISD', Projets: L(20), Responsable: 4 });
  addRow(raw2.tables.Tasks, {
    id: 2100,
    titre: 'T2100',
    Chantier: 202,
    projet: 20,
    parentTask: 0,
    statut: 'todo',
    assignees: L(4),
  });
  const mm2 = buildModel(raw2);
  const unfiltered = chantiersOf(applyFilters(mm2, { ...DEFAULT_FILTERS }, DEFAULT_PREFS).tree);
  assert.ok(unfiltered.includes(202));
  assert.ok(!chantiersOf(applyFilters(mm2, f, DEFAULT_PREFS).tree).includes(202));
  assert.ok(names(r.tree).includes('(sans chantier)')); // gardé par 2001 (charge d'Eve)
  assert.ok(r.taskIds.has(2001));
  assert.equal(r.taskIds.has(7000), false);
});

test('ISD seulement : projet sans rien de gardé disparu des tâches, gardé dans l’arbre s’il est ISD par lui-même', () => {
  const r = run({ isdOnly: true });
  const projets = projectsOf(r.tree);
  assert.ok(projets.includes(80)); // responsable Management ISD, sans tâche
  assert.ok(projets.includes(10) && projets.includes(20));
  // Hors périmètre aussi : Dora responsable du projet 90 mais tâche d'Alice -> gardé par sa tâche
  const out = run({ isdOnly: true, includeOutOfScope: true });
  assert.ok(projectsOf(out.tree).includes(90));
  assert.ok(!projectsOf(out.tree).includes(40)); // tout y est hors ISD
  assert.ok(!chantiersOf(out.tree).includes(300)); // Reporting (Dora) masqué
  assert.ok(projectsOf(out.tree).includes(30)); // gardé par le chantier partagé 201 (tâche d'Eve)
  assert.equal(out.taskIds.has(3000), false);
  assert.equal(out.taskIds.has(4001), false);
});

test('ISD seulement : se combine avec Mes chantiers et les autres filtres', () => {
  const mine = run({ isdOnly: true, scope: 'chantiers' }, { me: 1 });
  assert.equal(mine.taskIds.has(2100), false);
  assert.equal(mine.taskIds.has(2102), true);
  assert.equal(mine.taskIds.has(2200), false);
  const status = run({ isdOnly: true, statuses: ['done'] });
  assert.deepEqual(ids(status), [1001]);
  const search = run({ isdOnly: true, search: 'T2102' });
  assert.deepEqual(ids(search), [2102]);
});

test('ISD seulement : sanitizePrefs et étiquette', () => {
  const stored = (isdOnly) => ({ getItem: () => JSON.stringify({ filters: { isdOnly } }) });
  assert.equal(loadPrefs(stored(true)).filters.isdOnly, true);
  for (const bad of ['oui', 1, null, undefined]) assert.equal(loadPrefs(stored(bad)).filters.isdOnly, false);
  assert.equal(PREFS_KEY, 'roadmap-isd:prefs');
  assert.deepEqual(activeFilterChips({ ...DEFAULT_FILTERS, isdOnly: true }, m), [
    { field: 'isdOnly', label: 'ISD seulement' },
  ]);
  assert.deepEqual(activeFilterChips(DEFAULT_FILTERS, m), []);
});
