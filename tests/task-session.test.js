import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feuille } from './fixtures/feuille.js';
import { GRIST_ERRORS, createFakeGrist, lookupOf } from './fixtures/fake-grist.js';
import { createGateway } from '../widget/js/core/grist-gateway.js';
import {
  EXPECTED_TYPES,
  WRITABLE,
  WriteFailed,
  buildUpdate,
  classifyError,
  createWriter,
  decodeRow,
} from '../widget/js/core/grist-writer.js';
import { applyToTables } from '../widget/js/core/grist-writer.js';
import { diffDraft, draftFrom, rebaseDraft } from '../widget/js/core/task-form.js';
import {
  batchWithCharges,
  conflictBatch,
  failureKind,
  runDates,
  runQuickStatus,
  runSave,
} from '../widget/js/core/task-session.js';
import { periodConflictCols } from '../widget/js/core/conflicts.js';
import { resolveEditState, writerMode } from '../widget/js/core/edit-switch.js';
import { dayOfIso } from '../widget/js/core/dates.js';
import { fteHours } from '../widget/js/core/capacity.js';
import { maxHours, roundHours } from '../widget/js/core/charges-edit.js';

const META = Object.fromEntries(Object.entries(EXPECTED_TYPES).map(([k, type]) => [k, { type, isFormula: false }]));

/** Faux Grist + passerelle + writer en envoi réel, sur la mini Feuille. */
function setup(opts = {}) {
  const tables = feuille().tables;
  // Toutes les colonnes de la liste blanche existent dans la Feuille (la mini Feuille n'en porte qu'une partie)
  for (const c of WRITABLE.Tasks.update) tables.Tasks[c] ??= tables.Tasks.id.map(() => null);
  const g = createFakeGrist(tables, opts);
  const gw = createGateway(g);
  const writer = createWriter({
    docApi: g.docApi,
    mode: opts.mode ?? 'on',
    columns: META,
    lookup: lookupOf(g),
    ...opts.writer,
  });
  const fetchRow = (id) => gw.fetchRow('Tasks', id);
  return { g, gw, writer, fetchRow };
}

test('aller-retour complet : brouillon → envoi → Grist → relecture → aucune différence', async () => {
  const { g, writer, fetchRow } = setup();
  const base = await fetchRow(1002);
  const draft = {
    ...draftFrom(base),
    titre: 'réalisation v2',
    statut: 'done',
    type: 'jalon',
    dateDebut: dayOfIso('2026-03-29'),
    dateEcheance: dayOfIso('2026-10-25'),
    dateCloture: dayOfIso('2024-02-29'),
    priorite: '2',
    Responsable: 2,
    assignees: [],
    dependDe: [1001, 1000],
    parentTask: null,
    description: 'Ligne 1\nLigne 2 <b>',
    Commentaire: '',
    Lien_utile: 'https://exemple.fr/a?b=1',
    progression: 75,
  };
  const r = await runSave({ taskId: 1002, base, draft, writer, fetchRow });
  assert.equal(r.kind, 'saved');
  assert.equal(g.batches.length, 1);
  const cells = g.batches[0][0][3];
  assert.equal(cells.assignees, null);
  assert.equal(cells.Responsable, 2);
  assert.equal(cells.parentTask, 0);
  assert.deepEqual(cells.dependDe, ['L', 1001, 1000]);
  assert.equal(cells.dateDebut % 86400, 0);
  const back = await fetchRow(1002);
  assert.deepEqual(diffDraft(back, draft), {});
  // La correction locale du modèle donne la même chose que la relecture
  const before = feuille().tables;
  for (const c of WRITABLE.Tasks.update) before.Tasks[c] ??= before.Tasks.id.map(() => null);
  const local = decodeRow(applyToTables(before, g.batches[0]).Tasks, 'Tasks', 1002);
  assert.deepEqual(local, back);
});

test('chaque enregistrement écrit dans la ligne de son instantané, jamais dans le formulaire suivant (I1)', async () => {
  const { g, writer, fetchRow } = setup();
  let release;
  const slowRead = (id) => new Promise((r) => (release = () => r(fetchRow(id))));
  const baseA = await fetchRow(1001);
  const pending = runSave({
    taskId: 1001,
    base: baseA,
    draft: { ...draftFrom(baseA), titre: 'A modifiée' },
    writer,
    fetchRow: slowRead,
  });
  // Pendant la relecture, un autre formulaire (tâche 1002) est ouvert : sans effet sur l'envoi en cours
  release();
  const r = await pending;
  assert.equal(r.kind, 'saved');
  assert.deepEqual(g.batches, [[['UpdateRecord', 'Tasks', 1001, { titre: 'A modifiée' }]]]);
  assert.equal((await fetchRow(1002)).titre, 'réalisation');
});

test('conflit : détecté champ par champ ; la nouvelle base fait suivre les champs non touchés (I2)', async () => {
  const { g, writer, fetchRow } = setup();
  const base = await fetchRow(1002);
  const draft = { ...draftFrom(base), titre: 'Ma version' };
  g.otherUserSets('Tasks', 1002, { titre: 'Leur version', Commentaire: 'note de quelqu’un' });
  const r = await runSave({ taskId: 1002, base, draft, writer, fetchRow });
  assert.equal(r.kind, 'conflict');
  assert.deepEqual(r.cols, ['titre']);
  assert.equal(g.batches.length, 0);
  // Après la fenêtre de conflit, le brouillon suit la Feuille pour Commentaire (non touché) : un nouvel essai
  // ne réécrit jamais l'ancien commentaire
  const rebased = rebaseDraft(base, draft, r.fresh);
  assert.equal(rebased.Commentaire, 'note de quelqu’un');
  assert.equal(rebased.titre, 'Ma version');
  assert.deepEqual(diffDraft(r.fresh, rebased), { titre: 'Ma version' });
  const again = await runSave({ taskId: 1002, base: r.fresh, draft: rebased, writer, fetchRow });
  assert.equal(again.kind, 'saved');
  assert.deepEqual(g.batches.at(-1)[0][3], { titre: 'Ma version' });
  assert.equal((await fetchRow(1002)).Commentaire, 'note de quelqu’un');
});

test('lot déjà arbitré (après conflit) : envoyé tel quel, sans nouvelle relecture', async () => {
  const { g, writer } = setup();
  const r = await runSave({
    taskId: 1002,
    base: {},
    draft: {},
    writer,
    fetchRow: () => assert.fail('pas de relecture'),
    changes: { titre: 'X' },
    before: { titre: 'Y' },
  });
  assert.equal(r.kind, 'saved');
  assert.deepEqual(r.entry.before, { titre: 'Y' });
  assert.equal(g.batches.length, 1);
});

