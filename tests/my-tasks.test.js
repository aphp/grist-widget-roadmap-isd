/** Vue « Mes tâches » : jour à Paris, semaines du lundi, groupes par échéance, tâches d'une personne, charge. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { dayInZone, dayOfIso, formatDayShort, isoOfDay, weekStart } from '../widget/js/core/dates.js';
import { personWeekCapacity } from '../widget/js/core/capacity.js';
import {
  groupByPeriod,
  myTasks,
  PAGE_SIZE,
  PERIODS,
  periodOf,
  placeOf,
  visibleCount,
  weekLoad,
} from '../widget/js/core/my-tasks.js';
import { feuille } from './fixtures/feuille.js';

const d = dayOfIso;
const m = buildModel(feuille());

test('jour à Paris : indépendant du fuseau du navigateur, heure d’été et d’hiver', () => {
  // Hiver (UTC+1) : 23 h 30 UTC le 25 octobre 2026 (jour du passage à l'heure d'hiver) = 0 h 30 le 26 à Paris
  assert.equal(isoOfDay(dayInZone(new Date('2026-10-25T23:30:00Z'))), '2026-10-26');
  assert.equal(isoOfDay(dayInZone(new Date('2026-10-25T22:30:00Z'))), '2026-10-25');
  // Été (UTC+2) : 22 h 30 UTC = 0 h 30 le lendemain
  assert.equal(isoOfDay(dayInZone(new Date('2026-07-14T22:30:00Z'))), '2026-07-15');
  assert.equal(isoOfDay(dayInZone(new Date('2026-07-14T21:30:00Z'))), '2026-07-14');
  // Instant en millisecondes et autre fuseau
  assert.equal(isoOfDay(dayInZone(Date.parse('2026-10-20T03:00:00Z'), 'America/New_York')), '2026-10-19');
});

test('semaines du lundi au dimanche', () => {
  assert.equal(isoOfDay(weekStart(d('2026-10-19'))), '2026-10-19'); // lundi
  assert.equal(isoOfDay(weekStart(d('2026-10-20'))), '2026-10-19'); // mardi
  assert.equal(isoOfDay(weekStart(d('2026-10-25'))), '2026-10-19'); // dimanche : encore la même semaine
  assert.equal(isoOfDay(weekStart(d('2026-10-26'))), '2026-10-26');
  assert.equal(isoOfDay(weekStart(d('2027-01-01'))), '2026-12-28'); // à cheval sur deux années
});

test('groupe d’une échéance : en retard, cette semaine, semaine prochaine, plus tard, sans date', () => {
  const tue = d('2026-10-20');
  assert.equal(periodOf(d('2026-10-19'), tue), 'late');
  assert.equal(periodOf(tue, tue), 'thisWeek'); // échéance aujourd'hui : pas encore en retard
  assert.equal(periodOf(d('2026-10-25'), tue), 'thisWeek');
  assert.equal(periodOf(d('2026-10-26'), tue), 'nextWeek');
  assert.equal(periodOf(d('2026-11-01'), tue), 'nextWeek');
  assert.equal(periodOf(d('2026-11-02'), tue), 'later');
  assert.equal(periodOf(null, tue), 'noDate');
  assert.equal(periodOf(undefined, tue), 'noDate');
  // Le dimanche, le lendemain est déjà la semaine prochaine
  const sun = d('2026-10-25');
  assert.equal(periodOf(d('2026-10-26'), sun), 'nextWeek');
  assert.equal(periodOf(d('2026-11-01'), sun), 'nextWeek');
  assert.equal(periodOf(d('2026-11-02'), sun), 'later');
  // Le lundi, la veille est en retard
  assert.equal(periodOf(d('2026-10-25'), d('2026-10-26')), 'late');
});

test('mes tâches : assignée, chargée ; terminées écartées ; chantier, projet et tâche parente', () => {
  const today = d('2026-10-20');
  const alice = myTasks(m, 1, today);
  assert.equal(alice.length, 1);
  assert.deepEqual(
    { ...alice[0], etp: Math.round(alice[0].etp * 100) / 100 },
    {
      id: 1002,
      title: 'réalisation',
      status: 'inprogress',
      start: d('2026-10-26'),
      end: d('2026-11-08'),
      subtask: true,
      period: 'later',
      lateDays: 0,
      roles: ['assignee', 'charge'],
      hours: 70,
      etp: 1,
      chantier: 'Produit de Données Patient',
      projet: 'Données Socle Commun EDS',
      parent: 'Ajout table FHIR Adresse',
    },
  );
  // Eve : tâche datée d'abord (échéance le 6 novembre : plus tard), puis la tâche sans dates (chargée seulement, sans chantier)
  const eve = myTasks(m, 5, today);
  assert.deepEqual(
    eve.map((t) => [t.id, t.period, t.roles, t.chantier, t.projet]),
    [
      [2010, 'later', ['assignee', 'charge'], 'Chantier partagé', 'ChatDPI'],
      [2001, 'noDate', ['charge'], null, 'ChatDPI'],
    ],
  );
  assert.equal(eve[1].etp, null);
  assert.equal(eve[1].hours, 7);
  // Bob : sa seule tâche est terminée ; personne absente : rien
  assert.deepEqual(myTasks(m, 2, today), []);
  assert.deepEqual(myTasks(m, null, today), []);
  // Projets masqués dans les Préférences
  assert.deepEqual(myTasks(m, 5, today, { hiddenProjects: [20] }), []);
  // En retard : nombre de jours de retard
  const late = myTasks(m, 5, d('2026-11-10'));
  assert.deepEqual(
    late.map((t) => [t.id, t.period, t.lateDays]),
    [
      [2010, 'late', 4],
      [2001, 'noDate', 0],
    ],
  );
});

test('mes tâches : responsable, sous-tâche sans chantier qui hérite de sa tâche parente', () => {
  const raw = feuille();
  const t = raw.tables.Tasks;
  const add = (row) => {
    const n = t.id.length;
    for (const k of Object.keys(row)) t[k] ??= Array(n).fill(null);
    Object.keys(t).forEach((k) => t[k].push(k in row ? row[k] : null));
  };
  add({ id: 2011, titre: 'Sous-tâche', Chantier: 0, projet: 0, parentTask: 2010, statut: 'review', Responsable: 1 });
  add({
    id: 2012,
    titre: 'Petite-fille',
    Chantier: 0,
    projet: 0,
    parentTask: 2011,
    statut: 'todo',
    assignees: ['L', 1],
  });
  const model = buildModel(raw);
  const mine = myTasks(model, 1, d('2026-10-20'));
  const sub = mine.find((x) => x.id === 2011);
  assert.deepEqual(
    [sub.roles, sub.chantier, sub.projet, sub.parent],
    [['responsable'], 'Chantier partagé', 'ChatDPI', 'Tâche du chantier partagé'],
  );
  const deep = mine.find((x) => x.id === 2012);
  assert.deepEqual([deep.chantier, deep.projet, deep.parent], ['Chantier partagé', 'ChatDPI', 'Sous-tâche']);
});

test('lieu d’une tâche : parent introuvable ou cycle sans fin évités', () => {
  const task = (id, parentId) => ({ id, parentId, chantierId: null, projectId: null, title: `T${id}` });
  const model = { tasks: new Map(), chantiers: new Map(), projects: new Map() };
  model.tasks.set(1, task(1, 2));
  model.tasks.set(2, task(2, 1));
  assert.deepEqual(placeOf(model, model.tasks.get(1)), { chantier: null, projet: null, projectId: null, parent: 'T2' });
  model.tasks.set(3, task(3, 99));
  assert.deepEqual(placeOf(model, model.tasks.get(3)), { chantier: null, projet: null, projectId: null, parent: null });
});

test('groupes : les cinq, dans l’ordre, même vides ; ordre des tâches conservé', () => {
  const items = [
    { id: 1, period: 'later' },
    { id: 2, period: 'late' },
    { id: 3, period: 'later' },
    { id: 4, period: 'inconnu' },
  ];
  const g = groupByPeriod(items);
  assert.deepEqual(
    g.map((x) => x.period),
    PERIODS,
  );
  assert.deepEqual(
    g.map((x) => x.items.map((i) => i.id)),
    [[2], [], [], [1, 3], []],
  );
});

test('« Afficher plus » : une tranche de plus par appui, jamais au-delà du total', () => {
  assert.equal(PAGE_SIZE, 20);
  assert.equal(visibleCount(50), 20);
  assert.equal(visibleCount(50, 1), 40);
  assert.equal(visibleCount(50, 2), 50);
  assert.equal(visibleCount(5, 0), 5);
  assert.equal(visibleCount(50, -3), 20);
});

test('charge de la semaine : heures réparties sur les jours de la tâche, face à la capacité', () => {
  // Semaine du 26 octobre : 7 des 14 jours de « réalisation » (70 h) → 35 h, soit 1 ETP
  const w = weekLoad(m, 1, d('2026-10-28'));
  assert.equal(isoOfDay(w.start), '2026-10-26');
  assert.equal(w.hours, 35);
  assert.equal(w.etp, 1);
  assert.equal(w.capacity, personWeekCapacity(m.people.get(1), d('2026-10-26')));
  assert.ok(w.capacityEtp > 0.7 && w.capacityEtp < 1);
  // Semaine du 2 novembre : absente toute la semaine → capacité nulle
  assert.equal(weekLoad(m, 1, d('2026-11-04')).capacity, 0);
  // Semaine sans charge (avant la tâche) ; tâche sans dates (Eve, 2001) ignorée
  assert.equal(weekLoad(m, 1, d('2026-10-20')).hours, 0);
  assert.equal(weekLoad(m, 5, d('2026-11-03')).hours, 14);
  assert.equal(weekLoad(m, 999, d('2026-10-20')), null);
});

test('date courte : sans l’année de référence, avec une autre année ; vide → tiret', () => {
  assert.equal(formatDayShort(d('2026-11-03'), d('2026-10-20')), '3 nov.');
  assert.equal(formatDayShort(d('2027-01-05'), d('2026-10-20')), '5 janv. 2027');
  assert.equal(formatDayShort(d('2027-01-05')), '5 janv. 2027');
  assert.equal(formatDayShort(null, d('2026-10-20')), '—');
});
