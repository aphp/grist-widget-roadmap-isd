/** Tags (lot 2e) : encodage, contrôle strict du writer, fusion, choix proposés, filtre, Tableau, enregistrement. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TAGS_MAX_COUNT,
  TAG_MAX,
  cleanTag,
  declaredTags,
  mergeTags,
  mergeTagsChange,
  newTagProblem,
  readTagsCell,
  searchTags,
  tagOptions,
  tagsWriteProblem,
} from '../widget/js/core/tags-edit.js';
import {
  EXPECTED_TYPES,
  WRITABLE,
  WriteRefused,
  assertActions,
  buildAdd,
  buildUpdate,
  createWriter,
  decodeRow,
} from '../widget/js/core/grist-writer.js';
import { decodeValue, encodeValue } from '../widget/js/core/write-encode.js';
import { buildModel } from '../widget/js/core/model.js';
import {
  DEFAULT_FILTERS,
  DEFAULT_PREFS,
  applyFilters,
  filterChoices,
  validFilters,
} from '../widget/js/core/filters.js';
import { tableRows, toCsv } from '../widget/js/core/table-data.js';
import { diffDraft, draftFrom, rebaseDraft } from '../widget/js/core/task-form.js';
import { chantierDraftFrom, diffChantier, rebaseChantier } from '../widget/js/core/chantier-form.js';
import { conflictBatch, failureKind, runSave } from '../widget/js/core/task-session.js';
import { createGateway } from '../widget/js/core/grist-gateway.js';
import { createFakeGrist, lookupOf } from './fixtures/fake-grist.js';
import { feuille } from './fixtures/feuille.js';

const META = Object.fromEntries(Object.entries(EXPECTED_TYPES).map(([k, type]) => [k, { type, isFormula: false }]));
const refused = (fn, reason) =>
  assert.throws(fn, (e) => e instanceof WriteRefused && e.reason === 'tags' && e.message.endsWith(reason));

/** Mini Feuille avec des tags : tâches (aucun choix déclaré) et chantiers (un choix déclaré). */
function tagged() {
  const raw = feuille();
  const t = raw.tables;
  t.Tasks.tags = t.Tasks.id.map((id) =>
    id === 1000 ? ['L', 'atelier'] : id === 1001 ? ['L', 'qualité', 'atelier'] : null,
  );
  t.Chantiers.tags = t.Chantiers.id.map((id) =>
    id === 100 ? ['L', 'Intégration de données'] : id === 200 ? ['L', 'Projet pilote'] : null,
  );
  raw.choices = { ...raw.choices, 'Chantiers.tags': ['Intégration de données', 'Déclaré inutilisé'] };
  return raw;
}

test('encodage : liste de tags en ChoiceList [L, …], liste vide = null, aller-retour', () => {
  assert.equal(EXPECTED_TYPES['Tasks.tags'], 'ChoiceList');
  assert.equal(EXPECTED_TYPES['Chantiers.tags'], 'ChoiceList');
  assert.deepEqual(encodeValue('ChoiceList', ['a', 'b c']), ['L', 'a', 'b c']);
  assert.equal(encodeValue('ChoiceList', []), null);
  assert.deepEqual(decodeValue('ChoiceList', ['L', 'a', 'b c']), ['a', 'b c']);
  assert.deepEqual(decodeValue('ChoiceList', null), []);
  assert.deepEqual(decodeValue('ChoiceList', ['L']), []);
  for (const v of [['x'], ['  bords  ', 'x'], []])
    assert.deepEqual(decodeValue('ChoiceList', encodeValue('ChoiceList', v)), v);
});

test('nouveau tag : nettoyé (espaces), non vide, sans caractère de contrôle, borné', () => {
  assert.equal(cleanTag('  Projet   pilote \n'), 'Projet pilote');
  assert.equal(newTagProblem('ok'), null);
  assert.equal(newTagProblem(''), 'vide');
  assert.equal(newTagProblem('   '), 'vide');
  assert.equal(newTagProblem(' a'), 'espaces');
  assert.equal(newTagProblem('a\tb'), 'controle');
  assert.equal(newTagProblem('a\u2028b'), 'controle');
  assert.equal(newTagProblem('é'.repeat(TAG_MAX)), null);
  assert.equal(newTagProblem('é'.repeat(TAG_MAX + 1)), 'long');
  assert.equal(newTagProblem(3), 'vide');
});

