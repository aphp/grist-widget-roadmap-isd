/**
 * APH (Team.aph) et personne estimation : validation stricte de l'APH (chiffres seulement), colonne formule (vide)
 * jamais écrite, écrite seulement quand c'est une colonne de données ; la personne qui porte ESTIMATION_APH est
 * seule exemptée de la borne de 1 ETP par personne (saisie et writer), avec une borne de bon sens de 50 ETP.
 * Faux Grist Node, jamais de vrai Grist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feuille } from './fixtures/feuille.js';
import { createFakeGrist, lookupOf } from './fixtures/fake-grist.js';
import {
  ESTIMATION_APH,
  ESTIMATION_MAX_ETP,
  MAX_HOURS,
  chargesWriteProblem,
  hoursFromInput,
  isEstimationAph,
  isEstimationPerson,
  maxHours,
} from '../widget/js/core/charges-edit.js';
import {
  lookupFromTables,
  EXPECTED_TYPES,
  READ_ALSO,
  WRITABLE,
  WriteRefused,
  buildAdd,
  buildUpdate,
  checkColumns,
  createWriter,
  decodeRow,
  validAph,
} from '../widget/js/core/grist-writer.js';
import { buildModel } from '../widget/js/core/model.js';
import {
  diffPerson,
  newPersonDraft,
  newPersonFields,
  personDraftFrom,
  personInScope,
  teamValuesInScope,
  validatePerson,
} from '../widget/js/core/person-form.js';
import { lineInput } from '../widget/js/core/task-people.js';
import { filterUsers } from '../widget/js/core/team-directory.js';
import { runSave } from '../widget/js/core/task-session.js';

const ISD = 'Ingénierie et sciences des données - ISD';
const META = Object.fromEntries(Object.entries(EXPECTED_TYPES).map(([k, type]) => [k, { type, isFormula: false }]));
/** Team.aph comme dans la Feuille : colonne formule sans formule (« vide »). */
const META_FORMULA = { ...META, 'Team.aph': { type: 'Text', isFormula: true, empty: true } };
const CHOICES = {
  'Team.role': ['Management', 'DS', 'DE', 'DA', 'PO Data'],
  'Team.Domaine': ['Direction I&D', ISD, 'BNDMR'],
};

/** Feuille de test : Alice (1) est la personne estimation, Eve DA (5) a un APH ordinaire. */
function raw() {
  const r = feuille();
  for (const [name, ops] of Object.entries(WRITABLE))
    for (const c of new Set([...ops.update, ...ops.add, ...(READ_ALSO[name] ?? [])]))
      r.tables[name][c] ??= r.tables[name].id.map(() => null);
  r.tables.Team.aph = r.tables.Team.id.map((id) => (id === 1 ? ESTIMATION_APH : id === 5 ? '1234567' : ''));
  r.choices = { ...r.choices, ...CHOICES };
  return r;
}

