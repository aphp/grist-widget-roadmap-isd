/**
 * Writer, lot 2c : créations (AddRecord), chantiers, rattachement (sous-tâches qui suivent, BulkUpdateRecord),
 * contrôle strict (obligatoires, références, projet du chantier, parent du même chantier, cycles, dates),
 * périmètre, annulation d'une création (seule suppression possible). Faux Grist Node, jamais de vrai Grist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feuille } from './fixtures/feuille.js';
import { createFakeGrist, lookupOf } from './fixtures/fake-grist.js';
import {
  EXPECTED_TYPES,
  WRITABLE,
  WriteFailed,
  WriteRefused,
  applyToTables,
  buildAdd,
  createWriter,
  decodeRow,
  changedSinceCreation,
  groupRows,
  integrityProblem,
  lookupFromTables,
  rawRow,
  referencesTo,
} from '../widget/js/core/grist-writer.js';
import { reattachRows, taskLinksFromTable } from '../widget/js/core/chantier-form.js';
import { movePlan } from '../widget/js/core/create-form.js';
import { buildModel } from '../widget/js/core/model.js';
import { runMove, runSave } from '../widget/js/core/task-session.js';
import { chantierDraftFrom, diffChantier } from '../widget/js/core/chantier-form.js';
import { createGateway } from '../widget/js/core/grist-gateway.js';

const META = Object.fromEntries(Object.entries(EXPECTED_TYPES).map(([k, type]) => [k, { type, isFormula: false }]));

function tables() {
  const t = feuille().tables;
  for (const [name, ops] of Object.entries(WRITABLE))
    for (const c of new Set([...ops.update, ...ops.add])) t[name][c] ??= t[name].id.map(() => null);
  return t;
}

/**
 * Faux Grist + writer. lookup : données « chargées » ; stale = photo prise à l'ouverture (comme le widget, que les
 * autres ne mettent pas à jour), sinon vue directe du faux Grist. readTable relit toujours le faux Grist.
 */
function setup(opts = {}) {
  const g = createFakeGrist(tables(), opts.grist);
  const lookup = opts.stale ? lookupFromTables(structuredClone(g.data)) : lookupOf(g);
  const writer = createWriter({
    docApi: g.docApi,
    mode: opts.mode ?? 'on',
    columns: META,
    lookup,
    readTable: async (t) => structuredClone(g.data[t]),
    ...opts.writer,
  });
  const readRow = async (t, id) => decodeRow(g.data[t], t, id);
  return { g, writer, lookup, readRow };
}

const reason = async (p) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteRefused) return e.reason;
    throw e;
  }
  return null;
};

test('buildAdd : colonnes de création, obligatoires non vides, encodage ; Projects et colonnes hors liste refusés', () => {
  assert.deepEqual(buildAdd('Tasks', { titre: 'T', Chantier: 100, projet: 10, assignees: [1], dateDebut: 2 }), [
    'AddRecord',
    'Tasks',
    null,
    { titre: 'T', Chantier: 100, projet: 10, assignees: ['L', 1], dateDebut: 172800 },
  ]);
  const r = (fn) => {
    try {
      fn();
    } catch (e) {
      return e.reason;
    }
    return null;
  };
  assert.equal(
    r(() => buildAdd('Tasks', { titre: ' ', Chantier: 1, projet: 1 })),
    'requis',
  );
  assert.equal(
    r(() => buildAdd('Tasks', { titre: 'a', projet: 1 })),
    'requis',
  );
  assert.equal(
    r(() => buildAdd('Chantiers', { Nom_du_chantier: 'a', Projets: [] })),
    'requis',
  );
  assert.equal(
    r(() => buildAdd('Tasks', { titre: 'a', Chantier: 1, projet: 1, tags: ['L', 'x'] })),
    'colonne',
  );
  assert.equal(
    r(() => buildAdd('Tasks', { titre: 'a', Chantier: 1, projet: 1, dateDebut: 'x' })),
    'encodage',
  );
  assert.equal(
    r(() => buildAdd('Projects', { nom: 'a' })),
    'table',
  );
  assert.equal(
    r(() => buildAdd('_grist_Tables', {})),
    'table',
  );
  assert.equal(
    r(() => buildAdd('Tasks', { titre: 'a', Chantier: 1, projet: 1 }, new Map([['Tasks.titre', 'formule']]))),
    'colonne-retiree',
  );
});

