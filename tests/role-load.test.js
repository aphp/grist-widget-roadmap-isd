import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { applyFilters, DEFAULT_FILTERS, DEFAULT_PREFS } from '../widget/js/core/filters.js';
import {
  RATE_TENSION,
  byHoursDesc,
  loadRate,
  profileHeadcount,
  roleLoad,
  segmentMove,
  segmentTasks,
  summarizeMonths,
} from '../widget/js/core/role-load.js';
import { dayOfIso, monthRange } from '../widget/js/core/dates.js';
import { fteHours, personMonthCapacity } from '../widget/js/core/capacity.js';
import { feuille } from './fixtures/feuille.js';

const today = dayOfIso('2026-10-20');
const close = (a, b, msg = '') => assert.ok(Math.abs(a - b) < 1e-6, `${msg} ${a} ≠ ${b}`);
const monthFte = (ym) => fteHours(monthRange(ym).start, monthRange(ym).end);
const NOV = monthFte('2026-11');

function withTasks(tasks) {
  const m = buildModel(feuille());
  m.tasks.clear();
  for (const t of tasks)
    m.tasks.set(t.id, {
      id: t.id,
      title: t.title ?? `Tâche ${t.id}`,
      start: t.start ? dayOfIso(t.start) : null,
      end: t.end ? dayOfIso(t.end) : null,
      charges: t.charges,
    });
  return m;
}
const row = (rows, month) => rows.find((r) => r.month === month);

test('taux : ok, tension, dépassement ; capacité nulle', () => {
  assert.equal(RATE_TENSION, 0.85);
  assert.deepEqual(loadRate(0, 0), { rate: null, level: 'none' });
  assert.deepEqual(loadRate(5, 0), { rate: null, level: 'over' });
  assert.equal(loadRate(8, 10).level, 'ok');
  assert.equal(loadRate(8.5, 10).level, 'tension');
  assert.equal(loadRate(10, 10).level, 'tension');
  assert.equal(loadRate(10.1, 10).level, 'over');
  assert.equal(loadRate(0, 10).level, 'ok');
  assert.equal(loadRate(3, 10).rate, 0.3);
});

test('capacité par profil et par mois : personnes actives du profil, quotité et indisponibilités comprises', () => {
  const m = withTasks([{ id: 1, start: '2026-11-01', end: '2026-11-30', charges: [{ personId: 1, heures: NOV }] }]);
  const r = row(roleLoad(m, [1], today), '2026-11');
  const cap = (id) => personMonthCapacity(m.people.get(id), '2026-11');
  close(r.capacityHours.DE, cap(1), 'DE (Alice, indisponible du 2 au 6 novembre)');
  assert.ok(r.capacityHours.DE < NOV);
  close(r.capacityHours.DA, cap(5), 'DA (Eve, 28 h)');
  close(r.capacityHours.PO, cap(2), 'PO');
  close(r.capacityHours.Mgmt, cap(6), 'Mgmt (Fanny seulement, pas Gus du BNDMR)');
  assert.equal(r.capacityHours.DS, 0); // Carl inactif
  assert.equal('Autre' in r.capacityHours, false);
  // En ETP : 1 ETP = capacité standard du mois
  close(r.fte, NOV);
  close(r.capacity.DE, cap(1) / NOV);
  close(r.isdCapacity, (cap(1) + cap(5) + cap(2)) / NOV, 'capacité PO, DA, DS, DE (Management à part)');
});

test('taux par profil : heures de charge sur heures de capacité, niveaux de loadRate', () => {
  const m = withTasks([
    {
      id: 1,
      start: '2026-11-01',
      end: '2026-11-30',
      charges: [
        { personId: 1, heures: NOV }, // DE : 1 ETP pour une capacité réduite → dépassement
        { personId: 2, heures: 10 }, // PO : normal
        { personId: 4, heures: 20 }, // Autre : sans capacité
      ],
    },
  ]);
  const r = row(roleLoad(m, [1], today), '2026-11');
  close(r.hours.DE, NOV);
  assert.equal(r.rates.DE.level, 'over');
  assert.deepEqual(r.rates.DE, loadRate(NOV, r.capacityHours.DE));
  assert.equal(r.rates.PO.level, 'ok');
  assert.deepEqual(r.rates.DS, { rate: null, level: 'none' });
  assert.equal(r.rates.Mgmt.level, 'ok');
  assert.equal('Autre' in r.rates, false);
  close(r.hours.Autre, 20);
  // Les mois sans charge gardent leur capacité
  const oct = row(roleLoad(m, [1], today), '2026-10');
  assert.equal(oct.total, 0);
  assert.ok(oct.capacity.PO > 0);
  assert.equal(oct.rates.PO.level, 'ok');
});

