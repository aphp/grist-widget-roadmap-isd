/**
 * Charges à la création d'une tâche (bloc « Personnes » des fenêtres « Nouvelle tâche » et « Sous-tâche ») :
 * Tasks.charges permis dans l'AddRecord avec les contrôles stricts de la mise à jour (JSON, personnes existantes,
 * pas de 0,5 h, 1 ETP sur la période des dates du même AddRecord, exemption de la seule personne estimation) et la
 * cohérence assignés / charges. Faux Grist Node, jamais de vrai Grist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feuille } from './fixtures/feuille.js';
import { createFakeGrist, lookupOf } from './fixtures/fake-grist.js';
import { ESTIMATION_APH } from '../widget/js/core/charges-edit.js';
import { newChargesError, newTaskDraft, newTaskFields } from '../widget/js/core/create-form.js';
import {
  EXPECTED_TYPES,
  READ_ALSO,
  WRITABLE,
  WriteRefused,
  buildAdd,
  createWriter,
  newChargesProblem,
} from '../widget/js/core/grist-writer.js';
import { buildModel } from '../widget/js/core/model.js';

const META = Object.fromEntries(Object.entries(EXPECTED_TYPES).map(([k, type]) => [k, { type, isFormula: false }]));

/** Feuille de test : Alice (1) est la personne estimation, Eve DA (5) a un APH ordinaire. */
function raw() {
  const r = feuille();
  for (const [name, ops] of Object.entries(WRITABLE))
    for (const c of new Set([...ops.update, ...ops.add, ...(READ_ALSO[name] ?? [])]))
      r.tables[name][c] ??= r.tables[name].id.map(() => null);
  r.tables.Team.aph = r.tables.Team.id.map((id) => (id === 1 ? ESTIMATION_APH : id === 5 ? '1234567' : ''));
  return r;
}

function setup(mode = 'on') {
  const g = createFakeGrist(raw().tables);
  const writer = createWriter({
    docApi: g.docApi,
    mode,
    columns: META,
    lookup: lookupOf(g),
    readTable: async (t) => structuredClone(g.data[t]),
    tempId: () => 5000,
  });
  return { g, writer };
}

const reason = async (p) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteRefused) return e.message;
    throw e;
  }
  return null;
};
const syncReason = (fn) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof WriteRefused) return e.reason;
    throw e;
  }
  return null;
};

// 14 jours (100 à 113) : 1 ETP = 70 h ; 50 ETP = 3 500 h
const BASE = { titre: 'Nouvelle', Chantier: 100, projet: 10, statut: 'todo', type: 'tache' };
const DATED = { ...BASE, dateDebut: 100, dateEcheance: 113 };
const team = (t, id) => t === 'Team' && [1, 2, 3, 5].includes(id);
const est = (id) => id === 1;
const ch = (...entries) => JSON.stringify(entries.map(([teamId, heures]) => ({ teamId, heures })));

test('buildAdd : charges contrôlées comme en mise à jour, sur la période des dates du même AddRecord', () => {
  const ctx = { refExists: team, isEstimation: est };
  const v = ch([1, 35], [2, 70]);
  assert.deepEqual(buildAdd('Tasks', { ...DATED, assignees: [1, 2], charges: v }, new Map(), ctx)[3].charges, v);
  // Borne de 1 ETP sur la période : 70 h pour 14 jours
  const add = (fields) => syncReason(() => buildAdd('Tasks', fields, new Map(), ctx));
  assert.equal(add({ ...DATED, assignees: [2], charges: ch([2, 70.5]) }), 'charges');
  // Sans dates : 2 000 h au plus pour tous
  assert.equal(add({ ...BASE, assignees: [2], charges: ch([2, 2000]) }), null);
  assert.equal(add({ ...BASE, assignees: [2], charges: ch([2, 2000.5]) }), 'charges');
  // Une seule date : pas de période, borne sans dates
  assert.equal(add({ ...BASE, dateDebut: 100, assignees: [2], charges: ch([2, 500]) }), null);
  // Personne estimation : 50 ETP sur la période, jamais plus
  assert.equal(add({ ...DATED, assignees: [1], charges: ch([1, 3500]) }), null);
  assert.equal(add({ ...DATED, assignees: [1], charges: ch([1, 3500.5]) }), 'charges');
  // Sans prédicat d'estimation ni d'existence : aucune exemption, personne n'existe
  assert.equal(
    syncReason(() =>
      buildAdd('Tasks', { ...DATED, assignees: [1], charges: ch([1, 210]) }, new Map(), { refExists: team }),
    ),
    'charges',
  );
  assert.equal(
    syncReason(() => buildAdd('Tasks', { ...DATED, assignees: [2], charges: ch([2, 7]) })),
    'charges',
  );
});

