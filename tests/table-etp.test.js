/** Colonne « Équipe (ETP) » du Tableau : pastilles par profil dans la cellule et total Σ. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { applyFilters, DEFAULT_FILTERS, DEFAULT_PREFS } from '../widget/js/core/filters.js';
import { ETP_PART_ORDER, etpParts, sortRows, tableRows, toCsv } from '../widget/js/core/table-data.js';
import { label } from '../widget/js/labels.js';
import { feuille } from './fixtures/feuille.js';

test('pastilles dans l’ordre PO, DA, DS, DE, Mgmt puis Autre ; profils nuls omis ; total formaté', () => {
  assert.deepEqual(ETP_PART_ORDER, ['PO', 'DA', 'DS', 'DE', 'Mgmt', 'Autre']);
  const r = { etp: 1.8, byRole: { DE: 0, DS: 0.5, Autre: 0.04, DA: 1, PO: 0.3, total: 1.8 } };
  assert.deepEqual(etpParts(r), {
    parts: [
      { role: 'PO', text: '0,3' },
      { role: 'DA', text: '1,0' },
      { role: 'DS', text: '0,5' },
    ],
    total: '1,8',
  });
  // Mgmt entre les profils ISD et « Autre »
  assert.deepEqual(etpParts({ etp: 0.9, byRole: { DE: 0.2, Mgmt: 0.4, Autre: 0.3 } }).parts, [
    { role: 'DE', text: '0,2' },
    { role: 'Mgmt', text: '0,4' },
    { role: 'Autre', text: '0,3' },
  ]);
  // « Autre » non nul après les profils ISD
  assert.deepEqual(etpParts({ etp: 0.7, byRole: { DE: 0.2, Autre: 0.5 } }).parts, [
    { role: 'DE', text: '0,2' },
    { role: 'Autre', text: '0,5' },
  ]);
});

test('sans ventilation : total seul ; sans ETP : rien', () => {
  assert.deepEqual(etpParts({ etp: 2, byRole: null }), { parts: [], total: '2,0' });
  assert.equal(etpParts({ etp: null, byRole: null }), null);
  assert.equal(etpParts({}), null);
  assert.equal(label('table.etp.sum', { total: '1,8' }), 'Σ 1,8');
  assert.equal(label('table.col.etp'), 'Équipe (ETP)');
});

test('données réelles : la tâche chargée a ses pastilles, le tri reste sur le total, le CSV garde le total', () => {
  const m = buildModel(feuille());
  const rows = tableRows(m, applyFilters(m, { ...DEFAULT_FILTERS }, { ...DEFAULT_PREFS }));
  const charged = rows.find((r) => r.taskId === 1002);
  // 70 h sur la capacité standard du 26 octobre au 8 novembre 2026 (57,8 h) : 1,2 ETP
  assert.deepEqual(etpParts(charged), { parts: [{ role: 'DE', text: '1,2' }], total: '1,2' });
  const sorted = sortRows(rows, 'etp', 'desc').filter((r) => r.etp !== null);
  assert.ok(sorted.every((r, i) => i === 0 || sorted[i - 1].etp >= r.etp));
  const [head, ...lines] = toCsv([charged], ['tache', 'etp']).slice(1).split('\r\n');
  assert.equal(head, 'Tâche;Équipe (ETP)');
  assert.ok(lines[0].endsWith(';1,2'));
});
