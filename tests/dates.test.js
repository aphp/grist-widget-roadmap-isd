import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayOf,
  isoOfDay,
  dayOfIso,
  monthKey,
  monthRange,
  monthsFrom,
  weekday,
  formatDateFr,
  maxPlanDay,
} from '../widget/js/core/dates.js';

const utc = (y, m, d, h = 0) => Date.UTC(y, m - 1, d, h) / 1000;

test('dayOf : minuit UTC et minuit Paris tombent sur le même jour', () => {
  assert.equal(isoOfDay(dayOf(utc(2026, 10, 5))), '2026-10-05');
  assert.equal(isoOfDay(dayOf(utc(2026, 10, 4, 22))), '2026-10-05'); // minuit Paris (été) stocké 22:00 UTC la veille
  assert.equal(isoOfDay(dayOf(utc(2026, 12, 4, 23))), '2026-12-05'); // minuit Paris (hiver)
});

test('dayOf : valeurs vides ou invalides', () => {
  assert.equal(dayOf(null), null);
  assert.equal(dayOf(undefined), null);
  assert.equal(dayOf('abc'), null);
  assert.equal(dayOf(0), null); // 0 = date vide de Grist, pas le 1er janvier 1970
  assert.equal(dayOf(-5), null);
  assert.equal(dayOf(Number.NaN), null);
});

test('conversions jour ↔ ISO et mois', () => {
  const d = dayOfIso('2027-02-28');
  assert.equal(isoOfDay(d), '2027-02-28');
  assert.equal(monthKey(d), '2027-02');
  assert.deepEqual(monthRange('2027-02'), { start: dayOfIso('2027-02-01'), end: dayOfIso('2027-02-28'), n: 28 });
  assert.equal(monthRange('2028-02').n, 29);
  assert.deepEqual(monthsFrom('2026-11', 3), ['2026-11', '2026-12', '2027-01']);
});

test('weekday et format français', () => {
  assert.equal(weekday(dayOfIso('2026-10-19')), 1); // lundi
  assert.equal(formatDateFr(dayOfIso('2026-10-05')), '5 oct. 2026');
  assert.equal(formatDateFr(null), '—');
});

test('maxPlanDay : 31 décembre de l’année suivante', () => {
  assert.equal(isoOfDay(maxPlanDay(dayOfIso('2026-10-20'))), '2027-12-31');
  assert.equal(isoOfDay(maxPlanDay(dayOfIso('2026-12-31'))), '2027-12-31');
  assert.equal(isoOfDay(maxPlanDay(dayOfIso('2027-01-01'))), '2028-12-31');
});
