/**
 * Tests de bout en bout sur le faux Grist (dev/host.html), dans Chrome sans tête piloté par CDP (profil jetable,
 * jamais le navigateur de l'utilisateur ni un vrai Grist). Ignorés si Chrome n'est pas installé.
 * - aucune écriture au chargement ni pendant la visite de tous les onglets, édition coupée puis en mode essai ;
 * - formulaire (ui/task-editor.js) : envoi lent, sortie impossible pendant l'envoi, écriture sur la bonne ligne ;
 * - statut rapide : rien n'est écrit en parcourant le menu, seulement au choix.
 * Données : toujours le jeu synthétique de dev/synthetic-snapshot.js (?donnees=synthetiques), jamais
 * dev/data/snapshot.json. Aucun test ne reste bloqué : délai par commande CDP, par condition et par test.
 */
import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { fteHours } from '../widget/js/core/capacity.js';

const CHROME = ['google-chrome', 'chromium', 'chromium-browser'].find(
  (c) => spawnSync('which', [c], { stdio: 'ignore' }).status === 0,
);
const SKIP = !CHROME || typeof WebSocket === 'undefined' ? 'Chrome ou WebSocket indisponible' : false;
/** Délai d'attente d'une condition : large, pour une machine chargée (R1). */
const WAIT_MS = 20000;
/** Délai maximal d'une commande CDP, et d'un test entier. */
const SEND_MS = 30000;
const TEST_MS = 180000;
/** Dossier des journaux et captures d'un test en échec (E2E_ARTIFACTS, sinon dossier temporaire du système). */
const ARTIFACTS = process.env.E2E_ARTIFACTS || join(tmpdir(), 'roadmap-isd-e2e');
let PORT;
let CDP;
let BASE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Heures de 1 ETP du début à l'échéance (dates ISO) : capacité standard, comme le widget (capacity.js:fteHours).
 * Du 2 au 15 novembre 2026 : 52 h ; au 8 : 28,9 h ; au 21 : 80,9 h ; au 29 : 109,8 h.
 */
const fteOf = (start, end) =>
  fteHours(Date.parse(`${start}T00:00:00Z`) / 864e5, Date.parse(`${end}T00:00:00Z`) / 864e5);
/** Heures de `etp` ETP sur la période, à 0,5 h près. */
const etpHours = (etp, start, end) => Math.round(etp * fteOf(start, end) * 2) / 2;
let server;
let chrome;
let profile;
let ws;
let seq = 0;
const pending = new Map();
/** Messages de la console et exceptions de la page, joints au journal d'un échec. */
const consoleLog = [];

/** Port TCP libre, choisi par le système (jamais un port fixe partagé avec un autre serveur). */
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const status = (path) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Chrome ne répond pas (${method}, ${SEND_MS} ms)`));
    }, SEND_MS);
    pending.set(id, (d) => {
      clearTimeout(timer);
      resolve(d);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** Évalue du code dans l'iframe du widget (W = window, D = document). */
async function w(body) {
  const expression = `(async () => { const W = document.getElementById('w').contentWindow; const D = W.document; ${body} })()`;
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description));
  return r.result?.result?.value;
}

/** Erreur de données du faux Grist (window.__mockError) : le test échoue tout de suite, sans attendre le délai. */
async function mockError() {
  return w(`return W.__mockError ?? null;`).catch(() => null);
}

async function until(cond, ms = WAIT_MS) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await w(`return Boolean(${cond});`).catch(() => false)) return;
    const err = await mockError();
    if (err) throw new Error(err);
    await sleep(100);
  }
  throw new Error(`délai dépassé : ${cond}`);
}

/** Attend que la page de premier niveau soit chargée à cette adresse (événement load, pas une durée fixe). */
async function loaded(url) {
  const end = Date.now() + WAIT_MS;
  while (Date.now() < end) {
    const r = await send('Runtime.evaluate', {
      expression: `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`,
      returnByValue: true,
    });
    if (r.result?.result?.value === true) return;
    await sleep(50);
  }
  throw new Error(`page non chargée : ${url}`);
}

/** Ouvre le widget sur le faux Grist, toujours avec le jeu de données synthétique. */
async function open(query) {
  query = `${query || '?'}${query ? '&' : ''}donnees=synthetiques&vue=kanban`;
  const host = `${BASE}/dev/host.html`;
  await send('Page.navigate', { url: host });
  await loaded(host);
  await send('Runtime.evaluate', {
    expression: `localStorage.setItem('roadmap-isd:prefs', JSON.stringify({ mePrompted: true }))`,
  });
  await send('Page.navigate', { url: `${host}${query}` });
  await loaded(`${host}${query}`);
  await until(`D.querySelector('.view [data-task]')`);
}

/** Journal (erreur, console, écritures) et capture d'écran d'un test en échec, dans ARTIFACTS. */
async function saveFailure(name, err) {
  try {
    mkdirSync(ARTIFACTS, { recursive: true });
    const base = join(
      ARTIFACTS,
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${name.replace(/[^\p{L}\d]+/gu, '-').slice(0, 80)}`,
    );
    const writes = await w(`return JSON.stringify(W.__writes ?? null);`).catch(() => 'indisponible');
    writeFileSync(
      `${base}.log`,
      [`Test : ${name}`, `Erreur : ${err?.stack ?? err}`, `__writes : ${writes}`, 'Console :', ...consoleLog].join(
        '\n',
      ),
    );
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) writeFileSync(`${base}.png`, Buffer.from(shot.result.data, 'base64'));
  } catch {
    // le journal d'échec ne doit jamais masquer l'erreur du test
  }
}

/** test() de node:test, avec journal et capture en cas d'échec ; la console est remise à zéro à chaque test. */
function test(name, opts, fn) {
  return nodeTest(name, { timeout: TEST_MS, ...opts }, async (t) => {
    consoleLog.length = 0;
    try {
      await fn(t);
    } catch (err) {
      await saveFailure(name, err);
      throw err;
    }
  });
}

const TABS = ['gantt', 'kanban', 'table', 'portfolio', 'stats', 'synthesis', 'team'];

