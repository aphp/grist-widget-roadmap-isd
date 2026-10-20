import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALLOWED_ACTIONS,
  CHOICE_COLUMNS,
  EXPECTED_TYPES,
  NO_REMOVE,
  WRITABLE,
} from '../widget/js/core/grist-writer.js';
import { readEditMode } from '../widget/js/core/edit-switch.js';
import { GRIST_ORIGIN } from '../widget/js/config.js';

const WRITER = join('widget', 'js', 'core', 'grist-writer.js');

// widget/vendor/ = copie de grist-plugin-api.js (bibliothèque tierce qui définit ces API) : hors du contrôle.
const VENDOR = join('widget', 'vendor');
function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (p === VENDOR) return [];
    return statSync(p).isDirectory() ? files(p) : /\.(js|html|json)$/.test(p) ? [p] : [];
  });
}
const sources = files('widget').map((f) => [f, readFileSync(f, 'utf8')]);

test('widget/vendor/ ne contient que grist-plugin-api.js et dsfr/, chargés par index.html', () => {
  assert.deepEqual(readdirSync(VENDOR).sort(), ['dsfr', 'grist-plugin-api.js']);
  assert.deepEqual(readdirSync(join(VENDOR, 'dsfr')).sort(), ['LICENSE.md', 'dsfr.min.css', 'icons', 'icons.css']);
  const index = readFileSync('widget/index.html', 'utf8');
  assert.match(index, /href="vendor\/dsfr\/dsfr\.min\.css"/);
  assert.match(index, /href="vendor\/dsfr\/icons\.css"/);
  assert.doesNotMatch(index, /<link[^>]+cdn\.jsdelivr\.net/);
  assert.match(index, /<script src="vendor\/grist-plugin-api\.js"><\/script>/);
});

/** API et actions d'écriture : autorisées dans grist-writer.js seulement. */
const WRITE_APIS = ['applyUserActions', 'AddRecord', 'UpdateRecord', 'BulkUpdateRecord', 'RemoveRecord'];
/** Interdits partout dans widget/ (structure, options du widget, actions de masse). */
const FORBIDDEN = [
  'setOption',
  'setOptions',
  'sendActions',
  'AddTable',
  'RemoveTable',
  'RenameTable',
  'AddColumn',
  'RemoveColumn',
  'RenameColumn',
  'ModifyColumn',
  'BulkAddRecord',
  'BulkRemoveRecord',
  'ReplaceTableData',
  '_grist_ACL',
];

test('les API d’écriture n’apparaissent que dans core/grist-writer.js', () => {
  const hits = [];
  for (const [f, src] of sources)
    for (const w of WRITE_APIS) if (f !== WRITER && src.includes(w)) hits.push(`${f}: ${w}`);
  assert.deepEqual(hits, []);
  assert.ok(sources.find(([f]) => f === WRITER)[1].includes('applyUserActions'));
});

test('aucune action de structure ni écriture d’options nulle part dans widget/', () => {
  const hits = [];
  for (const [f, src] of sources) for (const w of FORBIDDEN) if (src.includes(w)) hits.push(`${f}: ${w}`);
  assert.deepEqual(hits, []);
});

/** Seuls fichiers qui parlent à Grist (objet global grist) ou au réseau (fetch). */
const GRIST_FILES = [join('widget', 'js', 'main.js'), join('widget', 'js', 'core', 'grist-gateway.js'), WRITER];
const FETCH_FILES = [join('widget', 'js', 'main.js'), join('widget', 'js', 'core', 'grist-gateway.js')];
const scripts = sources.filter(([f]) => f.endsWith('.js'));

test('seuls main.js, la passerelle et le writer référencent grist.', () => {
  const hits = scripts
    .filter(([f, src]) => !GRIST_FILES.includes(f) && /(?<![/.\w-])grist\s*\./.test(src))
    .map(([f]) => f);
  assert.deepEqual(hits, []);
});