test('groupRows : une BulkUpdateRecord par table et jeu de colonnes, UpdateRecord pour une ligne seule', () => {
  const out = groupRows([
    ['UpdateRecord', 'Tasks', 1, { Chantier: 2, projet: 3 }],
    ['UpdateRecord', 'Tasks', 4, { projet: 3, Chantier: 2 }],
    ['UpdateRecord', 'Tasks', 5, { projet: 9 }],
  ]);
  assert.deepEqual(out, [
    ['BulkUpdateRecord', 'Tasks', [1, 4], { Chantier: [2, 2], projet: [3, 3] }],
    ['UpdateRecord', 'Tasks', 5, { projet: 9 }],
  ]);
});

test('integrityProblem : références, projet du chantier, parent du même chantier, cycle, dates, sous-tâches', () => {
  const { lookup } = setup();
  const p = (items) => integrityProblem(items, lookup);
  const add = (values) => [{ table: 'Tasks', id: null, values: { titre: 'T', Chantier: 100, projet: 10, ...values } }];
  assert.equal(p(add({})), null);
  assert.equal(p(add({ titre: 'x'.repeat(301) })), 'titre');
  assert.equal(p(add({ Chantier: 999 })), 'reference');
  assert.equal(p(add({ projet: 999 })), 'reference');
  assert.equal(p(add({ projet: 20 })), 'projet-chantier');
  assert.equal(p(add({ parentTask: 1000 })), null);
  assert.equal(p(add({ parentTask: 9999 })), 'reference');
  assert.equal(p(add({ parentTask: 2000 })), 'parent-chantier');
  assert.equal(p(add({ dateDebut: 10, dateEcheance: 9 })), 'dates');
  assert.equal(p(add({ dateDebut: 10, dateEcheance: 10 })), null);
  assert.equal(p(add({ Responsable: 99 })), 'reference');
  assert.equal(p(add({ assignees: [1, 99] })), 'reference');
  assert.equal(p(add({ Cree_par: 'alice' })), null);
  assert.equal(p(add({ Cree_par: 'alice@exemple.fr' })), 'cree-par');
  // Mise à jour : cycle de parenté, ligne absente, dépendance absente
  assert.equal(p([{ table: 'Tasks', id: 1000, values: { parentTask: 1001 } }]), 'cycle');
  assert.equal(p([{ table: 'Tasks', id: 8888, values: { titre: 'x' } }]), 'ligne');
  assert.equal(p([{ table: 'Tasks', id: 1000, values: { dependDe: [7777] } }]), 'reference');
  // Une règle qui ne porte pas sur les colonnes du lot n'est pas contrôlée (tâche 3000 : dates déjà inversées)
  assert.equal(p([{ table: 'Tasks', id: 3000, values: { titre: 'Rapport' } }]), null);
  assert.equal(p([{ table: 'Tasks', id: 3000, values: { dateDebut: 1 } }]), null);
  assert.equal(p([{ table: 'Tasks', id: 3000, values: { titre: '' } }]), 'titre');
  // Changement de chantier : les sous-tâches doivent suivre, avec le même projet
  const move = { table: 'Tasks', id: 1000, values: { Chantier: 200, projet: 20 } };
  const kid = (id, values) => ({ table: 'Tasks', id, values: { Chantier: 200, projet: 20, ...values } });
  assert.equal(p([move]), 'sous-taches');
  assert.equal(p([move, kid(1001)]), 'sous-taches');
  assert.equal(p([move, kid(1001), kid(1002, { projet: 10 })]), 'sous-taches');
  assert.equal(p([kid(1002, { projet: 10 })]), 'projet-chantier');
  assert.equal(p([move, kid(1001), kid(1002)]), null);
  // Une sous-tâche ne change pas de chantier seule
  assert.equal(p([kid(1001)]), 'parent-chantier');
  // Chantiers
  const ch = (values, id = null) => [{ table: 'Chantiers', id, values }];
  assert.equal(p(ch({ Nom_du_chantier: 'N', Projets: [10] })), null);
  assert.equal(p(ch({ Nom_du_chantier: ' ', Projets: [10] })), 'nom');
  assert.equal(p(ch({ Nom_du_chantier: 'N', Projets: [] })), 'projets');
  assert.equal(p(ch({ Nom_du_chantier: 'N', Projets: [10, 999] })), 'reference');
  assert.equal(p(ch({ Nom_du_chantier: 'N', Projets: [10], Debut: 5, Fin: 4 })), 'dates');
  assert.equal(p(ch({ Nom_du_chantier: 'N', Projets: [10], Contributeurs: [99] })), 'reference');
  assert.equal(p(ch({ Nom_du_chantier: 'N', Projets: [10], Responsable: 99 })), 'reference');
  // Projets d'un chantier : ses tâches doivent garder un projet du chantier
  assert.equal(p(ch({ Projets: [30] }, 201)), 'taches-projet');
  assert.equal(p([...ch({ Projets: [30] }, 201), { table: 'Tasks', id: 2010, values: { projet: 30 } }]), null);
  assert.equal(p(ch({ Projets: [20] }, 201)), null);
});

