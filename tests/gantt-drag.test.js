/** Gantt : pas, décalages, bornes et droit de glisser (core/gantt-drag.js). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { dayOfIso, isoOfDay } from '../widget/js/core/dates.js';
import {
  clampShift,
  dragTarget,
  movedDates,
  shiftDay,
  snapUnit,
  stepsFromPixels,
} from '../widget/js/core/gantt-drag.js';
import { feuille } from './fixtures/feuille.js';

const d = dayOfIso;

test('snapUnit', () => {
  assert.deepEqual(
    ['week', 'month', 'year', '2y'].map((s) => snapUnit(s, false)),
    ['day', 'week', 'week', 'month'],
  );
  assert.equal(snapUnit('2y', true), 'day');
});

test('shiftDay : fins de mois, bissextile, passage d’année', () => {
  assert.equal(isoOfDay(shiftDay(d('2027-01-31'), 'month', 1)), '2027-02-28');
  assert.equal(isoOfDay(shiftDay(d('2028-01-31'), 'month', 1)), '2028-02-29');
  assert.equal(isoOfDay(shiftDay(d('2026-12-15'), 'month', 1)), '2027-01-15');
  assert.equal(isoOfDay(shiftDay(d('2026-03-31'), 'month', -1)), '2026-02-28');
  assert.equal(isoOfDay(shiftDay(d('2026-01-15'), 'month', -2)), '2025-11-15');
  assert.equal(isoOfDay(shiftDay(d('2026-10-24'), 'week', 1)), '2026-10-31');
  assert.equal(isoOfDay(shiftDay(d('2026-10-24'), 'day', -3)), '2026-10-21');
});

test('movedDates garde la durée et le jour de la semaine', () => {
  const r = movedDates(d('2026-11-03'), d('2026-11-06'), 'week', 2);
  assert.deepEqual([isoOfDay(r.start), isoOfDay(r.end)], ['2026-11-17', '2026-11-20']);
  const m = movedDates(d('2027-01-31'), d('2027-02-09'), 'month', 1);
  assert.deepEqual([isoOfDay(m.start), isoOfDay(m.end)], ['2027-02-28', '2027-03-09']);
});

test('stepsFromPixels aux quatre échelles', () => {
  assert.equal(stepsFromPixels(23, 11, 'day', 0), 2);
  assert.equal(stepsFromPixels(-20, 5, 'week', 0), -1);
  assert.equal(stepsFromPixels(3, 5, 'week', 0), 0);
  assert.equal(stepsFromPixels(40, 1.2, 'month', d('2027-01-31')), 1);
  assert.equal(stepsFromPixels(0, 1.2, 'month', d('2027-01-31')), 0);
  assert.equal(stepsFromPixels(-70, 1.2, 'month', d('2027-03-31')), -2);
});

test('clampShift : borne du 31/12 de l’année suivante', () => {
  const max = d('2027-12-31');
  assert.equal(clampShift(d('2027-12-20'), d('2027-12-28'), 10, 'day', { max }), 3);
  assert.equal(clampShift(d('2027-12-20'), d('2027-12-28'), -10, 'day', { max }), -10);
  assert.equal(clampShift(d('2027-12-31'), d('2027-12-31'), 2, 'week', { max }), 0);
  assert.equal(clampShift(2, 5, -10, 'day', { max }), -1);
  assert.equal(clampShift(d('2027-12-20'), d('2027-12-28'), 0, 'day', { max }), 0);
});

test('dragTarget : chaque condition', () => {
  const model = buildModel(feuille());
  const ON = { mode: 'on', canEdit: true, reason: 'ok' };
  const writer = { can: () => ({ ok: true }) };
  const ctx = { edit: ON, writer, narrow: false };
  const task = (id, extra = {}) => {
    const t = model.tasks.get(id);
    return { kind: 'tache', ref: { table: 'Tasks', id }, taskId: id, start: t.start, end: t.end, ...extra };
  };
  const reason = (node, over = {}) => dragTarget(model, node, { ...ctx, ...over }).reason;

  assert.deepEqual(dragTarget(model, task(1001), ctx), {
    ok: true,
    table: 'Tasks',
    id: 1001,
    cols: ['dateDebut', 'dateEcheance'],
    milestone: false,
  });
  assert.equal(dragTarget(model, task(1001, { kind: 'sous-tache' }), ctx).ok, true);
  assert.equal(reason(task(1001), { narrow: true }), 'list');
  assert.equal(reason(task(1001, { kind: 'projet' })), 'kind');
  assert.equal(reason(task(1001, { kind: 'categorie' })), 'kind');
  assert.equal(reason({ kind: 'chantier', ref: null, start: null, end: null }), 'virtual');
  assert.equal(reason(task(1001, { end: null })), 'nodates');
  assert.equal(reason(task(1001, { start: null })), 'nodates');
  assert.equal(reason(task(1001, { start: null, end: null, span: { start: 5, end: 9 } })), 'deduced');
  assert.equal(reason(task(1001, { start: null, end: null })), 'nodates');
  assert.equal(reason(task(1001), { edit: { mode: 'off', canEdit: false, reason: 'off' } }), 'edit');
  assert.equal(reason(task(4001, { start: 10, end: 12 })), 'scope');
  assert.equal(reason(task(1001), { writer: { can: (t, c) => ({ ok: c !== 'dateEcheance' }) } }), 'column');
  assert.equal(reason(task(1001), { writer: null }), 'column');

  const jalon = { ...model, tasks: new Map(model.tasks).set(1001, { ...model.tasks.get(1001), type: 'jalon' }) };
  assert.equal(dragTarget(jalon, task(1001), ctx).milestone, true);

  const chantier = { kind: 'chantier', ref: { table: 'Chantiers', id: 100 }, start: 10, end: 20 };
  assert.deepEqual(dragTarget(model, chantier, ctx), {
    ok: true,
    table: 'Chantiers',
    id: 100,
    cols: ['Debut', 'Fin'],
    milestone: false,
  });
});
