import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPECTED_TYPES,
  WriteFailed,
  WriteRefused,
  applyToTables,
  assertActions,
  buildUpdate,
  checkColumns,
  classifyError,
  createWriter,
  decodeRow,
  planUndo,
} from '../widget/js/core/grist-writer.js';
import { docIdFromBaseUrl, flagsAllowEdition, readEditMode, resolveEditState } from '../widget/js/core/edit-switch.js';

/** Métadonnées conformes à la Feuille pour toutes les colonnes de la liste blanche. */
const META = Object.fromEntries(Object.entries(EXPECTED_TYPES).map(([k, type]) => [k, { type, isFormula: false }]));

/** Faux docApi qui enregistre les lots envoyés. */
function fakeDoc(fail = null) {
  const sent = [];
  return {
    sent,
    async applyUserActions(actions) {
      sent.push(actions);
      if (fail) throw new Error(fail);
      return { retValues: actions.map(() => null) };
    },
  };
}

test('buildUpdate encode selon le type attendu et ne garde que les colonnes données', () => {
  const a = buildUpdate('Tasks', 812, { statut: 'done', dateCloture: 20617, assignees: [], Responsable: null });
  assert.deepEqual(a, [
    'UpdateRecord',
    'Tasks',
    812,
    { statut: 'done', dateCloture: 1781308800, assignees: null, Responsable: 0 },
  ]);
  assert.deepEqual(buildUpdate('Tasks', 1, { dependDe: [4, 2] })[3], { dependDe: ['L', 4, 2] });
});

test('liste blanche : Projects, tables _grist, colonnes hors liste, identifiants invalides refusés', () => {
  const reason = (fn) => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof WriteRefused);
      return e.reason;
    }
    return null;
  };
  assert.equal(
    reason(() => buildUpdate('Projects', 1, { nom: 'x' })),
    'table',
  );
  assert.equal(
    reason(() => buildUpdate('_grist_Tables_column', 1, { type: 'Text' })),
    'table',
  );
  assert.equal(
    reason(() => buildUpdate('Chantiers', 1, { Priorite: 'x' })),
    'colonne',
  );
  assert.equal(
    reason(() => buildUpdate('Tasks', 1, { Cree_par: 'x' })),
    'colonne',
  );
  assert.equal(
    reason(() => buildUpdate('Tasks', 1, { manualSort: 3 })),
    'colonne',
  );
  assert.equal(
    reason(() => buildUpdate('Tasks', 0, { titre: 'x' })),
    'identifiant',
  );
  assert.equal(
    reason(() => buildUpdate('Tasks', '3', { titre: 'x' })),
    'identifiant',
  );
  assert.equal(
    reason(() => buildUpdate('Tasks', 3, {})),
    'vide',
  );
  assert.equal(
    reason(() => buildUpdate('Tasks', 3, { dateDebut: 'demain' })),
    'encodage',
  );
  assert.equal(
    reason(() => buildUpdate('Tasks', 3, { titre: 'x' }, new Map([['Tasks.titre', 'formule']]))),
    'colonne-retiree',
  );
  assert.equal(
    reason(() => buildUpdate(null, 3, { titre: 'x' })),
    'table',
  );
});