test('création réelle : un seul AddRecord, identifiant lu dans retValues, journal et action appliquée', async () => {
  const { g, writer } = setup();
  assert.ok(writer.canAdd('Tasks').ok);
  assert.ok(writer.canAddField('Tasks', 'Cree_par'));
  assert.ok(writer.canAddField('Tasks', 'charges'));
  assert.ok(!writer.canAddField('Tasks', 'tags'));
  const e = await writer.add('Tasks', { titre: 'Nouvelle', Chantier: 100, projet: 10, statut: 'todo', type: 'tache' });
  assert.equal(g.batches.length, 1);
  assert.deepEqual(g.batches[0], [
    ['AddRecord', 'Tasks', null, { titre: 'Nouvelle', Chantier: 100, projet: 10, statut: 'todo', type: 'tache' }],
  ]);
  assert.equal(e.kind, 'add');
  assert.equal(e.sent, true);
  assert.ok(e.id > 4001);
  assert.deepEqual(e.applied, [['AddRecord', 'Tasks', e.id, g.batches[0][0][3]]]);
  // La correction locale donne la même ligne que la relecture
  const local = decodeRow(applyToTables(tables(), e.applied).Tasks, 'Tasks', e.id);
  assert.deepEqual(local, decodeRow(g.data.Tasks, 'Tasks', e.id));
  assert.equal(writer.journal().length, 1);
});

test('création : contrôle strict, périmètre et vérification obligatoire avant tout envoi', async () => {
  const { g, writer } = setup({ writer: { canWriteValues: (t, v) => v.projet !== 40 && !v.Projets?.includes(40) } });
  assert.equal(await reason(writer.add('Tasks', { titre: 'a', Chantier: 100, projet: 20 })), 'projet-chantier');
  assert.equal(await reason(writer.add('Tasks', { titre: 'a', Chantier: 400, projet: 40 })), 'perimetre');
  assert.equal(await reason(writer.add('Chantiers', { Nom_du_chantier: 'a', Projets: [40] })), 'perimetre');
  assert.equal(await reason(writer.add('Tasks', { titre: 'a', Chantier: 100 })), 'requis');
  assert.equal(g.batches.length, 0);
  const blind = createWriter({ docApi: g.docApi, mode: 'on', columns: META });
  assert.equal(await reason(blind.add('Tasks', { titre: 'a', Chantier: 100, projet: 10 })), 'verification');
  assert.equal(await reason(blind.update('Chantiers', 100, { Statut: 'Planifié' })), 'verification');
  assert.equal(await reason(blind.update('Tasks', 1000, { Chantier: 200, projet: 20 })), 'verification');
  assert.equal(g.batches.length, 0);
  const off = createWriter({ docApi: g.docApi, columns: META });
  assert.equal(await reason(off.add('Tasks', { titre: 'a', Chantier: 100, projet: 10 })), 'off');
  assert.equal(off.canAdd('Tasks').reason, 'off');
  assert.equal(off.canAdd('Projects').reason, 'off');
  assert.equal(writer.canAdd('Projects').reason, 'table');
});

test('création en mode essai : rien n’est envoyé, identifiant local, annulation notée', async () => {
  const { g, writer } = setup({
    mode: 'dry-run',
    writer: { tempId: () => 5000, preflight: async () => assert.fail() },
  });
  const e = await writer.add('Chantiers', { Nom_du_chantier: 'Essai', Projets: [10], Statut: 'À cadrer' });
  assert.equal(e.sent, false);
  assert.equal(e.id, 5000);
  assert.deepEqual(e.applied[0], [
    'AddRecord',
    'Chantiers',
    5000,
    { Nom_du_chantier: 'Essai', Projets: ['L', 10], Statut: 'À cadrer' },
  ]);
  const r = await writer.undoLast(async () => assert.fail('pas de relecture en mode essai'));
  assert.deepEqual(r.undoEntry.actions, [['RemoveRecord', 'Chantiers', 5000]]);
  assert.equal(r.undoEntry.sent, false);
  assert.equal(g.batches.length, 0);
  // Sans tempId : identifiant local élevé, jamais celui d'une ligne existante
  const w2 = createWriter({ docApi: null, mode: 'dry-run', columns: META, lookup: lookupOf(g) });
  assert.ok((await w2.add('Tasks', { titre: 'x', Chantier: 100, projet: 10 })).id > 900000000);
});