test('relecture impossible : rien n’est envoyé sans l’accord de l’utilisateur (M1)', async () => {
  const { g, writer, fetchRow } = setup();
  const base = await fetchRow(1002);
  const draft = { ...draftFrom(base), titre: 'Z' };
  const broken = async () => {
    throw new Error('réseau');
  };
  const r = await runSave({ taskId: 1002, base, draft, writer, fetchRow: broken });
  assert.deepEqual(r, { kind: 'reread-failed', error: 'réseau' });
  assert.equal(g.batches.length, 0);
  const forced = await runSave({ taskId: 1002, base, draft, writer, fetchRow: broken, skipCheck: true });
  assert.equal(forced.kind, 'saved');
  assert.equal(g.batches.length, 1);
});

test('ligne disparue (relecture ou message de Grist), rien à enregistrer, mode essai', async () => {
  const { writer, fetchRow } = setup();
  const base = await fetchRow(1002);
  assert.equal(
    (
      await runSave({
        taskId: 1002,
        base,
        draft: { ...draftFrom(base), titre: 'Z' },
        writer,
        fetchRow: async () => null,
      })
    ).kind,
    'missing',
  );
  assert.equal((await runSave({ taskId: 1002, base, draft: draftFrom(base), writer, fetchRow })).kind, 'nothing');
  const gone = setup({ fail: GRIST_ERRORS.missing });
  const r = await runSave({
    taskId: 1002,
    base,
    draft: { ...draftFrom(base), titre: 'Z' },
    writer: gone.writer,
    fetchRow: gone.fetchRow,
  });
  assert.equal(r.kind, 'missing');
  const dry = setup({ mode: 'dry-run' });
  const d = await runSave({
    taskId: 1002,
    base,
    draft: { ...draftFrom(base), titre: 'Z' },
    writer: dry.writer,
    fetchRow: () => assert.fail(),
  });
  assert.equal(d.kind, 'saved');
  assert.equal(d.entry.sent, false);
  assert.equal(dry.g.batches.length, 0);
});

test('messages réels de Grist : lecteur (tout le document), règles d’accès, ligne disparue', async () => {
  assert.equal(classifyError(GRIST_ERRORS.viewer), 'acl');
  assert.equal(classifyError(GRIST_ERRORS.aclTable), 'acl');
  assert.equal(classifyError(GRIST_ERRORS.aclColumn), 'acl');
  assert.equal(classifyError(GRIST_ERRORS.aclRow), 'acl');
  assert.equal(classifyError(GRIST_ERRORS.missing), 'missing');

  const viewer = setup({ fail: GRIST_ERRORS.viewer });
  const base = await viewer.fetchRow(1002);
  const r = await runSave({
    taskId: 1002,
    base,
    draft: { ...draftFrom(base), titre: 'Z' },
    writer: viewer.writer,
    fetchRow: viewer.fetchRow,
  });
  assert.equal(r.kind, 'failed');
  assert.equal(failureKind(r.error), 'document');
  assert.ok(viewer.writer.isBlocked());
  assert.deepEqual(viewer.writer.can('Tasks', 'statut'), { ok: false, reason: 'viewer' });

  const acl = setup({ fail: GRIST_ERRORS.aclColumn });
  const r2 = await runSave({
    taskId: 1002,
    base,
    draft: { ...draftFrom(base), titre: 'Z', Commentaire: 'C' },
    writer: acl.writer,
    fetchRow: acl.fetchRow,
  });
  assert.equal(failureKind(r2.error), 'acl');
  // Lot de deux colonnes : on ne sait pas laquelle est visée, aucune n'est verrouillée (I6)
  assert.ok(acl.writer.can('Tasks', 'titre').ok && acl.writer.can('Tasks', 'Commentaire').ok);
  assert.ok(!acl.writer.isBlocked());
  assert.equal(failureKind(new Error('x')), 'other');
  assert.equal(failureKind(new WriteFailed('other', 'x')), 'other');
});

test('statut rapide : clôture calculée sur la ligne relue, pas sur une copie ancienne (M4)', async () => {
  const { g, writer, fetchRow } = setup();
  const today = dayOfIso('2026-10-19');
  const stale = { ...(await fetchRow(1000)), dateCloture: null };
  g.otherUserSets('Tasks', 1000, { dateCloture: 86400 * dayOfIso('2026-10-01') });
  const r = await runQuickStatus({ taskId: 1000, status: 'done', localBase: stale, writer, fetchRow, today });
  assert.equal(r.kind, 'saved');
  assert.deepEqual(g.batches.at(-1)[0][3], { statut: 'done' });
  const r2 = await runQuickStatus({ taskId: 1001, status: 'todo', localBase: null, writer, fetchRow, today });
  assert.deepEqual(r2.entry.after, { statut: 'todo' });
  const r3 = await runQuickStatus({ taskId: 1002, status: 'done', localBase: null, writer, fetchRow, today });
  assert.deepEqual(r3.entry.after, { statut: 'done', dateCloture: today });
  assert.equal(
    (await runQuickStatus({ taskId: 1002, status: 'done', localBase: null, writer, fetchRow, today })).kind,
    'nothing',
  );
  assert.equal((await runQuickStatus({ taskId: 9, status: 'done', writer, fetchRow, today })).kind, 'missing');
  const broken = async () => {
    throw new Error('réseau');
  };
  assert.equal(
    (await runQuickStatus({ taskId: 1002, status: 'todo', writer, fetchRow: broken, today })).kind,
    'reread-failed',
  );
  // Mode essai : base locale, sans relecture
  const dry = setup({ mode: 'dry-run' });
  const d = await runQuickStatus({
    taskId: 1000,
    status: 'review',
    localBase: stale,
    writer: dry.writer,
    fetchRow: () => assert.fail(),
    today,
  });
  assert.equal(d.entry.sent, false);
  assert.equal(
    (await runQuickStatus({ taskId: 1000, status: 'review', localBase: null, writer: dry.writer, today })).kind,
    'missing',
  );
  const viewer = setup({ fail: GRIST_ERRORS.viewer });
  const v = await runQuickStatus({
    taskId: 1000,
    status: 'review',
    writer: viewer.writer,
    fetchRow: viewer.fetchRow,
    today,
  });
  assert.equal(failureKind(v.error), 'document');
});

test('périmètre (M3) et arrêt d’urgence avant envoi (I3) : contrôlés par le writer lui-même', async () => {
  let flags = true;
  const s = setup({ writer: { canWriteRow: (t, id) => id !== 4001, preflight: async () => flags } });
  await assert.rejects(
    () => s.writer.update('Tasks', 4001, { titre: 'x' }),
    (e) => e.reason === 'perimetre',
  );
  await s.writer.update('Tasks', 1000, { titre: 'x' });
  flags = false;
  await assert.rejects(
    () => s.writer.update('Tasks', 1000, { titre: 'y' }),
    (e) => failureKind(e) === 'refused:coupe',
  );
  assert.equal(s.g.batches.length, 1);
});