test('assertActions : seules les actions de la liste blanche passent ; suppression d’une création seulement', () => {
  assert.doesNotThrow(() => assertActions([['UpdateRecord', 'Tasks', 1, { titre: 'a' }]]));
  assert.doesNotThrow(() => assertActions([['UpdateRecord', 'Chantiers', 1, { Statut: 'Planifié' }]]));
  assert.doesNotThrow(() => assertActions([['AddRecord', 'Chantiers', null, { Nom_du_chantier: 'a' }]]));
  assert.doesNotThrow(() => assertActions([['BulkUpdateRecord', 'Tasks', [1, 2], { Chantier: [3, 3] }]]));
  assert.doesNotThrow(() => assertActions([['RemoveRecord', 'Tasks', 4]], { removable: (t, id) => id === 4 }));
  assert.throws(() => assertActions([['RemoveRecord', 'Tasks', 5]], { removable: (t, id) => id === 4 }), WriteRefused);
  for (const bad of [
    [],
    [['AddTable', 'X', []]],
    [['ModifyColumn', 'Tasks', 'tags', { widgetOptions: '{}' }]],
    [['UpdateRecord', 'Projects', 1, { nom: 'a' }]],
    [['UpdateRecord', '_grist_ACLRules', 1, {}]],
    [['UpdateRecord', 'Tasks', 1.5, { titre: 'a' }]],
    [['UpdateRecord', 'Tasks', 1, { Cree_par: 'a' }]],
    [['UpdateRecord', 'Chantiers', 1, { Priorite: 'P3' }]],
    [['AddRecord', 'Chantiers', null, { Nom_du_chantier: 'a', tags: ['L', 'x'] }]],
    [['AddRecord', 'Tasks', null, { titre: 'a', tags: ['L', 'x'] }]],
    [['AddRecord', 'Tasks', 3, { titre: 'a' }]],
    [['AddRecord', 'Tasks', null, { dateCloture: 1 }]],
    [['AddRecord', 'Projects', null, { nom: 'a' }]],
    [['RemoveRecord', 'Tasks', 4]],
    [['BulkUpdateRecord', 'Tasks', [1, 1], { titre: ['a', 'b'] }]],
    [['BulkUpdateRecord', 'Tasks', [1, 2], { titre: ['a'] }]],
    [['BulkUpdateRecord', 'Tasks', [], {}]],
    [['BulkUpdateRecord', 'Tasks', [1, 2], { Cree_par: ['a', 'b'] }]],
    [['BulkRemoveRecord', 'Tasks', [1]]],
    ['UpdateRecord'],
  ])
    assert.throws(() => assertActions(bad), WriteRefused, JSON.stringify(bad));
  assert.throws(() => assertActions(null), WriteRefused);
});

test('checkColumns : colonne absente, devenue formule, de type changé, métadonnées illisibles', () => {
  assert.equal(checkColumns(META).size, 0);
  const meta = { ...META, 'Tasks.titre': { type: 'Text', isFormula: true }, 'Tasks.progression': { type: 'Text' } };
  delete meta['Tasks.Lien_utile'];
  const off = checkColumns(meta);
  assert.equal(off.get('Tasks.titre'), 'formule');
  assert.equal(off.get('Tasks.progression'), 'type');
  assert.equal(off.get('Tasks.Lien_utile'), 'absente');
  assert.equal(off.size, 3);
  assert.equal(checkColumns(null).get('Tasks.statut'), 'meta');
});

test('mode off (défaut) : toute écriture refusée, rien n’est envoyé', async () => {
  const doc = fakeDoc();
  const w = createWriter({ docApi: doc, columns: META });
  assert.equal(w.mode, 'off');
  assert.deepEqual(w.can('Tasks', 'titre'), { ok: false, reason: 'off' });
  await assert.rejects(
    () => w.update('Tasks', 1, { titre: 'x' }),
    (e) => e instanceof WriteRefused && e.reason === 'off',
  );
  assert.equal(doc.sent.length, 0);
  assert.throws(() => createWriter({ docApi: doc, mode: 'oui' }), WriteRefused);
});

