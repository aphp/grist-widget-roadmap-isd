import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { applyFilters, DEFAULT_FILTERS, DEFAULT_PREFS } from '../widget/js/core/filters.js';
import { ROLE_WINDOW, roleLoad, roleSeries, shiftMonth } from '../widget/js/core/stats-data.js';
import { dayOfIso, monthRange } from '../widget/js/core/dates.js';
import { fteHours } from '../widget/js/core/capacity.js';
import { feuille } from './fixtures/feuille.js';

const today = dayOfIso('2026-10-20');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
/** Heures de 1 ETP sur un mois 'YYYY-MM' : capacité standard du mois. */
const monthFte = (ym) => fteHours(monthRange(ym).start, monthRange(ym).end);
const etp = (hours, ym) => hours / monthFte(ym);
const NOV = monthFte('2026-11');

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

test('un mois entier chargé à la capacité standard du mois = 1 ETP', () => {
  const m = withTasks([{ id: 1, start: '2026-11-01', end: '2026-11-30', charges: [{ personId: 1, heures: NOV }] }]);
  const r = row(roleLoad(m, [1], today), '2026-11');
  close(r.DE, 1);
  close(r.total, 1);
  assert.equal(r.PO + r.DA + r.DS + r.Mgmt + r.Autre, 0);
});

test('tâche à 1 ETP de juin à août 2027 : 1,00 ETP chaque mois (heures au prorata de la capacité standard)', () => {
  const start = dayOfIso('2027-06-01');
  const end = dayOfIso('2027-08-31');
  const m = withTasks([
    { id: 1, start: '2027-06-01', end: '2027-08-31', charges: [{ personId: 1, heures: fteHours(start, end) }] },
  ]);
  const rows = roleLoad(m, [1], dayOfIso('2027-05-15'));
  for (const ym of ['2027-06', '2027-07', '2027-08']) close(Math.round(row(rows, ym).DE * 1e6) / 1e6, 1);
});

test('tâche à cheval sur deux mois : heures au prorata des jours, ETP sur la capacité de chaque mois', () => {
  // 25 octobre → 7 novembre : 7 jours de chaque côté, 70 h → 35 h par mois
  const m = withTasks([{ id: 1, start: '2026-10-25', end: '2026-11-07', charges: [{ personId: 1, heures: 70 }] }]);
  const rows = roleLoad(m, [1], today);
  close(row(rows, '2026-10').DE, etp(35, '2026-10'));
  close(row(rows, '2026-11').DE, etp(35, '2026-11'));
  assert.equal(row(rows, '2026-09').total, 0);
  assert.equal(row(rows, '2026-12').total, 0);
});

test('bornes de la fenêtre : seules les heures des mois affichés comptent', () => {
  // 1er juin → 31 juillet 2026 : 61 h réparties au prorata de la capacité standard (juin hors fenêtre)
  const m = withTasks([
    { id: 1, start: '2026-06-01', end: '2026-07-31', charges: [{ personId: 1, heures: 61 }] },
    { id: 2, start: '2027-07-01', end: '2027-07-31', charges: [{ personId: 1, heures: 99 }] },
  ]);
  const rows = roleLoad(m, [1, 2], today);
  const july = (61 * monthFte('2026-07')) / fteHours(dayOfIso('2026-06-01'), dayOfIso('2026-07-31'));
  close(row(rows, '2026-07').DE, etp(july, '2026-07'));
  close(
    rows.reduce((s, r) => s + r.total, 0),
    etp(july, '2026-07'),
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
  close(r.Mgmt, 150 / NOV);
  close(r.Autre, 330 / NOV);
  close(r.PO, 30 / NOV);
  close(r.DA, 15 / NOV);
  assert.equal(r.DS, 0);
  close(r.total, 525 / NOV);
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
  close(row(roleLoad(m, [3, 3, 404], today), '2026-11').DE, 15 / NOV);
});

test('filtres : seules les tâches visibles comptent', () => {
  const m = buildModel(feuille());
  const all = roleLoad(m, [...applyFilters(m, DEFAULT_FILTERS, DEFAULT_PREFS).taskIds], today);
  assert.ok(row(all, '2026-11').DE > 0);
  const view = applyFilters(m, { ...DEFAULT_FILTERS, person: 5 }, DEFAULT_PREFS);
  assert.ok(!view.taskIds.has(1002));
  const eve = row(roleLoad(m, [...view.taskIds], today), '2026-11');
  assert.equal(eve.DE, 0);
  close(eve.DA, etp(14, '2026-11'));
});

test('rendu : segments à « 0,0 » omis, mois courant marqué, pas d’infobulle, filtre Personne expliqué', async () => {
  const { rolesCard } = await import('../widget/js/views/stats.js');
  const m = withTasks([
    {
      id: 1,
      start: '2026-10-01',
      end: '2026-10-31',
      charges: [
        { personId: 1, heures: 155 }, // DE : 1,2 ETP (capacité standard d'octobre ≈ 127 h)
        { personId: 2, heures: 4 }, // PO : 0,03 ETP → « 0,0 »
      ],
    },
  ]);
  const rows = roleLoad(m, [1], today);
  const out = rolesCard(rows, roleSeries(rows), { today }).toString();
  assert.equal((out.match(/class="rbars__seg /g) ?? []).length, 1);
  assert.match(out, /class="rbars__seg tone--role-de"/);
  assert.doesNotMatch(out, /class="rbars__seg tone--role-po"/);
  assert.equal((out.match(/rbars__row--current/g) ?? []).length, 1);
  assert.doesNotMatch(out, /rbars__seg[^>]*title=/);
  assert.match(out, /Le filtre Personne retient des tâches et compte toutes leurs charges/);
  // Le tableau garde la colonne PO (0,0)
  assert.match(out, /<th scope="col">PO<\/th>/);
  // Pastille « i » à côté du titre : explication de l'ETP, reliée au bouton
  assert.match(out, /<div class="stats__card-head"><h3 class="stats__card-title" id="stats-roles">/);
  assert.match(out, /aria-label="À propos de l’ETP" aria-describedby="tip-fte-stats"/);
  assert.match(out, /id="tip-fte-stats">1 ETP = une personne à temps plein sur la période/);
  assert.match(rolesCard([], [], { today }).toString(), /tip-fte-stats/);
});