before(async () => {
  if (SKIP) return;
  PORT = await freePort();
  CDP = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  server = spawn('python3', ['dev/serve.py', String(PORT)], { stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    try {
      up = (await status('/dev/host.html')) === 200;
    } catch {
      await sleep(100);
    }
  }
  if (!up) throw new Error('serveur de développement injoignable (python3 dev/serve.py)');
  if ((await status('/dev/synthetic-snapshot.js')) !== 200)
    throw new Error('jeu de données synthétique introuvable : dev/synthetic-snapshot.js');
  profile = mkdtempSync(join(tmpdir(), 'roadmap-isd-chrome-'));
  chrome = spawn(
    CHROME,
    ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 100 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch {
      await sleep(100);
    }
  }
  if (!ws) throw new Error('Chrome sans tête injoignable (DevTools)');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome sans tête : connexion DevTools impossible')), SEND_MS);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    } else if (d.method === 'Runtime.consoleAPICalled')
      consoleLog.push(`[${d.params.type}] ${d.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    else if (d.method === 'Runtime.exceptionThrown')
      consoleLog.push(
        `[exception] ${d.params.exceptionDetails?.exception?.description ?? d.params.exceptionDetails?.text}`,
      );
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
});

after(async () => {
  ws?.close();
  server?.kill();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await exited;
  }
  // Les sous-processus de Chrome peuvent écrire encore un instant dans le profil : nettoyage au mieux
  await sleep(500);
  try {
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // profil jetable dans le dossier temporaire du système
  }
});

for (const query of ['', '?edition=essai', '?edition=1&doc=doc-dev-local&ecritures=memoire']) {
  test(
    `aucune écriture au chargement ni en visitant tous les onglets (${query || 'édition coupée'})`,
    { skip: SKIP },
    async () => {
      await open(query);
      for (const tab of TABS) {
        await w(`D.getElementById('tab-${tab}').click(); return true;`);
        await until(`D.querySelector('#view-panel[data-view="${tab}"]')`);
        await sleep(250);
      }
      // Ouvrir puis fermer une fiche n'écrit rien non plus
      await w(`D.getElementById('tab-kanban').click(); return true;`);
      await until(`D.querySelector('.view [data-task]')`);
      await w(`D.querySelector('.view [data-task]').click(); return true;`);
      await until(`D.getElementById('app-detail').dataset.open === 'true'`);
      await w(`D.getElementById('btn-detail-close').click(); return true;`);
      assert.equal(await w(`return W.__writes.length;`), 0);
    },
  );
}

test(
  'formulaire : pendant un envoi lent, impossible de quitter ; l’écriture vise la tâche ouverte',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire,lent');
    await w(`D.querySelector('.view [data-task]').click(); return true;`);
    await until(`D.getElementById('btn-edit-open')`);
    await w(`D.getElementById('btn-edit-open').click(); return true;`);
    await until(`D.getElementById('task-form')`);
    const id = await w(`return Number(D.getElementById('task-form').dataset.taskId);`);
    await w(`const t = D.getElementById('tf-titre'); t.value = 'Titre lent'; t.dispatchEvent(new W.Event('input', { bubbles: true }));
    D.getElementById('btn-form-save').click(); return true;`);
    await until(`D.getElementById('btn-form-save')?.disabled`);
    // Échap et « Fermer » pendant l'envoi : rien ne se passe, pas de barre « Abandonner »
    await w(
      `D.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); D.getElementById('btn-detail-close').click(); return true;`,
    );
    assert.equal(await w(`return Boolean(D.querySelector('.tf-foot--leave'));`), false);
    assert.equal(await w(`return Boolean(D.getElementById('task-form'));`), true);
    await until(`!D.getElementById('task-form')`);
    const writes = await w(`return W.__writes.map((x) => x.args[0]);`);
    assert.deepEqual(writes, [[['UpdateRecord', 'Tasks', id, { titre: 'Titre lent' }]]]);
    await until(`D.querySelector('.toast__text')`);
    assert.match(await w(`return D.querySelector('.toast__text').textContent;`), /enregistrées/);
  },
);

test('statut rapide : parcourir le menu n’écrit rien, seul le choix écrit', { skip: SKIP }, async () => {
  await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
  await w(`D.querySelector('.view [data-task]').click(); return true;`);
  await until(`D.getElementById('btn-status-menu')`);
  await w(`D.getElementById('btn-status-menu').click(); return true;`);
  await until(`!D.getElementById('status-menu-list').hidden`);
  for (let i = 0; i < 3; i++)
    await w(
      `D.activeElement.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return true;`,
    );
  assert.equal(await w(`return W.__writes.length;`), 0);
  const chosen =
    await w(`const b = [...D.querySelectorAll('[data-set-status]')].find((x) => !x.hasAttribute('aria-current'));
    b.click(); return b.dataset.setStatus;`);
  await until(`W.__writes.length === 1`);
  const cells = await w(`return W.__writes[0].args[0][0][3];`);
  assert.equal(cells.statut, chosen);
});

/** Ouvre le formulaire de la première tâche du Kanban et renvoie son identifiant. */
async function openForm() {
  await w(`D.querySelector('.view [data-task]').click(); return true;`);
  await until(`D.getElementById('btn-edit-open')`);
  await w(`D.getElementById('btn-edit-open').click(); return true;`);
  await until(`D.getElementById('task-form')`);
  return w(`return Number(D.getElementById('task-form').dataset.taskId);`);
}
const type = (id, value) =>
  w(
    `const t = D.getElementById('${id}'); t.value = ${JSON.stringify(value)}; t.dispatchEvent(new W.Event('input', { bubbles: true })); return true;`,
  );

test(
  'refus d’une règle d’accès : saisie conservée et copiable, champ rétabli puis le reste enregistré',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire,acl:Tasks');
    await openForm();
    await type('tf-titre', 'Titre refusé');
    await w(`D.getElementById('btn-form-save').click(); return true;`);
    await until(`D.querySelector('.tf-alert')`);
    assert.match(await w(`return D.getElementById('tf-copy').value;`), /Titre refusé/);
    assert.equal(await w(`return D.getElementById('tf-copy').disabled;`), false);
    // Un seul champ dans le lot : il est verrouillé, « Rétablir » le remet à sa valeur
    await until(`D.querySelector('[data-revert="titre"]')`);
    await w(`D.querySelector('[data-revert="titre"]').click(); return true;`);
    assert.match(await w(`return D.getElementById('tf-pending').textContent;`), /Aucune modification/);
  },
);

/** Formulaire passé en lecture : message unique, saisie copiable, champs en lecture, Fermer sans confirmation. */
async function expectLockedForm(text, typed) {
  await until(`D.querySelector('.tf-alert') && D.getElementById('tf-titre').disabled`);
  assert.match(await w(`return D.querySelector('.tf-alert').textContent;`), text);
  assert.match(await w(`return D.getElementById('tf-copy').value;`), typed);
  assert.equal(await w(`return D.querySelectorAll('.toast').length;`), 1);
  await w(`D.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`);
  await until(`D.getElementById('app-detail').dataset.open === 'false'`);
  assert.equal(await w(`return Boolean(D.querySelector('.tf-foot--leave'));`), false);
}

test(
  'compte lecteur découvert à l’écriture : formulaire en lecture, saisie copiable, une seule fois',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=lecteur,acces-inconnu');
    await openForm();
    await type('tf-titre', 'Essai lecteur');
    await w(`D.getElementById('btn-form-save').click(); return true;`);
    await expectLockedForm(/droit de modifier/, /Essai lecteur/);
    assert.equal(await w(`return W.__writes.length;`), 1);
    await w(`D.querySelector('.view [data-task]').click(); return true;`);
    await until(`D.querySelector('.dt-readonly')`);
    assert.match(await w(`return D.querySelector('.dt-readonly').textContent;`), /sans droit de modification/);
  },
);

test('arrêt d’urgence relu avant l’envoi : rien n’est écrit, formulaire en lecture (R2)', { skip: SKIP }, async () => {
  await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
  await openForm();
  await type('tf-titre', 'Après coupure');
  await w(`W.__coupe = true; D.getElementById('btn-form-save').click(); return true;`);
  await expectLockedForm(/coupée pour toutes les pages/, /Après coupure/);
  assert.equal(await w(`return W.__writes.length;`), 0);
});

test(
  'droits relus au moment d’agir : un bouton du bloc Personnes resté affiché après le passage en lecture ne change rien',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await openForm();
    // Une personne ajoutée au brouillon : sa ligne porte « Retirer »
    const id = Number(await firstOption('#tf-assignees'));
    await change('#tf-assignees', String(id));
    await until(`D.querySelector('[data-person-remove="${id}"]')`);
    const lines = await w(`return D.querySelectorAll('#tf-people [data-charge]').length;`);
    // La session passe en lecture (arrêt d'urgence relu avant l'envoi)
    await type('tf-titre', 'Après coupure');
    await w(`W.__coupe = true; D.getElementById('btn-form-save').click(); return true;`);
    await until(`D.querySelector('.tf-alert') && !D.querySelector('[data-person-remove]')`);
    // Boutons et menu périmés (rendus avant le passage en lecture) : rien ne change
    const stale = (html) =>
      w(
        `const box = D.createElement('div'); box.innerHTML = ${JSON.stringify(html)}; D.getElementById('tf-people').append(box); return true;`,
      );
    await stale(`<button type="button" data-person-remove="${id}" id="stale-remove">x</button>`);
    await clickOn('#stale-remove');
    await stale(
      `<select data-person-add id="stale-add"><option value=""></option><option value="${id + 1}">y</option></select>`,
    );
    await change('#stale-add', String(id + 1));
    await stale(`<button type="button" data-charges="replace-confirm" id="stale-replace">z</button>`);
    await clickOn('#stale-replace');
    assert.equal(await w(`return D.querySelectorAll('#tf-people [data-charge]').length;`), lines);
    assert.ok(await w(`return Boolean(D.querySelector('#tf-people [data-charge="${id}"]'));`));
    assert.equal(await w(`return W.__writes.length;`), 0);
  },
);

test(
  'arrêt d’urgence relu à une relecture, formulaire ouvert : il passe en lecture ; journal gardé (R2, R3)',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    // Une écriture d'abord, pour vérifier que le journal reste visible après la coupure
    await w(`D.querySelector('.view [data-task]').click(); return true;`);
    await until(`D.getElementById('btn-status-menu')`);
    await w(`D.getElementById('btn-status-menu').click();
    [...D.querySelectorAll('[data-set-status]')].find((x) => !x.hasAttribute('aria-current')).click(); return true;`);
    await until(`W.__writes.length === 1`);
    await sleep(800);
    await until(`D.getElementById('btn-edit-open')`);
    await w(`D.getElementById('btn-edit-open').click(); return true;`);
    await until(`D.getElementById('task-form')`);
    await type('tf-titre', 'Saisie en cours');
    await w(`W.__coupe = true; W.grist.__simulateChange(); return true;`);
    await expectLockedForm(/coupée pour toutes les pages/, /Saisie en cours/);
    assert.equal(await w(`return W.__writes.length;`), 1);
    assert.match(await w(`return D.getElementById('btn-edit-pill')?.textContent ?? '';`), /Lecture seule · 1/);
    await w(`D.getElementById('btn-edit-pill').click(); return true;`);
    await until(`!D.getElementById('edit-panel').hidden`);
    assert.equal(await w(`return D.querySelector('[data-edit-undo]').disabled;`), true);
    assert.equal(await w(`return D.querySelectorAll('.edit-panel__list li').length;`), 1);
  },
);

test(
  'Grist ne répond pas : délai dépassé, résultat relu et affiché, fiche de nouveau utilisable (R1)',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire,bloque-apres&delai=1000');
    await openForm();
    await type('tf-titre', 'Peut-être écrit');
    await w(`D.getElementById('btn-form-save').click(); return true;`);
    await until(`D.querySelector('.tf-unknown')`);
    assert.match(await w(`return D.querySelector('.tf-unknown').textContent;`), /Peut-être écrit.*enregistré/);
    assert.match(await w(`return D.getElementById('tf-pending').textContent;`), /Aucune modification/);
    await w(`D.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`);
    await until(`D.getElementById('app-detail').dataset.open === 'false'`);
  },
);

test(
  'Grist ne répond pas et n’a rien écrit : la saisie reste à enregistrer, Échap demande confirmation (R1)',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire,bloque&delai=1000');
    await openForm();
    await type('tf-titre', 'Jamais écrit');
    await w(`D.getElementById('btn-form-save').click(); return true;`);
    await until(`D.querySelector('.tf-unknown')`);
    assert.match(await w(`return D.querySelector('.tf-unknown').textContent;`), /n’est pas enregistrée/);
    assert.match(await w(`return D.getElementById('tf-pending').textContent;`), /1 modification/);
    await w(`D.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`);
    await until(`D.querySelector('.tf-foot--leave')`);
    await w(`D.querySelector('[data-form=leave-discard]').click(); return true;`);
    await until(`D.getElementById('app-detail').dataset.open === 'false'`);
  },
);

test(
  'flags.json sans réponse avant l’envoi : rien n’est envoyé, message clair, fiche utilisable (R1)',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire&delai=1000');
    await openForm();
    await type('tf-titre', 'Sans réponse');
    await w(`W.__flagsBloque = true; D.getElementById('btn-form-save').click(); return true;`);
    await until(`D.querySelector('.tf-alert')`);
    assert.match(await w(`return D.querySelector('.tf-alert').textContent;`), /impossible de vérifier/);
    assert.equal(await w(`return W.__writes.length;`), 0);
    assert.equal(await w(`return D.getElementById('tf-titre').disabled;`), false);
    assert.equal(await w(`return D.getElementById('btn-form-save').disabled;`), false);
  },
);

test(
  'charges (2b) : ajout en ETP, passage en heures, dates changées (ETP gardé), fusion avec une saisie concurrente',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await w(`localStorage.removeItem('roadmap-isd.chargesUnit'); return true;`);
    const id = await openForm();
    // Une tâche à deux dates (un jalon n'en a qu'une)
    if (await w(`return D.getElementById('tf-type').checked;`))
      await w(`const c = D.getElementById('tf-type'); c.click(); return true;`);
    await until(`D.getElementById('tf-dateDebut')`);
    const setDate = (f, iso) =>
      w(
        `const t = D.getElementById('tf-${f}'); t.value = '${iso}'; t.dispatchEvent(new W.Event('change', { bubbles: true })); return true;`,
      );
    await setDate('dateDebut', '2026-11-02');
    await setDate('dateEcheance', '2026-11-15');
    // ETP par défaut ; ajout d'une personne ISD par le bloc « Personnes » (elle est assignée)
    assert.equal(await w(`return D.getElementById('tf-charges-unit-etp').checked;`), true);
    const person = await w(`const s = D.getElementById('tf-assignees');
      const o = s.querySelector('optgroup option'); s.value = o.value;
      s.dispatchEvent(new W.Event('change', { bubbles: true })); return Number(o.value);`);
    await until(`D.getElementById('tf-ch-${person}')`);
    // Plus de 1 ETP : refusé avec un message, « Enregistrer » désactivé
    await type(`tf-ch-${person}`, '1,5');
    assert.match(
      await w(`return D.getElementById('tf-ch-${person}-msg').textContent;`),
      /1 ETP maximum par personne \(soit 52 h sur la période\)/,
    );
    assert.equal(await w(`return D.getElementById('btn-form-save').disabled;`), true);
    await type(`tf-ch-${person}`, '1');
    assert.equal(await w(`return D.getElementById('btn-form-save').disabled;`), false);
    // 1 ETP du 2 au 15 novembre = capacité standard de la période (9 jours ouvrés, 11 novembre férié)
    assert.equal(etpHours(1, '2026-11-02', '2026-11-15'), 52);
    assert.equal(await w(`return D.getElementById('tf-ch-${person}-eq').textContent.trim();`), '= 52 h');
    assert.match(await w(`return D.getElementById('tf-charges-foot').textContent;`), /Total 52 h · 1,0 ETP/);
    // Passage en heures : 52 h = 1,0 ETP ; l'unité est mémorisée
    await w(`const r = D.getElementById('tf-charges-unit-heures'); r.checked = true;
      r.dispatchEvent(new W.Event('change', { bubbles: true })); return true;`);
    assert.equal(await w(`return D.getElementById('tf-ch-${person}').value;`), '52');
    assert.equal(await w(`return D.getElementById('tf-ch-${person}-eq').textContent.trim();`), '= 1,0 ETP');
    assert.equal(await w(`return localStorage.getItem('roadmap-isd.chargesUnit');`), 'heures');
    // Dates changées : l'ETP fait foi (1 ETP du 2 au 21 novembre = 81 h), écart d'heures signalé
    await setDate('dateEcheance', '2026-11-21');
    assert.equal(etpHours(1, '2026-11-02', '2026-11-21'), 81);
    assert.equal(await w(`return D.getElementById('tf-ch-${person}').value;`), '81');
    assert.match(
      await w(`return D.getElementById('tf-ch-${person}-msg').textContent;`),
      /Dates modifiées : 52 h → 81 h \(ETP conservé\)/,
    );
    // Sans début : la saisie en ETP est désactivée, en heures elle reste possible
    await w(`const r = D.getElementById('tf-charges-unit-etp'); r.checked = true;
      r.dispatchEvent(new W.Event('change', { bubbles: true })); return true;`);
    await setDate('dateDebut', '');
    assert.match(await w(`return D.getElementById('tf-charges-nodates').textContent;`), /Indiquez début et échéance/);
    assert.equal(await w(`return D.getElementById('tf-ch-${person}').disabled;`), true);
    // Le samedi 21 seul : aucun jour ouvré, traité comme sans dates (message propre)
    await setDate('dateDebut', '2026-11-21');
    assert.match(await w(`return D.getElementById('tf-charges-nodates').textContent;`), /aucun jour ouvré/);
    assert.equal(await w(`return D.getElementById('tf-ch-${person}').disabled;`), true);
    await setDate('dateDebut', '2026-11-02');
    assert.equal(await w(`return W.__writes.length;`), 0);
    // Quelqu'un d'autre ajoute une charge pendant la saisie (JSON écrit autrement) : elle survit à l'enregistrement
    const other = await w(`const s = D.getElementById('tf-assignees');
      return Number([...s.querySelectorAll('option')].find((o) => o.value && Number(o.value) !== ${person}).value);`);
    const orig = await w(`const t = await W.grist.docApi.fetchTable('Tasks'); const v = t.charges[t.id.indexOf(${id})];
      return v ? JSON.parse(v) : [];`);
    // Textes des entrées écrits autrement (espaces) : ils doivent être recopiés octet par octet
    const theirs = [...orig, { teamId: other, heures: 3 }].map((e) => JSON.stringify(e).replace(/,"/g, ', "'));
    const theirsText = `[ ${theirs.join(' , ')} ]`;
    await w(
      `await W.grist.docApi.applyUserActions([['UpdateRecord', 'Tasks', ${id}, { charges: ${JSON.stringify(theirsText)} }]]); return true;`,
    );
    await w(`D.getElementById('btn-form-save').click(); return true;`);
    await until(`W.__writes.length === 2`);
    const cells = await w(`return W.__writes[1].args[0][0][3];`);
    assert.equal(await w(`return W.__writes[1].args[0][0][2];`), id);
    assert.equal(cells.charges, `[${[...theirs, JSON.stringify({ teamId: person, heures: 81 })].join(',')}]`);
    assert.ok(cells.assignees.includes(person));
    assert.equal(cells.dateDebut, Date.UTC(2026, 10, 2) / 1000);
    assert.equal(cells.dateEcheance, Date.UTC(2026, 10, 21) / 1000);
  },
);

/**
 * Fiche d'une tâche de 14 jours (2 au 15 novembre 2026) chargée de 52 h pour une personne ISD (1 ETP standard),
 * posée ailleurs avant l'ouverture ; écritures remises à zéro. Rend { id, person }.
 */
async function openCharged14() {
  await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
  await w(`localStorage.removeItem('roadmap-isd.chargesUnit'); return true;`);
  const id = await openForm();
  const person = await w(`return Number(D.querySelector('#tf-assignees optgroup option').value);`);
  const title = await w(`return D.getElementById('tf-titre').value;`);
  await w(`D.getElementById('btn-form-cancel').click(); return true;`);
  await until(`!D.getElementById('task-form')`);
  const day = (y, m, d) => Date.UTC(y, m - 1, d) / 1000;
  const charges = JSON.stringify([{ teamId: person, heures: etpHours(1, '2026-11-02', '2026-11-15') }]);
  await w(`await W.grist.docApi.applyUserActions([['UpdateRecord', 'Tasks', ${id}, { assignees: ['L', ${person}], charges: ${JSON.stringify(charges)}, type: 'tache', dateDebut: ${day(2026, 11, 2)}, dateEcheance: ${day(2026, 11, 15)} }]]);
    W.__writes.length = 0; return true;`);
  // La tâche seule (recherche sur son titre), modèle relu (dates nouvelles sur la carte) avant d'ouvrir la fiche
  await typeIn('#f-search', title);
  await until(`D.getElementById('kc-${id}')?.textContent.includes('15 nov. 2026')`);
  await w(`D.getElementById('kc-${id}').click(); return true;`);
  await until(`D.getElementById('btn-edit-open')`);
  await w(`D.getElementById('btn-edit-open').click(); return true;`);
  await until(`D.getElementById('tf-ch-${person}')`);
  return { id, person };
}
const setFormDate = (f, iso) =>
  w(
    `const t = D.getElementById('tf-${f}'); t.value = '${iso}'; t.dispatchEvent(new W.Event('change', { bubbles: true })); return true;`,
  );

test('fiche : dates allongées, ETP gardé, heures recalculées et envoyées', { skip: SKIP }, async () => {
  const { id, person } = await openCharged14();
  assert.equal(await w(`return D.getElementById('tf-ch-${person}-eq').textContent.trim();`), '= 52 h');
  // Échéance + 14 jours : 1 ETP du 2 au 29 novembre = 110 h, écart affiché avant l'envoi
  assert.equal(etpHours(1, '2026-11-02', '2026-11-29'), 110);
  await setFormDate('dateEcheance', '2026-11-29');
  await until(`D.getElementById('tf-ch-${person}-eq').textContent.trim() === '= 110 h'`);
  assert.equal(await w(`return D.getElementById('tf-ch-${person}').value;`), '1,0');
  assert.match(
    await w(`return D.getElementById('tf-ch-${person}-msg').textContent;`),
    /Dates modifiées : 52 h → 110 h \(ETP conservé\)/,
  );
  assert.equal(await w(`return W.__writes.length;`), 0);
  await w(`D.getElementById('btn-form-save').click(); return true;`);
  await until(`W.__writes.length === 1`);
  const batch = (await writes())[0];
  assert.equal(batch.length, 1);
  const [kind, table, rowId, cells] = batch[0];
  assert.deepEqual([kind, table, rowId], ['UpdateRecord', 'Tasks', id]);
  assert.deepEqual(Object.keys(cells).sort(), ['charges', 'dateEcheance']);
  assert.equal(cells.dateEcheance, Date.UTC(2026, 10, 29) / 1000);
  assert.equal(cells.charges, JSON.stringify([{ teamId: person, heures: 110 }]));
});

test('fiche : décalage à durée égale de juin à juillet, ETP gardé, heures recalculées', { skip: SKIP }, async () => {
  const { id, person } = await openCharged14();
  // Deux semaines de juin 2027 puis les deux mêmes jours de semaine en juillet : même durée, capacité plus faible
  await setFormDate('dateDebut', '2027-06-07');
  await setFormDate('dateEcheance', '2027-06-20');
  const june = etpHours(1, '2027-06-07', '2027-06-20');
  await until(`D.getElementById('tf-ch-${person}-eq').textContent.trim() === '= ${june} h'`);
  await setFormDate('dateDebut', '2027-07-05');
  await setFormDate('dateEcheance', '2027-07-18');
  const july = etpHours(1, '2027-07-05', '2027-07-18');
  assert.ok(july < june);
  await until(`D.getElementById('tf-ch-${person}-eq').textContent.trim() === '= ${String(july).replace('.', ',')} h'`);
  assert.equal(await w(`return D.getElementById('tf-ch-${person}').value;`), '1,0');
  await w(`D.getElementById('btn-form-save').click(); return true;`);
  await until(`W.__writes.length === 1`);
  const [, , rowId, cells] = (await writes())[0][0];
  assert.equal(rowId, id);
  assert.equal(cells.charges, JSON.stringify([{ teamId: person, heures: july }]));
});

test('fiche : dates remises à l’identique, charges non envoyées', { skip: SKIP }, async () => {
  const { id, person } = await openCharged14();
  await setFormDate('dateEcheance', '2026-11-29');
  await until(`D.getElementById('tf-ch-${person}-eq').textContent.trim() === '= 110 h'`);
  await setFormDate('dateEcheance', '2026-11-15');
  await until(`D.getElementById('tf-ch-${person}-eq').textContent.trim() === '= 52 h'`);
  assert.doesNotMatch(await w(`return D.getElementById('tf-ch-${person}-msg').textContent;`), /Dates modifiées/);
  // Une autre modification pour avoir quelque chose à enregistrer : seule elle part
  await type('tf-titre', 'Titre après dates rétablies');
  await w(`D.getElementById('btn-form-save').click(); return true;`);
  await until(`W.__writes.length === 1`);
  const [, , rowId, cells] = (await writes())[0][0];
  assert.equal(rowId, id);
  assert.deepEqual(Object.keys(cells), ['titre']);
});

test(
  'pastilles « i » de l’ETP : fiche, statistiques et plan de charge (nom, description, visibles au focus, dans la fenêtre)',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await openForm();
    const tip = async (id) => {
      assert.equal(await w(`return D.querySelectorAll('#${id}').length;`), 1);
      const btn = `D.querySelector('[aria-describedby="${id}"]')`;
      assert.equal(await w(`return ${btn}.getAttribute('aria-label');`), 'À propos de l’ETP');
      assert.match(await w(`return D.getElementById('${id}').textContent;`), /7 h par jour ouvré.*mai \(80 %\)/);
      await w(`${btn}.scrollIntoView({ block: 'center' }); ${btn}.focus(); return true;`);
      await until(`getComputedStyle(D.getElementById('${id}')).opacity === '1'`);
      assert.equal(
        await w(
          `const r = D.getElementById('${id}').getBoundingClientRect(); return r.left >= 0 && r.right <= D.documentElement.clientWidth;`,
        ),
        true,
      );
    };
    await tip('tip-fte-tf');
    await w(`D.getElementById('btn-form-cancel').click(); return true;`);
    await until(`!D.getElementById('task-form')`);
    await w(`D.getElementById('btn-detail-close').click(); D.getElementById('tab-stats').click(); return true;`);
    await until(`D.getElementById('tip-fte-stats') && D.getElementById('tip-fte-plan')`);
    await tip('tip-fte-stats');
    await tip('tip-fte-plan');
    assert.equal(await w(`return W.__writes.length;`), 0);
  },
);

/**
 * Fiche de openCharged14 ; ailleurs, la charge de la personne passe à 36 h (sauf remote: false), puis une sous-tâche
 * créée depuis la fiche fait relire la ligne (refreshFromModel). before : étape faite dans la fiche avant la
 * relecture. Rend { id, person } ; une écriture (la sous-tâche) dans __writes.
 */
async function openRebased36({
  before = null,
  remote = true,
  expect = '= 36 h',
  entries = (person) => [{ teamId: person, heures: 36 }],
  card = '0,7 ETP',
} = {}) {
  const { id, person } = await openCharged14();
  const other = await w(`return Number(D.querySelector('#tf-assignees optgroup option').value);`);
  if (before) await before(person);
  if (remote) {
    const charges = JSON.stringify(entries(person, other));
    await w(`await W.grist.docApi.applyUserActions([['UpdateRecord', 'Tasks', ${id}, { charges: ${JSON.stringify(charges)} }]]);
      return true;`);
    // Modèle relu (ETP de la carte) avant la sous-tâche
    await until(`D.getElementById('kc-${id}')?.textContent.includes('${card}')`);
  }
  await w(`W.__writes.length = 0; return true;`);
  await clickOn('#btn-add-subtask');
  await until(`D.querySelector('dialog.cdlg[open] #cf-titre')`);
  await typeIn('#cf-titre', 'Sous-tâche de relecture');
  await clickOn('#cf-create');
  await until(`!D.querySelector('dialog.cdlg') && W.__writes.length === 1`);
  await until(`D.getElementById('tf-ch-${person}-eq')?.textContent.trim() === '${expect}'`);
  // Une relecture seule ne produit jamais d'écart « Dates modifiées »
  if (!before)
    assert.doesNotMatch(await w(`return D.getElementById('tf-ch-${person}-msg').textContent;`), /Dates modifiées/);
  return { id, person, other };
}

/** Échéance + 14 jours dans la fiche (52 h → 110 h pour la personne non saisie). */
async function lengthen(person) {
  await setFormDate('dateEcheance', '2026-11-29');
  await until(`D.getElementById('tf-ch-${person}-eq').textContent.trim() === '= 110 h'`);
}
/** Heures relues sur le 2 au 15 novembre, recalculées sur le 2 au 29 (ETP gardé). */
const toNov29 = (h) => Math.round((h / fteOf('2026-11-02', '2026-11-15')) * fteOf('2026-11-02', '2026-11-29') * 2) / 2;

test(
  'fiche : dates allongées, puis charges relues avec une personne ajoutée ailleurs : elle est gardée (rien perdu)',
  { skip: SKIP },
  async () => {
    // Ailleurs : la personne passe à 36 h et une autre est ajoutée (7 h) ; ici les dates avaient été allongées
    assert.deepEqual([toNov29(36), toNov29(7)], [76, 15]);
    const { id, person, other } = await openRebased36({
      before: lengthen,
      expect: '= 76 h',
      entries: (p, o) => [
        { teamId: p, heures: 36 },
        { teamId: o, heures: 7 },
      ],
      card: '0,8 ETP',
    });
    await w(`D.getElementById('btn-form-save').click(); return true;`);
    await until(`W.__writes.length === 2`);
    const [, , rowId, cells] = (await writes())[1][0];
    assert.equal(rowId, id);
    // ETP de l'autre personne, ajoutée ailleurs, gardé et recalculé sur la période allongée (7 h → 15 h)
    assert.equal(
      cells.charges,
      JSON.stringify([
        { teamId: person, heures: 76 },
        { teamId: other, heures: 15 },
      ]),
    );
  },
);

test(
  'fiche : charge saisie puis changée ailleurs : la relecture ne l’écrase pas, fenêtre de conflit',
  { skip: SKIP },
  async () => {
    const typeHalf = async (person) => {
      await type(`tf-ch-${person}`, '0,5');
      await until(`D.getElementById('tf-ch-${person}-eq').textContent.trim() === '= 26 h'`);
    };
    const { person } = await openRebased36({ before: typeHalf, expect: '= 26 h' });
    await w(`D.getElementById('btn-form-save').click(); return true;`);
    await until(`D.querySelector('.tf-conflict')`);
    assert.equal(await w(`return W.__writes.length;`), 1);
    assert.ok(await w(`return Boolean(D.getElementById('tf-cf-charges-mine'));`));
    assert.match(await w(`return D.querySelector('.tf-conflict').textContent;`), /36/);
    assert.equal(await w(`return D.getElementById('tf-ch-${person}').value;`), '0,5');
  },
);

test('fiche : valeur affichée ressaisie, puis charges relues : la ligne suit la Feuille', { skip: SKIP }, async () => {
  const retype = async (person) => {
    await type(`tf-ch-${person}`, '1,0');
  };
  await openRebased36({ before: retype, expect: '= 36 h' });
});

/**
 * Fiche de openCharged14 ; typed : ETP saisi d'abord ; dates raccourcies à 7 jours ; ailleurs, échéance au
 * 29 novembre ; enregistrer ouvre la fenêtre, « la leur » choisie pour l'échéance. Rend { id, person }.
 */
async function shortenAgainstTheirs(typed = null) {
  const { id, person } = await openCharged14();
  if (typed) await type(`tf-ch-${person}`, typed);
  await setFormDate('dateEcheance', '2026-11-08');
  await w(
    `await W.grist.docApi.applyUserActions([['UpdateRecord', 'Tasks', ${id}, { dateEcheance: ${Date.UTC(2026, 10, 29) / 1000} }]]);
    W.__writes.length = 0; return true;`,
  );
  await w(`D.getElementById('btn-form-save').click(); return true;`);
  await until(`D.getElementById('tf-cf-dateEcheance-theirs')`);
  assert.equal(await w(`return W.__writes.length;`), 0);
  await w(`const r = D.getElementById('tf-cf-dateEcheance-theirs'); r.checked = true;
    r.dispatchEvent(new W.Event('change', { bubbles: true })); return true;`);
  await w(`D.querySelector('[data-form="conflict-apply"]').click(); return true;`);
  return { id, person };
}

test(
  'fiche : ETP saisi, dates raccourcies, échéance changée ailleurs, « la leur » : heures recalculées sur les dates envoyées',
  { skip: SKIP },
  async () => {
    // 0,8 ETP saisi (41,5 h du 2 au 15), 23 h jusqu'au 8 ici ; « la leur » : jusqu'au 29, 0,8 ETP = 88 h (pas 23 h)
    assert.deepEqual(
      [etpHours(0.8, '2026-11-02', '2026-11-15'), etpHours(0.8, '2026-11-02', '2026-11-08')],
      [41.5, 23],
    );
    const { id, person } = await shortenAgainstTheirs('0,8');
    await until(`W.__writes.length === 1`);
    const [, , rowId, cells] = (await writes())[0][0];
    assert.equal(rowId, id);
    assert.deepEqual(cells, {
      charges: JSON.stringify([{ teamId: person, heures: etpHours(0.8, '2026-11-02', '2026-11-29') }]),
    });
    assert.equal(etpHours(0.8, '2026-11-02', '2026-11-29'), 88);
  },
);

test(
  'fiche : charge non saisie, dates raccourcies, « la leur » pour l’échéance : la Feuille reste telle quelle',
  { skip: SKIP },
  async () => {
    // La ligne suit la Feuille (52 h jusqu'au 29) : jamais les 29 h calculées jusqu'au 8
    await shortenAgainstTheirs();
    await until(`!D.getElementById('task-form')`);
    assert.equal(await w(`return W.__writes.length;`), 0);
  },
);

test(
  'fiche : dates allongées, puis charges relues : la personne non saisie repart des nouvelles heures',
  { skip: SKIP },
  async () => {
    // 36 h du 2 au 15 relues après l'allongement au 29 : 76 h (et non les 110 h d'avant, sans conflit)
    const { id, person } = await openRebased36({ before: lengthen, expect: '= 76 h' });
    await w(`D.getElementById('btn-form-save').click(); return true;`);
    await until(`W.__writes.length === 2`);
    const [, , rowId, cells] = (await writes())[1][0];
    assert.equal(rowId, id);
    assert.equal(cells.charges, JSON.stringify([{ teamId: person, heures: 76 }]));
    assert.equal(cells.dateEcheance, Date.UTC(2026, 10, 29) / 1000);
  },
);

test(
  'fiche : dates allongées, puis relecture sans changement des charges : 110 h gardées',
  { skip: SKIP },
  async () => {
    const { person } = await openRebased36({ before: lengthen, remote: false, expect: '= 110 h' });
    await w(`D.getElementById('btn-form-save').click(); return true;`);
    await until(`W.__writes.length === 2`);
    const [, , , cells] = (await writes())[1][0];
    assert.equal(cells.charges, JSON.stringify([{ teamId: person, heures: 110 }]));
  },
);

test(
  'fiche : charges relues, puis date de clôture seule : aucun recalcul, charges non envoyées',
  { skip: SKIP },
  async () => {
    const { id, person } = await openRebased36();
    await setFormDate('dateCloture', '2026-11-20');
    assert.equal(await w(`return D.getElementById('tf-ch-${person}-eq').textContent.trim();`), '= 36 h');
    await w(`D.getElementById('btn-form-save').click(); return true;`);
    await until(`W.__writes.length === 2`);
    const [, , rowId, cells] = (await writes())[1][0];
    assert.equal(rowId, id);
    assert.deepEqual(Object.keys(cells), ['dateCloture']);
  },
);

test(
  'fiche : charges relues, puis dates allongées : recalcul depuis les nouvelles heures',
  { skip: SKIP },
  async () => {
    const { id, person } = await openRebased36();
    // 36 h du 2 au 15, échéance + 14 jours : 76 h (et non 110 h depuis les 52 h d'avant)
    await setFormDate('dateEcheance', '2026-11-29');
    await until(`D.getElementById('tf-ch-${person}-eq').textContent.trim() === '= 76 h'`);
    assert.match(await w(`return D.getElementById('tf-ch-${person}-msg').textContent;`), /36 h → 76 h/);
    await w(`D.getElementById('btn-form-save').click(); return true;`);
    await until(`W.__writes.length === 2`);
    const [, , rowId, cells] = (await writes())[1][0];
    assert.equal(rowId, id);
    assert.equal(cells.charges, JSON.stringify([{ teamId: person, heures: 76 }]));
  },
);

test(
  'personnes : ajout en ETP, « Assigner » une charge non assignée, retrait ; un seul lot ; listes unifiées en lecture',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await w(`localStorage.removeItem('roadmap-isd.chargesUnit'); return true;`);
    const id = await openForm();
    // Trois personnes ISD proposées par « Ajouter une personne… »
    const [a, b, c] = await w(
      `return [...D.querySelectorAll('#tf-assignees optgroup option')].slice(0, 3).map((o) => Number(o.value));`,
    );
    await w(`D.getElementById('btn-form-cancel').click(); return true;`);
    await until(`!D.getElementById('task-form')`);
    // Ailleurs : a est assignée sans charge, b a une charge sans être assignée (jamais assignée d'office)
    const day = (y, m, d) => Date.UTC(y, m - 1, d) / 1000;
    const charges = JSON.stringify([{ teamId: b, heures: 7 }]);
    await w(`await W.grist.docApi.applyUserActions([['UpdateRecord', 'Tasks', ${id}, { assignees: ['L', ${a}], charges: ${JSON.stringify(charges)}, type: 'tache', dateDebut: ${day(2026, 11, 2)}, dateEcheance: ${day(2026, 11, 15)} }]]);
      W.__writes.length = 0; return true;`);
    // Kanban : la tâche seule (recherche sur son titre) ; liste unique, b marquée « non assignée », ETP par personne
    const title = await w(`return D.getElementById('kc-${id}')?.querySelector('.kcard__title').textContent ?? '';`);
    await typeIn('#f-search', title);
    await until(`D.querySelector('#kc-${id} .kcard__person--unassigned')`);
    const card = await w(`return D.querySelector('#kc-${id} .kcard__people .fr-sr-only').textContent;`);
    assert.match(card, /non assignée/);
    assert.match(card, /0,1 ETP/);
    assert.equal(await w(`return D.querySelectorAll('#kc-${id} .kcard__person').length;`), 2);
    // Fiche en lecture : un seul tableau « Personnes », a sans charge (—), b non assignée
    await w(`D.getElementById('kc-${id}').click(); return true;`);
    await until(`D.querySelector('.dt-people-list [data-person="${b}"]')`);
    assert.deepEqual(
      await w(`return [...D.querySelectorAll('.dt-people-list tbody tr')].map((r) => Number(r.dataset.person));`),
      [a, b],
    );
    assert.ok(await w(`return Boolean(D.querySelector('.dt-people-list [data-person="${b}"] .dt-unassigned'));`));
    assert.equal(
      await w(`return Boolean(D.querySelector('.dt-people-list [data-person="${a}"] .dt-unassigned'));`),
      false,
    );
    // Formulaire : un seul bloc « Personnes », plus de champ « Assignés » ni de case « Ajouter aussi aux assignés »
    await w(`D.getElementById('btn-edit-open').click(); return true;`);
    await until(`D.getElementById('tf-people')`);
    assert.equal(
      await w(`return D.querySelectorAll('#task-form [data-field="assignees"], #tf-ch-assign, #tf-charges').length;`),
      0,
    );
    assert.equal(await w(`return D.getElementById('tf-ch-${a}').value;`), '');
    assert.ok(await w(`return Boolean(D.getElementById('tf-person-${b}-flag'));`));
    // Ajouter c : assignée, le champ de charge prend le focus ; 0,5 ETP du 2 au 15 novembre = 26 h
    await change('#tf-assignees', String(c));
    await until(`D.getElementById('tf-ch-${c}')`);
    assert.equal(await w(`return D.activeElement.id;`), `tf-ch-${c}`);
    await type(`tf-ch-${c}`, '0,5');
    assert.equal(await w(`return D.getElementById('tf-ch-${c}-eq').textContent.trim();`), '= 26 h');
    assert.match(await w(`return D.getElementById('tf-charges-foot').textContent;`), /Total 33 h · 0,6 ETP/);
    // Assigner b (charge non assignée) : la mention disparaît
    await clickOn(`#tf-person-${b}-assign`);
    await until(`!D.getElementById('tf-person-${b}-flag')`);
    // Retirer a : sa ligne disparaît (assignation retirée)
    await clickOn(`#tf-person-${a}-remove`);
    await until(`!D.getElementById('tf-ch-${a}')`);
    assert.equal(await w(`return D.activeElement.id;`), 'tf-assignees');
    assert.equal(await w(`return W.__writes.length;`), 0);
    await w(`D.getElementById('btn-form-save').click(); return true;`);
    await until(`W.__writes.length === 1`);
    // Un seul lot, une seule action, avec les deux colonnes ; octets de l'entrée de b conservés
    const batch = await w(`return W.__writes[0].args[0];`);
    assert.equal(batch.length, 1);
    assert.deepEqual(batch[0].slice(0, 3), ['UpdateRecord', 'Tasks', id]);
    assert.deepEqual(batch[0][3], {
      assignees: ['L', c, b],
      charges: `[${charges.slice(1, -1)},${JSON.stringify({ teamId: c, heures: 26 })}]`,
    });
    // Tableau : liste unique avec profil écrit et ETP par personne
    await until(`!D.getElementById('task-form')`);
    await w(`D.getElementById('btn-detail-close').click(); D.getElementById('tab-table').click(); return true;`);
    await until(`D.querySelector('[data-open="${id}"]')`);
    const people = await w(
      `return D.querySelector('[data-open="${id}"]').closest('tr').querySelector('.tbl-people').title;`,
    );
    assert.match(people, /0,5 ETP/);
    assert.doesNotMatch(people, /non assignée/);
    assert.equal(
      await w(`return D.querySelector('[data-open="${id}"]').closest('tr').querySelectorAll('.tbl-person').length;`),
      2,
    );
  },
);

test(
  'personnes : Management ISD ajouté avec 0,5 ETP, écrit en un lot, affiché « Mgmt » (jamais « hors ISD »)',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await w(`localStorage.removeItem('roadmap-isd.chargesUnit'); return true;`);
    const id = await openForm();
    // Groupe « ISD — Management » du bloc « Personnes » (pickerGroups) : première personne proposée
    const m = await w(
      `return Number([...D.querySelectorAll('#tf-assignees optgroup')].find((g) => g.label === 'ISD — Management')?.querySelector('option')?.value ?? 0);`,
    );
    assert.ok(m > 0, 'groupe ISD — Management absent');
    // Une seule fois dans la liste (pas aussi dans « Autres personnes »)
    assert.equal(await w(`return D.querySelectorAll('#tf-assignees option[value="${m}"]').length;`), 1);
    await w(`D.getElementById('btn-form-cancel').click(); return true;`);
    await until(`!D.getElementById('task-form')`);
    // Tâche sans personne, du 2 au 15 novembre (0,5 ETP = 26 h)
    const day = (y, mo, d) => Date.UTC(y, mo - 1, d) / 1000;
    await w(`await W.grist.docApi.applyUserActions([['UpdateRecord', 'Tasks', ${id}, { assignees: ['L'], charges: '[]', type: 'tache', dateDebut: ${day(2026, 11, 2)}, dateEcheance: ${day(2026, 11, 15)} }]]);
      W.__writes.length = 0; return true;`);
    // Rouverte depuis le Kanban (carte seule, recherche sur son titre) : données relues
    await w(`D.getElementById('btn-detail-close').click(); return true;`);
    const title = await w(`return D.getElementById('kc-${id}')?.querySelector('.kcard__title').textContent ?? '';`);
    await typeIn('#f-search', title);
    // Attendre la relecture : la carte porte les nouvelles dates
    await until(`D.querySelector('#kc-${id} .kcard__dates')?.textContent.includes('2026')`);
    await w(`D.getElementById('kc-${id}').click(); return true;`);
    await until(`D.getElementById('btn-edit-open')`);
    await w(`D.getElementById('btn-edit-open').click(); return true;`);
    await until(`D.getElementById('tf-people')`);
    await change('#tf-assignees', String(m));
    await until(`D.getElementById('tf-ch-${m}')`);
    const who = await w(`return D.querySelector('[data-charge="${m}"] .tf-charge__who').textContent;`);
    assert.match(who, /Mgmt/);
    assert.doesNotMatch(who, /hors ISD/);
    await type(`tf-ch-${m}`, '0,5');
    assert.equal(await w(`return D.getElementById('tf-ch-${m}-eq').textContent.trim();`), '= 26 h');
    assert.equal(await w(`return W.__writes.length;`), 0);
    await w(`D.getElementById('btn-form-save').click(); return true;`);
    await until(`W.__writes.length === 1`);
    const batch = await w(`return W.__writes[0].args[0];`);
    assert.deepEqual(batch, [
      ['UpdateRecord', 'Tasks', id, { assignees: ['L', m], charges: JSON.stringify([{ teamId: m, heures: 26 }]) }],
    ]);
    // Fiche en lecture : rôle « Mgmt », pas « hors ISD »
    await until(`!D.getElementById('task-form') && D.querySelector('.dt-people-list [data-person="${m}"]')`);
    const row = await w(`return D.querySelector('.dt-people-list [data-person="${m}"] th').textContent;`);
    assert.match(row, /Mgmt/);
    assert.doesNotMatch(row, /hors ISD/);
    // Kanban : la carte montre la personne avec « Mgmt » ; texte complet « Management » et 0,5 ETP
    await w(`D.getElementById('btn-detail-close').click(); return true;`);
    await until(`D.querySelector('#kc-${id} .kcard__role')`);
    assert.deepEqual(await w(`return [...D.querySelectorAll('#kc-${id} .kcard__role')].map((r) => r.textContent);`), [
      'Mgmt',
    ]);
    const card = await w(`return D.querySelector('#kc-${id} .kcard__people .fr-sr-only').textContent;`);
    assert.match(card, /\(Management\)/);
    assert.match(card, /0,5 ETP/);
    assert.doesNotMatch(card, /hors ISD|non assignée/);
    assert.equal(await w(`return W.__writes.length;`), 1);
  },
);

