/** Statut depuis la carte et la ligne (P-UX-6) : droit d'afficher, entrées, clavier du menu, focus après coup. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { dayOfIso } from '../widget/js/core/dates.js';
import {
  canQuickStatus,
  focusOrder,
  isRepeatedChoice,
  isStatusShortcut,
  limitToReveal,
  menuMove,
  menuStartIndex,
  statusMenuItems,
} from '../widget/js/core/quick-status.js';
import { myTasksHtml } from '../widget/js/views/my-tasks.js';
import { feuille } from './fixtures/feuille.js';
import { createFakeGrist, lookupOf } from './fixtures/fake-grist.js';
import { createGateway } from '../widget/js/core/grist-gateway.js';
import { EXPECTED_TYPES, WRITABLE, createWriter } from '../widget/js/core/grist-writer.js';
import { createTaskEditor } from '../widget/js/ui/task-editor.js';

const model = buildModel(feuille());
const ON = { mode: 'on', canEdit: true, reason: 'ok' };
const writerOf = (mode, ok = true) => ({ mode, can: (t, c) => ({ ok: ok && t === 'Tasks' && c === 'statut' }) });

test('canQuickStatus : édition ouverte, session modifiable, tâche ISD et colonne statut permise', () => {
  assert.equal(canQuickStatus(model, 1001, ON, writerOf('on')), true);
  // Mode essai : le contrôle s'affiche (le writer note sans envoyer)
  assert.equal(canQuickStatus(model, 1001, { ...ON, mode: 'dry' }, writerOf('dry')), true);
  // Lecture seule : édition coupée, compte lecteur, writer absent ou coupé
  assert.equal(canQuickStatus(model, 1001, { mode: 'off', canEdit: false, reason: 'off' }, writerOf('off')), false);
  assert.equal(canQuickStatus(model, 1001, { mode: 'on', canEdit: false, reason: 'viewer' }, writerOf('on')), false);
  assert.equal(canQuickStatus(model, 1001, ON, null), false);
  assert.equal(canQuickStatus(model, 1001, ON, writerOf('off')), false);
  assert.equal(canQuickStatus(model, 1001, null, writerOf('on')), false);
  assert.equal(canQuickStatus(null, 1001, ON, writerOf('on')), false);
  // Colonne statut refusée par le writer, tâche hors périmètre ISD, tâche inconnue
  assert.equal(canQuickStatus(model, 1001, ON, writerOf('on', false)), false);
  assert.equal(canQuickStatus(model, 4001, ON, writerOf('on')), false);
  assert.equal(canQuickStatus(model, 4242, ON, writerOf('on')), false);
});

test('statusMenuItems : statuts de la Feuille, statut actuel coché, valeur ancienne ajoutée, vide jamais proposé', () => {
  const statuses = ['todo', 'inprogress', 'review', 'done'];
  assert.deepEqual(statusMenuItems(statuses, 'review'), [
    { value: 'todo', current: false },
    { value: 'inprogress', current: false },
    { value: 'review', current: true },
    { value: 'done', current: false },
  ]);
  assert.deepEqual(
    statusMenuItems(statuses, 'Ancien').map((x) => [x.value, x.current]),
    [
      ['todo', false],
      ['inprogress', false],
      ['review', false],
      ['done', false],
      ['Ancien', true],
    ],
  );
  assert.deepEqual(
    statusMenuItems(['todo', '', null], '').map((x) => x.value),
    ['todo'],
  );
  assert.deepEqual(statusMenuItems(undefined, null), []);
  // La liste d'origine n'est pas modifiée
  const src = ['todo'];
  statusMenuItems(src, 'x');
  assert.deepEqual(src, ['todo']);
});

test('menuMove : flèches en boucle, Début et Fin ; aucune autre touche ne déplace (ni n’écrit)', () => {
  assert.equal(menuMove(4, 0, 'ArrowDown'), 1);
  assert.equal(menuMove(4, 3, 'ArrowDown'), 0);
  assert.equal(menuMove(4, 0, 'ArrowUp'), 3);
  assert.equal(menuMove(4, 2, 'ArrowUp'), 1);
  assert.equal(menuMove(4, -1, 'ArrowDown'), 0);
  assert.equal(menuMove(4, -1, 'ArrowUp'), 3);
  assert.equal(menuMove(4, 2, 'Home'), 0);
  assert.equal(menuMove(4, 1, 'End'), 3);
  for (const k of ['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'a']) assert.equal(menuMove(4, 1, k), null);
  assert.equal(menuMove(0, -1, 'ArrowDown'), null);
});

test('isStatusShortcut : « s », Maj+F10 et touche Menu ; jamais avec Ctrl, Alt ou Méta', () => {
  assert.equal(isStatusShortcut({ key: 's' }), true);
  assert.equal(isStatusShortcut({ key: 'S' }), true);
  assert.equal(isStatusShortcut({ key: 'F10', shiftKey: true }), true);
  assert.equal(isStatusShortcut({ key: 'ContextMenu' }), true);
  assert.equal(isStatusShortcut({ key: 'F10' }), false);
  assert.equal(isStatusShortcut({ key: 's', shiftKey: true }), false);
  assert.equal(isStatusShortcut({ key: 's', ctrlKey: true }), false);
  assert.equal(isStatusShortcut({ key: 's', metaKey: true }), false);
  assert.equal(isStatusShortcut({ key: 'F10', shiftKey: true, altKey: true }), false);
  for (const k of ['ArrowDown', 'Enter', ' ', 'd']) assert.equal(isStatusShortcut({ key: k }), false);
});

test('focusOrder : la tâche, puis la voisine suivante et la précédente, en s’éloignant', () => {
  assert.deepEqual(focusOrder(['a', 'b', 'c', 'd'], 'b'), ['b', 'c', 'a', 'd']);
  assert.deepEqual(focusOrder(['a', 'b', 'c'], 'c'), ['c', 'b', 'a']);
  assert.deepEqual(focusOrder(['a'], 'a'), ['a']);
  assert.deepEqual(focusOrder([], 'x'), ['x']);
  assert.deepEqual(focusOrder(['a', 'b'], 'x'), ['x']);
});

test('limitToReveal : la page qui contient la tâche, jamais moins que la limite affichée', () => {
  assert.equal(limitToReveal(40, 10, 40), 40);
  assert.equal(limitToReveal(40, 40, 40), 80);
  assert.equal(limitToReveal(40, 95, 40), 120);
  assert.equal(limitToReveal(80, 50, 40), 80);
  assert.equal(limitToReveal(100, -1, 100), 100);
});

test('Mes tâches : en lecture seule, aucun contrôle ; en édition, un bouton-menu par tâche modifiable', () => {
  const today = dayOfIso('2026-10-20');
  const ro = myTasksHtml(model, { me: 5, today }).toString();
  assert.doesNotMatch(ro, /data-qs-open/);
  assert.match(ro, /class="mt__status"/);
  const ids = [...ro.matchAll(/data-task="(\d+)"/g)].map((x) => Number(x[1]));
  assert.ok(ids.length > 0);
  const allowed = new Set(ids.slice(0, 1));
  const out = myTasksHtml(model, { me: 5, today, qs: { can: (id) => allowed.has(id) } }).toString();
  const qs = [...out.matchAll(/data-qs-open="(\d+)" data-qs-focus="(\d+)"/g)];
  assert.deepEqual(
    qs.map((x) => Number(x[1])),
    [...allowed],
  );
  assert.equal(qs[0][1], qs[0][2]);
  assert.match(out, /class="mt__item mt__item--qs"/);
  assert.match(out, /aria-haspopup="menu" aria-expanded="false" aria-label="[^"]+, changer le statut de « [^"]+ »"/);
  // La ligne reste le bouton qui ouvre la fiche ; le statut n'y est plus répété
  assert.equal([...out.matchAll(/data-task="/g)].length, ids.length);
  assert.equal([...out.matchAll(/class="mt__status"/g)].length, ids.length - 1);
});

test('menuStartIndex : statut actuel focalisé ; sans statut coché, position neutre (-1)', () => {
  assert.equal(menuStartIndex(statusMenuItems(['todo', 'review'], 'review')), 1);
  assert.equal(menuStartIndex(statusMenuItems(['todo', 'review'], '')), -1);
  assert.equal(menuStartIndex(statusMenuItems(['todo', 'review'], null)), -1);
  assert.equal(menuStartIndex([]), -1);
});

test('isRepeatedChoice : Entrée ou Espace maintenues ignorées ; appui franc et autres touches laissés', () => {
  assert.equal(isRepeatedChoice({ key: 'Enter', repeat: true }), true);
  assert.equal(isRepeatedChoice({ key: ' ', repeat: true }), true);
  assert.equal(isRepeatedChoice({ key: 'Spacebar', repeat: true }), true);
  assert.equal(isRepeatedChoice({ key: 'Enter', repeat: false }), false);
  assert.equal(isRepeatedChoice({ key: 'Enter' }), false);
  assert.equal(isRepeatedChoice({ key: 'ArrowDown', repeat: true }), false);
});

/** Faux Grist, writer (envoi réel ou essai), contrôleur des fiches sans formulaire ouvert ; messages notés. */
function editorSetup({ mode = 'on', columns = {}, fetchRow, getBase = () => null } = {}) {
  const tables = feuille().tables;
  for (const [name, ops] of Object.entries(WRITABLE))
    for (const c of new Set([...ops.update, ...ops.add])) tables[name][c] ??= tables[name].id.map(() => null);
  const g = createFakeGrist(tables, {});
  const gw = createGateway(g);
  const meta = Object.fromEntries(Object.entries(EXPECTED_TYPES).map(([k, type]) => [k, { type, isFormula: false }]));
  const writer = createWriter({ docApi: g.docApi, mode, columns: { ...meta, ...columns }, lookup: lookupOf(g) });
  const out = { g, writer, toasts: [], written: [], undos: 0 };
  out.editor = createTaskEditor({
    root: { addEventListener() {}, contains: () => false, querySelector: () => null },
    chrome: {},
    getModel: () => buildModel({ tables: g.data }),
    getBase,
    getWriter: () => writer,
    fetchRow: fetchRow ?? ((table, id) => gw.fetchRow(table, id)),
    today: () => dayOfIso('2026-10-19'),
    storage: null,
    toast: { show: (text, opts = {}) => out.toasts.push({ text, ...opts }) },
    onWritten: (e) => out.written.push(e),
    onUndo: () => (out.undos += 1),
    onUnknown() {},
    onSessionReadOnly() {},
    timeoutMs: () => 40,
  });
  return out;
}
const T2000 = { table: 'Tasks', id: 2000 };