test('synthèse par profil : du mois courant à la fin, pic, mois en dépassement et en tension, moyenne', () => {
  const r = (month, de, cap) => ({
    month,
    PO: 0,
    DA: 0,
    DS: 0,
    DE: de,
    Mgmt: 0,
    hours: { PO: 0, DA: 0, DS: 0, DE: de * 100, Mgmt: 0 },
    capacity: { PO: 0, DA: 0, DS: 0, DE: cap, Mgmt: 0 },
    capacityHours: { PO: 0, DA: 0, DS: 0, DE: cap * 100, Mgmt: 0 },
  });
  const rows = [
    r('2026-09', 5, 1),
    r('2026-10', 0.9, 1),
    r('2026-11', 0.5, 1),
    r('2026-12', 1.2, 1),
    r('2027-01', 0, 1),
  ];
  const s = summarizeMonths(rows, '2026-10');
  assert.deepEqual(Object.keys(s), ['PO', 'DA', 'DS', 'DE', 'Mgmt']);
  const de = s.DE;
  // Septembre (passé) n'entre pas dans la synthèse
  assert.deepEqual([de.months, de.loadedMonths, de.overMonths, de.tensionMonths, de.level], [4, 3, 1, 1, 'over']);
  assert.deepEqual(de.peak, { rate: 1.2, month: '2026-12', level: 'over' });
  close(de.avgLoaded.load, (0.9 + 0.5 + 1.2) / 3);
  close(de.avgLoaded.capacity, 1);
  assert.deepEqual([s.PO.loadedMonths, s.PO.peak, s.PO.level, s.PO.avgLoaded], [0, null, 'none', null]);
  // Charge sans capacité : pic sans taux, dépassement
  const nocap = summarizeMonths([r('2026-10', 0.5, 0), r('2026-11', 0.2, 1)], '2026-10').DE;
  assert.deepEqual(nocap.peak, { rate: null, month: '2026-10', level: 'over' });
  assert.equal(nocap.overMonths, 1);
});

test('effectif par profil : personnes actives de l’équipe ISD', () => {
  const m = buildModel(feuille());
  assert.deepEqual(profileHeadcount(m), { PO: 1, DA: 1, DS: 0, DE: 1, Mgmt: 1 });
});

test('tâches d’un segment : heures du profil sur le mois, personnes, tri par heures décroissantes', () => {
  const m = withTasks([
    {
      id: 1,
      title: 'Petite',
      start: '2026-11-01',
      end: '2026-11-30',
      charges: [
        { personId: 1, heures: 10 },
        { personId: 2, heures: 50 },
      ],
    },
    {
      id: 2,
      title: 'Grande, à cheval',
      start: '2026-10-25',
      end: '2026-11-07',
      charges: [{ personId: 1, heures: 70 }],
    },
    { id: 3, title: 'Sans dates', start: null, end: null, charges: [{ personId: 1, heures: 70 }] },
    { id: 4, title: 'Hors mois', start: '2026-12-01', end: '2026-12-31', charges: [{ personId: 1, heures: 70 }] },
    {
      id: 5,
      title: 'Ex aequo',
      start: '2026-11-01',
      end: '2026-11-30',
      charges: [{ personId: 1, heures: 10 }],
    },
  ]);
  const seg = segmentTasks(m, [5, 1, 2, 3, 4, 404], 'DE', '2026-11');
  const rows = roleLoad(m, [1, 2, 3, 4, 5], today);
  close(seg.hours, row(rows, '2026-11').hours.DE, 'total du segment = heures du graphique');
  assert.deepEqual(
    seg.tasks.map((t) => t.taskId),
    [2, 1, 5],
  );
  assert.equal(seg.tasks[0].people.length, 1);
  assert.equal(seg.tasks[0].people[0].personId, 1);
  close(seg.tasks[0].people[0].hours, seg.tasks[0].hours);
  // PO : seule la charge de Bob compte
  const po = segmentTasks(m, [1, 2, 5], 'PO', '2026-11');
  assert.deepEqual(
    po.tasks.map((t) => [t.taskId, t.hours]),
    [[1, 50]],
  );
  assert.deepEqual(segmentTasks(m, [1], 'DS', '2026-11'), { hours: 0, tasks: [] });
});

