import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, isdDomainOf } from '../widget/js/core/model.js';
import { applyFilters, DEFAULT_FILTERS, DEFAULT_PREFS } from '../widget/js/core/filters.js';
import { isEmptyContainer } from '../widget/js/core/gantt-data.js';
import { isdDomain } from '../widget/js/core/team-directory.js';
import { feuille } from './fixtures/feuille.js';

/** Ajoute une ligne à une table colonnaire (colonnes absentes à null). */
function addRow(table, row) {
  const n = table.id.length;
  for (const c of Object.keys(row)) if (!(c in table)) table[c] = Array(n).fill(null);
  for (const c of Object.keys(table)) table[c].push(c in row ? row[c] : null);
}

/**
 * Feuille de test plus trois projets sans tâche : 50 porté par le seul Management ISD (Fanny, 6) avec un
 * chantier vide dont elle est contributrice, 60 porté par le Management d'un autre Domaine (Gus, 7), et 70 dont
 * Fanny n'est que sponsor, sans chantier.
 */
function withEmptyProjects() {
  const raw = feuille();
  const t = raw.tables;
  addRow(t.Projects, { id: 50, nom: 'Pilotage Management', Categorie: 'Projet', responsable: 6, Sponsor: ['L', 4] });
  addRow(t.Chantiers, { id: 500, Nom_du_chantier: 'POC sans tâche', Projets: ['L', 50], Contributeurs: ['L', 6] });
  addRow(t.Projects, { id: 60, nom: 'Projet du Management BNDMR', Categorie: 'Projet', responsable: 7 });
  addRow(t.Chantiers, { id: 600, Nom_du_chantier: 'Chantier BNDMR', Projets: ['L', 60], Responsable: 7 });
  addRow(t.Projects, { id: 70, nom: 'Projet sponsorisé', Categorie: 'Projet', responsable: 4, Sponsor: ['L', 6] });
  return buildModel(raw);
}

const m = withEmptyProjects();
const run = (f = {}, p = {}) => applyFilters(m, { ...DEFAULT_FILTERS, ...f }, { ...DEFAULT_PREFS, ...p });
const projectsOf = (tree) => tree.flatMap((c) => c.children.map((p) => p.projectId));
const chantierNode = (tree, id) =>
  tree.flatMap((c) => c.children.flatMap((p) => p.children)).find((ch) => ch.ref?.id === id);

test('équipe ISD : profil ISD actif ou Domaine ISD (Management ISD compris) ; isd garde le seul profil', () => {
  const flags = (id) => [m.people.get(id).isd, m.people.get(id).isdTeam];
  assert.deepEqual(flags(1), [true, true]); // DE du Domaine ISD
  assert.deepEqual(flags(5), [true, true]); // DA sans Domaine : profil ISD
  assert.deepEqual(flags(6), [false, true]); // Management ISD : équipe, pas de profil
  assert.deepEqual(flags(7), [false, false]); // Management d'un autre Domaine
  assert.deepEqual(flags(3), [false, false]); // DS inactif
  assert.deepEqual(flags(4), [false, false]); // hors ISD
  assert.equal(isdDomainOf(m.people.values()), isdDomain(m));
  assert.equal(isdDomainOf([]), null);
});

test('périmètre ISD : un projet où seul le Management ISD est impliqué en fait partie', () => {
  assert.equal(m.projects.get(50).inScope, true); // responsable Management ISD, sponsor hors ISD
  assert.equal(m.projects.get(70).inScope, true); // sponsor Management ISD
  assert.equal(m.projects.get(60).inScope, false); // Management d'un autre Domaine
  assert.equal(m.projects.get(40).inScope, false);
});

test('« Tout » : projet et chantier sans tâche du périmètre visibles dans l’arbre, aucune tâche ajoutée', () => {
  const r = run();
  assert.ok(projectsOf(r.tree).includes(50));
  assert.ok(projectsOf(r.tree).includes(70)); // projet sans chantier ni tâche
  assert.equal(projectsOf(r.tree).includes(60), false);
  assert.equal(chantierNode(r.tree, 500).children.length, 0);
  assert.deepEqual([...r.taskIds].sort(), [1000, 1001, 1002, 1500, 2000, 2001, 2010, 3000]);
  // Hors périmètre aussi : le projet du Management BNDMR apparaît, lui aussi sans tâche
  assert.ok(projectsOf(run({ includeOutOfScope: true }).tree).includes(60));
});

test('« Mes chantiers » : chantier vide dont je suis contributeur, projets dont je suis responsable ou sponsor', () => {
  const r = run({ scope: 'chantiers' }, { me: 6 });
  assert.deepEqual(projectsOf(r.tree).sort(), [50, 70]);
  assert.ok(chantierNode(r.tree, 500));
  assert.equal(r.taskIds.size, 0);
  // Projet hors périmètre ISD dont je suis responsable : visible avec son chantier, même sans tâche
  const gus = run({ scope: 'chantiers' }, { me: 7 });
  assert.deepEqual(projectsOf(gus.tree), [60]);
  assert.ok(chantierNode(gus.tree, 600));
  // Contributeur clé d'un projet : tous ses chantiers comptent
  const model = withEmptyProjects();
  model.projects.get(10).contributeursCles.push(5);
  const eve = applyFilters(model, { ...DEFAULT_FILTERS, scope: 'chantiers' }, { ...DEFAULT_PREFS, me: 5 });
  // Projet 10 entier (« (sans chantier) » compris), plus les chantiers où elle a une tâche
  assert.deepEqual([...eve.taskIds].sort(), [1000, 1001, 1002, 1500, 2001, 2010]);
});

test('filtres de tâche (Personne, Profil, Statut) : les éléments sans tâche sont retirés', () => {
  assert.equal(projectsOf(run({ profile: 'DE' }).tree).includes(50), false);
  assert.equal(projectsOf(run({ person: 6 }).tree).includes(50), false);
  assert.equal(projectsOf(run({ statuses: ['todo'] }).tree).includes(50), false);
});

test('Gantt : « Aucune tâche » sur un projet ou un chantier sans enfant, jamais sur une tâche', () => {
  const r = run();
  assert.equal(isEmptyContainer(chantierNode(r.tree, 500)), true);
  const p70 = r.tree.flatMap((c) => c.children).find((p) => p.projectId === 70);
  assert.equal(isEmptyContainer(p70), true);
  assert.equal(isEmptyContainer(chantierNode(r.tree, 200)), false);
  assert.equal(isEmptyContainer({ kind: 'tache', children: [] }), false);
});