test('mode essai : journalisé, jamais envoyé', async () => {
  const doc = fakeDoc();
  const w = createWriter({ docApi: doc, mode: 'dry-run', columns: META });
  const e = await w.update('Tasks', 5, { statut: 'inprogress' }, { before: { statut: 'todo' } });
  assert.equal(e.sent, false);
  assert.deepEqual(e.actions, [['UpdateRecord', 'Tasks', 5, { statut: 'inprogress' }]]);
  assert.deepEqual(e.before, { statut: 'todo' });
  assert.equal(doc.sent.length, 0);
  assert.equal(w.journal().length, 1);
  // Annuler en mode essai : l'inverse est noté, toujours sans envoi
  const r = await w.undoLast(async () => {
    throw new Error('ne doit pas relire');
  });
  assert.deepEqual(r.undoEntry.after, { statut: 'todo' });
  assert.equal(r.undoEntry.sent, false);
  assert.equal(doc.sent.length, 0);
  assert.equal(w.lastUndoable(), null);
});

test('mode on : un seul lot par enregistrement, avec seulement les colonnes modifiées', async () => {
  const doc = fakeDoc();
  const w = createWriter({ docApi: doc, mode: 'on', columns: META });
  assert.deepEqual(w.can('Tasks', 'titre'), { ok: true, reason: 'ok' });
  assert.equal(w.can('Projects', 'nom').reason, 'table');
  assert.equal(w.can('Tasks', 'Cree_par').reason, 'colonne');
  assert.equal(w.can('Chantiers', 'Priorite').reason, 'colonne');
  assert.ok(w.can('Chantiers', 'Statut').ok);
  const e = await w.update(
    'Tasks',
    7,
    { titre: 'Nouveau', priorite: '2' },
    { before: { titre: 'Ancien', priorite: '' } },
  );
  assert.equal(e.sent, true);
  assert.deepEqual(doc.sent, [[['UpdateRecord', 'Tasks', 7, { titre: 'Nouveau', priorite: '2' }]]]);
  assert.equal(w.lastUndoable().seq, e.seq);
});

test('refus par règle d’accès : erreur typée et colonnes retirées pour la session', async () => {
  const doc = fakeDoc('Blocked by table update access rules');
  const w = createWriter({ docApi: doc, mode: 'on', columns: META });
  await assert.rejects(
    () => w.update('Tasks', 7, { titre: 'x' }, { before: { titre: 'y' } }),
    (e) => e instanceof WriteFailed && e.kind === 'acl',
  );
  assert.deepEqual(w.can('Tasks', 'titre'), { ok: false, reason: 'acl' });
  assert.equal(w.journal().length, 0);
  const other = createWriter({ docApi: fakeDoc('Network down'), mode: 'on', columns: META });
  await assert.rejects(
    () => other.update('Tasks', 7, { titre: 'x' }),
    (e) => e instanceof WriteFailed && e.kind === 'other',
  );
  assert.ok(other.can('Tasks', 'titre').ok);
  w.refuse('Tasks', 'statut');
  assert.equal(w.can('Tasks', 'statut').reason, 'acl');
});

test('colonne devenue formule : retirée, son écriture est refusée avant envoi', async () => {
  const doc = fakeDoc();
  const w = createWriter({
    docApi: doc,
    mode: 'on',
    columns: { ...META, 'Tasks.titre': { type: 'Text', isFormula: true } },
  });
  assert.deepEqual(w.can('Tasks', 'titre'), { ok: false, reason: 'formule' });
  await assert.rejects(() => w.update('Tasks', 1, { titre: 'x' }), WriteRefused);
  assert.equal(doc.sent.length, 0);
});

test('classifyError reconnaît les refus et les lignes disparues', () => {
  assert.equal(classifyError('Blocked by table update access rules'), 'acl');
  assert.equal(classifyError('No permission to edit'), 'acl');
  assert.equal(classifyError('Invalid row id 12'), 'missing');
  assert.equal(classifyError('Timeout'), 'other');
  assert.equal(classifyError(undefined), 'other');
});

