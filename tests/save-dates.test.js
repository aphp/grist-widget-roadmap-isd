/** Dates glissées dans le Gantt, enregistrées par le contrôleur des fiches (ui/task-editor.js, saveDates). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feuille } from './fixtures/feuille.js';
import { createFakeGrist, lookupOf } from './fixtures/fake-grist.js';
import { createGateway } from '../widget/js/core/grist-gateway.js';
import { EXPECTED_TYPES, WRITABLE, createWriter } from '../widget/js/core/grist-writer.js';
import { buildModel } from '../widget/js/core/model.js';
import { dayOfIso } from '../widget/js/core/dates.js';
import { createTaskEditor } from '../widget/js/ui/task-editor.js';

const D = 86400;
const day = dayOfIso;
const OCT1 = { start: day('2027-10-04'), end: day('2027-10-10') };
const OCT2 = { start: day('2027-10-11'), end: day('2027-10-17') };
const COLS = ['dateDebut', 'dateEcheance'];
const T = { table: 'Tasks', id: 1002 };

/** Faux Grist, writer en envoi réel, éditeur sans formulaire ouvert ; messages et rappels notés. */
function setup({ grist = {}, columns = {}, fetchRow, noWriter = false, maxDay = null } = {}) {
  const tables = feuille().tables;
  for (const [name, ops] of Object.entries(WRITABLE))
    for (const c of new Set([...ops.update, ...ops.add])) tables[name][c] ??= tables[name].id.map(() => null);
  const g = createFakeGrist(tables, grist);
  const gw = createGateway(g);
  const meta = Object.fromEntries(Object.entries(EXPECTED_TYPES).map(([k, type]) => [k, { type, isFormula: false }]));
  const writer = createWriter({
    docApi: g.docApi,
    mode: 'on',
    columns: { ...meta, ...columns },
    lookup: { ...lookupOf(g), maxDay: () => maxDay },
    timeoutMs: 40,
  });
  const out = { g, writer, toasts: [], written: [], unknown: 0, readOnly: [] };
  out.editor = createTaskEditor({
    root: { addEventListener() {}, contains: () => false, querySelector: () => null },
    chrome: {},
    getModel: () => buildModel({ tables: g.data }),
    getBase: () => null,
    getWriter: () => (noWriter ? null : writer),
    fetchRow: fetchRow ?? ((table, id) => gw.fetchRow(table, id)),
    today: () => day('2027-09-01'),
    storage: null,
    toast: { show: (text, opts = {}) => out.toasts.push({ text, ...opts }) },
    onWritten: (e) => out.written.push(e),
    onUndo() {},
    onUnknown: () => (out.unknown += 1),
    onSessionReadOnly: (r) => out.readOnly.push(r),
    timeoutMs: () => 40,
  });
  out.place = (period, charges = null) =>
    g.otherUserSets('Tasks', 1002, {
      dateDebut: D * period.start,
      dateEcheance: D * period.end,
      charges,
      assignees: ['L', 1],
    });
  return out;
}

test('saveDates : enregistré → message « Dates enregistrées » avec « Annuler », écriture notée', async () => {
  const s = setup();
  s.place(OCT1);
  assert.equal(await s.editor.saveDates(T, COLS, OCT1, OCT2), 'saved');
  assert.equal(s.written.length, 1);
  assert.match(s.toasts[0].text, /Dates enregistrées : 11 oct\. → 17 oct\./);
  assert.equal(typeof s.toasts[0].onAction, 'function');
  assert.equal(s.toasts[0].more, undefined);
});

test('saveDates : dates changées dans la Feuille → changed, message avec les dates relues, relecture, rien d’envoyé', async () => {
  const s = setup();
  s.place(OCT1);
  s.g.otherUserSets('Tasks', 1002, { dateEcheance: D * day('2027-10-12') });
  assert.equal(await s.editor.saveDates(T, COLS, OCT1, OCT2), 'changed');
  assert.match(s.toasts[0].text, /maintenant 4 oct\. → 12 oct\./);
  assert.equal(s.toasts[0].tone, 'error');
  assert.equal(s.unknown, 1);
  assert.equal(s.g.batches.length, 0);
});

