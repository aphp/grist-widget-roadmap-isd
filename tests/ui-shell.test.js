import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schemaMessage } from '../widget/js/ui/states.js';
import { focusAfterRemoval } from '../widget/js/ui/filters.js';

test('colonne absente : message nommant table et colonne, avec la conséquence', () => {
  const m = schemaMessage({ table: 'Tasks', column: 'charges', optional: false });
  assert.equal(m.tone, 'danger');
  assert.equal(
    m.text,
    'La colonne Tasks.charges est introuvable : la charge ne peut pas être calculée. Le widget n’a rien modifié.',
  );
});

test('colonne absente sans conséquence connue : formule générique', () => {
  const m = schemaMessage({ table: 'Projects', column: 'Sponsor', optional: false });
  assert.match(m.text, /^La colonne Projects\.Sponsor est introuvable : les informations qui en dépendent/);
});

test('table absente (KeyError) : « introuvable »', () => {
  const m = schemaMessage({ table: 'Tasks', column: null, optional: false, error: 'KeyError Tasks' });
  assert.match(m.text, /^La table Tasks est introuvable : aucune tâche ne peut être affichée\./);
});

test('table refusée pour une autre raison : « illisible » avec le message de Grist', () => {
  const m = schemaMessage({
    table: 'Tasks',
    column: null,
    optional: false,
    error: 'Blocked by table read access rules.',
  });
  assert.equal(m.tone, 'danger');
  assert.equal(
    m.text,
    'La table Tasks est illisible : Blocked by table read access rules. En conséquence, aucune tâche ne peut être affichée. Le widget n’a rien modifié.',
  );
});

test('table optionnelle : avertissement, un seul message par table', () => {
  const a = schemaMessage({ table: 'Disponibilites', column: 'dispo', optional: true });
  const b = schemaMessage({ table: 'Disponibilites', column: null, optional: true, error: 'KeyError x' });
  assert.equal(a.tone, 'warning');
  assert.equal(a.key, b.key);
});

test('retrait d’une étiquette : focus sur la suivante, sinon la précédente, sinon Tout effacer puis recherche', () => {
  const chips = [{ field: 'categorie' }, { field: 'profile' }, { field: 'statuses' }];
  assert.deepEqual(focusAfterRemoval(chips, 'categorie'), ['chip-profile', 'btn-clear', 'f-search']);
  assert.deepEqual(focusAfterRemoval(chips, 'statuses'), ['chip-profile', 'btn-clear', 'f-search']);
  assert.deepEqual(focusAfterRemoval([{ field: 'mine' }], 'mine'), ['btn-clear', 'f-search']);
  assert.deepEqual(focusAfterRemoval([], 'mine'), ['btn-clear', 'f-search']);
});