test('annuler : relit la ligne et ne remet pas une cellule modifiée depuis par quelqu’un d’autre', async () => {
  const doc = fakeDoc();
  const w = createWriter({ docApi: doc, mode: 'on', columns: META });
  await w.update('Tasks', 3, { statut: 'done', dateCloture: 20000 }, { before: { statut: 'todo', dateCloture: null } });
  const r = await w.undoLast(async () => ({ statut: 'review', dateCloture: 20000 }));
  assert.deepEqual(r.skipped, ['statut']);
  assert.deepEqual(doc.sent.at(-1), [['UpdateRecord', 'Tasks', 3, { dateCloture: null }]]);
  assert.equal(r.undoEntry.undoOf, r.entry.seq);
  assert.deepEqual(await w.undoLast(async () => null), { entry: null, skipped: [], undoEntry: null, busy: false });
  // Tout a changé ailleurs : rien n'est envoyé
  await w.update('Tasks', 3, { titre: 'a' }, { before: { titre: 'b' } });
  const n = doc.sent.length;
  const r2 = await w.undoLast(async () => ({ titre: 'c' }));
  assert.equal(r2.undoEntry, null);
  assert.equal(doc.sent.length, n);
});

test('planUndo : ligne disparue, tout est ignoré', () => {
  assert.deepEqual(planUndo({ before: { a: 1 }, after: { a: 2 } }, null), { changes: {}, skipped: ['a'] });
  assert.deepEqual(planUndo({ before: { a: [1] }, after: { a: [1, 2] } }, { a: [1, 2] }), {
    changes: { a: [1] },
    skipped: [],
  });
});

test('applyToTables corrige une copie des tables brutes, sans toucher à l’original', () => {
  const tables = { Tasks: { id: [1, 2], titre: ['a', 'b'] }, Team: { id: [1] } };
  const out = applyToTables(tables, [
    ['UpdateRecord', 'Tasks', 2, { titre: 'B', inconnue: 1 }],
    ['UpdateRecord', 'Tasks', 9, { titre: 'x' }],
    ['UpdateRecord', 'Absente', 1, { a: 1 }],
    ['AddRecord', 'Tasks', null, {}],
  ]);
  assert.deepEqual(out.Tasks.titre, ['a', 'B']);
  assert.deepEqual(tables.Tasks.titre, ['a', 'b']);
  assert.equal(out.Team, tables.Team);
});

test('decodeRow : valeurs du modèle de la liste blanche ; null si la ligne manque', () => {
  const t = { id: [4], titre: ['T'], assignees: [['L', 2]], dateDebut: [86400 * 3], progression: [50] };
  const row = decodeRow(t, 'Tasks', 4);
  assert.equal(row.titre, 'T');
  assert.deepEqual(row.assignees, [2]);
  assert.equal(row.dateDebut, 3);
  assert.equal(row.progression, 50);
  assert.equal(row.description, '');
  assert.deepEqual(row.dependDe, []);
  assert.equal(decodeRow(t, 'Tasks', 5), null);
  assert.equal(decodeRow(undefined, 'Tasks', 5), null);
  assert.deepEqual(decodeRow(t, 'Projects', 4), {});
});

test('readEditMode : adresse complète, chaîne de requête, URL, paramètres ; doc= validé', () => {
  assert.deepEqual(readEditMode('https://exemple.fr/w/?edition=1&doc=abc_DEF-12#x'), {
    requested: 'on',
    doc: 'abc_DEF-12',
  });
  assert.deepEqual(readEditMode(new URL('https://e.fr/?edition=essai')), { requested: 'dry-run', doc: null });
  assert.deepEqual(readEditMode(new URLSearchParams('edition=OUI&doc=a b')), { requested: 'on', doc: null });
  assert.deepEqual(readEditMode('edition=1'), { requested: 'on', doc: null });
  assert.deepEqual(readEditMode('http://[invalide'), { requested: 'off', doc: null });
  assert.deepEqual(readEditMode(undefined), { requested: 'off', doc: null });
});