test('ajout refusé par une règle d’accès : création bloquée pour la session, modifications toujours possibles', async () => {
  const { g, writer } = setup({
    grist: { fail: (a) => (a[0][0] === 'AddRecord' ? 'Blocked by table create access rules' : null) },
  });
  await assert.rejects(
    () => writer.add('Tasks', { titre: 'a', Chantier: 100, projet: 10 }),
    (e) => e instanceof WriteFailed && e.kind === 'acl',
  );
  assert.deepEqual(writer.canAdd('Tasks'), { ok: false, reason: 'acl' });
  assert.equal(await reason(writer.add('Tasks', { titre: 'a', Chantier: 100, projet: 10 })), 'ajout-refuse');
  assert.ok(writer.canAdd('Chantiers').ok);
  assert.ok(writer.can('Tasks', 'titre').ok);
  await writer.update('Tasks', 1000, { titre: 'Toujours modifiable' });
  assert.equal(g.batches.length, 2);
  // Compte lecteur : toute la session passe en lecture
  const v = setup({ grist: { fail: 'No write access' } });
  await assert.rejects(() => v.writer.add('Tasks', { titre: 'a', Chantier: 100, projet: 10 }), WriteFailed);
  assert.ok(v.writer.isBlocked());
  // Identifiant non renvoyé : échec signalé
  const n = setup();
  n.g.docApi.applyUserActions = async () => ({ retValues: [null] });
  await assert.rejects(() => n.writer.add('Tasks', { titre: 'a', Chantier: 100, projet: 10 }), /identifiant/);
});

test('changement de chantier : la tâche et ses sous-tâches dans un seul lot (BulkUpdateRecord) ; annulation', async () => {
  const { g, writer, readRow } = setup();
  const before = { Chantier: 100, projet: 10 };
  const also = [1001, 1002].map((id) => ({ table: 'Tasks', id, changes: { Chantier: 200, projet: 20 }, before }));
  assert.equal(await reason(writer.update('Tasks', 1000, { Chantier: 200, projet: 20 }, { before })), 'sous-taches');
  assert.equal(
    await reason(writer.update('Tasks', 1000, { Chantier: 200, projet: 20 }, { before, also: [also[0], also[0]] })),
    'identifiant',
  );
  const e = await writer.update('Tasks', 1000, { Chantier: 200, projet: 20 }, { before, also });
  assert.deepEqual(g.batches, [
    [
      ['UpdateRecord', 'Tasks', 1000, { Chantier: 200, projet: 20 }],
      ['BulkUpdateRecord', 'Tasks', [1001, 1002], { Chantier: [200, 200], projet: [20, 20] }],
    ],
  ]);
  assert.equal(e.rows.length, 2);
  for (const id of [1000, 1001, 1002]) assert.equal(decodeRow(g.data.Tasks, 'Tasks', id).Chantier, 200);
  // Quelqu'un rattache ailleurs une sous-tâche : l'annulation laisserait une sous-tâche sur un autre projet que sa
  // tâche ; le contrôle strict est rejoué (M3), rien n'est envoyé
  g.otherUserSets('Tasks', 1002, { projet: 30 });
  const n = g.batches.length;
  await assert.rejects(
    () => writer.undoLast(readRow),
    (e) => e instanceof WriteRefused && e.reason === 'sous-taches',
  );
  assert.equal(g.batches.length, n);
  // Rien de changé ailleurs : l'annulation remet tout, en un lot
  const s2 = setup();
  await s2.writer.update('Tasks', 1000, { Chantier: 200, projet: 20 }, { before, also });
  await s2.writer.undoLast(s2.readRow);
  assert.deepEqual(s2.g.batches.at(-1), [
    ['UpdateRecord', 'Tasks', 1000, { Chantier: 100, projet: 10 }],
    ['BulkUpdateRecord', 'Tasks', [1001, 1002], { Chantier: [100, 100], projet: [10, 10] }],
  ]);
});

test('périmètre contrôlé sur chaque ligne du lot et sur les valeurs d’arrivée', async () => {
  const { g, writer } = setup({
    writer: {
      canWriteRow: (t, id) => id !== 1002,
      canWriteValues: (t, v) => v.projet !== 30 && !v.Projets?.includes(30) === true,
    },
  });
  const before = { Chantier: 100, projet: 10 };
  const also = [1001, 1002].map((id) => ({ table: 'Tasks', id, changes: { Chantier: 200, projet: 20 }, before }));
  assert.equal(
    await reason(writer.update('Tasks', 1000, { Chantier: 200, projet: 20 }, { before, also })),
    'perimetre',
  );
  assert.equal(await reason(writer.update('Tasks', 2010, { Chantier: 300, projet: 30 })), 'perimetre');
  assert.equal(g.batches.length, 0);
});

