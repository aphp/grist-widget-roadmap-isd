import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import {
  activeFilterChips,
  applyFilters,
  DEFAULT_FILTERS,
  DEFAULT_PREFS,
  loadPrefs,
} from '../widget/js/core/filters.js';
import { PROFILE_KEYS, profileKey } from '../widget/js/core/kanban-data.js';
import { portfolioKpis, summarizeWeeks, weeklyLoadByProfile } from '../widget/js/core/portfolio-data.js';
import { personWeekCapacity } from '../widget/js/core/capacity.js';
import { teamLoad, teamTotals } from '../widget/js/core/team-data.js';
import { dayOfIso } from '../widget/js/core/dates.js';
import { PROFILES } from '../widget/js/ui/kit.js';
import { label } from '../widget/js/labels.js';
import { feuille } from './fixtures/feuille.js';

/** Feuille de test où Fanny (6, Management ISD) et Gus (7, Management BNDMR) sont chargés 14 h sur la tâche 1002. */
function withManagers() {
  const raw = feuille();
  const t = raw.tables.Tasks;
  t.charges[t.id.indexOf(1002)] = '[{"teamId":1,"heures":70},{"teamId":6,"heures":14},{"teamId":7,"heures":14}]';
  return buildModel(raw);
}
const m = withManagers();
const view = applyFilters(m, DEFAULT_FILTERS, DEFAULT_PREFS);

test('profils : PO, DA, DS, DE puis Mgmt (Management actif de l’équipe ISD seulement)', () => {
  assert.deepEqual(PROFILE_KEYS, ['PO', 'DA', 'DS', 'DE', 'Mgmt']);
  assert.deepEqual(PROFILES, PROFILE_KEYS);
  const key = (id) => profileKey(m.people.get(id), m);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(key), ['DE', 'PO', null, null, 'DA', 'Mgmt', null]);
  assert.equal(profileKey(undefined, m), null);
  // Management ISD inactif : plus de profil
  const raw = feuille();
  raw.tables.Team.actif[raw.tables.Team.id.indexOf(6)] = false;
  const off = buildModel(raw);
  assert.equal(profileKey(off.people.get(6), off), null);
});

test('filtre Profil « Mgmt » : tâches où un Management ISD est impliqué ; libellés « Mgmt » et « Management »', () => {
  assert.deepEqual([...applyFilters(m, { ...DEFAULT_FILTERS, profile: 'Mgmt' }, DEFAULT_PREFS).taskIds], [1002]);
  // Gus (Management d'un autre Domaine) seul sur une tâche : pas retenue
  const model = withManagers();
  model.tasks.get(3000).assignees = [7];
  model.tasks.get(3000).charges = [];
  model.tasks.get(3000).responsable = null;
  const ids = applyFilters(model, { ...DEFAULT_FILTERS, profile: 'Mgmt', includeOutOfScope: true }, DEFAULT_PREFS);
  assert.equal(ids.taskIds.has(3000), false);
  assert.deepEqual(activeFilterChips({ ...DEFAULT_FILTERS, profile: 'Mgmt' }, m), [
    { field: 'profile', label: 'Mgmt' },
  ]);
  assert.equal(label('profile.Mgmt'), 'Mgmt');
  // Libellé court « Mgmt » (options, colonnes) ; complet « Management » (étiquette, légende, infobulle), comme
  // les badges de rôle (roleSpan)
  assert.equal(label('profile.group.Mgmt'), label('profile.group.Management'));
});

test('préférences : profil « Mgmt » conservé, valeur inconnue retirée', () => {
  const load = (v) => loadPrefs({ getItem: () => JSON.stringify(v), setItem() {} });
  assert.equal(load({ filters: { profile: 'Mgmt' } }).filters.profile, 'Mgmt');
  assert.equal(load({ filters: { profile: 'Management' } }).filters.profile, null);
  assert.equal(load({ filters: { profile: 'DE' } }).filters.profile, 'DE');
});

test('Portfolio : personnes Mgmt dans les indicateurs, charge et capacité Mgmt par semaine', () => {
  assert.deepEqual(portfolioKpis(m, view).personnes, { total: 4, PO: 1, DA: 1, DS: 0, DE: 1, Mgmt: 1 });
  const week = dayOfIso('2026-10-26');
  const rows = weeklyLoadByProfile(m, view.taskIds, week, 2);
  // 14 h sur 14 jours (26 oct. – 8 nov.) : 7 h par semaine ; Gus (BNDMR) ignoré
  assert.deepEqual(
    rows.map((r) => r.Mgmt),
    [7, 7],
  );
  // Capacité : mêmes règles que les autres profils (35 h par défaut, fériés, indisponibilités)
  const fanny = m.people.get(6);
  for (const r of rows) assert.ok(Math.abs(r.capacity.Mgmt - personWeekCapacity(fanny, r.weekStart)) < 1e-6);
  assert.ok(rows[0].capacity.Mgmt > 0);
  assert.equal(summarizeWeeks(rows).Mgmt.loadedWeeks, 2);
});

test('Plan de charge : ligne et total « Mgmt » pour le Management ISD', () => {
  const rows = teamLoad(m, view.taskIds, ['2026-10', '2026-11']);
  const fanny = rows.find((r) => r.personId === 6);
  assert.equal(fanny.role, 'Mgmt');
  assert.equal(
    fanny.months.reduce((s, c) => s + c.load, 0),
    14,
  );
  assert.equal(
    rows.some((r) => r.personId === 7),
    false,
  );
  const total = teamTotals(rows).find((t) => t.role === 'Mgmt');
  assert.equal(total.count, 1);
});
