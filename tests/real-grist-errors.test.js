import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, isDocumentRefusal } from '../widget/js/core/grist-writer.js';

// Messages relevés sur le vrai Grist (POST /apply du document de test, tools/real-grist/harness.js, octobre 2026).

test('vrai Grist : ligne disparue (UpdateRecord ou BulkUpdateRecord) classée « missing »', () => {
  for (const m of [
    '[Sandbox] AssertionError docactions.[Bulk]UpdateRecord for non-existent record #1413',
    '[Sandbox] AssertionError docactions.[Bulk]UpdateRecord for non-existent record #99999999',
  ]) {
    assert.equal(classifyError(m), 'missing');
    assert.equal(isDocumentRefusal(m), false);
  }
});

test('faux Grist : message de ligne disparue toujours classé « missing »', () => {
  assert.equal(classifyError('Invalid row id 12 in Tasks'), 'missing');
});

test('vrai Grist : colonne ou table inconnue classée « other », sans refus du document', () => {
  for (const m of ["[Sandbox] KeyError 'colonneInexistante'", "[Sandbox] KeyError 'TableInexistante'"]) {
    assert.equal(classifyError(m), 'other');
    assert.equal(isDocumentRefusal(m), false);
  }
});

test('vrai Grist : action inconnue (jamais envoyée par le writer) classée « acl », sans refus du document', () => {
  const m = "Blocked by access rules: 'ActionInexistante' actions are not controlled";
  assert.equal(classifyError(m), 'acl');
  assert.equal(isDocumentRefusal(m), false);
});
