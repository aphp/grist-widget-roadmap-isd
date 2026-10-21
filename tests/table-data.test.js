import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { applyFilters, DEFAULT_FILTERS, DEFAULT_PREFS } from '../widget/js/core/filters.js';
import {
  COLUMNS,
  DEFAULT_COLUMNS,
  DISPLAY_COLUMNS,
  HIERARCHY_COLUMNS,
  TABLE_PAGE,
  csvColumns,
  csvFilename,
  defaultOrder,
  formatEtp,
  isLate,
  nextLimit,
  pageRows,
  parentTitle,
  personInitials,
  priorityRank,
  sortRows,
  tableRows,
  toCsv,
} from '../widget/js/core/table-data.js';
import { feuille } from './fixtures/feuille.js';
import { fteHours } from '../widget/js/core/capacity.js';
import { dayOfIso } from '../widget/js/core/dates.js';

const m = buildModel(feuille());
const view = applyFilters(m, DEFAULT_FILTERS, DEFAULT_PREFS);
const rows = tableRows(m, view);
const row = (id) => rows.find((r) => r.taskId === id);
// ETP sur la capacité standard de la période : 1002 (70 h, 26 oct. → 8 nov. 2026) ≈ 1,21 ; 2010 (14 h, 2 → 6 nov.) ≈ 0,48
const F1002 = fteHours(dayOfIso('2026-10-26'), dayOfIso('2026-11-08'));
const E1002 = 70 / F1002;
const E2010 = 14 / fteHours(dayOfIso('2026-11-02'), dayOfIso('2026-11-06'));

test('une ligne par tâche du périmètre, sans doublon pour le chantier partagé', () => {
  assert.equal(rows.length, view.taskIds.size);
  assert.deepEqual(rows.map((r) => r.taskId).sort(), [1000, 1001, 1002, 1500, 2000, 2001, 2010, 3000]);
  assert.equal(rows.filter((r) => r.taskId === 2010).length, 1);
});

test('colonnes : catégorie, projet, chantier, tâche, sous-tâche, statut, dates, personnes, ETP, priorité, demandeur', () => {
  // Ordre d'affichage : Tâche, Chantier, Projet, Statut, Priorité, Personnes, dates, ETP ; puis les options
  assert.deepEqual(COLUMNS, [
    'tache',
    'chantier',
    'projet',
    'status',
    'priority',
    'people',
    'start',
    'end',
    'etp',
    'etpPO',
    'etpDA',
    'etpDS',
    'etpDE',
    'etpMgmt',
    'etpOther',
    'categorie',
    'requester',
    'tags',
    'sousTache',
  ]);
  // Par défaut : Catégorie, Demandeur et ETP par profil masqués (menu Colonnes)
  assert.deepEqual(DEFAULT_COLUMNS, [
    'tache',
    'chantier',
    'projet',
    'status',
    'priority',
    'people',
    'start',
    'end',
    'etp',
  ]);
  const r = row(1002);
  // Chaque ligne de la Feuille à sa vraie place, produit de données compris
  assert.deepEqual(
    [r.categorie, r.projet, r.chantier, r.tache, r.sousTache],
    [
      'Produit de données',
      'Données Socle Commun EDS',
      'Produit de Données Patient',
      'Ajout table FHIR Adresse',
      'réalisation',
    ],
  );
  assert.deepEqual(
    [row(1000).chantier, row(1000).tache, row(1000).sousTache],
    ['Produit de Données Patient', 'Ajout table FHIR Adresse', ''],
  );
  assert.deepEqual([row(1500).chantier, row(1500).tache], ['(sans chantier)', 'Produit sans chantier']);
  assert.ok(rows.every((x) => x.tache && x.tache !== '—'));
  assert.equal(row(2010).chantier, 'Chantier partagé');
  assert.equal(row(2010).tache, 'Tâche du chantier partagé');
  assert.equal(r.status, 'inprogress');
  assert.equal(r.people, 'Alice DE');
  assert.equal(r.etp, E1002);
  const q = row(2001);
  assert.equal(q.categorie, 'Projet');
  assert.equal(q.projet, 'ChatDPI');
  assert.equal(q.chantier, '(sans chantier)');
  assert.equal(q.priority, 'Priorité 1');
  assert.equal(r.priority, '1');
  assert.equal(q.requester, 'DIM');
  assert.equal(q.etp, null);
  assert.equal(row(2010).people, 'Eve DA');
});

