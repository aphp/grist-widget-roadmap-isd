/**
 * Suppression depuis la fiche : une tâche avec toutes ses sous-tâches, ou un chantier vide, dans un seul lot de
 * RemoveRecord ; refus si une ligne hors du lot en dépend, hors périmètre, ou hors de Tasks et Chantiers.
 * « Annuler » recrée les lignes au même identifiant (AddRecord à identifiant fixe, valeurs relues avant la
 * suppression, parents avant enfants). Faux Grist Node, jamais de vrai Grist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feuille } from './fixtures/feuille.js';
import { createFakeGrist, lookupOf } from './fixtures/fake-grist.js';
import {
  EXPECTED_TYPES,
  REMOVABLE,
  WRITABLE,
  WriteFailed,
  WriteRefused,
  applyToTables,
  assertActions,
  createWriter,
  dataCells,
  deletionBatch,
  linksFromTables,
  lookupFromTables,
  referencesIn,
} from '../widget/js/core/grist-writer.js';
import { buildModel } from '../widget/js/core/model.js';
import { deletePlan } from '../widget/js/core/delete-plan.js';
import { runDelete } from '../widget/js/core/task-session.js';

/** Tables de la mini Feuille, avec toutes les colonnes de la liste blanche, dependDe des chantiers et une formule. */
function tables() {
  const t = feuille().tables;
  for (const [name, ops] of Object.entries(WRITABLE))
    for (const c of new Set([...ops.update, ...ops.add])) t[name][c] ??= t[name].id.map(() => null);
  t.Chantiers.dependDe = t.Chantiers.id.map(() => null);
  t.Tasks.manualSort = t.Tasks.id.map((id) => id / 10);
  t.Tasks.avancement = t.Tasks.id.map(() => 0.5); // colonne formule : jamais dans l'instantané
  // Chantier vide (aucune tâche)
  t.Chantiers.id.push(500);
  for (const c of Object.keys(t.Chantiers)) if (c !== 'id') t.Chantiers[c].push(null);
  const i = t.Chantiers.id.indexOf(500);
  t.Chantiers.Nom_du_chantier[i] = 'Chantier vide';
  t.Chantiers.Projets[i] = ['L', 10];
  return t;
}

/** Métadonnées de toutes les colonnes lues (type de la liste blanche, sinon Any) ; avancement est une formule. */
function metaOf(t) {
  const out = {};
  for (const [name, cols] of Object.entries(t))
    for (const c of Object.keys(cols))
      if (c !== 'id')
        out[`${name}.${c}`] = { type: EXPECTED_TYPES[`${name}.${c}`] ?? 'Any', isFormula: c === 'avancement' };
  return out;
}

