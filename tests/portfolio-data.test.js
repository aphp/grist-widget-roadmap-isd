import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { applyFilters, DEFAULT_FILTERS, DEFAULT_PREFS, loadPrefs } from '../widget/js/core/filters.js';
import { dayOfIso, isoOfDay } from '../widget/js/core/dates.js';
import { hoursToEtp, workdaysInYear } from '../widget/js/core/capacity.js';
import {
  PORTFOLIO_MONTHS,
  PORTFOLIO_TABS,
  TAB_KIND,
  defaultStart,
  loadRate,
  portfolioItems,
  portfolioKpis,
  portfolioScale,
  summarizeWeeks,
  weekCount,
  weeklyLoadByProfile,
} from '../widget/js/core/portfolio-data.js';
import { feuille } from './fixtures/feuille.js';

const m = buildModel(feuille());
const view = applyFilters(m, DEFAULT_FILTERS, DEFAULT_PREFS);
const d = dayOfIso;
const avail = 1 - 44 / workdaysInYear(2026);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-5, `${msg ?? ''} ${a} ≠ ${b}`);

test('indicateurs : projets, chantiers et tâches visibles, personnes ISD impliquées par profil', () => {
  const k = portfolioKpis(m, view);
  assert.equal(k.projets, 3); // Données Socle Commun EDS, ChatDPI, BI Gestion
  assert.equal(k.chantiers, 4); // 100, 200, 201 (partagé, une fois), 300 ; « (sans chantier) » exclu
  assert.equal(k.taches, 8); // tâches et sous-tâches : 1000, 1001, 1002, 1500, 2000, 2001, 2010 (une fois), 3000
  assert.deepEqual(k.personnes, { total: 3, PO: 1, DA: 1, DS: 0, DE: 1 });
});

test('indicateurs : suivent les filtres', () => {
  const v = applyFilters(m, { ...DEFAULT_FILTERS, person: 5 }, DEFAULT_PREFS);
  const k = portfolioKpis(m, v);
  assert.deepEqual([k.projets, k.chantiers, k.taches], [2, 1, 2]);
  assert.deepEqual(k.personnes, { total: 1, PO: 0, DA: 1, DS: 0, DE: 0 });
});

test('éléments de la frise : uniques, sans chantier virtuel, triés par début puis titre', () => {
  const ch = portfolioItems(m, view.tree, 'chantier', '');
  assert.deepEqual(
    ch.map((x) => `${x.ref.table}:${x.ref.id}`),
    ['Chantiers:100', 'Chantiers:201', 'Chantiers:300', 'Chantiers:200'],
  );
  assert.equal(ch[1].context, 'BI Gestion'); // premier emplacement dans l’arbre
  assert.deepEqual(
    [isoOfDay(ch[1].bar.start), isoOfDay(ch[1].bar.end), ch[1].bar.deduced],
    ['2026-11-02', '2026-11-06', true],
  );
  assert.equal(ch[3].bar, null);
  const projets = portfolioItems(m, view.tree, TAB_KIND.projets, '');
  assert.deepEqual(
    projets.map((x) => x.title),
    ['Données Socle Commun EDS', 'BI Gestion', 'ChatDPI'],
  );
  assert.equal(projets[0].context, 'Produit de données'); // la catégorie
  const tasks = portfolioItems(m, view.tree, TAB_KIND.taches, '');
  assert.equal(tasks.length, 8); // sous-tâches comprises
  assert.equal(tasks.find((x) => x.ref.id === 1000).context, 'Données Socle Commun EDS › Produit de Données Patient');
  assert.equal(
    tasks.find((x) => x.ref.id === 1002).context,
    'Données Socle Commun EDS › Produit de Données Patient › Ajout table FHIR Adresse',
  );
});

test('éléments de la frise : recherche locale (accents et casse ignorés)', () => {
  assert.deepEqual(
    portfolioItems(m, view.tree, 'chantier', 'PARTAGE').map((x) => x.ref.id),
    [201],
  );
  assert.deepEqual(
    portfolioItems(m, view.tree, TAB_KIND.taches, 'réal').map((x) => x.ref.id),
    [1002],
  );
  assert.deepEqual(portfolioItems(m, view.tree, 'projet', 'zzz'), []);
});