test('tri : texte français, dates et ETP avec valeurs absentes toujours à la fin', () => {
  const ids = (key, dir) => sortRows(rows, key, dir).map((r) => r.taskId);
  const withEnd = ids('end', 'asc').slice(0, 3);
  assert.deepEqual(
    withEnd.map((i) => row(i).end),
    [...withEnd.map((i) => row(i).end)].sort((a, b) => a - b),
  );
  assert.equal(row(ids('end', 'asc').at(-1)).end, null);
  assert.equal(row(ids('end', 'desc').at(-1)).end, null);
  assert.equal(ids('etp', 'desc')[0], 1002);
  assert.equal(row(ids('projet', 'asc')[0]).projet, 'BI Gestion');
  assert.equal(row(ids('projet', 'desc')[0]).projet, 'Données Socle Commun EDS');
  assert.equal(sortRows(rows, '', 'asc'), rows);
  assert.notEqual(sortRows(rows, 'tache', 'asc'), rows);
  assert.equal(rows.length, 8);
});

test('CSV : BOM, séparateur « ; », guillemets doublés, ligne d’en-tête, CRLF', () => {
  const odd = [{ ...row(1002), tache: 'a;b "c"', projet: 'x\ny' }];
  const csv = toCsv(odd, ['projet', 'tache', 'sousTache', 'etp', 'start']);
  assert.ok(csv.startsWith('﻿'));
  const [head, line] = csv.slice(1).split('\r\n');
  assert.equal(head, 'Projet;Tâche;Sous-tâche;Équipe (ETP);Début');
  assert.ok(line.includes('"a;b ""c"""'));
  assert.ok(line.startsWith('"x\ny";'));
  assert.ok(line.includes(';1,2;'));
});

test('CSV : une ligne par tâche, dates au format français, statut en clair', () => {
  const csv = toCsv(rows, COLUMNS);
  const lines = csv.slice(1).split('\r\n').filter(Boolean);
  assert.equal(lines.length, 1 + rows.length);
  assert.ok(lines.some((l) => l.includes('En cours') && l.includes('26/10/2026')));
});

