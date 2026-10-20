/**
 * Team.aph convertie par Grist en colonne de données Int (saisie de chiffres dans la colonne vide de la Feuille) :
 * lecture en texte (aphText), écriture selon le type relu de la colonne (nombre pour Int, texte pour Text), Numeric
 * et autres types refusés, personne estimation reconnue pour le nombre 9999999 et toujours protégée.
 * Faux Grist Node, jamais de vrai Grist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feuille } from './fixtures/feuille.js';
import { createFakeGrist, lookupOf } from './fixtures/fake-grist.js';
import {
  ESTIMATION_APH,
  aphText,
  estimationHoldersOfTable,
  estimationIdOfTable,
  isEstimationAph,
} from '../widget/js/core/estimation.js';
import {
  ALSO_ACCEPTED_TYPES,
  EXPECTED_TYPES,
  READ_ALSO,
  WRITABLE,
  WriteRefused,
  buildAdd,
  buildUpdate,
  checkColumns,
  columnTypeOf,
  createWriter,
  decodeRow,
  encodeAph,
  planUndo,
} from '../widget/js/core/grist-writer.js';
import { buildModel } from '../widget/js/core/model.js';
import { personInScope, teamValuesInScope, validatePerson, newPersonDraft } from '../widget/js/core/person-form.js';
import { EncodeError } from '../widget/js/core/write-encode.js';

const ISD = 'Ingénierie et sciences des données - ISD';
const META = Object.fromEntries(Object.entries(EXPECTED_TYPES).map(([k, type]) => [k, { type, isFormula: false }]));
const META_INT = { ...META, 'Team.aph': { type: 'Int', isFormula: false } };
const CHOICES = {
  'Team.role': ['Management', 'DS', 'DE', 'DA', 'PO Data'],
  'Team.Domaine': ['Direction I&D', ISD, 'BNDMR'],
};

/** Feuille de test, Team.aph en Int : Alice (1) porte 9999999, Eve DA (5) 1234567, les autres 0 (vide). */
function raw() {
  const r = feuille();
  for (const [name, ops] of Object.entries(WRITABLE))
    for (const c of new Set([...ops.update, ...ops.add, ...(READ_ALSO[name] ?? [])]))
      r.tables[name][c] ??= r.tables[name].id.map(() => null);
  r.tables.Team.aph = r.tables.Team.id.map((id) => (id === 1 ? 9999999 : id === 5 ? 1234567 : 0));
  r.choices = { ...r.choices, ...CHOICES };
  return r;
}

