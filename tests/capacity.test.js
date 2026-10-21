import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayOfIso, isoOfDay } from '../widget/js/core/dates.js';
import {
  easterSunday,
  frenchHolidays,
  isWorkday,
  workdaysBetween,
  workdaysInYear,
  spreadHours,
  hoursToEtp,
  etpToHours,
  personMonthCapacity,
  personDayCapacity,
  personWeekCapacity,
  loadByPersonMonth,
  SLOWDOWN,
  standardDayHours,
  fteHours,
} from '../widget/js/core/capacity.js';

test('Pâques et jours fériés', () => {
  assert.equal(isoOfDay(easterSunday(2026)), '2026-04-05');
  assert.equal(isoOfDay(easterSunday(2027)), '2027-03-28');
  const h = frenchHolidays(2027);
  assert.equal(h.size, 11);
  for (const iso of ['2027-01-01', '2027-03-29', '2027-05-06', '2027-05-17', '2027-07-14', '2027-12-25'])
    assert.ok(h.has(dayOfIso(iso)), iso);
});

test('jours ouvrés', () => {
  assert.equal(isWorkday(dayOfIso('2026-10-19')), true);
  assert.equal(isWorkday(dayOfIso('2026-10-18')), false); // dimanche
  assert.equal(isWorkday(dayOfIso('2026-11-11')), false); // férié
  assert.equal(workdaysBetween(dayOfIso('2026-11-01'), dayOfIso('2026-11-30')), 20); // 21 jours de semaine − 11 nov.
  assert.equal(workdaysInYear(2027), 254); // 261 jours de semaine − 7 fériés en semaine
});

test('répartition des heures sur les jours calendaires ; conversion ETP ↔ heures par les heures de 1 ETP', () => {
  const m = spreadHours(70, dayOfIso('2026-10-26'), dayOfIso('2026-11-08')); // 14 jours : 6 en oct., 8 en nov.
  assert.equal(m.get('2026-10'), 30);
  assert.equal(m.get('2026-11'), 40);
  assert.equal(hoursToEtp(70, 70), 1);
  assert.equal(hoursToEtp(35, 140), 0.25);
  assert.equal(hoursToEtp(35, null), 0);
  assert.equal(hoursToEtp(35, 0), 0);
  assert.equal(etpToHours(0.5, 140), 70);
  assert.equal(spreadHours(10, null, dayOfIso('2026-11-08')), null);
  assert.equal(spreadHours(10, dayOfIso('2026-11-08'), dayOfIso('2026-11-01')), null);
});

test('capacité mensuelle : congés, fériés, ralentissements, quotité, indisponibilités', () => {
  const full = { capaciteHebdo: 0, unavailability: [] };
  const avail = 1 - 44 / workdaysInYear(2026);
  assert.ok(Math.abs(personMonthCapacity(full, '2026-11') - 7 * 20 * avail) < 1e-9);
  const july =
    7 * workdaysBetween(dayOfIso('2027-07-01'), dayOfIso('2027-07-31')) * (1 - 44 / workdaysInYear(2027)) * 0.6;
  assert.ok(Math.abs(personMonthCapacity(full, '2027-07') - july) < 1e-9);
  const part = { capaciteHebdo: 28, unavailability: [] };
  assert.ok(Math.abs(personMonthCapacity(part, '2026-11') - (28 / 5) * 20 * avail) < 1e-9);
  const off = {
    capaciteHebdo: 35,
    unavailability: [{ start: dayOfIso('2026-11-02'), end: dayOfIso('2026-11-06'), dispo: 0 }],
  };
  assert.ok(Math.abs(personMonthCapacity(off, '2026-11') - 7 * 15 * avail) < 1e-9);
});

test('charge par personne et par mois (tâches sans dates ignorées)', () => {
  const tasks = [
    {
      start: dayOfIso('2026-10-26'),
      end: dayOfIso('2026-11-08'),
      charges: [
        { personId: 1, heures: 70 },
        { personId: 2, heures: 14 },
      ],
    },
    { start: null, end: null, charges: [{ personId: 1, heures: 1000 }] },
  ];
  const load = loadByPersonMonth(tasks);
  assert.equal(load.get(1).get('2026-11'), 40);
  assert.equal(load.get(2).get('2026-10'), 6);
  assert.equal(
    [...load.get(1).values()].reduce((a, b) => a + b, 0),
    70,
  );
});

test('capacité journalière : somme sur le mois = capacité mensuelle ; week-end et fériés à 0', () => {
  const off = {
    capaciteHebdo: 28,
    unavailability: [{ start: dayOfIso('2026-12-14'), end: dayOfIso('2026-12-18'), dispo: 0.5 }],
  };
  for (const ym of ['2026-11', '2026-12', '2027-07']) {
    let sum = 0;
    const [y, m] = ym.split('-').map(Number);
    for (let d = Date.UTC(y, m - 1, 1) / 864e5; d < Date.UTC(y, m, 1) / 864e5; d++) sum += personDayCapacity(off, d);
    assert.ok(Math.abs(sum - personMonthCapacity(off, ym)) < 1e-9, ym);
  }
  assert.equal(personDayCapacity(off, dayOfIso('2026-11-07')), 0); // samedi
  assert.equal(personDayCapacity(off, dayOfIso('2026-11-11')), 0); // férié
});

