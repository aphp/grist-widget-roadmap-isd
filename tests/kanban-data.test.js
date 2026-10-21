import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { applyFilters, DEFAULT_FILTERS, DEFAULT_PREFS } from '../widget/js/core/filters.js';
import {
  etpRoleParts,
  kanbanColumns,
  taskEtp,
  taskEtpByRole,
  taskPriority,
  taskPaths,
} from '../widget/js/core/kanban-data.js';
import { feuille } from './fixtures/feuille.js';
import { fteHours } from '../widget/js/core/capacity.js';
import { dayOfIso } from '../widget/js/core/dates.js';

const m = buildModel(feuille());
const view = applyFilters(m, DEFAULT_FILTERS, DEFAULT_PREFS);
const ids = (col) => col.tasks;
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
// 1 ETP = capacité standard de la période : 1002 du 26 octobre au 8 novembre 2026 (10 jours ouvrés), 2010 du 2 au 6
const F1002 = fteHours(dayOfIso('2026-10-26'), dayOfIso('2026-11-08'));
const F2010 = fteHours(dayOfIso('2026-11-02'), dayOfIso('2026-11-06'));

test('ETP : 70 h ÷ capacité standard de la période (≈ 1,2) ; null sans dates', () => {
  assert.equal(taskEtp(m.tasks.get(1002)), 70 / F1002);
  // Période sans jour ouvré (un samedi et un dimanche) : comme sans dates
  assert.equal(taskEtp({ ...m.tasks.get(1002), start: dayOfIso('2026-11-07'), end: dayOfIso('2026-11-08') }), null);
  assert.equal(taskEtp(m.tasks.get(2001)), null);
  assert.equal(taskEtp(m.tasks.get(1000)), null);
  assert.equal(taskEtp(m.tasks.get(1001)), 0);
});

test('ETP : dates incohérentes → null', () => {
  assert.equal(taskEtp(m.tasks.get(3000)), null);
});

test('regroupement par statut : ordre du cycle de vie, colonnes vides conservées', () => {
  const cols = kanbanColumns(m, view.taskIds, 'status', 'title-asc');
  assert.deepEqual(
    cols.map((c) => c.key),
    ['todo', 'inprogress', 'review', 'Bloqué', 'done'],
  );
  assert.deepEqual(ids(cols[1]), [1002]);
  assert.deepEqual(ids(cols[4]), [1001]);
  assert.deepEqual(ids(cols[2]), []);
  assert.deepEqual(ids(cols[3]), []);
  assert.equal(cols[0].label, 'À faire');
  const all = cols.flatMap(ids);
  assert.equal(new Set(all).size, all.length);
  assert.equal(all.length, view.taskIds.size);
});

test('statut hors liste : colonne « Sans statut » ajoutée', () => {
  const odd = {
    ...m,
    tasks: new Map([
      [1000, { ...m.tasks.get(1000), status: 'Inconnu' }],
      [1001, m.tasks.get(1001)],
    ]),
  };
  const cols = kanbanColumns(odd, new Set([1000, 1001]), 'status', 'title-asc');
  assert.deepEqual(cols.at(-1).tasks, [1000]);
  assert.equal(cols.at(-1).key, 'Inconnu');
});

test('tri : titre A→Z, Z→A, échéance (sans date à la fin)', () => {
  const todo = (sort) => kanbanColumns(m, view.taskIds, 'status', sort)[0].tasks;
  assert.deepEqual(
    todo('title-asc'),
    [2000, 2010, 3000, 2001, 1000, 1500].sort((a, b) => cmp(a, b)),
  );
  assert.deepEqual(todo('title-desc'), todo('title-asc').slice().reverse());
  const due = todo('due');
  assert.deepEqual(
    due.slice(0, 2),
    [2010, 3000].sort((a, b) => m.tasks.get(a).end - m.tasks.get(b).end),
  );
  assert.ok(due.indexOf(2010) < due.indexOf(1000));
});
function cmp(a, b) {
  return m.tasks.get(a).title.localeCompare(m.tasks.get(b).title, 'fr', { sensitivity: 'base' });
}

test('regroupement par chantier : une tâche = une colonne, sans chantier à part', () => {
  const cols = kanbanColumns(m, view.taskIds, 'chantier', 'title-asc');
  const byLabel = Object.fromEntries(cols.map((c) => [c.label, c.tasks]));
  assert.deepEqual(byLabel['Reporting'], [3000]);
  assert.deepEqual(byLabel['Chantier partagé'], [2010]);
  assert.ok(byLabel['(sans chantier)'].includes(2001));
  assert.equal(cols.flatMap(ids).length, view.taskIds.size);
});

test('priorité : celle de la tâche, sinon du chantier, sinon du projet ; colonne « Sans priorité » en dernier', () => {
  assert.equal(taskPriority(m, m.tasks.get(1002)), '1'); // propre à la tâche
  assert.equal(taskPriority(m, m.tasks.get(2000)), '3'); // la tâche prime sur le chantier (P3)
  assert.equal(taskPriority(m, m.tasks.get(1600)), 'P3'); // sans priorité de tâche : chantier 200
  assert.equal(taskPriority(m, m.tasks.get(2001)), 'Priorité 1'); // sans chantier : projet
  assert.equal(taskPriority(m, m.tasks.get(3000)), ''); // aucune
  assert.equal(taskPriority(m, m.tasks.get(1001)), ''); // ni tâche, ni chantier 100, ni produit de données
  const cols = kanbanColumns(m, view.taskIds, 'priority', 'title-asc');
  assert.deepEqual(
    cols.map((c) => c.label),
    ['Priorité 1', 'Priorité 3', 'Sans priorité'],
  );
});

