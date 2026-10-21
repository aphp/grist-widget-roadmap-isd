import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNIT_KEY, storedUnit } from '../widget/js/ui/people-block.js';

/** Stockage du navigateur en mémoire. */
const memory = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m };
};

test('unité de saisie : ETP par défaut, h/semaine, ancienne préférence « heures » migrée en « hsem »', () => {
  assert.equal(storedUnit(memory()), 'etp');
  assert.equal(storedUnit(memory({ [UNIT_KEY]: 'etp' })), 'etp');
  assert.equal(storedUnit(memory({ [UNIT_KEY]: 'hsem' })), 'hsem');
  const old = memory({ [UNIT_KEY]: 'heures' });
  assert.equal(storedUnit(old), 'hsem');
  assert.equal(old.m.get(UNIT_KEY), 'hsem');
  assert.equal(storedUnit(memory({ [UNIT_KEY]: 'autre' })), 'etp');
  assert.equal(storedUnit(null), 'etp');
  assert.equal(
    storedUnit({
      getItem: () => {
        throw new Error('bloqué');
      },
    }),
    'etp',
  );
  // Écriture refusée pendant la migration : l'unité vaut quand même pour la session
  assert.equal(
    storedUnit({
      getItem: () => 'heures',
      setItem: () => {
        throw new Error('plein');
      },
    }),
    'hsem',
  );
});
