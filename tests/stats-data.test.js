import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { applyFilters, DEFAULT_FILTERS, DEFAULT_PREFS } from '../widget/js/core/filters.js';
import {
  ISSUE_KINDS,
  countBy,
  dataQuality,
  delays,
  timeline,
  todoItem,
  visibleProjectIds,
} from '../widget/js/core/stats-data.js';
import { dayOfIso } from '../widget/js/core/dates.js';
import { feuille } from './fixtures/feuille.js';

const m = buildModel(feuille());
const view = applyFilters(m, DEFAULT_FILTERS, DEFAULT_PREFS);
const ids = [...view.taskIds];
const q = (kind) => dataQuality(m, ids).find((r) => r.kind === kind);

test('une anomalie charge-sans-dates : la tâche 2001', () => {
  assert.deepEqual(q('charge-sans-dates').taskIds, [2001]);
});
test('la tâche 2010 n’est pas « sans charge »', () => {
  assert.ok(!q('isd-sans-charge')?.taskIds.includes(2010));
});
test('anomalies restreintes aux tâches visibles', () => {
  assert.deepEqual(
    dataQuality(m, [1000]).map((r) => r.kind),
    ['sans-dates'],
  );
  assert.deepEqual(dataQuality(m, []), []);
  assert.ok(dataQuality(m, ids).every((r) => r.taskIds.every((i) => view.taskIds.has(i))));
});
test('tâches sans dates et dates incohérentes', () => {
  assert.ok(q('sans-dates').taskIds.includes(1000));
  assert.deepEqual(q('dates-incoherentes').taskIds, [3000]);
});
test('tâche ISD sans charge : seulement les tâches non terminées', () => {
  assert.equal(q('isd-sans-charge'), undefined);
  const m2 = buildModel(feuille());
  m2.tasks.get(1001).done = false;
  assert.deepEqual(dataQuality(m2, ids).find((r) => r.kind === 'isd-sans-charge').taskIds, [1001]);
  assert.ok(!q('sans-dates')?.taskIds.includes(2010));
});
test('countBy statut : ordre du modèle, total = tâches', () => {
  const r = countBy(m, ids, 'status');
  assert.equal(
    r.reduce((s, x) => s + x.value, 0),
    ids.length,
  );
  assert.equal(r[0].label, 'À faire');
});
test('countBy priorité : sans priorité en dernier', () => {
  const r = countBy(m, ids, 'priority');
  assert.equal(
    r.reduce((s, x) => s + x.value, 0),
    ids.length,
  );
  assert.equal(r.at(-1).label, 'Sans priorité');
});
test('countBy priorité : libellé « Priorité n » (format unique)', () => {
  const r = countBy(m, ids, 'priority').filter((x) => x.key !== '');
  assert.ok(r.length > 0);
  for (const x of r) assert.match(x.label, /^Priorité /);
});
test('countBy personne : ISD seulement, tri décroissant', () => {
  const r = countBy(m, ids, 'person');
  assert.ok(r.length > 0);
  assert.ok(r.every((x, i) => i === 0 || r[i - 1].value >= x.value));
});
test('chronologie : 12 derniers mois jusqu’au mois courant, sans mois futurs', () => {
  const t = timeline(m, ids, dayOfIso('2026-12-15'));
  assert.equal(t.length, 12);
  assert.equal(t[0].month, '2026-01');
  assert.equal(t.at(-1).month, '2026-12');
  assert.equal(
    t.reduce((s, x) => s + x.started, 0),
    4,
  );
  // Mois courant = octobre 2026 : novembre et décembre (futurs) sont exclus
  const oct = timeline(m, ids, dayOfIso('2026-10-19'));
  assert.deepEqual([oct[0].month, oct.at(-1).month], ['2025-11', '2026-10']);
  assert.ok(oct.reduce((s, x) => s + x.started, 0) < 4);
});
test('chronologie : dates hors fenêtre ignorées (2029, 2030)', () => {
  const m2 = buildModel(feuille());
  m2.tasks.get(1002).start = dayOfIso('2029-05-02');
  m2.tasks.get(1002).closed = dayOfIso('2030-01-10');
  const t = timeline(m2, [1002], dayOfIso('2026-12-15'));
  assert.deepEqual(t, []);
  const later = timeline(m2, [1002], dayOfIso('2030-03-01'));
  assert.deepEqual([later[0].month, later.at(-1).month], ['2029-04', '2030-03']);
  assert.equal(later.find((x) => x.month === '2030-01').closed, 1);
  assert.equal(later.find((x) => x.month === '2029-05').started, 1);
});
test('chronologie vide sans dates', () => assert.deepEqual(timeline(m, [1000], dayOfIso('2026-12-15')), []));
test('valeurs toutes nulles : ni NaN ni division par zéro', () => {
  assert.equal(barPercent(0, 0), 0);
  assert.equal(barPercent(Number.NaN, 5), 0);
  assert.equal(barPercent(5, Number.NaN), 0);
  assert.deepEqual(
    delays(m, [1000]).buckets.map((b) => b.value),
    [0, 0, 0, 0, 0],
  );
  assert.equal(delays(m, [1000]).mean, null);
  assert.deepEqual(topN([], 15), { shown: [], hidden: 0 });
});
test('délais : écart clôture − échéance', () => {
  const m2 = buildModel(feuille());
  m2.tasks.get(1001).closed = m2.tasks.get(1001).end + 3;
  m2.tasks.get(1002).closed = m2.tasks.get(1002).end - 2;
  const d = delays(m2, [1001, 1002, 1000]);
  assert.equal(d.count, 2);
  assert.equal(d.mean, 0.5);
  assert.equal(d.buckets.find((b) => b.key === 'w1').value, 1);
  assert.equal(d.buckets.find((b) => b.key === 'early').value, 1);
  assert.equal(delays(m, ids).mean, null);
  assert.ok(dayOfIso('2026-01-01') > 0);
});