test('état d’édition → mode du writer : off dès que l’utilisateur ne peut pas modifier', () => {
  const base = { doc: 'D', docId: 'D', flagsOk: true, access: 'editors' };
  const mode = (o) => writerMode(resolveEditState({ ...base, ...o }));
  assert.equal(mode({ requested: 'on' }), 'on');
  assert.equal(mode({ requested: 'dry-run' }), 'dry-run');
  assert.equal(mode({ requested: 'on', access: 'viewers' }), 'off');
  assert.equal(mode({ requested: 'dry-run', access: 'viewers' }), 'off');
  assert.equal(mode({ requested: 'on', doc: 'E' }), 'off');
  assert.equal(mode({ requested: 'on', flagsOk: false }), 'off');
  assert.equal(mode({ requested: 'off' }), 'off');
  assert.equal(writerMode(null), 'off');
  assert.equal(writerMode({ canEdit: true, mode: 'autre' }), 'off');
  // Jeton toujours demandé en lecture seule
  const g = createFakeGrist({});
  return createGateway(g)
    .fetchAccess(async () => ({ ok: false }))
    .then((a) => {
      assert.equal(a.docId, 'doc-faux-test');
      assert.deepEqual(g.tokens, [{ readOnly: true }]);
    });
});

test('buildUpdate refuse une table héritée de Object (N1)', () => {
  assert.throws(
    () => buildUpdate('constructor', 1, { a: 1 }),
    (e) => e.reason === 'table',
  );
  assert.throws(
    () => buildUpdate('toString', 1, { a: 1 }),
    (e) => e.reason === 'table',
  );
});

test('délai dépassé à l’envoi : résultat inconnu, ligne relue (écrite ou non) (R1)', async () => {
  const after = setup({ hang: 'after', writer: { timeoutMs: 30 } });
  const base = await after.fetchRow(1002);
  const r = await runSave({
    taskId: 1002,
    base,
    draft: { ...draftFrom(base), titre: 'Peut-être' },
    writer: after.writer,
    fetchRow: after.fetchRow,
    timeoutMs: 30,
  });
  assert.equal(r.kind, 'unknown');
  assert.equal(r.stored.titre, 'Peut-être');
  assert.deepEqual(r.changes, { titre: 'Peut-être' });
  assert.deepEqual(diffDraft(r.stored, rebaseDraft(base, { ...draftFrom(base), titre: 'Peut-être' }, r.stored)), {});
  assert.equal(after.writer.journal().length, 0);

  const before = setup({ hang: 'before', writer: { timeoutMs: 30 } });
  const r2 = await runSave({
    taskId: 1002,
    base,
    draft: { ...draftFrom(base), titre: 'Jamais' },
    writer: before.writer,
    fetchRow: before.fetchRow,
    timeoutMs: 30,
  });
  assert.equal(r2.kind, 'unknown');
  assert.equal(r2.stored.titre, 'réalisation');
  // Relecture impossible elle aussi : stored indéfini
  let first = true;
  const flaky = async (id) => {
    if (first) {
      first = false;
      return before.fetchRow(id);
    }
    return new Promise(() => {});
  };
  const r3 = await runSave({
    taskId: 1002,
    base,
    draft: { ...draftFrom(base), titre: 'X' },
    writer: before.writer,
    fetchRow: flaky,
    timeoutMs: 30,
  });
  assert.equal(r3.kind, 'unknown');
  assert.equal(r3.stored, undefined);
  // Statut rapide : même traitement
  const q = await runQuickStatus({
    taskId: 1002,
    status: 'review',
    writer: after.writer,
    fetchRow: after.fetchRow,
    today: 1,
    timeoutMs: 30,
  });
  assert.equal(q.kind, 'unknown');
  assert.equal(q.stored.statut, 'review');
});

test('relecture sans réponse avant l’envoi : rien n’est envoyé (R1)', async () => {
  const s = setup();
  const base = await s.fetchRow(1002);
  const hang = () => new Promise(() => {});
  const r = await runSave({
    taskId: 1002,
    base,
    draft: { ...draftFrom(base), titre: 'Z' },
    writer: s.writer,
    fetchRow: hang,
    timeoutMs: 30,
  });
  assert.equal(r.kind, 'reread-failed');
  assert.match(r.error, /délai/);
  const q = await runQuickStatus({
    taskId: 1002,
    status: 'review',
    writer: s.writer,
    fetchRow: hang,
    today: 1,
    timeoutMs: 30,
  });
  assert.equal(q.kind, 'reread-failed');
  assert.equal(s.g.batches.length, 0);
});

test('arrêt d’urgence sans réponse avant l’envoi : refus « flags-indisponible », rien n’est envoyé (R1)', async () => {
  const hang = setup({ writer: { timeoutMs: 30, preflight: () => new Promise(() => {}) } });
  await assert.rejects(
    () => hang.writer.update('Tasks', 1000, { titre: 'x' }),
    (e) => failureKind(e) === 'refused:flags-indisponible',
  );
  const broken = setup({
    writer: {
      preflight: async () => {
        throw new TypeError('Failed to fetch');
      },
    },
  });
  await assert.rejects(
    () => broken.writer.update('Tasks', 1000, { titre: 'x' }),
    (e) => failureKind(e) === 'refused:flags-indisponible',
  );
  assert.equal(hang.g.batches.length + broken.g.batches.length, 0);
  assert.ok(!hang.writer.isBlocked());
});

test('session verrouillée : plus d’écriture, journal conservé (R3)', async () => {
  const s = setup();
  await s.writer.update('Tasks', 1000, { titre: 'a' }, { before: { titre: 'b' } });
  s.writer.lock('flags');
  s.writer.lock('viewer');
  assert.deepEqual(s.writer.can('Tasks', 'titre'), { ok: false, reason: 'flags' });
  await assert.rejects(
    () => s.writer.update('Tasks', 1000, { titre: 'c' }),
    (e) => failureKind(e) === 'refused:flags',
  );
  assert.equal(s.writer.journal().length, 1);
  assert.ok(s.writer.isBlocked());
});

test('délai des requêtes : 10 s, raccourci seulement par delai= (entre 1 et 10 s)', async () => {
  const { readTimeout } = await import('../widget/js/core/edit-switch.js');
  assert.equal(readTimeout(''), 10000);
  assert.equal(readTimeout('?delai=1500'), 1500);
  assert.equal(readTimeout('?delai=10'), 1000);
  assert.equal(readTimeout('?delai=999999'), 10000);
  assert.equal(readTimeout('?delai=abc'), 10000);
  assert.equal(readTimeout(undefined), 10000);
});