test(
  'personnes : une personne hors ISD posée via la Feuille reste affichée, non proposable, et gardée à l’enregistrement',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    const id = await openForm();
    // Personne de Team absente de tous les sélecteurs d'ajout (donc hors équipe ISD active)
    const offered = await w(
      `return [...D.querySelectorAll('#tf-assignees option')].map((o) => Number(o.value)).filter(Boolean);`,
    );
    const out = await w(`const t = await W.grist.docApi.fetchTable('Team'); const offered = ${JSON.stringify(offered)};
      const i = t.id.findIndex((x, k) => t.actif[k] && !offered.includes(x)); return i < 0 ? 0 : t.id[i];`);
    assert.ok(out > 0, 'aucune personne hors ISD dans les données de dev');
    await w(`D.getElementById('btn-form-cancel').click(); return true;`);
    await until(`!D.getElementById('task-form')`);
    await w(`await W.grist.docApi.applyUserActions([['UpdateRecord', 'Tasks', ${id}, { assignees: ['L', ${out}], charges: '[]', Responsable: ${out} }]]);
      W.__writes.length = 0; return true;`);
    await w(`D.getElementById('btn-detail-close').click(); return true;`);
    const title = await w(`return D.getElementById('kc-${id}')?.querySelector('.kcard__title').textContent ?? '';`);
    await typeIn('#f-search', title);
    // Attendre la relecture : la carte porte la personne posée
    await until(`D.querySelector('#kc-${id} .kcard__people')?.textContent.trim()`);
    await w(`D.getElementById('kc-${id}').click(); return true;`);
    await until(`D.getElementById('btn-edit-open')`);
    await w(`D.getElementById('btn-edit-open').click(); return true;`);
    await until(`D.getElementById('tf-people')`);
    // Affichée dans le bloc Personnes et comme Responsable (« hors ISD »), mais non proposée à l'ajout
    assert.ok(
      await w(
        `return !!D.querySelector('#tf-people [data-person="${out}"], #tf-people [data-charge="${out}"]') || D.getElementById('tf-people').innerHTML.includes('${out}');`,
      ),
    );
    assert.equal(await w(`return D.querySelectorAll('#tf-assignees option[value="${out}"]').length;`), 0);
    assert.equal(await w(`return D.querySelectorAll('#tf-Responsable optgroup option[value="${out}"]').length;`), 0);
    assert.equal(await w(`return D.getElementById('tf-Responsable').value;`), String(out));
    assert.match(await w(`return D.getElementById('tf-Responsable').selectedOptions[0].textContent;`), /\(hors ISD\)/);
    // Un changement de titre ne touche ni les assignés ni le Responsable
    await type('tf-titre', 'Titre modifié hors ISD');
    await w(`D.getElementById('btn-form-save').click(); return true;`);
    await until(`W.__writes.length === 1`);
    assert.deepEqual(await w(`return W.__writes[0].args[0];`), [
      ['UpdateRecord', 'Tasks', id, { titre: 'Titre modifié hors ISD' }],
    ]);
    assert.deepEqual(
      await w(
        `const t = await W.grist.docApi.fetchTable('Tasks'); const i = t.id.indexOf(${id}); return [t.assignees[i], t.Responsable[i]];`,
      ),
      [['L', out], out],
    );
  },
);

// ---------- Lot 2c : créations, fiche chantier, changement de chantier ----------

const change = (sel, value) =>
  w(
    `const t = D.querySelector(${JSON.stringify(sel)}); t.value = ${JSON.stringify(value)}; t.dispatchEvent(new W.Event('change', { bubbles: true })); return true;`,
  );
const typeIn = (sel, value) =>
  w(
    `const t = D.querySelector(${JSON.stringify(sel)}); t.value = ${JSON.stringify(value)}; t.dispatchEvent(new W.Event('input', { bubbles: true })); return true;`,
  );
/** Clic comme à la souris : le bouton prend le focus (il le retrouve à la fermeture d'une fenêtre). */
const clickOn = (sel) => w(`const b = D.querySelector(${JSON.stringify(sel)}); b.focus(); b.click(); return true;`);
const writes = () => w(`return W.__writes.map((x) => x.args[0]);`);
const firstOption = (sel) => w(`return [...D.querySelectorAll('${sel} option')].find((o) => o.value)?.value ?? null;`);

test(
  'créations (2c) : chantier, tâche dedans, deux sous-tâches, puis changement de chantier ; lots exacts',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    // Boutons une seule fois, au bout de la ligne des onglets : « Nouvelle tâche » en rouge, « Nouveau chantier » secondaire
    assert.deepEqual(await w(`return [...D.querySelectorAll('#app-tabs .tabs-end [data-create]')].map((b) => b.id);`), [
      'btn-new-chantier',
      'btn-new-task',
    ]);
    assert.equal(await w(`return D.getElementById('btn-new-task').classList.contains('fr-btn--secondary');`), false);
    // Nouveau chantier : vide → erreurs, rien n'est envoyé
    await clickOn('#btn-new-chantier');
    await until(`D.querySelector('dialog.cdlg[open] #cf-Nom_du_chantier')`);
    assert.equal(await w(`return D.activeElement.id;`), 'cf-Nom_du_chantier');
    assert.equal(await w(`return D.querySelectorAll('dialog .fr-error-text').length;`), 0);
    await clickOn('#cf-create-open');
    await until(`D.querySelectorAll('dialog .fr-error-text').length === 2`);
    assert.equal(await w(`return W.__writes.length;`), 0);
    await typeIn('#cf-Nom_du_chantier', 'Chantier de test 2c');
    const projet = Number(await firstOption('#cf-Projets'));
    await change('#cf-Projets', String(projet));
    await clickOn('#cf-create-open');
    await until(`D.getElementById('chantier-form')`);
    const chId = await w(`return Number(D.getElementById('chantier-form').dataset.chantierId);`);
    assert.deepEqual((await writes())[0], [
      [
        'AddRecord',
        'Chantiers',
        null,
        { Nom_du_chantier: 'Chantier de test 2c', Projets: ['L', projet], Statut: 'À cadrer' },
      ],
    ]);
    // « + Tâche » de la fiche chantier : chantier prérempli
    await clickOn('#chantier-form [data-create="task"]');
    await until(`D.querySelector('dialog.cdlg[open] #cf-titre')`);
    assert.equal(await w(`return D.getElementById('cf-cible').value;`), `${chId}:${projet}`);
    await typeIn('#cf-titre', 'Tâche de test 2c');
    await clickOn('#cf-create-open');
    await until(`D.getElementById('task-form')`);
    const taskId = await w(`return Number(D.getElementById('task-form').dataset.taskId);`);
    // Deux sous-tâches depuis la fiche tâche (« Créer » : la fiche reste ouverte et suit)
    for (const titre of ['Sous-tâche A', 'Sous-tâche B']) {
      await clickOn('#task-form [data-create="subtask"]');
      await until(`D.querySelector('dialog.cdlg[open] #cf-titre')`);
      await typeIn('#cf-titre', titre);
      await clickOn('#cf-create');
      await until(`!D.querySelector('dialog.cdlg')`);
    }
    await until(`D.querySelectorAll('#task-form .dt-list li').length === 2`);
    // Le focus revient au bouton d'origine
    assert.equal(await w(`return D.activeElement?.dataset.create ?? '';`), 'subtask');
    const all = await writes();
    assert.equal(all.length, 4);
    assert.deepEqual(all[1], [
      [
        'AddRecord',
        'Tasks',
        null,
        { titre: 'Tâche de test 2c', Chantier: chId, projet, statut: 'todo', type: 'tache' },
      ],
    ]);
    const subIds = [taskId + 1, taskId + 2];
    assert.deepEqual(all[2], [
      [
        'AddRecord',
        'Tasks',
        null,
        { titre: 'Sous-tâche A', Chantier: chId, projet, statut: 'todo', type: 'tache', parentTask: taskId },
      ],
    ]);
    // Changement de chantier : la tâche et ses deux sous-tâches dans un seul lot
    await clickOn('#tf-move');
    await until(`D.querySelector('dialog.cdlg[open] #cf-cible')`);
    assert.match(await w(`return D.getElementById('cf-follow').textContent;`), /2 sous-tâches suivront/);
    const target = await w(
      `return [...D.querySelectorAll('#cf-cible option')].map((o) => o.value).find((v) => v && !v.startsWith('${chId}:'));`,
    );
    await change('#cf-cible', target);
    await clickOn('#cf-submit');
    await until(`!D.querySelector('dialog.cdlg') && W.__writes.length === 5`);
    const [c, p] = target.split(':').map(Number);
    assert.deepEqual((await writes())[4], [
      ['UpdateRecord', 'Tasks', taskId, { Chantier: c, projet: p }],
      ['BulkUpdateRecord', 'Tasks', subIds, { Chantier: [c, c], projet: [p, p] }],
    ]);
    assert.match(await w(`return D.querySelector('.toast__text').textContent;`), /2 sous-tâches ont suivi/);
    assert.ok(await w(`return D.getElementById('task-form') !== null;`));
  },
);

test(
  'fiche chantier (2c) : nom et description enregistrés seuls, confirmation avant de quitter',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await w(`D.querySelector('.view [data-task]').click(); return true;`);
    await until(`D.querySelector('.dt-crumbs [data-ref-table="Chantiers"]')`);
    await clickOn('.dt-crumbs [data-ref-table="Chantiers"]');
    await until(`D.getElementById('btn-edit-open')`);
    // En lecture : « + Tâche » et statut rapide du chantier
    assert.ok(await w(`return Boolean(D.querySelector('.drawer__body [data-create="task"][data-chantier]'));`));
    await clickOn('#btn-edit-open');
    await until(`D.getElementById('chantier-form')`);
    const id = await w(`return Number(D.getElementById('chantier-form').dataset.chantierId);`);
    await typeIn('#tf-Nom_du_chantier', ' Nom modifié 2c ');
    await w(`D.getElementById('tf-more').open = true; return true;`);
    await typeIn('#tf-Description', 'Nouvelle description');
    // Fin avant le début : erreur, « Enregistrer » désactivé ; dates d'origine remises ensuite
    const [debut, fin] = await w(`return [D.getElementById('tf-Debut').value, D.getElementById('tf-Fin').value];`);
    await change('#tf-Debut', '2026-12-10');
    await change('#tf-Fin', '2026-12-01');
    assert.match(await w(`return D.getElementById('tf-Fin-msgs').textContent;`), /fin doit être/);
    assert.equal(await w(`return D.getElementById('btn-form-save').disabled;`), true);
    await change('#tf-Fin', fin);
    await change('#tf-Debut', debut);
    // Échap avec une saisie : confirmation
    await w(`D.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`);
    await until(`D.querySelector('.tf-foot--leave')`);
    await clickOn('[data-form=leave-continue]');
    await clickOn('#btn-form-save');
    await until(`W.__writes.length === 1`);
    assert.deepEqual((await writes())[0], [
      ['UpdateRecord', 'Chantiers', id, { Nom_du_chantier: 'Nom modifié 2c', Description: 'Nouvelle description' }],
    ]);
  },
);

test(
  'boutons de création : une seule fois dans l’en-tête global, sur tous les onglets ; atteignables à 390 px',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    for (const tab of TABS) {
      await w(`D.getElementById('tab-${tab}').click(); return true;`);
      await until(`D.querySelector('#view-panel[data-view="${tab}"]')`);
      assert.equal(await w(`return D.querySelectorAll('#btn-new-task, #btn-new-chantier').length;`), 2, tab);
      assert.equal(await w(`return D.querySelectorAll('.view-heading [data-create]').length;`), 0, tab);
    }
    // Compteur à gauche des boutons, sur la même ligne que les onglets
    await w(`D.getElementById('tab-kanban').click(); return true;`);
    await until(`D.querySelector('.view [data-task]')`);
    assert.ok(
      await w(`const c = D.querySelector('.task-count').getBoundingClientRect(); const b = D.getElementById('btn-new-chantier').getBoundingClientRect();
      const t = D.getElementById('tab-kanban').getBoundingClientRect(); return c.right <= b.left && Math.abs(b.top - t.top) < 24;`),
    );
    // 390 px : boutons visibles, dans l'écran, sans défilement horizontal de la page
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    try {
      await until(`D.documentElement.clientWidth <= 390`);
      for (const id of ['btn-new-task', 'btn-new-chantier']) {
        const r = await w(
          `const r = D.getElementById('${id}').getBoundingClientRect(); return [r.left, r.right, r.width];`,
        );
        assert.ok(r[0] >= 0 && r[1] <= 390 && r[2] > 40, `${id} : ${r}`);
      }
      assert.ok(await w(`return D.documentElement.scrollWidth <= D.documentElement.clientWidth;`));
      // Ouvrir puis fermer la fenêtre : le focus revient au bouton
      await clickOn('#btn-new-task');
      await until(`D.querySelector('dialog.cdlg[open]')`);
      await w(
        `D.querySelector('dialog.cdlg[open]').dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`,
      );
      await until(`!D.querySelector('dialog.cdlg[open]')`);
      assert.equal(await w(`return D.activeElement.id;`), 'btn-new-task');
    } finally {
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    assert.equal(await w(`return W.__writes.length;`), 0);
  },
);

test(
  'Tableau : colonnes par défaut sans défilement à 1440 px ; lignes affichées gardées après une écriture',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await w(`D.getElementById('tab-table').click(); return true;`);
    await until(`D.querySelector('.tbl__grid tbody tr')`);
    // Personnes (liste unique) et Équipe (ETP) côte à côte, sans défilement horizontal
    assert.ok(
      await w(`return Boolean(D.querySelector('.tbl__td--people')) && Boolean(D.querySelector('.tbl__th--etp'));`),
    );
    const over =
      await w(`let m = 0; for (let g = D.querySelector('.tbl__grid').parentElement; g && g !== D.body; g = g.parentElement)
        m = Math.max(m, g.scrollWidth - g.clientWidth);
      return [m, D.documentElement.scrollWidth - D.documentElement.clientWidth];`);
    assert.deepEqual(over, [0, 0]);
    // « Afficher 100 de plus », puis une écriture (relecture onRecords) : les 200 lignes restent affichées
    await w(`D.getElementById('tbl-more').click(); return true;`);
    await until(`D.querySelectorAll('.tbl__grid tbody tr').length === 200`);
    const id = await w(`return Number(D.querySelector('.tbl__grid tbody tr').dataset.task);`);
    await w(
      `await W.grist.docApi.applyUserActions([['UpdateRecord', 'Tasks', ${id}, { description: 'relecture' }]]); return true;`,
    );
    await sleep(800);
    assert.equal(await w(`return D.querySelectorAll('.tbl__grid tbody tr').length;`), 200);
    // Un tri repart à une page
    await w(`D.querySelector('[data-sort="start"]').click(); return true;`);
    await until(`D.querySelectorAll('.tbl__grid tbody tr').length === 100`);
  },
);

test('validation (2c) : erreurs claires, Échap demande confirmation, rien n’est envoyé', { skip: SKIP }, async () => {
  await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
  await clickOn('#btn-new-task');
  await until(`D.querySelector('dialog.cdlg[open] #cf-titre')`);
  await clickOn('#cf-create');
  await until(`D.querySelectorAll('dialog .fr-error-text').length >= 2`);
  const msgs = await w(
    `return [...D.querySelectorAll('dialog .fr-error-text')].map((x) => x.textContent).join(' | ');`,
  );
  assert.match(msgs, /titre est obligatoire/);
  assert.match(msgs, /Choisissez un chantier/);
  assert.equal(await w(`return D.getElementById('cf-create').disabled;`), true);
  await typeIn('#cf-titre', 'Tâche invalide');
  await change('#cf-cible', await firstOption('#cf-cible'));
  await change('#cf-dateDebut', '2026-12-10');
  await change('#cf-dateEcheance', '2026-12-01');
  assert.match(await w(`return D.getElementById('cf-dateEcheance-msgs').textContent;`), /échéance doit être/);
  // Échap : la fiche dessous n'est pas touchée, la fenêtre demande confirmation
  await w(
    `D.querySelector('dialog.cdlg').dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`,
  );
  await until(`D.getElementById('cf-leave-continue')`);
  assert.equal(await w(`return D.activeElement.id;`), 'cf-leave-continue');
  await clickOn('#cf-leave-discard');
  await until(`!D.querySelector('dialog.cdlg')`);
  assert.equal(await w(`return D.activeElement.id;`), 'btn-new-task');
  assert.equal(await w(`return W.__writes.length;`), 0);
});

test('mode essai (2c) : création et changement de chantier notés, rien n’est envoyé', { skip: SKIP }, async () => {
  await open('?edition=essai');
  await clickOn('#btn-new-task');
  await until(`D.querySelector('dialog.cdlg[open] #cf-titre')`);
  assert.match(await w(`return D.getElementById('cf-create-open').textContent;`), /essai/);
  await typeIn('#cf-titre', 'Tâche en essai');
  await change('#cf-cible', await firstOption('#cf-cible'));
  await clickOn('#cf-create-open');
  await until(`D.getElementById('task-form')`);
  assert.match(await w(`return D.querySelector('.toast__text').textContent;`), /Mode essai/);
  await clickOn('#tf-move');
  await until(`D.querySelector('dialog.cdlg[open] #cf-cible')`);
  await change(
    '#cf-cible',
    await w(`return [...D.querySelectorAll('#cf-cible option')].map((o) => o.value).filter(Boolean)[2];`),
  );
  await clickOn('#cf-submit');
  await until(`!D.querySelector('dialog.cdlg')`);
  assert.equal(await w(`return W.__writes.length;`), 0);
  assert.match(await w(`return D.getElementById('btn-edit-pill').textContent;`), /Mode essai · 2/);
});

test(
  'ajout refusé par une règle d’accès (2c) : message, saisie conservée, boutons retirés',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire,acl-ajout:Tasks');
    await clickOn('#btn-new-task');
    await until(`D.querySelector('dialog.cdlg[open] #cf-titre')`);
    await typeIn('#cf-titre', 'Refusée');
    await change('#cf-cible', await firstOption('#cf-cible'));
    await clickOn('#cf-create');
    await until(`D.getElementById('cf-alert')`);
    assert.match(await w(`return D.getElementById('cf-alert').textContent;`), /n’autorise pas votre compte à créer/);
    assert.match(await w(`return D.getElementById('cf-copy').value;`), /Refusée/);
    assert.equal(await w(`return D.getElementById('cf-titre').value;`), 'Refusée');
    // Nouvel essai : le droit d'ajout est relu avant l'envoi (refus de la règle d'accès gardé), rien n'est envoyé
    await clickOn('#cf-create');
    await sleep(400);
    assert.equal(await w(`return W.__writes.length;`), 1);
    assert.match(await w(`return D.getElementById('cf-alert').textContent;`), /n’autorise pas votre compte à créer/);
    assert.match(await w(`return D.getElementById('cf-copy').value;`), /Refusée/);
    await w(`D.getElementById('cf-cancel')?.click(); return true;`);
    await w(`D.getElementById('cf-leave-discard')?.click(); return true;`);
    await until(`!D.querySelector('dialog.cdlg')`);
    assert.equal(await w(`return Boolean(D.getElementById('btn-new-task'));`), false);
    assert.equal(await w(`return Boolean(D.getElementById('btn-new-chantier'));`), true);
  },
);

for (const query of ['', '?edition=1&doc=doc-dev-local&ecritures=lecteur', '?edition=1&doc=autre-doc']) {
  test(
    `édition coupée ou sans droit (2c) : aucun bouton de création (${query || 'sans paramètre'})`,
    { skip: SKIP },
    async () => {
      await open(query);
      for (const tab of ['kanban', 'table', 'gantt', 'portfolio']) {
        await w(`D.getElementById('tab-${tab}').click(); return true;`);
        await until(`D.querySelector('#view-panel[data-view="${tab}"] .view-heading')`);
        assert.equal(await w(`return D.querySelectorAll('[data-create]').length;`), 0, tab);
      }
      await w(`D.getElementById('tab-kanban').click(); return true;`);
      await until(`D.querySelector('.view [data-task]')`);
      await w(`D.querySelector('.view [data-task]').click(); return true;`);
      await until(`D.querySelector('.dt-crumbs [data-ref-table="Chantiers"]')`);
      assert.equal(await w(`return D.querySelectorAll('[data-create], #tf-move, #btn-edit-open').length;`), 0);
      await clickOn('.dt-crumbs [data-ref-table="Chantiers"]');
      await until(`D.querySelector('.dt-readonly')`);
      assert.equal(await w(`return D.querySelectorAll('[data-create], #btn-edit-open').length;`), 0);
      assert.equal(await w(`return W.__writes.length;`), 0);
    },
  );
}

test(
  'annuler une création (2c) : la ligne créée dans la session est supprimée, seule suppression possible',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await clickOn('#btn-new-task');
    await until(`D.querySelector('dialog.cdlg[open] #cf-titre')`);
    await typeIn('#cf-titre', 'À annuler');
    await change('#cf-cible', await firstOption('#cf-cible'));
    await clickOn('#cf-create');
    await until(`!D.querySelector('dialog.cdlg') && W.__writes.length === 1`);
    const id = await w(`const t = await W.grist.docApi.fetchTable('Tasks'); return t.id.at(-1);`);
    await until(`D.querySelector('.toast [data-toast-action]')`);
    await clickOn('.toast [data-toast-action]');
    await until(`W.__writes.length === 2`);
    assert.deepEqual((await writes())[1], [['RemoveRecord', 'Tasks', id]]);
    await until(`D.querySelector('.toast__text')?.textContent.includes('Création annulée')`);
    assert.equal(await w(`const t = await W.grist.docApi.fetchTable('Tasks'); return t.id.includes(${id});`), false);
  },
);

test(
  'annuler une création complétée ailleurs (2c, I1) : rien n’est supprimé, message clair',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await clickOn('#btn-new-task');
    await until(`D.querySelector('dialog.cdlg[open] #cf-titre')`);
    await typeIn('#cf-titre', 'Complétée ailleurs');
    await change('#cf-cible', await firstOption('#cf-cible'));
    await clickOn('#cf-create');
    await until(`!D.querySelector('dialog.cdlg') && W.__writes.length === 1`);
    const id = await w(`const t = await W.grist.docApi.fetchTable('Tasks'); return t.id.at(-1);`);
    // Quelqu'un d'autre ajoute une description et 20 h de charge (écriture hors du widget, non comptée ensuite)
    await w(
      `await W.grist.docApi.applyUserActions([['UpdateRecord', 'Tasks', ${id}, { description: 'travail de B', charges: '[{"teamId":2,"heures":20}]' }]]); W.__writes.length = 1; return true;`,
    );
    await clickOn('.toast [data-toast-action]');
    await until(`D.querySelector('.toast__text')?.textContent.includes('Création conservée')`);
    assert.equal(await w(`return W.__writes.length;`), 1);
    assert.equal(await w(`const t = await W.grist.docApi.fetchTable('Tasks'); return t.id.includes(${id});`), true);
  },
);

test(
  'changement de chantier (2c, M1) : une sous-tâche ajoutée ailleurs avant l’envoi suit aussi',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await clickOn('#btn-new-task');
    await until(`D.querySelector('dialog.cdlg[open] #cf-titre')`);
    await typeIn('#cf-titre', 'Tâche à déplacer');
    const cible = await firstOption('#cf-cible');
    await change('#cf-cible', cible);
    await clickOn('#cf-create-open');
    await until(`D.getElementById('task-form')`);
    const taskId = await w(`return Number(D.getElementById('task-form').dataset.taskId);`);
    const [c0, p0] = cible.split(':').map(Number);
    // Ailleurs, sans relecture par le widget : une sous-tâche est ajoutée
    const added = await w(
      `const r = await W.grist.docApi.applyUserActions([['AddRecord', 'Tasks', null, { titre: 'Sous-tâche d’ailleurs', Chantier: ${c0}, projet: ${p0}, parentTask: ${taskId} }]]); W.__writes.length = 1; return r.retValues[0];`,
    );
    await clickOn('#tf-move');
    await until(`D.querySelector('dialog.cdlg[open] #cf-cible')`);
    const target = await w(
      `return [...D.querySelectorAll('#cf-cible option')].map((o) => o.value).find((v) => v && !v.startsWith('${c0}:'));`,
    );
    await change('#cf-cible', target);
    await clickOn('#cf-submit');
    await until(`!D.querySelector('dialog.cdlg') && W.__writes.length === 2`);
    const [c, p] = target.split(':').map(Number);
    assert.deepEqual((await writes())[1], [
      ['UpdateRecord', 'Tasks', taskId, { Chantier: c, projet: p }],
      ['UpdateRecord', 'Tasks', added, { Chantier: c, projet: p }],
    ]);
    assert.match(await w(`return D.querySelector('.toast__text').textContent;`), /1 sous-tâche a suivi/);
  },
);

// ---------- Lot 2d : personnes de l'équipe ISD ----------

/** Onglet Équipe ouvert (annuaire affiché). */
async function openTeam(query) {
  await open(query);
  await w(`D.getElementById('tab-team').click(); return true;`);
  await until(`D.querySelector('#view-panel[data-view="team"] [data-person]')`);
}
const teamWrites = async () => (await writes()).flat().filter((a) => a[1] === 'Team' || a[1] === 'Disponibilites');

