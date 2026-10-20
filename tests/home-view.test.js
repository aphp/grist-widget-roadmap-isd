/** Vue d'accueil par profil (P-UX-2). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultHomeView,
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

test('vue d’accueil proposée : Mes tâches (DE, DS, DA), Gantt (PO), Synthèse (Management)', () => {
  assert.deepEqual([de, ds, da, po, mg, other, null].map(defaultHomeView), [
    'mytasks',
    'mytasks',
    'mytasks',
    'gantt',
    'synthesis',
    'mytasks',
    'mytasks',
  ]);
  // Périmètre : Mes chantiers pour tous les profils, sauf le Management (tout) ; plus de périmètre « Mes tâches »
  assert.deepEqual([de, da, po, mg, null].map(defaultScope), [
    'chantiers',
    'chantiers',
    'chantiers',
    'all',
    'chantiers',
  ]);
  assert.deepEqual(SCOPES, ['all', 'chantiers']);
  // Toutes les vues proposées sont des onglets ; « Mes tâches » est le premier
  for (const p of [de, po, mg]) assert.ok(TABS.includes(defaultHomeView(p)));
  assert.equal(TABS[0], 'mytasks');
});

test('vue d’accueil enregistrée : onglet ou « dernière vue » gardés ; ancienne préférence avec personne → dernière vue', () => {
  assert.equal(sanitizeHomeView('gantt', 1, TABS), 'gantt');
  assert.equal(sanitizeHomeView(HOME_LAST, null, TABS), HOME_LAST);
  assert.equal(sanitizeHomeView(null, null, TABS), null);
  assert.equal(sanitizeHomeView('disparue', null, TABS), null);
  // Migration : quelqu'un qui avait déjà choisi « Je suis… » garde l'ouverture sur sa dernière vue
  assert.equal(sanitizeHomeView(null, 4, TABS), HOME_LAST);
  assert.equal(sanitizeHomeView('disparue', 4, TABS), HOME_LAST);
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

test('premier choix : vue d’accueil du profil ouverte ; ensuite rien d’imposé', () => {
  assert.deepEqual(firstChoicePrefs({ homeView: null }, de), { homeView: 'mytasks', view: 'mytasks' });
  assert.deepEqual(firstChoicePrefs({}, po), { homeView: 'gantt', view: 'gantt', ganttLevel: 'tache' });
  assert.deepEqual(firstChoicePrefs({ homeView: null }, mg), { homeView: 'synthesis', view: 'synthesis' });
  assert.deepEqual(firstChoicePrefs({ homeView: HOME_LAST }, de), {});
  assert.deepEqual(firstChoicePrefs({ homeView: 'table' }, po), {});
});
