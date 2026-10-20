import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { dayOfIso } from '../widget/js/core/dates.js';
import {
  DEFAULT_WEEKLY_HOURS,
  filterUsers,
  groupUsersByRole,
  inIsdTeam,
  isdTeamSummary,
  isdDomain,
  isValidEmail,
  personItems,
  pickerGroups,
  roleShort,
  roleSummary,
  roleTone,
  ROLE_ORDER,
  upcomingUnavailability,
} from '../widget/js/core/team-directory.js';
import { feuille } from './fixtures/feuille.js';

const m = buildModel(feuille());
const today = dayOfIso('2026-10-19');
const ISD = 'Ingénierie et sciences des données - ISD';
const ids = (rows) => rows.map((r) => r.id);

test('rôles : liste de choix de la Feuille, « PO » pour « PO Data »', () => {
  assert.deepEqual(m.roles, ['DE', 'DS', 'DA', 'PO Data', 'Management']);
  assert.equal(roleShort('PO Data'), 'PO');
  assert.equal(roleShort('Management'), 'Management');
  assert.equal(roleShort(''), '');
  assert.equal(roleShort(undefined), '');
});

test('rôles sans liste de choix : valeurs observées', () => {
  const raw = feuille();
  delete raw.choices['Team.role'];
  assert.deepEqual(buildModel(raw).roles, ['DE', 'PO Data', 'DS', 'DA', 'Management']);
});

test('rôles de l’équipe ISD : personnes actives et capacité hebdo (35 h par défaut), ordre de la liste de choix', () => {
  const r = roleSummary(m);
  assert.deepEqual(
    r.map((x) => [x.role, x.label, x.active, x.hours]),
    [
      ['DE', 'DE', 1, DEFAULT_WEEKLY_HOURS],
      ['DA', 'DA', 1, 28],
      ['PO Data', 'PO', 1, 35],
      ['Management', 'Management', 1, 35], // Fanny (ISD) ; Gus, Management hors ISD, n'est pas compté
    ],
  );
  // DS : Carl est inactif ; aucune ligne « sans rôle »
  assert.ok(!r.some((x) => x.role === 'DS' || x.role === ''));
  assert.deepEqual(roleSummary({ people: new Map() }), []);
});

test('équipe ISD : Domaine portant « ISD », sans repli sur le plus représenté en profils ISD', () => {
  assert.equal(isdDomain(m), ISD);
  const raw = feuille();
  raw.tables.Team.Domaine = raw.tables.Team.Domaine.map((d) => (d === ISD ? 'Données' : d));
  assert.equal(isdDomain(buildModel(raw)), null);
  assert.equal(isdDomain({ people: new Map() }), null);
});

test('synthèse de l’équipe ISD : effectif actif, rôles, capacité', () => {
  const s = isdTeamSummary(m);
  assert.equal(s.domaine, ISD);
  assert.equal(s.count, 4);
  assert.deepEqual(
    s.roles.map((r) => [r.label, r.n]),
    [
      ['DE', 1],
      ['DA', 1],
      ['PO', 1],
      ['Management', 1],
    ],
  );
  assert.equal(s.hours, 35 + 35 + 28 + 35);
  assert.ok(!('unavailableSoon' in s));
  assert.equal(s.noRole, 0);
});

test('équipe ISD : personnes sans rôle comptées à part, jamais en ligne de rôle', () => {
  const raw = feuille();
  raw.tables.Team.Domaine = raw.tables.Team.Domaine.map((d, i) => (raw.tables.Team.id[i] === 4 ? ISD : d));
  const mm = buildModel(raw);
  assert.equal(isdTeamSummary(mm).noRole, 1);
  assert.equal(isdTeamSummary(mm).count, 5);
  assert.ok(!roleSummary(mm).some((r) => r.role === ''));
  assert.ok(ids(filterUsers(mm)).includes(4));
});

test('rôles : valeurs saisies hors de la liste de choix ajoutées après celle-ci', () => {
  const raw = feuille();
  raw.tables.Team.role = raw.tables.Team.role.map((r, i) => (raw.tables.Team.id[i] === 6 ? 'Chef de projet' : r));
  assert.deepEqual(
    roleSummary(buildModel(raw)).map((r) => r.role),
    ['DE', 'DA', 'PO Data', 'Chef de projet'],
  );
});

test('utilisateurs : équipe ISD seulement (profil ISD ou Domaine ISD), actifs, triés par nom', () => {
  assert.deepEqual(ids(filterUsers(m)), [1, 2, 5, 6]);
  assert.deepEqual(ids(filterUsers(m, { includeInactive: true })), [1, 2, 3, 5, 6]);
  assert.equal(inIsdTeam({ role: null, domaine: 'BNDMR' }, ISD), false);
  assert.equal(inIsdTeam({ role: null, domaine: 'X' }, null), false);
});