test('contrôle strict : chaînes seulement, nouveaux tags valides, aucun doublon ajouté, nombre borné', () => {
  assert.equal(tagsWriteProblem(['a', 'b'], []), null);
  assert.equal(tagsWriteProblem([], ['a']), null);
  assert.equal(tagsWriteProblem('a', []), 'format');
  assert.equal(tagsWriteProblem(['a', 2], []), 'format');
  assert.equal(tagsWriteProblem(['a', null], []), 'format');
  assert.equal(tagsWriteProblem(['a', 'a'], []), 'doublon');
  assert.equal(tagsWriteProblem(['a', ' b'], []), 'espaces');
  assert.equal(tagsWriteProblem(['x'.repeat(TAG_MAX + 1)], []), 'long');
  assert.equal(tagsWriteProblem(['a\nb'], []), 'controle');
  // Valeurs d'avant gardées telles quelles : espaces de bord, doublon, longueur hors bornes acceptés
  const odd = [' bord ', 'd', 'd', 'x'.repeat(TAG_MAX + 5)];
  assert.equal(tagsWriteProblem([...odd, 'nouveau'], odd), null);
  assert.equal(tagsWriteProblem([...odd, 'd'], odd), 'doublon');
  // Nombre maximal : refusé au-delà, sauf pour une cellule qui en avait déjà autant (retrait possible)
  const many = Array.from({ length: TAGS_MAX_COUNT }, (_, i) => `t${i}`);
  assert.equal(tagsWriteProblem(many, []), null);
  assert.equal(tagsWriteProblem([...many, 'un de trop'], []), 'trop');
  const longer = [...many, 'x', 'y'];
  assert.equal(tagsWriteProblem(longer.slice(1), longer), null);
});

test('writer : tags dans la liste blanche en mise à jour seulement, encodés en ChoiceList', () => {
  assert.ok(WRITABLE.Tasks.update.includes('tags'));
  assert.ok(WRITABLE.Chantiers.update.includes('tags'));
  assert.ok(!WRITABLE.Tasks.add.includes('tags') && !WRITABLE.Chantiers.add.includes('tags'));
  assert.deepEqual(buildUpdate('Tasks', 1, { tags: ['atelier', 'nouveau tag'] }, new Map(), { before: { tags: [] } }), [
    'UpdateRecord',
    'Tasks',
    1,
    { tags: ['L', 'atelier', 'nouveau tag'] },
  ]);
  assert.deepEqual(buildUpdate('Chantiers', 2, { tags: [] }, new Map(), { before: { tags: ['x'] } }), [
    'UpdateRecord',
    'Chantiers',
    2,
    { tags: null },
  ]);
  // Une valeur d'avant non retouchée part octet par octet
  assert.deepEqual(buildUpdate('Tasks', 1, { tags: ['  a ', 'b'] }, new Map(), { before: { tags: ['  a '] } })[3], {
    tags: ['L', '  a ', 'b'],
  });
  assert.throws(() => buildAdd('Tasks', { titre: 'a', Chantier: 1, projet: 1, tags: ['x'] }), WriteRefused);
  assert.throws(() => assertActions([['AddRecord', 'Chantiers', null, { Nom_du_chantier: 'a', tags: ['L', 'x'] }]]));
  assert.doesNotThrow(() => assertActions([['UpdateRecord', 'Chantiers', 1, { tags: ['L', 'x'] }]]));
});

