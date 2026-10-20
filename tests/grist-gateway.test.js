import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accessRefused,
  createGateway,
  isAccessLevelError,
  REQUIRED,
  USER_TABLES,
} from '../widget/js/core/grist-gateway.js';

function fakeGrist(tables) {
  const calls = [];
  return {
    calls,
    onRecords(cb) {
      this._cb = cb;
    },
    docApi: {
      async fetchTable(name) {
        calls.push(name);
        if (!(name in tables)) throw new Error(`KeyError ${name}`);
        return tables[name];
      },
      async listTables() {
        return Object.keys(tables);
      },
    },
  };
}
const full = (t) => Object.fromEntries([['id', [1]], ...REQUIRED[t].map((c) => [c, [null]])]);

test('fetchAll lit les 5 tables et les choix, sans problème', async () => {
  const g = fakeGrist({
    Team: full('Team'),
    Projects: full('Projects'),
    Chantiers: full('Chantiers'),
    Tasks: full('Tasks'),
    Disponibilites: full('Disponibilites'),
    _grist_Tables: { id: [1, 2], tableId: ['Tasks', 'Chantiers'] },
    _grist_Tables_column: {
      id: [1, 2, 3],
      parentId: [1, 2, 1],
      colId: ['statut', 'Statut', 'titre'],
      widgetOptions: ['{"choices":["todo","inprogress","done"]}', '{"choices":["À cadrer","Terminé"]}', ''],
    },
  });
  const raw = await createGateway(g).fetchAll();
  assert.deepEqual(raw.problems, []);
  assert.deepEqual(raw.choices['Tasks.statut'], ['todo', 'inprogress', 'done']);
  assert.deepEqual(raw.choices['Chantiers.Statut'], ['À cadrer', 'Terminé']);
});

test('colonne renommée et table optionnelle absente : signalées, pas d’exception', async () => {
  const tasks = full('Tasks');
  delete tasks.charges;
  const g = fakeGrist({ Team: full('Team'), Projects: full('Projects'), Chantiers: full('Chantiers'), Tasks: tasks });
  const raw = await createGateway(g).fetchAll();
  assert.deepEqual(raw.problems, [
    { table: 'Tasks', column: 'charges', optional: false },
    { table: 'Disponibilites', column: null, optional: true, error: 'KeyError Disponibilites' },
  ]);
  assert.deepEqual(raw.choices, {});
  assert.ok(raw.tables.Tasks);
});

test('la passerelle n’expose aucune écriture (lecture, ligne, droits, changements)', () => {
  const gw = createGateway(fakeGrist({}));
  assert.deepEqual(Object.keys(gw).sort(), ['fetchAccess', 'fetchAll', 'fetchRow', 'fetchTableRaw', 'onChange']);
});

test('fetchAll lit aussi le type des colonnes (contrôle de la liste blanche)', async () => {
  const g = fakeGrist({
    Team: full('Team'),
    Projects: full('Projects'),
    Chantiers: full('Chantiers'),
    Tasks: full('Tasks'),
    _grist_Tables: { id: [1], tableId: ['Tasks'] },
    _grist_Tables_column: {
      id: [1, 2],
      parentId: [1, 1],
      colId: ['titre', 'progression'],
      type: ['Text', 'Numeric'],
      isFormula: [false, true],
      widgetOptions: ['', ''],
    },
  });
  const raw = await createGateway(g).fetchAll();
  assert.deepEqual(raw.columns, {
    'Tasks.titre': { type: 'Text', isFormula: false },
    'Tasks.progression': { type: 'Numeric', isFormula: true },
  });
});

test('colonne « vide » (formule sans formule, isFormula à 1 dans une photo) : signalée vide', async () => {
  const g = fakeGrist({
    Team: full('Team'),
    Projects: full('Projects'),
    Chantiers: full('Chantiers'),
    Tasks: full('Tasks'),
    _grist_Tables: { id: [2], tableId: ['Team'] },
    _grist_Tables_column: {
      id: [1, 2, 3],
      parentId: [2, 2, 2],
      colId: ['capaciteHebdo', 'nom', 'calc'],
      type: ['Numeric', 'Text', 'Any'],
      isFormula: [1, 0, true],
      formula: ['', '', '$nom'],
      widgetOptions: ['', '', ''],
    },
  });
  const raw = await createGateway(g).fetchAll();
  assert.deepEqual(raw.columns, {
    'Team.capaciteHebdo': { type: 'Numeric', isFormula: true, empty: true },
    'Team.nom': { type: 'Text', isFormula: false },
    'Team.calc': { type: 'Any', isFormula: true },
  });
});

test('métadonnées sans type : columns = null (le writer retire alors toutes les colonnes)', async () => {
  const g = fakeGrist({
    _grist_Tables: { id: [1], tableId: ['Tasks'] },
    _grist_Tables_column: { id: [1], parentId: [1], colId: ['titre'], widgetOptions: [''] },
  });
  const raw = await createGateway(g).fetchAll();
  assert.equal(raw.columns, null);
});

