/** Filtres « + Filtres » (Responsable, Demandeur) et choix de la personne « Je suis… ». */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import {
  activeFilterChips,
  applyFilters,
  choosePerson,
  DEFAULT_FILTERS,
  DEFAULT_PREFS,
  EXTRA_FILTERS,
  filterChoices,
  loadPrefs,
  PREFS_KEY,
  shouldPromptMe,
  splitDemandeurs,
  validFilters,
} from '../widget/js/core/filters.js';
import { feuille } from './fixtures/feuille.js';

/** Fixture enrichie : responsables de tâche, responsable de projet (Fanny, 6) et demandeurs en texte libre. */
function enriched() {
  const raw = feuille();
  const t = raw.tables;
  const col = (table, name, byId) => {
    table[name] = table.id.map((id) => (id in byId ? byId[id] : (table[name]?.[table.id.indexOf(id)] ?? null)));
  };
  col(t.Tasks, 'Responsable', { 2001: 5, 1001: 1 });
  col(t.Projects, 'responsable', { 10: 6 });
  col(t.Projects, 'Commanditaires', { 10: 'DSN & DST', 20: 'DIM', 30: 'DST ; Direction', 40: 'Hors' });
  return buildModel(raw);
}
const m = enriched();
const run = (f = {}, p = {}) => applyFilters(m, { ...DEFAULT_FILTERS, ...f }, { ...DEFAULT_PREFS, ...p });
const ids = (r) => [...r.taskIds].sort((a, b) => a - b);

test('demandeurs : texte libre découpé, espaces et doublons (accents, casse) retirés', () => {
  assert.deepEqual(splitDemandeurs('DSN & DST'), ['DSN', 'DST']);
  assert.deepEqual(splitDemandeurs(' PSCC,  COPIL  Données ;dst\nDST '), ['PSCC', 'COPIL Données', 'dst']);
  assert.deepEqual(splitDemandeurs(''), []);
  assert.deepEqual(splitDemandeurs(null), []);
});

test('filtre Demandeur : projets dont le demandeur correspond, casse ignorée', () => {
  assert.deepEqual(ids(run({ demandeur: 'DIM' })), [2000, 2001, 2010]);
  // « dst » (casse ignorée) : demandeur de Données Socle (DSN & DST) et de BI Gestion (DST ; Direction)
  assert.deepEqual(ids(run({ demandeur: 'dst' })), [1000, 1001, 1002, 1500, 2010, 3000]);
  assert.equal(run({ demandeur: 'Inconnu' }).taskIds.size, 0);
});

test('filtre Responsable : projet, chantier ou tâche, descendants compris', () => {
  // Bob (2) responsable du chantier 100 et du projet ChatDPI (20) : toutes leurs tâches et sous-tâches
  assert.deepEqual(ids(run({ responsable: 2 })), [1000, 1001, 1002, 2000, 2001, 2010]);
  // Alice (1) : chantier 200 (tâche 2000) et sous-tâche 1001 (responsable de la tâche)
  assert.deepEqual(ids(run({ responsable: 1 })), [1001, 2000]);
  // Eve (5) : tâche sans chantier
  assert.deepEqual(ids(run({ responsable: 5 })), [2001]);
  // Combiné à un autre filtre de tâche
  assert.deepEqual(ids(run({ responsable: 2, statuses: ['done'] })), [1001]);
});

test('filtre Responsable : responsable du projet seulement (Projects.responsable)', () => {
  // Fanny (6) n'est responsable que du projet Données Socle (10) : toutes ses tâches, chantier virtuel compris
  assert.deepEqual(ids(run({ responsable: 6 })), [1000, 1001, 1002, 1500]);
  // Dora (4) : projet BI Gestion (30, chantier partagé compris) ; projet hors périmètre (40) si la case est cochée
  assert.deepEqual(ids(run({ responsable: 4 })), [2010, 3000]);
  assert.deepEqual(ids(run({ responsable: 4, includeOutOfScope: true })), [2010, 3000, 4001]);
});

test('choix de « + Filtres » : responsables par nom et demandeurs triés, limités aux projets proposés', () => {
  const c = filterChoices(m, { ...DEFAULT_FILTERS }, { ...DEFAULT_PREFS });
  assert.deepEqual(
    c.responsables.map((p) => p.nom),
    ['Alice DE', 'Bob PO', 'Dora (hors ISD)', 'Eve DA', 'Fanny Manager'],
  );
  // Responsable de projet seulement : retiré quand son projet est masqué
  const noSocle = filterChoices(m, { ...DEFAULT_FILTERS }, { ...DEFAULT_PREFS, hiddenProjects: [10] });
  assert.ok(!noSocle.responsables.some((p) => p.nom === 'Fanny Manager'));
  assert.deepEqual(c.demandeurs, ['DIM', 'Direction', 'DSN', 'DST']);
  // Projet masqué : ses demandeurs disparaissent ; hors périmètre seulement si la case est cochée
  const hidden = filterChoices(m, { ...DEFAULT_FILTERS }, { ...DEFAULT_PREFS, hiddenProjects: [30] });
  assert.ok(!hidden.demandeurs.includes('Direction'));
  assert.ok(!c.demandeurs.includes('Hors'));
  const out = filterChoices(m, { ...DEFAULT_FILTERS, includeOutOfScope: true }, { ...DEFAULT_PREFS });
  assert.ok(out.demandeurs.includes('Hors'));
});

test('filtres valides : responsable inconnu et demandeur absent retirés, sinon objet inchangé', () => {
  const f = { ...DEFAULT_FILTERS, responsable: 2, demandeur: 'dim' };
  assert.equal(validFilters(m, f), f);
  assert.deepEqual(validFilters(m, { ...DEFAULT_FILTERS, responsable: 999 }), DEFAULT_FILTERS);
  assert.deepEqual(validFilters(m, { ...DEFAULT_FILTERS, demandeur: 'Personne' }), DEFAULT_FILTERS);
});

