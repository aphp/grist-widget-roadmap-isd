import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import {
  isColumnCollapsed,
  kanbanColumns,
  lifecycleOrder,
  peopleDisplay,
  priorityText,
  rovingMove,
  shortName,
  toggleColumn,
} from '../widget/js/core/kanban-data.js';
import { feuille } from './fixtures/feuille.js';

const m = buildModel(feuille());

test('priorityText : un seul format « Priorité 3 »', () => {
  assert.equal(priorityText('3'), 'Priorité 3');
  assert.equal(priorityText(' 2 '), 'Priorité 2');
  assert.equal(priorityText('P0'), 'Priorité 0');
  assert.equal(priorityText('p 4'), 'Priorité 4');
  assert.equal(priorityText('Priorité 1'), 'Priorité 1');
  assert.equal(priorityText('priorite 2'), 'priorite 2');
  assert.equal(priorityText('Basse'), 'Priorité Basse');
  assert.equal(priorityText(''), '');
  assert.equal(priorityText(null), '');
  assert.equal(priorityText(undefined), '');
});

test('lifecycleOrder : cycle de vie, puis les autres dans leur ordre, « Sans statut » en dernier', () => {
  const choices = ['todo', 'inprogress', 'review', 'done', 'Pré-cadrage', 'Cadrage', 'En attente externe', 'Bloqué'];
  assert.deepEqual(lifecycleOrder([...choices, 'À cadrer', '', 'Zut']), [
    'Pré-cadrage',
    'Cadrage',
    'todo',
    'inprogress',
    'review',
    'En attente externe',
    'Bloqué',
    'done',
    'À cadrer',
    'Zut',
    '',
  ]);
  // Comparaison sans accents ni casse
  assert.deepEqual(lifecycleOrder(['done', 'BLOQUE', 'pre-cadrage']), ['pre-cadrage', 'BLOQUE', 'done']);
  assert.deepEqual(lifecycleOrder([]), []);
});

test('colonnes par statut : statuts observés hors choix ajoutés, « Sans statut » en dernier', () => {
  const tasks = new Map([
    [1000, { ...m.tasks.get(1000), status: '' }],
    [1001, { ...m.tasks.get(1001), status: 'Cadrage' }],
    [1002, { ...m.tasks.get(1002), status: 'Pré-cadrage' }],
  ]);
  const odd = { ...m, tasks, statuses: { ...m.statuses, tasks: ['todo', 'done', 'Pré-cadrage'] } };
  const cols = kanbanColumns(odd, new Set([1000, 1001, 1002]), 'status', 'title-asc');
  assert.deepEqual(
    cols.map((c) => c.key),
    ['Pré-cadrage', 'Cadrage', 'todo', 'done', ''],
  );
  assert.equal(cols.at(-1).label, 'Sans statut');
  assert.deepEqual(cols.at(-1).tasks, [1000]);
});

test('colonnes repliées : vides par défaut, choix manuel conservé', () => {
  assert.equal(isColumnCollapsed([], 'status:todo', false), false);
  assert.equal(isColumnCollapsed([], 'status:Bloqué', true), true);
  assert.equal(isColumnCollapsed(['status:todo'], 'status:todo', false), true);
  assert.equal(isColumnCollapsed(['+status:Bloqué'], 'status:Bloqué', true), false);
  // Une colonne repliée à la main reste repliée, même vide
  assert.equal(isColumnCollapsed(['status:todo'], 'status:todo', true), true);
});

test('toggleColumn : n’enregistre que l’écart à l’état par défaut', () => {
  // colonne pleine : repliée puis dépliée
  let s = toggleColumn([], 'a', false);
  assert.deepEqual(s, ['a']);
  s = toggleColumn(s, 'a', false);
  assert.deepEqual(s, []);
  // colonne vide : dépliée puis repliée
  s = toggleColumn(['x'], 'b', true);
  assert.deepEqual(s, ['x', '+b']);
  assert.equal(isColumnCollapsed(s, 'b', true), false);
  s = toggleColumn(s, 'b', true);
  assert.deepEqual(s, ['x']);
  assert.equal(isColumnCollapsed(s, 'b', true), true);
  // colonne repliée à la main devenue vide : la déplier l'ouvre
  s = toggleColumn(['c'], 'c', true);
  assert.deepEqual(s, ['+c']);
});