test('charges : modification concurrente d’une autre entrée conservée (fusion sur le JSON brut)', async () => {
  const team = (t, id) => t === 'Team' && [1, 2, 3, 4, 5, 6, 7].includes(id);
  const { g, writer, fetchRow } = setup({ writer: { refExists: team } });
  const base = await fetchRow(2010);
  assert.equal(base.charges, '[{"teamId":5,"heures":14},{"teamId":99,"heures":3}]');
  const draft = { ...draftFrom(base), charges: '[{"teamId":5,"heures":21},{"teamId":99,"heures":3}]' };
  // Quelqu'un d'autre ajoute Alice pendant la saisie, avec une autre écriture du JSON
  const i = g.data.Tasks.id.indexOf(2010);
  g.data.Tasks.charges[i] = '[{"teamId": 5, "heures": 14}, {"teamId": 99, "heures": 3}, {"teamId": 1, "heures": 7}]';
  const r = await runSave({ taskId: 2010, base, draft, writer, fetchRow });
  assert.equal(r.kind, 'saved');
  assert.deepEqual(g.batches, [
    [
      [
        'UpdateRecord',
        'Tasks',
        2010,
        // Texte d'origine des entrées non touchées recopié octet par octet (M1)
        { charges: '[{"teamId":5,"heures":21},{"teamId": 99, "heures": 3},{"teamId": 1, "heures": 7}]' },
      ],
    ],
  ]);
  // Valeur d’avant (pour « Annuler ») : la cellule relue, avec l’ajout de l’autre personne
  assert.match(r.entry.before.charges, /"teamId": 1, "heures": 7/);
  // Même personne modifiée des deux côtés : conflit, rien n'est envoyé, la version « mienne » est fusionnée
  const base2 = await fetchRow(2010);
  g.data.Tasks.charges[i] =
    '[{"teamId":5,"heures":28},{"teamId":99,"heures":3},{"teamId":1,"heures":7},{"teamId":2,"heures":1}]';
  const draft2 = {
    ...draftFrom(base2),
    charges: '[{"teamId":5,"heures":35},{"teamId":99,"heures":3},{"teamId":1,"heures":7}]',
  };
  const c = await runSave({ taskId: 2010, base: base2, draft: draft2, writer, fetchRow });
  assert.equal(c.kind, 'conflict');
  assert.deepEqual(c.cols, ['charges']);
  assert.equal(
    c.mine.charges,
    '[{"teamId":5,"heures":35},{"teamId":99,"heures":3},{"teamId":1,"heures":7},{"teamId":2,"heures":1}]',
  );
  assert.equal(g.batches.length, 1);
});

test('charges : le writer refuse une personne inconnue de Team et un JSON non tableau', async () => {
  const { g, writer, fetchRow } = setup({ writer: { refExists: (t, id) => t === 'Team' && id === 1 } });
  const base = await fetchRow(1002);
  for (const charges of ['[{"teamId":42,"heures":7}]', '{"teamId":1}', '[{"teamId":1,"heures":-2}]']) {
    const r = await runSave({ taskId: 1002, base, draft: { ...draftFrom(base), charges }, writer, fetchRow });
    assert.equal(r.kind, 'failed', charges);
    assert.equal(failureKind(r.error), 'refused:charges');
  }
  assert.equal(g.batches.length, 0);
});

test('charges illisibles remplacées par une saisie vide, puis « Annuler » rend le contenu d’origine', async () => {
  const { g, writer, fetchRow } = setup({ writer: { refExists: () => true } });
  const base = await fetchRow(2000);
  assert.equal(base.charges, 'oops');
  const r = await runSave({ taskId: 2000, base, draft: { ...draftFrom(base), charges: '[]' }, writer, fetchRow });
  assert.equal(r.kind, 'saved');
  const i = g.data.Tasks.id.indexOf(2000);
  assert.equal(g.data.Tasks.charges[i], '[]');
  const u = await writer.undoLast((t, id) => fetchRow(id));
  assert.deepEqual(u.skipped, []);
  assert.equal(g.data.Tasks.charges[i], 'oops');
  // Hors « Annuler », le même contenu illisible est refusé
  await assert.rejects(writer.update('Tasks', 2000, { charges: 'oops' }, { before: { charges: '[]' } }), /charges/);
});

/** Ligne 1002 préparée : titre T, p1 = 10 h, p2 = 10 h. */
function prepareConflict() {
  const ctx = setup({ writer: { refExists: (t, id) => t === 'Team' && id >= 1 && id <= 7 } });
  const i = ctx.g.data.Tasks.id.indexOf(1002);
  ctx.g.data.Tasks.titre[i] = 'T';
  ctx.g.data.Tasks.charges[i] = '[{"teamId":1,"heures":10},{"teamId":2,"heures":10}]';
  return { ...ctx, i };
}

test('I1 : conflit sur le titre, charges modifiées ailleurs sur une autre personne : elles survivent', async () => {
  const { g, writer, fetchRow, i } = prepareConflict();
  const base = await fetchRow(1002);
  // A : titre T3, p2 = 20 h
  const draft = { ...draftFrom(base), titre: 'T3', charges: '[{"teamId":1,"heures":10},{"teamId":2,"heures":20}]' };
  // B enregistre entre-temps : titre T2, p1 = 50 h
  g.data.Tasks.titre[i] = 'T2';
  g.data.Tasks.charges[i] = '[{"teamId":1,"heures":50},{"teamId":2,"heures":10}]';
  const r = await runSave({ taskId: 1002, base, draft, writer, fetchRow });
  assert.equal(r.kind, 'conflict');
  assert.deepEqual(r.cols, ['titre']);
  // A garde son titre
  const batch = conflictBatch(base, draft, r.fresh, { titre: 'mine' });
  const s = await runSave({ taskId: 1002, base, draft, writer, fetchRow, ...batch });
  assert.equal(s.kind, 'saved');
  assert.equal(g.data.Tasks.titre[i], 'T3');
  assert.equal(g.data.Tasks.charges[i], '[{"teamId":1,"heures":50},{"teamId":2,"heures":20}]');
  // « Prendre la leur » sur le titre : seules les charges fusionnées partent
  const b2 = conflictBatch(base, draft, r.fresh, { titre: 'theirs' });
  assert.deepEqual(Object.keys(b2.changes), ['charges']);
});

test('M2 : « Garder la mienne » relit et refusionne : une 3e modification faite pendant la fenêtre survit', async () => {
  const { g, writer, fetchRow, i } = prepareConflict();
  const base = await fetchRow(1002);
  const draft = { ...draftFrom(base), charges: '[{"teamId":1,"heures":20},{"teamId":2,"heures":10}]' };
  g.data.Tasks.charges[i] = '[{"teamId":1,"heures":30},{"teamId":2,"heures":10}]';
  const r = await runSave({ taskId: 1002, base, draft, writer, fetchRow });
  assert.deepEqual(r.cols, ['charges']);
  // Pendant la fenêtre de conflit, C ajoute p3
  g.data.Tasks.charges[i] = '[{"teamId":1,"heures":30},{"teamId":2,"heures":10},{"teamId": 3, "heures": 5}]';
  const batch = conflictBatch(base, draft, r.fresh, { charges: 'mine' });
  const s = await runSave({ taskId: 1002, base, draft, writer, fetchRow, ...batch });
  assert.equal(s.kind, 'saved');
  assert.equal(
    g.data.Tasks.charges[i],
    '[{"teamId":1,"heures":20},{"teamId":2,"heures":10},{"teamId": 3, "heures": 5}]',
  );
  assert.equal(
    s.entry.before.charges,
    '[{"teamId":1,"heures":30},{"teamId":2,"heures":10},{"teamId": 3, "heures": 5}]',
  );
  // Même résultat déjà présent dans la Feuille : rien n'est envoyé
  const n = g.batches.length;
  const again = await runSave({ taskId: 1002, base, draft, writer, fetchRow, ...batch });
  assert.equal(again.kind, 'nothing');
  assert.equal(g.batches.length, n);
  // Relecture impossible ou ligne disparue au moment d'appliquer : rien n'est envoyé
  const failing = await runSave({
    taskId: 1002,
    base,
    draft,
    writer,
    ...batch,
    fetchRow: () => Promise.reject(new Error('x')),
  });
  assert.equal(failing.kind, 'reread-failed');
  const gone = await runSave({ taskId: 1002, base, draft, writer, ...batch, fetchRow: async () => null });
  assert.equal(gone.kind, 'missing');
});

