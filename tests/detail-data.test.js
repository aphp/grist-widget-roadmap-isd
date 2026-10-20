import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskPeopleRows } from '../widget/js/core/kanban-data.js';
import { buildModel } from '../widget/js/core/model.js';
import {
  breadcrumb,
  chantierItems,
  dependents,
  detailLevel,
  projectItems,
  safeLink,
  splitEmptyFields,
} from '../widget/js/core/detail-data.js';
import { feuille } from './fixtures/feuille.js';

const m = buildModel(feuille());
const T = (id) => ({ table: 'Tasks', id });
const C = (id) => ({ table: 'Chantiers', id });
const P = (id) => ({ table: 'Projects', id });

test('niveau du widget = niveau de la Feuille, sans cas particulier (spec §4.2)', () => {
  assert.equal(detailLevel(m, P(10)), 'projet'); // y compris un produit de données
  assert.equal(detailLevel(m, P(20)), 'projet');
  assert.equal(detailLevel(m, C(100)), 'chantier');
  assert.equal(detailLevel(m, C(200)), 'chantier');
  assert.equal(detailLevel(m, T(1000)), 'tache');
  assert.equal(detailLevel(m, T(1002)), 'sous-tache');
  assert.equal(detailLevel(m, T(2010)), 'tache');
  assert.equal(detailLevel(m, T(4000)), 'tache');
  assert.equal(detailLevel(m, T(424242)), null);
  assert.equal(detailLevel(m, P(424242)), null);
  assert.equal(detailLevel(m, { table: 'Team', id: 1 }), 'personne');
  assert.equal(detailLevel(m, { table: 'Team', id: 424242 }), null);
  assert.equal(detailLevel(m, C(424242)), null);
  assert.equal(detailLevel(m, { table: 'Autre', id: 1 }), null);
});

test('sous-tâche : niveau « sous-tache » à toute profondeur', () => {
  const raw = feuille();
  const t = raw.tables.Tasks;
  t.id.push(2020, 2021);
  for (const k of Object.keys(t)) if (k !== 'id') t[k].push(null, null);
  const n = t.id.length;
  t.titre[n - 2] = 'Sous-tâche';
  t.parentTask[n - 2] = 2010;
  t.projet[n - 2] = 20;
  t.titre[n - 1] = 'Sous-sous-tâche';
  t.parentTask[n - 1] = 2020;
  const mm = buildModel(raw);
  assert.equal(detailLevel(mm, T(2020)), 'sous-tache');
  assert.equal(detailLevel(mm, T(2021)), 'sous-tache');
  assert.deepEqual(
    breadcrumb(mm, T(2020)).map((c) => c.kind),
    ['categorie', 'projet', 'chantier', 'tache'],
  );
  assert.deepEqual(
    breadcrumb(mm, T(2021)).map((c) => c.kind),
    ['categorie', 'projet', 'chantier', 'tache', 'sous-tache'],
  );
});

test('fil d’Ariane catégorie → projet → chantier → tâche, avec les références cliquables', () => {
  // Sous-tâche d'un produit de données : même forme que partout ailleurs
  assert.deepEqual(breadcrumb(m, T(1001)), [
    { kind: 'categorie', title: 'Produit de données', ref: null },
    { kind: 'projet', title: 'Données Socle Commun EDS', ref: P(10) },
    { kind: 'chantier', title: 'Produit de Données Patient', ref: C(100) },
    { kind: 'tache', title: 'Ajout table FHIR Adresse', ref: T(1000) },
  ]);
  assert.deepEqual(breadcrumb(m, T(2010)), [
    { kind: 'categorie', title: 'Produit', ref: null }, // chantier partagé : premier emplacement (BI Gestion)
    { kind: 'projet', title: 'BI Gestion', ref: P(30) },
    { kind: 'chantier', title: 'Chantier partagé', ref: C(201) },
  ]);
  assert.deepEqual(breadcrumb(m, T(2001)).at(-1), { kind: 'chantier', title: '(sans chantier)', ref: null });
  assert.deepEqual(breadcrumb(m, C(200)), [
    { kind: 'categorie', title: 'Projet', ref: null },
    { kind: 'projet', title: 'ChatDPI', ref: P(20) },
  ]);
  assert.deepEqual(breadcrumb(m, P(10)), [{ kind: 'categorie', title: 'Produit de données', ref: null }]);
  assert.deepEqual(breadcrumb(m, T(4000)), []); // orpheline : hors de l'arbre
});

test('personnes de la fiche (liste unique) : heures, ETP, profil ; null sans dates', () => {
  const rows = taskPeopleRows(m, m.tasks.get(1002)).filter((r) => r.hours !== null);
  assert.deepEqual(
    rows.map((r) => [r.personId, r.person.nom, r.person.role, r.hours, r.etp]),
    [[1, 'Alice DE', 'DE', 70, 1]],
  );
  const r = taskPeopleRows(m, m.tasks.get(2001)).find((x) => x.hours !== null);
  assert.equal(r.etp, null);
  assert.equal(r.hours, 7);
});

test('éléments d’un chantier et d’un projet ; dépendants', () => {
  assert.deepEqual(chantierItems(m, 100), [1000]);
  assert.deepEqual(chantierItems(m, 201), [2010]);
  assert.deepEqual(projectItems(m, 20), [
    { table: 'Chantiers', id: 201 },
    { table: 'Chantiers', id: 200 },
  ]);
  const raw = feuille();
  const t = raw.tables.Tasks;
  t.dependDe = t.id.map((id) => (id === 2010 ? ['L', 2001] : null));
  assert.deepEqual(dependents(buildModel(raw), 2001), [2010]);
  assert.deepEqual(dependents(m, 2001), []);
});

test('lien utile : http(s) seulement', () => {
  assert.equal(safeLink('https://exemple.fr/a?b=1'), 'https://exemple.fr/a?b=1');
  assert.equal(safeLink('  http://x.fr '), 'http://x.fr/');
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(safeLink('voir le wiki'), null);
  assert.equal(safeLink(''), null);
});

test('splitEmptyFields : champs vides regroupés, ordre conservé', () => {
  const { filled, empty } = splitEmptyFields([
    ['a', 'x'],
    ['b', null],
    ['c', ''],
    ['d', 0],
    ['e', undefined],
    ['f', 'y'],
  ]);
  assert.deepEqual(filled, [
    ['a', 'x'],
    ['d', 0],
    ['f', 'y'],
  ]);
  assert.deepEqual(empty, ['b', 'c', 'e']);
  assert.deepEqual(splitEmptyFields([]), { filled: [], empty: [] });
});