test('newChargesProblem : entrées invalides, personne inconnue, doublon, charge sans assignation', () => {
  const p = (fields) => newChargesProblem({ ...DATED, ...fields }, (n) => team('Team', n), est);
  assert.equal(p({ assignees: [2], charges: '[]' }), null);
  assert.equal(p({ assignees: [2], charges: 'pas du json' }), 'JSON illisible');
  assert.equal(p({ assignees: [2], charges: '{"teamId":2}' }), 'tableau JSON attendu');
  assert.equal(p({ assignees: [2], charges: 7 }), 'texte JSON attendu');
  assert.equal(p({ assignees: [2], charges: '[1]' }), 'entrée qui n’est pas un objet');
  assert.equal(p({ assignees: [2], charges: '[{"teamId": 2, "heures": 7}]' }), 'encodage non compact');
  assert.equal(p({ assignees: [2], charges: ch([0, 7]) }), 'teamId entier attendu');
  assert.equal(p({ assignees: [99], charges: ch([99, 7]) }), 'personne inconnue : 99');
  assert.equal(p({ assignees: [2], charges: ch([2, -1]) }), 'heures : nombre fini positif ou nul attendu');
  assert.equal(p({ assignees: [2], charges: ch([2, 7.25]) }), 'heures : pas de 0,5 h attendu');
  assert.equal(p({ assignees: [2], charges: ch([2, 71]) }), 'heures : au plus 70 h (1 ETP sur la période)');
  assert.equal(p({ assignees: [2], charges: ch([2, 7], [2, 7]) }), 'personne en double : 2');
  assert.equal(p({ assignees: [2], charges: ch([2, 7], [5, 7]) }), 'personne chargée non assignée : 5');
  assert.equal(p({ charges: ch([2, 7]) }), 'personne chargée non assignée : 2');
  // Assigné sans charge : permis (charge facultative)
  assert.equal(p({ assignees: [2, 5], charges: ch([2, 7]) }), null);
});

test('création réelle : UN AddRecord avec assignés et charges, borne de 1 ETP et estimation par le writer', async () => {
  const { g, writer } = setup();
  const charges = ch([2, 35], [5, 12]);
  const e = await writer.add('Tasks', { ...DATED, assignees: [2, 5], charges });
  assert.equal(g.batches.length, 1);
  assert.deepEqual(g.batches[0], [
    [
      'AddRecord',
      'Tasks',
      null,
      { ...BASE, dateDebut: 100 * 86400, dateEcheance: 113 * 86400, assignees: ['L', 2, 5], charges },
    ],
  ]);
  assert.equal(e.sent, true);
  // Au-delà de 1 ETP pour une personne ordinaire : refusé, rien n'est envoyé
  assert.match(await reason(writer.add('Tasks', { ...DATED, assignees: [5], charges: ch([5, 140]) })), /^charges/);
  // Personne estimation (titulaire unique de l'APH) : 3 ETP acceptés
  await writer.add('Tasks', { ...DATED, assignees: [1], charges: ch([1, 210]) });
  assert.equal(g.batches.length, 2);
  // Deuxième titulaire de l'APH : plus personne n'est exempté
  g.data.Team.aph[g.data.Team.id.indexOf(5)] = ESTIMATION_APH;
  assert.match(await reason(writer.add('Tasks', { ...DATED, assignees: [1], charges: ch([1, 210]) })), /^charges/);
  // Personne inconnue, charge sans assignation
  assert.match(await reason(writer.add('Tasks', { ...DATED, assignees: [99], charges: ch([99, 7]) })), /^charges/);
  assert.match(await reason(writer.add('Tasks', { ...DATED, charges: ch([2, 7]) })), /non assignée/);
  assert.equal(g.batches.length, 2);
});

test('création en mode essai avec charges : rien n’est envoyé, mêmes contrôles', async () => {
  const { g, writer } = setup('dry-run');
  const e = await writer.add('Tasks', { ...DATED, assignees: [2], charges: ch([2, 35]) });
  assert.equal(e.sent, false);
  assert.equal(e.applied[0][3].charges, ch([2, 35]));
  assert.match(await reason(writer.add('Tasks', { ...DATED, assignees: [2], charges: ch([2, 71]) })), /^charges/);
  assert.equal(g.batches.length, 0);
});

test('fenêtre de création : charge facultative, borne sur la période saisie, valeurs envoyées', () => {
  const model = buildModel(raw());
  const d = { ...newTaskDraft(model, { chantierId: 100, me: 2 }), titre: 'T' };
  // « Je suis… » : une ligne assignée, charge vide
  assert.deepEqual(d.assignees, [2]);
  assert.equal(d.charges, '');
  assert.equal(newChargesError(d, model), null);
  assert.ok(!('charges' in newTaskFields(d)));
  assert.ok(!('charges' in newTaskFields({ ...d, charges: '[]' })));
  const dated = { ...d, dateDebut: 100, dateEcheance: 113, assignees: [2, 5], charges: ch([2, 35], [5, 7]) };
  assert.equal(newChargesError(dated, model), null);
  assert.equal(newTaskFields(dated).charges, ch([2, 35], [5, 7]));
  // Dates raccourcies après la saisie : la charge dépasse 1 ETP, création bloquée
  assert.deepEqual(newChargesError({ ...dated, dateEcheance: 101 }, model), {
    key: 'create.error.chargesOver',
    vars: { h: 10 },
  });
  // Personne estimation : 50 ETP
  assert.equal(newChargesError({ ...dated, assignees: [1], charges: ch([1, 210]) }, model), null);
  // Incohérences : charge sans assignation, doublon, inconnu, cellule illisible
  for (const bad of [ch([5, 7]), ch([2, 7], [2, 7]), ch([99, 7]), '[{"x":1}]', 'oups'])
    assert.deepEqual(newChargesError({ ...dated, assignees: [2], charges: bad }, model), {
      key: 'form.error.charges',
    });
  // Assignés non permis à la création : aucune charge envoyée
  const f = newTaskFields(dated, { canAddField: (c) => c !== 'assignees' });
  assert.ok(!('assignees' in f) && !('charges' in f));
  assert.ok(!('charges' in newTaskFields(dated, { canAddField: (c) => c !== 'charges' })));
});