test('writer : refus des tags invalides avant tout envoi', () => {
  const ctx = { before: { tags: ['a'] } };
  refused(() => buildUpdate('Tasks', 1, { tags: 'a' }, new Map(), ctx), 'format');
  refused(() => buildUpdate('Tasks', 1, { tags: ['a', 3] }, new Map(), ctx), 'format');
  refused(() => buildUpdate('Tasks', 1, { tags: ['a', 'a'] }, new Map(), ctx), 'doublon');
  refused(() => buildUpdate('Chantiers', 1, { tags: ['a', 'b '] }, new Map(), ctx), 'espaces');
  refused(() => buildUpdate('Chantiers', 1, { tags: ['x'.repeat(TAG_MAX + 1)] }, new Map(), ctx), 'long');
  refused(() => buildUpdate('Tasks', 1, { tags: [''] }, new Map(), {}), 'vide');
  // Colonne absente ou de type inattendu dans la Feuille : retirée pour la session
  assert.throws(
    () => buildUpdate('Tasks', 1, { tags: ['x'] }, new Map([['Tasks.tags', 'type']])),
    (e) => e.reason === 'colonne-retiree',
  );
});

test('writer : mode essai, rien n’est envoyé ; envoi réel, un seul UpdateRecord', async () => {
  const sent = [];
  const docApi = { applyUserActions: async (a) => sent.push(a) };
  const dry = createWriter({ docApi, mode: 'dry-run', columns: META });
  const e = await dry.update('Tasks', 7, { tags: ['atelier'] }, { before: { tags: [] } });
  assert.equal(e.sent, false);
  assert.deepEqual(e.actions, [['UpdateRecord', 'Tasks', 7, { tags: ['L', 'atelier'] }]]);
  assert.deepEqual(sent, []);
  const on = createWriter({ docApi, mode: 'on', columns: META });
  await on.update('Tasks', 3, { tags: [] }, { before: { tags: ['x'] } });
  assert.deepEqual(sent, [[['UpdateRecord', 'Tasks', 3, { tags: null }]]]);
  await assert.rejects(on.update('Tasks', 7, { tags: ['a', 'a'] }, { before: { tags: [] } }), WriteRefused);
  assert.equal(sent.length, 1);
  // « Annuler » remet la cellule d'avant telle quelle, même hors des règles d'un nouveau tag
  const odd = createWriter({ docApi, mode: 'dry-run', columns: META });
  await odd.update('Tasks', 8, { tags: ['b'] }, { before: { tags: [' a ', ' a '] } });
  const u = await odd.undoLast();
  assert.deepEqual(u.undoEntry.actions[0][3], { tags: ['L', ' a ', ' a '] });
});

test('fusion en ensemble : ajouts et retraits des deux côtés conservés, ordre de la cellule relue', () => {
  assert.deepEqual(mergeTags(['a', 'b'], ['a', 'c'], ['b', 'a', 'd']), ['a', 'd', 'c']);
  assert.deepEqual(mergeTags([], ['x'], ['x']), ['x']);
  assert.deepEqual(mergeTags(['a'], [], []), []);
  assert.deepEqual(mergeTags(undefined, ['x'], undefined), ['x']);
  // Valeur relue inconnue (ajoutée ailleurs, même bizarre) : recopiée telle quelle
  assert.deepEqual(mergeTags(['a'], ['a', 'b'], ['a', ' z ']), ['a', ' z ', 'b']);
  const base = { tags: ['a'] };
  assert.deepEqual(mergeTagsChange(base, { tags: ['a'] }, { tags: ['a', 'b'] }), { tags: ['a', 'b'] });
  assert.deepEqual(mergeTagsChange(base, { tags: ['a', 'c'] }, { tags: ['a', 'b'], titre: 'x' }), {
    tags: ['a', 'c', 'b'],
    titre: 'x',
  });
  // Fusion qui redonne la cellule relue : rien à écrire pour les tags
  assert.deepEqual(mergeTagsChange(base, { tags: ['b'] }, { tags: [] }), {});
  assert.deepEqual(mergeTagsChange(base, { tags: ['a'] }, { titre: 'x' }), { titre: 'x' });
});

