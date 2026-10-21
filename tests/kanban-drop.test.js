import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dropChanges,
  dropColumns,
  dropTargets,
  hasDropTarget,
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

test('dropTargets chantier (lot D) : tout refusé « kind » ; tâche inconnue : rien', () => {
  const m = mk([task(1)]);
  assert.deepEqual(dropTargets(m, 1, 'chantier', [col('C1')]).get('C1'), { ok: false, reason: 'kind' });
  assert.equal(dropTargets(m, 99, 'status', [col('done')]).size, 0);
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
  assert.deepEqual(dropChanges(m, 2, 'chantier', 'C1', 0), { error: 'kind' });
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