test('ETP par rôle : 1002 → DE 1,2 ; 2010 → DA 0,48 (charge de personne inconnue ignorée)', () => {
  const a = taskEtpByRole(m.tasks.get(1002), m);
  assert.deepEqual(a, { total: 70 / F1002, PO: 0, DA: 0, DS: 0, DE: 70 / F1002, Mgmt: 0, Autre: 0 });
  const b = taskEtpByRole(m.tasks.get(2010), m);
  near(b.DA, 14 / F2010);
  assert.equal(b.total, b.DA);
  assert.equal(b.DE, 0);
});

test('ETP par rôle : personne hors ISD ou sans rôle → « Autre » ; null sans dates valides', () => {
  const task = {
    ...m.tasks.get(1002),
    charges: [
      { personId: 1, heures: 35 },
      { personId: 4, heures: 35 },
      { personId: 3, heures: 35 },
    ],
  };
  const r = taskEtpByRole(task, m);
  assert.equal(r.DE, 35 / F1002);
  assert.equal(r.Autre, 2 * r.DE); // Dora (sans rôle) et Carl (DS inactif, donc hors ISD)
  assert.equal(r.DS, 0);
  assert.equal(r.total, 3 * r.DE);
  assert.equal(taskEtpByRole(m.tasks.get(2001), m), null);
  assert.equal(taskEtpByRole(m.tasks.get(3000), m), null);
  assert.equal(taskEtpByRole({ ...task, start: dayOfIso('2026-11-07'), end: dayOfIso('2026-11-08') }, m), null);
  assert.equal(taskEtpByRole(m.tasks.get(1001), m).total, 0);
});

test('chemin « projet › chantier » (› tâche pour une sous-tâche) et dédoublonnage des chantiers partagés', () => {
  const paths = taskPaths(view.tree);
  assert.deepEqual(paths.get(1000).path, ['Données Socle Commun EDS', 'Produit de Données Patient']);
  assert.deepEqual(paths.get(1002).path, [
    'Données Socle Commun EDS',
    'Produit de Données Patient',
    'Ajout table FHIR Adresse',
  ]);
  assert.deepEqual(paths.get(1500).path, ['Données Socle Commun EDS', '(sans chantier)']);
  assert.equal(paths.get(2010).path.at(-1), 'Chantier partagé');
  assert.equal(paths.get(2010).path[0], 'BI Gestion'); // premier nœud de l'arbre
  assert.equal(paths.size, view.taskIds.size);
});

test('entrée vide', () => {
  assert.deepEqual(
    kanbanColumns(m, new Set(), 'status', 'due').map((c) => c.tasks.length),
    [0, 0, 0, 0, 0],
  );
});

test('ETP par rôle : Management de l’ISD → « Mgmt » ; Management d’un autre domaine → « Autre »', () => {
  const task = {
    ...m.tasks.get(1002),
    charges: [
      { personId: 6, heures: 35 }, // Fanny, Management, Domaine ISD
      { personId: 7, heures: 70 }, // Gus, Management, BNDMR
      { personId: 1, heures: 35 }, // Alice, DE
    ],
  };
  assert.equal(m.people.get(6).roleText, 'Management');
  const r = taskEtpByRole(task, m);
  const unit = 35 / F1002;
  assert.equal(r.Mgmt, unit);
  assert.equal(r.Autre, 2 * unit);
  assert.equal(r.DE, unit);
  assert.equal(r.total, 4 * unit);
  assert.deepEqual(
    etpRoleParts(r).map((p) => p.key),
    ['DE', 'Mgmt', 'Autre'],
  );
  // Sans Domaine ISD identifiable, aucun Management n'est de l'équipe ISD
  const other = buildModel({ ...feuille() });
  for (const p of other.people.values()) if (!p.role) p.domaine = 'Ailleurs';
  assert.equal(taskEtpByRole(task, other).Mgmt, 0);
});

test('ventilation affichée : parts qui s’afficheraient « 0,0 » masquées, ordre PO DA DS DE Mgmt Autre', () => {
  const by = { total: 1.6, PO: 0.04, DA: 0.5, DS: 0, DE: 1.0, Mgmt: 0.3, Autre: 0.06 };
  assert.deepEqual(etpRoleParts(by), [
    { key: 'DA', text: '0,5' },
    { key: 'DE', text: '1,0' },
    { key: 'Mgmt', text: '0,3' },
    { key: 'Autre', text: '0,1' },
  ]);
  assert.deepEqual(etpRoleParts({ total: 0.02, PO: 0.02, DA: 0, DS: 0, DE: 0, Mgmt: 0, Autre: 0 }), []);
  assert.deepEqual(etpRoleParts(null), []);
  assert.deepEqual(etpRoleParts(taskEtpByRole(m.tasks.get(1002), m)), [{ key: 'DE', text: '1,2' }]);
});