import { visibleChantierIds } from '../widget/js/core/stats-data.js';

test('chantiers sans responsable : seulement les chantiers visibles', () => {
  const sans = m.issues.filter((i) => i.kind === 'chantier-sans-responsable').map((i) => i.chantierId);
  assert.ok(sans.length > 0);
  const row = dataQuality(m, ids, [sans[0]]).find((r) => r.kind === 'chantier-sans-responsable');
  assert.deepEqual(
    row.items.map((i) => [i.table, i.id]),
    [['Chantiers', sans[0]]],
  );
  assert.ok(!dataQuality(m, ids, []).some((r) => r.kind === 'chantier-sans-responsable'));
  assert.ok(!dataQuality(m, ids, [999999]).some((r) => r.kind === 'chantier-sans-responsable'));
});
test('visibleChantierIds : chantiers de l’arbre filtré, sans doublon', () => {
  const c = visibleChantierIds(view.tree);
  assert.equal(new Set(c).size, c.length);
  assert.ok(c.every((id) => m.chantiers.has(id)));
});

test('plus de cas « tâche de produit de données sans chantier » : rangée sous « (sans chantier) »', () => {
  assert.ok(!ISSUE_KINDS.includes('tache-sans-chantier'));
  assert.ok(!dataQuality(m, ids).some((r) => r.kind === 'tache-sans-chantier'));
  assert.ok(view.taskIds.has(1500));
});

import { barPercent, priorityTones, statusTone, topN } from '../widget/js/core/stats-data.js';