test('M3 : le writer refuse plus de 1 ETP par personne sur la période (entrée nouvelle ou modifiée)', async () => {
  const doc = { sent: [], applyUserActions: async (a) => (doc.sent.push(a), { retValues: [null] }) };
  const w = createWriter({
    docApi: doc,
    mode: 'on',
    columns: Object.fromEntries(Object.entries(EXPECTED_TYPES).map(([k, type]) => [k, { type, isFormula: false }])),
    refExists: () => true,
    periodOf: () => ({ start: 100, end: 113 }), // 1 ETP standard du 11 au 24 avril 1970 : 58 h au plus
  });
  const max = roundHours(fteHours(100, 113));
  assert.equal(max, 58);
  await assert.rejects(w.update('Tasks', 1, { charges: `[{"teamId":1,"heures":${max + 0.5}}]` }), /1 ETP/);
  await w.update('Tasks', 1, { charges: `[{"teamId":1,"heures":${max}}]` });
  // Valeur au-dessus conservée telle quelle : admise
  await w.update(
    'Tasks',
    1,
    { charges: '[{"teamId":1,"heures":100},{"teamId":2,"heures":3}]' },
    {
      before: { charges: '[{"teamId":1,"heures":100}]' },
    },
  );
  // Dates du même lot : la période raccourcie (du 11 au 17 avril, 5 jours ouvrés) s'applique
  const short = roundHours(fteHours(100, 106));
  assert.ok(short < 40);
  await assert.rejects(
    w.update('Tasks', 1, { dateEcheance: 106, charges: '[{"teamId":1,"heures":40}]' }),
    new RegExp(`au plus ${short} h`),
  );
  assert.equal(doc.sent.length, 2);
});

test('R1 : cellule devenue illisible juste avant l’envoi : nouvelle fenêtre de conflit, rien n’est écrit', async () => {
  const { g, writer, fetchRow, i } = prepareConflict();
  const base = await fetchRow(1002);
  const draft = { ...draftFrom(base), titre: 'T3', charges: '[{"teamId":1,"heures":10},{"teamId":2,"heures":20}]' };
  g.data.Tasks.titre[i] = 'T2';
  g.data.Tasks.charges[i] = '[{"teamId":1,"heures":50},{"teamId":2,"heures":10}]';
  const r = await runSave({ taskId: 1002, base, draft, writer, fetchRow });
  assert.deepEqual(r.cols, ['titre']);
  const batch = conflictBatch(base, draft, r.fresh, { titre: 'mine' });
  // Pendant la fenêtre, quelqu'un laisse la cellule illisible (les 50 h de p1 y sont)
  const broken = '[{"teamId":1,"heures":50},oops';
  g.data.Tasks.charges[i] = broken;
  const s = await runSave({ taskId: 1002, base, draft, writer, fetchRow, ...batch });
  assert.equal(s.kind, 'conflict');
  assert.deepEqual(s.cols, ['charges']);
  assert.equal(g.batches.length, 0);
  assert.equal(g.data.Tasks.charges[i], broken);
  // Cellule illisible dès l'ouverture, remplacement confirmé : écrit seulement si elle n'a pas changé depuis
  const base2 = { ...(await fetchRow(1002)) };
  const replace = conflictBatch(base2, { ...draftFrom(base2), charges: '[]' }, base2, {});
  g.data.Tasks.charges[i] = 'oops';
  assert.equal((await runSave({ taskId: 1002, base: base2, writer, fetchRow, ...replace })).kind, 'conflict');
  g.data.Tasks.charges[i] = broken;
  assert.equal((await runSave({ taskId: 1002, base: base2, writer, fetchRow, ...replace })).kind, 'saved');
  assert.equal(g.data.Tasks.charges[i], '[]');
});

test('R2 : même personne modifiée entre la fenêtre et le clic : la fenêtre se rouvre pour les charges', async () => {
  const { g, writer, fetchRow, i } = prepareConflict();
  const base = await fetchRow(1002);
  const draft = { ...draftFrom(base), titre: 'T3', charges: '[{"teamId":1,"heures":10},{"teamId":2,"heures":20}]' };
  g.data.Tasks.titre[i] = 'T2';
  g.data.Tasks.charges[i] = '[{"teamId":1,"heures":50},{"teamId":2,"heures":10}]';
  const r = await runSave({ taskId: 1002, base, draft, writer, fetchRow });
  const batch = conflictBatch(base, draft, r.fresh, { titre: 'mine' });
  // Pendant la fenêtre, p2 passe à 30 h
  g.data.Tasks.charges[i] = '[{"teamId":1,"heures":50},{"teamId":2,"heures":30}]';
  const s = await runSave({ taskId: 1002, base, draft, writer, fetchRow, ...batch });
  assert.equal(s.kind, 'conflict');
  assert.deepEqual(s.cols, ['charges']);
  assert.equal(s.mine.charges, '[{"teamId":1,"heures":50},{"teamId":2,"heures":20}]');
  assert.equal(g.batches.length, 0);
  assert.match(g.data.Tasks.charges[i], /"teamId":2,"heures":30/);
  // L'utilisateur tranche « Garder la mienne » dans la nouvelle fenêtre : écrit, p1 conservé
  const base2 = { ...base, ...r.fresh, titre: base.titre };
  const draft2 = { ...draft, charges: s.mine.charges };
  const again = conflictBatch(base2, draft2, s.fresh, { charges: 'mine' });
  const w = await runSave({ taskId: 1002, base: base2, draft: draft2, writer, fetchRow, ...again });
  assert.equal(w.kind, 'saved');
  assert.equal(g.data.Tasks.charges[i], '[{"teamId":1,"heures":50},{"teamId":2,"heures":20}]');
  assert.equal(g.data.Tasks.titre[i], 'T3');
});

