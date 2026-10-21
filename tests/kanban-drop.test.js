import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chantierDropTarget,
  chantierProjectChoice,
  columnName,
  dropChanges,
  dropColumns,
  dropTargets,
  hasDropTarget,
  isApplied,
  pendingModel,
  priorityMenuItems,
  priorityValueFor,
} from '../widget/js/core/kanban-drop.js';

const task = (id, o = {}) => ({
  id,
  status: 'todo',
  priorite: '',
  closed: null,
  chantierId: null,
  parentId: null,
  projectId: null,
  ...o,
});
function mk(tasks, { chantiers = [], projects = [], prio = ['1', 'Priorité 1', '2'] } = {}) {
  return {
    tasks: new Map(tasks.map((t) => [t.id, t])),
    chantiers: new Map(chantiers.map((c) => [c.id, c])),
    projects: new Map(projects.map((p) => [p.id, p])),
    statuses: { tasks: ['todo', 'inprogress', 'done'] },
    choices: { 'Tasks.priorite': prio },
  };
}
const col = (key) => ({ key, label: key, tasks: [] });

test('priorityValueFor : valeur déclarée du libellé, la plus fréquente, sinon null', () => {
  const m = mk([task(1, { priorite: 'Priorité 1' }), task(2, { priorite: 'Priorité 1' }), task(3, { priorite: '1' })]);
  assert.equal(priorityValueFor(m, 'Priorité 1'), 'Priorité 1');
  assert.equal(priorityValueFor(m, 'Priorité 2'), '2');
  assert.equal(priorityValueFor(m, 'P5'), null);
  assert.equal(priorityValueFor(mk([task(1)]), 'Priorité 1'), '1', 'égalité : la première déclarée');
  assert.equal(priorityValueFor({ ...m, choices: {} }, 'Priorité 1'), null);
});

test('dropTargets statut : same, empty-status, undeclared, ok', () => {
  const m = mk([task(1)]);
  const t = dropTargets(m, 1, 'status', ['todo', 'done', '', 'ancien'].map(col));
  assert.deepEqual(t.get('todo'), { ok: false, reason: 'same' });
  assert.deepEqual(t.get('done'), { ok: true });
  assert.deepEqual(t.get(''), { ok: false, reason: 'empty-status' });
  assert.deepEqual(t.get('ancien'), { ok: false, reason: 'undeclared' });
});

test('dropTargets priorité : déclarée, non déclarée, same, hérité', () => {
  const m = mk([task(1, { priorite: '1', chantierId: 5 })], { chantiers: [{ id: 5, priorite: '2' }] });
  const t = dropTargets(m, 1, 'priority', ['Priorité 1', 'Priorité 2', 'P5', ''].map(col));
  assert.deepEqual(t.get('Priorité 1'), { ok: false, reason: 'same' });
  assert.deepEqual(t.get('Priorité 2'), { ok: true });
  assert.deepEqual(t.get('P5'), { ok: false, reason: 'undeclared' });
  assert.deepEqual(t.get(''), { ok: false, reason: 'inherited' });
  const free = mk([task(2, { priorite: '1' })]);
  assert.deepEqual(dropTargets(free, 2, 'priority', [col('')]).get(''), { ok: true });
  const proj = mk([task(3, { projectId: 9 })], { projects: [{ id: 9, priorite: '1' }] });
  assert.deepEqual(dropTargets(proj, 3, 'priority', [col('')]).get(''), { ok: false, reason: 'inherited' });
  assert.deepEqual(dropTargets(proj, 3, 'priority', [col('Priorité 2')]).get('Priorité 2'), { ok: true });
  const none = mk([task(4)]);
  assert.deepEqual(dropTargets(none, 4, 'priority', [col('')]).get(''), { ok: false, reason: 'same' });
});

/** Projets 10 et 20 du périmètre, 40 hors périmètre ; chantier 6 partagé par 10 et 20. */
function mkChantiers() {
  return mk(
    [
      task(1, { chantierId: 5, projectId: 10 }),
      task(2, { parentId: 1, chantierId: 5, projectId: 10 }),
      task(3, { chantierId: 6, projectId: 20 }),
      task(4, { projectId: 10 }),
      task(9, { chantierId: 8, projectId: 40 }),
    ],
    {
      chantiers: [
        { id: 5, title: 'Socle', projectIds: [10] },
        { id: 6, title: 'Partagé', projectIds: [10, 20] },
        { id: 7, title: 'Autre', projectIds: [20] },
        { id: 8, title: 'Ailleurs', projectIds: [40] },
      ],
      projects: [
        { id: 10, inScope: true },
        { id: 20, inScope: true },
        { id: 40, inScope: false },
      ],
    },
  );
}
const chantierCols = ['C5', 'C6', 'C7', 'C8', 'C99', ''].map(col);

