import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';

const PORT = 8798;
let child;

const get = (path) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

// Requête HTTP brute : node ne normalise pas `path`, donc les « .. » arrivent tels quels au serveur.
const status = (path) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });

before(async () => {
  child = spawn('python3', ['dev/serve.py', String(PORT)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await status('/dev/host.html');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('serveur de développement injoignable');
});

after(() => child?.kill());

test('refuse toute traversée de chemin', async () => {
  for (const p of [
    '/dev/../../config.yaml',
    '/dev/data/../../../config.yaml',
    '/dev/../.git/config',
    '/dev/../tools/grist_api.py',
    '/dev/%2e%2e/%2e%2e/config.yaml',
    '/../config.yaml',
    '/js/../../config.yaml',
  ]) {
    assert.equal(await status(p), 404, p);
  }
});

test('sert les fichiers de dev/', async () => {
  assert.equal(await status('/dev/host.html'), 200);
  assert.equal(await status('/dev/mock-grist.js'), 200);
  assert.equal(await status('/dev/synthetic-snapshot.js'), 200);
});

test('?mock=1 sert widget/index.html avec le faux Grist à la place de la vraie API', async () => {
  const res = await get('/index.html?mock=1');
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('/dev/mock-grist.js'));
  // En mode faux Grist, la balise de la vraie API (copie locale) doit avoir disparu.
  assert.ok(!res.body.includes('src="vendor/grist-plugin-api.js"'));
});
