/**
 * Tags des tâches et des chantiers (lot 2e, Q3 B) : affecter et retirer, sans jamais toucher aux options des
 * colonnes. Fonctions pures, sans écriture (l'envoi est grist-writer.js).
 *
 * - `Tasks.tags` et `Chantiers.tags` sont deux listes distinctes (ChoiceList) ; une cellule s'écrit ['L', …], une
 *   liste vide null (write-encode.js).
 * - Tags proposés : les choix déclarés de la colonne, plus les valeurs déjà utilisées dans les données.
 * - Un nom nouveau peut être affecté : il est écrit dans la cellule SANS être déclaré (aucune modification de la colonne) ; il
 *   s'affiche alors comme « non déclaré », comme dans Grist.
 * - Valeurs déjà présentes dans la cellule : recopiées telles quelles (espaces, doublons compris), jamais retouchées.
 */
import { normalize } from './text.js';

/** Longueur maximale d'un nouveau tag (caractères). */
export const TAG_MAX = 80;
/** Nombre maximal de tags sur une ligne (au-delà, seules les cellules déjà plus longues restent modifiables). */
export const TAGS_MAX_COUNT = 30;
/** Colonnes de tags : une liste par table. */
export const TAG_TABLES = Object.freeze(['Tasks', 'Chantiers']);

// Caractères de contrôle (retours à la ligne, tabulations…) : refusés dans un nouveau tag
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Clé de comparaison d'un tag (sans accents ni casse, espaces réduits) : recherche et doublons approchés. */
export const tagKey = (s) => normalize(s);

/** Saisie d'un nouveau tag nettoyée : espaces de bord retirés, espaces intérieurs réduits à un seul. */
export const cleanTag = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Problème d'un nouveau tag (déjà nettoyé) : 'vide', 'long', 'controle', sinon null.
 * @param {string} s
 */
export function newTagProblem(s) {
  if (typeof s !== 'string' || !s.trim()) return 'vide';
  if (s !== s.trim()) return 'espaces';
  if (CONTROL.test(s)) return 'controle';
  if ([...s].length > TAG_MAX) return 'long';
  return null;
}

