import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureScrolls, dataFingerprint, needsRender, restoreScrolls } from '../widget/js/core/reload-state.js';

const raw = () => ({
  tables: { Tasks: { id: [1, 2], titre: ['A', 'B'], tags: [['L', 'x'], null] }, Team: { id: [5], nom: ['P'] } },
  choices: { 'Tasks.statut': ['À faire', 'Fait'] },
  columns: { 'Tasks.titre': { type: 'Text', isFormula: false } },
  problems: [],
});

test('empreinte : identique pour les mêmes données, quel que soit l’ordre des clés', () => {
  const a = raw();
  const b = raw();
  b.tables = { Team: b.tables.Team, Tasks: { titre: ['A', 'B'], tags: [['L', 'x'], null], id: [1, 2] } };
  assert.equal(dataFingerprint(a), dataFingerprint(b));
  assert.match(dataFingerprint(a), /^\d+:[0-9a-f]+$/);
});

test('empreinte : change avec une cellule, un choix, un type de colonne ou un problème', () => {
  const base = dataFingerprint(raw());
  const cell = raw();
  cell.tables.Tasks.titre[1] = 'C';
  const order = raw();
  order.tables.Tasks.id = [2, 1];
  const choice = raw();
  choice.choices['Tasks.statut'].push('Bloqué');
  const col = raw();
  col.columns['Tasks.titre'].isFormula = true;
  const pb = raw();
  pb.problems.push({ table: 'Tasks', column: 'titre' });
  const nul = raw();
  nul.tables.Tasks.tags[1] = undefined;
  for (const r of [cell, order, choice, col, pb, nul]) assert.notEqual(dataFingerprint(r), base);
});

test('empreinte : données absentes ou partielles sans erreur', () => {
  assert.equal(dataFingerprint(null), dataFingerprint({}));
  assert.notEqual(dataFingerprint({ tables: {} }), dataFingerprint({}));
});

test('needsRender : rien à redessiner seulement si les données affichées sont les mêmes', () => {
  assert.equal(needsRender('a', 'a'), false);
  assert.equal(needsRender('a', 'b'), true);
  assert.equal(needsRender(null, 'a'), true);
  assert.equal(needsRender('a', 'a', true), true);
});

/** Faux nœuds : querySelectorAll('[data-scroll-key]') et scrollTop / scrollLeft. */
const node = (key, top = 0, left = 0) => ({ dataset: { scrollKey: key }, scrollTop: top, scrollLeft: left });
const root = (nodes) => ({ querySelectorAll: (sel) => (sel === '[data-scroll-key]' ? nodes : []) });

test('défilements : relevés par clé, clés répétées numérotées, clé vide ignorée', () => {
  const nodes = [node('gantt', 120, 300), node('vbars', 0, 40), node('vbars', 5, 0), node('')];
  assert.deepEqual(captureScrolls(root(nodes)), {
    gantt: { top: 120, left: 300 },
    vbars: { top: 0, left: 40 },
    'vbars#2': { top: 5, left: 0 },
  });
  assert.deepEqual(captureScrolls(null), {});
  const attrOnly = { dataset: {}, getAttribute: () => 'plan', scrollTop: 3, scrollLeft: 0 };
  assert.deepEqual(captureScrolls(root([attrOnly])), { plan: { top: 3, left: 0 } });
});

test('défilements : rendus aux zones du même nom après un rendu, zones nouvelles laissées telles quelles', () => {
  const saved = captureScrolls(root([node('gantt', 120, 300), node('vbars', 0, 40), node('vbars', 5, 0)]));
  const fresh = [node('gantt'), node('vbars'), node('vbars'), node('nouvelle', 7, 8)];
  const done = restoreScrolls(root(fresh), saved);
  assert.equal(done.length, 3);
  assert.deepEqual(
    fresh.map((n) => [n.scrollTop, n.scrollLeft]),
    [
      [120, 300],
      [0, 40],
      [5, 0],
      [7, 8],
    ],
  );
  assert.deepEqual(restoreScrolls(root(fresh), null), []);
});

test('défilements : une zone déjà à la bonne position n’est pas réécrite', () => {
  let writes = 0;
  const n = {
    dataset: { scrollKey: 'k' },
    get scrollTop() {
      return 10;
    },
    set scrollTop(_) {
      writes++;
    },
    get scrollLeft() {
      return 0;
    },
    set scrollLeft(_) {
      writes++;
    },
  };
  restoreScrolls(root([n]), { k: { top: 10, left: 0 } });
  assert.equal(writes, 0);
});

test('défilements : une clé répétée est numérotée dans l’ordre du document (d’où des clés uniques par graphique)', () => {
  // Deux graphiques sous la même clé : si le premier disparaît, le second hérite de sa position
  const saved = captureScrolls(root([node('vbars', 0, 40), node('vbars', 0, 90)]));
  const second = node('vbars');
  restoreScrolls(root([second]), saved);
  assert.equal(second.scrollLeft, 40);
  // Clés propres à chaque graphique : chacun retrouve la sienne
  const own = captureScrolls(root([node('vbars-status', 0, 40), node('vbars-priority', 0, 90)]));
  const priority = node('vbars-priority');
  restoreScrolls(root([priority]), own);
  assert.equal(priority.scrollLeft, 90);
});

test('needsRender : même données, autre jour (empreinte suivie du jour) : redessiner', () => {
  const fp = dataFingerprint(raw());
  assert.equal(needsRender(`${fp}|20381`, `${fp}|20381`), false);
  assert.equal(needsRender(`${fp}|20381`, `${fp}|20382`), true);
});