test('dropTargets chantier : same, ok, hors périmètre, sans chantier, chantier inconnu', () => {
  const t = dropTargets(mkChantiers(), 1, 'chantier', chantierCols);
  assert.deepEqual(t.get('C5'), { ok: false, reason: 'same' });
  assert.deepEqual(t.get('C6'), { ok: true });
  assert.deepEqual(t.get('C7'), { ok: true });
  assert.deepEqual(t.get('C8'), { ok: false, reason: 'scope' });
  assert.deepEqual(t.get('C99'), { ok: false, reason: 'chantier' });
  assert.deepEqual(t.get(''), { ok: false, reason: 'no-chantier' });
  // Tâche sans chantier : sa colonne est « (sans chantier) »
  const free = dropTargets(mkChantiers(), 4, 'chantier', chantierCols);
  assert.deepEqual(free.get(''), { ok: false, reason: 'same' });
  assert.deepEqual(free.get('C5'), { ok: true });
  assert.equal(dropTargets(mkChantiers(), 99, 'status', [col('done')]).size, 0);
});

test('dropTargets chantier : une sous-tâche est refusée partout (elle suit sa tâche)', () => {
  const t = dropTargets(mkChantiers(), 2, 'chantier', chantierCols);
  for (const key of ['C5', 'C6', 'C7', 'C8', 'C99', '']) assert.deepEqual(t.get(key), { ok: false, reason: 'subtask' });
});

test('chantierDropTarget : un projet, projet actuel porté, sinon le premier projet du périmètre', () => {
  const m = mkChantiers();
  assert.equal(chantierDropTarget(m, 1, 7), '7:20', 'un seul projet');
  assert.equal(chantierDropTarget(m, 1, 6), '6:10', 'le chantier porte le projet actuel');
  assert.equal(chantierDropTarget(m, 3, 5), '5:10');
  assert.equal(chantierDropTarget(m, 9, 6), '6:10', 'deux projets : le premier du périmètre, à confirmer');
  const outFirst = { ...m, chantiers: new Map(m.chantiers).set(6, { id: 6, title: 'Partagé', projectIds: [40, 20] }) };
  assert.equal(chantierDropTarget(outFirst, 1, 6), '6:20', 'projet hors périmètre sauté');
  assert.equal(chantierDropTarget(m, 1, 99), '');
  assert.equal(chantierDropTarget(m, 99, 6), '');
});

test('chantierProjectChoice : plusieurs projets du périmètre possibles, aucun n’est celui de la tâche', () => {
  const m = mkChantiers();
  assert.equal(chantierProjectChoice(m, 9, 6), true);
  assert.equal(chantierProjectChoice(m, 1, 6), false, 'projet actuel porté');
  assert.equal(chantierProjectChoice(m, 1, 7), false, 'un seul projet');
  const oneIn = { ...m, chantiers: new Map(m.chantiers).set(6, { id: 6, projectIds: [40, 20] }) };
  assert.equal(chantierProjectChoice(oneIn, 1, 6), false, 'un seul projet du périmètre');
  assert.equal(chantierProjectChoice(m, 99, 6), false);
  assert.equal(chantierProjectChoice(m, 1, 99), false);
});

test('dropChanges chantier : cible de la fenêtre, rien à écrire directement, refus', () => {
  const m = mkChantiers();
  assert.deepEqual(dropChanges(m, 1, 'chantier', 'C6', 0), {
    changes: {},
    inherited: false,
    target: '6:10',
    ask: false,
  });
  assert.deepEqual(
    dropChanges(m, 9, 'chantier', 'C6', 0),
    { changes: {}, inherited: false, target: '6:10', ask: true },
    'deux projets sans le projet actuel : la fenêtre demande de confirmer le projet',
  );
  assert.deepEqual(dropChanges(m, 4, 'chantier', 'C6', 0), {
    changes: {},
    inherited: false,
    target: '6:10',
    ask: false,
  });
  assert.deepEqual(dropChanges(m, 1, 'chantier', 'C5', 0), { changes: {}, inherited: false });
  assert.deepEqual(dropChanges(m, 2, 'chantier', 'C6', 0), { error: 'subtask' });
  assert.deepEqual(dropChanges(m, 1, 'chantier', '', 0), { error: 'no-chantier' });
  assert.deepEqual(dropChanges(m, 1, 'chantier', 'C8', 0), { error: 'scope' });
});

test('dropColumns chantier : chantiers du périmètre seulement', () => {
  assert.deepEqual([...dropColumns(mkChantiers(), 'chantier', chantierCols)], ['C5', 'C6', 'C7']);
});

