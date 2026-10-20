import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { applyFilters, DEFAULT_FILTERS, DEFAULT_PREFS, loadPrefs } from '../widget/js/core/filters.js';
import { dayOfIso, isoOfDay } from '../widget/js/core/dates.js';
import {
  MAX_EXPANDED,
  SCALES,
  prunedExpanded,
  barGeometry,
  colorKey,
  DEFAULT_LEVEL,
  GANTT_LEVELS,
  chronoItems,
  levelExpanded,
  expandableKeys,
  ganttRows,
  isLate,
  isMilestone,
  isoWeek,
  nodeBar,
  pdfFilenameOfDay,
  phaseOf,
  shiftAnchor,
  timeScale,
  todayAnchor,
} from '../widget/js/core/gantt-data.js';
import { feuille } from './fixtures/feuille.js';

const m = buildModel(feuille());
const view = applyFilters(m, DEFAULT_FILTERS, DEFAULT_PREFS);
const d = dayOfIso;
const iso = (x) => isoOfDay(x);

test('phaseOf : étape détectée sur le titre, sans accents ni casse', () => {
  assert.equal(phaseOf('Préparation MEP'), 'mep');
  assert.equal(phaseOf('réalisation'), 'realisation');
  assert.equal(phaseOf('Instruction'), 'instruction');
  assert.equal(phaseOf('INSTRUCTION du besoin'), 'instruction');
  assert.equal(phaseOf('Préparation à la mise en production'), 'mep');
  assert.equal(phaseOf('MEP 3.4'), 'mep');
  assert.equal(phaseOf('Réalisation TDB'), 'realisation');
  assert.equal(phaseOf('Temps de préparation'), null);
  assert.equal(phaseOf('Campement'), null); // « mep » au milieu d'un mot : ignoré
  assert.equal(phaseOf(''), null);
  assert.equal(phaseOf(null), null);
});

test('ganttRows : seuls les enfants des nœuds dépliés, profondeur et enfants', () => {
  const fams = view.tree.map((f) => f.key);
  const rows = ganttRows(view.tree, new Set(fams));
  assert.deepEqual(
    rows.map((r) => [r.node.kind, r.depth]),
    [
      ['categorie', 0],
      ['projet', 1],
      ['categorie', 0],
      ['projet', 1],
      ['categorie', 0],
      ['projet', 1],
    ],
  );
  assert.ok(rows.every((r) => r.hasChildren));
  assert.equal(rows[0].expanded, true);
  assert.equal(rows[1].expanded, false);
  const prod = rows.find((r) => r.node.title === 'ChatDPI');
  const more = ganttRows(view.tree, new Set([...fams, prod.key]));
  assert.equal(more.length, rows.length + prod.node.children.length);
  assert.deepEqual(ganttRows(view.tree, new Set()).length, view.tree.length);
  assert.deepEqual(ganttRows([], new Set(fams)), []);
});

test('ganttRows : tout déplié = tous les nœuds, sous-tâches comprises', () => {
  const all = ganttRows(view.tree, new Set(expandableKeys(view.tree)));
  const count = (n) => 1 + n.children.reduce((s, c) => s + count(c), 0);
  assert.equal(
    all.length,
    view.tree.reduce((s, f) => s + count(f), 0),
  );
  const sub = all.find((r) => r.node.taskId === 1002);
  assert.equal(sub.depth, 4); // catégorie 0, projet 1, chantier 2, tâche 3, sous-tâche 4
  assert.equal(sub.node.kind, 'sous-tache');
  assert.equal(all.find((r) => r.node.taskId === 1000).node.kind, 'tache');
  assert.equal(sub.hasChildren, false);
});

test('niveaux : chaque niveau déplie les niveaux au-dessus, « sous-tache » déplie tout', () => {
  assert.deepEqual(GANTT_LEVELS, ['projet', 'chantier', 'tache', 'sous-tache']);
  assert.equal(DEFAULT_LEVEL, 'chantier');
  const kinds = (level) =>
    new Set(ganttRows(view.tree, new Set(levelExpanded(view.tree, level))).map((r) => r.node.kind));
  assert.deepEqual([...kinds('projet')].sort(), ['categorie', 'projet']);
  assert.deepEqual([...kinds('chantier')].sort(), ['categorie', 'chantier', 'projet']);
  assert.ok(kinds('tache').has('tache') && !kinds('tache').has('sous-tache'));
  assert.ok(kinds('sous-tache').has('sous-tache'));
  assert.deepEqual(levelExpanded(view.tree, 'sous-tache').sort(), expandableKeys(view.tree).sort());
  assert.deepEqual(levelExpanded(view.tree, 'inconnu'), levelExpanded(view.tree, DEFAULT_LEVEL));
  assert.deepEqual(levelExpanded([], 'tache'), []);
  const keys = expandableKeys(view.tree);
  assert.ok(keys.includes('C:Projet'));
  assert.ok(!keys.some((k) => k.endsWith('/T1002'))); // feuille sans enfant
});

