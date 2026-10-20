import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EncodeError,
  SECONDS_PER_DAY,
  dayFromInput,
  decodeValue,
  encodeValue,
  inputFromDay,
  isIsoDate,
  parisToday,
  parseNumberFr,
  sameValue,
  typeFamily,
} from '../widget/js/core/write-encode.js';
import { dayOf, dayOfIso } from '../widget/js/core/dates.js';

test('dates : jour × 86 400 (minuit UTC), aller-retour exact avec dayOf', () => {
  assert.equal(encodeValue('Date', 20617), 1781308800);
  for (const iso of ['2026-03-29', '2026-10-25', '2024-02-29', '2026-12-31', '2027-01-01', '1999-12-31']) {
    const day = dayFromInput(iso);
    const cell = encodeValue('Date', day);
    assert.equal(cell % SECONDS_PER_DAY, 0, iso);
    assert.equal(dayOf(cell), day, iso);
    assert.equal(decodeValue('Date', cell), day, iso);
    assert.equal(inputFromDay(day), iso);
  }
  assert.equal(encodeValue('Date', null), null);
  assert.equal(inputFromDay(null), '');
  assert.equal(dayFromInput(''), null);
  assert.throws(() => encodeValue('Date', 1.5), EncodeError);
  assert.throws(() => dayFromInput('2026-02-30'), EncodeError);
  assert.throws(() => dayFromInput('31/12/2026'), EncodeError);
  // Bornes : 1970 et avant ne font pas l'aller-retour avec dayOf ; au-delà de 2199, refus aussi (N2)
  assert.throws(() => dayFromInput('1970-01-01'), EncodeError);
  assert.throws(() => dayFromInput('0001-01-01'), EncodeError);
  assert.throws(() => dayFromInput('2200-01-01'), EncodeError);
  assert.equal(dayFromInput('1971-01-01'), 365);
  assert.throws(() => encodeValue('Date', 0), EncodeError);
});

test('isIsoDate refuse les dates impossibles', () => {
  assert.ok(isIsoDate('2024-02-29'));
  assert.ok(!isIsoDate('2026-02-29'));
  assert.ok(!isIsoDate('2026-13-01'));
  assert.ok(!isIsoDate(null));
});

test('aujourd’hui = jour calendaire de Paris, même tard le soir en UTC', () => {
  // 31/12/2026 23 h 30 UTC = 1er janvier 2027 à Paris
  assert.equal(parisToday(new Date('2026-12-31T23:30:00Z')), dayOfIso('2027-01-01'));
  // 29/03/2026 (passage à l'heure d'été) 22 h 30 UTC = 30 mars 00 h 30 à Paris
  assert.equal(parisToday(new Date('2026-03-29T22:30:00Z')), dayOfIso('2026-03-30'));
  assert.equal(parisToday(new Date('2026-07-14T10:00:00Z')), dayOfIso('2026-07-14'));
});

test('Ref, RefList, ChoiceList : 0, ["L", …], liste vide = null', () => {
  assert.equal(encodeValue('Ref:Team', 12), 12);
  assert.equal(encodeValue('Ref:Team', null), 0);
  assert.equal(encodeValue('Ref:Team', 0), 0);
  assert.throws(() => encodeValue('Ref:Team', -1), EncodeError);
  assert.throws(() => encodeValue('Ref:Team', '12'), EncodeError);
  assert.deepEqual(encodeValue('RefList:Team', [3, 1]), ['L', 3, 1]);
  assert.equal(encodeValue('RefList:Team', []), null);
  assert.throws(() => encodeValue('RefList:Team', [1, 'x']), EncodeError);
  assert.throws(() => encodeValue('RefList:Team', 1), EncodeError);
  assert.deepEqual(encodeValue('ChoiceList', ['a', 'b']), ['L', 'a', 'b']);
  assert.equal(encodeValue('ChoiceList', []), null);
  assert.deepEqual(encodeValue('ChoiceList', ['']), ['L', '']); // chaîne vide gardée (contrôle des nouveaux tags en amont)
  assert.throws(() => encodeValue('ChoiceList', ['a', 3]), EncodeError);
  assert.throws(() => encodeValue('ChoiceList', 'a'), EncodeError);
  assert.deepEqual(decodeValue('RefList:Team', ['L', 3, 0, 1]), [3, 1]);
  assert.deepEqual(decodeValue('RefList:Team', ['L']), []);
  assert.deepEqual(decodeValue('RefList:Team', null), []);
  assert.deepEqual(decodeValue('ChoiceList', ['L', 'x', 3]), ['x']);
  assert.deepEqual(decodeValue('ChoiceList', null), []);
  assert.equal(decodeValue('Ref:Team', 0), null);
  assert.equal(decodeValue('Ref:Team', 7), 7);
});

test('nombres : virgule française, vide = null, texte refusé', () => {
  assert.equal(parseNumberFr('1,5'), 1.5);
  assert.equal(parseNumberFr(' 2 '), 2);
  assert.equal(parseNumberFr(''), null);
  assert.equal(parseNumberFr(3), 3);
  assert.throws(() => parseNumberFr('abc'), EncodeError);
  assert.throws(() => parseNumberFr(Number.NaN), EncodeError);
  assert.equal(encodeValue('Numeric', '0,25'), 0.25);
  assert.equal(encodeValue('Numeric', null), null);
  assert.equal(encodeValue('Numeric', ''), null);
  assert.equal(encodeValue('Int', '4'), 4);
  assert.equal(encodeValue('Int', null), null);
  assert.throws(() => encodeValue('Int', '4,5'), EncodeError);
  assert.equal(decodeValue('Numeric', 75), 75);
  assert.equal(decodeValue('Numeric', null), null);
  assert.equal(decodeValue('Int', 'x'), null);
});

test('texte, choix, booléen ; types inconnus refusés à l’écriture', () => {
  assert.equal(encodeValue('Text', 'abc'), 'abc');
  assert.equal(encodeValue('Text', null), '');
  assert.equal(encodeValue('Choice', 'done'), 'done');
  assert.throws(() => encodeValue('Text', 3), EncodeError);
  assert.equal(encodeValue('Bool', true), true);
  assert.throws(() => encodeValue('Bool', 'oui'), EncodeError);
  assert.throws(() => encodeValue('Attachments', []), EncodeError);
  assert.equal(decodeValue('Text', null), '');
  assert.equal(decodeValue('Text', 12), '12');
  assert.equal(decodeValue('Text', ' a '), ' a ');
  assert.equal(decodeValue('Bool', 1), false);
  assert.equal(decodeValue('Bool', true), true);
  assert.deepEqual(decodeValue('Any', undefined), null);
  assert.equal(typeFamily('RefList:Tasks'), 'RefList');
  assert.equal(typeFamily(undefined), '');
});

test('sameValue compare les listes élément par élément', () => {
  assert.ok(sameValue([1, 2], [1, 2]));
  assert.ok(!sameValue([1, 2], [2, 1]));
  assert.ok(!sameValue([1], 1));
  assert.ok(!sameValue([1], [1, 2]));
  assert.ok(sameValue('a', 'a'));
  assert.ok(!sameValue(null, 0));
});