test('chantier : mise à jour des colonnes de la fiche ; projets retirés avec les tâches rattachées ailleurs', async () => {
  const { g, writer } = setup();
  await writer.update('Chantiers', 200, { Statut: 'Terminé', Debut: 20000, Fin: 20010 }, { before: {} });
  assert.deepEqual(g.batches[0], [
    ['UpdateRecord', 'Chantiers', 200, { Statut: 'Terminé', Debut: 1728000000, Fin: 1728864000 }],
  ]);
  assert.equal(await reason(writer.update('Chantiers', 200, { Fin: 19000 })), 'dates');
  assert.equal(await reason(writer.update('Chantiers', 200, { Priorite: '1' })), 'colonne');
  assert.equal(await reason(writer.update('Chantiers', 201, { Projets: [30] })), 'taches-projet');
  await writer.update(
    'Chantiers',
    201,
    { Projets: [30] },
    {
      before: { Projets: [20, 30] },
      also: [{ table: 'Tasks', id: 2010, changes: { projet: 30 }, before: { projet: 20 } }],
    },
  );
  assert.deepEqual(g.batches.at(-1), [
    ['UpdateRecord', 'Chantiers', 201, { Projets: ['L', 30] }],
    ['UpdateRecord', 'Tasks', 2010, { projet: 30 }],
  ]);
});

test('annuler une création : supprimée si inchangée et non référencée, sinon conservée avec la raison', async () => {
  const { g, writer, readRow } = setup();
  const e = await writer.add('Tasks', { titre: 'À annuler', Chantier: 100, projet: 10 });
  const r = await writer.undoLast(readRow);
  assert.deepEqual(g.batches.at(-1), [['RemoveRecord', 'Tasks', e.id]]);
  assert.equal(r.undoEntry.kind, 'remove');
  assert.equal(decodeRow(g.data.Tasks, 'Tasks', e.id), null);
  assert.equal(writer.lastUndoable(), null);
  // Modifiée depuis par quelqu'un d'autre : rien n'est supprimé
  const e2 = await writer.add('Tasks', { titre: 'Gardée', Chantier: 100, projet: 10 });
  g.otherUserSets('Tasks', e2.id, { titre: 'Modifiée ailleurs' });
  const r2 = await writer.undoLast(readRow);
  assert.equal(r2.reason, 'modifiee');
  assert.deepEqual(r2.skipped, ['titre']);
  g.otherUserSets('Tasks', e2.id, { titre: 'Gardée' }); // remise à l'identique : on ne la supprime pas dans ce test
  e2.undone = true;
  assert.equal(r2.undoEntry, null);
  assert.ok(decodeRow(g.data.Tasks, 'Tasks', e2.id));
  // Référencée (une sous-tâche a été créée dessous ailleurs) : conservée
  const e3 = await writer.add('Chantiers', { Nom_du_chantier: 'C', Projets: [10] });
  g.otherUserSets('Tasks', 1500, { Chantier: e3.id });
  const r3 = await writer.undoLast(readRow);
  assert.equal(r3.reason, 'reference');
  // Disparue entre-temps : rien à faire
  const e4 = await writer.add('Tasks', { titre: 'Disparue', Chantier: 100, projet: 10 });
  await g.docApi.applyUserActions([['RemoveRecord', 'Tasks', e4.id]]);
  const n = g.batches.length;
  const r4 = await writer.undoLast(readRow);
  assert.equal(r4.reason, 'disparue');
  assert.equal(g.batches.length, n);
  // Une suppression qui ne vise pas une création de la session est refusée par le writer
  assert.equal(writer.journal().filter((x) => x.kind === 'remove').length, 1);
});

test('applyToTables : AddRecord (identifiant attribué), BulkUpdateRecord, RemoveRecord, sans toucher à l’original', () => {
  const t = { Tasks: { id: [1, 2], titre: ['a', 'b'], projet: [10, 10] } };
  const out = applyToTables(t, [
    ['AddRecord', 'Tasks', 3, { titre: 'c', inconnue: 1 }],
    ['AddRecord', 'Tasks', 3, { titre: 'doublon' }],
    ['BulkUpdateRecord', 'Tasks', [1, 3, 9], { projet: [20, 30, 90] }],
    ['RemoveRecord', 'Tasks', 2],
    ['RemoveRecord', 'Tasks', 99],
    ['AddRecord', 'Absente', 1, {}],
  ]);
  assert.deepEqual(out.Tasks, { id: [1, 3], titre: ['a', 'c'], projet: [20, 30] });
  assert.deepEqual(t.Tasks.id, [1, 2]);
});