test('tâches d’un segment : plusieurs personnes du profil, « Autre », doublons sans effet', () => {
  const m = withTasks([
    {
      id: 1,
      start: '2026-11-01',
      end: '2026-11-30',
      charges: [
        { personId: 6, heures: 20 }, // Management ISD
        { personId: 7, heures: 30 }, // Management BNDMR → Autre
        { personId: 4, heures: 40 }, // hors ISD → Autre
      ],
    },
  ]);
  const other = segmentTasks(m, [1, 1], 'Autre', '2026-11');
  assert.equal(other.tasks.length, 1);
  close(other.hours, 70);
  assert.deepEqual(
    other.tasks[0].people.map((p) => p.personId),
    [4, 7],
  );
  close(segmentTasks(m, [1], 'Mgmt', '2026-11').hours, 20);
});

test('tri des heures : décroissant, puis identifiant croissant', () => {
  assert.deepEqual(
    [
      [3, 5],
      [1, 5],
      [2, 9],
    ].sort(byHoursDesc),
    [
      [2, 9],
      [1, 5],
      [3, 5],
    ],
  );
});

test('déplacement dans la grille des segments : profils sur la ligne, mois d’une ligne à l’autre', () => {
  const grid = [['PO', 'DE'], [], ['DE'], ['PO', 'DA', 'DE']];
  assert.deepEqual(segmentMove(grid, { row: 0, col: 0 }, 'ArrowRight'), { row: 0, col: 1 });
  assert.equal(segmentMove(grid, { row: 0, col: 1 }, 'ArrowRight'), null);
  assert.equal(segmentMove(grid, { row: 0, col: 0 }, 'ArrowLeft'), null);
  // ↓ saute le mois sans segment, garde le profil s'il existe
  assert.deepEqual(segmentMove(grid, { row: 0, col: 1 }, 'ArrowDown'), { row: 2, col: 0 });
  // sinon le segment le plus proche par la position
  assert.deepEqual(segmentMove(grid, { row: 0, col: 0 }, 'ArrowDown'), { row: 2, col: 0 });
  assert.deepEqual(segmentMove(grid, { row: 2, col: 0 }, 'ArrowDown'), { row: 3, col: 2 });
  assert.deepEqual(segmentMove(grid, { row: 3, col: 1 }, 'ArrowUp'), { row: 2, col: 0 });
  assert.equal(segmentMove(grid, { row: 3, col: 0 }, 'ArrowDown'), null);
  assert.equal(segmentMove(grid, { row: 0, col: 0 }, 'ArrowUp'), null);
  assert.deepEqual(segmentMove(grid, { row: 3, col: 1 }, 'Home'), { row: 3, col: 0 });
  assert.deepEqual(segmentMove(grid, { row: 3, col: 1 }, 'End'), { row: 3, col: 2 });
  assert.equal(segmentMove(grid, { row: 3, col: 0 }, 'Home'), null);
  assert.equal(segmentMove(grid, { row: 3, col: 0 }, 'Enter'), null);
});

test('filtres : seules les tâches visibles comptent dans les tâches d’un segment', () => {
  const m = buildModel(feuille());
  const all = [...applyFilters(m, DEFAULT_FILTERS, DEFAULT_PREFS).taskIds];
  const seg = segmentTasks(m, all, 'DE', '2026-11');
  assert.ok(seg.tasks.some((t) => t.taskId === 1002));
  const eve = [...applyFilters(m, { ...DEFAULT_FILTERS, person: 5 }, DEFAULT_PREFS).taskIds];
  assert.equal(
    segmentTasks(m, eve, 'DE', '2026-11').tasks.some((t) => t.taskId === 1002),
    false,
  );
});
