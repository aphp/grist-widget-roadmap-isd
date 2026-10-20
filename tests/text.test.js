import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../widget/js/core/text.js';
import { normalize as fromFilters } from '../widget/js/core/filters.js';

test('normalize : accents, casse et espaces', () => {
  assert.equal(normalize('Électricité  Ça '), 'electricite ca');
  assert.equal(normalize(null), '');
  assert.equal(fromFilters, normalize); // ré-export, une seule implémentation
});
