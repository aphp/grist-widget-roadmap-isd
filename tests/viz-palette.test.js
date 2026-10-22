import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VIZ_PRINT } from '../widget/js/ui/viz-palette.js';
import { canvasScale } from '../widget/js/ui/pdf.js';

const tokens = readFileSync('widget/css/tokens.css', 'utf8');
const lightBlock = tokens.slice(tokens.indexOf(':root {'), tokens.indexOf(':root[data-fr-theme'));

test('palette imprimée = variables --viz-* du thème clair de tokens.css', () => {
  for (const [name, hex] of Object.entries(VIZ_PRINT)) {
    if (Array.isArray(hex)) continue; // teintes de chantier : test suivant
    const m = lightBlock.match(new RegExp(`--viz-${name}:\\s*(#[0-9a-fA-F]{6})`));
    assert.ok(m, `--viz-${name} absent de tokens.css`);
    assert.equal(m[1].toLowerCase(), hex.toLowerCase(), name);
  }
});

// ---------- Teintes de chantier (mode « Chantier » du Gantt) ----------
const CH = {
  clair: {
    fill: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6'],
    deep: ['#1c5cab', '#b84a1d', '#127a55', '#9a6800', '#b8476f', '#005c00', '#4535a8'],
  },
  sombre: {
    fill: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'],
    deep: ['#86b6ef', '#f09a75', '#6fd0ab', '#f2c85c', '#f0a3c0', '#63c463', '#c0b8f5'],
  },
};
const tok = (block, name) => block.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

test('teintes de chantier : 7 remplissages et 7 teintes foncées par thème, bande à 7 %', () => {
  for (const [theme, block] of [
    ['clair', lightBlock],
    ['sombre', darkBlock],
  ])
    for (let i = 0; i < 7; i++) {
      const n = i + 1;
      assert.equal(tok(block, `viz-ch-${n}`)?.toLowerCase(), CH[theme].fill[i], `--viz-ch-${n} (${theme})`);
      assert.equal(tok(block, `viz-ch-${n}-deep`)?.toLowerCase(), CH[theme].deep[i], `--viz-ch-${n}-deep (${theme})`);
      // Bande en rgba explicite (html2canvas ne lit pas color-mix) : même teinte que le remplissage, 7 %
      assert.equal(
        tok(block, `viz-ch-${n}-band`),
        `rgba(${rgbOf(CH[theme].fill[i]).join(', ')}, 0.07)`,
        `bande ${n} (${theme})`,
      );
    }
});

test('palette imprimée des chantiers = teintes claires de tokens.css', () => {
  assert.deepEqual(VIZ_PRINT.chantier, CH.clair.fill);
  assert.deepEqual(VIZ_PRINT.chantierDeep, CH.clair.deep);
});

test('teintes foncées des chantiers ≥ 3:1 sur la carte (liseré des barres, barre du chantier)', () => {
  for (const [theme, surface] of [
    ['clair', '#ffffff'],
    ['sombre', '#1e293b'],
  ])
    for (const hex of CH[theme].deep)
      assert.ok(ratio(hex, surface) >= 3, `${hex} sur ${surface} (${theme}) : ${ratio(hex, surface).toFixed(2)}`);
});

for (const f of ['gantt.css', 'stats.css', 'synthesis.css', 'team.css', 'load-plan.css', 'detail.css', 'table.css'])
  test(`${f} n’utilise que les variables partagées`, () => {
    const css = readFileSync(`widget/css/${f}`, 'utf8');
    assert.equal(/#[0-9a-fA-F]{3,6}\b/.test(css), false);
  });

test('échelle du canvas : le plus grand côté reste sous 32 000 px, sinon null', () => {
  assert.equal(canvasScale(1000, 1000), 2);
  const s = canvasScale(1400, 30000);
  assert.ok(30000 * s <= 32000 && 1400 * 30000 * s * s <= 120e6);
  assert.equal(canvasScale(1400, 80000), null); // trop haut : il faut replier des lignes
  assert.equal(canvasScale(0, 100), null);
});

// ---------- Contraste des marques graphiques (WCAG 1.4.11 : ≥ 3:1) ----------
const lum = (hex) => {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = v.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const darkBlock = tokens.slice(tokens.indexOf(':root[data-fr-theme'));
const MARKS = ['viz-1', 'viz-2', 'viz-3', 'viz-4', 'viz-mgmt', 'viz-neutral', 'status-other-mark'];
for (const [theme, block, surfaces] of [
  ['clair', lightBlock, ['#ffffff', '#f8fafc']],
  ['sombre', darkBlock, ['#1e293b', '#0f172a']],
])
  test(`marques graphiques ≥ 3:1 sur la carte et le fond (${theme})`, () => {
    for (const name of MARKS) {
      const m = block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
      assert.ok(m, `--${name} absent (${theme})`);
      for (const s of surfaces)
        assert.ok(ratio(m[1], s) >= 3, `--${name} ${m[1]} sur ${s} : ${ratio(m[1], s).toFixed(2)}`);
    }
  });
