/** Fiche chantier, créations et changement de chantier (lot 2c), de bout en bout sur le faux Grist Node. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feuille } from './fixtures/feuille.js';
import { createFakeGrist, lookupOf } from './fixtures/fake-grist.js';
import { createGateway } from '../widget/js/core/grist-gateway.js';
import { EXPECTED_TYPES, WRITABLE, WriteRefused, createWriter } from '../widget/js/core/grist-writer.js';
import { chantierDraftFrom, diffChantier, reattachPlan } from '../widget/js/core/chantier-form.js';
import { movePlan, newTaskDraft, newTaskFields } from '../widget/js/core/create-form.js';
import { buildModel } from '../widget/js/core/model.js';
import { conflictBatch, runCreate, runMove, runQuickStatus, runSave } from '../widget/js/core/task-session.js';

const META = Object.fromEntries(Object.entries(EXPECTED_TYPES).map(([k, type]) => [k, { type, isFormula: false }]));

function setup(opts = {}) {
  const tables = feuille().tables;
  for (const [name, ops] of Object.entries(WRITABLE))
    for (const c of new Set([...ops.update, ...ops.add])) tables[name][c] ??= tables[name].id.map(() => null);
  const g = createFakeGrist(tables, opts.grist);
  const gw = createGateway(g);
  const writer = createWriter({ docApi: g.docApi, mode: opts.mode ?? 'on', columns: META, lookup: lookupOf(g) });
  return { g, gw, writer, model: buildModel({ ...feuille(), tables }) };
}

test('fiche chantier : enregistrement des seules colonnes modifiées, relecture, conflit sur une même colonne', async () => {
  const { g, gw, writer } = setup();
  const fetchRow = (id) => gw.fetchRow('Chantiers', id);
  const base = await fetchRow(200);
  const draft = { ...chantierDraftFrom(base), Nom_du_chantier: ' WP1 : Modèle LLM v2 ', Description: 'Texte' };
  const r = await runSave({ table: 'Chantiers', diff: diffChantier, taskId: 200, base, draft, writer, fetchRow });
  assert.equal(r.kind, 'saved');
  assert.deepEqual(g.batches[0], [
    ['UpdateRecord', 'Chantiers', 200, { Nom_du_chantier: 'WP1 : Modèle LLM v2', Description: 'Texte' }],
  ]);
  assert.deepEqual(diffChantier(await fetchRow(200), draft), {});
  // Quelqu'un change le statut et la description pendant la saisie : conflit sur la description seulement
  const base2 = await fetchRow(200);
  const d2 = { ...chantierDraftFrom(base2), Description: 'La mienne', Fin: base2.Fin };
  g.otherUserSets('Chantiers', 200, { Description: 'La leur', Statut: 'Terminé' });
  const c = await runSave({
    table: 'Chantiers',
    diff: diffChantier,
    taskId: 200,
    base: base2,
    draft: d2,
    writer,
    fetchRow,
  });
  assert.equal(c.kind, 'conflict');
  assert.deepEqual(c.cols, ['Description']);
  const batch = conflictBatch(base2, d2, c.fresh, { Description: 'mine' }, diffChantier);
  assert.deepEqual(batch.changes, { Description: 'La mienne' });
  const r2 = await runSave({ table: 'Chantiers', taskId: 200, base: base2, draft: d2, writer, fetchRow, ...batch });
  assert.equal(r2.kind, 'saved');
  assert.equal((await fetchRow(200)).Statut, 'Terminé');
});

test('fiche chantier : projet retiré, ses tâches rattachées au projet restant dans le même lot', async () => {
  const { g, gw, writer, model } = setup();
  const fetchRow = (id) => gw.fetchRow('Chantiers', id);
  const base = await fetchRow(201);
  const draft = { ...chantierDraftFrom(base), Projets: [30] };
  const plan = reattachPlan(model, 201, draft.Projets, 30);
  const bad = await runSave({ table: 'Chantiers', diff: diffChantier, taskId: 201, base, draft, writer, fetchRow });
  assert.equal(bad.kind, 'failed');
  assert.ok(bad.error instanceof WriteRefused && bad.error.reason === 'taches-projet');
  const ok = await runSave({
    table: 'Chantiers',
    diff: diffChantier,
    taskId: 201,
    base,
    draft,
    writer,
    fetchRow,
    also: plan.also,
  });
  assert.equal(ok.kind, 'saved');
  assert.deepEqual(g.batches.at(-1), [
    ['UpdateRecord', 'Chantiers', 201, { Projets: ['L', 30] }],
    ['UpdateRecord', 'Tasks', 2010, { projet: 30 }],
  ]);
});

test('statut rapide d’un chantier : la seule colonne Statut, relue avant l’envoi', async () => {
  const { g, gw, writer } = setup();
  const fetchRow = (id) => gw.fetchRow('Chantiers', id);
  const r = await runQuickStatus({ table: 'Chantiers', taskId: 200, status: 'Terminé', writer, fetchRow, today: 1 });
  assert.equal(r.kind, 'saved');
  assert.deepEqual(g.batches[0], [['UpdateRecord', 'Chantiers', 200, { Statut: 'Terminé' }]]);
  const same = await runQuickStatus({ table: 'Chantiers', taskId: 200, status: 'Terminé', writer, fetchRow });
  assert.equal(same.kind, 'nothing');
});

test('création : tâche puis sous-tâche dans le nouveau chantier ; refus et absence de réponse', async () => {
  const { g, writer } = setup();
  const ch = await runCreate({ writer, table: 'Chantiers', fields: { Nom_du_chantier: 'Nouveau', Projets: [10] } });
  assert.equal(ch.kind, 'saved');
  const chId = ch.entry.id;
  const t = await runCreate({
    writer,
    table: 'Tasks',
    fields: { titre: 'Tâche', Chantier: chId, projet: 10, statut: 'todo', type: 'tache', Cree_par: 'alice' },
  });
  assert.equal(t.kind, 'saved');
  const model = buildModel({ ...feuille(), tables: g.data });
  const sub = newTaskFields({ ...newTaskDraft(model, { parentId: t.entry.id }), titre: 'Sous-tâche' });
  assert.equal(sub.Chantier, chId);
  const s = await runCreate({ writer, table: 'Tasks', fields: sub });
  assert.equal(s.kind, 'saved');
  assert.equal(g.batches.length, 3);
  assert.deepEqual(g.batches[2][0][3].parentTask, t.entry.id);
  const refused = await runCreate({ writer, table: 'Tasks', fields: { titre: '', Chantier: chId, projet: 10 } });
  assert.equal(refused.kind, 'failed');
  const hang = setup({ grist: { hang: 'after' } });
  const h = createWriter({ docApi: hang.g.docApi, mode: 'on', columns: META, lookup: lookupOf(hang.g), timeoutMs: 20 });
  assert.equal(
    (await runCreate({ writer: h, table: 'Chantiers', fields: { Nom_du_chantier: 'N', Projets: [10] } })).kind,
    'unknown',
  );
});

test('changement de chantier : relu avant l’envoi ; modifié ailleurs, rien n’est envoyé ; sous-tâches suivent', async () => {
  const { g, gw, writer, model } = setup();
  const fetchRow = (id) => gw.fetchRow('Tasks', id);
  const plan = movePlan(model, 1000, 200, 20);
  g.otherUserSets('Tasks', 1000, { Chantier: 201 });
  const c = await runMove({ writer, taskId: 1000, plan, fetchRow });
  assert.equal(c.kind, 'changed');
  assert.equal(g.batches.length, 0);
  g.otherUserSets('Tasks', 1000, { Chantier: 100 });
  const r = await runMove({ writer, taskId: 1000, plan, fetchRow });
  assert.equal(r.kind, 'saved');
  assert.deepEqual(g.batches[0][1], [
    'BulkUpdateRecord',
    'Tasks',
    [1001, 1002],
    { Chantier: [200, 200], projet: [20, 20] },
  ]);
  assert.equal((await runMove({ writer, taskId: 4242, plan, fetchRow })).kind, 'missing');
  const broken = await runMove({ writer, taskId: 1000, plan, fetchRow: async () => assert.fail('x') });
  assert.equal(broken.kind, 'reread-failed');
  // Mode essai : pas de relecture, rien n'est envoyé
  const dry = setup({ mode: 'dry-run' });
  const d = await runMove({ writer: dry.writer, taskId: 1000, plan, fetchRow: async () => assert.fail() });
  assert.equal(d.kind, 'saved');
  assert.equal(dry.g.batches.length, 0);
  // Grist ne répond pas : résultat relu
  const hang = setup({ grist: { hang: 'before' } });
  const h = createWriter({ docApi: hang.g.docApi, mode: 'on', columns: META, lookup: lookupOf(hang.g), timeoutMs: 20 });
  const hr = await runMove({
    writer: h,
    taskId: 1000,
    plan,
    fetchRow: (id) => createGateway(hang.g).fetchRow('Tasks', id),
  });
  assert.equal(hr.kind, 'unknown');
  assert.equal(hr.stored.Chantier, 100);
  // Ligne disparue côté Grist pendant l'envoi
  const gone = setup({ grist: { fail: 'Invalid row id 1000' } });
  const gr = await runMove({
    writer: gone.writer,
    taskId: 1000,
    plan,
    fetchRow: (id) => gone.gw.fetchRow('Tasks', id),
  });
  assert.equal(gr.kind, 'missing');
  const other = setup({ grist: { fail: 'Boom' } });
  assert.equal(
    (await runMove({ writer: other.writer, taskId: 1000, plan, fetchRow: (id) => other.gw.fetchRow('Tasks', id) }))
      .kind,
    'failed',
  );
});