test('dropChanges statut : clôture posée, gardée à la réouverture, refus', () => {
  const m = mk([task(1), task(2, { status: 'done', closed: 20000 })]);
  assert.deepEqual(dropChanges(m, 1, 'status', 'done', 20500), {
    changes: { statut: 'done', dateCloture: 20500 },
    inherited: false,
  });
  assert.deepEqual(dropChanges(m, 2, 'status', 'todo', 20500), { changes: { statut: 'todo' }, inherited: false });
  assert.deepEqual(dropChanges(m, 1, 'status', '', 20500), { error: 'empty-status' });
  assert.deepEqual(dropChanges(m, 1, 'status', 'todo', 20500), { changes: {}, inherited: false });
  assert.deepEqual(dropChanges(m, 99, 'status', 'done', 1), { error: 'missing' });
});

test('dropChanges priorité : valeur déclarée, vide permis, inherited', () => {
  const m = mk([task(1, { chantierId: 5 }), task(2, { priorite: '1' })], { chantiers: [{ id: 5, priorite: '2' }] });
  assert.deepEqual(dropChanges(m, 1, 'priority', 'Priorité 1', 0), { changes: { priorite: '1' }, inherited: true });
  assert.deepEqual(dropChanges(m, 2, 'priority', 'Priorité 2', 0), { changes: { priorite: '2' }, inherited: false });
  assert.deepEqual(dropChanges(m, 2, 'priority', '', 0), { changes: { priorite: '' }, inherited: false });
  assert.deepEqual(dropChanges(m, 1, 'priority', '', 0), { error: 'inherited' });
  assert.deepEqual(dropChanges(m, 2, 'priority', 'P5', 0), { error: 'undeclared' });
  assert.deepEqual(dropChanges(m, 2, 'priority', 'Priorité 1', 0), { changes: {}, inherited: false });
});

test('dropTargets priorité : « Sans priorité » refusé quand la tâche a sa priorité ET une priorité en amont', () => {
  const m = mk([task(1, { priorite: '1', chantierId: 5 })], { chantiers: [{ id: 5, priorite: '2' }] });
  assert.deepEqual(dropTargets(m, 1, 'priority', [col('')]).get(''), { ok: false, reason: 'inherited' });
  assert.deepEqual(dropChanges(m, 1, 'priority', '', 0), { error: 'inherited' });
});

test('dropTargets priorité : sous-tâche qui hérite du chantier par sa tâche parente', () => {
  const m = mk([task(1, { chantierId: 5 }), task(2, { parentId: 1 })], { chantiers: [{ id: 5, priorite: '2' }] });
  const t = dropTargets(m, 2, 'priority', ['Priorité 2', 'Priorité 1', ''].map(col));
  assert.deepEqual(t.get('Priorité 2'), { ok: false, reason: 'same' });
  assert.deepEqual(t.get('Priorité 1'), { ok: true });
  assert.deepEqual(t.get(''), { ok: false, reason: 'inherited' });
  assert.deepEqual(dropChanges(m, 2, 'priority', 'Priorité 1', 0), { changes: { priorite: '1' }, inherited: true });
});

test('dropChanges statut : tâche sans statut déposée sur « Sans statut » → same, rien à écrire', () => {
  const m = mk([task(1, { status: '' })]);
  assert.deepEqual(dropTargets(m, 1, 'status', [col('')]).get(''), { ok: false, reason: 'same' });
  assert.deepEqual(dropChanges(m, 1, 'status', '', 0), { changes: {}, inherited: false });
});

test('priorityValueFor : une seule valeur du libellé → sans parcourir les tâches', () => {
  const m = mk([]);
  m.tasks = { values: () => assert.fail('parcours des tâches') };
  assert.equal(priorityValueFor(m, 'Priorité 2'), '2');
});

test('hasDropTarget : vrai exactement quand dropTargets donne une colonne permise', () => {
  const m = mk(
    [
      task(1),
      task(2, { status: 'done' }),
      task(3, { priorite: '1', chantierId: 5 }),
      task(4, { chantierId: 5 }),
      task(5, { status: '' }),
      task(6, { priorite: '1' }),
    ],
    { chantiers: [{ id: 5, priorite: '2' }] },
  );
  const groups = {
    status: ['todo', 'inprogress', 'done', '', 'ancien'].map(col),
    priority: ['Priorité 1', 'Priorité 2', 'P5', ''].map(col),
    chantier: [col('C5'), col('')],
  };
  for (const [group, columns] of Object.entries(groups)) {
    const open = dropColumns(m, group, columns);
    for (const id of [1, 2, 3, 4, 5, 6, 99]) {
      const any = [...dropTargets(m, id, group, columns).values()].some((v) => v.ok);
      assert.equal(hasDropTarget(m, id, group, open), any, `${group} ${id}`);
    }
  }
  const mc = mkChantiers();
  const open = dropColumns(mc, 'chantier', chantierCols);
  for (const id of [1, 2, 3, 4, 9, 99]) {
    const any = [...dropTargets(mc, id, 'chantier', chantierCols).values()].some((v) => v.ok);
    assert.equal(hasDropTarget(mc, id, 'chantier', open), any, `chantier ${id}`);
  }
  // Seule colonne : celle de la carte → rien ; priorité héritée et seule « Sans priorité » → rien
  assert.equal(hasDropTarget(m, 1, 'status', dropColumns(m, 'status', [col('todo')])), false);
  assert.equal(hasDropTarget(m, 4, 'priority', dropColumns(m, 'priority', [col('Priorité 2'), col('')])), false);
  assert.equal(hasDropTarget(m, 6, 'priority', dropColumns(m, 'priority', [col('Priorité 1'), col('')])), true);
});

