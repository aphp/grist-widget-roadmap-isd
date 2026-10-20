/** Carte « Contrôle qualité des données » : total dans l'en-tête, repliée par défaut, état retenu dans les préférences. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { applyFilters, DEFAULT_FILTERS, DEFAULT_PREFS, loadPrefs } from '../widget/js/core/filters.js';
import { dataQuality, qualityRows, qualityTotal } from '../widget/js/core/stats-data.js';
import { qualityCard } from '../widget/js/views/stats.js';
import { feuille } from './fixtures/feuille.js';

const m = buildModel(feuille());
const ids = [...applyFilters(m, DEFAULT_FILTERS, DEFAULT_PREFS).taskIds];
const rows = qualityRows(dataQuality(m, ids));

test('total des anomalies : somme des éléments de chaque catégorie', () => {
  const total = rows.reduce((s, r) => s + r.items.length, 0);
  assert.ok(total > 0);
  assert.equal(qualityTotal(rows), total);
  assert.equal(qualityTotal(qualityRows([])), 0);
});

test('repliée : bouton d’en-tête dans le h3, aria-expanded=false, total écrit, contenu masqué', () => {
  const out = qualityCard(rows, ids.length, false).toString();
  assert.match(out, /<h3 class="stats__card-title stats__quality-title">\s*<button type="button"/);
  assert.match(out, /aria-expanded="false" aria-controls="stats-quality-body"/);
  assert.match(
    out,
    /Contrôle qualité des données<\/span>\s*<span class="stats__quality-sep" aria-hidden="true">·<\/span>/,
  );
  assert.match(out, new RegExp(`<span class="stats__count">${qualityTotal(rows)}</span>`));
  assert.match(out, /Checklist des données manquantes ou incohérentes dans la Feuille de route/);
  assert.match(out, /<div id="stats-quality-body" hidden>/);
  // Les catégories restent dépliables une à une, avec leur compteur
  assert.match(out, /data-kind="sans-dates" aria-expanded="false"/);
});

test('dépliée : aria-expanded=true, contenu visible', () => {
  const out = qualityCard(rows, ids.length, true).toString();
  assert.match(out, /aria-expanded="true"/);
  assert.match(out, /<div id="stats-quality-body" >/);
});

test('aucune anomalie : « Aucune anomalie » et coche dans l’en-tête', () => {
  const out = qualityCard(qualityRows([]), 0, false).toString();
  assert.match(out, /stats__count--ok"><span aria-hidden="true">✓<\/span>Aucune anomalie<\/span>/);
});

test('préférence « carte dépliée » : repliée par défaut, seul true est retenu', () => {
  const load = (v) => loadPrefs({ getItem: () => JSON.stringify(v) });
  assert.equal(DEFAULT_PREFS.statsQualityOpen, false);
  assert.equal(load({}).statsQualityOpen, false);
  assert.equal(load({ statsQualityOpen: true }).statsQualityOpen, true);
  assert.equal(load({ statsQualityOpen: 'oui' }).statsQualityOpen, false);
});
