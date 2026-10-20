import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, isDocumentRefusal } from '../widget/js/core/grist-writer.js';

// Messages relevés sur le vrai Grist (POST /apply du document de test, tools/real-grist/harness.js, octobre 2026).

test('vrai Grist : ligne disparue (UpdateRecord ou BulkUpdateRecord) classée « missing »', () => {
  // Bug : le vrai message n'est pas celui du faux Grist (« Invalid row id N in Table ») ; classé 'other'
  const real = '[Sandbox] AssertionError docactions.[Bulk]UpdateRecord for non-existent record #1413';
  assert.equal(classifyError(real), 'missing');
  assert.equal(isDocumentRefusal(real), false);
});

test('vrai Grist : colonne ou table inconnue classée « other », sans refus du document', () => {
  for (const m of ["[Sandbox] KeyError 'colonneInexistante'", "[Sandbox] KeyError 'TableInexistante'"]) {
    assert.equal(classifyError(m), 'other');
    assert.equal(isDocumentRefusal(m), false);
  }
});