test('échelle : du jour de début, N mois, colonnes mensuelles et années', () => {
  const s = portfolioScale(d('2026-10-19'), 6);
  assert.deepEqual([isoOfDay(s.start), isoOfDay(s.end)], ['2026-10-19', '2027-04-18']);
  assert.equal(s.days, s.end - s.start + 1);
  assert.equal(s.columns.length, 7);
  assert.deepEqual([isoOfDay(s.columns[0].start), isoOfDay(s.columns[0].end)], ['2026-10-19', '2026-10-31']);
  assert.equal(s.columns[1].label, 'nov.');
  assert.deepEqual(
    s.groups.map((g) => g.label),
    ['2026', '2027'],
  );
  assert.equal(portfolioScale(d('2026-01-01'), 12).columns.length, 12);
  assert.deepEqual(PORTFOLIO_MONTHS, [6, 12, 18]);
  assert.deepEqual(PORTFOLIO_TABS, ['projets', 'chantiers', 'taches', 'load']);
});

test('début par défaut : premier jour du mois courant ; nombre de semaines de la période', () => {
  assert.equal(isoOfDay(defaultStart(d('2026-10-19'))), '2026-10-01');
  // 6 mois depuis le lundi 2 novembre 2026 : jusqu’au 1er mai 2027 → 26 semaines
  assert.equal(weekCount(d('2026-11-02'), 6), 26);
  // Début un mercredi : la première semaine commence au lundi précédent
  assert.equal(weekCount(d('2026-11-04'), 6), 27);
});

test('charge hebdomadaire : la tâche 1002 donne 35 h la semaine du 2 novembre 2026, soit 1,0 ETP DE', () => {
  const w = weeklyLoadByProfile(m, view.taskIds, d('2026-10-26'), 3);
  assert.deepEqual(
    w.map((x) => isoOfDay(x.weekStart)),
    ['2026-10-26', '2026-11-02', '2026-11-09'],
  );
  near(w[1].DE, 35);
  assert.equal(hoursToEtp(w[1].DE, 7), 1);
  near(w[0].DE, 35);
  assert.equal(w[2].DE, 0);
  near(w[1].DA, 14); // tâche 2010 (Eve DA), la charge de la personne inconnue 99 est ignorée
  assert.equal(w[1].PO, 0);
  assert.equal(w[1].DS, 0);
});

test('charge hebdomadaire : la tâche 2010 (chantier partagé) n’est comptée qu’une fois', () => {
  const [w] = weeklyLoadByProfile(m, [2010, 2010], d('2026-11-04'), 1);
  assert.equal(isoOfDay(w.weekStart), '2026-11-02');
  near(w.DA, 14);
  const sum = (ids) => weeklyLoadByProfile(m, ids, d('2026-11-02'), 1)[0].DA;
  near(sum(view.taskIds), sum([2010]));
});

test('charge hebdomadaire : seules les personnes ISD comptent ; tâches inconnues ignorées', () => {
  const raw = feuille();
  raw.tables.Tasks.charges[raw.tables.Tasks.id.indexOf(1002)] = '[{"teamId":4,"heures":70},{"teamId":3,"heures":70}]';
  const mm = buildModel(raw);
  const [w] = weeklyLoadByProfile(mm, [1002, 12345], d('2026-11-02'), 1);
  assert.deepEqual([w.PO, w.DA, w.DS, w.DE], [0, 0, 0, 0]);
});

test('capacité hebdomadaire par profil : toutes les personnes ISD actives du profil', () => {
  const w = weeklyLoadByProfile(m, [], d('2026-10-26'), 3);
  near(w[0].capacity.DE, 35 * avail, 'DE');
  assert.equal(w[1].capacity.DE, 0); // Alice indisponible du 2 au 6 novembre
  near(w[2].capacity.DE, 28 * avail, 'DE 11 nov.'); // 11 novembre férié
  near(w[0].capacity.DA, 28 * avail, 'DA'); // 28 h / semaine
  near(w[0].capacity.PO, 35 * avail, 'PO');
  assert.equal(w[0].capacity.DS, 0); // Carl inactif
});