test('aucune écriture par l’API TableOperations du plugin (getTable, selectedTable)', () => {
  const hits = [];
  for (const [f, src] of scripts)
    for (const re of [/\bgetTable\s*\(/, /\bselectedTable\b/, /\.(upsert|destroy)\s*\(/])
      if (re.test(src)) hits.push(`${f}: ${re}`);
  assert.deepEqual(hits, []);
});

test('getAccessToken seulement en lecture seule ; aucune requête réseau autre que GET', () => {
  const hits = [];
  for (const [f, src] of scripts) {
    for (const m of src.matchAll(/getAccessToken\(([^)]*)\)/g))
      if (!/\{\s*readOnly:\s*true\s*\}/.test(m[1])) hits.push(`${f}: getAccessToken(${m[1]})`);
    for (const m of src.matchAll(/method\s*:\s*['"`]?(\w+)/g))
      if (m[1].toUpperCase() !== 'GET') hits.push(`${f}: method ${m[1]}`);
    if (/\bfetch\s*\(/.test(src) && !FETCH_FILES.includes(f)) hits.push(`${f}: fetch`);
    for (const re of [/XMLHttpRequest/, /sendBeacon/, /new\s+WebSocket/, /EventSource/])
      if (re.test(src)) hits.push(`${f}: ${re}`);
  }
  assert.deepEqual(hits, []);
});

test('CSP : connect-src limité à la même origine et à l’origine exacte de l’instance Grist', () => {
  const html = readFileSync('widget/index.html', 'utf8');
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)[1];
  const connect = /connect-src ([^;]+)/.exec(csp)[1].trim().split(/\s+/);
  assert.deepEqual(connect, ["'self'", GRIST_ORIGIN]);
  assert.match(GRIST_ORIGIN, /^https:\/\/[a-z0-9.-]+$/);
  assert.ok(!csp.includes('*'));
});

/** Liste figée de la liste blanche (lots 2a, 2b, 2c) : toute modification du writer doit la reproduire ici. */
const FROZEN = {
  Tasks: {
    update: [
      'Chantier',
      'Commentaire',
      'Lien_utile',
      'Responsable',
      'assignees',
      'charges',
      'dateCloture',
      'dateDebut',
      'dateEcheance',
      'dependDe',
      'description',
      'parentTask',
      'priorite',
      'progression',
      'projet',
      'statut',
      'tags',
      'titre',
      'type',
    ],
    add: [
      'Chantier',
      'Cree_par',
      'Responsable',
      'assignees',
      'dateDebut',
      'dateEcheance',
      'description',
      'parentTask',
      'priorite',
      'projet',
      'statut',
      'titre',
      'type',
    ],
  },
  Chantiers: {
    update: [
      'Contributeurs',
      'Criteres_de_succes',
      'Debut',
      'Description',
      'Fin',
      'Nom_du_chantier',
      'Objectifs_resultats_attendus',
      'Projets',
      'Responsable',
      'Statut',
      'tags',
    ],
    add: ['Contributeurs', 'Debut', 'Description', 'Fin', 'Nom_du_chantier', 'Projets', 'Responsable', 'Statut'],
  },
  // Lot 2d : personnes ISD (Domaine seulement à la création, forcé à l'ISD) et indisponibilités
  Team: {
    update: ['actif', 'aph', 'capaciteHebdo', 'email', 'n_1', 'nom', 'role'],
    add: ['Domaine', 'actif', 'aph', 'capaciteHebdo', 'email', 'n_1', 'nom', 'role'],
  },
  Disponibilites: {
    update: ['commentaire', 'dateDebut', 'dateFin', 'dispo', 'type'],
    add: ['commentaire', 'dateDebut', 'dateFin', 'dispo', 'membre', 'type'],
  },
};

test('liste blanche figée : Tasks, Chantiers, Team et Disponibilites (lots 2a à 2d), ni Projects, ni table _grist, ni colonne hors formulaire', () => {
  assert.deepEqual(Object.keys(WRITABLE).sort(), ['Chantiers', 'Disponibilites', 'Tasks', 'Team']);
  for (const [t, ops] of Object.entries(FROZEN)) {
    assert.deepEqual(Object.keys(WRITABLE[t]).sort(), ['add', 'update'], t);
    for (const op of ['update', 'add']) {
      assert.deepEqual([...WRITABLE[t][op]].sort(), ops[op], `${t}.${op}`);
      assert.ok(Object.isFrozen(WRITABLE[t][op]), `${t}.${op} gelé`);
    }
    assert.ok(Object.isFrozen(WRITABLE[t]));
  }
  assert.ok(Object.isFrozen(WRITABLE));
  const all = Object.entries(WRITABLE).flatMap(([t, o]) =>
    [...new Set([...o.update, ...o.add])].map((c) => `${t}.${c}`),
  );
  assert.deepEqual(Object.keys(EXPECTED_TYPES).sort(), all.sort());
  // Tags (2e) en mise à jour seulement ; ni priorité des chantiers (Q5), ni colonnes hors formulaire
  assert.ok(WRITABLE.Tasks.update.includes('tags') && !WRITABLE.Tasks.add.includes('tags'));
  assert.ok(WRITABLE.Chantiers.update.includes('tags') && !WRITABLE.Chantiers.add.includes('tags'));
  assert.equal(EXPECTED_TYPES['Tasks.tags'], 'ChoiceList');
  assert.equal(EXPECTED_TYPES['Chantiers.tags'], 'ChoiceList');
  for (const c of ['estimationH', 'tempsPasse', 'manualSort', 'subtasks', 'couleur'])
    assert.ok(!WRITABLE.Tasks.update.includes(c) && !WRITABLE.Tasks.add.includes(c), c);
  for (const c of ['Priorite', 'Completion', 'Livrables', 'Perimetre', 'dependDe', 'manualSort'])
    assert.ok(!WRITABLE.Chantiers.update.includes(c) && !WRITABLE.Chantiers.add.includes(c), c);
  // Team : ni avatar, couleur, indispos (hors formulaire), ni Domaine en mise à jour ; jamais de suppression (Q9)
  for (const c of ['avatar', 'couleur', 'indispos', 'manualSort'])
    assert.ok(!WRITABLE.Team.update.includes(c) && !WRITABLE.Team.add.includes(c), c);
  assert.ok(!WRITABLE.Team.update.includes('Domaine'));
  assert.deepEqual(NO_REMOVE, ['Team']);
  // Cree_par : à la création seulement (Q11)
  assert.ok(!WRITABLE.Tasks.update.includes('Cree_par'));
  for (const c of CHOICE_COLUMNS) assert.ok(['Tasks.tags', 'Chantiers.tags', 'Team.role'].includes(c), c);
  assert.deepEqual(CHOICE_COLUMNS, []);
  assert.deepEqual(ALLOWED_ACTIONS, ['UpdateRecord', 'BulkUpdateRecord', 'AddRecord', 'RemoveRecord']);
});

test('RemoveRecord n’est produit qu’à un endroit du writer : l’annulation d’une création de la session', () => {
  const src = sources.find(([f]) => f === WRITER)[1];
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(code.match(/'RemoveRecord'/g).length, 4); // ALLOWED_ACTIONS, contrôle du lot, correction locale, undoAdd
  assert.match(code, /actions = \[\['RemoveRecord', entry\.table, entry\.id\]\]/);
  // Jamais sur Team : refusé par le contrôle du lot et avant toute annulation de création
  assert.match(code, /if \(NO_REMOVE\.includes\(table\)\) throw new WriteRefused\('suppression'/);
  assert.match(code, /if \(NO_REMOVE\.includes\(entry\.table\)\) return keep\('personne'\)/);
});

test('interrupteur d’édition coupé par défaut ; seul un paramètre explicite l’ouvre', () => {
  for (const src of ['', '?', '?mock=1', '?edition=', '?edition=0', '?edition=true', '?Edition=1x', '?doc=abc'])
    assert.equal(readEditMode(src).requested, 'off', src);
  assert.equal(readEditMode('?edition=1').requested, 'on');
  assert.equal(readEditMode('?edition=essai').requested, 'dry-run');
});

/** Fichiers suivis du dépôt (hors dépendances, données et documents locaux ignorés par git). */
function repoFiles(dir = '.') {
  const skip = new Set(['node_modules', 'vendor', '.git', 'docs', 'schema', 'data', '__pycache__', '.superpowers']);
  return readdirSync(dir).flatMap((f) => {
    if (skip.has(f) || f === 'package-lock.json') return [];
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return repoFiles(p);
    return /\.(js|mjs|html|json|md|py|ya?ml|css|txt)$/.test(p) ? [p] : [];
  });
}

test('aucun identifiant de document Grist écrit dans le dépôt', () => {
  const ID = /(api\/docs\/|[?&]doc=|\/doc\/|\bdoc_?id['"]?\s*[:=]\s*['"]|gouv\.fr\/(?:o\/[\w-]+\/)?)[A-Za-z0-9]{10,}/i;
  const files = repoFiles();
  assert.ok(files.length > 30);
  const hits = files.filter((f) => ID.test(readFileSync(f, 'utf8'))).map((f) => f);
  assert.deepEqual(hits, []);
});

test('flags.json : un objet { edition: booléen } (sa valeur peut être basculée sans casser les tests)', () => {
  const flags = JSON.parse(readFileSync('widget/flags.json', 'utf8'));
  assert.deepEqual(Object.keys(flags), ['edition']);
  assert.equal(typeof flags.edition, 'boolean');
});

test('grist.ready demande l’accès complet', () => {
  const main = readFileSync('widget/js/main.js', 'utf8');
  assert.match(main, /grist\.ready\(\{\s*requiredAccess:\s*'full'/);
});
