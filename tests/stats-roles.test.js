import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { applyFilters, DEFAULT_FILTERS, DEFAULT_PREFS } from '../widget/js/core/filters.js';
import { ROLE_WINDOW, roleLoad, roleSeries, shiftMonth } from '../widget/js/core/stats-data.js';
import { dayOfIso } from '../widget/js/core/dates.js';
import { feuille } from './fixtures/feuille.js';

const today = dayOfIso('2026-10-20');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
const etp = (hours, days) => hours / ((35 * days) / 7);

/** Modèle du jeu de test, avec seulement les tâches données (id, dates ISO, charges). */
function withTasks(tasks) {
  const m = buildModel(feuille());
  m.tasks.clear();
  for (const t of tasks)
    m.tasks.set(t.id, {
      id: t.id,
      start: t.start ? dayOfIso(t.start) : null,
      end: t.end ? dayOfIso(t.end) : null,
      charges: t.charges,
    });
  return m;
}
const row = (rows, month) => rows.find((r) => r.month === month);

test('décalage de mois, y compris d’une année à l’autre', () => {
  assert.equal(shiftMonth('2026-10', -3), '2026-07');
  assert.equal(shiftMonth('2026-02', -3), '2025-11');
  assert.equal(shiftMonth('2026-10', 8), '2027-06');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
});

test('fenêtre : 3 mois passés, le mois courant et 8 à venir', () => {
  const m = withTasks([{ id: 1, start: '2026-10-01', end: '2026-10-31', charges: [{ personId: 1, heures: 10 }] }]);
  const rows = roleLoad(m, [1], today);
  assert.equal(rows.length, ROLE_WINDOW.before + 1 + ROLE_WINDOW.after);
  assert.equal(rows[0].month, '2026-07');
  assert.equal(rows.at(-1).month, '2027-06');
});

test('un mois entier chargé à 150 h sur 30 jours = 1 ETP', () => {
  const m = withTasks([{ id: 1, start: '2026-11-01', end: '2026-11-30', charges: [{ personId: 1, heures: 150 }] }]);
  const r = row(roleLoad(m, [1], today), '2026-11');
  close(r.DE, 1);
  close(r.total, 1);
  assert.equal(r.PO + r.DA + r.DS + r.Mgmt + r.Autre, 0);
});

test('tâche à cheval sur deux mois : heures au prorata des jours, ETP sur la durée de chaque mois', () => {
  // 25 octobre → 7 novembre : 7 jours de chaque côté, 70 h → 35 h par mois
  const m = withTasks([{ id: 1, start: '2026-10-25', end: '2026-11-07', charges: [{ personId: 1, heures: 70 }] }]);
  const rows = roleLoad(m, [1], today);
  close(row(rows, '2026-10').DE, etp(35, 31));
  close(row(rows, '2026-11').DE, etp(35, 30));
  assert.equal(row(rows, '2026-09').total, 0);
  assert.equal(row(rows, '2026-12').total, 0);
});

test('bornes de la fenêtre : seules les heures des mois affichés comptent', () => {
  // 1er juin → 31 juillet : 61 jours, 61 h → 30 h en juin (hors fenêtre), 31 h en juillet
  const m = withTasks([
    { id: 1, start: '2026-06-01', end: '2026-07-31', charges: [{ personId: 1, heures: 61 }] },
    { id: 2, start: '2027-07-01', end: '2027-07-31', charges: [{ personId: 1, heures: 99 }] },
  ]);
  const rows = roleLoad(m, [1, 2], today);
  close(row(rows, '2026-07').DE, etp(31, 31));
  close(
    rows.reduce((s, r) => s + r.total, 0),
    etp(31, 31),
  );
  assert.deepEqual(roleLoad(m, [2], today), []);
});

test('Management de l’ISD → Mgmt ; Management d’un autre domaine, hors ISD, inconnu → Autre', () => {
  const m = withTasks([
    {
      id: 1,
      start: '2026-11-01',
      end: '2026-11-30',
      charges: [
        { personId: 6, heures: 150 }, // Management, Domaine ISD
        { personId: 7, heures: 150 }, // Management, autre domaine
        { personId: 4, heures: 75 }, // sans rôle, hors ISD
        { personId: 3, heures: 75 }, // DS inactif
        { personId: 99, heures: 30 }, // personne inconnue
        { personId: 2, heures: 30 }, // PO
        { personId: 5, heures: 15 }, // DA
      ],
    },
  ]);
  const r = row(roleLoad(m, [1], today), '2026-11');
  close(r.Mgmt, 1);
  close(r.Autre, 2.2);
  close(r.PO, 0.2);
  close(r.DA, 0.1);
  assert.equal(r.DS, 0);
  close(r.total, 3.5);
});

test('profils tracés : « Autre » seulement s’il a une charge', () => {
  const de = withTasks([{ id: 1, start: '2026-11-01', end: '2026-11-30', charges: [{ personId: 1, heures: 15 }] }]);
  assert.deepEqual(roleSeries(roleLoad(de, [1], today)), ['PO', 'DA', 'DS', 'DE', 'Mgmt']);
  const other = withTasks([{ id: 1, start: '2026-11-01', end: '2026-11-30', charges: [{ personId: 4, heures: 15 }] }]);
  assert.deepEqual(roleSeries(roleLoad(other, [1], today)), ['PO', 'DA', 'DS', 'DE', 'Mgmt', 'Autre']);
  assert.deepEqual(roleSeries([]), ['PO', 'DA', 'DS', 'DE', 'Mgmt']);
});

test('tâches sans dates ou aux dates incohérentes ignorées ; ids inconnus et doublons sans effet', () => {
  const m = withTasks([
    { id: 1, start: null, end: '2026-11-30', charges: [{ personId: 1, heures: 15 }] },
    { id: 2, start: '2026-11-30', end: '2026-11-01', charges: [{ personId: 1, heures: 15 }] },
    { id: 3, start: '2026-11-01', end: '2026-11-30', charges: [{ personId: 1, heures: 15 }] },
  ]);
  assert.deepEqual(roleLoad(m, [1, 2], today), []);
  close(row(roleLoad(m, [3, 3, 404], today), '2026-11').DE, 0.1);
});

test('filtres : seules les tâches visibles comptent', () => {
  const m = buildModel(feuille());
  const all = roleLoad(m, [...applyFilters(m, DEFAULT_FILTERS, DEFAULT_PREFS).taskIds], today);
  assert.ok(row(all, '2026-11').DE > 0);
  const view = applyFilters(m, { ...DEFAULT_FILTERS, person: 5 }, DEFAULT_PREFS);
  assert.ok(!view.taskIds.has(1002));
  const eve = row(roleLoad(m, [...view.taskIds], today), '2026-11');
  assert.equal(eve.DE, 0);
  close(eve.DA, etp(14, 30));
});