test('quickPriority : valeur écrite seule, message « Priorité : … » avec « Annuler » (chemin commun)', async () => {
  const s = editorSetup();
  assert.equal(await s.editor.quickPriority(T2000, '1'), 'saved');
  assert.deepEqual(s.g.batches.at(-1), [['UpdateRecord', 'Tasks', 2000, { priorite: '1' }]]);
  assert.equal(s.written.length, 1);
  assert.equal(s.toasts[0].text, 'Priorité : Priorité 1.');
  s.toasts[0].onAction();
  assert.equal(s.undos, 1);
  assert.equal(await s.editor.quickPriority(T2000, '1'), 'nothing', 'déjà la valeur relue : rien envoyé');
  assert.equal(s.g.batches.length, 1);
  assert.equal(await s.editor.quickPriority(T2000, ''), 'saved');
  assert.equal(s.toasts.at(-1).text, 'Priorité : Sans priorité.');
});

test('quickPriority : priorité héritée → message qui dit que la tâche a maintenant sa propre priorité', async () => {
  const s = editorSetup();
  assert.equal(await s.editor.quickPriority({ table: 'Tasks', id: 2001 }, '3', { inherited: true }), 'saved');
  assert.match(s.toasts[0].text, /Priorité 3/);
  assert.match(s.toasts[0].text, /sa propre priorité/);
});