test('R4 : la borne de 1 ETP suit les dates de la ligne relue, pas celles des données chargées', async () => {
  // Données chargées : 2 au 15 janvier 1970 (1 ETP ≈ 58 h) ; ligne relue : dates raccourcies ailleurs à 3 jours
  // ouvrés (26 au 28 octobre 2026)
  const { g, writer, fetchRow } = setup({
    writer: { refExists: () => true, periodOf: () => ({ start: 1, end: 14 }) },
  });
  const i = g.data.Tasks.id.indexOf(1002);
  const base = await fetchRow(1002);
  const draft = { ...draftFrom(base), charges: '[{"teamId":1,"heures":40}]' };
  g.data.Tasks.dateEcheance[i] = g.data.Tasks.dateDebut[i] + 2 * 86400;
  // Période changée ailleurs depuis la saisie : fenêtre de conflit d'abord ; « Garder la mienne » envoie les
  // charges sur les dates relues, que le writer borne
  const c = await runSave({ taskId: 1002, base, draft, writer, fetchRow });
  assert.deepEqual([c.kind, c.cols], ['conflict', ['charges']]);
  const batch = conflictBatch(base, draft, c.fresh, { charges: 'mine' });
  const r = await runSave({ taskId: 1002, base: c.fresh, draft, writer, fetchRow, ...batch });
  assert.equal(r.kind, 'failed');
  assert.ok(40 < roundHours(fteHours(1, 14)));
  const start = dayOfIso('2026-10-26');
  assert.match(r.error.message, new RegExp(`au plus ${roundHours(fteHours(start, start + 2))} h`));
  assert.equal(g.batches.length, 0);
});

test('periodConflictCols : charges et date de la période envoyées, période changée ailleurs', () => {
  const seen = { dateDebut: 10, dateEcheance: 23 };
  const ch = { dateEcheance: 37, charges: '[]' };
  assert.deepEqual(periodConflictCols(seen, seen, ch), []);
  assert.deepEqual(periodConflictCols(seen, { dateDebut: 17, dateEcheance: 23 }, ch), ['dateEcheance']);
  // Échéance changée ailleurs aussi : la saisie la remplace, même période
  assert.deepEqual(periodConflictCols(seen, { dateDebut: 10, dateEcheance: 30 }, ch), []);
  // Sans charges dans le lot : rien
  assert.deepEqual(periodConflictCols(seen, { dateDebut: 17 }, { dateEcheance: 37 }), []);
  // Charges sans date : conflit sur les charges si la période relue n'a plus la capacité de celle de la saisie
  assert.deepEqual(periodConflictCols(seen, { dateDebut: 17, dateEcheance: 23 }, { charges: '[]' }), ['charges']);
  assert.deepEqual(periodConflictCols(seen, { dateDebut: 10, dateEcheance: 23 }, { charges: '[]' }), []);
  assert.deepEqual(periodConflictCols(seen, { dateDebut: 10, dateEcheance: null }, { charges: '[]' }), ['charges']);
  // Capacité comparée, pas la durée : début déplacé ailleurs du samedi 4 au lundi 6 septembre 2027 (mêmes jours
  // ouvrés) : pas de conflit ; au mardi 7 : un jour ouvré de moins, conflit
  const sat = { dateDebut: dayOfIso('2027-09-04'), dateEcheance: dayOfIso('2027-09-10') };
  const lot = { dateEcheance: dayOfIso('2027-09-17'), charges: '[]' };
  assert.deepEqual(periodConflictCols(sat, { dateDebut: dayOfIso('2027-09-06') }, lot), []);
  assert.deepEqual(periodConflictCols(sat, { dateDebut: dayOfIso('2027-09-07') }, lot), ['dateEcheance']);
});

test('ETP gardé : date de début changée ailleurs pendant un allongement, fenêtre de conflit puis heures recalculées sur les dates envoyées', async () => {
  const { g, writer, fetchRow } = setup();
  const day = (iso) => dayOfIso(iso);
  // 0,5 ETP du 2 au 15 novembre ; l'ETP fait foi, les heures suivent la capacité standard de chaque période
  const h0 = roundHours(fteHours(day('2026-11-02'), day('2026-11-15')) / 2);
  const etp = h0 / fteHours(day('2026-11-02'), day('2026-11-15'));
  const long = roundHours(etp * fteHours(day('2026-11-02'), day('2026-11-29')));
  const sent = roundHours(etp * fteHours(day('2026-11-09'), day('2026-11-29')));
  g.otherUserSets('Tasks', 1002, {
    dateDebut: 86400 * day('2026-11-02'),
    dateEcheance: 86400 * day('2026-11-15'),
    charges: `[{"teamId":1,"heures":${h0}}]`,
  });
  const base = await fetchRow(1002);
  // Saisie : échéance + 14 jours, 0,5 ETP gardé ; ailleurs, début au 9 novembre
  const draft = { ...draftFrom(base), dateEcheance: day('2026-11-29'), charges: `[{"teamId":1,"heures":${long}}]` };
  g.otherUserSets('Tasks', 1002, { dateDebut: 86400 * day('2026-11-09') });
  const r = await runSave({ taskId: 1002, base, draft, writer, fetchRow });
  assert.equal(r.kind, 'conflict');
  assert.ok(r.cols.includes('dateEcheance'));
  assert.equal(g.batches.length, 0);
  // « Garder la mienne » : 9 au 29 novembre, heures recalculées sur cette période
  const batch = batchWithCharges(
    conflictBatch(base, draft, r.fresh, { dateEcheance: 'mine' }),
    `[{"teamId":1,"heures":${sent}}]`,
    r.fresh,
  );
  assert.equal(batch.chargesBase, r.fresh.charges);
  // La période bouge encore ailleurs avant l'envoi : nouvelle fenêtre, rien n'est envoyé
  g.otherUserSets('Tasks', 1002, { dateDebut: 86400 * day('2026-11-16') });
  const again = await runSave({ taskId: 1002, base: r.fresh, draft, writer, fetchRow, ...batch });
  assert.deepEqual([again.kind, again.cols], ['conflict', ['dateEcheance']]);
  g.otherUserSets('Tasks', 1002, { dateDebut: 86400 * day('2026-11-09') });
  const saved = await runSave({ taskId: 1002, base: r.fresh, draft, writer, fetchRow, ...batch });
  assert.equal(saved.kind, 'saved');
  const cells = g.batches.at(-1)[0][3];
  assert.equal(cells.charges, `[{"teamId":1,"heures":${sent}}]`);
  assert.equal(cells.dateEcheance, 86400 * day('2026-11-29'));
  // Charges identiques à la ligne relue : retirées du lot
  assert.equal('charges' in batchWithCharges({ changes: { charges: 'x' } }, r.fresh.charges, r.fresh).changes, false);
});

