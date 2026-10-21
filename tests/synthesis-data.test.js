import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { applyFilters, DEFAULT_FILTERS, DEFAULT_PREFS } from '../widget/js/core/filters.js';
import { dayOfIso } from '../widget/js/core/dates.js';
import {
  MAX_GANTT_TASKS,
  TITLE_PREFIX,
  markdownToHtml,
  mdEscape,
  mermaidEscape,
  mermaidGantt,
  mermaidGanttPlan,
  synthesisMarkdown,
} from '../widget/js/core/synthesis-data.js';
import { feuille } from './fixtures/feuille.js';

const m = buildModel(feuille());
const view = applyFilters(m, DEFAULT_FILTERS, DEFAULT_PREFS);

test('Markdown : un titre par projet et par chantier visible, une ligne par tâche', () => {
  const md = synthesisMarkdown(m, view);
  const lines = md.split('\n');
  assert.ok(lines.includes('# Tableau de pilotage — Roadmap ISD'));
  for (const t of ['Données Socle Commun EDS (Produit de données)', 'BI Gestion (Produit)', 'ChatDPI (Projet)'])
    assert.ok(lines.includes(`## ${t}`), t);
  for (const c of ['Produit de Données Patient', 'Reporting', 'WP1 : Modèle LLM — En réalisation', 'Chantier partagé'])
    assert.ok(
      lines.some((l) => l.startsWith('### ') && l.includes(c.replaceAll('_', '\\_'))),
      c,
    );
  // Produit de Données Patient, sans chantier (×2), partagé (détaillé, puis renvoi), Reporting, WP1
  assert.equal(lines.filter((l) => l.startsWith('### ')).length, 7);
  // 8 tâches du périmètre, chacune une seule fois
  assert.equal(lines.filter((l) => /^\| /.test(l) && !l.includes('---') && !l.startsWith('| Tâche |')).length, 8);
  // Chantiers distincts : le chantier partagé compte une fois, chaque « (sans chantier) » une fois par projet
  // ETP sur la capacité standard de chaque tâche : 1002 (70 h, ≈ 1,21) + 2010 (14 h, ≈ 0,48)
  assert.ok(lines.includes('3 projets, 6 chantiers, 8 tâches, 1,7 ETP au total.'), md);
  assert.equal(md.match(/Tâche du chantier partagé/g).length, 1);
});

test('Markdown : statut, échéance, personnes et ETP par profil', () => {
  const md = synthesisMarkdown(m, view);
  const row = md.split('\n').find((l) => l.includes('réalisation') && l.includes('Alice'));
  assert.ok(row, md);
  assert.match(row, /En cours|inprogress/i);
  assert.match(row, /8 nov\. 2026/);
  assert.match(row, /DE 1,2/); // 70 h ÷ 57,8 h (1 ETP standard du 26 octobre au 8 novembre 2026)
});

test('Markdown : colonnes ETP masquées pour un chantier sans aucune charge', () => {
  const md = synthesisMarkdown(m, view);
  const headers = md.split('\n').filter((l) => l.startsWith('| Tâche |'));
  const full = '| Tâche | Statut | Échéance | Personnes | ETP | ETP par profil |';
  const short = '| Tâche | Statut | Échéance | Personnes |';
  assert.ok(headers.includes(full), md);
  assert.ok(headers.includes(short), md);
  // Chaque tableau garde autant de colonnes dans ses lignes que dans son en-tête
  const blocks = md.split('\n\n').filter((b) => b.startsWith('| Tâche |'));
  for (const b of blocks) {
    const n = (l) => l.split(' | ').length;
    const [head, ...rest] = b.split('\n').filter(Boolean);
    for (const l of rest) assert.equal(n(l.replace('| --- |', '| x |')), n(head), b);
  }
});

test('Markdown : le texte des données est échappé (| * _ < >)', () => {
  assert.equal(mdEscape('a|b *c* _d_ <img onerror=x> [l](u)'), 'a\\|b \\*c\\* \\_d\\_ \\<img onerror=x\\> \\[l\\](u)');
  assert.equal(mdEscape('ligne1\nligne2'), 'ligne1 ligne2');
});