test('annuler une création (I1) : complétée ailleurs sur une colonne non écrite à la création → rien n’est supprimé', async () => {
  // Cas du relecteur : la tâche créée reçoit ailleurs une description et 20 h de charge
  const { g, writer, readRow } = setup();
  const e = await writer.add('Tasks', { titre: 'Créée ici', Chantier: 100, projet: 10, statut: 'todo', type: 'tache' });
  g.otherUserSets('Tasks', e.id, { description: 'travail de B', charges: '[{"teamId":2,"heures":20}]' });
  const n = g.batches.length;
  const r = await writer.undoLast(readRow);
  assert.equal(r.reason, 'modifiee');
  assert.deepEqual(r.skipped.sort(), ['charges', 'description']);
  assert.equal(r.undoEntry, null);
  assert.equal(g.batches.length, n);
  assert.ok(decodeRow(g.data.Tasks, 'Tasks', e.id));
  // Une colonne hors de la liste blanche compte aussi (ici estimationH, absente de la photo de création)
  const s2 = setup();
  s2.g.data.Tasks.estimationH = s2.g.data.Tasks.id.map(() => 0);
  const e2 = await s2.writer.add('Tasks', { titre: 'B', Chantier: 100, projet: 10 });
  s2.g.otherUserSets('Tasks', e2.id, { estimationH: 12 });
  assert.deepEqual((await s2.writer.undoLast(s2.readRow)).skipped, ['estimationH']);
  // R2 : une colonne formule (isFormula dans les métadonnées lues) change seule ; elle ne compte pas
  const s3 = setup({ writer: { columns: { ...META, 'Tasks.avancement': { type: 'Numeric', isFormula: true } } } });
  s3.g.data.Tasks.avancement = s3.g.data.Tasks.id.map(() => 0);
  const e3 = await s3.writer.add('Tasks', { titre: 'C', Chantier: 100, projet: 10 });
  s3.g.otherUserSets('Tasks', e3.id, { avancement: 42 });
  const r3 = await s3.writer.undoLast(s3.readRow);
  assert.deepEqual(r3.skipped, []);
  assert.ok(r3.undoEntry, 'annulation envoyée malgré la formule recalculée');
});

test('annuler une création (I1) : sous-tâche, dépendance ou tâche ajoutées ailleurs après le chargement → conservée', async () => {
  for (const [label, refer] of [
    ['sous-tâche', (id) => ({ titre: 'Sous-tâche d’ailleurs', Chantier: 100, projet: 10, parentTask: id })],
    ['dépendance', (id) => ({ titre: 'Dépend de la nouvelle', Chantier: 100, projet: 10, dependDe: ['L', id] })],
  ]) {
    const { g, writer, readRow } = setup({ stale: true });
    const e = await writer.add('Tasks', { titre: 'Nouvelle', Chantier: 100, projet: 10 });
    // Créée par quelqu'un d'autre, absente des données chargées par ce widget
    g.otherUserAdds('Tasks', refer(e.id));
    const n = g.batches.length;
    const r = await writer.undoLast(readRow);
    assert.equal(r.reason, 'reference', label);
    assert.equal(g.batches.length, n, label);
  }
  // Chantier créé, puis une tâche ailleurs dans ce chantier
  const { g, writer, readRow } = setup({ stale: true });
  const c = await writer.add('Chantiers', { Nom_du_chantier: 'C', Projets: [10] });
  g.otherUserAdds('Tasks', { titre: 'x', Chantier: c.id, projet: 10 });
  assert.equal((await writer.undoLast(readRow)).reason, 'reference');
  // Relecture impossible (ou writer sans relecture) : rien n'est supprimé
  const nb = setup();
  const noRead = createWriter({ docApi: nb.g.docApi, mode: 'on', columns: META, lookup: lookupOf(nb.g) });
  await noRead.add('Tasks', { titre: 'y', Chantier: 100, projet: 10 });
  assert.equal((await noRead.undoLast(nb.readRow)).reason, 'relecture');
});