test('brouillon : tags dans les fiches tâche et chantier, différence et nouvelle base fusionnée', () => {
  const tb = { titre: 'T', assignees: [], dependDe: [], tags: ['a'] };
  const d = draftFrom(tb);
  d.tags.push('b');
  assert.deepEqual(tb.tags, ['a'], 'copie');
  assert.deepEqual(diffDraft(tb, d), { tags: ['a', 'b'] });
  assert.deepEqual(rebaseDraft(tb, d, { ...tb, tags: ['z', 'a'] }).tags, ['z', 'a', 'b']);
  assert.deepEqual(rebaseDraft(tb, draftFrom(tb), { ...tb, tags: ['z'] }).tags, ['z']);
  const cb = { Nom_du_chantier: 'C', Projets: [1], Contributeurs: [], tags: ['x', 'y'] };
  const c = { ...chantierDraftFrom(cb), tags: ['y'] };
  assert.deepEqual(diffChantier(cb, c), { tags: ['y'] });
  assert.deepEqual(rebaseChantier(cb, c, { ...cb, tags: ['x', 'y', 'w'] }).tags, ['y', 'w']);
  assert.deepEqual(rebaseChantier(cb, chantierDraftFrom(cb), { ...cb, tags: [] }).tags, []);
});

test('tags proposés : choix déclarés et valeurs utilisées, comptées, par ordre alphabétique', () => {
  const m = buildModel(tagged());
  assert.deepEqual(m.chantiers.get(100).tags, ['Intégration de données']);
  assert.deepEqual(m.tasks.get(1001).tags, ['qualité', 'atelier']);
  assert.deepEqual(declaredTags(m, 'Tasks'), []);
  assert.deepEqual(declaredTags(m, 'Chantiers'), ['Intégration de données', 'Déclaré inutilisé']);
  assert.deepEqual(tagOptions(m, 'Tasks'), [
    { value: 'atelier', declared: false, count: 2 },
    { value: 'qualité', declared: false, count: 1 },
  ]);
  assert.deepEqual(tagOptions(m, 'Chantiers'), [
    { value: 'Déclaré inutilisé', declared: true, count: 0 },
    { value: 'Intégration de données', declared: true, count: 1 },
    { value: 'Projet pilote', declared: false, count: 1 },
  ]);
});

test('recherche : sans accents ni casse, choisis exclus, nom nouveau proposé seulement s’il est valide', () => {
  const opts = [
    { value: 'atelier', declared: false, count: 2 },
    { value: 'Qualité', declared: true, count: 1 },
    { value: 'Data qualité', declared: false, count: 1 },
  ];
  assert.deepEqual(
    searchTags(opts, '', []).items.map((x) => x.value),
    ['atelier', 'Qualité', 'Data qualité'],
  );
  // Ceux qui commencent par la saisie d'abord, puis l'option « nouveau tag »
  const r = searchTags(opts, 'QUALI', ['atelier']);
  assert.deepEqual(
    r.items.map((x) => [x.value, Boolean(x.create)]),
    [
      ['Qualité', false],
      ['Data qualité', false],
      ['QUALI', true],
    ],
  );
  // Nom existant (accents, casse) : pas de doublon approché proposé
  assert.ok(!searchTags(opts, ' qualite ', []).items.some((x) => x.create));
  assert.equal(searchTags(opts, 'atelier', ['atelier']).duplicate, true);
  assert.equal(searchTags(opts, 'atelier', ['atelier']).items.length, 0);
  assert.equal(searchTags(opts, 'x'.repeat(TAG_MAX + 1), []).invalid, 'long');
  const nouveau = searchTags(opts, '  Projet   pilote ', []).items.at(-1);
  assert.deepEqual(nouveau, { value: 'Projet pilote', declared: false, count: 0, create: true });
  const full = Array.from({ length: TAGS_MAX_COUNT }, (_, i) => `t${i}`);
  assert.ok(!searchTags(opts, 'neuf', full).items.some((x) => x.create));
});