test('ganttRows : position et taille de la fratrie (aria-posinset, aria-setsize)', () => {
  const rows = ganttRows(view.tree, new Set(levelExpanded(view.tree, 'chantier')));
  const top = rows.filter((r) => r.depth === 0);
  assert.deepEqual(
    top.map((r) => [r.posinset, r.setsize]),
    top.map((_, i) => [i + 1, view.tree.length]),
  );
  for (const r of rows.filter((x) => x.depth === 2)) {
    const parent = rows.find((p) => p.node.children.includes(r.node));
    assert.equal(r.setsize, parent.node.children.length);
    assert.equal(parent.node.children[r.posinset - 1], r.node);
  }
});

test('chronoItems : tâches et sous-tâches de la fenêtre, triées par début, avec leur chemin', () => {
  const all = chronoItems(view.tree, timeScale('2y', d('2020-01-01')));
  const wide = { start: -1e6, end: 1e6, days: 2e6 + 1 };
  const every = chronoItems(view.tree, wide);
  assert.ok(every.length > 0);
  assert.ok(every.every((x) => x.node.kind === 'tache' || x.node.kind === 'sous-tache'));
  for (let i = 1; i < every.length; i++) assert.ok(every[i - 1].bar.start <= every[i].bar.start);
  assert.ok(every.every((x) => x.path.length === 2 && !x.geometry.outside));
  assert.equal(all.length, 0); // fenêtre 2020-2021 : aucune tâche
  // Égalité de dates : ordre par échéance puis titre
  const mk = (key, title, start, end) => ({ key, kind: 'tache', title, start, end, span: null, children: [] });
  const tree = [
    {
      key: 'C',
      kind: 'categorie',
      title: 'C',
      children: [
        {
          key: 'P',
          kind: 'projet',
          title: 'P',
          children: [
            {
              key: 'K',
              kind: 'chantier',
              title: 'K',
              children: [mk('b', 'B', 10, 20), mk('a', 'A', 10, 20), mk('c', 'C', 10, 15), mk('z', null, 10, 20)],
            },
          ],
        },
      ],
    },
  ];
  assert.deepEqual(
    chronoItems(tree, wide).map((x) => x.key),
    ['c', 'z', 'a', 'b'], // sans titre (« » vide) avant A,
  );
  assert.deepEqual(chronoItems(tree, wide)[0].path, ['P', 'K']);
});

test('échelle « mois » : 6 mois à partir du mois de l’ancre', () => {
  const s = timeScale('month', d('2026-10-19'));
  assert.equal(iso(s.start), '2026-10-01');
  assert.equal(iso(s.end), '2027-03-31');
  assert.equal(s.columns.length, 6);
  assert.deepEqual(
    s.columns.map((c) => c.label),
    ['oct.', 'nov.', 'déc.', 'janv.', 'févr.', 'mars'],
  );
  assert.equal(iso(s.columns[1].start), '2026-11-01');
  assert.equal(iso(s.columns[1].end), '2026-11-30');
  assert.deepEqual(
    s.groups.map((g) => g.label),
    ['2026', '2027'],
  );
  assert.equal(s.days, s.end - s.start + 1);
});

test('échelle « semaine » : 12 semaines ISO à partir du lundi de l’ancre', () => {
  const s = timeScale('week', d('2026-10-21')); // mercredi
  assert.equal(iso(s.start), '2026-10-19');
  assert.equal(s.columns.length, 12);
  assert.equal(s.columns[0].label, 'S43');
  assert.equal(iso(s.columns[0].end), '2026-10-25');
  assert.equal(iso(s.end), '2027-01-10');
  assert.match(s.columns[0].title, /Semaine 43/);
  assert.deepEqual(
    s.groups.map((g) => g.label),
    ['oct. 2026', 'nov. 2026', 'déc. 2026', 'janv. 2027'],
  );
  assert.equal(s.groups[0].start, s.start);
  assert.equal(s.groups.at(-1).end, s.end);
});

