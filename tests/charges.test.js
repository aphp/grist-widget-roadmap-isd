import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCharges } from '../widget/js/core/charges.js';

test('charges vides', () => {
  for (const v of [null, undefined, '', '[]']) assert.deepEqual(parseCharges(v), { charges: [], error: null });
});

test('charges valides', () => {
  assert.deepEqual(parseCharges('[{"teamId":40,"heures":10},{"teamId":"102","heures":5.5}]'), {
    charges: [
      { personId: 40, heures: 10 },
      { personId: 102, heures: 5.5 },
    ],
    error: null,
  });
});

test('charges invalides : jamais d’exception', () => {
  assert.deepEqual(parseCharges('oops'), { charges: [], error: 'json' });
  assert.deepEqual(parseCharges('{"teamId":1}'), { charges: [], error: 'format' });
  assert.deepEqual(
    parseCharges('[{"heures":3},{"teamId":5,"heures":-2},{"teamId":6,"heures":"x"},{"teamId":7,"heures":4}]'),
    {
      charges: [{ personId: 7, heures: 4 }],
      error: 'entree',
    },
  );
});

test('teamId invalides : rejetés (entrée ignorée, erreur entree)', () => {
  for (const teamId of ['', true, 0, '12a']) {
    assert.deepEqual(
      parseCharges(JSON.stringify([{ teamId, heures: 3 }])),
      { charges: [], error: 'entree' },
      `teamId=${JSON.stringify(teamId)}`,
    );
  }
});

test('teamId chaîne de chiffres : accepté comme entier', () => {
  assert.deepEqual(parseCharges('[{"teamId":"102","heures":2}]'), {
    charges: [{ personId: 102, heures: 2 }],
    error: null,
  });
});

test('heures invalides : rejetées (entrée ignorée, erreur entree)', () => {
  for (const heures of [null, '', true, [], -1, 'x']) {
    assert.deepEqual(
      parseCharges(JSON.stringify([{ teamId: 5, heures }])),
      { charges: [], error: 'entree' },
      `heures=${JSON.stringify(heures)}`,
    );
  }
});

test('heures chaîne numérique : accepté comme nombre', () => {
  assert.deepEqual(parseCharges('[{"teamId":5,"heures":"5.5"}]'), {
    charges: [{ personId: 5, heures: 5.5 }],
    error: null,
  });
});