test('verrou de document, flags.json et droits', () => {
  assert.equal(docIdFromBaseUrl('https://g.fr/api/docs/AbC123'), 'AbC123');
  assert.equal(docIdFromBaseUrl('https://g.fr/o/docs/api/docs/x%2Dy/'), 'x-y');
  assert.equal(docIdFromBaseUrl('https://g.fr/'), null);
  assert.equal(docIdFromBaseUrl(null), null);
  assert.ok(flagsAllowEdition({ edition: true }));
  for (const f of [null, {}, { edition: 'true' }, { edition: false }, 'x']) assert.ok(!flagsAllowEdition(f));

  const base = { doc: 'D1', docId: 'D1', flagsOk: true, access: 'editors' };
  assert.deepEqual(resolveEditState({ ...base, requested: 'off' }), { mode: 'off', canEdit: false, reason: 'off' });
  assert.deepEqual(resolveEditState({ ...base, requested: 'on' }), { mode: 'on', canEdit: true, reason: 'ok' });
  assert.deepEqual(resolveEditState({ ...base, requested: 'on', flagsOk: false }), {
    mode: 'off',
    canEdit: false,
    reason: 'flags',
  });
  // Mauvais doc=, doc= absent, document inconnu : envoi réel impossible
  for (const v of [{ doc: 'D2' }, { doc: null }, { docId: null }])
    assert.equal(resolveEditState({ ...base, ...v, requested: 'on' }).reason, 'doc');
  // Le mode essai n'envoie rien : pas de verrou de document
  assert.deepEqual(resolveEditState({ ...base, doc: null, requested: 'dry-run' }), {
    mode: 'dry-run',
    canEdit: true,
    reason: 'ok',
  });
  assert.deepEqual(resolveEditState({ ...base, requested: 'on', access: 'viewers' }), {
    mode: 'on',
    canEdit: false,
    reason: 'viewer',
  });
});

test('flags.json à une adresse fixe, commune à toutes les versions publiées', async () => {
  const { flagsUrl } = await import('../widget/js/core/edit-switch.js');
  assert.equal(flagsUrl('/index.html'), '/flags.json');
  assert.equal(flagsUrl('/'), '/flags.json');
  assert.equal(flagsUrl(''), '/flags.json');
  assert.equal(flagsUrl('/site/v0.2.0/index.html'), '/site/flags.json');
  assert.equal(flagsUrl('/site/v0.2.0-alpha.1/'), '/site/flags.json');
  assert.equal(flagsUrl('/site/v1/index.html'), '/site/flags.json');
  assert.equal(flagsUrl('/site/widget/index.html'), '/site/widget/flags.json');
  assert.equal(flagsUrl('/v0.3.1/index.html', 'arret.json'), '/arret.json');
});

test('annulation : un seul déclenchement à la fois (N4)', async () => {
  let release;
  const doc = fakeDoc();
  const w = createWriter({ docApi: doc, mode: 'on', columns: META });
  await w.update('Tasks', 3, { titre: 'a' }, { before: { titre: 'b' } });
  const first = w.undoLast(() => new Promise((r) => (release = () => r({ titre: 'a' }))));
  const second = await w.undoLast(async () => ({ titre: 'a' }));
  assert.equal(second.busy, true);
  assert.equal(second.entry, null);
  release();
  const r = await first;
  assert.deepEqual(r.undoEntry.after, { titre: 'b' });
  assert.equal(doc.sent.length, 2);
});

test('mode essai : ni arrêt d’urgence relu, ni envoi ; périmètre contrôlé', async () => {
  const w = createWriter({
    docApi: fakeDoc(),
    mode: 'dry-run',
    columns: META,
    preflight: async () => assert.fail('pas de relecture en mode essai'),
    canWriteRow: () => false,
  });
  await assert.rejects(
    () => w.update('Tasks', 1, { titre: 'x' }),
    (e) => e.reason === 'perimetre',
  );
  const ok = createWriter({ docApi: null, mode: 'dry-run', columns: META, preflight: async () => assert.fail() });
  assert.equal((await ok.update('Tasks', 1, { titre: 'x' })).sent, false);
});
