/**
 * Writer, lot 2d : personnes (Team) et indisponibilités (Disponibilites). Liste blanche, contrôle strict (nom,
 * e-mail, rôle et Domaine parmi les choix, capacité 0 < h ≤ 60 au pas de 0,5, N+1), périmètre ISD sur les lignes
 * et sur les valeurs d'arrivée, jamais de RemoveRecord sur Team (désactivation à la place), annulation d'une
 * indisponibilité créée. Faux Grist Node, jamais de vrai Grist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feuille } from './fixtures/feuille.js';
import { createFakeGrist, lookupOf } from './fixtures/fake-grist.js';
import {
  EXPECTED_TYPES,
  NO_REMOVE,
  READ_ALSO,
  WRITABLE,
  WriteRefused,
  assertActions,
  buildAdd,
  buildUpdate,
  checkColumns,
  createWriter,
  decodeRow,
  integrityProblem,
  lookupFromTables,
  referencesTo,
  validCapacity,
} from '../widget/js/core/grist-writer.js';
import { buildModel } from '../widget/js/core/model.js';
import { personInScope, teamValuesInScope } from '../widget/js/core/person-form.js';
import { runCreate, runSave, runSetActive } from '../widget/js/core/task-session.js';
import { diffPerson, personDraftFrom, diffUnav, unavDraftFrom } from '../widget/js/core/person-form.js';

const ISD = 'Ingénierie et sciences des données - ISD';
const META = Object.fromEntries(Object.entries(EXPECTED_TYPES).map(([k, type]) => [k, { type, isFormula: false }]));
const CHOICES = {
  'Team.role': ['Management', 'DS', 'DE', 'DA', 'PO Data'],
  'Team.Domaine': ['Direction I&D', ISD, 'BNDMR'],
};

function raw() {
  const r = feuille();
  for (const [name, ops] of Object.entries(WRITABLE))
    for (const c of new Set([...ops.update, ...ops.add, ...(READ_ALSO[name] ?? [])]))
      r.tables[name][c] ??= r.tables[name].id.map(() => null);
  for (const [c, def] of [
    ['commentaire', ''],
    ['type', ''],
  ])
    r.tables.Disponibilites[c] = r.tables.Disponibilites[c].map((v) => v ?? def);
  r.choices = { ...r.choices, ...CHOICES };
  return r;
}

/** Faux Grist + writer avec les règles de périmètre du widget (main.js) branchées sur person-form.js. */
function setup(opts = {}) {
  const r = raw();
  const g = createFakeGrist(r.tables, opts.grist);
  const model = () => buildModel({ ...r, tables: g.data });
  const base = lookupOf(g);
  const lookup = { ...base, choices: (k) => CHOICES[k] ?? null };
  const canWriteRow = (table, id) => {
    const m = model();
    if (table === 'Team') return personInScope(m, m.people.get(id));
    if (table === 'Disponibilites') return personInScope(m, m.people.get(lookup.row(table, id)?.membre));
    return false;
  };
  const canWriteValues = (table, v, o) => {
    const m = model();
    if (table === 'Team') return teamValuesInScope(m, v, o);
    if (table === 'Disponibilites') return personInScope(m, m.people.get(v.membre));
    return false;
  };
  const writer = createWriter({
    docApi: g.docApi,
    mode: opts.mode ?? 'on',
    columns: opts.columns ?? META,
    lookup,
    canWriteRow,
    canWriteValues,
    readTable: async (t) => structuredClone(g.data[t]),
    ...opts.writer,
  });
  const readRow = async (t, id) => decodeRow(g.data[t], t, id);
  return { g, writer, lookup, readRow, model };
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

test('liste blanche Team et Disponibilites : colonnes, types, pas de Domaine en mise à jour, jamais de suppression', () => {
  assert.deepEqual([...WRITABLE.Team.update].sort(), ['actif', 'capaciteHebdo', 'email', 'n_1', 'nom', 'role']);
  assert.deepEqual([...WRITABLE.Team.add].sort(), ['Domaine', 'actif', 'capaciteHebdo', 'email', 'n_1', 'nom', 'role']);
  assert.ok(!WRITABLE.Team.update.includes('Domaine'));
  assert.ok(!WRITABLE.Disponibilites.update.includes('membre'));
  for (const c of ['avatar', 'couleur', 'indispos']) assert.ok(!WRITABLE.Team.add.includes(c), c);
  assert.deepEqual(NO_REMOVE, ['Team']);
  assert.equal(EXPECTED_TYPES['Team.actif'], 'Bool');
  assert.equal(EXPECTED_TYPES['Team.capaciteHebdo'], 'Numeric');
  assert.equal(EXPECTED_TYPES['Disponibilites.membre'], 'Ref:Team');
  assert.ok(Object.isFrozen(WRITABLE.Team.update) && Object.isFrozen(WRITABLE.Disponibilites.add));
  // Colonne capaciteHebdo vide de la Feuille (formule sans formule) : retirée, l'écrire la convertirait (structure)
  const off = checkColumns({ ...META, 'Team.capaciteHebdo': { type: 'Numeric', isFormula: true } });
  assert.equal(off.get('Team.capaciteHebdo'), 'formule');
  const empty = checkColumns({ ...META, 'Team.capaciteHebdo': { type: 'Numeric', isFormula: true, empty: true } });
  assert.equal(empty.get('Team.capaciteHebdo'), 'vide');
});

test('RemoveRecord sur Team : toujours refusé, même pour une ligne de la session', () => {
  assert.throws(
    () => assertActions([['RemoveRecord', 'Team', 1]], { removable: () => true }),
    (e) => e instanceof WriteRefused && e.reason === 'suppression',
  );
  assert.doesNotThrow(() => assertActions([['RemoveRecord', 'Disponibilites', 1]], { removable: () => true }));
});

test('buildUpdate / buildAdd : encodage (Bool, Numeric, Ref), obligatoires et colonnes hors liste', () => {
  assert.deepEqual(buildUpdate('Team', 1, { actif: false, capaciteHebdo: '17,5', n_1: null }), [
    'UpdateRecord',
    'Team',
    1,
    { actif: false, capaciteHebdo: 17.5, n_1: 0 },
  ]);
  assert.throws(() => buildUpdate('Team', 1, { Domaine: 'BNDMR' }), /colonne/);
  assert.throws(() => buildUpdate('Team', 1, { actif: 'oui' }), /encodage/);
  assert.throws(() => buildAdd('Team', { nom: 'X', role: 'DE', actif: true }), /requis/);
  assert.deepEqual(buildAdd('Team', { nom: 'X', role: 'DE', Domaine: ISD, actif: true }), [
    'AddRecord',
    'Team',
    null,
    { nom: 'X', role: 'DE', Domaine: ISD, actif: true },
  ]);
  assert.throws(() => buildAdd('Team', { nom: 'X', role: 'DE', Domaine: ISD, actif: true, avatar: 'a' }), /colonne/);
  assert.throws(() => buildAdd('Disponibilites', { membre: 1, dateDebut: 3 }), /requis/);
});

test('capacité : 0 < h ≤ 60 au pas de 0,5', () => {
  for (const h of [0.5, 17.5, 35, 60]) assert.ok(validCapacity(h), String(h));
  for (const h of [0, -1, 60.5, 61, 0.3, NaN, Infinity, null, '35']) assert.ok(!validCapacity(h), String(h));
});

test('integrityProblem Team : nom, e-mail, rôle et Domaine parmi les choix, capacité, N+1, actif', () => {
  const g = createFakeGrist(raw().tables);
  const look = { ...lookupOf(g), choices: (k) => CHOICES[k] ?? null };
  const upd = (values) => integrityProblem([{ table: 'Team', id: 1, values }], look);
  const add = (values) =>
    integrityProblem(
      [{ table: 'Team', id: null, values: { nom: 'N', role: 'DE', Domaine: ISD, actif: true, ...values } }],
      look,
    );
  assert.equal(upd({ nom: '  ' }), 'nom-personne');
  assert.equal(upd({ email: 'pas une adresse' }), 'email');
  assert.equal(upd({ email: '' }), null);
  assert.equal(upd({ email: 'a.b@exemple.fr' }), null);
  assert.equal(upd({ role: 'Nouveau rôle' }), 'role');
  assert.equal(upd({ role: '' }), 'role');
  assert.equal(upd({ role: 'DS' }), null);
  assert.equal(upd({ capaciteHebdo: 0 }), 'capacite');
  assert.equal(upd({ capaciteHebdo: 61 }), 'capacite');
  assert.equal(upd({ capaciteHebdo: null }), 'capacite');
  assert.equal(upd({ capaciteHebdo: 60 }), null);
  assert.equal(upd({ n_1: 1 }), 'n1-soi');
  assert.equal(upd({ n_1: 999 }), 'reference');
  assert.equal(upd({ n_1: 6 }), null);
  assert.equal(upd({ n_1: null }), null);
  assert.equal(upd({ actif: 'non' }), 'actif');
  assert.equal(upd({ actif: false }), null);
  assert.equal(add({}), null);
  assert.equal(add({ capaciteHebdo: null }), null);
  assert.equal(add({ actif: false }), 'actif');
  assert.equal(add({ Domaine: 'Inventé' }), 'domaine');
  assert.equal(add({ role: 'Chef' }), 'role');
  // Sans liste de choix lue, aucun rôle n'est admis (on ne devine pas)
  const blind = integrityProblem([{ table: 'Team', id: 1, values: { role: 'DE' } }], lookupOf(g));
  assert.equal(blind, 'role');
});

test('integrityProblem Disponibilites : membre existant, dates obligatoires et ordonnées, part de 0 à 1', () => {
  const g = createFakeGrist(raw().tables);
  const look = lookupOf(g);
  const add = (values) =>
    integrityProblem(
      [{ table: 'Disponibilites', id: null, values: { membre: 1, dateDebut: 10, dateFin: 12, dispo: 0, ...values } }],
      look,
    );
  assert.equal(add({}), null);
  assert.equal(add({ membre: 999 }), 'reference');
  assert.equal(add({ dateFin: null }), 'dates-requises');
  assert.equal(add({ dateFin: 9 }), 'dates');
  assert.equal(add({ dispo: 1.5 }), 'dispo');
  assert.equal(add({ dispo: null }), null);
  assert.equal(add({ type: 'x'.repeat(301) }), 'texte');
  assert.equal(
    integrityProblem([{ table: 'Disponibilites', id: 1, values: { dateFin: null } }], look),
    'dates-requises',
  );
  assert.deepEqual(referencesTo({ Tasks: g.data.Tasks }, 'Disponibilites', 1), []);
});

test('decodeRow lit aussi le Domaine (Team) et le membre (Disponibilites) pour le périmètre', () => {
  const g = createFakeGrist(raw().tables);
  assert.equal(decodeRow(g.data.Team, 'Team', 1).Domaine, ISD);
  assert.equal(decodeRow(g.data.Disponibilites, 'Disponibilites', 2).membre, 5);
  assert.equal(lookupFromTables({}, { choices: (k) => CHOICES[k] }).choices('Team.role').length, 5);
  assert.equal(lookupFromTables({}).choices('Team.role'), null);
});

test('mise à jour d’une personne ISD : un UpdateRecord, seules les colonnes modifiées', async () => {
  const { g, writer, readRow } = setup();
  const base = await readRow('Team', 1);
  const draft = { ...personDraftFrom(base), capaciteHebdo: 28, email: ' alice.de@exemple.fr ' };
  const r = await runSave({
    table: 'Team',
    diff: diffPerson,
    taskId: 1,
    base,
    draft,
    writer,
    fetchRow: (id) => readRow('Team', id),
  });
  assert.equal(r.kind, 'saved');
  assert.deepEqual(g.batches, [[['UpdateRecord', 'Team', 1, { email: 'alice.de@exemple.fr', capaciteHebdo: 28 }]]]);
});

test('conflit : une cellule modifiée ailleurs n’est pas écrasée, les autres passent (fusion par champ)', async () => {
  const { g, writer, readRow } = setup();
  const base = await readRow('Team', 1);
  g.otherUserSets('Team', 1, { email: 'autre@exemple.fr' });
  const draft = { ...personDraftFrom(base), email: 'moi@exemple.fr' };
  const conflict = await runSave({
    table: 'Team',
    diff: diffPerson,
    taskId: 1,
    base,
    draft,
    writer,
    fetchRow: (id) => readRow('Team', id),
  });
  assert.equal(conflict.kind, 'conflict');
  assert.deepEqual(conflict.cols, ['email']);
  assert.equal(g.batches.length, 0);
  // Autre champ modifié ailleurs, saisie sur la capacité seulement : pas de conflit
  const draft2 = { ...personDraftFrom(base), capaciteHebdo: 30 };
  const ok = await runSave({
    table: 'Team',
    diff: diffPerson,
    taskId: 1,
    base,
    draft: draft2,
    writer,
    fetchRow: (id) => readRow('Team', id),
  });
  assert.equal(ok.kind, 'saved');
  assert.deepEqual(g.batches, [[['UpdateRecord', 'Team', 1, { capaciteHebdo: 30 }]]]);
  assert.equal(g.data.Team.email[0], 'autre@exemple.fr');
});

test('périmètre : personne hors ISD refusée ; rôle qui ferait sortir de l’ISD refusé ; inactive ISD modifiable', async () => {
  const { g, writer } = setup();
  assert.equal(await reason(writer.update('Team', 4, { nom: 'Dora' })), 'perimetre'); // BNDMR, sans rôle
  assert.equal(await reason(writer.update('Team', 7, { capaciteHebdo: 20 })), 'perimetre'); // Management hors ISD
  // Eve DA sans Domaine : passer en Management la ferait sortir de l'équipe ISD
  assert.equal(await reason(writer.update('Team', 5, { role: 'Management' })), 'perimetre');
  // Fanny Management, Domaine ISD : rôle DE admis (reste ISD)
  await writer.update('Team', 6, { role: 'DE' });
  await writer.update('Team', 3, { capaciteHebdo: 21 }); // Carl DS inactif
  assert.deepEqual(g.batches, [
    [['UpdateRecord', 'Team', 6, { role: 'DE' }]],
    [['UpdateRecord', 'Team', 3, { capaciteHebdo: 21 }]],
  ]);
});

test('création d’une personne : Domaine ISD et rôle ISD ou Management obligatoires ; une seule AddRecord', async () => {
  const { g, writer } = setup();
  const fields = { nom: 'Nina Nouvelle', role: 'DS', Domaine: ISD, actif: true, email: 'nina@exemple.fr' };
  assert.equal(await reason(writer.add('Team', { ...fields, Domaine: 'BNDMR' })), 'perimetre');
  assert.equal(
    await reason(writer.add('Team', { ...fields, Domaine: 'Direction I&D', role: 'Management' })),
    'perimetre',
  );
  const r = await runCreate({ writer, table: 'Team', fields });
  assert.equal(r.kind, 'saved');
  assert.deepEqual(g.batches, [[['AddRecord', 'Team', null, fields]]]);
  assert.equal(r.entry.id, 8);
});

test('« Annuler » une création de personne : jamais de RemoveRecord, la raison est donnée', async () => {
  const { g, writer, readRow } = setup();
  await writer.add('Team', { nom: 'Nina', role: 'DE', Domaine: ISD, actif: true });
  const r = await writer.undoLast(readRow);
  assert.equal(r.reason, 'personne');
  assert.equal(r.undoEntry, null);
  assert.equal(g.batches.length, 1);
  assert.ok(!g.batches.flat().some((a) => a[0] === 'RemoveRecord'));
  // Mode essai : pas de suppression non plus
  const dry = setup({ mode: 'dry-run' });
  await dry.writer.add('Team', { nom: 'Nina', role: 'DE', Domaine: ISD, actif: true });
  assert.equal((await dry.writer.undoLast(dry.readRow)).reason, 'personne');
  assert.equal(dry.g.batches.length, 0);
});

test('désactiver puis réactiver : UpdateRecord actif, ligne relue, rien si déjà dans l’état ; « Annuler » réactive', async () => {
  const { g, writer, readRow } = setup();
  const fetchRow = (id) => readRow('Team', id);
  const off = await runSetActive({ writer, personId: 1, actif: false, fetchRow });
  assert.equal(off.kind, 'saved');
  assert.equal((await runSetActive({ writer, personId: 1, actif: false, fetchRow })).kind, 'nothing');
  const undo = await writer.undoLast(readRow);
  assert.ok(undo.undoEntry);
  const on = await runSetActive({ writer, personId: 3, actif: true, fetchRow });
  assert.equal(on.kind, 'saved');
  assert.deepEqual(g.batches, [
    [['UpdateRecord', 'Team', 1, { actif: false }]],
    [['UpdateRecord', 'Team', 1, { actif: true }]],
    [['UpdateRecord', 'Team', 3, { actif: true }]],
  ]);
  assert.ok(!g.batches.flat().some((a) => a[0] === 'RemoveRecord'));
  assert.equal((await runSetActive({ writer, personId: 4, actif: false, fetchRow })).kind, 'failed'); // hors ISD
  assert.equal((await runSetActive({ writer, personId: 999, actif: false, fetchRow })).kind, 'missing');
});

test('désactiver : relecture impossible ou sans réponse ; mode essai sans envoi', async () => {
  const { writer } = setup();
  const failing = await runSetActive({
    writer,
    personId: 1,
    actif: false,
    fetchRow: async () => {
      throw new Error('réseau');
    },
  });
  assert.equal(failing.kind, 'reread-failed');
  const hang = setup({ grist: { hang: 'before' }, writer: { timeoutMs: 20 } });
  const unknown = await runSetActive({
    writer: hang.writer,
    personId: 1,
    actif: false,
    fetchRow: (id) => hang.readRow('Team', id),
    timeoutMs: 20,
  });
  assert.equal(unknown.kind, 'unknown');
  const dry = setup({ mode: 'dry-run' });
  const r = await runSetActive({ writer: dry.writer, personId: 1, actif: false, localBase: { actif: true } });
  assert.equal(r.kind, 'saved');
  assert.equal(r.entry.sent, false);
  assert.equal(dry.g.batches.length, 0);
});

test('indisponibilité : création (membre ISD seulement), modification, annulation de la création', async () => {
  const { g, writer, readRow } = setup();
  const fields = { membre: 1, dateDebut: 20000, dateFin: 20004, dispo: 0.5, type: 'Formation' };
  assert.equal(await reason(writer.add('Disponibilites', { ...fields, membre: 4 })), 'perimetre');
  const r = await runCreate({ writer, table: 'Disponibilites', fields });
  assert.equal(r.kind, 'saved');
  const id = r.entry.id;
  const undo = await writer.undoLast(readRow);
  assert.ok(undo.undoEntry);
  assert.deepEqual(g.batches.at(-1), [['RemoveRecord', 'Disponibilites', id]]);
  // Modification d'une indisponibilité existante (membre ISD), puis d'une hors ISD (refusée)
  const base = await readRow('Disponibilites', 1);
  const saved = await runSave({
    table: 'Disponibilites',
    diff: diffUnav,
    taskId: 1,
    base,
    draft: { ...unavDraftFrom(base), dispo: 0.2 },
    writer,
    fetchRow: (x) => readRow('Disponibilites', x),
  });
  assert.equal(saved.kind, 'saved');
  assert.deepEqual(g.batches.at(-1), [['UpdateRecord', 'Disponibilites', 1, { dispo: 0.2 }]]);
  assert.equal(await reason(writer.update('Disponibilites', 3, { dispo: 0.2 })), null); // Bob PO : ISD
  const g2 = setup();
  g2.g.otherUserSets('Disponibilites', 3, { membre: 4 });
  assert.equal(await reason(g2.writer.update('Disponibilites', 3, { dispo: 0.2 })), 'perimetre');
});

test('indisponibilité créée puis modifiée ailleurs : « Annuler » ne la supprime pas', async () => {
  const { g, writer, readRow } = setup();
  const r = await writer.add('Disponibilites', { membre: 1, dateDebut: 20000, dateFin: 20004, dispo: 0 });
  g.otherUserSets('Disponibilites', r.id, { commentaire: 'ajouté ailleurs' });
  const undo = await writer.undoLast(readRow);
  assert.equal(undo.reason, 'modifiee');
  assert.ok(!g.batches.flat().some((a) => a[0] === 'RemoveRecord'));
});

test('mode essai et édition coupée : rien n’est envoyé', async () => {
  const dry = setup({ mode: 'dry-run' });
  const e = await dry.writer.update('Team', 1, { capaciteHebdo: 30 });
  assert.equal(e.sent, false);
  await dry.writer.add('Team', { nom: 'N', role: 'DE', Domaine: ISD, actif: true });
  assert.equal(dry.g.batches.length, 0);
  const off = setup({ mode: 'off' });
  assert.equal(await reason(off.writer.update('Team', 1, { capaciteHebdo: 30 })), 'off');
  assert.equal(off.writer.can('Team', 'nom').reason, 'off');
  assert.equal(off.writer.canAdd('Team').reason, 'off');
});

test('sans lookup : toute écriture Team ou Disponibilites est refusée (vérification)', async () => {
  const g = createFakeGrist(raw().tables);
  const writer = createWriter({ docApi: g.docApi, mode: 'on', columns: META });
  assert.equal(await reason(writer.update('Team', 1, { capaciteHebdo: 30 })), 'verification');
  assert.equal(await reason(writer.add('Disponibilites', { membre: 1, dateDebut: 2, dateFin: 3 })), 'verification');
  assert.equal(g.batches.length, 0);
});

test('capacité en colonne formule (vide dans la Feuille) : non modifiable, création possible sans elle', async () => {
  const { writer } = setup({ columns: { ...META, 'Team.capaciteHebdo': { type: 'Numeric', isFormula: true } } });
  assert.equal(writer.can('Team', 'capaciteHebdo').reason, 'formule');
  assert.equal(writer.canAdd('Team').ok, true);
  assert.equal(writer.canAddField('Team', 'capaciteHebdo'), false);
  assert.equal(await reason(writer.update('Team', 1, { capaciteHebdo: 30 })), 'colonne-retiree');
});