test('utilisateurs : filtre par rôle, dans l’équipe ISD', () => {
  assert.deepEqual(ids(filterUsers(m, { role: 'Management' })), [6]); // Gus (hors ISD) exclu
  assert.deepEqual(ids(filterUsers(m, { role: 'DS' })), []);
  assert.deepEqual(ids(filterUsers(m, { role: 'DS', includeInactive: true })), [3]);
});

test('utilisateurs : recherche sans accents ni casse (nom, adresse, rôle, équipe)', () => {
  assert.deepEqual(ids(filterUsers(m, { query: 'ALICE' })), [1]);
  assert.deepEqual(ids(filterUsers(m, { query: 'exemple.fr' })), [1]);
  assert.deepEqual(ids(filterUsers(m, { query: 'po data' })), [2]);
  assert.deepEqual(ids(filterUsers(m, { query: 'ingenierie' })), [1, 6]);
  assert.deepEqual(ids(filterUsers(m, { query: 'bndmr' })), []);
});

test('utilisateur : adresse valide ou non, N+1 résolu, capacité, libellé de rôle', () => {
  const all = filterUsers(m, { includeInactive: true });
  const get = (id) => all.find((p) => p.id === id);
  assert.equal(get(1).emailValid, true);
  assert.deepEqual(get(1).n1, { id: 2, nom: 'Bob PO' });
  assert.equal(get(1).capaciteHebdo, null);
  assert.equal(get(2).emailValid, false);
  assert.equal(get(2).roleLabel, 'PO');
  assert.equal(get(2).n1, null);
  assert.equal(get(5).capaciteHebdo, 28);
  assert.equal(get(5).email, '');
  assert.equal(get(3).actif, false);
});

test('adresses électroniques', () => {
  assert.equal(isValidEmail('a.b@aphp.fr'), true);
  assert.equal(isValidEmail(' a@b.fr '), true);
  for (const bad of ['', 'pas-une-adresse', 'a@b', 'a b@c.fr', 'javascript:x@y.fr', '"x"@y.fr', null, 3])
    assert.equal(isValidEmail(bad), false, String(bad));
});

test('indisponibilités à venir : passées exclues, en cours incluses, triées', () => {
  const bob = m.people.get(2);
  assert.deepEqual(upcomingUnavailability(bob, today), []);
  assert.equal(upcomingUnavailability(bob, dayOfIso('2026-03-04')).length, 1);
  const eve = upcomingUnavailability(m.people.get(5), today);
  assert.equal(eve.length, 1);
  assert.equal(eve[0].type, 'Formation');
  assert.deepEqual(upcomingUnavailability({}, today), []);
  const p = {
    unavailability: [
      { start: 30, end: 40 },
      { start: 10, end: 20 },
      { start: 1, end: 5 },
    ],
  };
  assert.deepEqual(
    upcomingUnavailability(p, 15).map((u) => u.start),
    [10, 30],
  );
});

test('éléments d’Alice : tâche chargée en cours, chantiers responsable et chargé', () => {
  const { tasks, chantiers } = personItems(m, 1, today);
  assert.deepEqual(
    tasks.map((t) => [t.id, t.roles]),
    [[1002, ['assignee', 'charge']]],
  );
  assert.equal(tasks[0].hours, 70);
  assert.ok(tasks[0].etp > 0);
  assert.deepEqual(
    chantiers.map((c) => [c.id, c.roles]),
    [
      [100, ['charge']],
      [200, ['responsable']],
    ],
  );
});

test('éléments : tâches terminées ou échues exclues, tâches sans dates incluses', () => {
  // Bob : tâche 1001 terminée → exclue
  assert.ok(!personItems(m, 2, today).tasks.some((t) => t.id === 1001));
  // Eve : 2001 (sans dates, chargée) et 2010 (assignée, à venir)
  assert.deepEqual(
    personItems(m, 5, today).tasks.map((t) => t.id),
    [2010, 2001],
  );
  assert.equal(personItems(m, 5, today).tasks.find((t) => t.id === 2001).etp, null);
  // Après l’échéance de 2010, seule 2001 reste
  assert.deepEqual(
    personItems(m, 5, dayOfIso('2027-01-01')).tasks.map((t) => t.id),
    [2001],
  );
  assert.deepEqual(personItems(m, 999, today), { tasks: [], chantiers: [] });
});

test('chantiers clos exclus', () => {
  const m2 = buildModel(feuille());
  m2.chantiers.get(200).status = 'Terminé';
  assert.ok(!personItems(m2, 1, today).chantiers.some((c) => c.id === 200));
});