test('charges seules envoyées, période changée ailleurs depuis la saisie : conflit, rien n’est envoyé (ETP gardé)', async () => {
  const { g, writer, fetchRow } = setup();
  const base = await fetchRow(1002);
  const draft = { ...draftFrom(base), charges: '[{"teamId":1,"heures":20}]' };
  // Ailleurs : échéance allongée d'une semaine ; 20 h ne vaudraient plus le même ETP
  g.otherUserSets('Tasks', 1002, { dateEcheance: 86400 * (base.dateEcheance + 7) });
  const r = await runSave({ taskId: 1002, base, draft, writer, fetchRow });
  assert.deepEqual([r.kind, r.cols], ['conflict', ['charges']]);
  assert.equal(g.batches.length, 0);
  // Après la fenêtre (dates de la ligne relue retenues), la période bouge encore : nouvelle fenêtre
  const batch = conflictBatch(base, draft, r.fresh, { charges: 'mine' });
  g.otherUserSets('Tasks', 1002, { dateEcheance: 86400 * (base.dateEcheance + 14) });
  const again = await runSave({ taskId: 1002, base: r.fresh, draft, writer, fetchRow, ...batch });
  assert.deepEqual([again.kind, again.cols], ['conflict', ['charges']]);
  assert.equal(g.batches.length, 0);
  // Même capacité qu'à la saisie : envoyé
  g.otherUserSets('Tasks', 1002, { dateEcheance: 86400 * (base.dateEcheance + 7) });
  const saved = await runSave({ taskId: 1002, base: r.fresh, draft, writer, fetchRow, ...batch });
  assert.equal(saved.kind, 'saved');
  assert.deepEqual(Object.keys(g.batches[0][0][3]), ['charges']);
});

const D = 86400;
const day = (iso) => dayOfIso(iso);
const TASK_COLS = ['dateDebut', 'dateEcheance'];
const maxOf = (_teamId, fte) => maxHours(fte);

/** Faux Grist avec toutes les colonnes de la liste blanche (tâches et chantiers), pour runDates. */
function datesSetup(opts = {}) {
  const tables = feuille().tables;
  for (const [name, ops] of Object.entries(WRITABLE))
    for (const c of new Set([...ops.update, ...ops.add])) tables[name][c] ??= tables[name].id.map(() => null);
  const g = createFakeGrist(tables, opts.grist);
  const gw = createGateway(g);
  const writer = createWriter({
    docApi: g.docApi,
    mode: opts.mode ?? 'on',
    columns: META,
    lookup: lookupOf(g),
    ...opts.writer,
  });
  return { g, gw, writer, fetchRow: (id) => gw.fetchRow('Tasks', id) };
}

/** Tâche 1002 posée sur une période (jours) avec ses charges et ses assignés. */
function place(g, period, charges, assignees = ['L', 1]) {
  g.otherUserSets('Tasks', 1002, { dateDebut: D * period.start, dateEcheance: D * period.end, charges, assignees });
}

const OCT1 = { start: day('2027-10-04'), end: day('2027-10-10') };
const OCT2 = { start: day('2027-10-11'), end: day('2027-10-17') };

test('runDates : dates relues différentes de celles vues → changed, aucun envoi', async () => {
  const { g, writer, fetchRow } = datesSetup();
  place(g, OCT1, '[{"teamId":1,"heures":14.5}]');
  g.otherUserSets('Tasks', 1002, { dateEcheance: D * day('2027-10-12') });
  const snap = { writer, table: 'Tasks', id: 1002, cols: TASK_COLS, seen: OCT1, next: OCT2, fetchRow, maxOf };
  const r = await runDates(snap);
  assert.equal(r.kind, 'changed');
  assert.equal(r.fresh.dateEcheance, day('2027-10-12'));
  g.otherUserSets('Tasks', 1002, { dateEcheance: D * OCT1.end, dateDebut: D * day('2027-10-01') });
  assert.equal((await runDates(snap)).kind, 'changed');
  assert.equal(g.batches.length, 0);
  // Mêmes dates que celles vues : rien à envoyer
  g.otherUserSets('Tasks', 1002, { dateDebut: D * OCT1.start });
  assert.equal((await runDates({ ...snap, next: OCT1 })).kind, 'nothing');
  assert.equal(g.batches.length, 0);
});

test('runDates : déplacement à capacité égale → charges non envoyées', async () => {
  const { g, writer, fetchRow } = datesSetup();
  assert.equal(fteHours(OCT1.start, OCT1.end), fteHours(OCT2.start, OCT2.end));
  place(g, OCT1, '[{"teamId":1,"heures":14.5}]');
  const r = await runDates({
    writer,
    table: 'Tasks',
    id: 1002,
    cols: TASK_COLS,
    seen: OCT1,
    next: OCT2,
    fetchRow,
    maxOf,
  });
  assert.equal(r.kind, 'saved');
  assert.deepEqual(r.keptOver, []);
  assert.deepEqual(g.batches[0][0][3], { dateDebut: D * OCT2.start, dateEcheance: D * OCT2.end });
  assert.deepEqual(r.entry.before, { dateDebut: OCT1.start, dateEcheance: OCT1.end });
  // Seule l'échéance change (dimanche → samedi, même capacité) : elle part seule, sans charges
  const { g: g2, writer: w2, fetchRow: f2 } = datesSetup();
  place(g2, OCT1, '[{"teamId":1,"heures":14.5}]');
  const sunday = { start: OCT1.start, end: day('2027-10-09') };
  assert.equal(fteHours(sunday.start, sunday.end), fteHours(OCT1.start, OCT1.end));
  const one = await runDates({
    writer: w2,
    table: 'Tasks',
    id: 1002,
    cols: TASK_COLS,
    seen: OCT1,
    next: sunday,
    fetchRow: f2,
    maxOf,
  });
  assert.equal(one.kind, 'saved');
  assert.deepEqual(g2.batches[0][0][3], { dateEcheance: D * sunday.end });
});

test('runDates : déplacement de juin à juillet 2027 à durée égale → heures recalculées, ETP gardé', async () => {
  const { g, writer, fetchRow } = datesSetup();
  const june = { start: day('2027-06-07'), end: day('2027-06-20') };
  const july = { start: day('2027-07-05'), end: day('2027-07-18') };
  const fJune = fteHours(june.start, june.end);
  const fJuly = fteHours(july.start, july.end);
  assert.notEqual(fJune, fJuly);
  const h0 = roundHours(fJune / 2);
  place(g, june, `[{"teamId":1,"heures":${h0}}]`);
  const r = await runDates({
    writer,
    table: 'Tasks',
    id: 1002,
    cols: TASK_COLS,
    seen: june,
    next: july,
    fetchRow,
    maxOf,
  });
  assert.equal(r.kind, 'saved');
  const cells = g.batches[0][0][3];
  const sent = JSON.parse(cells.charges);
  assert.deepEqual(sent, [{ teamId: 1, heures: roundHours((h0 / fJune) * fJuly) }]);
  assert.ok(Math.abs(sent[0].heures / fJuly - h0 / fJune) < 0.5 / fJuly);
  assert.equal(r.entry.before.charges, `[{"teamId":1,"heures":${h0}}]`);
});

