/** Bloc « Personnes » : assignés et charges réunis (core/task-people.js) et liste unique en lecture (taskPeopleRows). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addPersonLine,
  assignPerson,
  lineInput,
  peopleLines,
  presentIds,
  removePersonLine,
} from '../widget/js/core/task-people.js';
import { taskPeople, taskPeopleRows } from '../widget/js/core/kanban-data.js';

const model = {
  people: new Map([
    [1, { id: 1, nom: 'Alice A', role: 'DE', isd: true }],
    [2, { id: 2, nom: 'Bruno B', role: 'DS', isd: true }],
    [3, { id: 3, nom: 'Chloé C', role: null, isd: false }],
  ]),
};
const ids = (r) => r.lines.map((l) => l.teamId);

test('union des assignés et des charges : ordre, drapeau non assignée, charge vide', () => {
  const r = peopleLines(model, [2, 1], '[{"teamId":3,"heures":7},{"teamId":1,"heures":10}]');
  assert.equal(r.readable, true);
  // Assignés dans leur ordre, puis les charges sans assignation, dans l'ordre de la cellule
  assert.deepEqual(ids(r), [2, 1, 3]);
  assert.deepEqual(r.lines[0], { teamId: 2, assigned: true, charged: false, heures: null, count: 0, known: true });
  assert.deepEqual(r.lines[1], { teamId: 1, assigned: true, charged: true, heures: 10, count: 1, known: true });
  assert.deepEqual(r.lines[2], { teamId: 3, assigned: false, charged: true, heures: 7, count: 1, known: true });
  assert.deepEqual(presentIds(model, [2], '[{"teamId":3,"heures":7}]'), [2, 3]);
});

test('cas limites : vide, absente de l’équipe, doublons, entrées invalides, cellule illisible', () => {
  assert.deepEqual(peopleLines(model, [], null).lines, []);
  assert.deepEqual(peopleLines(model, [], '').lines, []);
  // Personne absente de Team (assignée ou chargée) : ligne conservée, marquée inconnue
  const u = peopleLines(model, [99], '[{"teamId":98,"heures":2}]');
  assert.deepEqual(
    u.lines.map((l) => [l.teamId, l.known, l.assigned]),
    [
      [99, false, true],
      [98, false, false],
    ],
  );
  // Assigné en double dans la RefList : une seule ligne
  assert.deepEqual(ids(peopleLines(model, [1, 1], null)), [1]);
  // Doublon dans les charges : une ligne, heures cumulées, count = 2
  const d = peopleLines(model, [1], '[{"teamId":1,"heures":2},{"teamId":1,"heures":3}]');
  assert.deepEqual([d.lines.length, d.lines[0].heures, d.lines[0].count], [1, 5, 2]);
  // Entrée invalide : à part, conservée ; elle ne crée pas de ligne
  const i = peopleLines(model, [], '[{"teamId":2},"x"]');
  assert.deepEqual(i.lines, []);
  assert.deepEqual(
    i.invalid.map((x) => x.teamId),
    [2, null],
  );
  // Cellule illisible : lignes des seuls assignés, sans charge
  const bad = peopleLines(model, [2], 'oops');
  assert.equal(bad.readable, false);
  assert.deepEqual(bad.lines, [{ teamId: 2, assigned: true, charged: false, heures: null, count: 0, known: true }]);
});

test('ajouter assigne sans créer de charge ; assigner une charge non assignée ; jamais d’office', () => {
  const draft = { assignees: [1], charges: '[{"teamId":3,"heures":7}]' };
  const added = addPersonLine(draft, 2);
  assert.deepEqual(added.assignees, [1, 2]);
  assert.equal(added.charges, draft.charges, 'charges inchangées (charge vide)');
  assert.equal(addPersonLine(added, 2), added, 'déjà assignée : sans effet');
  // La personne 3 a une charge sans être assignée : rien ne l'assigne sans « Assigner »
  assert.equal(peopleLines(model, added.assignees, added.charges).lines.find((l) => l.teamId === 3).assigned, false);
  const assigned = assignPerson(added, 3);
  assert.deepEqual(assigned.assignees, [1, 2, 3]);
  assert.equal(assigned.charges, draft.charges);
  assert.deepEqual(ids(peopleLines(model, assigned.assignees, assigned.charges)), [1, 2, 3]);
});

test('retirer une ligne : assignation et entrées valides retirées, octets du reste conservés', () => {
  const raw = '[ {"teamId": 2, "heures": 5.0, "x":"é"} , {"teamId":1,"heures":10},{"teamId":1}]';
  const r = removePersonLine({ assignees: [1, 2, 1], charges: raw }, 1);
  assert.deepEqual(r.assignees, [2]);
  // Entrée valide de 1 retirée ; l'entrée invalide {"teamId":1} et le texte d'origine de 2 sont conservés
  assert.equal(r.charges, '[{"teamId": 2, "heures": 5.0, "x":"é"},{"teamId":1}]');
  // Non assignée avec charge : la charge part
  assert.equal(removePersonLine({ assignees: [], charges: '[{"teamId":3,"heures":7}]' }, 3).charges, '[]');
  // Assignée sans charge : seule l'assignation part, la cellule est rendue telle quelle
  const empty = removePersonLine({ assignees: [2], charges: null }, 2);
  assert.deepEqual([empty.assignees, empty.charges], [[], null]);
  // Cellule illisible : jamais touchée
  assert.equal(removePersonLine({ assignees: [2], charges: 'oops' }, 2).charges, 'oops');
});

test('saisie d’une ligne : règles du 1 ETP, valeur affichée, charge vidée, erreurs', () => {
  const days = 14;
  const draft = { assignees: [1], charges: null };
  // 1,0 ETP sur 14 jours = 70 h, ajoutée en fin de cellule
  assert.deepEqual(lineInput(draft, 1, '1', 'etp', days), { charges: '[{"teamId":1,"heures":70}]', heures: 70 });
  // Au plus 1 ETP, ETP à une décimale, moins de 0,25 h refusé, sans dates en ETP
  assert.equal(lineInput(draft, 1, '1,5', 'etp', days).error.error, 'max');
  assert.equal(lineInput(draft, 1, '0,25', 'etp', days).error.error, 'decimale');
  assert.equal(lineInput(draft, 1, '0,1', 'heures', days).error.error, 'petit');
  assert.equal(lineInput(draft, 1, '0,5', 'etp', null).error.error, 'dates');
  assert.equal(lineInput(draft, 1, 'abc', 'heures', days).error.error, 'nombre');
  // Valeur affichée ressaisie : heures inchangées, cellule identique (10 h s'affichent 0,1 ETP)
  const ten = { assignees: [1], charges: '[{"teamId":1,"heures":10}]' };
  assert.deepEqual(lineInput(ten, 1, '0,1', 'etp', days), { charges: ten.charges, heures: 10 });
  // Charge vidée : assignée → entrée retirée (la ligne reste, charge vide) ; non assignée → erreur « vide »
  assert.deepEqual(lineInput(ten, 1, '  ', 'etp', days), { charges: '[]', heures: null });
  assert.deepEqual(lineInput(draft, 1, '', 'etp', days), { charges: null, heures: null });
  assert.equal(lineInput({ assignees: [], charges: ten.charges }, 1, '', 'etp', days).error.error, 'vide');
  // Doublon non fusionné ou cellule illisible : refus, rien n'est changé
  const dup = { assignees: [1], charges: '[{"teamId":1,"heures":2},{"teamId":1,"heures":3}]' };
  assert.equal(lineInput(dup, 1, '4', 'heures', days).error.error, 'nombre');
  assert.equal(lineInput({ assignees: [1], charges: 'oops' }, 1, '4', 'heures', days).error.error, 'nombre');
});

test('lecture : liste unique (taskPeopleRows), heures cumulées, ETP, non assignée, absente de l’équipe', () => {
  const task = {
    start: 0,
    end: 13,
    assignees: [2, 1],
    charges: [
      { personId: 3, heures: 35 },
      { personId: 1, heures: 50 },
      { personId: 1, heures: 20 },
      { personId: 99, heures: 7 },
    ],
  };
  const rows = taskPeopleRows(model, task);
  assert.deepEqual(
    rows.map((r) => [r.personId, r.assigned, r.hours, r.etp === null ? null : Math.round(r.etp * 10) / 10]),
    [
      [2, true, null, null],
      [1, true, 70, 1],
      [3, false, 35, 0.5],
      [99, false, 7, 0.1],
    ],
  );
  assert.equal(rows[3].person, null);
  // Sans dates : pas d'ETP ; taskPeople ne garde que les personnes connues, dans le même ordre
  assert.equal(taskPeopleRows(model, { ...task, start: null })[1].etp, null);
  assert.deepEqual(
    taskPeople(model, task).map((p) => p.id),
    [2, 1, 3],
  );
});