test('rovingMove : flèches dans la colonne, entre colonnes (lignes bornées), Début et Fin', () => {
  const counts = [3, 0, 1, 5];
  assert.deepEqual(rovingMove(counts, { col: 0, row: 0 }, 'ArrowDown'), { col: 0, row: 1 });
  assert.equal(rovingMove(counts, { col: 0, row: 2 }, 'ArrowDown'), null);
  assert.deepEqual(rovingMove(counts, { col: 0, row: 2 }, 'ArrowUp'), { col: 0, row: 1 });
  assert.equal(rovingMove(counts, { col: 0, row: 0 }, 'ArrowUp'), null);
  // la colonne sans élément est sautée ; la ligne est bornée au nombre d'éléments de la cible
  assert.deepEqual(rovingMove(counts, { col: 0, row: 2 }, 'ArrowRight'), { col: 2, row: 0 });
  assert.deepEqual(rovingMove(counts, { col: 2, row: 0 }, 'ArrowRight'), { col: 3, row: 0 });
  assert.deepEqual(rovingMove(counts, { col: 3, row: 4 }, 'ArrowLeft'), { col: 2, row: 0 });
  assert.deepEqual(rovingMove(counts, { col: 2, row: 0 }, 'ArrowLeft'), { col: 0, row: 0 });
  assert.equal(rovingMove(counts, { col: 3, row: 0 }, 'ArrowRight'), null);
  assert.equal(rovingMove(counts, { col: 0, row: 0 }, 'ArrowLeft'), null);
  assert.deepEqual(rovingMove(counts, { col: 3, row: 2 }, 'End'), { col: 3, row: 4 });
  assert.equal(rovingMove(counts, { col: 3, row: 4 }, 'End'), null);
  assert.deepEqual(rovingMove(counts, { col: 3, row: 2 }, 'Home'), { col: 3, row: 0 });
  assert.equal(rovingMove(counts, { col: 3, row: 0 }, 'Home'), null);
  assert.equal(rovingMove(counts, { col: 1, row: 0 }, 'End'), null);
  assert.equal(rovingMove(counts, { col: 0, row: 0 }, 'Enter'), null);
});

test('shortName : « Nom P. » à partir du nom en capitales ou du dernier mot', () => {
  assert.equal(shortName('Caroline GERMAIN'), 'Germain C.');
  assert.equal(shortName('Antoine MURZEAU '), 'Murzeau A.');
  assert.equal(shortName('Nora EL KHBIR'), 'El Khbir N.');
  assert.equal(shortName('Marzieh KOHANDANI-TAFRESH'), 'Kohandani-Tafresh M.');
  assert.equal(shortName('BRIDEL Sébastien'), 'Bridel S.');
  assert.equal(shortName('Caroline Germain'), 'Germain C.');
  assert.equal(shortName('élise d’ARC'), 'D’Arc É.');
  assert.equal(shortName('Prince'), 'Prince');
  assert.equal(shortName('JEAN DUPONT'), 'Dupont J.');
  assert.equal(shortName(''), '');
  assert.equal(shortName(null), '');
});

test('peopleDisplay : noms pour une ou deux personnes, initiales et « +n » au-delà', () => {
  assert.deepEqual(peopleDisplay([]), { named: true, shown: [], more: 0 });
  assert.deepEqual(peopleDisplay(['a', 'b']), { named: true, shown: ['a', 'b'], more: 0 });
  assert.deepEqual(peopleDisplay(['a', 'b', 'c']), { named: false, shown: ['a', 'b', 'c'], more: 0 });
  assert.deepEqual(peopleDisplay(['a', 'b', 'c', 'd', 'e']), { named: false, shown: ['a', 'b', 'c'], more: 2 });
});