test('filtre Tag : la tâche, sa tâche parente ou son chantier porte le tag ; choix et validité', () => {
  const m = buildModel(tagged());
  const run = (tag) =>
    [...applyFilters(m, { ...DEFAULT_FILTERS, tag, includeOutOfScope: true }, DEFAULT_PREFS).taskIds].sort();
  // 1000 porte « atelier » ; ses sous-tâches 1001 (qui le porte aussi) et 1002 suivent leur parente
  assert.ok(run('atelier').includes(1000) && run('atelier').includes(1001) && run('atelier').includes(1002));
  assert.ok(run('qualité').includes(1001) && !run('qualité').includes(1000));
  // Tag de chantier : toutes les tâches du chantier
  const ch100 = [...m.tasks.values()].filter((t) => t.chantierId === 100).map((t) => t.id);
  assert.deepEqual(run('Intégration de données'), [...new Set(ch100)].sort());
  assert.deepEqual(run('inconnu'), []);
  const choices = filterChoices(m, DEFAULT_FILTERS, DEFAULT_PREFS);
  assert.deepEqual(choices.tags, ['atelier', 'Intégration de données', 'Projet pilote', 'qualité']);
  assert.equal(validFilters(m, { ...DEFAULT_FILTERS, tag: 'atelier' }).tag, 'atelier');
  assert.equal(validFilters(m, { ...DEFAULT_FILTERS, tag: 'disparu' }).tag, '');
});

test('Tableau : colonne Tags en texte (tri, CSV) et pastilles marquées non déclarées', () => {
  const raw = tagged();
  raw.choices['Tasks.tags'] = ['qualité'];
  const m = buildModel(raw);
  const view = applyFilters(m, { ...DEFAULT_FILTERS, includeOutOfScope: true }, DEFAULT_PREFS);
  const row = tableRows(m, view).find((r) => r.taskId === 1001);
  assert.equal(row.tags, 'qualité, atelier');
  assert.deepEqual(row.tagItems, [
    { value: 'qualité', declared: true },
    { value: 'atelier', declared: false },
  ]);
  assert.match(toCsv([row], ['tache', 'tags']), /;qualité, atelier\r\n/);
});

test('enregistrement : tags modifiés aussi dans la Feuille, fusionnés sans conflit, valeurs relues gardées', async () => {
  const tables = tagged().tables;
  for (const c of WRITABLE.Tasks.update) tables.Tasks[c] ??= tables.Tasks.id.map(() => null);
  const g = createFakeGrist(tables);
  const gw = createGateway(g);
  const writer = createWriter({ docApi: g.docApi, mode: 'on', columns: META, lookup: lookupOf(g) });
  const fetchRow = (id) => gw.fetchRow('Tasks', id);
  const base = await fetchRow(1001);
  assert.deepEqual(base.tags, ['qualité', 'atelier']);
  const draft = { ...draftFrom(base), tags: ['qualité', 'nouveau'] };
  g.otherUserSets('Tasks', 1001, { tags: ['L', 'qualité', 'atelier', 'ajout ailleurs'] });
  const r = await runSave({ taskId: 1001, base, draft, writer, fetchRow });
  assert.equal(r.kind, 'saved');
  assert.deepEqual(g.batches, [
    [['UpdateRecord', 'Tasks', 1001, { tags: ['L', 'qualité', 'ajout ailleurs', 'nouveau'] }]],
  ]);
  assert.deepEqual((await fetchRow(1001)).tags, ['qualité', 'ajout ailleurs', 'nouveau']);
  // Fusion qui redonne la cellule relue : rien n'est envoyé
  const b2 = await fetchRow(1000);
  g.otherUserSets('Tasks', 1000, { tags: ['L', 'atelier', 'x'] });
  const r2 = await runSave({
    taskId: 1000,
    base: b2,
    draft: { ...draftFrom(b2), tags: ['atelier', 'x'] },
    writer,
    fetchRow,
  });
  assert.equal(r2.kind, 'nothing');
  assert.equal(g.batches.length, 1);
  // Lot arbitré après une fenêtre de conflit (autre champ) : les tags sont refusionnés sur la ligne relue
  const batch = conflictBatch(
    { titre: 'T', tags: ['a'] },
    { ...draftFrom({ titre: 'Mien', assignees: [], dependDe: [], tags: ['a', 'b'] }) },
    { titre: 'Leur', tags: ['a', 'c'] },
    { titre: 'mine' },
  );
  assert.deepEqual(batch.changes.tags, ['a', 'c', 'b']);
  assert.deepEqual(batch.before.tags, ['a', 'c']);
  const same = conflictBatch(
    { tags: ['a'] },
    { ...draftFrom({ assignees: [], dependDe: [], tags: ['a', 'b'] }) },
    { tags: ['a', 'b'] },
    {},
  );
  assert.ok(!('tags' in same.changes));
});