test(
  'équipe (2d) : ajouter une personne, modifier sa capacité, désactiver, réactiver ; jamais de RemoveRecord sur Team',
  { skip: SKIP },
  async () => {
    await openTeam('?edition=1&doc=doc-dev-local&ecritures=memoire,capacite-donnee');
    // Ajout : erreurs seulement après une tentative, rôle parmi les choix existants
    await clickOn('#btn-person-add');
    await until(`D.querySelector('dialog.cdlg[open] #pf-nom')`);
    const roles = await w(`return [...D.querySelectorAll('#pf-role option')].map((o) => o.value).filter(Boolean);`);
    assert.deepEqual(roles, ['DE', 'DA', 'DS', 'PO Data', 'Management']);
    await clickOn('#pf-submit');
    assert.equal(await w(`return W.__writes.length;`), 0);
    await typeIn('#pf-nom', 'Personne Essai2d');
    await typeIn('#pf-email', 'personne.essai2d@exemple.fr');
    await change('#pf-role', 'DS');
    await clickOn('#pf-submit');
    await until(`!D.querySelector('dialog.cdlg') && W.__writes.length === 1`);
    const [[add]] = await writes();
    assert.equal(add[0], 'AddRecord');
    assert.equal(add[1], 'Team');
    assert.deepEqual(add[3], {
      nom: 'Personne Essai2d',
      role: 'DS',
      Domaine: 'Ingénierie et sciences des données - ISD',
      actif: true,
      email: 'personne.essai2d@exemple.fr',
    });
    // La fiche de la personne s'ouvre : « Modifier », capacité 28,5 h
    await until(`D.getElementById('btn-edit-open') && D.getElementById('btn-person-active')`);
    await clickOn('#btn-edit-open');
    await until(`D.getElementById('person-form')`);
    const id = await w(`return Number(D.getElementById('person-form').dataset.personId);`);
    await typeIn('#tf-capaciteHebdo', '61');
    assert.equal(await w(`return D.getElementById('btn-form-save').disabled;`), true);
    await typeIn('#tf-capaciteHebdo', '28,5');
    await clickOn('#btn-form-save');
    await until(`!D.getElementById('person-form') && W.__writes.length === 2`);
    // Désactiver : confirmation qui dit que tâches et charges restent intactes
    await until(`D.querySelector('#btn-person-active[data-person-active="0"]')`);
    await clickOn('#btn-person-active');
    await until(`D.querySelector('dialog.cdlg[open] #pf-submit')`);
    assert.match(await w(`return D.querySelector('dialog.cdlg').textContent;`), /restent intacts/);
    // Focus initial sur l'action sûre « Annuler » (APG), jamais sur « Désactiver »
    assert.equal(await w(`return D.activeElement.id;`), 'pf-cancel');
    await clickOn('#pf-submit');
    await until(`W.__writes.length === 3`);
    await until(`D.querySelector('#btn-person-active[data-person-active="1"]')`);
    // Réactiver depuis la liste (« Inclure les inactifs ») : la personne y est grisée
    await w(`D.getElementById('btn-detail-close').click(); return true;`);
    await until(`D.getElementById('app-detail').dataset.open === 'false'`);
    assert.equal(await w(`return Boolean(D.querySelector('[data-person-reactivate="${id}"]'));`), false);
    await w(`D.getElementById('team-inactive').click(); return true;`);
    await until(`D.querySelector('[data-row="${id}"].is-inactive [data-person-reactivate="${id}"]')`);
    await clickOn(`[data-person-reactivate="${id}"]`);
    await until(`W.__writes.length === 4`);
    await until(`D.querySelector('[data-row="${id}"]:not(.is-inactive)')`);
    // « Annuler » du message : la personne redevient inactive (une mise à jour, pas une suppression)
    await clickOn('[data-toast-action]');
    await until(`W.__writes.length === 5`);
    const all = await writes();
    assert.deepEqual(all.slice(1), [
      [['UpdateRecord', 'Team', id, { capaciteHebdo: 28.5 }]],
      [['UpdateRecord', 'Team', id, { actif: false }]],
      [['UpdateRecord', 'Team', id, { actif: true }]],
      [['UpdateRecord', 'Team', id, { actif: false }]],
    ]);
    assert.ok(!all.flat().some((a) => a[0] === 'RemoveRecord'));
    // Annuler toutes les écritures restantes depuis le panneau : jamais de RemoveRecord sur Team
    for (let i = 0; i < 5; i++) {
      await w(`D.getElementById('btn-edit-pill').click(); return true;`);
      await until(`D.querySelector('[data-edit-undo]')`);
      if (await w(`return D.querySelector('[data-edit-undo]').disabled;`)) break;
      const n = await w(`return W.__writes.length;`);
      await w(`D.querySelector('[data-edit-undo]').click(); return true;`);
      await sleep(400);
      if ((await w(`return W.__writes.length;`)) === n) break;
    }
    assert.ok(!(await teamWrites()).some((a) => a[0] === 'RemoveRecord'));
  },
);

test(
  'équipe (2d) : N+1 choisi parmi le Management de tous les Domaines (UpdateRecord n_1)',
  { skip: SKIP },
  async () => {
    await openTeam('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await clickOn('[data-person="1"]');
    await until(`D.getElementById('btn-edit-open')`);
    await clickOn('#btn-edit-open');
    await until(`D.getElementById('person-form')`);
    const groups = await w(`return [...D.querySelectorAll('#tf-n_1 optgroup')].map((g) => g.label);`);
    assert.equal(groups[0], 'Management (tous Domaines)');
    const managers = await w(
      `return [...D.querySelectorAll('#tf-n_1 optgroup:first-of-type option')].map((o) => o.textContent);`,
    );
    assert.deepEqual(managers, ['Fanny Manager', 'Gus Manager Externe', 'Marius Manager']);
    // Ni la personne elle-même, ni une personne hors ISD sans rôle Management
    assert.equal(
      await w(`return Boolean(D.querySelector('#tf-n_1 option[value="1"], #tf-n_1 option[value="16"]'));`),
      false,
    );
    await change('#tf-n_1', '15');
    await clickOn('#btn-form-save');
    await until(`!D.getElementById('person-form') && W.__writes.length === 1`);
    assert.deepEqual(await writes(), [[['UpdateRecord', 'Team', 1, { n_1: 15 }]]]);
  },
);

/** Touche réelle (CDP) envoyée à l'élément focalisé : Tab, Maj+Tab, Entrée. */
async function pressKey(key, shift = false) {
  const codes = { Tab: 9, Enter: 13 };
  const base = { key, code: key, windowsVirtualKeyCode: codes[key], modifiers: shift ? 8 : 0 };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  if (key === 'Enter') await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...base });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

test(
  'fiche en édition : Tab suit l’ordre natif (champ désactivé sauté, un arrêt par groupe radio) et boucle',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await openForm();
    // Colonne non modifiable simulée : le champ titre est désactivé, comme le rend attrs()
    await w(`D.getElementById('tf-titre').disabled = true; D.getElementById('btn-detail-close').focus(); return true;`);
    const where = `const a = D.activeElement; return { id: a.id, name: a.type === 'radio' ? a.name : '', inside: Boolean(a.closest('#app-detail')), disabled: Boolean(a.disabled) };`;
    const seen = [];
    for (let i = 0; i < 200; i++) {
      await pressKey('Tab');
      const at = await w(where);
      seen.push(at);
      if (at.id === 'btn-detail-close') break;
    }
    const trace = seen.map((x) => x.id || x.name).join(',');
    assert.equal(seen.at(-1).id, 'btn-detail-close', `pas de retour à « Fermer » : ${trace}`);
    assert.ok(seen.length > 3, trace);
    assert.ok(
      seen.every((x) => x.inside && !x.disabled),
      trace,
    );
    assert.ok(!seen.some((x) => x.id === 'tf-titre'), trace);
    // Jamais bloqué sur place (un champ date garde le focus le temps de ses segments jour, mois, année), et un seul
    // arrêt par groupe de boutons radio (priorité, unité des charges)
    let run = 1;
    for (let i = 1; i < seen.length; i++) {
      run = seen[i].id === seen[i - 1].id ? run + 1 : 1;
      assert.ok(run <= 4, trace);
    }
    const radios = seen.filter((x) => x.name).map((x) => x.name);
    assert.ok(radios.includes('tf-priorite'), trace);
    assert.equal(new Set(radios).size, radios.length, trace);
    // Maj+Tab depuis « Fermer » : dernier arrêt de la fiche, sans sortir
    await pressKey('Tab', true);
    const last = await w(where);
    assert.ok(last.inside && last.id !== 'btn-detail-close', JSON.stringify(last));
    await pressKey('Tab');
    assert.equal((await w(where)).id, 'btn-detail-close');
  },
);