function setup(columns = META_INT) {
  const r = raw();
  const g = createFakeGrist(r.tables);
  const model = () => buildModel({ ...r, tables: g.data });
  const writer = createWriter({
    docApi: g.docApi,
    mode: 'on',
    columns,
    lookup: { ...lookupOf(g), choices: (k) => CHOICES[k] ?? null },
    canWriteRow: (table, id) => table !== 'Team' || personInScope(model(), model().people.get(id)),
    canWriteValues: (table, v, o) => table !== 'Team' || teamValuesInScope(model(), v, o),
    readTable: async (t) => structuredClone(g.data[t]),
  });
  return { g, writer, model, readRow: async (t, id) => decodeRow(g.data[t], t, id) };
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

// ---------- Lecture ----------

test('aphText : texte tel quel, entier positif en chiffres, 0 / null / autre contenu vide', () => {
  assert.equal(aphText('1234567'), '1234567');
  assert.equal(aphText(' 1234567 '), ' 1234567 ');
  assert.equal(aphText(''), '');
  assert.equal(aphText(1234567), '1234567');
  assert.equal(aphText(9999999), ESTIMATION_APH);
  assert.equal(aphText(1234567890), '1234567890');
  for (const empty of [0, null, undefined, -5, 1.5, NaN, Infinity, true, ['L', 1], {}])
    assert.equal(aphText(empty), '', String(empty));
});

test('modèle et decodeRow : colonne Int lue en texte de chiffres (0 = vide), estimation reconnue', () => {
  const r = raw();
  const m = buildModel(r);
  assert.equal(m.people.get(1).aph, ESTIMATION_APH);
  assert.equal(m.people.get(5).aph, '1234567');
  assert.equal(m.people.get(2).aph, '');
  assert.deepEqual(m.estimation, { holders: [1], id: 1 });
  assert.equal(decodeRow(r.tables.Team, 'Team', 5).aph, '1234567');
  assert.equal(decodeRow(r.tables.Team, 'Team', 2).aph, '');
  assert.equal(decodeRow(r.tables.Team, 'Team', 1).aph, ESTIMATION_APH);
  // Table brute (lookup du writer) : nombre ou texte, même règle stricte
  assert.deepEqual(estimationHoldersOfTable(r.tables.Team), [1]);
  assert.equal(estimationIdOfTable(r.tables.Team), 1);
  assert.deepEqual(estimationHoldersOfTable({ id: [1, 2, 3], aph: [9999999, '9999999', ' 9999999'] }), [1, 2]);
  assert.equal(estimationIdOfTable({ id: [1, 2], aph: [9999999, '9999999'] }), null);
  assert.equal(isEstimationAph(9999999), true);
  assert.equal(isEstimationAph(99999990), false);
});

// ---------- Types acceptés ----------

test('colonnes : Team.aph acceptée en Text ou Int, refusée en Numeric et autres types, formule jamais écrite', () => {
  assert.deepEqual(ALSO_ACCEPTED_TYPES, { 'Team.aph': ['Int'] });
  assert.equal(EXPECTED_TYPES['Team.aph'], 'Text');
  assert.equal(checkColumns(META).has('Team.aph'), false);
  assert.equal(checkColumns(META_INT).has('Team.aph'), false);
  for (const type of ['Numeric', 'Choice', 'Any', 'Bool'])
    assert.equal(checkColumns({ ...META, 'Team.aph': { type, isFormula: false } }).get('Team.aph'), 'type', type);
  assert.equal(checkColumns({ ...META, 'Team.aph': { type: 'Int', isFormula: true } }).get('Team.aph'), 'formule');
  // Seule Team.aph a un type de plus : une autre colonne Text en Int reste refusée
  assert.equal(checkColumns({ ...META, 'Team.email': { type: 'Int', isFormula: false } }).get('Team.email'), 'type');
  assert.equal(columnTypeOf(META_INT, 'Team', 'aph'), 'Int');
  assert.equal(columnTypeOf(META, 'Team', 'aph'), 'Text');
  assert.equal(columnTypeOf(null, 'Team', 'aph'), 'Text');
  assert.equal(columnTypeOf({ ...META, 'Team.aph': { type: 'Numeric' } }, 'Team', 'aph'), 'Text');
  assert.equal(columnTypeOf({ ...META, 'Team.email': { type: 'Int' } }, 'Team', 'email'), 'Text');
  assert.equal(columnTypeOf(META, 'Team', 'inconnue'), null);
});

// ---------- Écriture ----------

test('encodeAph : nombre pour Int (vide → null), texte pour Text, jamais 9999999 ni zéro de tête en Int', () => {
  assert.equal(encodeAph('Int', '1234567'), 1234567);
  assert.equal(encodeAph('Int', '1234567890'), 1234567890);
  assert.equal(encodeAph('Int', ''), null);
  assert.equal(encodeAph('Int', null), null);
  assert.equal(encodeAph('Text', '0123456'), '0123456');
  assert.equal(encodeAph('Text', '1234567'), '1234567');
  assert.equal(encodeAph('Text', null), '');
  for (const type of ['Int', 'Text']) {
    assert.throws(
      () => encodeAph(type, ESTIMATION_APH),
      (e) => e.reason === 'aph-estimation',
      type,
    );
    assert.throws(
      () => encodeAph(type, 9999999),
      (e) => e.reason === 'aph-estimation',
      type,
    );
  }
  assert.throws(
    () => encodeAph('Int', '0123456'),
    (e) => e.reason === 'aph-zero',
  );
  assert.throws(
    () => encodeAph('Int', '0'),
    (e) => e.reason === 'aph-zero',
  );
  for (const bad of ['12a', ' 1234567', '12345678901'])
    assert.throws(
      () => encodeAph('Int', bad),
      (e) => e.reason === 'aph',
      bad,
    );
  assert.throws(() => encodeAph('Int', 1234567), EncodeError);
  assert.throws(() => encodeAph('Numeric', '1234567'), EncodeError);
});

test('buildUpdate et buildAdd : encodage selon le type relu de Team.aph', () => {
  assert.deepEqual(buildUpdate('Team', 5, { aph: '7654321' }, new Map(), { columns: META_INT }), [
    'UpdateRecord',
    'Team',
    5,
    { aph: 7654321 },
  ]);
  assert.deepEqual(buildUpdate('Team', 5, { aph: '' }, new Map(), { columns: META_INT })[3], { aph: null });
  assert.deepEqual(buildUpdate('Team', 5, { aph: '7654321' }, new Map(), { columns: META })[3], { aph: '7654321' });
  assert.deepEqual(buildUpdate('Team', 5, { aph: '7654321' })[3], { aph: '7654321' });
  const fields = { nom: 'N', role: 'DE', Domaine: ISD, actif: true, aph: '7000001' };
  assert.equal(buildAdd('Team', fields, new Map(), META_INT)[3].aph, 7000001);
  assert.equal(buildAdd('Team', fields, new Map(), META)[3].aph, '7000001');
  assert.throws(
    () => buildUpdate('Team', 5, { aph: 1234567 }, new Map(), { columns: META_INT }),
    (e) => e.reason === 'encodage',
  );
});

test('writer, colonne Int : APH écrit en nombre, vidé en null, relu et annulé en texte', async () => {
  const { g, writer, readRow } = setup();
  assert.deepEqual(writer.can('Team', 'aph'), { ok: true, reason: 'ok' });
  assert.equal(writer.canAddField('Team', 'aph'), true);
  assert.equal(writer.columnType('Team', 'aph'), 'Int');
  assert.equal(writer.columnType('Team', 'nom'), 'Text');
  for (const bad of ['12a', ' 1234567', '12345678901'])
    assert.equal(await reason(writer.update('Team', 5, { aph: bad })), 'aph', bad);
  assert.equal(await reason(writer.update('Team', 5, { aph: '0123456' })), 'aph-zero');
  assert.equal(g.batches.length, 0);
  const i = g.data.Team.id.indexOf(5);
  await writer.update('Team', 5, { aph: '7654321' }, { before: { aph: '1234567' } });
  assert.deepEqual(g.batches.at(-1), [['UpdateRecord', 'Team', 5, { aph: 7654321 }]]);
  assert.equal(g.data.Team.aph[i], 7654321);
  assert.equal((await readRow('Team', 5)).aph, '7654321');
  // « Annuler » : la valeur relue (nombre) est reconnue comme celle écrite, l'APH d'avant est rendu en nombre
  assert.deepEqual(planUndo({ before: { aph: '1234567' }, after: { aph: '7654321' } }, await readRow('Team', 5)), {
    changes: { aph: '1234567' },
    skipped: [],
  });
  await writer.undoLast(readRow);
  assert.equal(g.data.Team.aph[i], 1234567);
  await writer.update('Team', 5, { aph: '' });
  assert.deepEqual(g.batches.at(-1), [['UpdateRecord', 'Team', 5, { aph: null }]]);
  const fields = { nom: 'Nouvelle DE', role: 'DE', Domaine: ISD, actif: true };
  await writer.add('Team', { ...fields, aph: '7000009' });
  assert.deepEqual(g.batches.at(-1), [['AddRecord', 'Team', null, { ...fields, aph: 7000009 }]]);
});

test('writer, colonne Int : l’APH d’estimation ne se pose ni ne se retire (texte ou nombre)', async () => {
  const { g, writer } = setup();
  const fields = { nom: 'Nouvelle DE', role: 'DE', Domaine: ISD, actif: true };
  assert.equal(await reason(writer.update('Team', 5, { aph: ESTIMATION_APH })), 'aph-estimation');
  assert.equal(await reason(writer.update('Team', 5, { aph: 9999999 })), 'aph-estimation');
  assert.equal(await reason(writer.add('Team', { ...fields, aph: ESTIMATION_APH })), 'aph-estimation');
  assert.equal(await reason(writer.add('Team', { ...fields, aph: 9999999 })), 'aph-estimation');
  // Titulaire (cellule 9999999 en nombre) : ni retiré ni changé, même d'après la ligne relue (before)
  assert.equal(await reason(writer.update('Team', 1, { aph: '1234567' })), 'aph-estimation');
  assert.equal(await reason(writer.update('Team', 1, { aph: '' })), 'aph-estimation');
  assert.equal(
    await reason(writer.update('Team', 5, { aph: '1234568' }, { before: { aph: 9999999 } })),
    'aph-estimation',
  );
  assert.equal(g.batches.length, 0);
  // Exemption de la borne de 1 ETP pour le titulaire unique (nombre 9999999)
  const period = { start: 100, end: 113 };
  await writer.update('Tasks', 1002, { charges: '[{"teamId":1,"heures":210}]' }, { period });
  assert.equal(g.batches.length, 1);
});

test('writer : type de Team.aph relu en cours de session (Text → Int), écriture au nouveau type', async () => {
  const { g, writer } = setup(META);
  await writer.update('Team', 5, { aph: '7654321' });
  assert.deepEqual(g.batches.at(-1), [['UpdateRecord', 'Team', 5, { aph: '7654321' }]]);
  writer.recheckColumns(null);
  assert.equal(writer.columnType('Team', 'aph'), 'Text');
  writer.recheckColumns(META_INT);
  assert.equal(writer.columnType('Team', 'aph'), 'Int');
  await writer.update('Team', 5, { aph: '7654322' });
  assert.deepEqual(g.batches.at(-1), [['UpdateRecord', 'Team', 5, { aph: 7654322 }]]);
  // Devenue Numeric : retirée pour la session
  writer.recheckColumns({ ...META, 'Team.aph': { type: 'Numeric', isFormula: false } });
  assert.deepEqual(writer.can('Team', 'aph'), { ok: false, reason: 'type' });
  assert.equal(await reason(writer.update('Team', 5, { aph: '7654323' })), 'colonne-retiree');
});

test('formulaire : zéro de tête refusé seulement pour une colonne Int', () => {
  const m = buildModel(raw());
  const v = (aph, aphType) =>
    validatePerson({ ...newPersonDraft(), nom: 'Nouvelle', role: 'DE', aph }, { model: m, aphType });
  assert.deepEqual(v('0123456', 'Int').errors.aph, { key: 'person.error.aphZero' });
  assert.equal(v('0123456', 'Text').errors.aph, undefined);
  assert.equal(v('0123456', null).errors.aph, undefined);
  assert.equal(v('1234567', 'Int').errors.aph, undefined);
  assert.deepEqual(v('9999999', 'Int').errors.aph, { key: 'person.error.aphEstimation' });
  // Personne estimation lue en nombre : APH en lecture
  const draft = { nom: 'Alice DE', email: '', aph: '1234567', role: 'DE', capaciteHebdo: null, n_1: null };
  assert.deepEqual(validatePerson(draft, { model: m, personId: 1, aphType: 'Int' }).errors.aph, {
    key: 'person.error.aphEstimation',
  });
});