test('countBy : chaque ligne porte sa clé (statut, priorité, personne)', () => {
  assert.equal(countBy(m, ids, 'status')[0].key, 'todo');
  assert.equal(countBy(m, ids, 'priority').at(-1).key, '');
  assert.ok(countBy(m, ids, 'person').every((r) => m.people.has(Number(r.key))));
});
test('statusTone : statuts connus, sinon « other »', () => {
  assert.deepEqual(['todo', 'inprogress', 'review', 'done', 'Bloqué', ''].map(statusTone), [
    'todo',
    'inprogress',
    'review',
    'done',
    'other',
    'other',
  ]);
});
test('priorityTones : rampe dans l’ordre, plafonnée, « none » sans priorité', () => {
  const rows = ['1', '2', '3', '4', '5', ''].map((key) => ({ key }));
  assert.deepEqual(priorityTones(rows), ['prio-1', 'prio-2', 'prio-3', 'prio-4', 'prio-4', 'none']);
  assert.deepEqual(priorityTones(countBy(m, ids, 'priority')).at(-1), 'none');
  assert.deepEqual(priorityTones([]), []);
});
test('topN : premières lignes et nombre masqué', () => {
  assert.deepEqual(topN([1, 2, 3], 2), { shown: [1, 2], hidden: 1 });
  assert.deepEqual(topN([1], 15), { shown: [1], hidden: 0 });
});
test('barPercent : proportion du maximum, minimum visible, bornes', () => {
  assert.equal(barPercent(5, 10), 50);
  assert.equal(barPercent(1, 1000), 1);
  assert.equal(barPercent(0, 10), 0);
  assert.equal(barPercent(3, 0), 0);
  assert.equal(barPercent(20, 10), 100);
});

import { QUALITY_KINDS, qualityRows } from '../widget/js/core/stats-data.js';

test('qualityRows : toutes les anomalies, vides comprises, dans l’ordre', () => {
  const rows = qualityRows(dataQuality(m, ids));
  assert.deepEqual(
    rows.map((r) => r.kind),
    [...QUALITY_KINDS],
  );
  assert.deepEqual(rows.find((r) => r.kind === 'charge-sans-dates').taskIds, [2001]);
  assert.equal(rows.find((r) => r.kind === 'isd-sans-charge').items.length, 0);
  assert.ok(rows.every((r) => r.label && !r.label.startsWith('stats.')));
});

test('todoItem : titre, niveau, emplacement sans catégorie, fiche ouvrable', () => {
  const t = todoItem(m, { table: 'Tasks', id: 1002 });
  assert.equal(t.level, 'sous-tache');
  assert.equal(t.openable, true);
  assert.equal(t.context.split(' › ').length, 3); // projet › chantier › tâche parente
  const c = todoItem(m, { table: 'Chantiers', id: [...m.chantiers.keys()][0] });
  assert.equal(c.level, 'chantier');
  assert.equal(c.context.split(' › ').length, 1);
  const p = todoItem(m, { table: 'Projects', id: [...m.projects.keys()][0] });
  assert.deepEqual([p.level, p.context], ['projet', '']);
  const gone = todoItem(m, { table: 'Tasks', id: 987654 });
  assert.deepEqual([gone.openable, gone.level, gone.title], [false, null, '(sans titre)']);
});

test('dataQuality : éléments enrichis (niveau, emplacement) et projets sans responsable', () => {
  const rows = dataQuality(m, ids, visibleChantierIds(view.tree), visibleProjectIds(view.tree));
  for (const r of rows) for (const it of r.items) assert.ok(it.openable && it.level, `${r.kind} ${it.id}`);
  const m2 = buildModel(feuille());
  const pid = visibleProjectIds(view.tree)[0];
  m2.projects.get(pid).responsable = null;
  const row = dataQuality(m2, ids, [], [pid, pid, 999999]).find((r) => r.kind === 'projet-sans-responsable');
  assert.deepEqual(
    row.items.map((i) => [i.table, i.id, i.level]),
    [['Projects', pid, 'projet']],
  );
  assert.equal(new Set(visibleProjectIds(view.tree)).size, visibleProjectIds(view.tree).length);
});