test('changedSinceCreation, referencesTo, rawRow : toutes les colonnes, photo ou valeurs par défaut', () => {
  const fresh = { id: 5, manualSort: 9, gristHelper_Display: 'x', titre: 'T', description: '', charges: null, n: 0 };
  assert.deepEqual(changedSinceCreation(fresh, { ...fresh, manualSort: 1, gristHelper_Display: 'y' }, {}), []);
  assert.deepEqual(changedSinceCreation({ ...fresh, description: 'd' }, fresh, {}), ['description']);
  // Sans photo : colonnes écrites identiques, les autres encore vides
  assert.deepEqual(changedSinceCreation(fresh, null, { titre: 'T' }), []);
  assert.deepEqual(changedSinceCreation({ ...fresh, tags: ['L'], assignees: ['L', 3] }, null, { titre: 'T' }), [
    'assignees',
  ]);
  assert.deepEqual(changedSinceCreation({ ...fresh, titre: 'U' }, null, { titre: 'T' }), ['titre']);
  // Colonnes formules ignorées (avec ou sans photo), sauf une colonne écrite par la création
  const isF = (c) => c === 'n' || c === 'titre';
  assert.deepEqual(changedSinceCreation({ ...fresh, n: 3 }, fresh, {}, isF), []);
  assert.deepEqual(changedSinceCreation({ ...fresh, n: 3 }, null, { titre: 'T' }, isF), []);
  assert.deepEqual(changedSinceCreation({ ...fresh, titre: 'U' }, null, { titre: 'T' }, isF), ['titre']);
  const t = { Tasks: { id: [1, 2, 3], parentTask: [0, 7, 0], dependDe: [null, null, ['L', 7]], Chantier: [7, 0, 0] } };
  assert.deepEqual(referencesTo(t, 'Tasks', 7), [2, 3]);
  assert.deepEqual(referencesTo({ ...t, Chantiers: { id: [4], dependDe: [['L', 7]] } }, 'Tasks', 7), [
    2,
    3,
    'chantier 4',
  ]);
  assert.deepEqual(referencesTo(t, 'Chantiers', 7), [1]);
  assert.deepEqual(referencesTo({}, 'Tasks', 7), []);
  assert.deepEqual(rawRow({ id: [1], a: ['x'] }, 1), { id: 1, a: 'x' });
  assert.equal(rawRow({ id: [1] }, 2), null);
  assert.equal(rawRow(undefined, 2), null);
});

test('création sans réponse (N2) : retrouvée sans ambiguïté, elle est annulable ; sinon résultat inconnu', async () => {
  const { g, writer, readRow } = setup({ stale: true, grist: { hang: 'after' }, writer: { timeoutMs: 30 } });
  const e = await writer.add('Tasks', { titre: 'Peut-être créée', Chantier: 100, projet: 10 });
  assert.equal(e.recovered, true);
  assert.equal(e.sent, true);
  assert.ok(decodeRow(g.data.Tasks, 'Tasks', e.id));
  // Annulation possible : la Grist bloquée ne répond pas non plus, mais la suppression est bien envoyée
  const pending = writer.undoLast(readRow).catch((err) => err);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(g.batches.at(-1), [['RemoveRecord', 'Tasks', e.id]]);
  await pending;
  // Deux lignes identiques déjà là (création répétée ailleurs) : on ne devine pas
  const s2 = setup({ stale: true, grist: { hang: 'after' }, writer: { timeoutMs: 30 } });
  s2.g.otherUserAdds('Tasks', { titre: 'Double', Chantier: 100, projet: 10 });
  await assert.rejects(
    () => s2.writer.add('Tasks', { titre: 'Double', Chantier: 100, projet: 10 }),
    (err) => err instanceof WriteFailed && err.kind === 'timeout',
  );
});

test('changement de chantier (M1) : une sous-tâche ajoutée ailleurs avant l’envoi suit aussi ; sinon refus', async () => {
  const { g, gw, writer } = (() => {
    const s0 = setup({ stale: true });
    return { ...s0, gw: createGateway(s0.g) };
  })();
  const model = buildModel({ ...feuille(), tables: structuredClone(g.data) });
  const plan = movePlan(model, 1000, 200, 20);
  assert.equal(plan.count, 2);
  // Quelqu'un ajoute une sous-tâche (et une petite-fille) après le chargement
  g.otherUserAdds('Tasks', { titre: 'Nouvelle', Chantier: 100, projet: 10, parentTask: 1001 });
  const added = g.data.Tasks.id.at(-1);
  g.batches.length = 0;
  // Le plan local seul est refusé par le writer (relecture juste avant l'envoi) : rien n'est envoyé
  await assert.rejects(
    () => writer.update('Tasks', 1000, plan.changes, { before: plan.before, also: plan.also }),
    (e) => e instanceof WriteRefused && e.reason === 'sous-taches',
  );
  assert.equal(g.batches.length, 0);
  // runMove recalcule les sous-tâches sur la table relue : la nouvelle suit
  const r = await runMove({
    writer,
    taskId: 1000,
    plan,
    fetchRow: (id) => gw.fetchRow('Tasks', id),
    readTable: async (t) => structuredClone(g.data[t]),
  });
  assert.equal(r.kind, 'saved');
  assert.equal(r.count, 3);
  assert.deepEqual(g.batches[0][1], [
    'BulkUpdateRecord',
    'Tasks',
    [1001, 1002, added],
    { Chantier: [200, 200, 200], projet: [20, 20, 20] },
  ]);
});