test('étiquettes : responsable (nom) et demandeur', () => {
  const chips = activeFilterChips({ ...DEFAULT_FILTERS, responsable: 2, demandeur: 'DIM' }, m);
  assert.deepEqual(chips, [
    { field: 'responsable', label: 'Bob PO' },
    { field: 'demandeur', label: 'DIM' },
  ]);
  assert.deepEqual(activeFilterChips({ ...DEFAULT_FILTERS, responsable: 999 }, m), [
    { field: 'responsable', label: '999' },
  ]);
  assert.deepEqual(EXTRA_FILTERS, ['responsable', 'demandeur', 'tag']);
  assert.deepEqual(activeFilterChips({ ...DEFAULT_FILTERS, tag: 'atelier' }, m), [{ field: 'tag', label: 'atelier' }]);
});

const store = (value) => ({ getItem: (k) => (k === PREFS_KEY ? JSON.stringify(value) : null), setItem() {} });

test('préférences : nouveaux filtres assainis, anciennes préférences migrées sans casse', () => {
  const p = loadPrefs(store({ filters: { responsable: '2', demandeur: 42 } }));
  assert.equal(p.filters.responsable, null);
  assert.equal(p.filters.demandeur, '');
  const q = loadPrefs(store({ filters: { responsable: 2, demandeur: '  DIM ' } }));
  assert.equal(q.filters.responsable, 2);
  assert.equal(q.filters.demandeur, 'DIM');
  // Ancien enregistrement avec une personne : l'invite ne s'affiche pas, la case décochée donne « Tout »
  const old = loadPrefs(store({ me: 5, filters: { mine: false } }));
  assert.equal(old.mePrompted, true);
  assert.equal(old.filters.scope, 'all');
  assert.equal(shouldPromptMe(old), false);
  // Ancien enregistrement sans personne, ou stockage vide : invite affichée une fois
  assert.equal(loadPrefs(store({ theme: 'dark' })).mePrompted, false);
  assert.equal(shouldPromptMe(loadPrefs(store({}))), true);
  assert.equal(loadPrefs(store({ mePrompted: 'oui' })).mePrompted, false);
  assert.equal(shouldPromptMe(loadPrefs(store({ mePrompted: true }))), false);
});

test('« Je suis… » : première personne choisie → périmètre « Mes chantiers » ; changement de personne → choix gardé', () => {
  const start = { ...DEFAULT_PREFS, filters: { ...DEFAULT_FILTERS } };
  const a = choosePerson(start, 5, m.people.get(5));
  assert.equal(a.me, 5);
  assert.equal(a.mePrompted, true);
  assert.equal(a.filters.scope, 'chantiers');
  // Eve (5) : le chantier partagé, où elle a une tâche, et sa tâche sans chantier
  assert.deepEqual(ids(applyFilters(m, a.filters, a)), [2001, 2010]);
  // L'utilisateur choisit « Tout », puis change de personne : le périmètre reste « Tout »
  const all = { ...a, filters: { ...a.filters, scope: 'all' } };
  assert.equal(choosePerson(all, 1, m.people.get(1)).filters.scope, 'all');
  // Changement de personne avec « Mes chantiers » : le filtre suit la nouvelle personne
  const b = choosePerson(a, 1, m.people.get(1));
  assert.equal(b.filters.scope, 'chantiers');
  assert.deepEqual(ids(applyFilters(m, b.filters, b)), [1000, 1001, 1002, 2000]);
  // Plus personne : périmètre « Tout », invite pas réaffichée
  const none = choosePerson(b, null);
  assert.equal(none.me, null);
  assert.equal(none.filters.scope, 'all');
  assert.equal(shouldPromptMe(none), false);
  assert.equal(choosePerson(start, Number.NaN).me, null);
  // Les préférences d'origine ne sont pas modifiées
  assert.equal(start.me, null);
});

test('« Je suis… » : premier choix → vue d’accueil et périmètre du profil, une seule fois', () => {
  const start = { ...DEFAULT_PREFS, filters: { ...DEFAULT_FILTERS } };
  // DE, DA : onglet Mes tâches, périmètre Mes chantiers ; personne inconnue : pareil
  for (const id of [1, 5, 999]) {
    const p = choosePerson(start, id, m.people.get(id));
    assert.equal(p.homeView, 'mytasks');
    assert.equal(p.view, 'mytasks');
    assert.equal(p.filters.scope, 'chantiers');
  }
  // PO : Gantt au niveau des tâches, Mes chantiers
  const po = choosePerson(start, 2, m.people.get(2));
  assert.deepEqual([po.homeView, po.view, po.ganttLevel, po.filters.scope], ['gantt', 'gantt', 'tache', 'chantiers']);
  // Management : Synthèse, sans périmètre
  const mg = choosePerson(start, 6, m.people.get(6));
  assert.deepEqual([mg.homeView, mg.view, mg.filters.scope], ['synthesis', 'synthesis', 'all']);
  // Vue d'accueil déjà choisie : ni elle ni l'onglet courant ne changent
  const later = choosePerson({ ...po, view: 'table' }, 1, m.people.get(1));
  assert.deepEqual([later.homeView, later.view], ['gantt', 'table']);
  // Retour à « personne » puis nouveau choix : périmètre du profil reposé, vue d'accueil gardée
  const again = choosePerson(choosePerson(po, null), 1, m.people.get(1));
  assert.deepEqual([again.homeView, again.filters.scope], ['gantt', 'chantiers']);
});