test('relecture d’une ligne : tags décodés pour les deux tables (decodeRow)', () => {
  const t = tagged().tables;
  assert.deepEqual(decodeRow(t.Chantiers, 'Chantiers', 200).tags, ['Projet pilote']);
  assert.deepEqual(decodeRow(t.Chantiers, 'Chantiers', 300).tags, []);
  assert.deepEqual(decodeRow(t.Tasks, 'Tasks', 1000).tags, ['atelier']);
});

/** Faux Grist + writer en envoi réel, sur la mini Feuille avec tags (tâche 1001 : base donnée). */
function realSetup(tags1001) {
  const tables = tagged().tables;
  for (const c of WRITABLE.Tasks.update) tables.Tasks[c] ??= tables.Tasks.id.map(() => null);
  if (tags1001 !== undefined) tables.Tasks.tags[tables.Tasks.id.indexOf(1001)] = tags1001;
  const g = createFakeGrist(tables);
  const gw = createGateway(g);
  const writer = createWriter({ docApi: g.docApi, mode: 'on', columns: META, lookup: lookupOf(g) });
  return { g, writer, fetchRow: (id) => gw.fetchRow('Tasks', id) };
}

test('après la fenêtre de conflit : ligne relue à l’envoi, un tag ajouté ailleurs pendant la fenêtre survit', async () => {
  const { g, writer, fetchRow } = realSetup(['L', 'a']);
  const base = await fetchRow(1001);
  const draft = { ...draftFrom(base), titre: 'Mien', tags: ['a', 'mine'] };
  g.otherUserSets('Tasks', 1001, { titre: 'Leur' });
  const r1 = await runSave({ taskId: 1001, base, draft, writer, fetchRow });
  assert.equal(r1.kind, 'conflict');
  assert.deepEqual(r1.cols, ['titre']);
  // Fenêtre ouverte : quelqu'un ajoute « other » et retire « a » ; l'utilisateur garde son titre
  g.otherUserSets('Tasks', 1001, { tags: ['L', 'other'] });
  const batch = conflictBatch(base, draft, r1.fresh, { titre: 'mine' });
  assert.deepEqual(batch.tagsSeen, ['a']);
  const r2 = await runSave({ taskId: 1001, base, draft, writer, fetchRow, ...batch });
  assert.equal(r2.kind, 'saved');
  assert.deepEqual(g.batches.at(-1), [
    ['UpdateRecord', 'Tasks', 1001, { titre: 'Mien', tags: ['L', 'other', 'mine'] }],
  ]);
  assert.deepEqual(r2.entry.before.tags, ['other']);
  // Fusion qui redonne la cellule relue : seuls les autres champs partent
  const b3 = await fetchRow(1001);
  const d3 = { ...draftFrom(b3), titre: 'Encore', tags: [...b3.tags, 'z'] };
  g.otherUserSets('Tasks', 1001, { titre: 'Autre' });
  const r3 = await runSave({ taskId: 1001, base: b3, draft: d3, writer, fetchRow });
  g.otherUserSets('Tasks', 1001, { tags: ['L', ...b3.tags, 'z'] });
  const r4 = await runSave({
    taskId: 1001,
    base: b3,
    draft: d3,
    writer,
    fetchRow,
    ...conflictBatch(b3, d3, r3.fresh, {}),
  });
  assert.equal(r4.kind, 'saved');
  assert.deepEqual(g.batches.at(-1), [['UpdateRecord', 'Tasks', 1001, { titre: 'Encore' }]]);
});