test('projets d’un chantier (M1, M2) : tâche ajoutée ailleurs et sous-tâches rattachées au projet restant', async () => {
  const s0 = setup({ stale: true });
  const gw = createGateway(s0.g);
  const fetchRow = (id) => gw.fetchRow('Chantiers', id);
  // Ailleurs : une tâche du chantier 201 sur le projet 20, avec une sous-tâche (projet 20, sans chantier propre)
  s0.g.otherUserAdds('Tasks', { titre: 'Ailleurs', Chantier: 201, projet: 20 });
  const t = s0.g.data.Tasks.id.at(-1);
  s0.g.otherUserAdds('Tasks', { titre: 'Sous', projet: 20, parentTask: t });
  const sub = s0.g.data.Tasks.id.at(-1);
  s0.g.batches.length = 0;
  const base = await fetchRow(201);
  const draft = { ...chantierDraftFrom(base), Projets: [30] };
  const r = await runSave({
    table: 'Chantiers',
    diff: diffChantier,
    taskId: 201,
    base,
    draft,
    writer: s0.writer,
    fetchRow,
    also: [{ table: 'Tasks', id: 2010, changes: { projet: 30 }, before: { projet: 20 } }],
    readTable: async (x) => structuredClone(s0.g.data[x]),
    reattachTo: 30,
  });
  assert.equal(r.kind, 'saved');
  assert.deepEqual(s0.g.batches[0], [
    ['UpdateRecord', 'Chantiers', 201, { Projets: ['L', 30] }],
    ['BulkUpdateRecord', 'Tasks', [2010, t, sub], { projet: [30, 30, 30] }],
  ]);
  // reattachRows : les sous-tâches suivent le projet de leur tâche
  const links = taskLinksFromTable(s0.g.data.Tasks);
  assert.ok(reattachRows(links, 201, [30], 30).taskIds.length === 0);
});

test('changer seulement le projet (M2) : les sous-tâches doivent suivre ; cycles de dépendances (N1) ; relecture', async () => {
  const { g, writer } = setup();
  // Le chantier 100 n'a que le projet 10 : on le rattache aussi à 20 pour l'exemple
  g.otherUserSets('Chantiers', 100, { Projets: ['L', 10, 20] });
  assert.equal(await reason(writer.update('Tasks', 1000, { projet: 20 }, { before: { projet: 10 } })), 'sous-taches');
  const also = [1001, 1002].map((id) => ({ table: 'Tasks', id, changes: { projet: 20 }, before: { projet: 10 } }));
  await writer.update('Tasks', 1000, { projet: 20 }, { before: { projet: 10 }, also });
  assert.deepEqual(g.batches.at(-1)[1], ['BulkUpdateRecord', 'Tasks', [1001, 1002], { projet: [20, 20] }]);
  // N1 : 1000 → 1001 → 1000
  g.otherUserSets('Tasks', 1001, { dependDe: ['L', 1000] });
  assert.equal(await reason(writer.update('Tasks', 1000, { dependDe: [1001] })), 'cycle-dependance');
  assert.equal(await reason(writer.update('Tasks', 1000, { dependDe: [1002] })), null);
  // Relecture impossible avant un changement de hiérarchie : rien n'est envoyé
  const n = g.batches.length;
  const broken = setup({ writer: { readTable: async () => assert.fail('réseau') } });
  assert.equal(await reason(broken.writer.update('Tasks', 1000, { dependDe: [1002] })), 'relecture');
  assert.equal(broken.g.batches.length, 0);
  assert.equal(g.batches.length, n);
});

test('lookupFromTables : tables relues prioritaires, données chargées sinon', () => {
  const base = {
    row: (t, id) => (t === 'Team' && id === 1 ? {} : null),
    childIds: () => [9],
    chantierTasks: () => [8],
  };
  const l = lookupFromTables({ Tasks: { id: [1, 2], parentTask: [0, 1], Chantier: [5, 5] } }, base);
  assert.deepEqual(l.childIds(1), [2]);
  assert.deepEqual(l.chantierTasks(5), [1, 2]);
  assert.deepEqual(l.row('Team', 1), {});
  assert.equal(l.row('Team', 2), null);
  const empty = lookupFromTables({}, base);
  assert.deepEqual(empty.childIds(1), [9]);
  assert.deepEqual(empty.chantierTasks(1), [8]);
  assert.equal(lookupFromTables({}).row('Team', 1), null);
  assert.deepEqual(lookupFromTables({}).childIds(1), []);
  assert.deepEqual(lookupFromTables({}).chantierTasks(1), []);
});
