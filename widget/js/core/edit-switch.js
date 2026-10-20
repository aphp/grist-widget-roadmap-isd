/**
 * Interrupteur d'édition et verrou de document. Fonctions pures.
 * L'édition est COUPÉE par défaut : elle ne s'ouvre que si l'adresse de la page le demande (edition=1 ou
 * edition=essai), si flags.json l'autorise (arrêt d'urgence publié avec les versions) et, pour l'envoi réel,
 * si le document ouvert est celui que nomme le paramètre doc=<id> de la page. Aucun identifiant de document
 * n'est écrit dans le code : il vient de l'adresse configurée dans Grist par un propriétaire.
 */

/** Valeurs acceptées du paramètre edition=. */
const ON = new Set(['1', 'oui', 'on']);
const DRY = new Set(['essai']);

/**
 * Mode demandé par l'adresse de la page.
 * @param {string|URL|URLSearchParams} src adresse complète, chaîne de requête ou paramètres
 * @returns {{requested:'off'|'dry-run'|'on', doc:string|null}}
 */
export function readEditMode(src) {
  let params;
  try {
    if (src instanceof URLSearchParams) params = src;
    else if (src instanceof URL) params = src.searchParams;
    else {
      const s = String(src ?? '');
      params = s.includes('://')
        ? new URL(s).searchParams
        : new URLSearchParams(s.split('#')[0].replace(/^[^?]*\?/, ''));
    }
  } catch {
    return { requested: 'off', doc: null };
  }
  const value = (params.get('edition') ?? '').trim().toLowerCase();
  const doc = (params.get('doc') ?? '').trim();
  return {
    requested: ON.has(value) ? 'on' : DRY.has(value) ? 'dry-run' : 'off',
    doc: /^[A-Za-z0-9_-]{1,64}$/.test(doc) ? doc : null,
  };
}

/**
 * Délai maximal des requêtes d'édition : 10 s par défaut ; le paramètre delai=<ms> ne peut que le raccourcir
 * (au moins 1 s), pour les essais sur le faux Grist.
 */
export function readTimeout(search, max = 10000) {
  let v;
  try {
    v = Number(new URLSearchParams(String(search ?? '')).get('delai'));
  } catch {
    v = NaN;
  }
  return Number.isFinite(v) && v > 0 ? Math.min(max, Math.max(1000, Math.round(v))) : max;
}

/** Identifiant du document dans l'adresse d'API de getAccessToken (…/api/docs/<id>), sinon null. */
export function docIdFromBaseUrl(baseUrl) {
  const m = /\/api\/docs\/([^/?#]+)/.exec(String(baseUrl ?? ''));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Adresse FIXE de flags.json, commune à toutes les versions publiées : si la page est servie depuis un dossier de
 * version (…/v0.2.0/index.html), le fichier est lu à la racine du site, au-dessus de ce dossier
 * (…/flags.json). Sinon, à côté de la page. Couper l'édition partout = publier ce seul fichier avec
 * { "edition": false }.
 * @param {string} pathname chemin de la page (location.pathname)
 * @param {string} [file]
 */
export function flagsUrl(pathname, file = 'flags.json') {
  const dir = String(pathname || '/').replace(/[^/]*$/, '') || '/';
  const m = /^(.*\/)v\d+(?:\.\d+)*[^/]*\/$/.exec(dir);
  return `${m ? m[1] : dir}${file}`;
}

/** Mode du writer pour un état d'édition : 'off' dès que l'utilisateur ne peut pas modifier. */
export function writerMode(edit) {
  return edit?.canEdit === true && (edit.mode === 'on' || edit.mode === 'dry-run') ? edit.mode : 'off';
}

/** flags.json autorise-t-il l'édition ? Absent, illisible ou sans { "edition": true } : non (par prudence). */
export function flagsAllowEdition(json) {
  return json !== null && typeof json === 'object' && json.edition === true;
}

/**
 * État d'édition de la session.
 * @param {{requested:'off'|'dry-run'|'on', doc:string|null, docId:string|null, flagsOk:boolean,
 *          access:'owners'|'editors'|'viewers'|null}} s
 * @returns {{mode:'off'|'dry-run'|'on', canEdit:boolean, reason:string}}
 *   reason : 'off' (non demandé), 'flags' (coupé à distance), 'doc' (page non configurée pour ce document),
 *   'viewer' (compte sans droit de modification), 'ok'
 */
export function resolveEditState({ requested, doc, docId, flagsOk, access }) {
  if (requested === 'off') return { mode: 'off', canEdit: false, reason: 'off' };
  if (!flagsOk) return { mode: 'off', canEdit: false, reason: 'flags' };
  // Le verrou ne s'applique qu'à l'envoi réel : le mode essai n'envoie rien
  if (requested === 'on' && (!doc || !docId || doc !== docId)) return { mode: 'off', canEdit: false, reason: 'doc' };
  if (access === 'viewers') return { mode: requested, canEdit: false, reason: 'viewer' };
  return { mode: requested, canEdit: true, reason: 'ok' };
}