test('semaines ISO : bascule d’année', () => {
  assert.deepEqual(isoWeek(d('2026-12-31')), { year: 2026, week: 53 });
  assert.deepEqual(isoWeek(d('2027-01-04')), { year: 2027, week: 1 });
  assert.deepEqual(isoWeek(d('2027-01-01')), { year: 2026, week: 53 });
});

test('échelles « année » et « 2 ans »', () => {
  const y = timeScale('year', d('2026-10-19'));
  assert.equal(iso(y.start), '2026-01-01');
  assert.equal(iso(y.end), '2026-12-31');
  assert.equal(y.columns.length, 12);
  assert.equal(y.columns[0].label, 'janv.');
  const t = timeScale('2y', d('2026-10-19'));
  assert.equal(iso(t.start), '2026-01-01');
  assert.equal(iso(t.end), '2027-12-31');
  assert.deepEqual(
    t.columns.map((c) => c.label),
    ['T1', 'T2', 'T3', 'T4', 'T1', 'T2', 'T3', 'T4'],
  );
  assert.equal(iso(t.columns[1].start), '2026-04-01');
  assert.match(t.columns[0].title, /1er trimestre 2026/);
  assert.deepEqual(
    t.groups.map((g) => g.label),
    ['2026', '2027'],
  );
  assert.equal(timeScale('nimporte', d('2026-10-19')).mode, 'month');
  assert.deepEqual(SCALES, ['week', 'month', 'year', '2y']);
});

test('navigation : précédent, suivant, aujourd’hui', () => {
  const a = d('2026-10-19');
  assert.equal(iso(shiftAnchor('week', a, 1)), '2026-11-16');
  assert.equal(iso(shiftAnchor('month', a, -1)), '2026-07-01');
  assert.equal(iso(shiftAnchor('month', d('2026-01-31'), 1)), '2026-04-01');
  assert.equal(iso(shiftAnchor('year', a, 1)), '2027-01-01');
  assert.equal(iso(shiftAnchor('2y', a, -1)), '2025-01-01');
  // « aujourd'hui » laisse un peu de passé à gauche
  assert.equal(iso(todayAnchor('week', a)), '2026-10-05');
  assert.equal(iso(todayAnchor('month', a)), '2026-09-01');
  assert.equal(iso(todayAnchor('year', a)), '2026-01-01');
  assert.equal(iso(todayAnchor('2y', a)), '2026-01-01');
  const s = timeScale('week', todayAnchor('week', a));
  assert.ok(s.start <= a && a <= s.end);
});

test('géométrie des barres : pourcentages, coupures et hors fenêtre', () => {
  const s = timeScale('month', d('2026-10-01')); // 182 jours
  const g = barGeometry(s, d('2026-10-01'), d('2026-10-31'));
  assert.equal(g.left, 0);
  assert.ok(Math.abs(g.width - (31 / s.days) * 100) < 1e-9);
  assert.equal(g.clipStart, false);
  assert.equal(g.clipEnd, false);
  const c = barGeometry(s, d('2026-09-01'), d('2027-06-01'));
  assert.deepEqual([c.left, c.width, c.clipStart, c.clipEnd], [0, 100, true, true]);
  assert.deepEqual(barGeometry(s, d('2026-01-01'), d('2026-02-01')), { outside: 'before' });
  assert.deepEqual(barGeometry(s, d('2027-05-01'), d('2027-06-01')), { outside: 'after' });
  const one = barGeometry(s, d('2026-10-10'), d('2026-10-10'));
  assert.ok(Math.abs(one.width - 100 / s.days) < 1e-9);
  // fin avant début : remise dans l'ordre
  assert.deepEqual(barGeometry(s, d('2026-10-31'), d('2026-10-01')), g);
});

test('barre d’un nœud : dates propres, sinon période déduite', () => {
  const byTask = (id) => m.nodes.get([...m.nodes.keys()].find((k) => m.nodes.get(k).taskId === id));
  const own = nodeBar(byTask(1002));
  assert.deepEqual(own, { start: d('2026-10-26'), end: d('2026-11-08'), deduced: false });
  const parent = nodeBar(byTask(1000)); // sans dates : étendue des sous-tâches
  assert.equal(parent.deduced, true);
  assert.equal(iso(parent.start), '2026-09-07');
  assert.equal(iso(parent.end), '2026-11-08');
  assert.equal(nodeBar(byTask(2001)), null);
  const backwards = nodeBar(byTask(3000)); // fin avant début : remise dans l'ordre
  assert.ok(backwards.start <= backwards.end);
  assert.equal(nodeBar({ start: d('2026-01-01'), end: null, span: null }), null);
});