test('priorityMenuItems : libellés déclarés une fois, valeur actuelle cochée, « Sans priorité » en dernier', () => {
  const m = mk([task(1, { priorite: '2' }), task(2, { chantierId: 5 }), task(3, { priorite: 'P9' })], {
    chantiers: [{ id: 5, priorite: '1' }],
  });
  assert.deepEqual(priorityMenuItems(m, 1), [
    { value: 'Priorité 1', text: 'Priorité 1', current: false, ok: true, reason: '' },
    { value: 'Priorité 2', text: 'Priorité 2', current: true, ok: false, reason: 'same' },
    { value: '', text: 'Sans priorité', current: false, ok: true, reason: '' },
  ]);
  // Priorité héritée du chantier : cochée, « Sans priorité » refusé (raison inherited)
  const inherited = priorityMenuItems(m, 2);
  assert.deepEqual(
    inherited.map((it) => [it.value, it.current, it.reason]),
    [
      ['Priorité 1', true, 'same'],
      ['Priorité 2', false, ''],
      ['', false, 'inherited'],
    ],
  );
  // Valeur non déclarée de la tâche : ajoutée, cochée
  assert.deepEqual(
    priorityMenuItems(m, 3).map((it) => [it.value, it.current]),
    [
      ['Priorité 1', false],
      ['Priorité 2', false],
      ['Priorité 9', true],
      ['', false],
    ],
  );
  // Sans priorité : « Sans priorité » coché
  assert.equal(priorityMenuItems(mk([task(4)]), 4).at(-1).current, true);
  assert.deepEqual(priorityMenuItems(m, 99), []);
});

test('pendingModel : la tâche porte le statut ou la priorité déposés, le reste du modèle inchangé', () => {
  const m = mk([task(1), task(2)]);
  const p = pendingModel(m, 1, { statut: 'done', dateCloture: 20500 });
  assert.equal(p.tasks.get(1).status, 'done');
  assert.equal(p.tasks.get(1).closed, 20500);
  assert.equal(p.tasks.get(2), m.tasks.get(2));
  assert.equal(m.tasks.get(1).status, 'todo', 'modèle d’origine intact');
  assert.equal(p.statuses, m.statuses);
  assert.equal(pendingModel(m, 2, { priorite: '2' }).tasks.get(2).priorite, '2');
  assert.equal(pendingModel(m, 2, { priorite: '' }).tasks.get(2).priorite, '');
  assert.equal(pendingModel(m, 99, { statut: 'done' }), m);
});

test('columnName : statut nommé, libellé de priorité, « Sans priorité »', () => {
  assert.equal(columnName('status', 'review'), 'En revue');
  assert.equal(columnName('priority', 'Priorité 2'), 'Priorité 2');
  assert.equal(columnName('priority', ''), 'Sans priorité');
  assert.equal(columnName('chantier', 'C6', mkChantiers()), 'Partagé');
  assert.equal(columnName('chantier', '', mkChantiers()), '(sans chantier)');
  assert.equal(columnName('chantier', 'C99', mkChantiers()), 'C99');
});

test('isApplied : le modèle porte déjà les valeurs déposées (correction locale reçue)', () => {
  const m = mk([task(1), task(2, { priorite: '2' })]);
  assert.equal(isApplied(m, 1, { statut: 'todo' }), true);
  assert.equal(isApplied(m, 1, { statut: 'done', dateCloture: 5 }), false);
  assert.equal(
    isApplied(pendingModel(m, 1, { statut: 'done', dateCloture: 5 }), 1, { statut: 'done', dateCloture: 5 }),
    true,
  );
  assert.equal(isApplied(m, 2, { priorite: '2' }), true);
  assert.equal(isApplied(m, 2, { priorite: '' }), false);
  assert.equal(isApplied(m, 99, { statut: 'todo' }), false);
});
