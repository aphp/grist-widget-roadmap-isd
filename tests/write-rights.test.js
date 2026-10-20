/** Droits relus au moment d'agir : brouillon des formulaires, fenêtres, statut rapide, messages de refus. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveChangesProjet } from '../widget/js/core/create-form.js';
import {
  createDialogRight,
  deleteRight,
  draftChangeRight,
  personDialogRight,
  quickStatusRight,
  rightFailure,
} from '../widget/js/core/write-rights.js';

const OK = { ok: true, reason: 'ok' };
/** Faux writer : colonnes refusées (Table.col → raison) et tables où l'ajout est refusé. */
const fakeWriter = ({ mode = 'on', cols = {}, adds = {} } = {}) => ({
  mode,
  can: (t, c) => (cols[`${t}.${c}`] ? { ok: false, reason: cols[`${t}.${c}`] } : OK),
  canAdd: (t) => (adds[t] ? { ok: false, reason: adds[t] } : OK),
});
const formState = (w, table, locked = false) => ({ locked, can: (c) => w.can(table, c) });

test('brouillon : chaque colonne touchée est relue ; writer coupé ou session verrouillée : refus', () => {
  const before = { assignees: [1], charges: '[]', titre: 'T' };
  const removed = { ...before, assignees: [], charges: '[]' };
  const w = fakeWriter({ cols: { 'Tasks.charges': 'formule' } });
  // Seule la colonne assignees change : permis
  assert.deepEqual(draftChangeRight(w, formState(w, 'Tasks'), before, removed), {
    ok: true,
    reason: 'ok',
    cols: ['assignees'],
  });
  // La charge change aussi : la colonne charges est refusée, rien n'est permis
  const r = draftChangeRight(w, formState(w, 'Tasks'), before, { ...removed, charges: '[{"teamId":2,"heures":7}]' });
  assert.deepEqual(r, { ok: false, reason: 'formule', cols: ['assignees', 'charges'] });
  // Writer coupé ou absent, session verrouillée
  const off = fakeWriter({ mode: 'off' });
  assert.equal(draftChangeRight(off, formState(off, 'Tasks'), before, removed).reason, 'off');
  assert.equal(draftChangeRight(null, formState(w, 'Tasks'), before, removed).reason, 'off');
  assert.equal(draftChangeRight(w, formState(w, 'Tasks', 'flags'), before, removed).reason, 'flags');
  // Session verrouillée : refus même sans changement
  assert.equal(draftChangeRight(w, formState(w, 'Tasks', 'viewer'), before, before).ok, false);
  // Aucun changement, writer actif : permis
  assert.equal(draftChangeRight(w, formState(w, 'Tasks'), before, { ...before }).ok, true);
});

test('fenêtres de création : ajout dans la table ; changement de chantier : projet relu seulement s’il change', () => {
  assert.equal(createDialogRight(fakeWriter(), 'task', 'Tasks').ok, true);
  assert.deepEqual(createDialogRight(fakeWriter({ adds: { Tasks: 'acl' } }), 'subtask', 'Tasks'), {
    ok: false,
    reason: 'acl',
  });
  assert.equal(createDialogRight(fakeWriter({ adds: { Tasks: 'acl' } }), 'chantier', 'Chantiers').ok, true);
  assert.equal(createDialogRight(fakeWriter({ mode: 'off' }), 'task', 'Tasks').reason, 'off');
  assert.equal(createDialogRight(null, 'move', 'Tasks').reason, 'off');
  const noProjet = fakeWriter({ cols: { 'Tasks.projet': 'colonne' } });
  const same = { changes: { Chantier: 2, projet: 10 }, before: { Chantier: 1, projet: 10 }, also: [] };
  const other = { ...same, changes: { Chantier: 2, projet: 20 } };
  const child = { ...same, also: [{ before: { Chantier: 1, projet: 20 } }] };
  assert.equal(moveChangesProjet(same), false);
  assert.equal(moveChangesProjet(other), true);
  assert.equal(moveChangesProjet(child), true);
  // À l'ouverture (pas encore de plan) et quand le projet ne change pas : la colonne Chantier suffit
  assert.equal(createDialogRight(noProjet, 'move', 'Tasks').ok, true);
  assert.equal(createDialogRight(noProjet, 'move', 'Tasks', same).ok, true);
  assert.deepEqual(createDialogRight(noProjet, 'move', 'Tasks', other), { ok: false, reason: 'colonne' });
  assert.equal(createDialogRight(noProjet, 'move', 'Tasks', child).ok, false);
  assert.equal(createDialogRight(fakeWriter({ cols: { 'Tasks.Chantier': 'type' } }), 'move', 'Tasks', same).ok, false);
});

test('fenêtres des personnes et statut rapide : la colonne ou la table de l’action', () => {
  const w = fakeWriter({ cols: { 'Team.actif': 'viewer', 'Chantiers.Statut': 'formule' }, adds: { Team: 'acl' } });
  assert.deepEqual(personDialogRight(w, 'add'), { ok: false, reason: 'acl' });
  assert.equal(personDialogRight(w, 'unav-add').ok, true);
  assert.deepEqual(personDialogRight(w, 'off'), { ok: false, reason: 'viewer' });
  assert.equal(personDialogRight(w, 'unav-edit').ok, true);
  assert.equal(
    personDialogRight(fakeWriter({ cols: { 'Disponibilites.dateDebut': 'absente' } }), 'unav-edit').ok,
    false,
  );
  assert.equal(personDialogRight(fakeWriter({ mode: 'off' }), 'unav-add').reason, 'off');
  assert.equal(quickStatusRight(w, 'Tasks').ok, true);
  assert.deepEqual(quickStatusRight(w, 'Chantiers'), { ok: false, reason: 'formule' });
  assert.equal(quickStatusRight(null, 'Tasks').reason, 'off');
});

test('suppression depuis la fiche : droit du writer relu (canRemove), writer coupé ou absent, ancien writer', () => {
  const w = { ...fakeWriter(), canRemove: (t) => (t === 'Chantiers' ? { ok: false, reason: 'acl' } : OK) };
  assert.deepEqual(deleteRight(w, 'Tasks'), OK);
  assert.deepEqual(deleteRight(w, 'Chantiers'), { ok: false, reason: 'acl' });
  assert.equal(deleteRight(null, 'Tasks').reason, 'off');
  assert.equal(deleteRight({ ...w, mode: 'off' }, 'Tasks').reason, 'off');
  assert.deepEqual(deleteRight(fakeWriter(), 'Tasks'), { ok: false, reason: 'table' });
});

test('refus relu avant l’envoi : un message propre à chaque raison', () => {
  assert.deepEqual(rightFailure('viewer'), { kind: 'session', message: 'viewer' });
  assert.deepEqual(rightFailure('flags'), { kind: 'session', message: 'flags' });
  assert.deepEqual(rightFailure('acl'), { kind: 'acl', message: '' });
  assert.deepEqual(rightFailure('off'), { kind: 'refused', message: 'off' });
  assert.deepEqual(rightFailure('table'), { kind: 'refused', message: 'table' });
  assert.deepEqual(rightFailure('colonne'), { kind: 'refused', message: 'colonne' });
  for (const r of ['absente', 'formule', 'vide', 'type', 'meta'])
    assert.deepEqual(rightFailure(r), { kind: 'refused', message: 'colonne-retiree' });
});