test(
  'message : un nouveau message garde le focus sur son bouton ; à sa fermeture, le focus revient',
  { skip: SKIP },
  async () => {
    await open('');
    // Page considérée comme active : les événements focusin sont émis comme pour un utilisateur
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Module du message chargé dans la page hôte (même origine) : instance isolée de celle du widget
    const top = async (body) => {
      const r = await send('Runtime.evaluate', {
        expression: `(async () => { ${body} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description));
      return r.result?.result?.value;
    };
    const focused = `const a = document.activeElement; return a.id || (a.hasAttribute('data-toast-action') ? 'action' : a.hasAttribute('data-toast-close') ? 'close' : a.tagName);`;
    await top(`
    const { createToast } = await import('/js/ui/toast.js');
    const b = document.createElement('button'); b.id = 'origine'; document.body.append(b); b.focus();
    window.__t = createToast();
    window.__t.show('Un', { onAction() {} });
    document.querySelector('.toast-region:last-of-type [data-toast-action]').focus();
    window.__t.show('Deux', { onAction() {} });
    return true;`);
    assert.equal(await top(focused), 'action');
    await top(`window.__t.show('Trois'); return true;`);
    assert.equal(await top(focused), 'close');
    await top(`window.__t.hide(); return true;`);
    assert.equal(await top(focused), 'origine');
    await send('Emulation.setFocusEmulationEnabled', { enabled: false });
  },
);

test(
  'fiche ouverte : le bouton « Annuler » du message est atteignable au Tab, la fiche reste modale',
  { skip: SKIP },
  async () => {
    await openTeam('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await clickOn('[data-person="2"]');
    await until(`D.querySelector('#btn-person-active[data-person-active="0"]')`);
    await clickOn('#btn-person-active');
    await until(`D.querySelector('dialog.cdlg[open] #pf-submit')`);
    await clickOn('#pf-submit');
    await until(`W.__writes.length === 1 && D.querySelector('.toast [data-toast-action]')`);
    await until(`D.getElementById('app-detail').dataset.open === 'true'`);
    await w(`D.getElementById('btn-detail-close').focus(); return true;`);
    // Tab depuis « Fermer » : on parcourt la fiche puis le message, sans jamais sortir ailleurs
    const where = `const a = D.activeElement; return a.closest('#app-detail') ? 'fiche' : a.closest('.toast-region') ? (a.matches('[data-toast-action]') ? 'annuler' : 'message') : 'ailleurs';`;
    const seen = [];
    for (let i = 0; i < 60 && !seen.includes('annuler'); i++) {
      await pressKey('Tab');
      seen.push(await w(where));
    }
    assert.ok(seen.includes('annuler'), seen.join(','));
    assert.ok(!seen.includes('ailleurs'), seen.join(','));
    // Maj+Tab revient dans la fiche ; Tab puis Tab bouclent vers la fiche après le message
    await pressKey('Tab', true);
    assert.equal(await w(where), 'fiche');
    await pressKey('Tab');
    assert.equal(await w(where), 'annuler');
    await pressKey('Tab');
    assert.equal(await w(where), 'message');
    await pressKey('Tab');
    assert.equal(await w(where), 'fiche');
    assert.equal(await w(`return D.getElementById('app-detail').getAttribute('aria-modal');`), 'true');
    // Entrée sur « Annuler » : la personne est réactivée, le focus revient dans la fiche
    await pressKey('Tab', true);
    await pressKey('Tab', true);
    assert.equal(await w(where), 'annuler');
    await pressKey('Enter');
    await until(`W.__writes.length === 2`);
    assert.deepEqual((await writes())[1], [['UpdateRecord', 'Team', 2, { actif: true }]]);
    await until(`D.activeElement.closest('#app-detail')`);
  },
);

/** Arrêt d'urgence relu à une relecture : la session passe en lecture sans redessiner les fenêtres ouvertes. */
async function cutEditing() {
  await w(`W.__coupe = true; W.grist.__simulateChange(); return true;`);
  await until(`/lecture seule pour cette session/.test(D.querySelector('.toast__text')?.textContent ?? '')`);
}
/** L'action refusée au moment d'agir ne lit rien (ni ligne relue, ni flags.json) et n'écrit rien. */
async function refusedWithoutReading(act) {
  await sleep(400);
  const before = await w(`return W.__reads.length;`);
  await act();
  await sleep(500);
  assert.deepEqual(await w(`return W.__reads.slice(${before});`), []);
  assert.equal(await w(`return W.__writes.length;`), 0);
}

test(
  'droits relus à l’envoi (2d) : « Désactiver » ouvert avant la coupure, puis « Réactiver » et statut périmés',
  { skip: SKIP },
  async () => {
    await openTeam('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await clickOn('[data-person="2"]');
    await until(`D.querySelector('#btn-person-active[data-person-active="0"]')`);
    await clickOn('#btn-person-active');
    await until(`D.querySelector('dialog.cdlg[open] #pf-submit')`);
    await cutEditing();
    // La fenêtre est restée ouverte : l'envoi relit le droit, rien n'est écrit, message de la coupure
    assert.ok(await w(`return Boolean(D.querySelector('dialog.cdlg[open] #pf-submit:not([disabled])'));`));
    await refusedWithoutReading(() => clickOn('#pf-submit'));
    await until(`D.querySelector('dialog.cdlg[open] #tf-alert')`);
    assert.match(
      await w(`return D.querySelector('dialog.cdlg #tf-alert').textContent;`),
      /coupée pour toutes les pages/,
    );
    assert.equal(await w(`return D.getElementById('pf-submit').disabled;`), true);
    await clickOn('#pf-cancel');
    await until(`!D.querySelector('dialog.cdlg')`);
    // Boutons périmés (rendus avant la coupure) : « Réactiver » dans la liste, statut rapide dans la fiche
    await w(
      `const b = D.createElement('button'); b.type = 'button'; b.id = 'stale-re'; b.dataset.personReactivate = '2'; D.querySelector('#view-panel[data-view="team"] [data-person]').closest('li, tr, div').append(b); return true;`,
    );
    await refusedWithoutReading(() => clickOn('#stale-re'));
    await w(`D.getElementById('tab-kanban').click(); return true;`);
    await until(`D.querySelector('.view [data-task]')`);
    await w(`D.querySelector('.view [data-task]').click(); return true;`);
    await until(
      `D.getElementById('app-detail').dataset.open === 'true' && D.querySelector('#app-detail .drawer__body')`,
    );
    await w(
      `const b = D.createElement('button'); b.type = 'button'; b.id = 'stale-status'; b.dataset.setStatus = 'done'; D.querySelector('#app-detail .drawer__body').append(b); return true;`,
    );
    await refusedWithoutReading(() => clickOn('#stale-status'));
  },
);

test(
  'droits relus à l’envoi (2c) : « Nouvelle tâche » ouverte avant la coupure, rien n’est créé',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await clickOn('#btn-new-task');
    await until(`D.querySelector('dialog.cdlg[open] #cf-titre')`);
    await typeIn('#cf-titre', 'Après coupure');
    await change('#cf-cible', await firstOption('#cf-cible'));
    await cutEditing();
    await refusedWithoutReading(() => clickOn('#cf-create'));
    await until(`D.querySelector('dialog.cdlg[open] #cf-alert')`);
    assert.match(await w(`return D.getElementById('cf-alert').textContent;`), /coupée pour toutes les pages/);
  },
);

test('équipe (2d) : indisponibilité ajoutée puis modifiée (AddRecord puis UpdateRecord)', { skip: SKIP }, async () => {
  await openTeam('?edition=1&doc=doc-dev-local&ecritures=memoire');
  await w(`D.querySelector('[data-person]').click(); return true;`);
  await until(`D.getElementById('btn-unav-add')`);
  const person = await w(`return Number(D.querySelector('[data-unav-add]').dataset.unavAdd);`);
  await clickOn('#btn-unav-add');
  await until(`D.querySelector('dialog.cdlg[open] #pf-dateDebut')`);
  await change('#pf-dateDebut', '2027-03-08');
  await change('#pf-dateFin', '2027-03-01');
  await clickOn('#pf-submit');
  assert.equal(await w(`return W.__writes.length;`), 0);
  await change('#pf-dateFin', '2027-03-12');
  await typeIn('#pf-dispo', '50');
  await typeIn('#pf-type', 'Formation');
  await clickOn('#pf-submit');
  await until(`!D.querySelector('dialog.cdlg') && W.__writes.length === 1`);
  await until(`D.querySelector('[data-unav-edit]')`);
  await clickOn('[data-unav-edit]');
  await until(`D.querySelector('dialog.cdlg[open] #pf-dispo')`);
  await typeIn('#pf-dispo', '20');
  await clickOn('#pf-submit');
  await until(`!D.querySelector('dialog.cdlg') && W.__writes.length === 2`);
  const [[a], [u]] = await writes();
  assert.deepEqual(a, [
    'AddRecord',
    'Disponibilites',
    null,
    { membre: person, dateDebut: 1804464000, dateFin: 1804809600, dispo: 0.5, type: 'Formation' },
  ]);
  assert.equal(u[0], 'UpdateRecord');
  assert.deepEqual(u[3], { dispo: 0.2 });
});

test(
  'équipe (2d) en mode essai : ajout et désactivation notés, rien n’est envoyé ; capacité vide de la Feuille en lecture',
  { skip: SKIP },
  async () => {
    await openTeam('?edition=essai');
    await clickOn('#btn-person-add');
    await until(`D.querySelector('dialog.cdlg[open] #pf-nom')`);
    // Colonne vide de la Feuille : non proposée à la création
    assert.equal(await w(`return Boolean(D.getElementById('pf-capaciteHebdo'));`), false);
    await typeIn('#pf-nom', 'Personne Essai');
    await change('#pf-role', 'Management');
    await clickOn('#pf-submit');
    await until(`!D.querySelector('dialog.cdlg') && D.getElementById('btn-person-active')`);
    await clickOn('#btn-edit-open');
    await until(`D.getElementById('person-form')`);
    assert.equal(await w(`return D.getElementById('tf-capaciteHebdo').disabled;`), true);
    assert.match(await w(`return D.getElementById('tf-capaciteHebdo-msgs').textContent;`), /Colonne vide/);
    await clickOn('#btn-form-cancel');
    await until(`D.getElementById('btn-person-active')`);
    await clickOn('#btn-person-active');
    await until(`D.querySelector('dialog.cdlg[open] #pf-submit')`);
    await clickOn('#pf-submit');
    await until(`D.querySelector('#btn-person-active[data-person-active="1"]')`);
    assert.equal(await w(`return W.__writes.length;`), 0);
    assert.match(await w(`return D.getElementById('btn-edit-pill').textContent;`), /Mode essai · 2/);
  },
);

for (const query of [
  '',
  '?edition=1&doc=autre-document&ecritures=memoire',
  '?edition=1&doc=doc-dev-local&ecritures=lecteur',
]) {
  test(
    `équipe (2d), édition coupée ou sans droit (${query || 'sans paramètre'}) : aucun bouton d’édition`,
    { skip: SKIP },
    async () => {
      await openTeam(query);
      await w(`D.getElementById('team-inactive').click(); return true;`);
      await until(`D.querySelector('.tperson.is-inactive')`);
      assert.equal(await w(`return Boolean(D.getElementById('btn-person-add'));`), false);
      assert.equal(await w(`return D.querySelectorAll('[data-person-reactivate]').length;`), 0);
      await w(`D.querySelector('.tperson.is-inactive [data-person]').click(); return true;`);
      await until(`D.getElementById('app-detail').dataset.open === 'true'`);
      for (const sel of ['#btn-edit-open', '#btn-person-active', '#btn-unav-add', '[data-unav-edit]'])
        assert.equal(await w(`return Boolean(D.querySelector('${sel}'));`), false, sel);
      assert.match(await w(`return D.querySelector('.dt-readonly').textContent;`), /Lecture seule|sans droit/);
      assert.equal(await w(`return W.__writes.length;`), 0);
    },
  );
}

/** Clavier dans la recherche des tags (Entrée, flèches, Échap, Retour arrière). */
const tagKey = (key) =>
  w(
    `D.getElementById('tf-tags').dispatchEvent(new W.KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })); return true;`,
  );
const tagChips = () =>
  w(
    `return [...D.querySelectorAll('[data-field="tags"] .tf-tagchip')].map((c) => [c.querySelector('.tf-chip__text').firstChild.textContent, c.classList.contains('tf-tagchip--undeclared')]);`,
  );

test(
  'tags (2e) : tâche, ajout d’un tag existant au clavier et d’un nom nouveau non déclaré, puis retrait ; lots exacts',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    const id = await openForm();
    assert.deepEqual(await tagChips(), []);
    // Recherche sans accents ni casse : « ATEL » propose « atelier », Entrée l'ajoute
    await w(`D.getElementById('tf-tags').focus(); return true;`);
    await typeIn('#tf-tags', 'ATEL');
    await until(`!D.getElementById('tf-tags-list').hidden`);
    assert.equal(await w(`return D.getElementById('tf-tags').getAttribute('aria-expanded');`), 'true');
    assert.match(await w(`return D.getElementById('tf-tags-opt-0').textContent;`), /atelier/);
    await tagKey('Enter');
    await until(`D.querySelectorAll('[data-field="tags"] .tf-tagchip').length === 1`);
    assert.equal(await w(`return D.activeElement.id;`), 'tf-tags');
    // Nom nouveau : dernière option « Affecter le nouveau tag », atteinte aux flèches ; Échap ferme la liste seule
    await typeIn('#tf-tags', '  Tag   neuf ');
    await until(`D.querySelector('.tf-tagopt--create')`);
    await tagKey('Escape');
    await until(`D.getElementById('tf-tags-list').hidden`);
    assert.equal(await w(`return Boolean(D.getElementById('task-form'));`), true);
    await tagKey('ArrowDown');
    await until(`!D.getElementById('tf-tags-list').hidden`);
    await w(
      `const n = D.querySelectorAll('.tf-tagopt').length; for (let i = 1; i < n; i++) D.getElementById('tf-tags').dispatchEvent(new W.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return true;`,
    );
    assert.equal(
      await w(`return D.getElementById(D.getElementById('tf-tags').getAttribute('aria-activedescendant')).className;`),
      'tf-tagopt is-active tf-tagopt--create',
    );
    await tagKey('Enter');
    await until(`D.querySelectorAll('[data-field="tags"] .tf-tagchip').length === 2`);
    // Tags des tâches : aucun choix déclaré dans la Feuille, tous marqués « non déclaré »
    assert.deepEqual(await tagChips(), [
      ['atelier', true],
      ['Tag neuf', true],
    ]);
    assert.equal(await w(`return W.__writes.length;`), 0);
    await clickOn('#btn-form-save');
    await until(`W.__writes.length === 1`);
    assert.deepEqual((await writes())[0], [['UpdateRecord', 'Tasks', id, { tags: ['L', 'atelier', 'Tag neuf'] }]]);
    // En lecture : pastilles dans la fiche ; puis retrait de « atelier » (bouton de la pastille)
    await until(`D.querySelector('.drawer__body .tf-tagchip')`);
    await clickOn('#btn-edit-open');
    await until(`D.getElementById('task-form')`);
    await clickOn('[data-remove-tag="0"]');
    await until(`D.querySelectorAll('[data-field="tags"] .tf-tagchip').length === 1`);
    // Retour arrière dans la recherche vide : retire le dernier tag ; Annuler les modifications le rend
    await tagKey('Backspace');
    await until(`D.querySelectorAll('[data-field="tags"] .tf-tagchip').length === 0`);
    await typeIn('#tf-tags', 'Tag neuf');
    await until(`D.querySelector('.tf-tagopt')`);
    await tagKey('Enter');
    await until(`D.querySelectorAll('[data-field="tags"] .tf-tagchip').length === 1`);
    await clickOn('#btn-form-save');
    await until(`W.__writes.length === 2`);
    assert.deepEqual((await writes())[1], [['UpdateRecord', 'Tasks', id, { tags: ['L', 'Tag neuf'] }]]);
  },
);

test(
  'tags (2e) : chantier, tag choisi à la souris et tag retiré ; choix déclaré et non déclaré distingués',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await w(`D.querySelector('.view [data-task]').click(); return true;`);
    await until(`D.querySelector('.dt-crumbs [data-ref-table="Chantiers"]')`);
    await clickOn('.dt-crumbs [data-ref-table="Chantiers"]');
    await until(`D.getElementById('btn-edit-open')`);
    await clickOn('#btn-edit-open');
    await until(`D.getElementById('chantier-form')`);
    const id = await w(`return Number(D.getElementById('chantier-form').dataset.chantierId);`);
    // « Intégration de données » est un choix déclaré de Chantiers.tags
    assert.deepEqual(await tagChips(), [['Intégration de données', false]]);
    // Clic dans la recherche : liste des tags des chantiers (pas ceux des tâches)
    await clickOn('#tf-tags');
    await until(`!D.getElementById('tf-tags-list').hidden`);
    const opts = await w(`return [...D.querySelectorAll('.tf-tagopt__name')].map((x) => x.textContent);`);
    assert.deepEqual(opts, ['Projet pilote']);
    await w(
      `const o = D.querySelector('.tf-tagopt'); o.dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true, cancelable: true })); o.click(); return true;`,
    );
    await until(`D.querySelectorAll('[data-field="tags"] .tf-tagchip').length === 2`);
    await clickOn('[data-remove-tag="0"]');
    await until(`D.querySelectorAll('[data-field="tags"] .tf-tagchip').length === 1`);
    assert.deepEqual(await tagChips(), [['Projet pilote', true]]);
    await clickOn('#btn-form-save');
    await until(`W.__writes.length === 1`);
    assert.deepEqual((await writes())[0], [['UpdateRecord', 'Chantiers', id, { tags: ['L', 'Projet pilote'] }]]);
  },
);

test('tags (2e), mode essai : l’ajout est noté dans le journal, rien n’est envoyé', { skip: SKIP }, async () => {
  await open('?edition=essai');
  await openForm();
  await w(`D.getElementById('tf-tags').focus(); return true;`);
  await typeIn('#tf-tags', 'essai');
  await until(`D.querySelector('.tf-tagopt--create')`);
  await tagKey('Enter');
  await until(`D.querySelectorAll('[data-field="tags"] .tf-tagchip').length === 1`);
  await clickOn('#btn-form-save');
  await until(`!D.getElementById('task-form')`);
  assert.equal(await w(`return W.__writes.length;`), 0);
  assert.match(await w(`return D.getElementById('btn-edit-pill').textContent;`), /Mode essai · 1/);
});

test(
  'tags (2e) : cellule illisible montrée et bloquée, remplacée seulement après confirmation ; annonce lue',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    const id = await w(`return Number(D.querySelector('.view [data-task]').dataset.task);`);
    await w(
      `await W.grist.docApi.applyUserActions([['UpdateRecord', 'Tasks', ${id}, { tags: 'texte libre' }]]); return true;`,
    );
    await sleep(800);
    assert.equal(await openForm(), id);
    assert.equal(await w(`return D.getElementById('tf-tags').disabled;`), true);
    assert.match(await w(`return D.querySelector('.tf-tags__unreadable').textContent;`), /texte libre/);
    await clickOn('#tf-tags-replace');
    await until(`D.getElementById('tf-tags-replace-confirm')`);
    await clickOn('#tf-tags-replace-confirm');
    await until(`!D.getElementById('tf-tags').disabled`);
    // Annonces : région persistante du panneau (#drawer-live), dans le dialogue mais hors du contenu redessiné ;
    // le texte change sur le même nœud, resté connecté à chaque rendu
    assert.equal(
      await w(
        `W.__live = D.getElementById('drawer-live'); return D.getElementById('app-detail').contains(W.__live) && !W.__live.closest('.drawer__content') && W.__live.getAttribute('aria-live');`,
      ),
      'polite',
    );
    await w(
      `W.__connected = []; new W.MutationObserver(() => W.__connected.push(W.__live.isConnected)).observe(W.__live, { childList: true, characterData: true, subtree: true }); D.getElementById('tf-tags').focus(); return true;`,
    );
    await typeIn('#tf-tags', 'remplacé');
    await until(`D.querySelector('.tf-tagopt--create')`);
    await tagKey('Enter');
    await until(`D.querySelectorAll('[data-field="tags"] .tf-tagchip').length === 1`);
    await until(`/« remplacé » ajouté/.test(W.__live.textContent)`);
    await clickOn('[data-remove-tag="0"]');
    await until(`/« remplacé » retiré/.test(W.__live.textContent)`);
    await typeIn('#tf-tags', 'remplacé');
    await until(`D.querySelector('.tf-tagopt')`);
    await tagKey('Enter');
    await until(`/« remplacé » ajouté/.test(W.__live.textContent)`);
    assert.equal(await w(`return D.getElementById('drawer-live') === W.__live && W.__live.isConnected;`), true);
    // Chaque changement de texte (vidé puis posé, trois messages) a eu lieu sur le nœud connecté
    const seen = await w(`return W.__connected;`);
    assert.ok(seen.length >= 3 && seen.every(Boolean), JSON.stringify(seen));
    assert.equal(await w(`return D.getElementById('tf-tags-label').getAttribute('tabindex');`), '-1');
    await clickOn('#btn-form-save');
    await until(`W.__writes.length === 2`);
    assert.deepEqual((await writes())[1], [['UpdateRecord', 'Tasks', id, { tags: ['L', 'remplacé'] }]]);
  },
);

test('statistiques : charge par profil tracée sur 12 mois, légende et tableau de valeurs', { skip: SKIP }, async () => {
  await open('');
  await w(`D.getElementById('tab-stats').click(); return true;`);
  await until(`D.querySelector('#stats-roles')`);
  const r = await w(`const c = D.getElementById('stats-roles').closest('section');
    return {
      legend: [...c.querySelectorAll('.stats__legend li')].map((li) => li.textContent.trim()),
      rows: c.querySelectorAll('.rbars__list > li').length,
      segs: c.querySelectorAll('.rbars__seg').length,
      current: c.querySelectorAll('.rbars__row--current').length,
      table: c.querySelectorAll('.stats__table tbody tr').length,
      heads: [...c.querySelectorAll('.stats__table thead th')].map((th) => th.textContent.trim()),
      axes: [...c.querySelectorAll('.rbars__axis')].map((p) => p.textContent.trim()),
    };`);
  assert.deepEqual(r.legend.slice(0, 5), ['PO', 'DA', 'DS', 'DE', 'Management ISD']);
  assert.equal(r.rows, 12);
  assert.equal(r.table, 12);
  assert.equal(r.current, 1);
  assert.ok(r.segs > 0, 'aucun segment tracé');
  assert.equal(r.heads[0], 'Mois');
  assert.equal(r.heads.at(-1), 'Total');
  assert.equal(r.axes.length, 2);
  assert.equal(await w(`return W.__writes.length;`), 0);
});

test(
  'statistiques : « Contrôle qualité des données » repliée par défaut, total affiché, état retenu',
  { skip: SKIP },
  async () => {
    await open('');
    await w(`D.getElementById('tab-stats').click(); return true;`);
    await until(`D.querySelector('#stats-quality')`);
    const state = () =>
      w(`const b = D.getElementById('stats-quality');
      return { expanded: b.getAttribute('aria-expanded'), text: b.textContent.replace(/\\s+/g, ' ').trim(),
        hidden: D.getElementById(b.getAttribute('aria-controls')).hidden,
        heading: b.parentElement.tagName };`);
    const closed = await state();
    assert.equal(closed.expanded, 'false');
    assert.equal(closed.hidden, true);
    assert.equal(closed.heading, 'H3');
    assert.match(closed.text, /^▸ Contrôle qualité des données · (\d+|✓Aucune anomalie)$/);
    // Clavier : le bouton garde le focus après l'ouverture (pas de nouveau rendu)
    await w(`const b = D.getElementById('stats-quality'); b.focus(); b.click(); return true;`);
    const opened = await state();
    assert.equal(opened.expanded, 'true');
    assert.equal(opened.hidden, false);
    assert.equal(await w(`return D.activeElement?.id ?? null;`), 'stats-quality');
    assert.equal(await w(`return JSON.parse(W.localStorage.getItem('roadmap-isd:prefs')).statsQualityOpen;`), true);
    // Changer d'onglet puis revenir : la carte reste dépliée
    await w(`D.getElementById('tab-kanban').click(); return true;`);
    await until(`D.querySelector('#view-panel[data-view="kanban"]')`);
    await w(`D.getElementById('tab-stats').click(); return true;`);
    await until(`D.querySelector('#stats-quality')`);
    assert.equal((await state()).expanded, 'true');
    assert.equal(await w(`return W.__writes.length;`), 0);
  },
);

// ---------- Arrivée sur le Gantt ----------
test(
  'arrivée : le Gantt s’ouvre malgré une vue mémorisée et une ancienne vue d’accueil (Synthèse) ; vue= ouvre l’onglet demandé',
  { skip: SKIP },
  async () => {
    const host = `${BASE}/dev/host.html`;
    const visit = async (q) => {
      await send('Page.navigate', { url: host });
      await loaded(host);
      await send('Runtime.evaluate', {
        expression: `localStorage.setItem('roadmap-isd:prefs', JSON.stringify({ mePrompted: true, me: 5, view: 'synthesis', homeView: 'synthesis' }))`,
      });
      await send('Page.navigate', { url: `${host}${q}` });
      await loaded(`${host}${q}`);
    };
    await visit('?donnees=synthetiques');
    await until(`D.querySelector('#view-panel[data-view="gantt"]')`);
    assert.equal(await w(`return D.getElementById('tab-gantt').getAttribute('aria-selected');`), 'true');
    assert.equal(await w(`return D.getElementById('tab-synthesis').getAttribute('aria-selected');`), 'false');
    await visit('?donnees=synthetiques&vue=table');
    await until(`D.querySelector('#view-panel[data-view="table"]')`);
    assert.equal(await w(`return D.getElementById('tab-table').getAttribute('aria-selected');`), 'true');
  },
);

// ---------- Statut depuis la carte et la ligne (P-UX-6) ----------
const EDIT = '?edition=1&doc=doc-dev-local&ecritures=memoire';

/** Ouvre une vue avec « Je suis… » posé (Mes tâches), toujours sur le jeu synthétique. */
async function openView(query, view, me = 5) {
  const host = `${BASE}/dev/host.html`;
  const q = `${query}&donnees=synthetiques&vue=${view}`;
  await send('Page.navigate', { url: host });
  await loaded(host);
  await send('Runtime.evaluate', {
    expression: `localStorage.setItem('roadmap-isd:prefs', JSON.stringify({ mePrompted: true, me: ${me} }))`,
  });
  await send('Page.navigate', { url: `${host}${q}` });
  await loaded(`${host}${q}`);
  await until(`D.querySelector('#view-panel[data-view="${view}"] .view [data-task]')`);
}

/** Choisit dans le menu ouvert le premier statut différent de l'actuel (ou `value`) ; renvoie la valeur choisie. */
const pickStatus = (value) =>
  w(`const items = [...D.querySelectorAll('#qs-menu [data-qs-value]')];
    const b = ${value ? `items.find((x) => x.dataset.qsValue === ${JSON.stringify(value)})` : `items.find((x) => x.getAttribute('aria-checked') !== 'true')`};
    b.focus(); b.click(); return b.dataset.qsValue;`);
const key = (k, extra = {}) =>
  w(
    `D.activeElement.dispatchEvent(new W.KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(extra)} })); return true;`,
  );

test(
  'statut depuis la carte (P-UX-6) : « s » ouvre le menu, les flèches n’écrivent rien, la carte change de colonne et garde le focus',
  { skip: SKIP },
  async () => {
    await open(EDIT);
    const id = await w(
      `const c = D.querySelector('.kcol[data-col="status:todo"] .kcard[data-qs-focus]'); c.focus(); return Number(c.dataset.task);`,
    );
    // Bouton ⋯ hors du focus itinérant : un seul arrêt de tabulation par colonne
    assert.equal(await w(`return D.querySelector('[data-qs-open="${id}"]').tabIndex;`), -1);
    assert.match(await w(`return D.getElementById('kanban-help').textContent;`), /Maj\+F10/);
    await key('s');
    await until(`D.getElementById('qs-menu') && D.activeElement.closest('#qs-menu')`);
    assert.equal(await w(`return D.activeElement.getAttribute('aria-checked');`), 'true');
    for (let i = 0; i < 3; i++) await key('ArrowDown');
    await key('Escape');
    await until(`!D.getElementById('qs-menu') && D.activeElement.id === 'kc-${id}'`);
    assert.equal(await w(`return W.__writes.length;`), 0);
    // Maj+F10 rouvre le même menu ; choix « En revue »
    await key('F10', { shiftKey: true });
    await until(`D.getElementById('qs-menu')`);
    assert.equal(await pickStatus('review'), 'review');
    await until(`W.__writes.length === 1 && D.querySelector('.kcol[data-col="status:review"] #kc-${id}')`);
    assert.deepEqual((await writes())[0], [['UpdateRecord', 'Tasks', id, { statut: 'review' }]]);
    await until(`D.activeElement?.id === 'kc-${id}'`);
    // La carte déplacée est l'arrêt de tabulation de sa nouvelle colonne
    assert.equal(await w(`return D.getElementById('kc-${id}').tabIndex;`), 0);
    assert.match(await w(`return D.querySelector('.toast__text').textContent;`), /En revue/);
    assert.equal(await w(`return Boolean(D.querySelector('.toast [data-toast-action]'));`), true);
    // « Annuler » : la carte revient, le focus la suit
    await w(`D.querySelector('.toast [data-toast-action]').click(); return true;`);
    await until(`D.querySelector('.kcol[data-col="status:todo"] #kc-${id}') && D.activeElement?.id === 'kc-${id}'`);
    assert.deepEqual((await writes())[1], [['UpdateRecord', 'Tasks', id, { statut: 'todo' }]]);
  },
);

test(
  'statut depuis la carte (P-UX-6) : la souris passe par le bouton ⋯, « Terminé » remplit la clôture',
  { skip: SKIP },
  async () => {
    await open(EDIT);
    const id = await w(
      `return Number(D.querySelector('.kcol[data-col="status:inprogress"] .kcard[data-qs-focus]').dataset.task);`,
    );
    const y = await w(`W.scrollTo(0, 200); return W.scrollY;`);
    await w(`D.querySelector('[data-qs-open="${id}"]').click(); return true;`);
    await until(`D.getElementById('qs-menu')`);
    assert.equal(await w(`return D.querySelector('[data-qs-open="${id}"]').getAttribute('aria-expanded');`), 'true');
    await pickStatus('done');
    await until(`W.__writes.length === 1 && D.activeElement?.id === 'kc-${id}'`);
    const cells = (await writes())[0][0][3];
    assert.equal(cells.statut, 'done');
    assert.equal(typeof cells.dateCloture, 'number');
    // La vue est redessinée sans perdre le défilement de la page
    assert.ok(Math.abs((await w(`return W.scrollY;`)) - y) < 400);
  },
);

test(
  'statut depuis la ligne du Tableau (P-UX-6) : la cellule devient un bouton-menu ; focus rendu au bouton',
  { skip: SKIP },
  async () => {
    await open(EDIT);
    await w(`D.getElementById('tab-table').click(); return true;`);
    await until(`D.querySelector('#view-panel[data-view="table"] .tbl-qs')`);
    const id = await w(`const b = D.querySelectorAll('.tbl-qs')[3]; b.focus(); return Number(b.dataset.qsOpen);`);
    await w(`D.activeElement.click(); return true;`);
    await until(`D.getElementById('qs-menu')`);
    for (let i = 0; i < 2; i++) await key('ArrowUp');
    assert.equal(await w(`return W.__writes.length;`), 0);
    const chosen = await pickStatus();
    await until(`W.__writes.length === 1`);
    assert.deepEqual((await writes())[0][0].slice(0, 3), ['UpdateRecord', 'Tasks', id]);
    assert.equal((await writes())[0][0][3].statut, chosen);
    await until(`D.activeElement?.dataset.qsFocus === '${id}'`);
    // Aucune fiche ouverte : le clic sur la cellule n'ouvre que le menu
    assert.notEqual(await w(`return D.getElementById('app-detail').dataset.open;`), 'true');
  },
);

test(
  'statut depuis Mes tâches (P-UX-6) : « Terminé » retire la ligne, le focus passe à la voisine',
  { skip: SKIP },
  async () => {
    await openView(EDIT, 'mytasks');
    const [id, next] = await w(
      `const b = [...D.querySelectorAll('.mt__qs')]; return [Number(b[0].dataset.qsOpen), b[1].dataset.qsOpen];`,
    );
    await w(`D.querySelector('[data-qs-open="${id}"]').click(); return true;`);
    await until(`D.getElementById('qs-menu')`);
    await pickStatus('done');
    await until(`W.__writes.length === 1 && !D.querySelector('[data-qs-open="${id}"]')`);
    assert.equal((await writes())[0][0][3].statut, 'done');
    await until(`D.activeElement?.dataset.qsFocus === '${next}'`);
  },
);

test(
  'statut depuis la carte en mode essai (P-UX-6) : la carte change de colonne, rien n’est envoyé',
  { skip: SKIP },
  async () => {
    await open('?edition=essai');
    const id = await w(
      `const c = D.querySelector('.kcol[data-col="status:todo"] .kcard[data-qs-focus]'); c.focus(); return Number(c.dataset.task);`,
    );
    await key('s');
    await until(`D.getElementById('qs-menu')`);
    await pickStatus('inprogress');
    await until(
      `D.querySelector('.kcol[data-col="status:inprogress"] #kc-${id}') && D.activeElement?.id === 'kc-${id}'`,
    );
    assert.match(await w(`return D.querySelector('.toast__text').textContent;`), /Mode essai/);
    assert.equal(await w(`return W.__writes.length;`), 0);
  },
);

for (const query of [
  '?x=1',
  '?edition=1&doc=autre-document&ecritures=memoire',
  '?edition=1&doc=doc-dev-local&ecritures=lecteur',
]) {
  test(
    `statut depuis la carte et la ligne (P-UX-6), lecture seule (${query}) : aucun contrôle`,
    { skip: SKIP },
    async () => {
      for (const view of ['kanban', 'table', 'mytasks']) {
        await openView(query, view);
        await sleep(200);
        assert.equal(await w(`return D.querySelectorAll('[data-qs-open], [data-qs-focus]').length;`), 0, view);
      }
      // « s » et le clic droit sur une carte n'ouvrent rien ; le menu du navigateur reste intact
      await openView(query, 'kanban');
      await w(`D.querySelector('.kcard').focus(); return true;`);
      await key('s');
      const prevented =
        await w(`const e = new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
        D.querySelector('.kcard').dispatchEvent(e); return e.defaultPrevented;`);
      assert.equal(prevented, false);
      await sleep(200);
      assert.equal(await w(`return Boolean(D.getElementById('qs-menu'));`), false);
      assert.doesNotMatch(await w(`return D.getElementById('kanban-help').textContent;`), /Maj\+F10/);
      assert.equal(await w(`return W.__writes.length;`), 0);
    },
  );
}

/** Vraie frappe clavier (CDP) dans l'élément focalisé : active les boutons comme un utilisateur ; repeat = touche maintenue. */
async function press(k, { repeat = false } = {}) {
  const codes = { Enter: 13, ' ': 32, ArrowDown: 40 };
  const text = k === 'Enter' ? '\r' : k === ' ' ? ' ' : undefined;
  const base = { key: k, code: k === ' ' ? 'Space' : k, windowsVirtualKeyCode: codes[k] ?? 0, autoRepeat: repeat };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text });
  if (!repeat) await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(50);
}

async function openTableMenu(query, index = 2) {
  await open(query);
  await w(`D.getElementById('tab-table').click(); return true;`);
  await until(`D.querySelector('#view-panel[data-view="table"] .tbl-qs')`);
  const id = await w(`const b = D.querySelectorAll('.tbl-qs')[${index}]; b.focus(); return Number(b.dataset.qsOpen);`);
  await press('Enter');
  await until(`D.getElementById('qs-menu') && D.activeElement.closest('#qs-menu')`);
  return id;
}

test(
  'menu de statut (P-UX-6) : choisir le statut actuel n’écrit rien ; Entrée maintenue n’écrit rien',
  { skip: SKIP },
  async () => {
    const id = await openTableMenu(EDIT);
    // Ouvert par Entrée : la répétition de la touche arrive dans le menu, sur le statut actuel, sans rien choisir
    assert.equal(await w(`return D.activeElement.getAttribute('aria-checked');`), 'true');
    await press('Enter', { repeat: true });
    await press('Enter', { repeat: true });
    assert.equal(await w(`return Boolean(D.getElementById('qs-menu'));`), true);
    await press('ArrowDown');
    await press('Enter', { repeat: true });
    assert.equal(await w(`return Boolean(D.getElementById('qs-menu'));`), true);
    assert.equal(await w(`return W.__writes.length;`), 0);
    // Statut actuel choisi franchement : menu fermé, rien n'est écrit, focus rendu au bouton
    await w(`D.querySelector('#qs-menu [aria-checked="true"]').focus(); return true;`);
    await press('Enter');
    await until(`!D.getElementById('qs-menu') && D.activeElement?.dataset.qsOpen === '${id}'`);
    await sleep(300);
    assert.equal(await w(`return W.__writes.length;`), 0);
    // aria-controls retiré avec le menu
    assert.equal(await w(`return D.activeElement.hasAttribute('aria-controls');`), false);
    assert.equal(await w(`return D.activeElement.getAttribute('aria-expanded');`), 'false');
  },
);

/** Lectures complètes faites par le widget (la table Projects n'est lue que par fetchAll, jamais par fetchRow). */
const fullReads = () => w(`return W.__reads.filter((t) => t === 'Projects').length;`);

/**
 * Attend la fin de tout ce qu'une écriture déclenche, sur l'état et non sur une durée : l'écriture n° n est notée,
 * les deux relectures qui la suivent ont eu lieu (après l'écriture, puis onRecords du faux Grist, à 500 ms) et
 * aucune n'est en cours. Une relecture tardive redessinerait la vue et fermerait un menu ouvert entre-temps.
 */
const writeSettled = (n, readsBefore) =>
  until(
    `W.__writes.length === ${n} && W.__reads.filter((t) => t === 'Projects').length >= ${readsBefore + 2} && !D.getElementById('btn-refresh')?.disabled`,
  );

/** Focalise la première entrée du menu ouvert qui n'est pas le statut actuel ; attend que le focus y soit. */
async function focusOtherStatus() {
  await until(`D.getElementById('qs-menu') && D.activeElement.closest('#qs-menu')`);
  const value = await w(
    `const b = [...D.querySelectorAll('#qs-menu [data-qs-value]')].find((x) => x.getAttribute('aria-checked') !== 'true'); b.focus(); return b.dataset.qsValue;`,
  );
  await until(`D.activeElement?.matches('#qs-menu [data-qs-value="${value}"]')`);
  return value;
}

test('menu de statut (P-UX-6) : Entrée et Espace sur une entrée écrivent ce statut', { skip: SKIP }, async () => {
  const id = await openTableMenu(EDIT);
  const first = await focusOtherStatus();
  let reads = await fullReads();
  await press('Enter');
  await writeSettled(1, reads);
  assert.equal((await writes())[0][0][3].statut, first);
  // Vue redessinée par les relectures : le focus est revenu au bouton de la ligne, qui rouvre le menu
  await until(`D.activeElement?.dataset.qsFocus === '${id}' && !D.getElementById('qs-menu')`);
  await press('Enter');
  const second = await focusOtherStatus();
  reads = await fullReads();
  await press(' ');
  await writeSettled(2, reads);
  assert.equal((await writes())[1][0][3].statut, second);
});

test(
  'menu de statut (P-UX-6) : tâche sans statut, focus neutre sur le menu, Entrée n’y choisit rien',
  { skip: SKIP },
  async () => {
    await open(`${EDIT},statut-vide`);
    await until(`D.querySelector('#kc-1[data-qs-focus]')`);
    await w(`D.getElementById('kc-1').focus(); return true;`);
    await key('s');
    await until(`D.getElementById('qs-menu')`);
    assert.equal(await w(`return D.activeElement.id;`), 'qs-menu');
    assert.equal(await w(`return D.querySelectorAll('#qs-menu [aria-checked="true"]').length;`), 0);
    await press('Enter');
    await press('Enter', { repeat: true });
    assert.equal(await w(`return Boolean(D.getElementById('qs-menu'));`), true);
    assert.equal(await w(`return W.__writes.length;`), 0);
    // Flèche : première entrée, choisie seulement par un appui franc
    await press('ArrowDown');
    assert.equal(await w(`return D.activeElement.dataset.qsValue;`), 'todo');
    await press('Enter', { repeat: true });
    assert.equal(await w(`return W.__writes.length;`), 0);
    await press('Enter');
    await until(`W.__writes.length === 1 && D.activeElement?.id === 'kc-1'`);
    assert.deepEqual((await writes())[0], [['UpdateRecord', 'Tasks', 1, { statut: 'todo' }]]);
  },
);

test(
  'statut depuis la carte (P-UX-6) : le clic droit ouvre le menu de statut ; choix pendant un envoi signalé',
  { skip: SKIP },
  async () => {
    await open(`${EDIT},lent`);
    const ctxMenu = (sel) =>
      w(`const e = new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
      D.querySelector(${JSON.stringify(sel)}).dispatchEvent(e); return e.defaultPrevented;`);
    const id = await w(`return Number(D.querySelector('.kcard[data-qs-focus]').dataset.task);`);
    // Clic droit sur la carte : menu de statut (pas celui du navigateur), ancré sur son ⋯
    assert.equal(await ctxMenu(`#kc-${id}`), true);
    await until(`D.getElementById('qs-menu') && D.activeElement.closest('#qs-menu')`);
    assert.equal(await w(`return D.querySelector('[data-qs-open="${id}"]').getAttribute('aria-expanded');`), 'true');
    // Deuxième « contextmenu » (Maj+F10 relâché sous Windows) : le menu reste ouvert ; dans le menu : bloqué
    assert.equal(await ctxMenu(`#kc-${id}`), true);
    assert.equal(await w(`return Boolean(D.getElementById('qs-menu'));`), true);
    assert.equal(await ctxMenu('#qs-menu'), true);
    await key('Escape');
    await until(`!D.getElementById('qs-menu') && D.activeElement?.id === 'kc-${id}'`);
    // Clic droit sur le ⋯ : même menu
    assert.equal(await ctxMenu(`[data-qs-open="${id}"]`), true);
    await until(`D.getElementById('qs-menu')`);
    await key('Escape');
    await until(`!D.getElementById('qs-menu')`);
    assert.equal(await w(`return W.__writes.length;`), 0);
    const [a, b] = await w(
      `const c = [...D.querySelectorAll('.kcol[data-col="status:todo"] .kcard[data-qs-focus]')]; return [Number(c[0].dataset.task), Number(c[1].dataset.task)];`,
    );
    await w(`D.querySelector('[data-qs-open="${a}"]').click(); return true;`);
    await until(`D.getElementById('qs-menu')`);
    await pickStatus('review');
    await until(`W.__writes.length === 1`);
    // Premier envoi encore en cours (1,5 s) : le second choix est refusé avec un message, rien n'est envoyé
    await w(`D.querySelector('[data-qs-open="${b}"]').click(); return true;`);
    await until(`D.getElementById('qs-menu')`);
    await pickStatus('review');
    await until(`/en cours d’envoi/.test(D.querySelector('.toast__text')?.textContent ?? '')`);
    await sleep(2000);
    assert.equal(await w(`return W.__writes.length;`), 1);
  },
);

test(
  '« Annuler » au clavier (P-UX-6) : la carte revient dans sa colonne et reprend le focus',
  { skip: SKIP },
  async () => {
    await open(EDIT);
    const id = await w(
      `const c = D.querySelector('.kcol[data-col="status:todo"] .kcard[data-qs-focus]'); c.focus(); return Number(c.dataset.task);`,
    );
    await key('s');
    await until(`D.getElementById('qs-menu')`);
    await pickStatus('review');
    await until(`W.__writes.length === 1 && D.querySelector('.kcol[data-col="status:review"] #kc-${id}')`);
    // Le message « Annuler » reçoit le focus (comme par Tab), puis Entrée ; le message disparaît avec son bouton
    await until(`D.querySelector('.toast [data-toast-action]')`);
    await w(`D.querySelector('.toast [data-toast-action]').focus(); return true;`);
    assert.equal(await w(`return D.activeElement.dataset.toastAction !== undefined;`), true);
    await press('Enter');
    await until(`W.__writes.length === 2 && D.querySelector('.kcol[data-col="status:todo"] #kc-${id}')`);
    assert.deepEqual((await writes())[1], [['UpdateRecord', 'Tasks', id, { statut: 'todo' }]]);
    await until(`D.activeElement?.id === 'kc-${id}'`);
    // Toujours là après la relecture qui suit l'annulation
    await sleep(500);
    assert.equal(await w(`return D.activeElement?.id;`), `kc-${id}`);
  },
);

