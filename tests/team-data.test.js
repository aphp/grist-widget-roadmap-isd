import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { applyFilters, DEFAULT_FILTERS, DEFAULT_PREFS } from '../widget/js/core/filters.js';
import { fteHours, personMonthCapacity, workdaysInYear } from '../widget/js/core/capacity.js';
import { dayOfIso, monthsFrom } from '../widget/js/core/dates.js';
import { rateLevel, teamLoad, teamTotals } from '../widget/js/core/team-data.js';
import { feuille } from './fixtures/feuille.js';

const m = buildModel(feuille());
const view = applyFilters(m, DEFAULT_FILTERS, DEFAULT_PREFS);
const months = monthsFrom('2026-10', 12);
const avail = 1 - 44 / workdaysInYear(2026);
const near = (a, b) => Math.abs(a - b) < 1e-6;
const cell = (rows, personId, ym) => rows.find((r) => r.personId === personId).months.find((x) => x.ym === ym);

test('équipe ISD active seulement, groupée par profil (PO, DA, DS, DE, Mgmt) puis par nom', () => {
  const rows = teamLoad(m, view.taskIds, months);
  // Fanny (6, Management ISD) a sa ligne « Mgmt » ; Gus (7, Management BNDMR), Carl (inactif), Dora (hors ISD) : non
  assert.deepEqual(
    rows.map((r) => [r.personId, r.role]),
    [
      [2, 'PO'],
      [5, 'DA'],
      [1, 'DE'],
      [6, 'Mgmt'],
    ],
  );
  assert.equal(rows[0].months.length, 12);
  assert.deepEqual(
    rows[0].months.map((x) => x.ym),
    months,
  );
});

test('Alice, novembre 2026 : 35 h de la tâche 1002, capacité réduite de 5 jours d’indisponibilité', () => {
  // 1002 : 70 h du 26 octobre au 8 novembre, 5 jours ouvrés de chaque côté → 35 h par mois (capacité standard)
  const c = cell(teamLoad(m, view.taskIds, months), 1, '2026-11');
  assert.equal(c.load, 35);
  assert.deepEqual(c.taskIds, [1002]);
  assert.deepEqual(c.hours, { 1002: 35 });
  assert.ok(near(c.capacity, 7 * 15 * avail));
  assert.ok(near(c.capacity, personMonthCapacity(m.people.get(1), '2026-11')));
  assert.ok(near(c.rate, 35 / c.capacity));
  const oct = cell(teamLoad(m, view.taskIds, months), 1, '2026-10');
  assert.equal(oct.load, 35);
});

test('personne à 35 h sans indisponibilité chargée à 1 ETP : 100 % chaque mois, été compris', () => {
  const mm = buildModel(feuille());
  const start = dayOfIso('2027-06-01');
  const end = dayOfIso('2027-08-31');
  // Bob PO (35 h par défaut, indisponible seulement en mars 2026)
  Object.assign(mm.tasks.get(2010), { start, end, charges: [{ personId: 2, heures: fteHours(start, end) }] });
  const rows = teamLoad(mm, [2010], monthsFrom('2027-06', 3));
  for (const ym of ['2027-06', '2027-07', '2027-08']) {
    const c = cell(rows, 2, ym);
    assert.ok(Math.abs(c.rate - 1) < 1e-6, `${ym} : ${c.rate}`);
  }
  const dec = fteHours(dayOfIso('2026-12-01'), dayOfIso('2026-12-31'));
  Object.assign(mm.tasks.get(2010), {
    start: dayOfIso('2026-12-01'),
    end: dayOfIso('2026-12-31'),
    charges: [{ personId: 2, heures: dec }],
  });
  assert.ok(Math.abs(cell(teamLoad(mm, [2010], months), 2, '2026-12').rate - 1) < 1e-6);
});

test('Eve, novembre : 14 h ; la charge du teamId 99 inconnu et la tâche sans dates sont ignorées', () => {
  const rows = teamLoad(m, view.taskIds, months);
  const c = cell(rows, 5, '2026-11');
  assert.equal(c.load, 14);
  assert.deepEqual(c.taskIds, [2010]);
  assert.ok(rows.every((r) => r.personId !== 99));
});

test('la tâche 2010 (chantier partagé entre deux projets) n’est comptée qu’une fois', () => {
  const rows = teamLoad(m, [2010, 2010, 2010], months);
  assert.equal(cell(rows, 5, '2026-11').load, 14);
  assert.equal(cell(teamLoad(m, view.taskIds, months), 5, '2026-11').load, 14);
});

test('seules les tâches retenues par les filtres comptent ; identifiants inconnus ignorés', () => {
  const rows = teamLoad(m, new Set([2010, 123456]), months);
  assert.equal(cell(rows, 1, '2026-11').load, 0);
  assert.deepEqual(cell(rows, 1, '2026-11').taskIds, []);
  assert.equal(cell(rows, 1, '2026-11').level, 'ok');
});

test('tâches d’une case triées par heures décroissantes', () => {
  const raw = feuille();
  raw.tables.Tasks.charges[raw.tables.Tasks.id.indexOf(2010)] = '[{"teamId":1,"heures":5}]';
  const mm = buildModel(raw);
  const c = cell(teamLoad(mm, [1002, 2010], months), 1, '2026-11');
  assert.deepEqual(c.taskIds, [1002, 2010]);
  assert.equal(c.load, 40);
});

test('seuils : < 85 % ok, 85 à 100 % tension, > 100 % dépassement (sur le % arrondi affiché)', () => {
  assert.equal(rateLevel(0), 'ok');
  assert.equal(rateLevel(0.844), 'ok');
  assert.equal(rateLevel(0.85), 'tension');
  assert.equal(rateLevel(1), 'tension');
  assert.equal(rateLevel(1.004), 'tension');
  assert.equal(rateLevel(1.006), 'over');
  assert.equal(rateLevel(null, 0), 'none');
  assert.equal(rateLevel(null, 3), 'over');
});

test('capacité nulle (indisponible tout le mois) : taux non défini, dépassement si charge', () => {
  const raw = feuille();
  const D = (iso) => Date.parse(`${iso}T00:00:00Z`) / 1000;
  raw.tables.Disponibilites.id.push(3);
  raw.tables.Disponibilites.membre.push(1);
  raw.tables.Disponibilites.dateDebut.push(D('2026-10-01'));
  raw.tables.Disponibilites.dateFin.push(D('2026-10-31'));
  raw.tables.Disponibilites.dispo.push(0);
  const c = cell(teamLoad(buildModel(raw), [1002], months), 1, '2026-10');
  assert.equal(c.capacity, 0);
  assert.equal(c.rate, null);
  assert.equal(c.level, 'over');
});

test('total par profil : sommes de capacité et de charge, taux recalculé', () => {
  const rows = teamLoad(m, view.taskIds, months);
  const totals = teamTotals(rows);
  assert.deepEqual(
    totals.map((t) => [t.role, t.count]),
    [
      ['PO', 1],
      ['DA', 1],
      ['DE', 1],
      ['Mgmt', 1],
    ],
  );
  const de = totals.find((t) => t.role === 'DE').months.find((x) => x.ym === '2026-11');
  assert.equal(de.load, 35);
  assert.ok(near(de.rate, 35 / de.capacity));
  assert.equal(de.level, rateLevel(de.rate, de.load));
});
