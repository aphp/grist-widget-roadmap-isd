import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFS, loadPrefs } from '../widget/js/core/filters.js';
import {
  LABEL_WIDTH,
  clampLabelWidth,
  defaultLabelWidth,
  labelWidthAfterKey,
  labelWidthMax,
  sanitizeLabelWidth,
} from '../widget/js/core/gantt-data.js';

test('largeur des noms : défaut selon la fenêtre, comme le CSS', () => {
  assert.equal(defaultLabelWidth(1440), 320);
  assert.equal(defaultLabelWidth(1280), 320);
  assert.equal(defaultLabelWidth(1279), 256);
  assert.equal(defaultLabelWidth(0), 320);
  // Les deux défauts tombent sur la grille des pas (curseur de type range)
  for (const w of [LABEL_WIDTH.wide, LABEL_WIDTH.medium]) assert.equal((w - LABEL_WIDTH.min) % LABEL_WIDTH.step, 0);
});

test('largeur des noms : maximum à 60 % de la vue, sur le pas, jamais sous 160 px', () => {
  assert.equal(labelWidthMax(1000), 592); // 600 ramené au pas inférieur (160 + 27 × 16)
  assert.equal(labelWidthMax(200), 160);
  assert.equal(labelWidthMax(0), 4000);
  assert.equal(labelWidthMax(undefined), 4000);
});

test('largeur des noms : bornée entre 160 px et 60 % de la vue, posée sur le pas', () => {
  assert.equal(clampLabelWidth(100, 1000), 160);
  assert.equal(clampLabelWidth(5000, 1000), 592);
  assert.equal(clampLabelWidth(283, 1000), 288);
  assert.equal(clampLabelWidth(279, 1000), 272);
  assert.equal(clampLabelWidth(NaN, 1000), 320);
  assert.equal(clampLabelWidth(undefined, 1000, 256), 256);
  // Vue étroite : le défaut lui-même est borné
  assert.equal(clampLabelWidth(320, 400), 240);
});

test('largeur des noms au clavier : pas de 16 px, 64 px avec Maj, Début / Fin aux bornes', () => {
  assert.equal(labelWidthAfterKey(320, 'ArrowRight', false, 1000), 336);
  assert.equal(labelWidthAfterKey(320, 'ArrowUp', false, 1000), 336);
  assert.equal(labelWidthAfterKey(320, 'ArrowLeft', false, 1000), 304);
  assert.equal(labelWidthAfterKey(320, 'ArrowDown', true, 1000), 256);
  assert.equal(labelWidthAfterKey(320, 'ArrowRight', true, 1000), 384);
  assert.equal(labelWidthAfterKey(176, 'ArrowLeft', true, 1000), 160);
  assert.equal(labelWidthAfterKey(576, 'ArrowRight', true, 1000), 592);
  assert.equal(labelWidthAfterKey(320, 'Home', false, 1000), 160);
  assert.equal(labelWidthAfterKey(320, 'End', false, 1000), 592);
  assert.equal(labelWidthAfterKey(320, 'Enter', false, 1000), null);
});

test('largeur des noms : préférence assainie, absente des anciennes préférences', () => {
  const load = (json) => loadPrefs({ getItem: () => json, setItem: () => {} });
  assert.equal(DEFAULT_PREFS.ganttLabelWidth, null);
  assert.equal(load('{"ganttScale":"week"}').ganttLabelWidth, null);
  assert.equal(load('{"ganttLabelWidth":400}').ganttLabelWidth, 400);
  assert.equal(load('{"ganttLabelWidth":400.6}').ganttLabelWidth, 401);
  for (const bad of ['"400"', '-5', '100', '99999', 'null', 'true', '[400]'])
    assert.equal(load(`{"ganttLabelWidth":${bad}}`).ganttLabelWidth, null, bad);
  assert.equal(sanitizeLabelWidth(160), 160);
  assert.equal(sanitizeLabelWidth(Infinity), null);
});