test(
  'tags (2e) : relecture impossible, « Enregistrer sans vérifier » n’envoie jamais les tags et le dit',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    const id = await openForm();
    await w(`D.getElementById('tf-tags').focus(); return true;`);
    await typeIn('#tf-tags', 'sans relecture');
    await until(`D.querySelector('.tf-tagopt--create')`);
    await tagKey('Enter');
    await until(`D.querySelectorAll('[data-field="tags"] .tf-tagchip').length === 1`);
    // Tags seuls : pas de bouton « sans vérifier », message clair
    await w(`W.__lectureEchoue = true; return true;`);
    await clickOn('#btn-form-save');
    await until(`D.getElementById('tf-nocheck-tags')`);
    assert.match(await w(`return D.getElementById('tf-nocheck-tags').textContent;`), /jamais sans vérification/);
    assert.equal(await w(`return Boolean(D.querySelector('[data-form="save-nocheck"]'));`), false);
    // Avec un autre champ : le bouton n'enregistre que ce champ
    await clickOn('[data-form="nocheck-cancel"]');
    await typeIn('#tf-titre', 'Titre sans relecture');
    await clickOn('#btn-form-save');
    await until(`D.querySelector('[data-form="save-nocheck"]')`);
    assert.match(await w(`return D.querySelector('[data-form="save-nocheck"]').textContent;`), /sans les tags/);
    assert.match(await w(`return D.getElementById('tf-nocheck-tags').textContent;`), /ne seront pas enregistrés/);
    await clickOn('[data-form="save-nocheck"]');
    await until(`W.__writes.length === 1`);
    assert.deepEqual((await writes())[0], [['UpdateRecord', 'Tasks', id, { titre: 'Titre sans relecture' }]]);
  },
);

// ---------- APH (Team.aph) et personne estimation ----------

test(
  'APH : colonne formule vide de la Feuille, en lecture dans la fiche (raison affichée), absente de la création',
  { skip: SKIP },
  async () => {
    await openTeam('?edition=1&doc=doc-dev-local&ecritures=memoire');
    assert.equal(await w(`return D.querySelectorAll('.tperson__aph').length;`), 0);
    await clickOn('#btn-person-add');
    await until(`D.querySelector('dialog.cdlg[open] #pf-nom')`);
    assert.equal(await w(`return Boolean(D.getElementById('pf-aph'));`), false);
    await clickOn('#pf-cancel');
    await until(`!D.querySelector('dialog.cdlg')`);
    await clickOn('[data-person="1"]');
    await until(`D.getElementById('btn-edit-open')`);
    await clickOn('#btn-edit-open');
    await until(`D.getElementById('person-form')`);
    assert.equal(await w(`return D.getElementById('tf-aph').disabled;`), true);
    assert.match(await w(`return D.getElementById('tf-aph-msgs').textContent;`), /Colonne vide/);
    // Le reste de la fiche reste modifiable et s'enregistre sans toucher à l'APH
    await typeIn('#tf-nom', 'Zoé DE modifiée');
    await clickOn('#btn-form-save');
    await until(`!D.getElementById('person-form') && W.__writes.length === 1`);
    assert.deepEqual(await writes(), [[['UpdateRecord', 'Team', 1, { nom: 'Zoé DE modifiée' }]]]);
  },
);

test(
  'APH : colonne de données, affiché dans la liste et la fiche, modifiable avec contrôle (chiffres seulement)',
  { skip: SKIP },
  async () => {
    await openTeam('?edition=1&doc=doc-dev-local&ecritures=memoire,aph-donnee');
    assert.equal(await w(`return D.querySelector('[data-aph="1"]').textContent.trim();`), 'APH 1000001');
    // Personne estimation : badge « Estimation » ; aucune autre personne ne le porte
    assert.match(await w(`return D.querySelector('[data-aph="19"]').textContent;`), /APH 9999999\s*Estimation/);
    // Plusieurs personnes estimation : toutes ont le badge (Estimation DE, Estimation DS)
    assert.match(await w(`return D.querySelector('[data-aph="20"]').textContent;`), /APH 9999999\s*Estimation/);
    assert.equal(await w(`return D.querySelectorAll('.tperson .est-badge').length;`), 2);
    await clickOn('[data-person="1"]');
    await until(`D.getElementById('btn-edit-open')`);
    assert.match(await w(`return D.getElementById('app-detail').textContent;`), /APH\s*1000001/);
    await clickOn('#btn-edit-open');
    await until(`D.getElementById('person-form')`);
    assert.equal(await w(`return D.getElementById('tf-aph').disabled;`), false);
    await typeIn('#tf-aph', '12a4567');
    assert.match(await w(`return D.getElementById('tf-aph-msgs').textContent;`), /APH invalide/);
    assert.equal(await w(`return D.getElementById('btn-form-save').disabled;`), true);
    await typeIn('#tf-aph', ' 1234568 ');
    assert.equal(await w(`return D.getElementById('btn-form-save').disabled;`), false);
    await clickOn('#btn-form-save');
    await until(`!D.getElementById('person-form') && W.__writes.length === 1`);
    assert.deepEqual(await writes(), [[['UpdateRecord', 'Team', 1, { aph: '1234568' }]]]);
    await until(`/APH\\s*1234568/.test(D.getElementById('app-detail').textContent)`);
    // Création : l'APH est proposé et envoyé nettoyé
    await w(`D.getElementById('btn-detail-close').click(); return true;`);
    await until(`D.getElementById('app-detail').dataset.open === 'false'`);
    await clickOn('#btn-person-add');
    await until(`D.querySelector('dialog.cdlg[open] #pf-aph')`);
    await typeIn('#pf-nom', 'Personne Aph');
    await change('#pf-role', 'DA');
    await typeIn('#pf-aph', ' 7000001 ');
    await clickOn('#pf-submit');
    await until(`!D.querySelector('dialog.cdlg') && W.__writes.length === 2`);
    const [, [add]] = await writes();
    assert.equal(add[0], 'AddRecord');
    assert.equal(add[3].aph, '7000001');
  },
);

for (const [variant, opt] of [
  ['Text', 'aph-donnee'],
  ['Int', 'aph-entier'],
])
  test(
    `estimation (colonne ${variant}) : 3 ETP acceptés pour la personne estimation (badge), refusés pour une autre personne`,
    { skip: SKIP },
    async () => {
      await open(`?edition=1&doc=doc-dev-local&ecritures=memoire,${opt}`);
      await w(`localStorage.removeItem('roadmap-isd.chargesUnit'); return true;`);
      const id = await openForm();
      if (await w(`return D.getElementById('tf-type').checked;`))
        await w(`const c = D.getElementById('tf-type'); c.click(); return true;`);
      await until(`D.getElementById('tf-dateDebut')`);
      const setDate = (f, iso) =>
        w(
          `const t = D.getElementById('tf-${f}'); t.value = '${iso}'; t.dispatchEvent(new W.Event('change', { bubbles: true })); return true;`,
        );
      // Du 2 au 15 novembre : 1 ETP = 52 h, 3 ETP = 156 h
      await setDate('dateDebut', '2026-11-02');
      await setDate('dateEcheance', '2026-11-15');
      const pick = (who) =>
        w(`const s = D.getElementById('tf-assignees');
        const o = [...s.querySelectorAll('optgroup option')].find((x) => ${who}); s.value = o.value;
        s.dispatchEvent(new W.Event('change', { bubbles: true })); return Number(o.value);`);
      const est = await pick(`x.textContent.trim() === 'Estimation DE'`);
      await until(`D.getElementById('tf-ch-${est}')`);
      assert.ok(await w(`return Boolean(D.querySelector('[data-charge="${est}"] .est-badge'));`));
      await type(`tf-ch-${est}`, '3');
      assert.equal(await w(`return D.getElementById('tf-ch-${est}-msg').textContent.trim();`), '');
      assert.equal(await w(`return D.getElementById('tf-ch-${est}-eq').textContent.trim();`), '= 156 h');
      assert.equal(await w(`return D.getElementById('btn-form-save').disabled;`), false);
      // Au-delà de 50 ETP : refusé même pour elle
      await type(`tf-ch-${est}`, '51');
      assert.match(await w(`return D.getElementById('tf-ch-${est}-msg').textContent;`), /50 ETP maximum/);
      await type(`tf-ch-${est}`, '3');
      // Deuxième personne estimation (Estimation DS) : exemptée elle aussi
      const est2 = await pick(`x.textContent.trim() === 'Estimation DS'`);
      await until(`D.getElementById('tf-ch-${est2}')`);
      assert.ok(await w(`return Boolean(D.querySelector('[data-charge="${est2}"] .est-badge'));`));
      await type(`tf-ch-${est2}`, '3');
      assert.equal(await w(`return D.getElementById('tf-ch-${est2}-msg').textContent.trim();`), '');
      // Une autre personne : 1 ETP au plus, sans badge
      const other = await pick(`!x.textContent.trim().startsWith('Estimation')`);
      await until(`D.getElementById('tf-ch-${other}')`);
      assert.equal(await w(`return Boolean(D.querySelector('[data-charge="${other}"] .est-badge'));`), false);
      await type(`tf-ch-${other}`, '3');
      assert.match(
        await w(`return D.getElementById('tf-ch-${other}-msg').textContent;`),
        /1 ETP maximum par personne \(soit 52 h sur la période\)/,
      );
      assert.equal(await w(`return D.getElementById('btn-form-save').disabled;`), true);
      await type(`tf-ch-${other}`, '1');
      assert.equal(await w(`return D.getElementById('btn-form-save').disabled;`), false);
      await w(`D.getElementById('btn-form-save').click(); return true;`);
      await until(`W.__writes.length === 1`);
      const [[[name, table, rowId, cells]]] = await writes();
      assert.deepEqual([name, table, rowId], ['UpdateRecord', 'Tasks', id]);
      assert.deepEqual(JSON.parse(cells.charges), [
        { teamId: est, heures: 156 },
        { teamId: est2, heures: 156 },
        { teamId: other, heures: 52 },
      ]);
    },
  );

test(
  'estimation : l’APH d’estimation ne se pose ni ne se retire depuis le widget (fiche en lecture, saisie refusée)',
  { skip: SKIP },
  async () => {
    await openTeam('?edition=1&doc=doc-dev-local&ecritures=memoire,aph-donnee');
    await clickOn('[data-person="19"]');
    await until(`D.getElementById('btn-edit-open')`);
    await clickOn('#btn-edit-open');
    await until(`D.getElementById('person-form')`);
    assert.equal(await w(`return D.getElementById('tf-aph').readOnly;`), true);
    assert.match(
      await w(`return D.getElementById('tf-aph-help').textContent;`),
      /La personne d’estimation se désigne directement dans la Feuille/,
    );
    await clickOn('#btn-form-cancel');
    await until(`D.getElementById('btn-person-active')`);
    await w(`D.getElementById('btn-detail-close').click(); return true;`);
    await until(`D.getElementById('app-detail').dataset.open === 'false'`);
    await clickOn('[data-person="1"]');
    await until(`D.getElementById('btn-edit-open')`);
    await clickOn('#btn-edit-open');
    await until(`D.getElementById('person-form')`);
    await typeIn('#tf-aph', '9999999');
    assert.match(
      await w(`return D.getElementById('tf-aph-msgs').textContent;`),
      /La personne d’estimation se désigne directement dans la Feuille/,
    );
    assert.equal(await w(`return D.getElementById('btn-form-save').disabled;`), true);
    assert.equal(await w(`return W.__writes.length;`), 0);
  },
);

test(
  'APH : colonne Int (convertie par Grist), affichée en chiffres dans la liste et la fiche, écrite en nombre',
  { skip: SKIP },
  async () => {
    await openTeam('?edition=1&doc=doc-dev-local&ecritures=memoire,aph-entier');
    assert.equal(await w(`return D.querySelector('[data-aph="1"]').textContent.trim();`), 'APH 1000001');
    // 0 dans une colonne Int : vide, rien d'affiché
    assert.equal(await w(`return Boolean(D.querySelector('[data-aph="2"]'));`), false);
    // Personne estimation (nombre 9999999) : badge dans la liste et dans sa fiche
    assert.match(await w(`return D.querySelector('[data-aph="19"]').textContent;`), /APH 9999999\s*Estimation/);
    // Plusieurs personnes estimation : toutes ont le badge (Estimation DE, Estimation DS)
    assert.match(await w(`return D.querySelector('[data-aph="20"]').textContent;`), /APH 9999999\s*Estimation/);
    assert.equal(await w(`return D.querySelectorAll('.tperson .est-badge').length;`), 2);
    await clickOn('[data-person="19"]');
    await until(`D.getElementById('btn-edit-open')`);
    assert.match(await w(`return D.getElementById('app-detail').textContent;`), /APH\s*9999999\s*Estimation/);
    assert.ok(await w(`return Boolean(D.querySelector('#app-detail .dt-aph + .est-badge'));`));
    await w(`D.getElementById('btn-detail-close').click(); return true;`);
    await until(`D.getElementById('app-detail').dataset.open === 'false'`);
    // Fiche d'une autre personne : APH affiché, modifiable, envoyé en nombre
    await clickOn('[data-person="1"]');
    await until(`D.getElementById('btn-edit-open')`);
    assert.match(await w(`return D.getElementById('app-detail').textContent;`), /APH\s*1000001/);
    assert.equal(await w(`return Boolean(D.querySelector('#app-detail .est-badge'));`), false);
    await clickOn('#btn-edit-open');
    await until(`D.getElementById('person-form')`);
    assert.equal(await w(`return D.getElementById('tf-aph').disabled;`), false);
    assert.equal(await w(`return D.getElementById('tf-aph').value;`), '1000001');
    // Zéro de tête : la colonne numérique le perdrait, refusé
    await typeIn('#tf-aph', '0123456');
    assert.match(await w(`return D.getElementById('tf-aph-msgs').textContent;`), /ne peut pas commencer par 0/);
    assert.equal(await w(`return D.getElementById('btn-form-save').disabled;`), true);
    // 9999999 : refusé, comme pour une colonne Text
    await typeIn('#tf-aph', '9999999');
    assert.match(
      await w(`return D.getElementById('tf-aph-msgs').textContent;`),
      /La personne d’estimation se désigne directement dans la Feuille/,
    );
    assert.equal(await w(`return D.getElementById('btn-form-save').disabled;`), true);
    assert.equal(await w(`return W.__writes.length;`), 0);
    await typeIn('#tf-aph', ' 1234568 ');
    assert.equal(await w(`return D.getElementById('btn-form-save').disabled;`), false);
    await clickOn('#btn-form-save');
    await until(`!D.getElementById('person-form') && W.__writes.length === 1`);
    assert.deepEqual(await writes(), [[['UpdateRecord', 'Team', 1, { aph: 1234568 }]]]);
    await until(`/APH\\s*1234568/.test(D.getElementById('app-detail').textContent)`);
    assert.equal(await w(`return D.querySelector('[data-aph="1"]').textContent.trim();`), 'APH 1234568');
  },
);

test(
  'APH : colonne Int, la fiche de la personne estimation garde l’APH en lecture ; création envoyée en nombre',
  { skip: SKIP },
  async () => {
    await openTeam('?edition=1&doc=doc-dev-local&ecritures=memoire,aph-entier');
    await clickOn('[data-person="19"]');
    await until(`D.getElementById('btn-edit-open')`);
    await clickOn('#btn-edit-open');
    await until(`D.getElementById('person-form')`);
    assert.equal(await w(`return D.getElementById('tf-aph').readOnly;`), true);
    assert.equal(await w(`return D.getElementById('tf-aph').value;`), '9999999');
    assert.match(
      await w(`return D.getElementById('tf-aph-help').textContent;`),
      /La personne d’estimation se désigne directement dans la Feuille/,
    );
    await clickOn('#btn-form-cancel');
    await until(`D.getElementById('btn-person-active')`);
    await w(`D.getElementById('btn-detail-close').click(); return true;`);
    await until(`D.getElementById('app-detail').dataset.open === 'false'`);
    await clickOn('#btn-person-add');
    await until(`D.querySelector('dialog.cdlg[open] #pf-aph')`);
    await typeIn('#pf-nom', 'Personne Aph Entier');
    await change('#pf-role', 'DA');
    await typeIn('#pf-aph', '9999999');
    assert.match(await w(`return D.getElementById('pf-aph-msgs').textContent;`), /se désigne directement/);
    await typeIn('#pf-aph', ' 7000001 ');
    await clickOn('#pf-submit');
    await until(`!D.querySelector('dialog.cdlg') && W.__writes.length === 1`);
    const [[add]] = await writes();
    assert.equal(add[0], 'AddRecord');
    assert.equal(add[3].aph, 7000001);
  },
);

// ---------- Périmètre ISD : Management et éléments sans tâche ----------
test(
  'périmètre : projet du seul Management ISD et chantier sans tâche visibles dans le Gantt, absents du Kanban',
  { skip: SKIP },
  async () => {
    const host = `${BASE}/dev/host.html`;
    const q = `?donnees=synthetiques`;
    await send('Page.navigate', { url: host });
    await loaded(host);
    // Fanny Manager (12, Management ISD), périmètre « Tout »
    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('roadmap-isd:prefs', JSON.stringify({ mePrompted: true, view: 'gantt', me: 12 }))`,
    });
    await send('Page.navigate', { url: `${host}${q}` });
    await loaded(`${host}${q}`);
    const row = `[...D.querySelectorAll('#view-panel[data-view="gantt"] .grow--chantier')].find((r) => r.textContent.includes('Chantier sans tâche du pilotage'))`;
    // Dans le périmètre ISD (responsable Management ISD, sponsor hors ISD) ; niveau Chantiers ouvert par défaut
    await until(row);
    assert.equal(await w(`return ${row}.querySelector('.grow__empty')?.textContent;`), 'Aucune tâche');
    assert.match(await w(`return ${row}.getAttribute('aria-label');`), /Aucune tâche/);
    // Kanban : centré sur les tâches, aucune carte de ce projet
    await w(`D.getElementById('tab-kanban').click(); return true;`);
    await until(`D.querySelector('#view-panel[data-view="kanban"] .kcard')`);
    assert.equal(await w(`return D.getElementById('view-panel').textContent.includes('Pilotage Management');`), false);
    // « Mes chantiers » : le chantier vide dont elle est contributrice reste visible dans le Gantt
    await w(`D.getElementById('tab-gantt').click(); return true;`);
    await until(row);
    await w(`D.getElementById('f-perimetre-chantiers').click(); return true;`);
    await until(`D.getElementById('f-perimetre-chantiers').checked && ${row}`);
    assert.equal(await w(`return W.__writes?.length ?? 0;`), 0);
  },
);

test(
  '« ISD seulement » : une carte sans personne ISD disparaît du Kanban, le compteur baisse, la pastille apparaît',
  { skip: SKIP },
  async () => {
    await open('');
    // Recherche sur la tâche inventée sans personne ISD (colonnes paginées : elle ne serait pas toujours visible)
    await w(
      `const s = D.getElementById('f-search'); s.value = 'externe sans ISD'; s.dispatchEvent(new W.Event('input', { bubbles: true })); return true;`,
    );
    const cards = `D.querySelectorAll('#view-panel[data-view="kanban"] .kcard').length`;
    const count = `D.querySelector('.task-count').textContent.trim()`;
    await until(`${cards} === 1`);
    assert.equal(await w(`return ${count};`), '1 tâche');
    assert.equal(await w(`return D.getElementById('chip-isdOnly') === null;`), true);
    // Aide en pastille « i » : infobulle liée au bouton, visible au focus et dans la fenêtre
    await w(`D.querySelector('#f-isd-only ~ .info-tip .info-tip__btn').focus(); return true;`);
    await until(`getComputedStyle(D.getElementById('tip-isd-only')).opacity === '1'`);
    assert.equal(
      await w(`return D.querySelector('[aria-describedby="tip-isd-only"]').getAttribute('aria-label');`),
      'À propos de « ISD seulement »',
    );
    assert.equal(
      await w(
        `const r = D.getElementById('tip-isd-only').getBoundingClientRect(); return r.left >= 0 && r.right <= D.documentElement.clientWidth;`,
      ),
      true,
    );
    await w(`D.getElementById('f-isd-only').click(); return true;`);
    await until(`D.getElementById('chip-isdOnly') && ${cards} === 0`);
    assert.match(await w(`return D.getElementById('chip-isdOnly').textContent;`), /ISD seulement/);
    assert.equal(await w(`return ${count};`), 'Aucune tâche');
    // Décochée : la carte revient
    await w(`D.getElementById('f-isd-only').click(); return true;`);
    await until(`!D.getElementById('chip-isdOnly') && ${cards} === 1`);
    assert.equal(await w(`return ${count};`), '1 tâche');
    // Retrait de la seule pastille : la case se décoche et la carte revient
    await w(`D.getElementById('f-isd-only').click(); return true;`);
    await until(`D.querySelector('[data-remove="isdOnly"]') && ${cards} === 0`);
    await w(`D.querySelector('[data-remove="isdOnly"]').click(); return true;`);
    await until(`!D.getElementById('chip-isdOnly') && ${cards} === 1`);
    assert.equal(await w(`return D.getElementById('f-isd-only').checked;`), false);
    // « Tout effacer » remet la case à faux
    await w(`D.getElementById('f-isd-only').click(); return true;`);
    await until(`D.getElementById('btn-clear') && ${cards} === 0`);
    await w(`D.getElementById('btn-clear').click(); return true;`);
    await until(`!D.getElementById('chip-isdOnly') && D.getElementById('f-isd-only').checked === false`);
    assert.equal(await w(`return W.__writes?.length ?? 0;`), 0);
  },
);

test('profil « Mgmt » : filtre, étiquette et charge par profil du Portfolio', { skip: SKIP }, async () => {
  await open('');
  await w(
    `const s = D.getElementById('f-profile'); s.value = 'Mgmt'; s.dispatchEvent(new W.Event('change', { bubbles: true })); return true;`,
  );
  await until(`D.getElementById('chip-profile')`);
  assert.match(await w(`return D.getElementById('chip-profile').textContent;`), /Profil : Management/);
  assert.equal(await w(`return D.querySelector('#f-profile option[value="Mgmt"]').textContent.trim();`), 'Mgmt');
  await until(`D.querySelector('#view-panel[data-view="kanban"] .kcard')`);
  // Portfolio, charge : une colonne et une synthèse « Mgmt » avec sa capacité
  await w(`D.getElementById('tab-portfolio').click(); return true;`);
  await until(`D.querySelector('#view-panel[data-view="portfolio"]')`);
  await until(`D.getElementById('pf-tab-load')`);
  await w(`D.getElementById('pf-tab-load').click(); return true;`);
  await until(`D.querySelector('.pf-load .pf-swatch--Mgmt') && D.querySelector('.pf-sum .pf-swatch--Mgmt')`);
  assert.equal(await w(`return W.__writes?.length ?? 0;`), 0);
});

// ---------- Bloc « Personnes » des fenêtres de création ----------

/** Choisit une valeur d'un bouton radio (unité de saisie) comme au clic. */
const pickRadio = (sel) =>
  w(
    `const t = D.querySelector(${JSON.stringify(sel)}); t.checked = true; t.dispatchEvent(new W.Event('change', { bubbles: true })); return true;`,
  );
/** Première personne proposée par « Ajouter une personne… » autre que `skip`. */
const otherPerson = (skip) =>
  w(
    `return Number([...D.querySelectorAll('#cf-assignees optgroup option')].map((o) => o.value).find((v) => v && Number(v) !== ${skip}));`,
  );
const cfDay = (y, m, d) => Date.UTC(y, m - 1, d) / 1000;

test(
  'nouvelle tâche : bloc « Personnes », deux personnes (0,5 ETP et des heures), UN AddRecord avec assignés et charges',
  { skip: SKIP },
  async () => {
    await openView(EDIT, 'kanban', 5);
    await w(`D.getElementById('btn-new-task').focus(); D.getElementById('btn-new-task').click(); return true;`);
    await until(`D.querySelector('dialog.cdlg[open] #cf-people')`);
    // Juste après les dates, visible (hors de « Plus d'options »), plus de champ « Assignés » simple
    assert.ok(
      await w(`const p = D.getElementById('cf-people'); const e = D.getElementById('cf-dateEcheance');
        return !p.closest('details') && Boolean(e.compareDocumentPosition(p) & W.Node.DOCUMENT_POSITION_FOLLOWING)
          && p.previousElementSibling.contains(e);`),
    );
    assert.equal(await w(`return D.querySelectorAll('[data-cf-add-assignee], #cf-assignees-label').length;`), 0);
    // « Je suis… » : une ligne, charge vide ; sans dates, saisie en ETP impossible (message), heures seulement
    assert.deepEqual(
      await w(`return [...D.querySelectorAll('#cf-people [data-charge]')].map((l) => Number(l.dataset.charge));`),
      [5],
    );
    assert.equal(await w(`return D.getElementById('cf-ch-5').value;`), '');
    assert.ok(
      await w(`return D.getElementById('cf-ch-5').disabled && Boolean(D.getElementById('cf-charges-nodates'));`),
    );
    // Sélecteurs : équipe ISD seulement, Management compris
    const groups = await w(`return [...D.querySelectorAll('#cf-assignees optgroup')].map((g) => g.label);`);
    assert.ok(groups.length && groups.every((g) => g.startsWith('ISD')), groups.join(', '));
    assert.ok(groups.includes('ISD — Management'), groups.join(', '));
    await typeIn('#cf-titre', 'Tâche avec personnes');
    await change('#cf-cible', await firstOption('#cf-cible'));
    // Du 2 au 15 novembre : 0,5 ETP = 26 h
    await change('#cf-dateDebut', '2026-11-02');
    await change('#cf-dateEcheance', '2026-11-15');
    await until(`!D.getElementById('cf-ch-5').disabled && !D.getElementById('cf-charges-nodates')`);
    await typeIn('#cf-ch-5', '0,5');
    assert.equal(await w(`return D.getElementById('cf-ch-5-eq').textContent;`), '= 26 h');
    // Deuxième personne, en heures
    const b = await otherPerson(5);
    await change('#cf-assignees', String(b));
    await until(`D.getElementById('cf-ch-${b}')`);
    assert.equal(await w(`return D.activeElement.id;`), `cf-ch-${b}`);
    await pickRadio('#cf-charges-unit-heures');
    await until(`D.getElementById('cf-ch-5').value === '26'`);
    await typeIn(`#cf-ch-${b}`, '12');
    assert.equal(await w(`return D.getElementById('cf-ch-${b}-eq').textContent;`), '= 0,23 ETP');
    assert.match(await w(`return D.getElementById('cf-charges-foot').textContent;`), /Total 38 h/);
    // Dates changées dans la fenêtre : l'ETP fait foi, les heures suivent (jusqu'au 8 : 0,5 ETP = 14,5 h ; 12 h → 6,5 h)
    assert.deepEqual(
      [
        etpHours(0.5, '2026-11-02', '2026-11-08'),
        etpHours(12 / fteOf('2026-11-02', '2026-11-15'), '2026-11-02', '2026-11-08'),
      ],
      [14.5, 6.5],
    );
    await change('#cf-dateEcheance', '2026-11-08');
    await until(`D.getElementById('cf-ch-5').value === '14,5' && D.getElementById('cf-ch-${b}').value === '6,5'`);
    assert.equal(await w(`return D.getElementById('cf-ch-5-eq').textContent;`), '= 0,5 ETP');
    // Retour à la période de saisie : heures saisies retrouvées
    await change('#cf-dateEcheance', '2026-11-15');
    await until(`D.getElementById('cf-ch-5').value === '26' && D.getElementById('cf-ch-${b}').value === '12'`);
    assert.equal(await w(`return W.__writes.length;`), 0);
    await clickOn('#cf-create');
    await until(`!D.querySelector('dialog.cdlg') && W.__writes.length === 1`);
    const batch = (await writes())[0];
    assert.equal(batch.length, 1);
    const [kind, table, id, cells] = batch[0];
    assert.deepEqual([kind, table, id], ['AddRecord', 'Tasks', null]);
    assert.equal(cells.titre, 'Tâche avec personnes');
    assert.equal(cells.dateDebut, cfDay(2026, 11, 2));
    assert.equal(cells.dateEcheance, cfDay(2026, 11, 15));
    assert.deepEqual(cells.assignees, ['L', 5, b]);
    assert.equal(
      cells.charges,
      JSON.stringify([
        { teamId: 5, heures: 26 },
        { teamId: b, heures: 12 },
      ]),
    );
  },
);

