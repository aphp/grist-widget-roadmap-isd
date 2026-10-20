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
  query = `${query || '?'}${query ? '&' : ''}donnees=synthetiques`;
  const host = `${BASE}/dev/host.html`;
  await send('Page.navigate', { url: host });
  await loaded(host);
  await send('Runtime.evaluate', {
    expression: `localStorage.setItem('roadmap-isd:prefs', JSON.stringify({ mePrompted: true, view: 'kanban' }))`,
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
  'charges (2b) : ajout en ETP, passage en heures, dates changées (écart d’ETP), fusion avec une saisie concurrente',
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
      /1 ETP maximum par personne \(soit 70 h sur la période\)/,
    );
    assert.equal(await w(`return D.getElementById('btn-form-save').disabled;`), true);
    await type(`tf-ch-${person}`, '1');
    assert.equal(await w(`return D.getElementById('btn-form-save').disabled;`), false);
    assert.equal(await w(`return D.getElementById('tf-ch-${person}-eq').textContent.trim();`), '= 70 h');
    assert.match(await w(`return D.getElementById('tf-charges-foot').textContent;`), /Total 70 h · 1,0 ETP/);
    // Passage en heures : 70 h = 1,0 ETP ; l'unité est mémorisée
    await w(`const r = D.getElementById('tf-charges-unit-heures'); r.checked = true;
      r.dispatchEvent(new W.Event('change', { bubbles: true })); return true;`);
    assert.equal(await w(`return D.getElementById('tf-ch-${person}').value;`), '70');
    assert.equal(await w(`return D.getElementById('tf-ch-${person}-eq').textContent.trim();`), '= 1,0 ETP');
    assert.equal(await w(`return localStorage.getItem('roadmap-isd.chargesUnit');`), 'heures');
    // Dates changées (Q8 A) : heures conservées, écart d'ETP signalé
    await setDate('dateEcheance', '2026-11-21');
    assert.equal(await w(`return D.getElementById('tf-ch-${person}').value;`), '70');
    assert.match(await w(`return D.getElementById('tf-ch-${person}-msg').textContent;`), /ETP 1,0 → 0,7/);
    // Sans début : la saisie en ETP est désactivée, en heures elle reste possible
    await w(`const r = D.getElementById('tf-charges-unit-etp'); r.checked = true;
      r.dispatchEvent(new W.Event('change', { bubbles: true })); return true;`);
    await setDate('dateDebut', '');
    assert.match(await w(`return D.getElementById('tf-charges-nodates').textContent;`), /Indiquez début et échéance/);
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
    assert.equal(cells.charges, `[${[...theirs, JSON.stringify({ teamId: person, heures: 70 })].join(',')}]`);
    assert.ok(cells.assignees.includes(person));
    assert.equal(cells.dateDebut, Date.UTC(2026, 10, 2) / 1000);
    assert.equal(cells.dateEcheance, Date.UTC(2026, 10, 21) / 1000);
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
    // Ajouter c : assignée, le champ de charge prend le focus ; 0,5 ETP sur 14 jours = 35 h
    await change('#tf-assignees', String(c));
    await until(`D.getElementById('tf-ch-${c}')`);
    assert.equal(await w(`return D.activeElement.id;`), `tf-ch-${c}`);
    await type(`tf-ch-${c}`, '0,5');
    assert.equal(await w(`return D.getElementById('tf-ch-${c}-eq').textContent.trim();`), '= 35 h');
    assert.match(await w(`return D.getElementById('tf-charges-foot').textContent;`), /Total 42 h · 0,6 ETP/);
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
      charges: `[${charges.slice(1, -1)},${JSON.stringify({ teamId: c, heures: 35 })}]`,
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
    // Tâche sans personne, 14 jours (0,5 ETP = 35 h)
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
    assert.equal(await w(`return D.getElementById('tf-ch-${m}-eq').textContent.trim();`), '= 35 h');
    assert.equal(await w(`return W.__writes.length;`), 0);
    await w(`D.getElementById('btn-form-save').click(); return true;`);
    await until(`W.__writes.length === 1`);
    const batch = await w(`return W.__writes[0].args[0];`);
    assert.deepEqual(batch, [
      ['UpdateRecord', 'Tasks', id, { assignees: ['L', m], charges: JSON.stringify([{ teamId: m, heures: 35 }]) }],
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

// ---------- Statut depuis la carte et la ligne (P-UX-6) ----------
const EDIT = '?edition=1&doc=doc-dev-local&ecritures=memoire';

/** Ouvre une vue avec « Je suis… » posé (Mes tâches), toujours sur le jeu synthétique. */
async function openView(query, view, me = 5) {
  const host = `${BASE}/dev/host.html`;
  const q = `${query}&donnees=synthetiques`;
  await send('Page.navigate', { url: host });
  await loaded(host);
  await send('Runtime.evaluate', {
    expression: `localStorage.setItem('roadmap-isd:prefs', JSON.stringify({ mePrompted: true, view: '${view}', me: ${me} }))`,
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
      // « s » sur une carte n'ouvre rien
      await openView(query, 'kanban');
      await w(`D.querySelector('.kcard').focus(); return true;`);
      await key('s');
      await sleep(200);
      assert.equal(await w(`return Boolean(D.getElementById('qs-menu'));`), false);
      assert.doesNotMatch(await w(`return D.getElementById('kanban-help').textContent;`), /Maj\+F10/);
      assert.equal(await w(`return W.__writes.length;`), 0);
    },
  );
}
