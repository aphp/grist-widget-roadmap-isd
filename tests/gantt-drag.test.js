/** Gantt : pas, décalages, bornes et droit de glisser (core/gantt-drag.js). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { dayOfIso, isoOfDay } from '../widget/js/core/dates.js';
import {
  clampShift,
  dragContext,
  dragSummary,
  dragTarget,
  keyMode,
  movedDates,
  periodOf,
  reattachDrag,
  shiftDay,
  snapUnit,
  stepsFromPixels,
  summaryText,
} from '../widget/js/core/gantt-drag.js';
import { expandableKeys, ganttRows, sortTreeByDate } from '../widget/js/core/gantt-data.js';
import { etpToHours } from '../widget/js/core/capacity.js';
import { periodFte, roundHours } from '../widget/js/core/charges-edit.js';
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

test('stepsFromPixels : arrondi symétrique, jamais -0, échelle invalide', () => {
  assert.equal(stepsFromPixels(5, 10, 'day', 0), stepsFromPixels(-5, 10, 'day', 0) * -1); // 0,5 j -> 1 / -1
  assert.equal(stepsFromPixels(-5, 10, 'day', 0), -1);
  assert.equal(stepsFromPixels(35, 10, 'week', 0), 1);
  assert.equal(stepsFromPixels(-35, 10, 'week', 0), -1);
  for (const u of ['day', 'week', 'month']) assert.ok(Object.is(stepsFromPixels(-0.1, 10, u, 0), 0), u);
  assert.ok(Object.is(stepsFromPixels(0, 10, 'day', 0), 0));
  for (const px of [0, -3, NaN, Infinity]) assert.equal(stepsFromPixels(50, px, 'day', 0), 0);
  assert.equal(stepsFromPixels(NaN, 5, 'week', 0), 0);
});

test('clampShift : borne du 31/12 de l’année suivante', () => {
  const max = d('2027-12-31');
  assert.equal(clampShift(d('2027-12-20'), d('2027-12-28'), 10, 'day', { max }), 3);
  assert.equal(clampShift(d('2027-12-20'), d('2027-12-28'), -10, 'day', { max }), -10);
  assert.equal(clampShift(d('2027-12-31'), d('2027-12-31'), 2, 'week', { max }), 0);
  assert.equal(clampShift(2, 5, -10, 'day', { max }), -1);
  assert.equal(clampShift(d('2027-12-20'), d('2027-12-28'), 0, 'day', { max }), 0);
  assert.equal(clampShift(10, 12, -20, 'day', { min: 5, max }), -5);
  const origin = d('2027-12-15');
  assert.equal(clampShift(origin, origin + 3, 1, 'month', { max }), 0);
  assert.equal(clampShift(d('2027-11-15'), d('2027-11-20'), 3, 'month', { max }), 1);
  assert.equal(clampShift(d('1970-01-20'), d('1970-01-25'), -2, 'month', { min: 1, max }), 0);
  assert.equal(clampShift(d('1970-03-20'), d('1970-03-25'), -5, 'month', { min: 1, max }), -2);
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

  assert.equal(reason(task(1001, { start: 30, end: 20 })), 'order');
  const jalon = { ...model, tasks: new Map(model.tasks).set(1001, { ...model.tasks.get(1001), type: 'jalon' }) };
  assert.equal(dragTarget(jalon, task(1001), ctx).milestone, true);
  assert.deepEqual(dragTarget(jalon, task(1001), ctx).cols, ['dateDebut', 'dateEcheance']);
  // Jalon à la seule échéance : glissable sur l'échéance seule ; seul début ou aucune date : non
  assert.deepEqual(dragTarget(jalon, task(1001, { start: null, end: 20 }), ctx), {
    ok: true,
    table: 'Tasks',
    id: 1001,
    cols: ['dateEcheance'],
    milestone: true,
  });
  assert.equal(dragTarget(jalon, task(1001, { start: 20, end: null }), ctx).reason, 'nodates');
  assert.equal(dragTarget(jalon, task(1001, { start: null, end: null }), ctx).reason, 'nodates');
  assert.equal(
    dragTarget(jalon, task(1001, { start: null, end: 20 }), { ...ctx, edit: { mode: 'off', canEdit: false } }).reason,
    'edit',
  );

  const chantier = { kind: 'chantier', ref: { table: 'Chantiers', id: 100 }, start: 10, end: 20 };
  assert.deepEqual(dragTarget(model, chantier, ctx), {
    ok: true,
    table: 'Chantiers',
    id: 100,
    cols: ['Debut', 'Fin'],
    milestone: false,
  });

  assert.equal(dragTarget(model, { ...chantier, ref: { table: 'Chantiers', id: 400 } }, ctx).reason, 'scope');
});

// ---------- dragSummary et summaryText ----------
const task = (id, extra = {}) => ({
  id,
  start: null,
  end: null,
  done: false,
  childIds: [],
  chantierId: null,
  parentId: null,
  charges: [],
  ...extra,
});
const modelOf = (...tasks) => ({ tasks: new Map(tasks.map((t) => [t.id, t])), estimation: { ids: new Set() } });
const T = (id) => ({ table: 'Tasks', id });
const span = (a, b) => ({ start: d(a), end: d(b) });
const hoursOf = (a, b, etp = 1) => roundHours(etpToHours(etp, periodFte(d(a), d(b))));

test('dragSummary : déplacement simple à capacité égale, heures non recalculées', () => {
  const m = modelOf(task(1, { start: d('2026-10-05'), end: d('2026-10-16'), charges: [{ personId: 7, heures: 40 }] }));
  const s = dragSummary(m, T(1), span('2026-10-05', '2026-10-16'), span('2026-10-19', '2026-10-30'), d('2026-10-01'));
  assert.equal(s.delta, 14);
  assert.equal(s.days, 12);
  assert.equal(s.hours, null);
  assert.deepEqual(s.keptOver, []);
  assert.equal(
    dragSummary(modelOf(task(2)), T(2), span('2026-10-05', '2026-10-16'), span('2026-10-19', '2026-10-30'), 0).hours,
    null,
  );
});

test('dragSummary : de juin à juillet à durée égale, heures recalculées à ETP gardé', () => {
  const from = span('2027-06-07', '2027-06-27');
  const to = span('2027-07-05', '2027-07-25');
  const before = hoursOf('2027-06-07', '2027-06-27');
  const m = modelOf(task(1, { charges: [{ personId: 7, heures: before }] }));
  const s = dragSummary(m, T(1), from, to, 0);
  assert.deepEqual(s.hours, { from: before, to: hoursOf('2027-07-05', '2027-07-25') });
  assert.ok(s.hours.to < s.hours.from);
});

test('dragSummary : tâche étirée, heures proportionnelles', () => {
  const m = modelOf(task(1, { charges: [{ personId: 7, heures: hoursOf('2026-11-02', '2026-11-15', 0.5) }] }));
  const s = dragSummary(m, T(1), span('2026-11-02', '2026-11-15'), span('2026-11-02', '2026-11-29'), 0);
  assert.deepEqual(s.hours, {
    from: hoursOf('2026-11-02', '2026-11-15', 0.5),
    to: hoursOf('2026-11-02', '2026-11-29', 0.5),
  });
});

test('dragSummary : ancienne charge à 2 ETP raccourcie, laissée telle quelle', () => {
  const m = modelOf(task(1, { charges: [{ personId: 7, heures: hoursOf('2026-11-02', '2026-11-29', 2) }] }));
  const s = dragSummary(m, T(1), span('2026-11-02', '2026-11-29'), span('2026-11-02', '2026-11-15'), 0);
  assert.deepEqual(s.keptOver, [7]);
  assert.equal(s.hours.from, s.hours.to);
});

test('dragSummary : chantier dont une tâche sort, sous-tâches directes', () => {
  const m = modelOf(
    task(1, { chantierId: 5, start: d('2026-11-02'), end: d('2026-11-06') }),
    task(2, { chantierId: 5, start: d('2026-11-20'), end: d('2026-11-30') }),
    task(3, { chantierId: 5, parentId: 2, start: d('2026-01-01'), end: d('2026-01-02') }),
    task(4, { chantierId: 5 }),
    task(10, { childIds: [11, 12, 13] }),
    task(11, { parentId: 10, start: d('2026-11-02'), end: d('2026-11-06') }),
    task(12, { parentId: 10, start: d('2026-11-02'), end: d('2026-12-30') }),
    task(13, { parentId: 10 }),
  );
  const ch = dragSummary(
    m,
    { table: 'Chantiers', id: 5 },
    span('2026-11-01', '2026-11-30'),
    span('2026-11-01', '2026-11-10'),
    0,
  );
  assert.equal(ch.childrenOutside, 1);
  assert.equal(ch.hours, null);
  const sub = dragSummary(m, T(10), span('2026-11-01', '2026-11-30'), span('2026-11-01', '2026-11-30'), 0);
  assert.equal(sub.childrenOutside, 1);
  assert.equal(
    dragSummary(m, T(404), span('2026-11-01', '2026-11-30'), span('2026-11-01', '2026-11-30'), 0).childrenOutside,
    0,
  );
});

test('dragSummary : tâche en retard déplacée après aujourd’hui', () => {
  const late = task(1, { start: d('2026-10-01'), end: d('2026-10-10') });
  const today = d('2026-10-21');
  const m = modelOf(late, { ...late, id: 2, done: true });
  assert.equal(
    dragSummary(m, T(1), span('2026-10-01', '2026-10-10'), span('2026-10-20', '2026-10-29'), today).lateCleared,
    true,
  );
  assert.equal(
    dragSummary(m, T(1), span('2026-10-01', '2026-10-10'), span('2026-10-05', '2026-10-14'), today).lateCleared,
    false,
  );
  assert.equal(
    dragSummary(m, T(2), span('2026-10-01', '2026-10-10'), span('2026-10-20', '2026-10-29'), today).lateCleared,
    false,
  );
});

test('summaryText : lignes de l’infobulle, alertes avec ⚠ et texte', () => {
  const base = {
    start: d('2026-11-17'),
    end: d('2026-12-12'),
    days: 26,
    delta: 14,
    hours: null,
    keptOver: [],
    childrenOutside: 0,
    childKind: 'sous-tache',
    lateCleared: false,
  };
  assert.deepEqual(summaryText(base, 'move'), ['17 nov. → 12 déc. 2026 (26 j)', '+14 j']);
  assert.deepEqual(summaryText({ ...base, delta: -3 }, 'move')[1], '−3 j');
  assert.deepEqual(summaryText({ ...base, delta: 0 }, 'move'), ['17 nov. → 12 déc. 2026 (26 j)']);
  assert.deepEqual(summaryText(base, 'end'), ['17 nov. → 12 déc. 2026 (26 j)']);
  const full = summaryText(
    { ...base, hours: { from: 80, to: 42.5 }, keptOver: [7], childrenOutside: 2, lateCleared: true },
    'move',
  );
  assert.deepEqual(full.slice(2), [
    'Heures 80 h → 42,5 h (ETP conservé)',
    '⚠ 1 charge laissée telle quelle (au-dessus de la borne)',
    '2 sous-tâches hors de la nouvelle période',
    'Ne sera plus en retard',
  ]);
  assert.ok(summaryText({ ...base, keptOver: [1, 2] }, 'move')[2].startsWith('⚠ 2 charges'));
  assert.equal(
    summaryText({ ...base, childrenOutside: 1, childKind: 'tache' }, 'move')[2],
    '1 tâche hors de la nouvelle période',
  );
  assert.ok(
    summaryText({ ...base, start: d('2026-12-20'), end: d('2027-01-05') }, 'move')[0].startsWith(
      '20 déc. 2026 → 5 janv.',
    ),
  );
});

test('dragSummary : personne estimation à 2 ETP raccourcie, hors keptOver', () => {
  const m = modelOf(task(1, { charges: [{ personId: 7, heures: hoursOf('2026-11-02', '2026-11-29', 2) }] }));
  m.estimation.ids.add(7);
  const s = dragSummary(m, T(1), span('2026-11-02', '2026-11-29'), span('2026-11-02', '2026-11-15'), 0);
  assert.deepEqual(s.keptOver, []);
  assert.equal(s.hours.to, hoursOf('2026-11-02', '2026-11-15', 2));
});

test('dragSummary : une personne recalculée, une laissée telle quelle', () => {
  const m = modelOf(
    task(1, {
      charges: [
        { personId: 7, heures: hoursOf('2026-11-02', '2026-11-29', 1) },
        { personId: 8, heures: hoursOf('2026-11-02', '2026-11-29', 2) },
      ],
    }),
  );
  const s = dragSummary(m, T(1), span('2026-11-02', '2026-11-29'), span('2026-11-02', '2026-11-15'), 0);
  assert.deepEqual(s.keptOver, [8]);
  assert.equal(s.hours.from, hoursOf('2026-11-02', '2026-11-29', 3));
  assert.equal(s.hours.to, hoursOf('2026-11-02', '2026-11-15', 1) + hoursOf('2026-11-02', '2026-11-29', 2));
});

test('dragContext : réutilisé, mêmes résultats qu’un appel neuf ; même période, même objet', () => {
  const m = modelOf(
    task(1, {
      end: d('2026-10-10'),
      childIds: [2],
      charges: [{ personId: 7, heures: hoursOf('2026-11-02', '2026-11-29', 1) }],
    }),
    task(2, { parentId: 1, start: d('2026-11-20'), end: d('2026-11-28') }),
  );
  const from = span('2026-11-02', '2026-11-29');
  const ctx = dragContext(m, T(1), from);
  const tos = [span('2026-11-02', '2026-11-15'), span('2026-11-09', '2026-12-06'), span('2026-11-02', '2026-11-15')];
  for (const to of tos) assert.deepEqual(dragSummary(m, T(1), from, to, 5, ctx), dragSummary(m, T(1), from, to, 5));
  const a = dragSummary(m, T(1), from, tos[0], 5, ctx);
  assert.equal(dragSummary(m, T(1), from, { ...tos[0] }, 5, ctx), a);
  assert.notEqual(dragSummary(m, T(1), from, tos[1], 5, ctx), a);
});

// ---------- reattachDrag ----------
test('reattachDrag : ligne retrouvée par sa clé à un autre index après un dépliage', () => {
  const tree = sortTreeByDate(buildModel(feuille()).tree);
  const all = expandableKeys(tree);
  const open = ganttRows(tree, new Set(all));
  const before = open.findLastIndex((r) => r.node.kind === 'tache' && r.node.start !== null && r.node.end !== null);
  const row = open[before];
  const gesture = { key: row.key, seen: { start: row.node.start, end: row.node.end } };
  assert.deepEqual(reattachDrag(gesture, open), { ok: true, index: before });
  // ligne repliée au-dessus, hors des ancêtres : celle qui précède dont le sous-arbre se ferme avant la ligne
  const above = open.findIndex(
    (x, i) => i < before && x.hasChildren && open.slice(i + 1, before + 1).some((y) => y.depth <= x.depth),
  );
  assert.ok(above >= 0, 'jeu de test : une ligne dépliée au-dessus');
  const rows = ganttRows(tree, new Set(all.filter((k) => k !== open[above].key)));
  const again = reattachDrag(gesture, rows);
  assert.equal(again.ok, true);
  assert.equal(
    rows[again.index],
    rows.find((r) => r.key === row.key),
  );
  assert.ok(again.index < before);
});

test('reattachDrag : ligne disparue → gone ; dates relues différentes → changed', () => {
  const node = { kind: 'tache', start: 10, end: 20 };
  const rows = [
    { key: 'a', node: { kind: 'projet' } },
    { key: 't1', node },
  ];
  const g = { key: 't1', seen: { start: 10, end: 20 } };
  assert.deepEqual(reattachDrag(g, rows), { ok: true, index: 1 });
  assert.deepEqual(reattachDrag(g, rows.slice(0, 1)), { ok: false, reason: 'gone' });
  assert.deepEqual(reattachDrag(g, []), { ok: false, reason: 'gone' });
  assert.deepEqual(reattachDrag(g, [{ key: 't1', node: { ...node, end: 21 } }]), { ok: false, reason: 'changed' });
  assert.deepEqual(reattachDrag(g, [{ key: 't1', node: { ...node, start: 9 } }]), { ok: false, reason: 'changed' });
  assert.deepEqual(reattachDrag(g, [{ key: 't1', node: { ...node, start: null } }]), {
    ok: false,
    reason: 'changed',
  });
});

test('periodOf : période d’origine, début = fin = échéance pour un jalon à une date', () => {
  assert.deepEqual(periodOf({ start: 5, end: 9 }), { start: 5, end: 9 });
  assert.deepEqual(periodOf({ start: null, end: 9 }), { start: 9, end: 9 });
  assert.deepEqual(movedDates(9, 9, 'week', 1), { start: 16, end: 16 });
  assert.equal(clampShift(9, 9, 3, 'day', { max: 10 }), 1);
});

test('reattachDrag : jalon à la seule échéance', () => {
  const g = { key: 'j', seen: { start: null, end: 9 } };
  assert.deepEqual(reattachDrag(g, [{ key: 'j', node: { start: null, end: 9 } }]), { ok: true, index: 0 });
  assert.equal(reattachDrag(g, [{ key: 'j', node: { start: 9, end: 9 } }]).reason, 'changed');
});

// ---------- keyMode (mode clavier « D ») ----------
const keyState = (over = {}) => ({
  target: { ok: true, table: 'Tasks', id: 1, cols: ['dateDebut', 'dateEcheance'], milestone: false },
  seen: { start: d('2026-11-02'), end: d('2026-11-06') },
  now: { start: d('2026-11-02'), end: d('2026-11-06') },
  edge: 'move',
  unit: 'week',
  max: d('2027-12-31'),
  ...over,
});
const iso2 = (p) => [isoOfDay(p.start), isoOfDay(p.end)];

test('keyMode : flèches d’un pas de l’échelle, Maj d’un jour, durée gardée', () => {
  let r = keyMode(keyState(), { key: 'ArrowRight', shiftKey: false });
  assert.equal(r.action, 'announce');
  assert.deepEqual(iso2(r.state.now), ['2026-11-09', '2026-11-13']);
  r = keyMode(r.state, { key: 'ArrowLeft', shiftKey: true });
  assert.deepEqual(iso2(r.state.now), ['2026-11-08', '2026-11-12']);
  assert.deepEqual(iso2(keyMode(keyState({ unit: 'day' }), { key: 'ArrowLeft' }).state.now), [
    '2026-11-01',
    '2026-11-05',
  ]);
  const m = keyMode(keyState({ unit: 'month' }), { key: 'ArrowRight' });
  assert.deepEqual(iso2(m.state.now), ['2026-12-02', '2026-12-06']);
  // l'état d'origine n'est pas modifié
  assert.deepEqual(iso2(keyState().now), ['2026-11-02', '2026-11-06']);
});

test('keyMode : Retour arrière remet les dates vues, Entrée enregistre, Échap annule, Tab reste sur move', () => {
  const moved = keyMode(keyState(), { key: 'ArrowRight' }).state;
  const back = keyMode(moved, { key: 'Backspace' });
  assert.equal(back.action, 'announce');
  assert.deepEqual(back.state.now, keyState().seen);
  assert.equal(keyMode(moved, { key: 'Enter' }).action, 'save');
  assert.equal(keyMode(moved, { key: 'Escape' }).action, 'cancel');
  const tab = keyMode(moved, { key: 'Tab', shiftKey: true });
  assert.deepEqual([tab.action, tab.state.edge], ['none', 'move']);
  assert.equal(keyMode(moved, { key: 'x' }).action, 'none');
});

test('keyMode : jalon à la seule échéance, borne du 31/12 de l’année suivante', () => {
  const ms = keyState({
    target: { ok: true, table: 'Tasks', id: 1, cols: ['dateEcheance'], milestone: true },
    seen: { start: null, end: d('2027-12-27') },
    now: { start: d('2027-12-27'), end: d('2027-12-27') },
  });
  const r = keyMode(ms, { key: 'ArrowRight' });
  assert.equal(r.action, 'announce');
  assert.equal(r.state.limit, true);
  assert.deepEqual(r.state.now, ms.now);
  const day1 = keyMode({ ...ms, unit: 'day' }, { key: 'ArrowRight' });
  assert.deepEqual(iso2(day1.state.now), ['2027-12-28', '2027-12-28']);
  assert.equal(day1.state.limit, false);
  assert.deepEqual(iso2(keyMode(day1.state, { key: 'Backspace' }).state.now), ['2027-12-27', '2027-12-27']);
});