test('rendu : balises, liens et images du texte sont neutralisés, gras et tableaux rendus', () => {
  const html = markdownToHtml(
    [
      '# Titre <b>',
      '',
      '- **gras** et \\*pas\\*',
      '',
      '| A | B |',
      '| --- | ---: |',
      '| <img src=x onerror=alert(1)> \\| x | 2 |',
    ].join('\n'),
  );
  assert.ok(!/<img|<b>|onerror=alert\(1\)>/.test(html.replace(/&lt;[^>]*&gt;/g, '')) || !html.includes('<img'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; | x'));
  assert.ok(html.includes('<strong>gras</strong>'));
  assert.ok(html.includes('*pas*'));
  assert.ok(html.includes('<h3>Titre &lt;b&gt;</h3>'));
  assert.ok(html.includes('<td class="num">2</td>'));
});

test('rendu d’un Markdown généré : un titre contenant du HTML reste du texte', () => {
  const html = markdownToHtml(synthesisMarkdown(m, view));
  assert.ok(html.includes('<table>'));
  assert.ok(!/<(script|img|a|iframe)\b/i.test(html));
});

test('mermaidEscape : retire : # ; et retours à la ligne, neutralise les guillemets', () => {
  const out = mermaidEscape('Lot 1 : "Migration" #12; fin\nsuite %% x');
  assert.ok(!/[:#;"'\n%]/.test(out), out);
  assert.equal(mermaidEscape('<b>x</b>'), '‹b›x‹/b›');
  assert.equal(mermaidEscape('  \n'), '(sans titre)');
  assert.equal(mermaidEscape(null), '(sans titre)');
});

test('Gantt : en-tête, sections par projet, tâches datées seulement, titres échappés', () => {
  const g = mermaidGantt(m, view);
  const lines = g.split('\n');
  assert.equal(lines[0], 'gantt');
  assert.ok(lines.includes('  dateFormat YYYY-MM-DD'));
  assert.ok(lines.includes('  section Données Socle Commun EDS'));
  assert.ok(g.includes('instruction :done, t1001, 2026-09-07, 2026-10-02'));
  assert.ok(g.includes('réalisation :active, t1002, 2026-10-26, 2026-11-08'));
  assert.ok(!g.includes('Entraînement')); // sans dates
  assert.ok(!g.includes('Rapport mensuel')); // dates incohérentes
  assert.ok(!g.includes('t2001'));
});

test('Gantt : un titre avec : et # ne casse pas la syntaxe', () => {
  const m2 = buildModel(feuille());
  const t = m2.tasks.get(1002);
  t.title = 'Lot A: "x" #7; fin';
  m2.nodes.get('P10/C100/T1000/T1002').title = t.title;
  const g = mermaidGantt(m2, applyFilters(m2, DEFAULT_FILTERS, DEFAULT_PREFS));
  const row = g.split('\n').find((l) => l.includes('t1002'));
  assert.equal(row.split(':').length, 2, row); // un seul « : » : celui du séparateur
  assert.ok(!/[#;"]/.test(row), row);
});

test('Gantt : plafond de tâches et nombre d’omises', () => {
  const p = mermaidGanttPlan(m, view, { max: 2 });
  assert.equal(p.count, 2);
  assert.ok(p.omitted >= 1);
  assert.equal(MAX_GANTT_TASKS, 60);
  assert.equal(mermaidGanttPlan(m, view).omitted, 0);
});

test('Gantt : retard marqué critique, jalon, aucune tâche datée → vide', () => {
  const late = mermaidGantt(m, view, { today: dayOfIso('2026-12-01') });
  assert.ok(
    late
      .split('\n')
      .find((l) => l.includes('t1002'))
      .includes('crit'),
  );
  assert.ok(
    !late
      .split('\n')
      .find((l) => l.includes('t1001'))
      .includes('crit'),
  ); // terminée
  const none = { tree: [], taskIds: new Set() };
  assert.deepEqual(mermaidGanttPlan(m, none), { text: '', count: 0, omitted: 0 });
});

test('Gantt : un titre commençant par un mot-clé Mermaid ne devient pas une directive', () => {
  const titles = ['title x', 'section x', 'dateFormat x', 'click x', 'excludes x', 'todayMarker off'];
  const m2 = buildModel(feuille());
  for (const [i, id] of [1001, 1002, 2010].entries()) {
    m2.tasks.get(id).title = titles[i];
    for (const n of m2.nodes.values()) if (n.taskId === id) n.title = titles[i];
  }
  const g = mermaidGantt(m2, applyFilters(m2, DEFAULT_FILTERS, DEFAULT_PREFS));
  const taskLines = g.split('\n').filter((l) => /:\s*(\w+, )*t\d+,/.test(l));
  assert.equal(taskLines.length, 3);
  for (const l of taskLines) assert.ok(l.startsWith(`  ${TITLE_PREFIX}`), l);
  assert.equal(g.split('\n').filter((l) => /^\s*title /.test(l)).length, 1);
  assert.ok(!g.split('\n').some((l) => /^\s*(section (x|)$|click|excludes|dateFormat x|todayMarker)/.test(l)));
  for (const t of ['dateFormat x', 'click x', 'excludes x']) {
    const m3 = buildModel(feuille());
    m3.nodes.get('P10/C100/T1000/T1002').title = t;
    const row = mermaidGantt(m3, applyFilters(m3, DEFAULT_FILTERS, DEFAULT_PREFS))
      .split('\n')
      .find((l) => l.includes('t1002'));
    assert.ok(row.startsWith(`  ${TITLE_PREFIX}${t}`), row);
  }
});

test('Gantt : au-delà du plafond, les tâches en cours ou à venir passent avant les passées ou terminées', () => {
  const today = dayOfIso('2026-10-20');
  // t1001 terminée, t1002 en cours (fin 8 nov.), t2010 à venir (fin 6 nov.), t3000 dates incohérentes
  const p = mermaidGanttPlan(m, view, { max: 2, today });
  assert.equal(p.count, 2);
  assert.ok(p.text.includes('t1002') && p.text.includes('t2010') && !p.text.includes('t1001'));
  assert.equal(p.omitted, 1);
  // ordre d'affichage : celui de l'arbre (catégorie « Produit » avant « Produit de données »)
  assert.ok(p.text.indexOf('t2010') < p.text.indexOf('t1002'));
});