test('ordre des rôles : DE, DA, DS, PO, Management, puis la liste de choix, puis hors liste', () => {
  assert.deepEqual(ROLE_ORDER, ['DE', 'DA', 'DS', 'PO Data', 'Management']);
  const raw = feuille();
  raw.choices['Team.role'] = ['Management', 'Architecte', 'PO Data', 'DS', 'DA', 'DE'];
  raw.tables.Team.role = raw.tables.Team.role.map((r, i) =>
    raw.tables.Team.id[i] === 6 ? 'Architecte' : raw.tables.Team.id[i] === 4 ? 'Zèbre' : r,
  );
  raw.tables.Team.Domaine = raw.tables.Team.Domaine.map((d, i) => ([4, 6].includes(raw.tables.Team.id[i]) ? ISD : d));
  assert.deepEqual(
    roleSummary(buildModel(raw)).map((r) => r.role),
    ['DE', 'DA', 'PO Data', 'Architecte', 'Zèbre'], // Management : Fanny (id 6) devient Architecte
  );
});

test('teintes des rôles', () => {
  assert.deepEqual(['DE', 'DA', 'DS', 'PO Data', 'Management', 'Architecte', '', null, undefined].map(roleTone), [
    'de',
    'da',
    'ds',
    'po',
    'mgmt',
    'other',
    'none',
    'none',
    'none',
  ]);
});

const sections = (groups) => groups.map((g) => [g.role, ids(g.people)]);

test('groupes par rôle : ordre DE, DA, DS, PO, Management, personnes triées, effectif et capacité', () => {
  const g = groupUsersByRole(m);
  assert.deepEqual(sections(g), [
    ['DE', [1]],
    ['DA', [5]],
    ['PO Data', [2]],
    ['Management', [6]],
  ]);
  assert.deepEqual(
    g.map((x) => [x.label, x.tone, x.count, x.inactive, x.hours]),
    [
      ['DE', 'de', 1, 0, DEFAULT_WEEKLY_HOURS],
      ['DA', 'da', 1, 0, 28],
      ['PO', 'po', 1, 0, 35],
      ['Management', 'mgmt', 1, 0, 35],
    ],
  );
  assert.deepEqual(groupUsersByRole({ people: new Map() }), []);
});

test('groupes par rôle : « Sans rôle » en dernier, seulement s’il y a quelqu’un', () => {
  const raw = feuille();
  raw.tables.Team.Domaine = raw.tables.Team.Domaine.map((d, i) => (raw.tables.Team.id[i] === 4 ? ISD : d));
  const g = groupUsersByRole(buildModel(raw));
  const last = g.at(-1);
  assert.equal(last.role, '');
  assert.equal(last.label, '');
  assert.equal(last.tone, 'none');
  assert.deepEqual(ids(last.people), [4]);
  assert.ok(!groupUsersByRole(m).some((x) => x.role === ''));
});

test('groupes par rôle : inactifs exclus par défaut, inclus sur demande mais hors capacité', () => {
  assert.ok(!groupUsersByRole(m).some((x) => x.role === 'DS'));
  const ds = groupUsersByRole(m, { includeInactive: true }).find((x) => x.role === 'DS');
  assert.deepEqual(ids(ds.people), [3]);
  assert.equal(ds.count, 1);
  assert.equal(ds.inactive, 1);
  assert.equal(ds.hours, 0);
  assert.deepEqual(
    groupUsersByRole(m, { includeInactive: true }).map((x) => x.role),
    ['DE', 'DA', 'DS', 'PO Data', 'Management'],
  );
});

test('groupes par rôle : recherche et filtre de rôle ne gardent que les sections non vides', () => {
  assert.deepEqual(sections(groupUsersByRole(m, { query: 'alice' })), [['DE', [1]]]);
  assert.deepEqual(sections(groupUsersByRole(m, { query: 'INGENIERIE' })), [
    ['DE', [1]],
    ['Management', [6]],
  ]);
  assert.deepEqual(groupUsersByRole(m, { query: 'aucun-resultat' }), []);
  assert.deepEqual(sections(groupUsersByRole(m, { role: 'DA' })), [['DA', [5]]]);
  assert.deepEqual(groupUsersByRole(m, { role: 'DS' }), []);
});

test('pickerGroups : profils ISD puis Management du Domaine ISD, sans Management des autres domaines ni inactifs', () => {
  const groups = pickerGroups(m);
  assert.deepEqual(
    groups.map((g) => g.role),
    ['PO', 'DA', 'DE', 'Management'], // DS vide (Carl inactif)
  );
  const mgmt = groups.find((g) => g.role === 'Management');
  assert.deepEqual(ids(mgmt.people), [6]); // Fanny (Domaine ISD) ; Gus (BNDMR) exclu
  assert.equal(
    groups.flatMap((g) => g.people).some((p) => p.id === 3),
    false,
  ); // Carl inactif
});

test('pickerGroups : Management inactif exclu, groupe vide omis', () => {
  const raw = feuille();
  const model = buildModel(raw);
  model.people.get(6).actif = false;
  assert.equal(
    pickerGroups(model).some((g) => g.role === 'Management'),
    false,
  );
});
