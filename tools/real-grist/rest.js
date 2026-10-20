/* global process, fetch, AbortSignal, URLSearchParams */
/**
 * Transport REST vers le VRAI Grist, pour le banc d'essai tools/real-grist/harness.js.
 *
 * - Lecture : /records (hidden=true, toutes les colonnes, comme fetchTable du plugin), /columns et /sql.
 * - Écriture : POST /apply, UNIQUEMENT sur le document de test. Le document visé, l'id du document de test et la
 *   liste des documents protégés (Feuille de route, document de référence…) viennent de l'environnement, posé par
 *   run.py depuis config.yaml : aucun identifiant n'est écrit dans le dépôt. Le contrôle est refait à chaque envoi.
 */

/** Configuration lue dans l'environnement ; lève une erreur si le document visé n'est pas le document de test. */
export function guardedConfig(env = process.env) {
  const url = env.GRIST_URL;
  const key = env.GRIST_API_KEY;
  const doc = env.GRIST_DOC;
  const testDoc = env.GRIST_TEST_DOC_ID;
  const protectedIds = String(env.GRIST_PROTECTED_DOC_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!url || !key) throw new Error('GRIST_URL et GRIST_API_KEY requis (lancer par run.py)');
  if (!doc || !testDoc || doc !== testDoc) throw new Error('refus : le document visé n’est pas le document de test');
  // Feuille de route (doc_id) ET document de référence (mkt_doc_id) au moins : sans eux, aucun contrôle possible
  if (protectedIds.length < 2) throw new Error('refus : liste des documents protégés incomplète');
  if (protectedIds.includes(doc)) throw new Error('refus : le document visé est un document protégé');
  return { url: url.replace(/\/+$/, ''), key, doc, testDoc, protectedIds };
}

/** Erreur renvoyée par Grist : message tel quel (champ error du JSON), statut HTTP et corps brut. */
export class GristHttpError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'GristHttpError';
    this.status = status;
    this.body = body;
  }
}

export function createRest(cfg, { timeoutMs = 60000 } = {}) {
  const base = `${cfg.url}/api/docs/${cfg.doc}`;
  const log = [];
  let sent = 0;
  const stats = { reads: 0, readMs: 0 };

  async function call(method, path, body) {
    const t0 = Date.now();
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    if (method === 'GET') {
      stats.reads++;
      stats.readMs += Date.now() - t0;
    }
    if (!r.ok) {
      let msg = text;
      try {
        msg = JSON.parse(text).error ?? text;
      } catch {
        /* corps non JSON : texte brut */
      }
      throw new GristHttpError(r.status, String(msg), text);
    }
    return JSON.parse(text);
  }

  async function columns(table) {
    return (await call('GET', `/tables/${encodeURIComponent(table)}/columns?hidden=true`)).columns;
  }

  async function sql(q) {
    return (await call('GET', `/sql?q=${encodeURIComponent(q)}`)).records.map((r) => r.fields);
  }

  async function records(table, filter = null) {
    const qs = new URLSearchParams({ hidden: 'true' });
    if (filter) qs.set('filter', JSON.stringify(filter));
    return (await call('GET', `/tables/${encodeURIComponent(table)}/records?${qs}`)).records;
  }

  /** Une ligne brute (toutes les colonnes), ou null. */
  async function row(table, id) {
    const r = await records(table, { id: [id] });
    return r.length ? { id: r[0].id, ...r[0].fields } : null;
  }

  /** Table au format colonnaire de docApi.fetchTable ; tables de métadonnées lues par /sql. */
  async function fetchTable(table) {
    if (table.startsWith('_grist_')) {
      const rows = await sql(`select * from ${table}`);
      const cols = rows.length ? Object.keys(rows[0]) : ['id'];
      return Object.fromEntries(cols.map((c) => [c, rows.map((r) => r[c])]));
    }
    const [cols, recs] = await Promise.all([columns(table), records(table)]);
    const out = { id: recs.map((r) => r.id) };
    for (const c of cols) out[c.id] = recs.map((r) => (c.id in r.fields ? r.fields[c.id] : null));
    return out;
  }

  /** applyUserActions : contrôle du document à CHAQUE envoi, journal des lots et des réponses. */
  async function apply(actions) {
    guardedConfig();
    if (cfg.doc !== cfg.testDoc || cfg.protectedIds.includes(cfg.doc)) throw new Error('refus : document protégé');
    sent++;
    const entry = { actions, response: null, error: null };
    log.push(entry);
    try {
      entry.response = await call('POST', '/apply', actions);
      return entry.response;
    } catch (err) {
      entry.error = { status: err.status ?? null, message: err.message, body: err.body ?? null };
      throw err;
    }
  }

  return {
    columns,
    sql,
    records,
    row,
    fetchTable,
    apply,
    log,
    stats,
    sentCount: () => sent,
  };
}
