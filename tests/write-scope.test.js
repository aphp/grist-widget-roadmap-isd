/**
 * Périmètre des écritures avec l'équipe ISD (Management ISD compris) : editAvailability, taskInScope,
 * chantierInScope, canWriteRowIn / canWriteValuesIn (règle passée au writer par main.js) et writer.
 * Projets ajoutés : 50 porté par Fanny (6, Management ISD), 60 par Gus (7, Management BNDMR), 70 porté par Dora
 * (4, hors ISD) avec Fanny seulement sponsor. Un chantier et une tâche dans chacun.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feuille } from './fixtures/feuille.js';
import { createFakeGrist, lookupOf } from './fixtures/fake-grist.js';
import { buildModel } from '../widget/js/core/model.js';
import { editAvailability, taskInScope } from '../widget/js/core/task-form.js';
import { chantierInScope } from '../widget/js/core/chantier-form.js';
import { canWriteRowIn, canWriteValuesIn } from '../widget/js/core/write-scope.js';
import { EXPECTED_TYPES, WRITABLE, WriteRefused, createWriter } from '../widget/js/core/grist-writer.js';

function addRow(table, row) {
  const n = table.id.length;
  for (const c of Object.keys(row)) if (!(c in table)) table[c] = Array(n).fill(null);
  for (const c of Object.keys(table)) table[c].push(c in row ? row[c] : null);
}

function raw() {
  const r = feuille();
  const t = r.tables;
  const project = (id, responsable, extra = {}) => {
    addRow(t.Projects, { id, nom: `Projet ${id}`, Categorie: 'Projet', responsable, ...extra });
    addRow(t.Chantiers, {
      id: id * 10,
      Nom_du_chantier: `Chantier ${id}`,
      Projets: ['L', id],
      Responsable: responsable,
    });
    addRow(t.Tasks, {
      id: id * 100,
      titre: `Tâche ${id}`,
      Chantier: id * 10,
      projet: id,
      parentTask: 0,
      statut: 'todo',
    });
  };
  project(50, 6, { Sponsor: ['L', 4] });
  project(60, 7);
  project(70, 4, { Sponsor: ['L', 6] });
  return r;
}
const m = buildModel(raw());
const ON = { mode: 'on', canEdit: true, reason: 'ok' };

test('taskInScope et chantierInScope : Management ISD responsable oui ; autre Domaine ou sponsor seul, non', () => {
  assert.equal(taskInScope(m, m.tasks.get(5000)), true);
  assert.equal(chantierInScope(m, m.chantiers.get(500)), true);
  assert.equal(taskInScope(m, m.tasks.get(6000)), false);
  assert.equal(chantierInScope(m, m.chantiers.get(600)), false);
  assert.equal(taskInScope(m, m.tasks.get(7000)), false);
  assert.equal(chantierInScope(m, m.chantiers.get(700)), false);
});

test('editAvailability : projet du Management ISD modifiable ; les deux autres refusés (« scope »)', () => {
  assert.deepEqual(editAvailability(m, { table: 'Tasks', id: 5000 }, ON), { editable: true, reason: 'ok' });
  assert.deepEqual(editAvailability(m, { table: 'Chantiers', id: 500 }, ON), { editable: true, reason: 'ok' });
  for (const ref of [
    { table: 'Tasks', id: 6000 },
    { table: 'Chantiers', id: 600 },
    { table: 'Tasks', id: 7000 },
    { table: 'Chantiers', id: 700 },
    { table: 'Team', id: 7 },
  ])
    assert.deepEqual(editAvailability(m, ref, ON), { editable: false, reason: 'scope' }, `${ref.table} ${ref.id}`);
  assert.deepEqual(editAvailability(m, { table: 'Team', id: 6 }, ON), { editable: true, reason: 'ok' });
});

test('canWriteRowIn et canWriteValuesIn : même périmètre que editAvailability', () => {
  assert.equal(canWriteRowIn(m, 'Tasks', 5000), true);
  assert.equal(canWriteRowIn(m, 'Chantiers', 500), true);
  assert.equal(canWriteRowIn(m, 'Tasks', 6000), false);
  assert.equal(canWriteRowIn(m, 'Chantiers', 600), false);
  assert.equal(canWriteRowIn(m, 'Tasks', 7000), false);
  assert.equal(canWriteRowIn(m, 'Chantiers', 700), false);
  assert.equal(canWriteRowIn(m, 'Chantiers', 999), false);
  assert.equal(canWriteRowIn(m, 'Projects', 50), false);
  assert.equal(canWriteRowIn(m, 'Team', 6), true);
  assert.equal(canWriteRowIn(m, 'Team', 7), false);
  assert.equal(
    canWriteRowIn(m, 'Disponibilites', 1, () => 6),
    true,
  );
  assert.equal(
    canWriteRowIn(m, 'Disponibilites', 1, () => 7),
    false,
  );
  assert.equal(canWriteRowIn(m, 'Disponibilites', 1), false);
  assert.equal(canWriteRowIn(null, 'Tasks', 5000), false);
  assert.equal(canWriteValuesIn(m, 'Tasks', { projet: 50 }), true);
  assert.equal(canWriteValuesIn(m, 'Tasks', { Chantier: 500 }), true);
  assert.equal(canWriteValuesIn(m, 'Tasks', { projet: 60, Chantier: 600 }), false);
  assert.equal(canWriteValuesIn(m, 'Tasks', { projet: 70 }), false);
  assert.equal(canWriteValuesIn(m, 'Chantiers', { Projets: [50] }), true);
  assert.equal(canWriteValuesIn(m, 'Chantiers', { Projets: [60, 70] }), false);
  assert.equal(canWriteValuesIn(m, 'Disponibilites', { membre: 6 }), true);
  assert.equal(canWriteValuesIn(m, 'Disponibilites', { membre: 7 }), false);
  assert.equal(canWriteValuesIn(m, 'Projects', {}), false);
  assert.equal(canWriteValuesIn(null, 'Tasks', { projet: 50 }), false);
  const isd = m.isdDomain;
  assert.equal(canWriteValuesIn(m, 'Team', { role: 'Management', Domaine: isd }, { add: true }), true);
  assert.equal(canWriteValuesIn(m, 'Team', { role: 'Management', Domaine: 'BNDMR' }, { add: true }), false);
});

const META = Object.fromEntries(Object.entries(EXPECTED_TYPES).map(([k, type]) => [k, { type, isFormula: false }]));

function setup() {
  const t = raw().tables;
  for (const [name, ops] of Object.entries(WRITABLE))
    for (const c of new Set([...ops.update, ...ops.add])) t[name][c] ??= t[name].id.map(() => null);
  const g = createFakeGrist(t);
  const writer = createWriter({
    docApi: g.docApi,
    mode: 'on',
    columns: META,
    lookup: lookupOf(g),
    readTable: async (name) => structuredClone(g.data[name]),
    canWriteRow: (table, id) => canWriteRowIn(m, table, id),
    canWriteValues: (table, v, opts) => canWriteValuesIn(m, table, v, opts),
  });
  return { g, writer };
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

test('writer : projet du Management ISD écrit ; Management d’un autre Domaine ou sponsor seul refusés', async () => {
  const { g, writer } = setup();
  await writer.update('Tasks', 5000, { titre: 'Modifiée' });
  await writer.update('Chantiers', 500, { Description: 'Texte' });
  await writer.add('Tasks', { titre: 'Nouvelle', Chantier: 500, projet: 50 });
  assert.equal(g.batches.length, 3);
  assert.equal(await reason(writer.update('Tasks', 6000, { titre: 'Non' })), 'perimetre');
  assert.equal(await reason(writer.update('Chantiers', 600, { Description: 'Non' })), 'perimetre');
  assert.equal(await reason(writer.update('Tasks', 7000, { titre: 'Non' })), 'perimetre');
  assert.equal(await reason(writer.update('Chantiers', 700, { Description: 'Non' })), 'perimetre');
  assert.equal(await reason(writer.add('Tasks', { titre: 'Non', Chantier: 700, projet: 70 })), 'perimetre');
  assert.equal(await reason(writer.add('Chantiers', { Nom_du_chantier: 'Non', Projets: [60] })), 'perimetre');
  assert.equal(g.batches.length, 3);
});
