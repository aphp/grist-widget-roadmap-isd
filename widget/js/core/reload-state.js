/**
 * Relectures des données (onRecords) sans perturber la lecture : empreinte des données lues, pour ne rien
 * redessiner quand une relecture n'apporte aucun changement, et mémoire des défilements de chaque zone de la vue
 * (attribut data-scroll-key), pour les rendre tels quels après un rendu complet.
 */

/** Texte stable d'une valeur : clés d'objet triées, tableaux dans leur ordre. */
function stable(value) {
  if (value === undefined) return 'u';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
    .join(',')}}`;
}

/** Hachage 53 bits (cyrb53) d'une chaîne, en hexadécimal. */
function hash53(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * Empreinte des données lues par la passerelle (tables, choix, types des colonnes, problèmes) : deux lectures
 * qui donnent la même empreinte s'affichent à l'identique. Longueur du texte jointe au hachage.
 * @param {{tables?:object, choices?:object, columns?:object|null, problems?:object[]}} raw
 */
export function dataFingerprint(raw) {
  const text = stable({
    tables: raw?.tables ?? null,
    choices: raw?.choices ?? null,
    columns: raw?.columns ?? null,
    problems: raw?.problems ?? null,
  });
  return `${text.length}:${hash53(text)}`;
}

/**
 * Faut-il redessiner après une relecture ? Toujours si elle est demandée (écriture, « Actualiser ») ou si rien
 * n'a encore été affiché depuis une lecture (correction locale après une écriture : shown = null) ; sinon
 * seulement si les données ont changé.
 * @param {string|null} shown empreinte des données affichées
 * @param {string} next empreinte des données relues
 * @param {boolean} [force]
 */
export function needsRender(shown, next, force = false) {
  return Boolean(force) || shown === null || shown !== next;
}

/** Clés des zones défilantes d'une racine : data-scroll-key, numérotée si elle se répète (#2, #3…). */
function keyed(root) {
  const out = [];
  const seen = new Map();
  for (const e of root?.querySelectorAll?.('[data-scroll-key]') ?? []) {
    const k = e.dataset?.scrollKey || e.getAttribute?.('data-scroll-key') || '';
    if (!k) continue;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    out.push([n === 1 ? k : `${k}#${n}`, e]);
  }
  return out;
}

/**
 * Défilement de chaque zone marquée data-scroll-key sous root, lu juste avant un rendu (la position la plus
 * récente : un défilement fait pendant la relecture est celui qui est gardé).
 * @returns {Record<string, {top:number, left:number}>}
 */
export function captureScrolls(root) {
  const out = {};
  for (const [k, e] of keyed(root)) out[k] = { top: e.scrollTop || 0, left: e.scrollLeft || 0 };
  return out;
}

/**
 * Rend à chaque zone du même nom son défilement (écrit seulement s'il diffère) ; une zone nouvelle ou disparue
 * est laissée telle quelle. Retourne les zones rendues.
 */
export function restoreScrolls(root, saved) {
  const done = [];
  for (const [k, e] of keyed(root)) {
    const s = saved?.[k];
    if (!s) continue;
    if (e.scrollTop !== s.top) e.scrollTop = s.top;
    if (e.scrollLeft !== s.left) e.scrollLeft = s.left;
    done.push(e);
  }
  return done;
}