test('capacité hebdomadaire : 7 jours depuis le début donné', () => {
  const full = { capaciteHebdo: 0, unavailability: [] };
  const avail = 1 - 44 / workdaysInYear(2026);
  assert.ok(Math.abs(personWeekCapacity(full, dayOfIso('2026-11-16')) - 35 * avail) < 1e-9);
  // Semaine du 9 novembre 2026 : 11 novembre férié
  assert.ok(Math.abs(personWeekCapacity(full, dayOfIso('2026-11-09')) - 28 * avail) < 1e-9);
  const off = {
    capaciteHebdo: 35,
    unavailability: [{ start: dayOfIso('2026-11-02'), end: dayOfIso('2026-11-06'), dispo: 0 }],
  };
  assert.equal(personWeekCapacity(off, dayOfIso('2026-11-02')), 0);
});

const d = (y, m, day) => Date.UTC(y, m - 1, day) / 864e5;
const naive = (a, b) => {
  let h = 0;
  for (let x = a; x <= b; x++) h += standardDayHours(x);
  return h > 0 ? Math.round(h * 1e6) / 1e6 : null;
};

test('ralentissements : mai et décembre à 80 %, juillet 60 %, août 50 %', () => {
  assert.deepEqual({ ...SLOWDOWN }, { '05': 0.8, '07': 0.6, '08': 0.5, 12: 0.8 });
  const full = { capaciteHebdo: 35, unavailability: [] };
  const may = 7 * workdaysBetween(d(2027, 5, 1), d(2027, 5, 31)) * (1 - 44 / workdaysInYear(2027)) * 0.8;
  assert.ok(Math.abs(personMonthCapacity(full, '2027-05') - may) < 1e-9);
});

test('1 ETP sur une période : capacité de la personne standard (fteHours)', () => {
  // Novembre 2026 : même valeur que le plan de charge pour une personne à 35 h sans indisponibilité
  const nov = personMonthCapacity({ capaciteHebdo: 35 }, '2026-11');
  assert.ok(Math.abs(fteHours(d(2026, 11, 1), d(2026, 11, 30)) - nov) < 1e-6);
  assert.ok(Math.abs(nov - 115.6) < 0.1, String(nov));
  // Mai 2027 : jours ouvrés × 7 × (1 − 44 / jours ouvrés de 2027) × 0,8
  const wd = workdaysBetween(d(2027, 5, 1), d(2027, 5, 31));
  assert.ok(Math.abs(fteHours(d(2027, 5, 1), d(2027, 5, 31)) - wd * 7 * (1 - 44 / workdaysInYear(2027)) * 0.8) < 1e-6);
  // Un samedi et un dimanche : aucun jour ouvré, traité comme « sans période »
  assert.equal(fteHours(d(2026, 11, 7), d(2026, 11, 8)), null);
  assert.equal(fteHours(d(2026, 11, 11), d(2026, 11, 11)), null); // férié
  assert.equal(fteHours(null, d(2026, 11, 8)), null);
  assert.equal(fteHours(d(2026, 11, 8), undefined), null);
  assert.equal(fteHours(d(2026, 11, 9), d(2026, 11, 8)), null);
  assert.equal(fteHours(1.5, 3), null);
  // Une journée ouvrée de novembre 2026 : 7 h × (1 − 44 / jours ouvrés de l'année)
  assert.ok(Math.abs(fteHours(d(2026, 11, 9), d(2026, 11, 9)) - 7 * (1 - 44 / workdaysInYear(2026))) < 1e-6);
  // À cheval sur deux années : somme des deux parts
  const across = fteHours(d(2026, 12, 14), d(2027, 1, 15));
  const parts = fteHours(d(2026, 12, 14), d(2026, 12, 31)) + fteHours(d(2027, 1, 1), d(2027, 1, 15));
  assert.ok(Math.abs(across - parts) < 1e-6);
  assert.ok(Math.abs(fteHours(d(2025, 3, 1), d(2028, 2, 10)) - naive(d(2025, 3, 1), d(2028, 2, 10))) < 1e-6);
});

test('fteHours égale la somme jour par jour (200 périodes tirées, graine fixe)', () => {
  let seed = 20261021;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const first = d(2025, 1, 1);
  const span = d(2028, 12, 31) - first + 1;
  for (let i = 0; i < 200; i++) {
    const a = first + Math.floor(rand() * span);
    const b = first + Math.floor(rand() * span);
    const [s, e] = a <= b ? [a, b] : [b, a];
    assert.equal(fteHours(s, e), naive(s, e), `${isoOfDay(s)} → ${isoOfDay(e)}`);
  }
});

test('ETP ↔ heures : aller-retour sans perte', () => {
  const f = fteHours(d(2026, 6, 1), d(2026, 7, 31));
  assert.equal(hoursToEtp(etpToHours(0.25, f), f), 0.25);
  assert.equal(etpToHours(1, f), f);
});