test('saveDates : pas de réponse dans le délai → unknown, relecture, message', async () => {
  const s = setup({ grist: { hang: 'after' } });
  s.place(OCT1);
  assert.equal(await s.editor.saveDates(T, COLS, OCT1, OCT2), 'unknown');
  assert.equal(s.unknown, 1);
  assert.match(s.toasts[0].text, /Pas de réponse de Grist/);
});

test('saveDates : heures à recalculer mais charges non modifiables → refused:charges, rien d’envoyé', async () => {
  const s = setup({ columns: { 'Tasks.charges': { type: 'Text', isFormula: true } } });
  s.place(OCT1, '[{"teamId":1,"heures":14}]');
  const july = { start: day('2027-07-05'), end: day('2027-07-11') };
  const oct = { start: day('2027-10-04'), end: day('2027-10-10') };
  assert.equal(await s.editor.saveDates(T, COLS, oct, july), 'refused:charges');
  assert.match(s.toasts[0].text, /ne sont pas modifiables/);
  assert.equal(s.g.batches.length, 0);
});

test('saveDates : ligne disparue → missing (relecture) ; relecture impossible → reread', async () => {
  const s = setup();
  assert.equal(await s.editor.saveDates({ table: 'Tasks', id: 999 }, COLS, OCT1, OCT2), 'missing');
  assert.match(s.toasts[0].text, /supprimé dans la Feuille/);
  assert.equal(s.unknown, 1);
  const r = setup({
    fetchRow: async () => {
      throw new Error('réseau');
    },
  });
  assert.equal(await r.editor.saveDates(T, COLS, OCT1, OCT2), 'reread');
  assert.match(r.toasts[0].text, /Impossible de relire la ligne/);
});

test('saveDates : envoi en cours → busy (rien lu ni envoyé) ; sans writer → refused:off', async () => {
  let release;
  const gate = new Promise((ok) => (release = ok));
  const s = setup();
  s.place(OCT1);
  const gw = createGateway(s.g);
  const slow = setup({
    fetchRow: async (t, id) => {
      await gate;
      return gw.fetchRow(t, id);
    },
  });
  const first = slow.editor.saveDates(T, COLS, OCT1, OCT2);
  assert.equal(await slow.editor.saveDates(T, COLS, OCT1, OCT2), 'busy');
  assert.deepEqual(slow.toasts, []); // le message « en cours » est celui de l'appelant (main.js)
  release();
  await first;
  const off = setup({ noWriter: true });
  assert.equal(await off.editor.saveDates(T, COLS, OCT1, OCT2), 'refused:off');
  assert.match(off.toasts[0].text, /refusé/);
});

test('saveDates : refus du writer (date au-delà de la borne) → refused:date-max, message du refus', async () => {
  const s = setup({ maxDay: day('2028-12-31') });
  s.place(OCT1);
  const far = { start: day('2040-01-01'), end: day('2040-01-07') };
  const kind = await s.editor.saveDates(T, COLS, OCT1, far);
  assert.equal(kind, 'refused:date-max');
  assert.match(s.toasts[0].text, /refusé cette modification/);
  assert.equal(s.g.batches.length, 0);
});

test('saveDates : charges en double et capacité qui change → message de correction dans la fiche', async () => {
  const s = setup();
  s.place(OCT1, '[{"teamId":1,"heures":7},{"teamId":1,"heures":7}]');
  const july = { start: day('2027-07-05'), end: day('2027-07-11') };
  assert.equal(await s.editor.saveDates(T, COLS, OCT1, july), 'refused:charges-illisibles');
  assert.match(s.toasts[0].text, /doivent être corrigées dans la fiche/);
  assert.equal(s.g.batches.length, 0);
});

test('saveDates : jalon → « Échéance enregistrée » (une seule date)', async () => {
  const s = setup();
  s.g.otherUserSets('Tasks', 1002, { type: 'jalon', dateDebut: null, dateEcheance: D * OCT1.end, charges: null });
  const r = await s.editor.saveDates(
    T,
    ['dateEcheance'],
    { start: null, end: OCT1.end },
    { start: OCT2.end, end: OCT2.end },
  );
  assert.equal(r, 'saved');
  assert.match(s.toasts[0].text, /^Échéance enregistrée : 17 oct\.\.?$/);
});