test('taux : ok, tension, dépassement ; capacité nulle', () => {
  assert.deepEqual(loadRate(0, 0), { rate: null, level: 'none' });
  assert.deepEqual(loadRate(5, 0), { rate: null, level: 'over' });
  assert.equal(loadRate(8, 10).level, 'ok');
  assert.equal(loadRate(8.5, 10).level, 'tension');
  assert.equal(loadRate(10, 10).level, 'tension');
  assert.equal(loadRate(10.1, 10).level, 'over');
  assert.equal(loadRate(0, 10).level, 'ok');
  assert.equal(loadRate(3, 10).rate, 0.3);
});

test('synthèse de la période : pic, semaines en dépassement / tension, moyenne des semaines chargées', () => {
  const w = weeklyLoadByProfile(m, view.taskIds, d('2026-10-26'), 3);
  const t = summarizeWeeks(w);
  assert.deepEqual(Object.keys(t), ['PO', 'DA', 'DS', 'DE']);
  // DE : 35 h pour 28,9 h la 1re semaine (121 %), 35 h sans capacité la 2e (Alice indisponible) → pic sans taux
  assert.deepEqual([t.DE.weeks, t.DE.loadedWeeks, t.DE.overWeeks, t.DE.tensionWeeks, t.DE.level], [3, 2, 2, 0, 'over']);
  assert.deepEqual([t.DE.peak.rate, isoOfDay(t.DE.peak.weekStart), t.DE.peak.level], [null, '2026-11-02', 'over']);
  near(t.DE.avgLoaded.load, 35);
  near(t.DE.avgLoaded.capacity, (35 * avail) / 2);
  // DA : 14 h pour 23,1 h la semaine du 2 novembre → 61 %, normal
  assert.deepEqual([t.DA.loadedWeeks, t.DA.overWeeks, t.DA.tensionWeeks, t.DA.level], [1, 0, 0, 'ok']);
  assert.equal(isoOfDay(t.DA.peak.weekStart), '2026-11-02');
  near(t.DA.peak.rate, Math.round((14 / (28 * avail)) * 1e4) / 1e4);
  near(t.DA.avgLoaded.load, 14);
  // PO : aucune charge
  assert.deepEqual([t.PO.loadedWeeks, t.PO.peak, t.PO.level, t.PO.avgLoaded], [0, null, 'none', null]);
});

test('synthèse de la période : semaines en tension et pic au taux le plus haut', () => {
  const row = (de, cap) => ({ weekStart: 0, PO: 0, DA: 0, DS: 0, DE: de, capacity: { PO: 0, DA: 0, DS: 0, DE: cap } });
  const rows = [row(9, 10), row(5, 10), row(12, 10), row(0, 10)].map((r, i) => ({ ...r, weekStart: 7 * i }));
  const t = summarizeWeeks(rows).DE;
  assert.deepEqual(
    [t.loadedWeeks, t.tensionWeeks, t.overWeeks, t.peak.rate, t.peak.weekStart, t.level],
    [3, 1, 1, 1.2, 14, 'over'],
  );
  near(t.avgLoaded.load, 26 / 3);
  near(t.avgLoaded.capacity, 10);
});

test('préférences du Portfolio : sous-onglet, début et durée validés', () => {
  const load = (s) => loadPrefs({ getItem: () => s });
  assert.deepEqual(
    [DEFAULT_PREFS.portfolioTab, DEFAULT_PREFS.portfolioStart, DEFAULT_PREFS.portfolioMonths],
    ['projets', null, 12],
  );
  const ok = load('{"portfolioTab":"load","portfolioStart":"2026-11-02","portfolioMonths":18}');
  assert.deepEqual([ok.portfolioTab, ok.portfolioStart, ok.portfolioMonths], ['load', '2026-11-02', 18]);
  const bad = load('{"portfolioTab":"x","portfolioStart":"2026-13-45","portfolioMonths":7}');
  assert.deepEqual([bad.portfolioTab, bad.portfolioStart, bad.portfolioMonths], ['projets', null, 12]);
  // Anciens sous-onglets « produits » et « tâches » repris
  assert.equal(load('{"portfolioTab":"products"}').portfolioTab, 'projets');
  assert.equal(load('{"portfolioTab":"tasks"}').portfolioTab, 'taches');
  const bad2 = load('{"portfolioStart":"demain","portfolioMonths":"12"}');
  assert.deepEqual([bad2.portfolioStart, bad2.portfolioMonths], [null, 12]);
});
