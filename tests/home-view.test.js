/** Vue d'accueil par profil (P-UX-2). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultScope,
  firstChoicePrefs,
  HOME_LAST,
  initialView,
  profileOf,
  sanitizeHomeView,
  SCOPES,
} from '../widget/js/core/home-view.js';
import { DEFAULT_PREFS } from '../widget/js/core/filters.js';
import { TABS } from '../widget/js/ui/kit.js';

const de = { role: 'DE', roleText: 'DE' };
const ds = { role: 'DS', roleText: 'DS' };
const da = { role: 'DA', roleText: 'DA' };
const po = { role: 'PO', roleText: 'PO Data' };
const mg = { role: null, roleText: 'Management' };
const other = { role: null, roleText: 'Stagiaire' };

test('profil : rôle ISD, Management, sinon aucun', () => {
  assert.deepEqual([de, po, mg, other, null, undefined].map(profileOf), ['DE', 'PO', 'Management', null, null, null]);
});

test('périmètre proposé par profil ; onglets', () => {
  // Périmètre : Mes chantiers pour tous les profils, sauf le Management (tout) ; plus de périmètre « Mes tâches »
  assert.deepEqual([de, da, po, mg, null].map(defaultScope), [
    'chantiers',
    'chantiers',
    'chantiers',
    'all',
    'chantiers',
  ]);
  assert.deepEqual(SCOPES, ['all', 'chantiers']);
  // « Mes tâches » est le premier onglet
  assert.equal(TABS[0], 'mytasks');
});

test('vue d’accueil enregistrée : onglet ou « dernière vue » gardés, sinon null', () => {
  assert.equal(sanitizeHomeView('gantt', TABS), 'gantt');
  assert.equal(sanitizeHomeView(HOME_LAST, TABS), HOME_LAST);
  assert.equal(sanitizeHomeView(null, TABS), null);
  assert.equal(sanitizeHomeView('disparue', TABS), null);
});

test('onglet à l’ouverture : paramètre vue=, sinon vue d’accueil choisie, sinon Gantt (dernière vue jamais restaurée)', () => {
  assert.equal(initialView({ homeView: null, view: 'gantt' }, '', TABS), 'gantt');
  assert.equal(initialView({ homeView: null, view: 'synthesis' }, '', TABS), 'gantt');
  assert.equal(initialView({ homeView: HOME_LAST, view: 'table' }, '', TABS), 'gantt');
  assert.equal(initialView({ homeView: 'mytasks', view: 'table' }, '', TABS), 'mytasks');
  assert.equal(initialView({ homeView: null, view: 'synthesis' }, '?vue=kanban', TABS), 'kanban');
  assert.equal(initialView({ homeView: 'mytasks', view: 'table' }, '?edition=essai&vue=team', TABS), 'team');
  assert.equal(initialView({ homeView: null, view: 'synthesis' }, '?vue=inconnue', TABS), 'gantt');
  assert.equal(initialView({ homeView: null, view: 'synthesis' }, '?vue=', TABS), 'gantt');
  assert.equal(initialView({ homeView: 'disparue', view: 'disparue' }, null, TABS), 'gantt');
  assert.equal(DEFAULT_PREFS.view, 'gantt');
});

test('premier choix : plus de vue d’accueil posée ; le PO ouvre le Gantt au niveau des tâches, une seule fois', () => {
  const first = { me: null, mePrompted: false, homeView: null };
  for (const p of [de, ds, da, mg, other]) assert.deepEqual(firstChoicePrefs(first, p), {});
  assert.deepEqual(firstChoicePrefs(first, po), { ganttLevel: 'tache' });
  assert.deepEqual(firstChoicePrefs({ me: 3, mePrompted: true }, po), {});
  assert.deepEqual(firstChoicePrefs({ me: null, mePrompted: true }, po), {});
});

test('onglet Portfolio retiré : vue et vue d’accueil « portfolio » enregistrées → Gantt, ?vue=portfolio → Gantt', async () => {
  const { loadPrefs } = await import('../widget/js/core/filters.js');
  assert.equal(TABS.includes('portfolio'), false);
  const load = (v) => loadPrefs({ getItem: () => JSON.stringify(v) });
  const p = load({ view: 'portfolio', homeView: 'portfolio', homeViewV: 2, portfolioTab: 'load', portfolioMonths: 18 });
  assert.equal(p.view, 'gantt');
  assert.equal(p.homeView, null);
  for (const k of ['portfolioTab', 'portfolioStart', 'portfolioMonths']) assert.equal(k in p, false, k);
  assert.equal(sanitizeHomeView(p.homeView, TABS), null);
  assert.equal(initialView({ homeView: p.homeView }, '?vue=portfolio', TABS), 'gantt');
  assert.equal(initialView({ homeView: 'portfolio' }, '', TABS), 'gantt');
  // Les autres vues enregistrées restent
  assert.equal(load({ view: 'stats', homeView: 'stats', homeViewV: 2 }).homeView, 'stats');
});