test('fusion au-delà de 30 tags (ajouts faits ailleurs) : refusée avec une raison claire, rien n’est envoyé', async () => {
  const many = Array.from({ length: TAGS_MAX_COUNT - 1 }, (_, i) => `t${i}`);
  const { g, writer, fetchRow } = realSetup(['L', ...many]);
  const base = await fetchRow(1001);
  g.otherUserSets('Tasks', 1001, { tags: ['L', ...many, 'ailleurs'] });
  const r = await runSave({
    taskId: 1001,
    base,
    draft: { ...draftFrom(base), tags: [...many, 'mien'] },
    writer,
    fetchRow,
  });
  assert.equal(r.kind, 'failed');
  assert.equal(r.error.reason, 'tags-trop');
  assert.equal(failureKind(r.error), 'refused:tags-trop');
  assert.equal(g.batches.length, 0);
  assert.equal(mergeTags(many, [...many, 'mien'], [...many, 'ailleurs']).length, TAGS_MAX_COUNT + 1);
});

test('cellule de tags illisible (texte, erreur, non-texte) : signalée, jamais réécrite sans confirmation', async () => {
  for (const cell of ['texte libre', ['E', 'TypeError'], ['L', 'a', 3]]) {
    const c = readTagsCell(cell);
    assert.equal(c.ok, false);
    assert.equal(c.raw, typeof cell === 'string' ? cell : JSON.stringify(cell));
  }
  for (const cell of [null, undefined, '', ['L'], ['L', '', 'a']]) assert.equal(readTagsCell(cell).ok, true);
  const { g, writer, fetchRow } = realSetup('texte libre');
  const base = await fetchRow(1001);
  assert.deepEqual(base.tags, []);
  assert.equal(base.tagsUnreadable, 'texte libre');
  const draft = { ...draftFrom(base), tags: ['nouveau'] };
  const r = await runSave({ taskId: 1001, base, draft, writer, fetchRow });
  assert.equal(r.kind, 'failed');
  assert.equal(r.error.reason, 'tags-illisible');
  assert.equal(g.batches.length, 0);
  // Confirmation d'un autre contenu : toujours refusé ; confirmation de ce contenu : remplacé
  const r2 = await runSave({ taskId: 1001, base, draft, writer, fetchRow, tagsReplace: 'autre chose' });
  assert.equal(r2.error.reason, 'tags-illisible');
  const r3 = await runSave({ taskId: 1001, base, draft, writer, fetchRow, tagsReplace: 'texte libre' });
  assert.equal(r3.kind, 'saved');
  assert.deepEqual(g.batches, [[['UpdateRecord', 'Tasks', 1001, { tags: ['L', 'nouveau'] }]]]);
  // Autres colonnes de la ligne : modifiables sans toucher à la cellule illisible
  assert.throws(
    () => buildUpdate('Tasks', 1, { tags: ['x'] }, new Map(), { before: { tags: [], tagsUnreadable: '"x"' } }),
    (e) => e.reason === 'tags-illisible',
  );
  assert.doesNotThrow(() => buildUpdate('Tasks', 1, { titre: 'x' }, new Map(), { before: { titre: 'y' } }));
  // Modèle (vues en lecture) : contenu brut gardé pour l'affichage
  const raw = tagged();
  raw.tables.Tasks.tags[0] = ['E', 'Err'];
  assert.equal(buildModel(raw).tasks.get(raw.tables.Tasks.id[0]).tagsUnreadable, '["E","Err"]');
});

test('tag vide déjà dans la cellule : gardé tel quel, sans bloquer les autres modifications', async () => {
  assert.equal(tagsWriteProblem(['', 'a', 'b'], ['', 'a']), null);
  assert.equal(tagsWriteProblem(['a', ''], ['a']), 'vide');
  const { g, writer, fetchRow } = realSetup(['L', '', 'a']);
  const base = await fetchRow(1001);
  assert.deepEqual(base.tags, ['', 'a']);
  const r = await runSave({
    taskId: 1001,
    base,
    draft: { ...draftFrom(base), tags: ['', 'a', 'b'] },
    writer,
    fetchRow,
  });
  assert.equal(r.kind, 'saved');
  assert.deepEqual(g.batches[0][0][3], { tags: ['L', '', 'a', 'b'] });
  const undo = await writer.undoLast(async (t, id) => fetchRow(id));
  assert.deepEqual(undo.undoEntry.actions[0][3], { tags: ['L', '', 'a'] });
});