test('nouvelle tâche : ETP saisi puis dates changées, heures recalculées', { skip: SKIP }, async () => {
  await openView(EDIT, 'kanban', 5);
  await w(`try { localStorage.removeItem('roadmap-isd.chargesUnit'); } catch {} return true;`);
  await clickOn('#btn-new-task');
  await until(`D.querySelector('dialog.cdlg[open] #cf-people')`);
  await typeIn('#cf-titre', 'Tâche à ETP gardé');
  await change('#cf-cible', await firstOption('#cf-cible'));
  // 0,5 ETP du 2 au 15 novembre (26 h), puis jusqu'au 29 : 55 h
  assert.equal(etpHours(0.5, '2026-11-02', '2026-11-29'), 55);
  await change('#cf-dateDebut', '2026-11-02');
  await change('#cf-dateEcheance', '2026-11-15');
  await until(`!D.getElementById('cf-ch-5').disabled`);
  await typeIn('#cf-ch-5', '0,5');
  assert.equal(await w(`return D.getElementById('cf-ch-5-eq').textContent;`), '= 26 h');
  // Pastille « i » de la fenêtre de création : identifiant propre, reliée au bouton
  assert.equal(
    await w(`return D.querySelector('#cf-people .info-tip__btn').getAttribute('aria-describedby');`),
    'tip-fte-cf',
  );
  await change('#cf-dateEcheance', '2026-11-29');
  await until(`D.getElementById('cf-ch-5-eq').textContent === '= 55 h'`);
  assert.equal(await w(`return D.getElementById('cf-ch-5').value;`), '0,5');
  assert.match(await w(`return D.getElementById('cf-ch-5-msg').textContent;`), /26 h → 55 h \(ETP conservé\)/);
  await clickOn('#cf-create');
  await until(`!D.querySelector('dialog.cdlg') && W.__writes.length === 1`);
  const [kind, , , cells] = (await writes())[0][0];
  assert.equal(kind, 'AddRecord');
  assert.equal(cells.dateEcheance, cfDay(2026, 11, 29));
  assert.equal(cells.charges, JSON.stringify([{ teamId: 5, heures: 55 }]));
});

test(
  'nouvelle tâche : au-delà de 1 ETP refusé dans la fenêtre, rien n’est envoyé ; « Créer et ouvrir » ouvre la fiche',
  { skip: SKIP },
  async () => {
    await openView(EDIT, 'kanban', 5);
    await w(`try { localStorage.removeItem('roadmap-isd.chargesUnit'); } catch {} return true;`);
    await clickOn('#btn-new-task');
    await until(`D.querySelector('dialog.cdlg[open] #cf-people')`);
    await typeIn('#cf-titre', 'Tâche trop chargée');
    await change('#cf-cible', await firstOption('#cf-cible'));
    await change('#cf-dateDebut', '2026-11-02');
    await change('#cf-dateEcheance', '2026-11-15');
    await until(`!D.getElementById('cf-ch-5').disabled`);
    await w(
      `D.getElementById('cf-charges-unit-etp').checked || D.getElementById('cf-charges-unit-etp').click(); return true;`,
    );
    await typeIn('#cf-ch-5', '1,5');
    assert.match(await w(`return D.getElementById('cf-ch-5-msg').textContent;`), /1 ETP maximum/);
    assert.equal(await w(`return D.getElementById('cf-create').disabled;`), true);
    // Ctrl+Entrée ne passe pas non plus
    await w(
      `D.getElementById('cf-ch-5').dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); return true;`,
    );
    await sleep(300);
    assert.equal(await w(`return W.__writes.length;`), 0);
    // 1 ETP accepté, puis dates raccourcies : l'ETP fait foi (29 h jusqu'au 8), création possible
    await typeIn('#cf-ch-5', '1');
    await until(`!D.getElementById('cf-create').disabled`);
    await change('#cf-dateEcheance', '2026-11-08');
    await until(`D.getElementById('cf-ch-5-eq').textContent === '= 29 h'`);
    assert.equal(await w(`return D.getElementById('cf-create').disabled;`), false);
    // Heures saisies sans dates (aucun ETP de référence), puis dates : heures gardées, au-dessus de la borne, bloqué
    // (date vidée : la ligne revient aux heures de sa référence, 52 h ; 45 h saisies ensuite)
    await change('#cf-dateDebut', '');
    await change('#cf-dateEcheance', '');
    await pickRadio('#cf-charges-unit-heures');
    await until(`D.getElementById('cf-ch-5').value === '52' && !D.getElementById('cf-ch-5').disabled`);
    await typeIn('#cf-ch-5', '45');
    await change('#cf-dateDebut', '2026-11-02');
    await change('#cf-dateEcheance', '2026-11-08');
    await until(`D.getElementById('cf-create').disabled`);
    assert.equal(await w(`return D.getElementById('cf-ch-5').value;`), '45');
    assert.match(await w(`return D.getElementById('cf-charges-msgs').textContent;`), /dépasse la borne/);
    assert.equal(await w(`return W.__writes.length;`), 0);
    await change('#cf-dateEcheance', '2026-11-15');
    await until(`!D.getElementById('cf-create').disabled`);
    await clickOn('#cf-create-open');
    await until(`D.getElementById('task-form') && W.__writes.length === 1`);
    assert.equal((await writes())[0][0][3].charges, JSON.stringify([{ teamId: 5, heures: 45 }]));
    // La fiche complète montre la même personne et sa charge
    await until(`D.getElementById('tf-ch-5')`);
  },
);

test('nouvelle tâche en mode essai : personnes et charges notées, rien n’est envoyé', { skip: SKIP }, async () => {
  await openView('?edition=essai', 'kanban', 5);
  await clickOn('#btn-new-task');
  await until(`D.querySelector('dialog.cdlg[open] #cf-people')`);
  await typeIn('#cf-titre', 'Essai avec charges');
  await change('#cf-cible', await firstOption('#cf-cible'));
  await pickRadio('#cf-charges-unit-heures');
  await until(`D.getElementById('cf-ch-5') && !D.getElementById('cf-ch-5').disabled`);
  await typeIn('#cf-ch-5', '10');
  const b = await otherPerson(5);
  await change('#cf-assignees', String(b));
  await until(`D.getElementById('cf-ch-${b}')`);
  await clickOn('#cf-create');
  await until(`!D.querySelector('dialog.cdlg')`);
  assert.match(await w(`return D.querySelector('.toast__text').textContent;`), /Mode essai/);
  assert.equal(await w(`return W.__writes.length;`), 0);
  // Le journal de l'essai note les assignés et les charges saisies (actions exactes du panneau)
  await clickOn('#btn-edit-pill');
  await until(`D.querySelector('.edit-panel__json pre')`);
  const noted = await w(
    `return JSON.parse(D.querySelector('.edit-panel__json pre').textContent).flat().find((x) => x[0] === 'AddRecord')[3];`,
  );
  assert.equal(noted.titre, 'Essai avec charges');
  assert.deepEqual(noted.assignees, ['L', 5, b]);
  assert.equal(noted.charges, JSON.stringify([{ teamId: 5, heures: 10 }]));
});

test(
  'sous-tâche : bloc « Personnes » dans la fenêtre (dates du parent), retrait, fusion, remplacement, Ctrl+Entrée et annonces',
  { skip: SKIP },
  async () => {
    await openView(EDIT, 'kanban', 5);
    await w(`try { localStorage.setItem('roadmap-isd.chargesUnit', 'heures'); } catch {} return true;`);
    // Tâche parente datée (du 2 au 15 novembre : 52 h = 1 ETP), créée puis ouverte
    await clickOn('#btn-new-task');
    await until(`D.querySelector('dialog.cdlg[open] #cf-people')`);
    await typeIn('#cf-titre', 'Parente datée');
    await change('#cf-cible', await firstOption('#cf-cible'));
    await change('#cf-dateDebut', '2026-11-02');
    await change('#cf-dateEcheance', '2026-11-15');
    await clickOn('#cf-create-open');
    await until(`D.getElementById('task-form') && W.__writes.length === 1`);
    const parentId = await w(`return Number(D.getElementById('task-form').dataset.taskId);`);
    // Fenêtre « Sous-tâche » : dates du parent prérenseignées, « Je suis… » assignée, champ de charge actif
    await clickOn('#task-form [data-create="subtask"]');
    await until(`D.querySelector('dialog.cdlg[open] #cf-people')`);
    assert.equal(await w(`return D.getElementById('cf-dateDebut').value;`), '2026-11-02');
    assert.equal(await w(`return D.getElementById('cf-dateEcheance').value;`), '2026-11-15');
    assert.deepEqual(
      await w(`return [...D.querySelectorAll('#cf-people [data-charge]')].map((l) => Number(l.dataset.charge));`),
      [5],
    );
    assert.equal(await w(`return D.getElementById('cf-ch-5').disabled;`), false);
    // Champs reliés aux messages du bloc (ligne et messages des charges)
    assert.match(await w(`return D.getElementById('cf-ch-5').getAttribute('aria-describedby');`), /cf-charges-msgs/);
    await typeIn('#cf-titre', 'Sous-tâche avec personnes');
    const b = await otherPerson(5);
    await change('#cf-assignees', String(b));
    await until(`D.getElementById('cf-ch-${b}')`);
    await typeIn('#cf-ch-5', '10');
    await typeIn(`#cf-ch-${b}`, '20');
    assert.match(await w(`return D.getElementById('cf-charges-foot').textContent;`), /Total 30 h/);
    // Retrait de la seconde personne : ligne, assignation et charge disparaissent, le focus revient à l'ajout
    await clickOn(`#cf-person-${b}-remove`);
    await until(`!D.getElementById('cf-ch-${b}')`);
    assert.equal(await w(`return D.activeElement.id;`), 'cf-assignees');
    assert.match(await w(`return D.getElementById('cf-charges-foot').textContent;`), /Total 10 h/);
    assert.equal(await w(`return D.getElementById('cf-ch-5').value;`), '10');
    // Fusion et remplacement : états inaccessibles depuis la fenêtre (cellule neuve), donc boutons posés comme le
    // ferait le rendu, pour exercer les branches du contrôleur partagé avec la fiche
    await w(
      `const f = D.createElement('div'); f.innerHTML = '<button type="button" data-charge-merge="5" id="cf-probe-merge">m</button>'; D.getElementById('cf-people').append(f); return true;`,
    );
    await clickOn('#cf-probe-merge');
    await until(`D.activeElement.id === 'cf-ch-5'`);
    assert.equal(await w(`return D.getElementById('cf-ch-5').value;`), '10');
    await w(
      `const f = D.createElement('div'); f.innerHTML = '<button type="button" data-charges="replace-confirm" id="cf-probe-replace">r</button>'; D.getElementById('cf-people').append(f); return true;`,
    );
    await clickOn('#cf-probe-replace');
    await until(`D.activeElement.id === 'cf-assignees' && D.getElementById('cf-ch-5').value === ''`);
    // Charge saisie en heures sans échéance (aucun ETP de référence), puis échéance au 8 : les 60 h sont
    // gardées, au-dessus de la borne de 29 h
    await change('#cf-dateEcheance', '');
    await typeIn('#cf-ch-5', '60');
    await w(`D.getElementById('cf-charges-msgs').__live = 1; D.getElementById('cf-pending').__live = 1; return true;`);
    await change('#cf-dateEcheance', '2026-11-08');
    await until(`D.getElementById('cf-create').disabled`);
    assert.match(await w(`return D.getElementById('cf-charges-msgs').textContent;`), /dépasse la borne/);
    // Les régions annoncées gardent leur nœud (contenu changé sur place) ; la ligne est marquée invalide
    assert.equal(
      await w(
        `return D.getElementById('cf-charges-msgs').__live === 1 && D.getElementById('cf-pending').__live === 1;`,
      ),
      true,
    );
    assert.equal(await w(`return D.getElementById('cf-ch-5').getAttribute('aria-invalid');`), 'true');
    assert.equal(await w(`return D.getElementById('cf-people').classList.contains('fr-input-group--error');`), true);
    // Ctrl+Entrée depuis le titre : rien n'est envoyé et le focus va à la première charge invalide
    await w(
      `D.getElementById('cf-titre').dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); return true;`,
    );
    await until(`D.activeElement.id === 'cf-ch-5'`);
    assert.equal(await w(`return W.__writes.length;`), 1);
    // En saisissant une valeur dans la borne, la bordure d'erreur et l'état invalide suivent aussitôt
    await typeIn('#cf-ch-5', '25');
    assert.equal(await w(`return D.getElementById('cf-people').classList.contains('fr-input-group--error');`), false);
    assert.equal(await w(`return D.getElementById('cf-ch-5').hasAttribute('aria-invalid');`), false);
    await typeIn('#cf-ch-5', '60');
    assert.equal(await w(`return D.getElementById('cf-people').classList.contains('fr-input-group--error');`), true);
    assert.equal(await w(`return D.getElementById('cf-ch-5').getAttribute('aria-invalid');`), 'true');
    await typeIn('#cf-ch-5', '25');
    await until(`!D.getElementById('cf-create').disabled`);
    await clickOn('#cf-create');
    await until(`!D.querySelector('dialog.cdlg') && W.__writes.length === 2`);
    const cells = (await writes())[1][0][3];
    assert.equal(cells.parentTask, parentId);
    assert.deepEqual(cells.assignees, ['L', 5]);
    assert.equal(cells.charges, JSON.stringify([{ teamId: 5, heures: 25 }]));
    assert.equal(cells.dateEcheance, cfDay(2026, 11, 8));
  },
);

// ---------- Relectures (onRecords) : défilements gardés, aucun rendu sans donnée changée ----------

/** Simule onRecords (avec ou sans donnée changée) et attend la fin de la relecture qui suit (anti-rebond compris). */
async function remoteChange(actions) {
  const n = await w(`return W.__reads.length;`);
  await w(`W.grist.__simulateChange(${actions ? JSON.stringify(actions) : ''}); return true;`);
  // 5 tables de la Feuille et 2 tables de métadonnées relues, puis le rendu
  await until(`W.__reads.length >= ${n + 7} && !D.getElementById('btn-refresh')?.disabled`);
  await sleep(200);
}

/** Défilement de chaque zone (sélecteur → {top, left}) et de la page. */
async function scrolls(selectors) {
  return w(`const out = { page: { top: W.scrollY, left: W.scrollX } };
    for (const s of ${JSON.stringify(selectors)}) { const e = D.querySelector(s); out[s] = e ? { top: e.scrollTop, left: e.scrollLeft } : null; }
    return out;`);
}

function assertSameScroll(actual, expected, what) {
  for (const [k, v] of Object.entries(expected)) {
    assert.ok(actual[k], `${what} : zone ${k} absente`);
    assert.ok(Math.abs(actual[k].top - v.top) <= 2, `${what} : ${k} vertical ${actual[k].top} au lieu de ${v.top}`);
    assert.ok(
      Math.abs(actual[k].left - v.left) <= 2,
      `${what} : ${k} horizontal ${actual[k].left} au lieu de ${v.left}`,
    );
  }
}

/** Marque le panneau de la vue : la marque disparaît au prochain rendu complet. */
const markPanel = () => w(`D.getElementById('view-panel').dataset.probe = '1'; return true;`);
const panelKept = () => w(`return D.getElementById('view-panel')?.dataset.probe === '1';`);

/** Change le titre de la première tâche de la Feuille (modification faite ailleurs). */
async function retitleFirstTask(titre) {
  const id = await w(`return (await W.grist.docApi.fetchTable('Tasks')).id[0];`);
  return remoteChange(['UpdateRecord', 'Tasks', id, { titre }]);
}

/**
 * Scénario commun : zones défilées, trois relectures sans changement (aucun rendu, défilements gardés), puis une
 * vraie modification (rendu complet, défilements gardés).
 */
async function checkScrollKept(selectors, what) {
  const before = await scrolls(selectors);
  await markPanel();
  for (let i = 0; i < 3; i++) await remoteChange();
  assert.equal(await panelKept(), true, `${what} : la vue est redessinée sans donnée changée`);
  assertSameScroll(await scrolls(selectors), before, `${what}, relecture sans changement`);
  await retitleFirstTask(`Titre changé ailleurs (${what})`);
  assert.equal(await panelKept(), false, `${what} : une vraie modification doit redessiner la vue`);
  assertSameScroll(await scrolls(selectors), before, `${what}, après une vraie modification`);
}

test(
  'relecture (onRecords) : le Gantt garde son défilement vertical et horizontal, son niveau et sa période',
  { skip: SKIP },
  async () => {
    await open('');
    // Cadre plus étroit (800 px, au-dessus de la liste chronologique) : la frise déborde en largeur
    await send('Runtime.evaluate', { expression: `document.getElementById('w').style.width = '800px'` });
    await w(`D.getElementById('tab-gantt').click(); return true;`);
    await until(`D.querySelector('.gantt__scroll')`);
    await w(`D.getElementById('gantt-level-sous-tache').click(); return true;`);
    await until(`D.getElementById('gantt-level-sous-tache')?.checked`);
    const set = await w(`const b = D.querySelector('.gantt__scroll'); b.scrollTop = 180; b.scrollLeft = 260;
      await new Promise((r) => W.requestAnimationFrame(() => W.requestAnimationFrame(r)));
      return { top: b.scrollTop, left: b.scrollLeft };`);
    assert.ok(set.top > 50 && set.left > 50, `Gantt trop petit pour défiler : ${JSON.stringify(set)}`);
    const period = await w(`return D.querySelector('.gantt__period').textContent;`);
    const rows = await w(`return D.querySelectorAll('.grow').length;`);
    await checkScrollKept(['.gantt__scroll'], 'Gantt');
    assert.equal(await w(`return D.getElementById('gantt-level-sous-tache').checked;`), true);
    assert.equal(await w(`return D.querySelector('.gantt__period').textContent;`), period);
    assert.equal(await w(`return D.querySelectorAll('.grow').length;`), rows);
    assert.equal(await w(`return W.__writes.length;`), 0);
  },
);

test('relecture (onRecords) : le Tableau garde son défilement et sa page', { skip: SKIP }, async () => {
  await open('');
  await w(`D.getElementById('tab-table').click(); return true;`);
  await until(`D.querySelector('.tbl__table .fr-table__wrapper')`);
  const set =
    await w(`const b = D.querySelector('.tbl__table .fr-table__wrapper'); b.scrollTop = 200; b.scrollLeft = 120;
    await new Promise((r) => W.requestAnimationFrame(() => W.requestAnimationFrame(r)));
    return { top: b.scrollTop, left: b.scrollLeft };`);
  assert.ok(set.top > 50, `Tableau trop petit pour défiler : ${JSON.stringify(set)}`);
  await checkScrollKept(['.tbl__table .fr-table__wrapper'], 'Tableau');
});

test(
  'relecture (onRecords) : le Kanban garde le défilement du plateau et de la page, même avec une carte focalisée',
  { skip: SKIP },
  async () => {
    await open('');
    await until(`D.querySelector('.kanban__board')`);
    // Carte de la première colonne focalisée, puis plateau défilé vers la droite et page vers le bas : la carte
    // est hors champ, une relecture ne doit pas la ramener à l'écran
    await w(`D.querySelector('.kanban__board [data-task]').focus(); return true;`);
    const set = await w(`const b = D.querySelector('.kanban__board'); b.scrollLeft = b.scrollWidth;
      W.scrollTo(0, 400);
      await new Promise((r) => setTimeout(r, 300));
      return { left: b.scrollLeft, page: W.scrollY };`);
    assert.ok(set.left > 50, `plateau trop étroit pour défiler : ${JSON.stringify(set)}`);
    await checkScrollKept(['.kanban__board'], 'Kanban');
  },
);

test(
  'relecture (onRecords) : un défilement fait pendant la relecture est gardé (pas de retour en arrière)',
  { skip: SKIP },
  async () => {
    await open('?ecritures=lent');
    await w(`D.getElementById('tab-gantt').click(); return true;`);
    await until(`D.querySelector('.gantt__scroll')`);
    await w(`D.getElementById('gantt-level-sous-tache').click(); return true;`);
    await until(`D.getElementById('gantt-level-sous-tache')?.checked`);
    await w(`D.querySelector('.gantt__scroll').scrollTop = 60; return true;`);
    const id = await w(`return (await W.grist.docApi.fetchTable('Tasks')).id[0];`);
    const n = await w(`return W.__reads.length;`);
    await w(
      `W.grist.__simulateChange(['UpdateRecord', 'Tasks', ${id}, { titre: 'Pendant le défilement' }]); return true;`,
    );
    // L'utilisateur défile pendant l'anti-rebond (avant le rendu)
    await sleep(250);
    const mid = await w(`const b = D.querySelector('.gantt__scroll'); b.scrollTop = 240;
      await new Promise((r) => W.requestAnimationFrame(r)); return b.scrollTop;`);
    await until(`W.__reads.length >= ${n + 7} && !D.getElementById('btn-refresh')?.disabled`);
    await sleep(200);
    const after = await w(`return D.querySelector('.gantt__scroll').scrollTop;`);
    assert.ok(Math.abs(after - mid) <= 2, `défilement ${after} au lieu de ${mid}`);
  },
);

// ---------- Gantt : largeur de la colonne des noms (poignée) ----------

/** Largeur de la colonne des noms : cellule affichée, poignée et préférence enregistrée. */
async function labelWidth() {
  return w(`const h = D.getElementById('gantt-resizer');
    return {
      cell: Math.round(D.querySelector('.grow__label').getBoundingClientRect().width),
      now: Number(h.getAttribute('aria-valuenow')),
      text: h.getAttribute('aria-valuetext'),
      pref: JSON.parse(W.localStorage.getItem('roadmap-isd:prefs') || '{}').ganttLabelWidth ?? null,
    };`);
}

function assertWidth(actual, px, pref, what) {
  assert.ok(Math.abs(actual.cell - px) <= 1, `${what} : colonne de ${actual.cell} px au lieu de ${px}`);
  assert.deepEqual([actual.now, actual.text, actual.pref], [px, `${px} px`, pref], what);
}

test(
  'Gantt : la colonne des noms s’élargit à la poignée et au clavier, sans curseur, et la largeur est gardée',
  { skip: SKIP },
  async () => {
    await open('');
    await w(`D.getElementById('tab-gantt').click(); return true;`);
    await until(`D.getElementById('gantt-resizer') && D.querySelector('.grow__label')`);
    assertWidth(await labelWidth(), 320, null, 'largeur par défaut');
    const sep = await w(`const h = D.getElementById('gantt-resizer');
      return { role: h.getAttribute('role'), o: h.getAttribute('aria-orientation'), min: h.getAttribute('aria-valuemin'),
        max: Number(h.getAttribute('aria-valuemax')), tab: h.tabIndex, slider: !!D.getElementById('gantt-width'), sliderLabel: !!D.querySelector('.gantt__width') };`);
    assert.deepEqual(
      [sep.role, sep.o, sep.min, sep.tab, sep.slider, sep.sliderLabel],
      ['separator', 'vertical', '160', 0, false, false],
    );
    assert.ok(sep.max >= 592, `maximum ${sep.max}`);
    // Les noms gardent leur nom complet en infobulle
    assert.equal(
      await w(`const t = D.querySelector('.grow__title'); return t.getAttribute('title') === t.textContent;`),
      true,
    );

    // Glisser la poignée de 96 px vers la droite (vrais événements de pointeur)
    const at = await w(`const r = D.getElementById('gantt-resizer').getBoundingClientRect();
      const f = W.frameElement.getBoundingClientRect(); return { x: f.left + r.left + r.width / 2, y: f.top + r.top + r.height / 2 };`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    for (const dx of [30, 60, 96])
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + dx, y: at.y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: at.x + 96,
      y: at.y,
      button: 'left',
      clickCount: 1,
    });
    assertWidth(await labelWidth(), 416, 416, 'après le glisser');

    // Une modification faite ailleurs (rendu complet) garde la largeur
    await retitleFirstTask('Titre changé ailleurs (largeur)');
    assertWidth(await labelWidth(), 416, 416, 'après une relecture');

    // Clavier : → +16 px, Maj+← −64 px
    await w(`D.getElementById('gantt-resizer').focus(); return true;`);
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'ArrowRight',
      code: 'ArrowRight',
      windowsVirtualKeyCode: 39,
    });
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'ArrowRight',
      code: 'ArrowRight',
      windowsVirtualKeyCode: 39,
    });
    assertWidth(await labelWidth(), 432, 432, 'flèche droite');
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      windowsVirtualKeyCode: 37,
      modifiers: 8,
    });
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      windowsVirtualKeyCode: 37,
      modifiers: 8,
    });
    assertWidth(await labelWidth(), 368, 368, 'Maj+flèche gauche');

    // Largeur gardée après un rechargement de la page
    const host = `${BASE}/dev/host.html?donnees=synthetiques`;
    await send('Page.navigate', { url: host });
    await loaded(host);
    await until(`D.getElementById('gantt-resizer') && D.querySelector('.grow__label')`);
    assertWidth(await labelWidth(), 368, 368, 'après rechargement');

    // Double-clic : largeur par défaut, préférence effacée
    const at2 = await w(`const r = D.getElementById('gantt-resizer').getBoundingClientRect();
      const f = W.frameElement.getBoundingClientRect(); return { x: f.left + r.left + r.width / 2, y: f.top + r.top + r.height / 2 };`);
    for (const clickCount of [1, 2]) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at2.x, y: at2.y, button: 'left', clickCount });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at2.x, y: at2.y, button: 'left', clickCount });
    }
    assertWidth(await labelWidth(), 320, null, 'double-clic');
    assert.equal(await w(`return W.__writes.length;`), 0);
  },
);