function setup({ columns = META } = {}) {
  const r = raw();
  const g = createFakeGrist(r.tables);
  const model = () => buildModel({ ...r, tables: g.data });
  const lookup = { ...lookupOf(g), choices: (k) => CHOICES[k] ?? null };
  const writer = createWriter({
    docApi: g.docApi,
    mode: 'on',
    columns,
    lookup,
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

// ---------- APH : validation ----------

test('APH : de 1 à 10 chiffres, sans espace, ni lettre, ni signe ; texte seulement', () => {
  for (const ok of ['1', '1234567', '9999999', '0012345', '1234567890']) assert.equal(validAph(ok), true, ok);
  for (const bad of ['', ' 1234567', '1234567 ', '12 34', '12345678901', 'AB12345', '-123', '1.5', '١٢٣'])
    assert.equal(validAph(bad), false, bad);
  assert.equal(validAph(1234567), false);
  assert.equal(validAph(null), false);
});

test('formulaire : APH nettoyé de ses espaces, invalide bloquant, longueur inhabituelle signalée', () => {
  const m = buildModel(raw());
  const draft = (aph) => ({ ...newPersonDraft(), nom: 'Nouvelle Personne', role: 'DE', aph });
  const check = (aph) => validatePerson(draft(aph), { model: m });
  assert.equal(check('').errors.aph, undefined);
  assert.equal(check('  1234567  ').errors.aph, undefined);
  assert.deepEqual(check(' 1234567 ').warnings, []);
  assert.deepEqual(check('12a4567').errors.aph, { key: 'person.error.aph', vars: { max: 10 } });
  assert.deepEqual(check('12345678901').errors.aph, { key: 'person.error.aph', vars: { max: 10 } });
  assert.deepEqual(check('12345').warnings, [{ field: 'aph', key: 'person.warn.aphLength', vars: { n: 7 } }]);
  // Brouillon et différences : espaces de bord retirés, valeur inchangée jamais réécrite
  const base = { nom: 'Alice DE', email: '', aph: '1234567', role: 'DE', capaciteHebdo: 0, n_1: null };
  const d = personDraftFrom(base);
  assert.equal(d.aph, '1234567');
  assert.deepEqual(diffPerson(base, { ...d, aph: ' 1234567 ' }), {});
  assert.deepEqual(diffPerson(base, { ...d, aph: ' 7654321 ' }), { aph: '7654321' });
  assert.deepEqual(diffPerson(base, { ...d, aph: '' }), { aph: '' });
  assert.equal(personDraftFrom({}).aph, '');
  // Création : APH seulement s'il est saisi et que la colonne peut être remplie
  assert.equal(newPersonFields(draft(' 1234567 '), { model: m }).aph, '1234567');
  assert.equal('aph' in newPersonFields(draft(''), { model: m }), false);
  assert.equal('aph' in newPersonFields(draft('1234567'), { model: m, canAddField: (c) => c !== 'aph' }), false);
});

test('modèle et annuaire : APH texte lu tel quel, entier lu en chiffres, vide si la colonne manque', () => {
  const r = raw();
  r.tables.Team.aph[1] = ' 7000001 ';
  r.tables.Team.aph[2] = 7000002;
  const m = buildModel(r);
  assert.equal(m.people.get(1).aph, ESTIMATION_APH);
  assert.equal(m.people.get(2).aph, ' 7000001 ');
  assert.equal(m.people.get(3).aph, '7000002');
  assert.equal(m.people.get(4).aph, '');
  assert.deepEqual(m.estimation, { ids: new Set([1]) });
  const users = filterUsers(m);
  assert.equal(users.find((p) => p.id === 1).aph, ESTIMATION_APH);
  assert.equal(users.find((p) => p.id === 1).estimation, true);
  assert.equal(users.find((p) => p.id === 2).estimation, false);
  const without = feuille();
  delete without.tables.Team.aph;
  assert.equal(buildModel(without).people.get(1).aph, '');
});

// ---------- APH : writer ----------

test('writer : Team.aph dans la liste blanche (mise à jour et création), type Text', () => {
  assert.ok(WRITABLE.Team.update.includes('aph'));
  assert.ok(WRITABLE.Team.add.includes('aph'));
  assert.equal(EXPECTED_TYPES['Team.aph'], 'Text');
});

test('writer : Team.aph colonne formule (vide ou non) jamais écrite, ni en mise à jour ni à la création', async () => {
  assert.equal(checkColumns(META_FORMULA).get('Team.aph'), 'vide');
  const withFormula = { ...META, 'Team.aph': { type: 'Text', isFormula: true } };
  assert.equal(checkColumns(withFormula).get('Team.aph'), 'formule');
  assert.equal(checkColumns({ ...META, 'Team.aph': undefined }).get('Team.aph'), 'absente');
  assert.equal(checkColumns({ ...META, 'Team.aph': { type: 'Numeric', isFormula: false } }).get('Team.aph'), 'type');
  assert.equal(checkColumns(META).has('Team.aph'), false);
  // Fonctions pures : la colonne retirée est refusée
  const off = checkColumns(META_FORMULA);
  assert.throws(
    () => buildUpdate('Team', 1, { aph: '1234567' }, off),
    (e) => e.reason === 'colonne-retiree',
  );
  const fields = { nom: 'N', role: 'DE', Domaine: ISD, actif: true, aph: '1234567' };
  assert.throws(
    () => buildAdd('Team', fields, off),
    (e) => e.reason === 'colonne-retiree',
  );
  // Writer : rien n'est envoyé, la raison est montrée au formulaire (can), le champ n'est pas proposé à la création
  for (const columns of [META_FORMULA, withFormula]) {
    const { g, writer } = setup({ columns });
    assert.deepEqual(writer.can('Team', 'aph'), { ok: false, reason: columns === META_FORMULA ? 'vide' : 'formule' });
    assert.equal(writer.canAddField('Team', 'aph'), false);
    assert.equal(await reason(writer.update('Team', 5, { aph: '7654321' })), 'colonne-retiree');
    assert.equal(await reason(writer.add('Team', fields)), 'colonne-retiree');
    // Le reste de la fiche reste modifiable
    await writer.update('Team', 5, { nom: 'Eve DA bis' });
    assert.deepEqual(g.batches, [[['UpdateRecord', 'Team', 5, { nom: 'Eve DA bis' }]]]);
  }
});

test('writer : Team.aph colonne de données écrite après contrôle strict (chiffres seulement, vide permis)', async () => {
  const { g, writer, readRow } = setup();
  assert.deepEqual(writer.can('Team', 'aph'), { ok: true, reason: 'ok' });
  for (const bad of ['12a', ' 1234567', '12345678901', '1 234'])
    assert.equal(await reason(writer.update('Team', 5, { aph: bad })), 'aph', bad);
  assert.equal(await reason(writer.update('Team', 5, { aph: 1234567 })), 'encodage');
  assert.equal(g.batches.length, 0);
  await writer.update('Team', 5, { aph: '7654321' });
  await writer.update('Team', 5, { aph: '' });
  assert.deepEqual(g.batches, [
    [['UpdateRecord', 'Team', 5, { aph: '7654321' }]],
    [['UpdateRecord', 'Team', 5, { aph: '' }]],
  ]);
  // Création avec un APH : un seul AddRecord ; APH invalide refusé avant l'envoi
  const fields = { nom: 'Nouvelle DE', role: 'DE', Domaine: ISD, actif: true };
  assert.equal(await reason(writer.add('Team', { ...fields, aph: 'x1' })), 'aph');
  await writer.add('Team', { ...fields, aph: '7000009' });
  assert.deepEqual(g.batches.at(-1), [['AddRecord', 'Team', null, { ...fields, aph: '7000009' }]]);
  // Par le formulaire (runSave) : saisie avec espaces de bord, envoyée nettoyée
  const base = await readRow('Team', 2);
  const r = await runSave({
    table: 'Team',
    diff: diffPerson,
    taskId: 2,
    base,
    draft: { ...personDraftFrom(base), aph: ' 7000010 ' },
    writer,
    fetchRow: (id) => readRow('Team', id),
  });
  assert.equal(r.kind, 'saved');
  assert.deepEqual(g.batches.at(-1), [['UpdateRecord', 'Team', 2, { aph: '7000010' }]]);
});

test('estimation : le widget ne pose jamais l’APH d’estimation et ne le retire jamais (writer et formulaire)', async () => {
  const { g, writer, model } = setup();
  const fields = { nom: 'Nouvelle DE', role: 'DE', Domaine: ISD, actif: true };
  // Writer : poser 9999999 (mise à jour ou création), ou changer l'APH de la ligne qui le porte : refusé
  assert.equal(await reason(writer.update('Team', 5, { aph: ESTIMATION_APH })), 'aph-estimation');
  assert.equal(await reason(writer.add('Team', { ...fields, aph: ESTIMATION_APH })), 'aph-estimation');
  assert.equal(await reason(writer.update('Team', 1, { aph: '1234567' })), 'aph-estimation');
  assert.equal(await reason(writer.update('Team', 1, { aph: '' })), 'aph-estimation');
  assert.equal(await reason(writer.update('Team', 1, { aph: ESTIMATION_APH })), 'aph-estimation');
  assert.equal(g.batches.length, 0);
  // Le reste de la fiche de la personne estimation reste modifiable
  await writer.update('Team', 1, { nom: 'Data Engineer' });
  assert.deepEqual(g.batches, [[['UpdateRecord', 'Team', 1, { nom: 'Data Engineer' }]]]);
  // Formulaire : erreur bloquante avec le message attendu, création sans l'APH d'estimation
  const m = model();
  const err = { key: 'person.error.aphEstimation' };
  const v = (draft, personId) =>
    validatePerson({ ...newPersonDraft(), nom: 'X', role: 'DE', ...draft }, { model: m, personId });
  assert.deepEqual(v({ aph: ' 9999999 ' }, null).errors.aph, err);
  assert.deepEqual(v({ aph: '9999999', role: 'DA' }, 5).errors.aph, err);
  assert.deepEqual(v({ aph: '1234567' }, 1).errors.aph, err);
  assert.deepEqual(v({ aph: '' }, 1).errors.aph, err);
  assert.equal(v({ aph: ESTIMATION_APH }, 1).errors.aph, undefined);
  assert.deepEqual(v({ aph: ESTIMATION_APH }, 1).warnings, []);
  assert.equal(
    'aph' in newPersonFields({ ...newPersonDraft(), nom: 'X', role: 'DE', aph: ESTIMATION_APH }, { model: m }),
    false,
  );
});

// ---------- Personne estimation : borne de 1 ETP ----------

test('estimation : seul le texte exact 9999999 désigne la personne estimation (comparaison stricte)', () => {
  assert.equal(ESTIMATION_APH, '9999999');
  assert.equal(isEstimationAph('9999999'), true);
  // Colonne Int : le nombre 9999999 compte aussi (aphText), jamais un autre nombre
  assert.equal(isEstimationAph(9999999), true);
  for (const no of [
    ' 9999999 ',
    '9999999 ',
    '09999999',
    9999999.5,
    -9999999,
    99999990,
    '',
    '999999',
    '99999999',
    '1234567',
    null,
    undefined,
    {},
  ])
    assert.equal(isEstimationAph(no), false, String(no));
  const m = buildModel(raw());
  assert.equal(isEstimationPerson(m, 1), true);
  assert.equal(isEstimationPerson(m, 5), false);
  assert.equal(isEstimationPerson(m, null), false);
  assert.equal(isEstimationPerson(null, 1), false);
  // Espaces de bord dans la Feuille : pas la personne estimation
  const r = raw();
  r.tables.Team.aph[0] = ' 9999999 ';
  assert.deepEqual(buildModel(r).estimation, { ids: new Set() });
});

test('estimation : plusieurs titulaires actifs de l’APH, tous exemptés (saisie, writer) ; une ligne inactive non', async () => {
  const r = raw();
  r.tables.Team.aph[4] = ESTIMATION_APH; // Eve DA aussi
  r.tables.Team.aph[2] = ESTIMATION_APH; // n° 3, inactive : pas exemptée
  const m = buildModel(r);
  assert.deepEqual(m.estimation, { ids: new Set([1, 5]) });
  assert.equal(isEstimationPerson(m, 1), true);
  assert.equal(isEstimationPerson(m, 5), true);
  assert.equal(isEstimationPerson(m, 3), false);
  // Aucun avertissement : plusieurs personnes estimation sont voulues (une par profil)
  const draft = personDraftFrom({ nom: 'Alice DE', role: 'DE', aph: ESTIMATION_APH });
  assert.deepEqual(validatePerson(draft, { model: m, personId: 1 }), { errors: {}, warnings: [] });
  // L'APH reste protégé pour chacune, inactive comprise
  assert.deepEqual(validatePerson({ ...draft, aph: '' }, { model: m, personId: 5 }).errors.aph, {
    key: 'person.error.aphEstimation',
  });
  const { g, writer } = setup();
  g.data.Team.aph[4] = ESTIMATION_APH;
  g.data.Team.aph[2] = ESTIMATION_APH;
  const period = { start: 100, end: 113 };
  for (const who of [1, 5]) {
    const i = g.data.Tasks.id.indexOf(1002);
    await writer.update(
      'Tasks',
      1002,
      { charges: `[{"teamId":${who},"heures":210}]` },
      { before: { charges: g.data.Tasks.charges[i] }, period },
    );
  }
  assert.equal(g.batches.length, 2);
  // Au-delà de 50 ETP : refusé pour chacune ; la ligne inactive reste bornée à 1 ETP
  for (const who of [1, 5])
    assert.equal(
      await reason(writer.update('Tasks', 1002, { charges: `[{"teamId":${who},"heures":3500.5}]` }, { period })),
      'charges',
    );
  for (const id of [5, 3]) assert.equal(await reason(writer.update('Team', id, { aph: '1234567' })), 'aph-estimation');
  assert.equal(g.batches.length, 2);
});

test('estimation : saisie au-delà de 1 ETP acceptée jusqu’à 50 ETP sur la période ; les autres restent à 1 ETP', () => {
  // Période où 1 ETP = 70 h (fte, periodFte) ; 50 ETP = 3 500 h
  assert.equal(ESTIMATION_MAX_ETP, 50);
  assert.equal(maxHours(70), 70);
  assert.equal(maxHours(70, true), 3500);
  assert.equal(maxHours(null, true), MAX_HOURS);
  const est = { estimation: true };
  assert.deepEqual(hoursFromInput('3', 'etp', 70, null, est), { heures: 210 });
  assert.deepEqual(hoursFromInput('3', 'etp', 70), { error: 'max', max: 70 });
  assert.deepEqual(hoursFromInput('50', 'etp', 70, null, est), { heures: 3500 });
  assert.deepEqual(hoursFromInput('50,1', 'etp', 70, null, est), { error: 'maxEstimation', max: 3500 });
  assert.deepEqual(hoursFromInput('3501', 'heures', 70, null, est), { error: 'maxEstimation', max: 3500 });
  // Sans dates : 2 000 h pour tous, estimation comprise
  assert.deepEqual(hoursFromInput('2000', 'heures', null, null, est), { heures: 2000 });
  assert.deepEqual(hoursFromInput('2001', 'heures', null, null, est), { error: 'max', max: 2000 });
  // Bloc « Personnes » (lineInput)
  const draft = { assignees: [1, 2], charges: '' };
  assert.deepEqual(lineInput(draft, 1, '3', 'etp', 70, est), {
    charges: '[{"teamId":1,"heures":210}]',
    heures: 210,
    etp: 3,
  });
  assert.deepEqual(lineInput(draft, 2, '3', 'etp', 70), { error: { error: 'max', max: 70 } });
});

test('estimation : contrôle du writer (chargesWriteProblem), exemption seulement pour la personne désignée', () => {
  const team = () => true;
  const est = (id) => id === 1;
  const v = '[{"teamId":1,"heures":210},{"teamId":2,"heures":70}]';
  assert.equal(chargesWriteProblem(v, '', team, 70, est), null);
  assert.equal(chargesWriteProblem(v, '', team, 70), 'heures : au plus 70 h (1 ETP sur la période)');
  assert.equal(
    chargesWriteProblem('[{"teamId":2,"heures":210}]', '', team, 70, est),
    'heures : au plus 70 h (1 ETP sur la période)',
  );
  assert.equal(
    chargesWriteProblem('[{"teamId":1,"heures":3500.5}]', '', team, 70, est),
    'heures : au plus 3500 h (50 ETP sur la période)',
  );
  // Un prédicat qui ne répond pas exactement vrai n'exempte personne
  assert.match(
    chargesWriteProblem(v, '', team, 70, () => 'oui'),
    /1 ETP/,
  );
});

test('estimation : le writer accepte 3 ETP pour la personne estimation, refuse 3 ETP pour une autre', async () => {
  // Période relue de la tâche : 11 au 24 avril 1970 (1 ETP ≈ 57,8 h, fteHours)
  const { g, writer } = setup();
  const period = { start: 100, end: 113 };
  const before = { charges: '[{"teamId":1,"heures":70}]' };
  const est = '[{"teamId":1,"heures":210}]';
  await writer.update('Tasks', 1002, { charges: est }, { before, period });
  assert.deepEqual(g.batches, [[['UpdateRecord', 'Tasks', 1002, { charges: est }]]]);
  // Eve DA (APH ordinaire) : toujours 1 ETP au plus
  const eve = '[{"teamId":1,"heures":210},{"teamId":5,"heures":210}]';
  const r = await reason(writer.update('Tasks', 1002, { charges: eve }, { before: { charges: est }, period }));
  assert.equal(r, 'charges');
  // Au-delà de 50 ETP : refusé même pour la personne estimation
  const huge = '[{"teamId":1,"heures":3500.5}]';
  assert.equal(
    await reason(writer.update('Tasks', 1002, { charges: huge }, { before: { charges: est }, period })),
    'charges',
  );
  assert.equal(g.batches.length, 1);
});

test('estimation : sans personne à l’APH 9999999, personne n’est exempté', async () => {
  const { g, writer } = setup();
  g.data.Team.aph = g.data.Team.aph.map(() => '');
  const period = { start: 100, end: 113 };
  const v = '[{"teamId":1,"heures":210}]';
  assert.equal(await reason(writer.update('Tasks', 1002, { charges: v }, { period })), 'charges');
  // Writer sans données lues (lookup absent) : aucune exemption non plus
  const w = createWriter({ docApi: g.docApi, mode: 'on', columns: META, refExists: () => true });
  assert.equal(await reason(w.update('Tasks', 1002, { charges: v }, { period })), 'charges');
  assert.equal(g.batches.length, 0);
});

test('estimation : « Annuler » une charge d’estimation rend la valeur d’avant, même après la perte de l’exemption', async () => {
  const { g, writer, readRow } = setup();
  const period = { start: 100, end: 113 };
  const i = g.data.Tasks.id.indexOf(1002);
  const est = '[{"teamId":1,"heures":210}]';
  await writer.update('Tasks', 1002, { charges: est }, { before: { charges: g.data.Tasks.charges[i] }, period });
  assert.equal(g.data.Tasks.charges[i], est);
  // Annulation simple : retour aux 70 h d'origine
  const u = await writer.undoLast(readRow);
  assert.equal(g.data.Tasks.charges[i], '[{"teamId":1,"heures":70}]');
  assert.ok(u.undoEntry);
  // Charge d'estimation ramenée à 70 h, puis l'exemption tombe (personne désactivée) : l'annulation rend les 210 h
  // telles quelles (valeur d'avant, non recontrôlée), une nouvelle saisie au-dessus de 1 ETP reste refusée
  await writer.update('Tasks', 1002, { charges: est }, { before: { charges: g.data.Tasks.charges[i] }, period });
  await writer.update('Tasks', 1002, { charges: '[{"teamId":1,"heures":70}]' }, { before: { charges: est }, period });
  g.data.Team.actif[0] = false;
  await writer.undoLast(readRow);
  assert.equal(g.data.Tasks.charges[i], est);
  const v = '[{"teamId":1,"heures":280}]';
  assert.equal(
    await reason(writer.update('Tasks', 1002, { charges: v }, { before: { charges: est }, period })),
    'charges',
  );
});

test('colonnes relues : une colonne redevenue formule vide est retirée à la relecture, jamais rétablie', async () => {
  const { g, writer } = setup();
  assert.equal(writer.can('Team', 'aph').ok, true);
  writer.recheckColumns(null);
  assert.equal(writer.can('Team', 'aph').ok, true);
  writer.recheckColumns(META_FORMULA);
  assert.deepEqual(writer.can('Team', 'aph'), { ok: false, reason: 'vide' });
  assert.equal(await reason(writer.update('Team', 5, { aph: '7654321' })), 'colonne-retiree');
  writer.recheckColumns(META);
  assert.deepEqual(writer.can('Team', 'aph'), { ok: false, reason: 'vide' });
  assert.equal(g.batches.length, 0);
});

test('estimation : données chargées en retard, l’APH relu avant l’envoi (before) protège quand même le titulaire', async () => {
  // L'admin désigne Eve (5) dans la Feuille ; le widget n'a pas encore relu (lookup sur les anciennes données)
  const r = raw();
  r.tables.Team.aph = r.tables.Team.id.map((id) => (id === 5 ? '1234567' : ''));
  const g = createFakeGrist(r.tables);
  const stale = structuredClone(g.data);
  g.data.Team.aph[g.data.Team.id.indexOf(5)] = ESTIMATION_APH;
  const lookup = { ...lookupFromTables(stale), choices: (k) => CHOICES[k] ?? null };
  const writer = createWriter({
    docApi: g.docApi,
    mode: 'on',
    columns: META,
    lookup,
    readTable: async (t) => structuredClone(g.data[t]),
  });
  // Conflit « garder la mienne » : before = ligne relue juste avant l'envoi
  const before = { aph: ESTIMATION_APH };
  assert.equal(await reason(writer.update('Team', 5, { aph: '1234568' }, { before })), 'aph-estimation');
  assert.equal(await reason(writer.update('Team', 5, { aph: '' }, { before })), 'aph-estimation');
  // Ligne dérivée (also) : même règle
  const also = [{ table: 'Team', id: 5, changes: { aph: '1234568' }, before }];
  assert.equal(await reason(writer.update('Team', 2, { nom: 'Bob' }, { also })), 'aph-estimation');
  assert.equal(g.batches.length, 0);
  assert.equal(g.data.Team.aph[g.data.Team.id.indexOf(5)], ESTIMATION_APH);
  // Le reste de sa fiche reste modifiable
  await writer.update('Team', 5, { nom: 'Eve DA bis' }, { before: { nom: 'Eve DA' } });
  assert.equal(g.batches.length, 1);
});