test('doublons : retirer un exemplaire d’un tag en double survit à la fusion (multi-ensemble)', () => {
  assert.deepEqual(mergeTags(['d', 'd'], ['d'], ['d', 'd', 'x']), ['d', 'x']);
  assert.deepEqual(mergeTags(['d', 'd'], ['d', 'd'], ['d']), ['d']);
  assert.deepEqual(mergeTags(['d'], ['d', 'n'], ['d', 'n']), ['d', 'n']); // même ajout des deux côtés : une fois
  assert.deepEqual(mergeTags(['a', 'b'], ['b'], ['b']), ['b']); // même retrait des deux côtés
  assert.deepEqual(mergeTags(['d', 'd', 'd'], ['d'], ['d', 'd']), ['d']); // le plus grand retrait l'emporte
});

test('« Annuler » ne réécrit jamais une cellule de tags devenue illisible ; le writer relit lui-même la ligne', async () => {
  const { g, writer, fetchRow } = realSetup(['L', 'a']);
  const base = await fetchRow(1001);
  assert.equal(base.tagsUnreadable, null);
  const r = await runSave({ taskId: 1001, base, draft: { ...draftFrom(base), tags: [] }, writer, fetchRow });
  assert.equal(r.kind, 'saved');
  assert.deepEqual(g.batches.at(-1), [['UpdateRecord', 'Tasks', 1001, { tags: null }]]);
  // Quelqu'un importe un texte dans la cellule ; l'utilisateur annule : tags sautés et signalés, rien n'est envoyé
  g.otherUserSets('Tasks', 1001, { tags: 'texte libre importé' });
  const u = await writer.undoLast((t, id) => fetchRow(id));
  assert.deepEqual(u.skipped, ['tags']);
  assert.equal(u.undoEntry, null);
  assert.equal(g.batches.length, 1);
  assert.equal((await fetchRow(1001)).tagsUnreadable, 'texte libre importé');
  // Contrôle du writer sur la ligne qu'il lit, même pour une remise à la valeur d'avant, sans aide de l'appelant
  await assert.rejects(writer.update('Tasks', 1001, { tags: ['a'] }), (e) => e.reason === 'tags-illisible');
  assert.throws(
    () =>
      buildUpdate('Tasks', 1, { tags: ['a'] }, new Map(), {
        current: { tagsUnreadable: '"x"' },
        restoring: ['tags'],
        before: { tags: ['a'] },
      }),
    (e) => e.reason === 'tags-illisible',
  );
  assert.equal(g.batches.length, 1);
  // Mode essai : la ligne des données chargées est contrôlée de la même façon
  const dry = createWriter({ docApi: g.docApi, mode: 'dry-run', columns: META, lookup: lookupOf(g) });
  await assert.rejects(dry.update('Tasks', 1001, { tags: ['b'] }), (e) => e.reason === 'tags-illisible');
});

test('relecture : tagsUnreadable toujours présent (null si lisible), aucun ancien signalement ne survit', () => {
  const t = tagged().tables;
  assert.equal(decodeRow(t.Tasks, 'Tasks', 1000).tagsUnreadable, null);
  t.Tasks.tags[t.Tasks.id.indexOf(1000)] = ['E', 'Err'];
  const bad = decodeRow(t.Tasks, 'Tasks', 1000);
  assert.equal(bad.tagsUnreadable, '["E","Err"]');
  t.Tasks.tags[t.Tasks.id.indexOf(1000)] = ['L', 'ok'];
  const merged = { ...bad, ...decodeRow(t.Tasks, 'Tasks', 1000) };
  assert.equal(merged.tagsUnreadable, null);
  assert.deepEqual(merged.tags, ['ok']);
});