test(
  'relecture (onRecords) : après l’écran « accès », des données inchangées redessinent la vue',
  { skip: SKIP },
  async () => {
    await open('');
    await remoteChange();
    await w(`W.__accesRefuse = true; return true;`);
    await remoteChange();
    assert.equal(await w(`return Boolean(D.querySelector('.view [data-task]'));`), false);
    // Accès rendu, données identiques à celles affichées avant l'écran : la vue revient quand même
    await w(`W.__accesRefuse = false; return true;`);
    await remoteChange();
    await until(`D.querySelector('.view [data-task]') && D.getElementById('btn-refresh')`);
  },
);

test(
  'relecture forcée (« Actualiser ») : redessine même sans donnée changée, défilement gardé',
  { skip: SKIP },
  async () => {
    await open('');
    await w(`D.getElementById('tab-table').click(); return true;`);
    await until(`D.querySelector('.tbl__table .fr-table__wrapper')`);
    await w(`D.querySelector('.tbl__table .fr-table__wrapper').scrollTop = 200; return true;`);
    const before = await scrolls(['.tbl__table .fr-table__wrapper']);
    await markPanel();
    const n = await w(`return W.__reads.length;`);
    await w(`D.getElementById('btn-refresh').click(); return true;`);
    await until(`W.__reads.length >= ${n + 7} && !D.getElementById('btn-refresh')?.disabled`);
    await sleep(200);
    assert.equal(await panelKept(), false, 'Actualiser doit redessiner la vue');
    assertSameScroll(await scrolls(['.tbl__table .fr-table__wrapper']), before, 'Actualiser');
  },
);

test('statistiques : chaque zone défilante a sa propre clé (data-scroll-key unique)', { skip: SKIP }, async () => {
  await open('');
  await w(`D.getElementById('tab-stats').click(); return true;`);
  await until(`D.querySelector('#view-panel[data-view="stats"] .vbars')`);
  const keys = await w(
    `return [...D.querySelectorAll('#view-panel [data-scroll-key]')].map((e) => e.dataset.scrollKey);`,
  );
  assert.ok(keys.length >= 2, keys.join(', '));
  assert.equal(new Set(keys).size, keys.length, `clés en double : ${keys.join(', ')}`);
});

test(
  'Gantt : un rendu complet pendant le glisser de la poignée garde la largeur, enregistrée au relâcher',
  { skip: SKIP },
  async () => {
    await open('');
    await w(`D.getElementById('tab-gantt').click(); return true;`);
    await until(`D.getElementById('gantt-resizer') && D.querySelector('.grow__label')`);
    const at = await w(`const r = D.getElementById('gantt-resizer').getBoundingClientRect();
      const f = W.frameElement.getBoundingClientRect(); return { x: f.left + r.left + r.width / 2, y: f.top + r.top + r.height / 2 };`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + 64, y: at.y, button: 'left', buttons: 1 });
    // Modification faite ailleurs pendant le glisser : la vue est redessinée, la largeur en cours reste
    await markPanel();
    await retitleFirstTask('Titre changé pendant le glisser');
    assert.equal(await panelKept(), false);
    assert.equal(await w(`return Number(D.getElementById('gantt-resizer').getAttribute('aria-valuenow'));`), 384);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + 128, y: at.y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: at.x + 128,
      y: at.y,
      button: 'left',
      clickCount: 1,
    });
    assertWidth(await labelWidth(), 448, 448, 'glisser poursuivi après le rendu');
    // Accessibilité : nom de l'en-tête sans celui de la poignée, aide clavier en description
    assert.equal(
      await w(
        `return D.getElementById(D.querySelector('.gantt__corner').getAttribute('aria-labelledby')).textContent;`,
      ),
      'Élément',
    );
    assert.match(
      await w(
        `return D.getElementById(D.getElementById('gantt-resizer').getAttribute('aria-describedby')).textContent;`,
      ),
      /Flèches gauche et droite/,
    );
  },
);

// ---------- Suppression depuis la fiche : tâche avec ses sous-tâches, chantier vide ; « Annuler » au même numéro ----------

/** Ouvre la fiche puis le formulaire d'une tâche du Kanban (par son identifiant). */
async function openTaskForm(id) {
  await until(`D.querySelector('.view [data-task="${id}"]')`);
  await clickOn(`.view [data-task="${id}"]`);
  await until(`D.getElementById('btn-edit-open')`);
  await clickOn('#btn-edit-open');
  await until(`D.getElementById('task-form') && D.getElementById('btn-form-delete')`);
}

/** Ouvre la fiche puis le formulaire d'un chantier (fil d'Ariane de la fiche d'une tâche du Kanban). */
async function openChantierForm(taskId) {
  await until(`D.querySelector('.view [data-task="${taskId}"]')`);
  await clickOn(`.view [data-task="${taskId}"]`);
  await until(`D.querySelector('.dt-crumbs [data-ref-table="Chantiers"]')`);
  await clickOn('.dt-crumbs [data-ref-table="Chantiers"]');
  await until(`D.getElementById('btn-edit-open')`);
  await clickOn('#btn-edit-open');
  await until(`D.getElementById('chantier-form')`);
}

/** Ouvre le formulaire d'un chantier par son identifiant (fiche ouverte depuis la vue, faute de carte). */
async function openChantierFormById(id) {
  await w(`D.getElementById('tab-gantt').click(); return true;`);
  const row = `[...D.querySelectorAll('#view-panel[data-view="gantt"] .grow--chantier')].find((r) => r.textContent.includes('Chantier sans tâche du pilotage'))`;
  await until(row);
  await w(`const t = ${row}.querySelector('[data-open]'); t.click(); return true;`);
  await until(`D.getElementById('btn-edit-open')`);
  await clickOn('#btn-edit-open');
  await until(`D.getElementById('chantier-form') && D.getElementById('btn-form-delete')`);
  assert.equal(
    await w(`return D.getElementById('detail-title').textContent.includes('Chantier sans tâche');`),
    true,
    id,
  );
}

test(
  'suppression : tâche et ses 2 sous-tâches dans un lot, disparues de la vue ; « Annuler » les recrée aux mêmes numéros',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await openTaskForm(2);
    // Bouton tertiaire à gauche du pied, jamais le bouton principal
    assert.equal(await w(`return D.querySelector('.tf-foot').firstElementChild.id;`), 'btn-form-delete');
    assert.match(await w(`return D.getElementById('btn-form-delete').className;`), /fr-btn--tertiary/);
    await clickOn('#btn-form-delete');
    await until(`D.querySelector('dialog.cdlg[open] #del-confirm')`);
    assert.match(
      await w(`return D.getElementById('cdlg-title').textContent;`),
      /Supprimer la tâche « Tâche 002 · Modélisation » \?/,
    );
    assert.equal(await w(`return D.querySelectorAll('#del-list li').length;`), 2);
    assert.match(await w(`return D.getElementById('del-hint').textContent;`), /Vous pourrez annuler juste après/);
    // « Annuler » a le focus par défaut
    assert.equal(await w(`return D.activeElement.id;`), 'del-cancel');
    await clickOn('#del-confirm');
    await until(`!D.querySelector('dialog.cdlg') && W.__writes.length === 1`);
    assert.deepEqual(await writes(), [
      [
        ['RemoveRecord', 'Tasks', 2],
        ['RemoveRecord', 'Tasks', 3],
        ['RemoveRecord', 'Tasks', 4],
      ],
    ]);
    await until(`D.getElementById('app-detail').dataset.open === 'false'`);
    await until(`!D.querySelector('.view [data-task="2"]')`);
    assert.match(
      await w(`return D.querySelector('.toast__text').textContent;`),
      /Tâche supprimée \(et ses 2 sous-tâches\)\./,
    );
    // Focus rendu à la vue, sur une carte voisine (pas au corps de la page)
    assert.equal(await w(`return D.getElementById('view-panel').contains(D.activeElement);`), true);
    assert.match(await w(`return D.activeElement.dataset.task ?? '';`), /^\d+$/);
    // Journal de l'en-tête à jour
    await w(`D.getElementById('btn-edit-pill').click(); return true;`);
    await until(`!D.getElementById('edit-panel').hidden`);
    assert.match(
      await w(`return D.querySelector('.edit-panel__list').textContent;`),
      /suppression de « Tâche 002 · Modélisation » et de ses 2 sous-tâches/,
    );
    await w(`D.getElementById('btn-edit-pill').click(); return true;`);
    // « Annuler » : les trois lignes recréées à leur numéro, la tâche revient
    await w(`D.querySelector('.toast [data-toast-action]').click(); return true;`);
    await until(`W.__writes.length === 2`);
    const restore = (await writes())[1];
    assert.deepEqual(
      restore.map((a) => [a[0], a[1], a[2]]),
      [
        ['AddRecord', 'Tasks', 2],
        ['AddRecord', 'Tasks', 3],
        ['AddRecord', 'Tasks', 4],
      ],
    );
    assert.equal(restore[1][3].parentTask, 2);
    assert.equal(restore[0][3].titre, 'Tâche 002 · Modélisation');
    await until(`D.querySelector('.view [data-task="2"]')`);
    await until(`/Suppression annulée/.test(D.querySelector('.toast__text')?.textContent ?? '')`);
  },
);

test(
  'suppression : chantier non vide refusé sans écriture ; « Annuler » de la fenêtre n’écrit rien',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await openChantierForm(2);
    await until(`D.getElementById('btn-form-delete')`);
    await clickOn('#btn-form-delete');
    await until(`D.querySelector('dialog.cdlg[open] #del-close')`);
    // Nombre attendu : tâches rattachées au chantier dans les données du faux Grist (jeu synthétique)
    const expected = await w(`const id = Number(D.getElementById('chantier-form').dataset.chantierId);
      const t = await W.grist.docApi.fetchTable('Tasks'); return t.Chantier.filter((c) => c === id).length;`);
    assert.ok(expected > 1);
    const alert = await w(`return D.getElementById('del-alert').textContent;`);
    assert.equal(Number(/déplacez ou supprimez d’abord ses (\d+) tâches/.exec(alert)?.[1]), expected);
    assert.equal(await w(`return D.querySelectorAll('.cdlg__foot button').length;`), 1);
    await clickOn('#del-close');
    await until(`!D.querySelector('dialog.cdlg')`);
    // Fenêtre de la tâche fermée par « Annuler » : rien n'est écrit, le formulaire reste ouvert
    await w(`D.getElementById('btn-detail-close').click(); return true;`);
    await until(`D.getElementById('app-detail').dataset.open === 'false'`);
    await openTaskForm(2);
    await clickOn('#btn-form-delete');
    await until(`D.querySelector('dialog.cdlg[open] #del-cancel')`);
    await clickOn('#del-cancel');
    await until(`!D.querySelector('dialog.cdlg')`);
    assert.equal(await w(`return Boolean(D.getElementById('task-form'));`), true);
    assert.equal(await w(`return W.__writes.length;`), 0);
  },
);

test('suppression : chantier vide supprimé puis restauré au même numéro', { skip: SKIP }, async () => {
  await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
  await openChantierFormById(31);
  await clickOn('#btn-form-delete');
  await until(`D.querySelector('dialog.cdlg[open] #del-confirm')`);
  assert.match(
    await w(`return D.getElementById('cdlg-title').textContent;`),
    /Supprimer le chantier « Chantier sans tâche du pilotage » \?/,
  );
  await clickOn('#del-confirm');
  await until(`W.__writes.length === 1`);
  assert.deepEqual(await writes(), [[['RemoveRecord', 'Chantiers', 31]]]);
  await until(`/Chantier supprimé/.test(D.querySelector('.toast__text')?.textContent ?? '')`);
  await until(
    `![...D.querySelectorAll('.grow--chantier')].some((r) => r.textContent.includes('Chantier sans tâche du pilotage'))`,
  );
  await w(`D.querySelector('.toast [data-toast-action]').click(); return true;`);
  await until(`W.__writes.length === 2`);
  const restore = (await writes())[1];
  assert.deepEqual([restore.length, restore[0][0], restore[0][1], restore[0][2]], [1, 'AddRecord', 'Chantiers', 31]);
  await until(
    `[...D.querySelectorAll('.grow--chantier')].some((r) => r.textContent.includes('Chantier sans tâche du pilotage'))`,
  );
});

test('suppression en mode essai : notée dans le journal, rien n’est envoyé', { skip: SKIP }, async () => {
  await open('?edition=essai');
  await openTaskForm(2);
  await clickOn('#btn-form-delete');
  await until(`D.querySelector('dialog.cdlg[open] #del-confirm')`);
  assert.match(await w(`return D.getElementById('del-confirm').textContent;`), /essai/);
  await clickOn('#del-confirm');
  await until(`!D.querySelector('dialog.cdlg')`);
  await until(`!D.querySelector('.view [data-task="2"]')`);
  assert.match(await w(`return D.querySelector('.toast__text').textContent;`), /Mode essai/);
  assert.equal(await w(`return W.__writes.length;`), 0);
  await w(`D.getElementById('btn-edit-pill').click(); return true;`);
  await until(`!D.getElementById('edit-panel').hidden`);
  assert.match(
    await w(`return D.querySelector('.edit-panel__list').textContent;`),
    /suppression de « Tâche 002 · Modélisation » et de ses 2 sous-tâches/,
  );
  assert.match(await w(`return D.querySelector('.edit-panel__json').textContent;`), /RemoveRecord/);
});

for (const query of ['', '?edition=1&doc=doc-dev-local&ecritures=lecteur']) {
  test(
    `suppression : aucun bouton sans édition ou pour un lecteur (${query || 'édition coupée'})`,
    { skip: SKIP },
    async () => {
      await open(query);
      await clickOn('.view [data-task="2"]');
      await until(`D.getElementById('app-detail').dataset.open === 'true'`);
      assert.equal(await w(`return D.querySelectorAll('#btn-form-delete, #btn-edit-open').length;`), 0);
      assert.equal(await w(`return W.__writes.length;`), 0);
    },
  );
}

// ---------- Gantt : couleur par chantier (mode par défaut) ----------
test(
  'Gantt : couleur par chantier par défaut (pastille, tâches de la teinte du chantier), bascule sur « Étape » mémorisée',
  { skip: SKIP },
  async () => {
    await open('');
    await w(`D.getElementById('tab-gantt').click(); return true;`);
    await until(`D.querySelector('.grow--chantier .grow__chip')`);
    assert.equal(await w(`return D.getElementById('gantt-color-chantier').checked;`), true);
    // Deux chantiers voisins d'un même projet : teintes différentes, pastille devant le nom
    const pair =
      await w(`const rows = [...D.querySelectorAll('.grow--chantier')].filter((r) => r.querySelector('.grow__chip'));
      for (let i = 0; i + 1 < rows.length; i++) {
        const a = rows[i], b = rows[i + 1];
        if (a.nextElementSibling === b) {
          const c = (r) => getComputedStyle(r.querySelector('.grow__chip')).backgroundColor;
          return { a: c(a), b: c(b), chipFirst: a.querySelector('.grow__label').firstElementChild.nextElementSibling.classList.contains('grow__chip') };
        }
      }
      return null;`);
    assert.ok(pair, 'deux chantiers voisins attendus au niveau « Chantiers »');
    assert.notEqual(pair.a, pair.b);
    assert.equal(pair.chipFirst, true);
    // Une tâche a la couleur de son chantier (barre, trait), une ligne de projet n'a pas de bande
    await w(`D.getElementById('gantt-level-tache').click(); return true;`);
    await until(`D.querySelector('.grow--tache .gbar')`);
    const same =
      await w(`const t = [...D.querySelectorAll('.grow--tache.grow--ch')].find((r) => r.querySelector('.gbar:not(.gbar--deduced)'));
      let c = t.previousElementSibling; while (!c.classList.contains('grow--chantier')) c = c.previousElementSibling;
      const bar = getComputedStyle(t.querySelector('.gbar')).backgroundColor;
      const chip = getComputedStyle(c.querySelector('.grow__chip')).backgroundColor;
      const trait = getComputedStyle(t.querySelector('.grow__title')).borderLeftColor;
      const proj = getComputedStyle(D.querySelector('.grow--projet > .grow__track')).backgroundImage;
      const band = getComputedStyle(t.querySelector('.grow__track')).backgroundImage;
      return { bar, chip, trait, proj, band, text: !!D.querySelector('.gbar__text'),
        label: t.querySelector('.gbar').getAttribute('aria-label'), chantier: c.querySelector('.grow__title').textContent };`);
    assert.equal(same.bar, same.chip);
    assert.equal(same.trait, same.chip);
    assert.equal(same.proj, 'none');
    assert.notEqual(same.band, 'none');
    assert.equal(same.text, false, 'pas de texte d’étape dans les barres en mode chantier');
    assert.ok(same.label.includes(`Chantier : ${same.chantier}`), same.label);
    // Bascule sur « Étape » : texte d'étape dans les barres, plus de pastille ; choix gardé au rechargement
    // (étapes : titres des sous-tâches du jeu synthétique)
    await w(`D.getElementById('gantt-level-sous-tache').click(); return true;`);
    assert.equal(await w(`return D.querySelectorAll('.gbar__text').length;`), 0);
    await w(`D.getElementById('gantt-color-phase').click(); return true;`);
    await until(`D.querySelector('.gbar__text') && !D.querySelector('.grow__chip')`);
    assert.equal(await w(`return JSON.parse(W.localStorage.getItem('roadmap-isd:prefs')).ganttColorBy;`), 'phase');
    await send('Page.reload');
    await until(`D.querySelector('.view [data-task]')`);
    await w(`D.getElementById('tab-gantt').click(); return true;`);
    await until(`D.getElementById('gantt-color-phase')?.checked`);
    assert.equal(await w(`return !!D.querySelector('.grow__chip');`), false);
  },
);

// ---------- Fiche tâche : mise en page des lignes « Date de clôture » et « Rattachement » ----------

test(
  'Fiche tâche : champs dans le panneau, bouton « Vider la date de clôture » à côté du champ, libellé « Rattachement » comme les autres',
  { skip: SKIP },
  async () => {
    try {
      for (const panel of [360, 480, 720]) {
        await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
        await w(`const s = D.createElement('style'); s.id = 'layout-probe';
          s.textContent = '.drawer[data-mode=edit]{width:min(${panel}px,100vw)!important}'; D.head.append(s); return true;`);
        await w(`D.querySelector('.view [data-task]').click(); return true;`);
        await until(`D.getElementById('btn-edit-open')`);
        await w(`D.getElementById('btn-edit-open').click(); return true;`);
        await until(`D.getElementById('task-form')`);
        await w(`if (!D.getElementById('tf-more').open) D.querySelector('#tf-more > summary').click(); return true;`);
        await until(`D.getElementById('tf-more').open`);
        // Pas de date de clôture : pas de bouton ; la date donnée, il apparaît aussitôt, date de clôture conservée en vue
        assert.equal(await w(`return D.querySelector('.tf-clear') === null;`), true);
        await w(`const t = D.getElementById('tf-dateCloture'); t.value = '2025-10-20';
          t.dispatchEvent(new W.Event('input', { bubbles: true })); t.dispatchEvent(new W.Event('change', { bubbles: true })); return true;`);
        await until(`D.querySelector('.tf-clear') && D.getElementById('tf-more').open`);
        const m =
          await w(`const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
          const body = D.querySelector('.drawer__body');
          const style = (e) => { const c = W.getComputedStyle(e); return [c.fontWeight, c.color, c.fontSize].join('|'); };
          const path = D.getElementById('tf-attach-path');
          return {
            body: box(body), hscroll: body.scrollWidth > body.clientWidth,
            inputs: [...D.querySelectorAll('#task-form input:not([type=radio]):not([type=checkbox]), #task-form select, #task-form textarea')]
              .map((e) => ({ id: e.id, ...box(e) })),
            date: box(D.getElementById('tf-dateCloture')), clear: box(D.querySelector('.tf-clear')),
            attachLabel: style(D.getElementById('tf-attach-label')),
            titleLabel: style(D.querySelector('label[for=tf-titre]')),
            path: box(path), move: box(D.getElementById('tf-move')),
          };`);
        const at = `panneau ${panel} px`;
        assert.equal(m.hscroll, false, `${at} : défilement horizontal`);
        for (const i of m.inputs)
          assert.ok(
            i.l >= m.body.l - 0.5 && i.r <= m.body.r + 0.5,
            `${at} : ${i.id} déborde (${i.l}-${i.r} pour ${m.body.l}-${m.body.r})`,
          );
        assert.ok(
          m.clear.l >= m.body.l - 0.5 && m.clear.r <= m.body.r + 0.5,
          `${at} : bouton « Vider » hors du panneau`,
        );
        const apart = m.clear.l >= m.date.r - 0.5 || m.clear.t >= m.date.b - 0.5 || m.clear.b <= m.date.t + 0.5;
        assert.ok(apart, `${at} : le bouton « Vider » chevauche le champ de date`);
        assert.equal(m.attachLabel, m.titleLabel, `${at} : libellé « Rattachement » différent des autres libellés`);
        assert.ok(
          m.move.l >= m.body.l - 0.5 && m.move.r <= m.body.r + 0.5,
          `${at} : bouton « Changer » hors du panneau`,
        );
        const same = m.move.l >= m.path.r - 0.5;
        const below = m.move.t >= m.path.b - 0.5;
        assert.ok(same || below, `${at} : « Changer » chevauche le chemin`);
        if (same)
          assert.ok(
            Math.abs((m.move.t + m.move.b) / 2 - (m.path.t + m.path.b) / 2) <= 14,
            `${at} : « Changer » mal aligné avec le chemin`,
          );
        // Vider la date : le bouton disparaît aussitôt, la date est vide
        await w(`D.querySelector('.tf-clear').click(); return true;`);
        await until(`!D.querySelector('.tf-clear')`);
        assert.equal(await w(`return D.getElementById('tf-dateCloture').value;`), '');
      }
    } finally {
      await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    }
    assert.equal(await w(`return W.__writes.length;`), 0);
  },
);

test(
  'Fiche tâche : le panneau tient dans la fenêtre à 390 px, sans passer sous la barre de défilement',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    try {
      await until(`D.documentElement.clientWidth <= 390`);
      await openForm();
      await sleep(400); // fin de la transition d'ouverture
      const r = await w(`const d = D.querySelector('.drawer').getBoundingClientRect();
        return { l: d.left, r: d.right, cw: D.documentElement.clientWidth };`);
      assert.ok(r.l >= -0.5 && r.r <= r.cw + 0.5, `panneau ${r.l}-${r.r} pour une fenêtre de ${r.cw} px`);
    } finally {
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
  },
);

test(
  'Fenêtre de création à 390 px : la feuille tient dans la fenêtre, sans passer sous la barre de défilement',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    try {
      await until(`D.documentElement.clientWidth <= 390`);
      await clickOn('#btn-new-task');
      await until(`D.querySelector('dialog.cdlg[open]')`);
      const r = await w(`const d = D.querySelector('dialog.cdlg[open]').getBoundingClientRect();
        return { l: d.left, r: d.right, cw: D.documentElement.clientWidth };`);
      assert.ok(r.l >= -0.5 && r.r <= r.cw + 0.5, `fenêtre ${r.l}-${r.r} pour ${r.cw} px`);
    } finally {
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
  },
);

test(
  'Fiche tâche : la date de clôture saisie, un vrai clic sur « Enregistrer » pendant le blur n’est pas perdu',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await openForm();
    await w(`if (!D.getElementById('tf-more').open) D.querySelector('#tf-more > summary').click(); return true;`);
    await until(`D.getElementById('tf-more').open`);
    await type('tf-titre', 'Titre et clôture'); // le bouton est déjà actif : il est mis à jour sur place
    await w(`const t = D.getElementById('tf-dateCloture'); t.focus(); t.value = '2025-10-20';
      t.dispatchEvent(new W.Event('input', { bubbles: true })); return true;`);
    await sleep(400); // fin de la transition d'ouverture du panneau
    const at = await w(`const r = D.getElementById('btn-form-save').getBoundingClientRect();
      const f = W.frameElement.getBoundingClientRect(); return { x: f.left + r.left + r.width / 2, y: f.top + r.top + r.height / 2 };`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    // Le champ de date perd le focus au mousedown : son événement change part avant le relâchement
    await w(`D.getElementById('tf-dateCloture').dispatchEvent(new W.Event('change', { bubbles: true })); return true;`);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await until(`W.__writes.length === 1`);
    assert.equal(await w(`return 'dateCloture' in W.__writes[0].args[0][0][3];`), true);
    assert.equal(await w(`return W.__writes.length;`), 1);
  },
);

test(
  'Fiche tâche : « Vider la date de clôture » pressé pendant le blur de la date n’est pas détaché et vide la date',
  { skip: SKIP },
  async () => {
    await open('?edition=1&doc=doc-dev-local&ecritures=memoire');
    await openForm();
    await w(`if (!D.getElementById('tf-more').open) D.querySelector('#tf-more > summary').click(); return true;`);
    await until(`D.getElementById('tf-more').open`);
    const setDate = (v) =>
      w(`const t = D.getElementById('tf-dateCloture'); t.focus(); t.value = '${v}';
        t.dispatchEvent(new W.Event('input', { bubbles: true })); return true;`);
    const change = () =>
      w(`D.getElementById('tf-dateCloture').dispatchEvent(new W.Event('change', { bubbles: true })); return true;`);
    await setDate('2025-10-20');
    await change();
    await until(`D.querySelector('.tf-clear')`);
    // Date de clôture existante modifiée : le bouton reste le même élément
    await w(`D.querySelector('.tf-clear').dataset.mark = 'same'; return true;`);
    await setDate('2025-10-21');
    await w(`D.querySelector('.tf-clear').scrollIntoView({ block: 'center' }); return true;`);
    await sleep(400);
    const at = await w(`const r = D.querySelector('.tf-clear').getBoundingClientRect();
      const f = W.frameElement.getBoundingClientRect(); return { x: f.left + r.left + r.width / 2, y: f.top + r.top + r.height / 2 };`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await change();
    assert.equal(await w(`return D.querySelector('.tf-clear')?.dataset.mark ?? null;`), 'same');
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await until(`!D.querySelector('.tf-clear')`);
    assert.equal(await w(`return D.getElementById('tf-dateCloture').value;`), '');
  },
);