test('quickPriority : relue sur la ligne de la Feuille, pas sur la base locale', async () => {
  const s = editorSetup({ getBase: () => ({ priorite: '' }) });
  s.g.otherUserSets('Tasks', 2000, { priorite: '2' });
  assert.equal(await s.editor.quickPriority(T2000, '2'), 'nothing');
  assert.equal(s.g.batches.length, 0);
});

test('quickPriority : colonne non modifiable → refused:colonne, rien lu ni envoyé ; busy ; relecture impossible ; essai', async () => {
  const off = editorSetup({ columns: { 'Tasks.priorite': { type: 'Choice', isFormula: true } } });
  const kind = await off.editor.quickPriority(T2000, '1');
  assert.match(kind, /^refused:/);
  assert.match(off.toasts[0].text, /refusé/);
  assert.equal(off.g.batches.length, 0);
  let release;
  const gate = new Promise((ok) => (release = ok));
  const slow = editorSetup({
    fetchRow: async () => {
      await gate;
      return null;
    },
  });
  const first = slow.editor.quickPriority(T2000, '1');
  assert.equal(await slow.editor.quickPriority(T2000, '2'), 'busy');
  assert.equal(await slow.editor.quickStatus(T2000, 'done'), 'busy', 'même garde que le statut rapide');
  release();
  assert.equal(await first, 'missing');
  const broken = editorSetup({
    fetchRow: async () => {
      throw new Error('réseau');
    },
  });
  assert.equal(await broken.editor.quickPriority(T2000, '1'), 'reread');
  assert.match(broken.toasts[0].text, /Impossible de relire/);
  const dry = editorSetup({ mode: 'dry-run', getBase: () => ({ priorite: '3' }) });
  assert.equal(await dry.editor.quickPriority(T2000, '1'), 'saved');
  assert.match(dry.toasts[0].text, /Mode essai/);
  assert.equal(dry.g.batches.length, 0);
});