function counts(list) {
  const m = new Map();
  for (const v of list) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

/**
 * Contrôle strict d'une liste de tags à écrire, par rapport à la cellule d'avant : liste de chaînes ; chaque valeur
 * absente d'avant doit être un tag valide (newTagProblem) ; aucun doublon ajouté (une valeur ne peut pas apparaître
 * plus souvent qu'avant, ni deux fois si elle est nouvelle) ; pas plus de TAGS_MAX_COUNT tags, sauf si la cellule en
 * avait déjà autant. Les valeurs d'avant gardées ne sont pas recontrôlées (recopiées telles quelles).
 * @param {unknown} next
 * @param {unknown} before
 * @returns {string|null} 'format', 'trop', 'doublon', 'vide', 'espaces', 'controle', 'long' ou null
 */
export function tagsWriteProblem(next, before) {
  if (!Array.isArray(next) || !next.every((x) => typeof x === 'string')) return 'format';
  const old = Array.isArray(before) ? before.filter((x) => typeof x === 'string') : [];
  if (next.length > TAGS_MAX_COUNT && next.length > old.length) return 'trop';
  const had = counts(old);
  for (const [v, n] of counts(next)) {
    const prev = had.get(v) ?? 0;
    if (n > Math.max(1, prev)) return 'doublon';
    if (!prev) {
      const p = newTagProblem(v);
      if (p) return p;
    }
  }
  return null;
}

/** Égalité de deux listes de tags, dans l'ordre. */
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Fusion à trois voies d'une liste de tags, valeur par valeur en comptant les exemplaires (multi-ensemble) : les
 * ajouts et retraits de la saisie (par rapport à l'ouverture) sont appliqués à la cellule relue. Les modifications
 * faites ailleurs entre-temps survivent ; même changement des deux côtés = appliqué une fois ; retirer un exemplaire
 * d'un tag en double retire bien un exemplaire. L'ordre et les valeurs de la cellule relue sont conservés (les
 * exemplaires retirés sont les derniers), les ajouts viennent à la fin, dans l'ordre de la saisie. Jamais de conflit.
 * @param {string[]} base cellule à l'ouverture du formulaire
 * @param {string[]} mine saisie
 * @param {string[]} fresh cellule relue
 * @returns {string[]}
 */
export function mergeTags(base, mine, fresh) {
  const b = counts(base ?? []);
  const m = counts(mine ?? []);
  const f = counts(fresh ?? []);
  const target = new Map();
  for (const v of new Set([...b.keys(), ...m.keys(), ...f.keys()])) {
    const nb = b.get(v) ?? 0;
    const dm = (m.get(v) ?? 0) - nb;
    const df = (f.get(v) ?? 0) - nb;
    // Même sens des deux côtés : le plus grand changement (une seule fois) ; sinon les deux s'ajoutent
    const n =
      dm === 0
        ? nb + df
        : df === 0
          ? nb + dm
          : Math.sign(dm) === Math.sign(df)
            ? nb + (Math.abs(dm) > Math.abs(df) ? dm : df)
            : nb + dm + df;
    target.set(v, Math.max(0, n));
  }
  const kept = new Map();
  const out = [];
  // Cellule relue, de la fin vers le début : les derniers exemplaires en trop sont retirés
  for (const v of [...(fresh ?? [])].reverse()) {
    if ((kept.get(v) ?? 0) < target.get(v)) {
      kept.set(v, (kept.get(v) ?? 0) + 1);
      out.unshift(v);
    }
  }
  for (const v of mine ?? [])
    if ((kept.get(v) ?? 0) < target.get(v)) {
      kept.set(v, (kept.get(v) ?? 0) + 1);
      out.push(v);
    }
  return out;
}

/**
 * Cellule de tags lue dans la Feuille : lisible si elle est vide (null, '', ['L']) ou une liste ['L', …] de chaînes
 * (une chaîne vide comprise, gardée telle quelle). Sinon (texte libre d'un import, ['E', …] d'une erreur, liste avec
 * des nombres…) : illisible, `raw` en donne le contenu (JSON), et la cellule n'est jamais réécrite sans
 * confirmation de remplacement.
 * @returns {{ok:boolean, tags:string[], raw:string|null}}
 */
export function readTagsCell(cell) {
  if (cell === null || cell === undefined || cell === '') return { ok: true, tags: [], raw: null };
  if (Array.isArray(cell) && cell[0] === 'L' && cell.slice(1).every((x) => typeof x === 'string'))
    return { ok: true, tags: cell.slice(1), raw: null };
  let raw;
  try {
    raw = typeof cell === 'string' ? cell : JSON.stringify(cell);
  } catch {
    raw = String(cell);
  }
  return { ok: false, tags: [], raw };
}

/**
 * Tags modifiés ici ET dans la Feuille depuis l'ouverture : la saisie est fusionnée sur la cellule relue
 * (mergeTags). Les tags retirés de la saisie qui ont déjà disparu, ou les ajouts déjà présents, ne changent rien.
 * @returns {object} lot à envoyer (tags fusionnés, ou retirés si la fusion redonne la cellule relue)
 */
export function mergeTagsChange(base, fresh, changes) {
  if (!('tags' in changes) || sameList(base.tags ?? [], fresh.tags ?? [])) return changes;
  const tags = mergeTags(base.tags, changes.tags, fresh.tags);
  const out = { ...changes, tags };
  if (sameList(tags, fresh.tags ?? [])) delete out.tags;
  return out;
}

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

/**
 * Tags proposés pour une table : choix déclarés de la colonne et valeurs utilisées (lignes du modèle), avec le
 * nombre d'utilisations ; par ordre alphabétique.
 * @param {object} model
 * @param {'Tasks'|'Chantiers'} table
 * @returns {{value:string, declared:boolean, count:number}[]}
 */
export function tagOptions(model, table) {
  const declared = declaredTags(model, table);
  const rows = table === 'Chantiers' ? model.chantiers : model.tasks;
  const used = new Map();
  for (const r of rows?.values() ?? []) for (const v of new Set(r.tags ?? [])) used.set(v, (used.get(v) ?? 0) + 1);
  const all = new Set([...declared, ...used.keys()].filter((v) => typeof v === 'string' && v.trim()));
  return [...all]
    .map((value) => ({ value, declared: declared.includes(value), count: used.get(value) ?? 0 }))
    .sort((a, b) => collator.compare(a.value, b.value));
}

/** Choix déclarés de la colonne de tags d'une table (lus dans la Feuille ; [] s'il n'y en a pas). */
export function declaredTags(model, table) {
  const c = model?.choices?.[`${table}.tags`];
  return Array.isArray(c) ? c.filter((v) => typeof v === 'string') : [];
}

/**
 * Résultats de la recherche du sélecteur de tags : tags proposés non encore choisis dont le nom contient la saisie
 * (sans accents ni casse ; ceux qui commencent par la saisie d'abord), puis, si la saisie est un nom nouveau valide,
 * l'option de l'affecter sans le déclarer.
 * @param {{value:string, declared:boolean, count:number}[]} options
 * @param {string} query
 * @param {string[]} selected tags déjà sur la ligne
 * @param {number} [limit]
 * @returns {{items:{value:string, declared:boolean, count:number, create?:boolean}[], invalid:string|null,
 *   duplicate:boolean}} invalid : raison pour laquelle la saisie ne peut pas être créée ; duplicate : déjà choisi
 */
export function searchTags(options, query, selected = [], limit = 8) {
  const q = tagKey(query);
  const chosen = new Set(selected.map(tagKey));
  const free = options.filter((o) => !chosen.has(tagKey(o.value)));
  const hits = q
    ? free
        .filter((o) => tagKey(o.value).includes(q))
        .sort((a, b) => Number(!tagKey(a.value).startsWith(q)) - Number(!tagKey(b.value).startsWith(q)))
    : free;
  const items = hits.slice(0, limit);
  const name = cleanTag(query);
  const duplicate = Boolean(q) && chosen.has(q);
  const exact = options.some((o) => tagKey(o.value) === q);
  const invalid = name ? newTagProblem(name) : null;
  if (name && !duplicate && !exact && !invalid && selected.length < TAGS_MAX_COUNT)
    items.push({ value: name, declared: false, count: 0, create: true });
  return { items, invalid: name && !exact && !duplicate ? invalid : null, duplicate };
}