function setup(opts = {}) {
  const t = tables();
  const g = createFakeGrist(t, opts.grist);
  const lookup = { ...lookupOf(g), table: (n) => g.data[n] ?? null };
  const writer = createWriter({
    docApi: g.docApi,
    mode: opts.mode ?? 'on',
    columns: metaOf(t),
    lookup,
    readTable: async (n) => structuredClone(g.data[n]),
    ...opts.writer,
  });
  return { g, writer, lookup };
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

const row = (g, table, id) => {
  const i = g.data[table].id.indexOf(id);
  return i < 0 ? null : Object.fromEntries(Object.keys(g.data[table]).map((c) => [c, g.data[table][c][i]]));
};

test('deletionBatch : tâche et sous-tâches (parents d’abord), chantier vide, refus chantier non vide et références', () => {
  const t = tables();
  const links = linksFromTables(t);
  assert.deepEqual(deletionBatch(links, 'Tasks', 1000), {
    ok: true,
    rows: [
      { table: 'Tasks', id: 1000 },
      { table: 'Tasks', id: 1001 },
      { table: 'Tasks', id: 1002 },
    ],
  });
  assert.deepEqual(deletionBatch(links, 'Chantiers', 500), { ok: true, rows: [{ table: 'Chantiers', id: 500 }] });
  assert.deepEqual(deletionBatch(links, 'Chantiers', 100), { ok: false, reason: 'chantier-non-vide', n: 3 });
  assert.equal(deletionBatch(links, 'Tasks', 77).reason, 'ligne');
  assert.equal(deletionBatch(links, 'Chantiers', 77).reason, 'ligne');
  for (const table of ['Team', 'Projects', 'Disponibilites', '_grist_Tables'])
    assert.equal(deletionBatch(links, table, 1).reason, 'table');
  // Petite-fille : à toute profondeur, toujours après son parent
  const deep = structuredClone(t);
  deep.Tasks.parentTask[deep.Tasks.id.indexOf(1500)] = 1002;
  assert.deepEqual(
    deletionBatch(linksFromTables(deep), 'Tasks', 1000).rows.map((r) => r.id),
    [1000, 1001, 1002, 1500],
  );
  // dependDe d'une tâche hors du lot → refus ; dependDe interne au lot → admis
  const ext = structuredClone(t);
  ext.Tasks.dependDe[ext.Tasks.id.indexOf(2000)] = ['L', 1001];
  assert.deepEqual(deletionBatch(linksFromTables(ext), 'Tasks', 1000), {
    ok: false,
    reason: 'reference',
    refs: [{ table: 'Tasks', id: 2000 }],
  });
  const chDep = structuredClone(t);
  chDep.Chantiers.dependDe[chDep.Chantiers.id.indexOf(300)] = ['L', 1002];
  assert.deepEqual(deletionBatch(linksFromTables(chDep), 'Tasks', 1000).refs, [{ table: 'Chantiers', id: 300 }]);
  const inner = structuredClone(t);
  inner.Tasks.dependDe[inner.Tasks.id.indexOf(1002)] = ['L', 1001];
  assert.equal(deletionBatch(linksFromTables(inner), 'Tasks', 1000).ok, true);
  // Scanner unique : sans exclusion, la sous-tâche référence sa tâche
  assert.deepEqual(referencesIn(links, 'Tasks', [1000]), [
    { table: 'Tasks', id: 1001 },
    { table: 'Tasks', id: 1002 },
  ]);
  assert.deepEqual(referencesIn(links, 'Team', [1]), []);
});

test('dataCells : colonnes de données relues telles quelles, sans formule ; colonne inconnue ou erreur → null', () => {
  const meta = { 'Tasks.titre': { isFormula: false }, 'Tasks.f': { isFormula: true }, 'Tasks.manualSort': {} };
  const r = { id: 5, titre: 'T', f: 3, manualSort: 2, gristHelper_Display: 'x' };
  assert.deepEqual(dataCells('Tasks', r, meta), { titre: 'T', manualSort: 2 });
  assert.equal(dataCells('Tasks', { ...r, autre: 1 }, meta), null);
  assert.equal(dataCells('Tasks', { ...r, titre: ['E', 'TypeError'] }, meta), null);
  assert.equal(dataCells('Tasks', r, null), null);
  assert.equal(dataCells('Tasks', null, meta), null);
});

test('supprimer une tâche : un seul lot de RemoveRecord (tâche puis sous-tâches), instantané sans formule', async () => {
  const { g, writer } = setup();
  assert.deepEqual(REMOVABLE, ['Tasks', 'Chantiers']);
  assert.deepEqual(writer.canRemove('Tasks'), { ok: true, reason: 'ok' });
  const before1001 = row(g, 'Tasks', 1001);
  const e = await writer.remove('Tasks', 1000);
  assert.deepEqual(g.batches, [
    [
      ['RemoveRecord', 'Tasks', 1000],
      ['RemoveRecord', 'Tasks', 1001],
      ['RemoveRecord', 'Tasks', 1002],
    ],
  ]);
  assert.equal(e.kind, 'delete');
  assert.equal(e.sent, true);
  assert.equal(e.before.titre, 'Ajout table FHIR Adresse');
  assert.deepEqual(
    e.snapshot.map((s) => s.id),
    [1000, 1001, 1002],
  );
  const s1001 = e.snapshot[1].values;
  assert.ok(!('avancement' in s1001) && !('id' in s1001));
  const data = Object.fromEntries(Object.entries(before1001).filter(([c]) => c !== 'id' && c !== 'avancement'));
  assert.deepEqual(s1001, data);
  assert.equal(row(g, 'Tasks', 1000), null);
  assert.equal(writer.lastUndoable(), e);
});

test('« Annuler » une suppression : AddRecord aux mêmes identifiants, parents d’abord, valeurs relues', async () => {
  const { g, writer } = setup();
  const before = [1000, 1001, 1002].map((id) => row(g, 'Tasks', id));
  await writer.remove('Tasks', 1000);
  const r = await writer.undoLast(async () => assert.fail('pas de relecture de ligne'));
  const batch = g.batches.at(-1);
  assert.deepEqual(
    batch.map((a) => [a[0], a[1], a[2]]),
    [
      ['AddRecord', 'Tasks', 1000],
      ['AddRecord', 'Tasks', 1001],
      ['AddRecord', 'Tasks', 1002],
    ],
  );
  assert.equal(r.undoEntry.kind, 'restore');
  assert.equal(r.undoEntry.sent, true);
  assert.equal(r.entry.undone, true);
  for (const b of before) {
    const now = row(g, 'Tasks', b.id);
    assert.deepEqual({ ...now, avancement: b.avancement }, b);
  }
  // Une restauration ne s'annule pas ; une seconde restauration du même instantané est refusée
  assert.equal(writer.lastUndoable(), null);
  assert.throws(() => assertActions(batch, {}), WriteRefused);
  // Locale (mode essai) : les lignes recréées dans les tables chargées avec toutes leurs colonnes
  const local = applyToTables({ Tasks: { id: [], titre: [], avancement: [] } }, r.undoEntry.applied);
  assert.deepEqual(local.Tasks.id, [1000, 1001, 1002]);
  assert.deepEqual(local.Tasks.avancement, [0.5, 0.5, 0.5]);
});

test('chantier : vide supprimé puis restauré ; non vide refusé sans rien envoyer', async () => {
  const { g, writer } = setup();
  assert.equal(await reason(writer.remove('Chantiers', 100)), 'chantier-non-vide');
  assert.equal(g.batches.length, 0);
  const before = row(g, 'Chantiers', 500);
  const e = await writer.remove('Chantiers', 500);
  assert.deepEqual(g.batches, [[['RemoveRecord', 'Chantiers', 500]]]);
  assert.equal(e.before.Nom_du_chantier, 'Chantier vide');
  await writer.undoLast(async () => null);
  assert.deepEqual(g.batches.at(-1)[0].slice(0, 3), ['AddRecord', 'Chantiers', 500]);
  assert.deepEqual(row(g, 'Chantiers', 500), before);
});

test('refus avant tout envoi : dépendance externe, périmètre, tables, identifiant, lot changé', async () => {
  const { g, writer } = setup({ writer: { canWriteRow: (t, id) => id !== 1002 } });
  assert.equal(await reason(writer.remove('Tasks', 1000)), 'perimetre');
  g.otherUserSets('Tasks', 2000, { dependDe: ['L', 2010] });
  assert.equal(await reason(writer.remove('Tasks', 2010)), 'reference');
  for (const t of ['Team', 'Projects', 'Disponibilites']) {
    assert.equal(await reason(writer.remove(t, 1)), 'table');
    assert.equal(writer.canRemove(t).ok, false);
  }
  assert.equal(await reason(writer.remove('Tasks', 0)), 'identifiant');
  assert.equal(await reason(writer.remove('Tasks', 77)), 'ligne');
  // Sous-tâche ajoutée ailleurs depuis la confirmation : rien n'est envoyé
  const { g: g2, writer: w2 } = setup();
  g2.otherUserAdds('Tasks', { titre: 'Nouvelle', Chantier: 100, projet: 10, parentTask: 1000 });
  assert.equal(await reason(w2.remove('Tasks', 1000, { expect: [1000, 1001, 1002] })), 'lot-change');
  assert.equal(g.batches.length + g2.batches.length, 0);
});

test('mode essai : rien n’est envoyé ni relu, journal et annulation notés sur les données chargées', async () => {
  const t = tables();
  const g = createFakeGrist(t);
  let loaded = structuredClone(g.data);
  const writer = createWriter({
    docApi: g.docApi,
    mode: 'dry-run',
    columns: metaOf(t),
    lookup: lookupFromTables(new Proxy({}, { get: (_, n) => loaded[n] })),
    readTable: async () => assert.fail('pas de relecture en mode essai'),
    preflight: async () => assert.fail('pas de flags.json en mode essai'),
  });
  const e = await writer.remove('Tasks', 1000);
  assert.equal(e.sent, false);
  assert.equal(e.actions.length, 3);
  loaded = applyToTables(loaded, e.applied);
  assert.ok(!loaded.Tasks.id.includes(1001));
  const r = await writer.undoLast(async () => assert.fail());
  assert.equal(r.undoEntry.sent, false);
  assert.equal(r.undoEntry.actions[0][2], 1000);
  assert.equal(g.batches.length, 0);
});

test('annulation refusée si un identifiant est réutilisé, ou si la relecture échoue', async () => {
  const { g, writer } = setup();
  await writer.remove('Chantiers', 500);
  g.data.Chantiers.id.push(500);
  for (const c of Object.keys(g.data.Chantiers)) if (c !== 'id') g.data.Chantiers[c].push(null);
  const n = g.batches.length;
  const r = await writer.undoLast(async () => null);
  assert.equal(r.reason, 'reutilise');
  assert.equal(r.undoEntry, null);
  assert.equal(g.batches.length, n);
  const s2 = setup({ writer: { readTable: async () => assert.fail('lecture') } });
  // La suppression elle-même relit les tables : refus de relecture, rien n'est envoyé
  assert.equal(await reason(s2.writer.remove('Chantiers', 500)), 'relecture');
  assert.equal(s2.g.batches.length, 0);
  let fail = false;
  const s3 = setup({
    writer: {
      readTable: async (name) => {
        if (fail) throw new Error('lecture');
        return structuredClone(s3.g.data[name]);
      },
    },
  });
  await s3.writer.remove('Chantiers', 500);
  fail = true;
  assert.equal((await s3.writer.undoLast(async () => null)).reason, 'relecture');
});

test('assertActions : AddRecord à identifiant fixe seulement s’il reproduit un instantané de la session', () => {
  const cells = { titre: 'T', manualSort: 3, estimationH: 2 };
  const ok = (t, id, f) => t === 'Tasks' && id === 7 && JSON.stringify(f) === JSON.stringify(cells);
  assert.doesNotThrow(() => assertActions([['AddRecord', 'Tasks', 7, cells]], { restorable: ok }));
  const r = (a, o) => {
    try {
      assertActions(a, o);
    } catch (e) {
      return e.reason;
    }
    return null;
  };
  assert.equal(r([['AddRecord', 'Tasks', 7, { titre: 'T' }]], { restorable: ok }), 'identifiant');
  assert.equal(r([['AddRecord', 'Tasks', 8, cells]], { restorable: ok }), 'identifiant');
  assert.equal(r([['AddRecord', 'Tasks', 7, cells]], {}), 'identifiant');
  assert.equal(r([['AddRecord', 'Tasks', -1, cells]], { restorable: () => true }), 'identifiant');
  assert.equal(r([['AddRecord', 'Team', 7, cells]], { restorable: () => true }), 'suppression');
  // RemoveRecord : jamais sur Team, même dans le lot d'une suppression
  assert.equal(r([['RemoveRecord', 'Team', 1]], { removable: () => true }), 'suppression');
  assert.equal(r([['RemoveRecord', 'Projects', 1]], { removable: () => true }), 'table');
});

test('canRemove et échecs : coupé, essai, session bloquée, règle d’accès, arrêt d’urgence, sans métadonnées', async () => {
  const off = createWriter({ docApi: null, mode: 'off', columns: {} });
  assert.deepEqual(off.canRemove('Tasks'), { ok: false, reason: 'off' });
  assert.equal(await reason(off.remove('Tasks', 1000)), 'off');
  const noMeta = setup({ writer: { columns: null } });
  assert.equal(noMeta.writer.canRemove('Tasks').reason, 'meta');
  assert.equal(await reason(noMeta.writer.remove('Tasks', 1000)), 'verification');
  // Règle d'accès : suppression refusée pour la session dans cette table
  const acl = setup({ grist: { fail: 'Blocked by table update access rules' } });
  await assert.rejects(acl.writer.remove('Chantiers', 500), (e) => e instanceof WriteFailed && e.kind === 'acl');
  assert.deepEqual(acl.writer.canRemove('Chantiers'), { ok: false, reason: 'acl' });
  assert.equal(acl.writer.canRemove('Tasks').ok, true);
  assert.equal(await reason(acl.writer.remove('Chantiers', 500)), 'suppression-refusee');
  // Compte lecteur : toute la session en lecture
  const viewer = setup({ grist: { fail: 'No write access' } });
  await assert.rejects(viewer.writer.remove('Chantiers', 500), (e) => e instanceof WriteFailed && e.document);
  assert.deepEqual(viewer.writer.canRemove('Tasks'), { ok: false, reason: 'viewer' });
  assert.equal(await reason(viewer.writer.remove('Tasks', 1000)), 'viewer');
  // Arrêt d'urgence relu juste avant l'envoi
  const cut = setup({ writer: { preflight: async () => false } });
  assert.equal(await reason(cut.writer.remove('Chantiers', 500)), 'coupe');
  assert.equal(cut.g.batches.length, 0);
  // Session bloquée : rien n'est relu
  const locked = setup();
  locked.writer.lock('flags');
  assert.equal(await reason(locked.writer.remove('Chantiers', 500)), 'flags');
  // Sans relecture possible en envoi réel : refus
  const noRead = setup({ writer: { readTable: null } });
  assert.equal(await reason(noRead.writer.remove('Chantiers', 500)), 'verification');
});

test('sans réponse dans le délai : lignes disparues à la relecture → suppression retenue (annulable) ; sinon inconnu', async () => {
  const after = setup({ grist: { hang: 'after' }, writer: { timeoutMs: 30 } });
  const e = await after.writer.remove('Chantiers', 500);
  assert.equal(e.recovered, true);
  assert.equal(after.writer.lastUndoable(), e);
  const before = setup({ grist: { hang: 'before' }, writer: { timeoutMs: 30 } });
  await assert.rejects(before.writer.remove('Chantiers', 500), (x) => x instanceof WriteFailed && x.kind === 'timeout');
  assert.equal(before.writer.lastUndoable(), null);
});

test('runDelete : saved, refused, failed, unknown', async () => {
  const { writer } = setup();
  const ok = await runDelete({ writer, table: 'Chantiers', id: 500 });
  assert.equal(ok.kind, 'saved');
  assert.equal(ok.entry.kind, 'delete');
  const no = await runDelete({ writer, table: 'Chantiers', id: 100, expect: [100] });
  assert.equal(no.kind, 'refused');
  assert.equal(no.reason, 'chantier-non-vide');
  const acl = setup({ grist: { fail: 'Blocked by table update access rules' } });
  const f = await runDelete({ writer: acl.writer, table: 'Tasks', id: 1000 });
  assert.equal(f.kind, 'failed');
  assert.equal(f.error.kind, 'acl');
  const hang = setup({ grist: { hang: 'before' }, writer: { timeoutMs: 30 } });
  assert.equal((await runDelete({ writer: hang.writer, table: 'Tasks', id: 1000, timeoutMs: 30 })).kind, 'unknown');
  const boom = { remove: async () => Promise.reject(new Error('x')) };
  assert.equal((await runDelete({ writer: boom, table: 'Tasks', id: 1 })).kind, 'failed');
});

test('deletePlan : même règle sur les données chargées, titres pour la fenêtre, refus avec ses variables', () => {
  const raw = feuille();
  raw.tables = tables();
  const model = buildModel(raw);
  assert.deepEqual(deletePlan(model, 'Tasks', 1000), {
    ok: true,
    count: 3,
    rows: [
      { table: 'Tasks', id: 1000, title: 'Ajout table FHIR Adresse' },
      { table: 'Tasks', id: 1001, title: 'instruction' },
      { table: 'Tasks', id: 1002, title: 'réalisation' },
    ],
  });
  assert.deepEqual(deletePlan(model, 'Chantiers', 500), {
    ok: true,
    count: 1,
    rows: [{ table: 'Chantiers', id: 500, title: 'Chantier vide' }],
  });
  assert.deepEqual(deletePlan(model, 'Chantiers', 100), {
    ok: false,
    reason: 'chantier-non-vide',
    vars: { n: 3 },
  });
  assert.deepEqual(deletePlan(model, 'Team', 1), { ok: false, reason: 'table', vars: {} });
  assert.deepEqual(deletePlan(model, 'Tasks', 77), { ok: false, reason: 'ligne', vars: {} });
  assert.deepEqual(deletePlan(model, 'Tasks', 1000, { canWriteRow: (t, id) => id !== 1001 }), {
    ok: false,
    reason: 'perimetre',
    vars: { n: 1, noms: '« instruction »' },
  });
  const dep = feuille();
  dep.tables = tables();
  dep.tables.Tasks.dependDe[dep.tables.Tasks.id.indexOf(2000)] = ['L', 1002];
  dep.tables.Chantiers.dependDe[dep.tables.Chantiers.id.indexOf(300)] = ['L', 1001];
  assert.deepEqual(deletePlan(buildModel(dep), 'Tasks', 1000), {
    ok: false,
    reason: 'reference',
    vars: { n: 2, noms: '« Entraînement », « Reporting »' },
  });
});