test('CSV : injection de formule neutralisée après espaces, retours et variantes pleine chasse', () => {
  const cell = (task) =>
    toCsv([{ ...row(1002), tache: task }], ['tache'])
      .slice(1)
      .split('\r\n')
      .slice(1)
      .join('\r\n');
  for (const bad of [' =1+1', '\n=1+1', '＝SUM(A1)', '  @x', '＋1', '－1', '＠x', ' \t-2', '\tx'])
    assert.ok(/^"?'/.test(cell(bad)), JSON.stringify(bad));
  for (const ok of ['abc', '1,5', 'a=b', 'x - y']) assert.equal(cell(ok), `${ok}\r\n`);
});

test('CSV : le garde ne vise que les colonnes de texte (ETP et dates produits par le widget)', () => {
  const csv = toCsv([{ ...row(1002), etp: -3, start: 20000 }], ['etp', 'start']);
  assert.equal(csv.slice(1).split('\r\n')[1], '-3,0;04/10/2024');
  assert.ok(!csv.includes("'"));
});

test('CSV : protection contre l’injection de formule', () => {
  for (const bad of ['=SUM(A1)', '+1', '-2', '@x', '\tx', '\rx']) {
    const csv = toCsv([{ ...row(1002), tache: bad }], ['tache']);
    const cell = csv.slice(1).split('\r\n')[1];
    assert.ok(/^"?'/.test(cell), `${JSON.stringify(bad)} → ${cell}`);
  }
  const ok = toCsv([{ ...row(1002), tache: 'Normal' }], ['tache'])
    .slice(1)
    .split('\r\n')[1];
  assert.equal(ok, 'Normal');
});

test('ETP par rôle : lignes, tri et CSV', () => {
  const r = row(1002);
  assert.deepEqual([r.etpPO, r.etpDA, r.etpDS, r.etpDE, r.etpMgmt, r.etpOther], [null, null, null, E1002, null, null]);
  assert.ok(Math.abs(row(2010).etpDA - E2010) < 1e-9);
  assert.equal(row(2001).etpDE, null);
  assert.equal(sortRows(rows, 'etpDE', 'desc')[0].taskId, 1002);
  assert.equal(sortRows(rows, 'etpDA', 'asc')[0].taskId, 2010);
  assert.equal(sortRows(rows, 'etpDE', 'asc').at(-1).etpDE, null); // absence en dernier
  const csv = toCsv([r, row(2010)], ['etp', 'etpDA', 'etpDE']);
  const [head, a, b] = csv.slice(1).split('\r\n');
  assert.equal(head, 'Équipe (ETP);ETP DA;ETP DE');
  assert.equal(a, '1,2;;1,2');
  assert.equal(b, '0,5;0,5;');
  const neg = toCsv([{ ...r, etpDE: -2 }], ['etpDE'])
    .slice(1)
    .split('\r\n')[1];
  assert.equal(neg, '-2,0'); // colonne numérique : pas de préfixe de formule
});

test('ETP Mgmt : colonne et CSV, Management ISD en « ETP Mgmt », autre domaine en « ETP autre »', () => {
  const raw = feuille();
  const model = buildModel(raw);
  const task = model.tasks.get(1002);
  task.charges = [
    { personId: 6, heures: 35 },
    { personId: 7, heures: 35 },
  ];
  const view = applyFilters(model, { ...DEFAULT_FILTERS }, { ...DEFAULT_PREFS });
  const r = tableRows(model, view).find((x) => x.taskId === 1002);
  assert.equal(r.etpMgmt, 35 / F1002);
  assert.equal(r.etpOther, 35 / F1002);
  const [head, line] = toCsv([r], ['etpDE', 'etpMgmt', 'etpOther']).slice(1).split('\r\n');
  assert.equal(head, 'ETP DE;ETP Mgmt;ETP autre');
  assert.equal(line, ';0,6;0,6');
});

test('nom du fichier', () => {
  assert.equal(csvFilename('2026-10-19'), 'roadmap-isd-2026-10-19.csv');
});

test('CSV : en-têtes Catégorie, Projet, Chantier, Tâche, Sous-tâche', () => {
  const head = toCsv([], ['categorie', 'projet', 'chantier', 'tache', 'sousTache']).slice(1).split('\r\n')[0];
  assert.equal(head, 'Catégorie;Projet;Chantier;Tâche;Sous-tâche');
});

test('sous-tâche profonde : sous-tâches intermédiaires puis titre', () => {
  const raw = feuille();
  const T = raw.tables.Tasks;
  const i = T.id.length;
  for (const c of Object.keys(T)) T[c].push(null);
  T.id[i] = 1003;
  T.titre[i] = 'Recette';
  T.parentTask[i] = 1002;
  T.Chantier[i] = 100;
  T.projet[i] = 10;
  T.statut[i] = 'todo';
  const mm = buildModel(raw);
  const r = tableRows(mm, applyFilters(mm, DEFAULT_FILTERS, DEFAULT_PREFS)).find((x) => x.taskId === 1003);
  assert.deepEqual([r.tache, r.sousTache], ['Ajout table FHIR Adresse', 'réalisation › Recette']);
  assert.deepEqual([r.level, r.own, r.parents], ['sous-tache', 'Recette', 'réalisation']);
  const t = tableRows(mm, applyFilters(mm, DEFAULT_FILTERS, DEFAULT_PREFS)).find((x) => x.taskId === 1000);
  assert.deepEqual([t.level, t.own, t.parents, t.sousTache], ['tache', 'Ajout table FHIR Adresse', '', '']);
});

test('isLate : échéance passée et tâche non terminée', () => {
  assert.equal(isLate({ end: 10, status: 'todo' }, 11), true);
  assert.equal(isLate({ end: 10, status: 'done' }, 11), false);
  assert.equal(isLate({ end: 11, status: 'todo' }, 11), false);
  assert.equal(isLate({ end: null, status: 'todo' }, 11), false);
});

test('colonnes affichables : la tâche est toujours affichée, la sous-tâche est une ligne à part', () => {
  assert.ok(!DISPLAY_COLUMNS.includes('tache'));
  assert.ok(!DISPLAY_COLUMNS.includes('sousTache'));
  assert.deepEqual(HIERARCHY_COLUMNS, ['categorie', 'projet', 'chantier', 'tache', 'sousTache']);
  // CSV : la hiérarchie complète puis les colonnes de données visibles
  assert.deepEqual(csvColumns(['etp', 'tache', 'status', 'projet']), [
    'categorie',
    'projet',
    'chantier',
    'tache',
    'sousTache',
    'status',
    'etp',
  ]);
});

test('lignes enrichies : personnes avec profil, jalon, rang de priorité', () => {
  const r = row(1002);
  assert.deepEqual(r.persons, [{ nom: 'Alice DE', role: 'DE', assigned: true, etp: E1002 }]);
  assert.equal(r.milestone, false);
  assert.deepEqual(r.byRole && Object.keys(r.byRole).sort(), ['Autre', 'DA', 'DE', 'DS', 'Mgmt', 'PO', 'total']);
  assert.deepEqual(row(2010).persons, [{ nom: 'Eve DA', role: 'DA', assigned: true, etp: E2010 }]);
  assert.equal(row(1000).byRole, null);
});

test('priorityRank : premier chiffre de la priorité, borné de 1 à 4 ; null sinon', () => {
  assert.equal(priorityRank('Priorité 1'), 1);
  assert.equal(priorityRank('P3'), 3);
  assert.equal(priorityRank('P0'), 1);
  assert.equal(priorityRank('9'), 4);
  assert.equal(priorityRank('Haute'), null);
  assert.equal(priorityRank(''), null);
});

test('personInitials : deux initiales, accents conservés, « ? » sinon', () => {
  assert.equal(personInitials('Alice DE'), 'AD');
  assert.equal(personInitials('élodie'), 'É');
  assert.equal(personInitials('Jean-Marc Durand Dupont'), 'JD');
  assert.equal(personInitials('  '), '?');
  assert.equal(personInitials(null), '?');
});

test('formatEtp : une décimale, virgule française', () => {
  assert.equal(formatEtp(0.56), '0,6');
  assert.equal(formatEtp(2), '2,0');
});

test('ordre par défaut : projet, puis chantier, puis début (sans date en dernier)', () => {
  const ordered = defaultOrder(rows);
  assert.deepEqual(
    ordered.map((r) => r.taskId),
    [2010, 3000, 2001, 2000, 1500, 1001, 1002, 1000],
  );
  // Chaque ligne garde sa hiérarchie complète (export CSV)
  assert.ok(ordered.every((r) => r.projet && r.chantier && r.tache));
  assert.equal(defaultOrder([]).length, 0);
});

test('parentTitle : tâche parente d’une sous-tâche, vide pour une tâche', () => {
  assert.equal(parentTitle(row(1002)), 'Ajout table FHIR Adresse');
  assert.equal(parentTitle(row(1000)), '');
  assert.equal(parentTitle({ level: 'sous-tache', parents: 'a › b', tache: 't' }), 'b');
});

test('pagination : 100 lignes d’emblée, le reste compté, « Afficher plus » ajoute une page au plus', () => {
  assert.equal(TABLE_PAGE, 100);
  const all = Array.from({ length: 587 }, (_, i) => i);
  const p1 = pageRows(all);
  assert.equal(p1.shown.length, 100);
  assert.deepEqual(p1.shown.slice(0, 2), [0, 1]);
  assert.deepEqual([p1.total, p1.rest, p1.next], [587, 487, 100]);
  // Pages suivantes : 200, 300, 400, 500 puis 587 (la dernière n'ajoute que 87 lignes)
  let limit = TABLE_PAGE;
  const seen = [];
  while (pageRows(all, limit).rest > 0) {
    limit = nextLimit(limit, all.length);
    seen.push(limit);
  }
  assert.deepEqual(seen, [200, 300, 400, 500, 587]);
  assert.deepEqual(pageRows(all, 500).next, 87);
  const last = pageRows(all, 587);
  assert.equal(last.shown, all, 'tout affiché : même tableau, sans copie');
  assert.deepEqual([last.rest, last.next], [0, 0]);
});

test('pagination : moins d’une page, liste vide, limites invalides, taille de page explicite', () => {
  assert.deepEqual(pageRows([1, 2, 3]), { shown: [1, 2, 3], total: 3, rest: 0, next: 0 });
  assert.deepEqual(pageRows([]), { shown: [], total: 0, rest: 0, next: 0 });
  const ten = Array.from({ length: 10 }, (_, i) => i);
  assert.equal(pageRows(ten, Number.NaN, 4).shown.length, 4);
  assert.equal(pageRows(ten, -1, 4).shown.length, 4);
  assert.equal(pageRows(ten, 2.7, 4).shown.length, 2);
  assert.equal(pageRows(ten, 0, 4).shown.length, 0);
  assert.deepEqual(pageRows(ten, 4, 4), { shown: [0, 1, 2, 3], total: 10, rest: 6, next: 4 });
  assert.equal(nextLimit(4, 10, 4), 8);
  assert.equal(nextLimit(8, 10, 4), 10);
  assert.equal(nextLimit(-5, 10, 4), 4);
  assert.equal(nextLimit(100, -1), 0);
});

test('pagination : le tri porte sur toutes les lignes, pas seulement la page affichée', () => {
  const all = Array.from({ length: 250 }, (_, i) => ({ ...row(1000), taskId: i, end: i }));
  const page = pageRows(sortRows(all, 'end', 'desc'));
  assert.deepEqual(
    page.shown.slice(0, 3).map((r) => r.taskId),
    [249, 248, 247],
  );
  assert.equal(page.total, 250);
});