test('fetchRow relit une ligne en valeurs du modèle ; null si elle a disparu', async () => {
  const g = fakeGrist({
    Tasks: {
      id: [5, 6],
      titre: ['A', 'B'],
      dateDebut: [86400 * 20000, null],
      assignees: [['L', 1, 2], null],
      Responsable: [0, 3],
    },
  });
  const gw = createGateway(g);
  const row = await gw.fetchRow('Tasks', 5);
  assert.equal(row.titre, 'A');
  assert.equal(row.dateDebut, 20000);
  assert.deepEqual(row.assignees, [1, 2]);
  assert.equal(row.Responsable, null);
  assert.equal((await gw.fetchRow('Tasks', 6)).Responsable, 3);
  assert.equal(await gw.fetchRow('Tasks', 99), null);
});

test('fetchAccess : jeton en lecture seule, identifiant du document et niveau d’accès', async () => {
  const g = fakeGrist({});
  let asked = null;
  g.docApi.getAccessToken = async (o) => {
    asked = o;
    return { token: 'x y', baseUrl: 'https://grist.exemple/api/docs/doc-essai-1' };
  };
  let url = '';
  const ok = async (u) => {
    url = u;
    return { ok: true, json: async () => ({ access: 'editors' }) };
  };
  assert.deepEqual(await createGateway(g).fetchAccess(ok), { docId: 'doc-essai-1', access: 'editors' });
  assert.deepEqual(asked, { readOnly: true });
  assert.equal(url, 'https://grist.exemple/api/docs/doc-essai-1?auth=x%20y');
  const weird = async () => ({ ok: true, json: async () => ({ access: 'admin' }) });
  assert.equal((await createGateway(g).fetchAccess(weird)).access, null);
  const ko = async () => ({ ok: false });
  assert.deepEqual(await createGateway(g).fetchAccess(ko), { docId: 'doc-essai-1', access: null });
  const boom = async () => {
    throw new Error('CSP');
  };
  assert.deepEqual(await createGateway(g).fetchAccess(boom), { docId: 'doc-essai-1', access: null });
  g.docApi.getAccessToken = async () => {
    throw new Error('non disponible');
  };
  assert.deepEqual(await createGateway(g).fetchAccess(ok), { docId: null, access: null });
});

test('onChange regroupe les notifications (anti-rebond)', async () => {
  const g = fakeGrist({});
  let n = 0;
  createGateway(g).onChange(() => n++, 20);
  g._cb();
  g._cb();
  g._cb();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(n, 1);
});

test('table refusée : le message de Grist est conservé dans problems.error', async () => {
  const g = fakeGrist({ Team: full('Team'), Projects: full('Projects'), Chantiers: full('Chantiers') });
  g.docApi.fetchTable = async (name) => {
    if (name === 'Tasks') throw new Error('Blocked by table read access rules');
    if (name === 'Disponibilites') throw 'refus brut';
    return full(name);
  };
  const raw = await createGateway(g).fetchAll();
  const byTable = Object.fromEntries(raw.problems.map((p) => [p.table, p]));
  assert.deepEqual(byTable.Tasks, {
    table: 'Tasks',
    column: null,
    optional: false,
    error: 'Blocked by table read access rules',
  });
  assert.equal(byTable.Disponibilites.error, 'refus brut');
});

test('isAccessLevelError : niveau d’accès oui, règles d’accès de la Feuille non', () => {
  assert.equal(isAccessLevelError('Access not granted'), true);
  assert.equal(isAccessLevelError('Blocked by table read access rules'), false);
  assert.equal(isAccessLevelError('KeyError Tasks'), false);
});

test('accessRefused seulement si toutes les tables indispensables sont refusées pour niveau d’accès', () => {
  const refused = (t, error = 'Access not granted') => ({ table: t, column: null, optional: false, error });
  assert.deepEqual([...USER_TABLES], ['Team', 'Projects', 'Chantiers', 'Tasks']);
  assert.equal(accessRefused(USER_TABLES.map((t) => refused(t))), true);
  assert.equal(accessRefused(USER_TABLES.slice(1).map((t) => refused(t))), false);
  assert.equal(accessRefused(USER_TABLES.map((t) => refused(t, 'Blocked by table read access rules'))), false);
  assert.equal(accessRefused([{ table: 'Tasks', column: 'charges', optional: false }]), false);
  assert.equal(accessRefused([]), false);
});

import { OPTIONAL_COLUMNS } from '../widget/js/core/grist-gateway.js';

test('colonnes facultatives (email, n_1, Domaine, type) : jamais signalées, lues si présentes', async () => {
  for (const [t, cols] of Object.entries(OPTIONAL_COLUMNS))
    for (const c of cols) assert.ok(!REQUIRED[t].includes(c), `${t}.${c}`);
  const team = { ...full('Team'), email: ['a@b.fr'], n_1: [0], Domaine: ['X'] };
  const g = fakeGrist({
    Team: team,
    Projects: full('Projects'),
    Chantiers: full('Chantiers'),
    Tasks: full('Tasks'),
    Disponibilites: full('Disponibilites'),
  });
  const raw = await createGateway(g).fetchAll();
  assert.deepEqual(raw.problems, []);
  assert.deepEqual(raw.tables.Team.email, ['a@b.fr']);
});
