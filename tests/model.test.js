import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { isoOfDay } from '../widget/js/core/dates.js';
import { feuille } from './fixtures/feuille.js';

const m = buildModel(feuille());
const titles = (nodes) => nodes.map((n) => n.title);

test('personnes ISD : rôles DE/DA/DS/PO Data actifs seulement', () => {
  assert.deepEqual(
    [...m.people.values()].filter((p) => p.isd).map((p) => p.id),
    [1, 2, 5],
  );
  assert.equal(m.people.get(2).role, 'PO');
  assert.equal(m.people.get(3).isd, false);
  assert.deepEqual(
    m.people.get(1).unavailability.map((u) => isoOfDay(u.start)),
    ['2026-11-02'],
  );
});

test('produit de données : catégorie → projet → chantier → tâche → sous-tâches, sans cas particulier', () => {
  const cat = m.tree.find((f) => f.title === 'Produit de données');
  assert.equal(cat.kind, 'categorie');
  assert.equal(cat.key, 'C:Produit de données');
  assert.deepEqual(titles(cat.children), ['Données Socle Commun EDS']);
  const projet = cat.children[0];
  assert.equal(projet.kind, 'projet');
  assert.deepEqual(projet.ref, { table: 'Projects', id: 10 });
  assert.equal(projet.parentKey, cat.key);
  assert.deepEqual(titles(projet.children), ['Produit de Données Patient', '(sans chantier)']);
  const chantier = projet.children[0];
  assert.equal(chantier.kind, 'chantier');
  assert.equal(chantier.key, 'P10/C100');
  assert.deepEqual(chantier.ref, { table: 'Chantiers', id: 100 });
  const tache = chantier.children[0];
  assert.equal(tache.kind, 'tache');
  assert.equal(tache.key, 'P10/C100/T1000');
  assert.equal(tache.title, 'Ajout table FHIR Adresse');
  assert.deepEqual(tache.ref, { table: 'Tasks', id: 1000 });
  assert.deepEqual(titles(tache.children), ['instruction', 'réalisation']);
  assert.deepEqual(
    tache.children.map((n) => [n.kind, n.key, n.parentKey, n.projectId]),
    [
      ['sous-tache', 'P10/C100/T1000/T1001', 'P10/C100/T1000', 10],
      ['sous-tache', 'P10/C100/T1000/T1002', 'P10/C100/T1000', 10],
    ],
  );
  assert.equal(isoOfDay(tache.span.start), '2026-09-07');
  assert.equal(isoOfDay(tache.span.end), '2026-11-08');
  // Tâche d'un produit de données sans chantier : sous « (sans chantier) » comme pour tout projet
  assert.deepEqual(titles(projet.children[1].children), ['Produit sans chantier']);
  assert.equal(projet.children[1].key, 'P10/C0');
  assert.equal(projet.children[1].ref, null);
});

test('autres catégories : même forme, chantier virtuel « (sans chantier) »', () => {
  const cat = m.tree.find((f) => f.title === 'Projet');
  const projet = cat.children[0];
  assert.equal(projet.kind, 'projet');
  assert.deepEqual(projet.ref, { table: 'Projects', id: 20 });
  assert.deepEqual(titles(projet.children), ['Chantier partagé', 'WP1 : Modèle LLM', '(sans chantier)']);
  assert.deepEqual(
    projet.children.map((n) => n.kind),
    ['chantier', 'chantier', 'chantier'],
  );
  assert.deepEqual(titles(projet.children[2].children), ['Tâche sans chantier']);
  assert.equal(projet.children[2].children[0].kind, 'tache');
});

test('genres de nœuds : seulement les cinq niveaux de la Feuille', () => {
  assert.deepEqual([...new Set([...m.nodes.values()].map((n) => n.kind))].sort(), [
    'categorie',
    'chantier',
    'projet',
    'sous-tache',
    'tache',
  ]);
});

test('projet sans catégorie : « Sans catégorie »', () => {
  const raw = feuille();
  raw.tables.Projects.Categorie[3] = '';
  const mm = buildModel(raw);
  const cat = mm.tree.find((f) => f.title === 'Sans catégorie');
  assert.equal(cat.key, 'C:Sans catégorie');
  assert.deepEqual(titles(cat.children), ['Projet hors ISD']);
});

test('périmètre ISD', () => {
  assert.equal(m.projects.get(10).inScope, true);
  assert.equal(m.projects.get(20).inScope, true);
  assert.equal(m.projects.get(40).inScope, false);
  assert.equal(m.projects.get(30).inScope, true); // via le chantier partagé (tâche 2010 assignée à Eve)
});

test('chantier partagé : deux nœuds, une seule tâche', () => {
  const nodes = [...m.nodes.values()].filter((n) => n.taskId === 2010);
  assert.equal(nodes.length, 2);
  assert.equal(new Set(nodes.map((n) => n.key)).size, 2);
  assert.equal(m.tasks.get(2010).charges.length, 1); // teamId 99 inconnu écarté
});

test('anomalies', () => {
  const k = (kind) =>
    m.issues
      .filter((i) => i.kind === kind)
      .map((i) => i.taskId ?? i.chantierId)
      .sort();
  assert.deepEqual(k('charges-invalides'), [2000]);
  assert.deepEqual(k('charge-personne-inconnue'), [2010]);
  assert.deepEqual(k('charge-sans-dates'), [2001]);
  assert.deepEqual(k('dates-incoherentes'), [3000]);
  assert.deepEqual(k('tache-orpheline'), [4000]);
  assert.deepEqual(k('chantier-sans-responsable'), [201]);
  assert.deepEqual(k('tache-sans-chantier'), []); // plus de cas particulier : rangée sous « (sans chantier) »
  assert.deepEqual(k('parent-introuvable'), [1600]);
});

test('statuts lus dans la Feuille', () => {
  assert.deepEqual(m.statuses.tasks, ['todo', 'inprogress', 'review', 'done', 'Bloqué']);
  assert.equal(m.tasks.get(1001).done, true);
});

test('disponibilités en pourcentage ramenées à [0,1]', () => {
  const u = m.people.get(5).unavailability;
  assert.equal(u.length, 1);
  assert.equal(u[0].dispo, 0.5);
});

test('catégorie « Produit » (nom de catégorie de la Feuille) et nombre de catégories', () => {
  assert.deepEqual(titles(m.tree.find((f) => f.title === 'Produit').children), ['BI Gestion', 'Projet hors ISD']);
  assert.deepEqual(titles(m.tree), ['Produit', 'Produit de données', 'Projet']);
});

test('priorité de la tâche : texte nettoyé, vide si absente', () => {
  const m = buildModel(feuille());
  assert.equal(m.tasks.get(1002).priorite, '1');
  assert.equal(m.tasks.get(1001).priorite, '');
});