test('retard, jalon et clé de couleur', () => {
  const t = (id) => ({ taskId: id, title: m.tasks.get(id).title, status: m.tasks.get(id).status });
  const today = d('2026-11-20');
  assert.equal(isLate(m, t(1002), today), true); // échéance 8 nov., en cours
  assert.equal(isLate(m, t(1001), today), false); // terminée
  assert.equal(isLate(m, t(1002), d('2026-11-08')), false); // échéance le jour même
  assert.equal(isLate(m, t(2001), today), false); // sans échéance
  assert.equal(isLate(m, { taskId: null, end: d('2020-01-01') }, today), false); // seules les tâches sont en retard

  const jm = { ...m, tasks: new Map([...m.tasks].map(([k, v]) => [k, k === 2010 ? { ...v, type: 'jalon' } : v])) };
  assert.equal(isMilestone(jm, t(2010)), true);
  assert.equal(isMilestone(m, t(2010)), false);
  assert.equal(isMilestone(m, { taskId: null }), false);

  assert.equal(colorKey(t(1002), 'phase'), 'realisation');
  assert.equal(colorKey(t(1001), 'phase'), 'instruction');
  assert.equal(colorKey(t(2000), 'phase'), 'other');
  assert.equal(colorKey(t(1002), 'status'), 'inprogress');
  assert.equal(colorKey(t(1001), 'status'), 'done');
  assert.equal(colorKey({ status: 'Bloqué', title: '' }, 'status'), 'other');
});

test('nom du fichier PDF', () => {
  assert.equal(pdfFilenameOfDay('gantt', d('2026-10-19')), 'roadmap-isd-gantt-2026-10-19.pdf');
});

test('préférences du Gantt assainies', () => {
  const load = (json) => loadPrefs({ getItem: () => json, setItem: () => {} });
  assert.equal(DEFAULT_PREFS.ganttScale, 'month');
  assert.equal(DEFAULT_PREFS.ganttColorBy, 'phase');
  assert.equal(DEFAULT_PREFS.ganttExpanded, null);
  const ok = load('{"ganttScale":"week","ganttColorBy":"status","ganttExpanded":["C:Projet"]}');
  assert.deepEqual([ok.ganttScale, ok.ganttColorBy, ok.ganttExpanded], ['week', 'status', ['C:Projet']]);
  // Anciennes clés « famille » : devenues les catégories de même titre (sans doublon)
  assert.deepEqual(load('{"ganttExpanded":["F:Projet","P20"]}').ganttExpanded, ['C:Projet', 'P20']);
  assert.deepEqual(load('{"ganttExpanded":["F:Projet","C:Projet"]}').ganttExpanded, ['C:Projet']);
  assert.deepEqual(load('{"ganttExpanded":[]}').ganttExpanded, []);
  const bad = load('{"ganttScale":"siècle","ganttColorBy":3,"ganttExpanded":[1,2]}');
  assert.deepEqual([bad.ganttScale, bad.ganttColorBy, bad.ganttExpanded], ['month', 'phase', null]);
  assert.equal(load('{"ganttExpanded":"x"}').ganttExpanded, null);
  // Niveau : « chantier » par défaut (anciennes préférences sans niveau comprises), « custom » accepté
  assert.equal(DEFAULT_PREFS.ganttLevel, 'chantier');
  assert.equal(load('{"ganttExpanded":["C:Projet"]}').ganttLevel, 'chantier');
  assert.equal(load('{"ganttLevel":"tache"}').ganttLevel, 'tache');
  assert.equal(load('{"ganttLevel":"custom"}').ganttLevel, 'custom');
  assert.equal(load('{"ganttLevel":"détail"}').ganttLevel, 'chantier');
});

test('dépliage enregistré : clés connues seulement, longueur bornée', () => {
  const valid = new Set(['a', 'b', 'c']);
  assert.deepEqual(prunedExpanded(new Set(['a', 'x', 'c']), valid), ['a', 'c']);
  const many = new Set(Array.from({ length: 3000 }, (_, i) => `k${i}`));
  assert.equal(prunedExpanded(many, many).length, MAX_EXPANDED);
  assert.equal(MAX_EXPANDED, 2000);
  const load = (json) => loadPrefs({ getItem: () => json, setItem: () => {} });
  assert.equal(load(JSON.stringify({ ganttExpanded: [...many] })).ganttExpanded.length, MAX_EXPANDED);
});