test('runDates : étirement → charges recalculées sur la cellule RELUE (une personne ajoutée ailleurs est recalculée aussi)', async () => {
  const { g, writer, fetchRow } = datesSetup();
  const long = { start: OCT1.start, end: OCT2.end };
  // Vue : Alice seule ; ailleurs, Eve ajoutée avant le relâcher
  place(g, OCT1, '[{"teamId":1,"heures":14.5}]');
  g.otherUserSets('Tasks', 1002, {
    charges: '[{"teamId":1,"heures":14.5},{"teamId":5,"heures":7}]',
    assignees: ['L', 1, 5],
  });
  const snap = { writer, table: 'Tasks', id: 1002, cols: TASK_COLS, seen: OCT1, next: long, fetchRow, maxOf };
  const r = await runDates(snap);
  assert.equal(r.kind, 'saved');
  const cells = g.batches[0][0][3];
  assert.equal(cells.dateEcheance, D * long.end);
  assert.deepEqual(JSON.parse(cells.charges), [
    { teamId: 1, heures: 29 },
    { teamId: 5, heures: 14 },
  ]);
  assert.equal(r.entry.before.charges, '[{"teamId":1,"heures":14.5},{"teamId":5,"heures":7}]');
  // Recalcul au-dessus de la borne d'une personne : son entrée reste telle quelle et est signalée
  const { g: g2, writer: w2, fetchRow: f2 } = datesSetup();
  place(g2, OCT1, '[{"teamId":1,"heures":14.5},{"teamId":5,"heures":7}]', ['L', 1, 5]);
  const capped = (teamId, fte) => (teamId === 5 ? 10 : maxHours(fte));
  const c = await runDates({ ...snap, writer: w2, fetchRow: f2, maxOf: capped });
  assert.equal(c.kind, 'saved');
  assert.deepEqual(c.keptOver, [5]);
  assert.deepEqual(JSON.parse(g2.batches[0][0][3].charges), [
    { teamId: 1, heures: 29 },
    { teamId: 5, heures: 7 },
  ]);
  // Cellule illisible : jamais touchée, seules les dates partent
  const { g: g3, writer: w3, fetchRow: f3 } = datesSetup();
  place(g3, OCT1, 'oops');
  const u = await runDates({ ...snap, writer: w3, fetchRow: f3 });
  assert.equal(u.kind, 'saved');
  assert.deepEqual(Object.keys(g3.batches[0][0][3]), ['dateEcheance']);
});

test('runDates : charges non modifiables et recalcul nécessaire → refused', async () => {
  const { g, writer, fetchRow } = datesSetup();
  place(g, OCT1, '[{"teamId":1,"heures":14.5}]');
  writer.refuse('Tasks', 'charges');
  const snap = { writer, table: 'Tasks', id: 1002, cols: TASK_COLS, seen: OCT1, fetchRow, maxOf };
  const r = await runDates({ ...snap, next: { start: OCT1.start, end: OCT2.end } });
  assert.deepEqual(r, { kind: 'refused', reason: 'charges' });
  assert.equal(g.batches.length, 0);
  // Capacité égale : aucune charge à recalculer, les dates partent
  assert.equal((await runDates({ ...snap, next: OCT2 })).kind, 'saved');
  assert.equal(g.batches.length, 1);
});

test('runDates : ligne disparue → missing ; relecture en échec → reread-failed ; délai → unknown', async () => {
  const { g, writer, fetchRow } = datesSetup();
  place(g, OCT1, '[{"teamId":1,"heures":14.5}]');
  const snap = { writer, table: 'Tasks', id: 1002, cols: TASK_COLS, seen: OCT1, next: OCT2, fetchRow, maxOf };
  assert.equal((await runDates({ ...snap, id: 4242 })).kind, 'missing');
  // Borne des charges oubliée par l'appelant : erreur de programmation, rien n'est lu ni envoyé
  await assert.rejects(runDates({ ...snap, maxOf: undefined }), TypeError);
  const broken = await runDates({ ...snap, fetchRow: async () => assert.fail('x') });
  assert.equal(broken.kind, 'reread-failed');
  const slow = await runDates({ ...snap, fetchRow: () => new Promise(() => {}), timeoutMs: 20 });
  assert.equal(slow.kind, 'reread-failed');
  assert.match(slow.error, /délai/);
  // Grist ne répond pas à l'envoi : résultat relu
  const hang = datesSetup({ grist: { hang: 'before' }, writer: { timeoutMs: 20 } });
  place(hang.g, OCT1, '[{"teamId":1,"heures":14.5}]');
  const h = await runDates({ ...snap, writer: hang.writer, fetchRow: hang.fetchRow, timeoutMs: 20 });
  assert.equal(h.kind, 'unknown');
  assert.equal(h.stored.dateDebut, OCT1.start);
  assert.deepEqual(h.changes, { dateDebut: OCT2.start, dateEcheance: OCT2.end });
  // Ligne disparue pendant l'envoi ; autre échec
  const gone = datesSetup({ grist: { fail: 'Invalid row id 1002' } });
  place(gone.g, OCT1, null);
  assert.equal((await runDates({ ...snap, writer: gone.writer, fetchRow: gone.fetchRow })).kind, 'missing');
  const other = datesSetup({ grist: { fail: 'Boom' } });
  place(other.g, OCT1, null);
  assert.equal((await runDates({ ...snap, writer: other.writer, fetchRow: other.fetchRow })).kind, 'failed');
});

test('runDates : mode essai → données chargées, entry.sent false', async () => {
  const { g, writer } = datesSetup({ mode: 'dry-run' });
  const localBase = {
    id: 1002,
    dateDebut: OCT1.start,
    dateEcheance: OCT1.end,
    charges: '[{"teamId":1,"heures":14.5}]',
  };
  const snap = { writer, table: 'Tasks', id: 1002, cols: TASK_COLS, seen: OCT1, localBase, maxOf };
  const r = await runDates({
    ...snap,
    next: { start: OCT1.start, end: OCT2.end },
    fetchRow: async () => assert.fail(),
  });
  assert.equal(r.kind, 'saved');
  assert.equal(r.entry.sent, false);
  assert.equal(r.entry.after.charges, '[{"teamId":1,"heures":29}]');
  assert.equal(g.batches.length, 0);
  assert.equal(
    (await runDates({ ...snap, localBase: null, next: OCT2, fetchRow: async () => assert.fail() })).kind,
    'missing',
  );
});

test('runDates : chantier → Debut et Fin seulement, jamais charges', async () => {
  const { g, gw, writer } = datesSetup();
  g.otherUserSets('Chantiers', 200, { Debut: D * OCT1.start, Fin: D * OCT1.end });
  const r = await runDates({
    writer,
    table: 'Chantiers',
    id: 200,
    cols: ['Debut', 'Fin'],
    seen: OCT1,
    next: { start: OCT1.start, end: OCT2.end },
    fetchRow: (id) => gw.fetchRow('Chantiers', id),
    maxOf,
  });
  assert.equal(r.kind, 'saved');
  assert.deepEqual(g.batches[0][0], ['UpdateRecord', 'Chantiers', 200, { Fin: D * OCT2.end }]);
  assert.deepEqual(r.keptOver, []);
});
