/**
 * Édition de Tasks.charges (lot 2b), sur le JSON BRUT de la cellule : [{"teamId": n, "heures": h}], h = total
 * d'heures de la personne sur la tâche. Fonctions pures, sans écriture (l'envoi est grist-writer.js).
 *
 * parseCharges (charges.js) écarte les entrées invalides : bien pour l'affichage, destructeur pour une réécriture.
 * Ici, le TEXTE d'origine de chaque entrée non touchée est recopié octet par octet (ordre, clés inconnues, entrées
 * invalides et entrées à 0 h compris) ; seules les entrées modifiées ou ajoutées sont encodées (JSON.stringify,
 * heures arrondies à 0,5 h). Une cellule qu'on ne pourrait pas relire sans perte (nombre hors limites, grand
 * entier, clé en double) n'est pas modifiable dans le widget, comme une cellule illisible.
 *
 * Conversion : 1 ETP = capacité d'une personne standard sur la période de dateDebut à dateEcheance (periodFte,
 * capacity.js:fteHours) ; h = ETP × heures de 1 ETP. Période changée (capacité différente) : l'ETP fait foi, les
 * heures sont recalculées (charges-rescale.js) ; à capacité égale, les entrées sont recopiées octet par octet.
 */
import { HOURS_PER_FTE_WEEK, etpToHours, fteHours, hoursToEtp } from './capacity.js';
import { taskEtpByRole } from './kanban-data.js';
import { EncodeError, parseNumberFr } from './write-encode.js';
import { ESTIMATION_MAX_ETP } from './estimation.js';

/** Pas de stockage des heures. */
export const HOURS_STEP = 0.5;
/** Plus petite charge non nulle acceptée en saisie (en dessous, l'arrondi donnerait 0 h sans le dire). */
export const MIN_HOURS = 0.25;
/** Au plus 1 ETP par personne sur une tâche (décision utilisateur) : la capacité standard de la période. */
export const MAX_ETP = 1;
/** Sans période connue, borne de bon sens : 2 000 h par personne et par tâche. */
export const MAX_HOURS = 2000;
// Personnes estimation (Team.aph, actives) : seules exemptées de la borne de 1 ETP, voir estimation.js
export { ESTIMATION_APH, ESTIMATION_MAX_ETP, isEstimationAph, isEstimationPerson } from './estimation.js';

/** Heures arrondies à 0,5 h près. */
export const roundHours = (h) => Math.round(h / HOURS_STEP) * HOURS_STEP;

/**
 * Heures de 1 ETP sur la période de la tâche (capacity.js:fteHours), ou null sans dates exploitables ou sans aucun
 * jour ouvré (mêmes règles que sans dates).
 * @param {number|null} start
 * @param {number|null} end
 * @returns {number|null}
 */
export const periodFte = (start, end) => fteHours(start, end);

/** Jours calendaires de la période (bornes incluses), ou null sans dates exploitables (texte du pied seulement). */
export const periodDayCount = (start, end) =>
  Number.isInteger(start) && Number.isInteger(end) && end >= start ? end - start + 1 : null;

/**
 * Période des charges : 'ok' (heures de 1 ETP connues), 'none' (date absente), 'order' (échéance avant le début),
 * 'noWorkday' (aucun jour ouvré). Hors 'ok', mêmes règles que sans dates (pas d'ETP, borne de 2 000 h).
 * @returns {'ok'|'none'|'order'|'noWorkday'}
 */
export function periodState(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return 'none';
  if (end < start) return 'order';
  return fteHours(start, end) === null ? 'noWorkday' : 'ok';
}

/**
 * Heures maximales d'une personne : 1 ETP sur la période (fte : heures de 1 ETP, periodFte) ; 2 000 h sans période.
 * La personne estimation (estimation vrai) : ESTIMATION_MAX_ETP sur la période, 2 000 h sans période.
 */
export function maxHours(fte, estimation = false) {
  return fte ? roundHours(etpToHours(estimation ? ESTIMATION_MAX_ETP : MAX_ETP, fte)) : MAX_HOURS;
}

/** teamId d'une entrée (entier > 0, ou chaîne de chiffres), sinon null. Même règle que charges.js. */
export function entryTeamId(e) {
  const v = e?.teamId;
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const n = Number(v);
    return n > 0 ? n : null;
  }
  return null;
}

/** heures d'une entrée (nombre fini ≥ 0, ou chaîne qui se lit comme tel), sinon null. */
export function entryHours(e) {
  const v = e?.heures;
  let n = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
  return n !== null && Number.isFinite(n) && n >= 0 ? n : null;
}

const isObject = (e) => e !== null && typeof e === 'object' && !Array.isArray(e);
const isValidEntry = (e) => isObject(e) && entryTeamId(e) !== null && entryHours(e) !== null;

const NUMBER = /-?\d+(\.\d+)?([eE][+-]?\d+)?/y;

/**
 * Un littéral numérique se relit-il sans perte ? Tout double fini se ré-encode sans perte (JSON.stringify) ;
 * un entier écrit sans décimale doit en plus être un entier sûr (sinon sa valeur affichée change).
 */
function lossyNumber(lit, frac, exp) {
  const n = Number(lit);
  if (!Number.isFinite(n)) return true;
  return !frac && !exp && !Number.isSafeInteger(n);
}

/**
 * Découpe un tableau JSON valide en textes d'origine de ses éléments, et signale ceux qu'une relecture altérerait
 * (clé en double, nombre hors limites ou trop précis).
 * @param {string} text texte déjà validé par JSON.parse (tableau)
 * @returns {{text:string, lossy:boolean}[]}
 */
function scanArray(text) {
  let i = 0;
  let lossy = false;
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };
  const str = () => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      const keys = new Set();
      i++;
      ws();
      if (text[i] === close) return void i++;
      for (;;) {
        if (c === '{') {
          ws();
          const k = str();
          if (keys.has(k)) lossy = true;
          keys.add(k);
          ws();
          i++; // « : »
        }
        value();
        ws();
        if (text[i++] === close) return;
      }
    }
    if (c === '"') return void str();
    if (c === 't' || c === 'n') return void (i += 4);
    if (c === 'f') return void (i += 5);
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    i += m[0].length;
    if (lossyNumber(m[0], m[1], m[2])) lossy = true;
  };
  const out = [];
  ws();
  i++; // « [ »
  ws();
  if (text[i] === ']') return out;
  for (;;) {
    ws();
    const start = i;
    lossy = false;
    value();
    out.push({ text: text.slice(start, i), lossy });
    ws();
    if (text[i++] === ']') return out;
  }
}

/**
 * Lecture de la cellule brute.
 * @returns {{ok:true, empty:boolean, entries:any[], texts:string[]}
 *   |{ok:false, error:'json'|'format'|'perte', raw:string}}
 *   empty : cellule vide (jamais réécrite en « [] » si rien n'est saisi) ; texts : texte d'origine de chaque
 *   entrée ; 'perte' : une entrée ne se relirait pas sans altération (édition bloquée)
 */
export function readChargesCell(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, empty: true, entries: [], texts: [] };
  const text = String(raw);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'json', raw: text };
  }
  if (!Array.isArray(data)) return { ok: false, error: 'format', raw: text };
  const parts = scanArray(text);
  if (parts.some((p) => p.lossy)) return { ok: false, error: 'perte', raw: text };
  return { ok: true, empty: false, entries: data, texts: parts.map((p) => p.text) };
}

/** Encodage compact, comme l'existant (`[{"teamId":40,"heures":10}]`). */
export const encodeCharges = (entries) => JSON.stringify(entries);

/** Forme canonique d'une valeur JSON (clés triées) : comparaison sur les valeurs, pas sur l'écriture. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/**
 * Égalité de deux cellules de charges, sur les valeurs : une cellule vide et « [] » sont égales (une cellule
 * vide n'est pas réécrite en « [] ») ; un contenu illisible n'est égal qu'à lui-même, caractère par caractère.
 */
export function sameCharges(a, b) {
  const x = readChargesCell(a);
  const y = readChargesCell(b);
  if (!x.ok || !y.ok) return (a ?? '') === (b ?? '');
  return canonical(x.entries) === canonical(y.entries);
}

/**
 * Lignes d'affichage : une par personne (ordre de première apparition), heures cumulées si elle a plusieurs
 * entrées (doublon signalé) ; les entrées invalides à part, conservées (teamId lisible éventuel : une saisie
 * pour cette personne remplacera l'entrée).
 * @returns {{rows:{teamId:number, heures:number, count:number}[],
 *   invalid:{index:number, text:string, teamId:number|null}[]}}
 */
export function chargeRows(entries) {
  const rows = [];
  const byId = new Map();
  const invalid = [];
  entries.forEach((e, index) => {
    if (!isValidEntry(e)) {
      invalid.push({ index, text: JSON.stringify(e) ?? String(e), teamId: isObject(e) ? entryTeamId(e) : null });
      return;
    }
    const id = entryTeamId(e);
    let row = byId.get(id);
    if (!row) {
      row = { teamId: id, heures: 0, count: 0 };
      byId.set(id, row);
      rows.push(row);
    }
    row.heures += entryHours(e);
    row.count += 1;
  });
  for (const r of rows) r.heures = Math.round(r.heures * 1e6) / 1e6;
  return { rows, invalid };
}

/** Erreur de manipulation des charges (cellule illisible, doublon non fusionné, valeur invalide). */
export class ChargesError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ChargesError';
    this.reason = reason;
  }
}

/** Entrées d'une cellule modifiable : valeur et texte d'origine. */
function itemsOf(raw) {
  const cell = readChargesCell(raw);
  if (!cell.ok) throw new ChargesError('illisible');
  return cell.entries.map((value, i) => ({ value, text: cell.texts[i] }));
}

/** Cellule ré-assemblée : textes d'origine des entrées non touchées, encodage compact des autres. */
const encodeItems = (items) => `[${items.map((x) => x.text).join(',')}]`;
const touched = (value) => ({ value, text: JSON.stringify(value) });

const indicesOf = (items, teamId) =>
  items.flatMap((x, i) => (isValidEntry(x.value) && entryTeamId(x.value) === teamId ? [i] : []));
/** Entrées invalides (objets) qui portent pourtant ce teamId (heures absentes ou invalides). */
const invalidIndicesOf = (items, teamId) =>
  items.flatMap((x, i) => (isObject(x.value) && !isValidEntry(x.value) && entryTeamId(x.value) === teamId ? [i] : []));

function checkHours(heures) {
  if (typeof heures !== 'number' || !Number.isFinite(heures) || heures < 0) throw new ChargesError('heures');
  return roundHours(heures);
}

/**
 * Heures d'une personne : son entrée est mise à jour à sa place (autres clés conservées, teamId et heures en
 * nombres) ; à défaut, une entrée invalide qui porte son teamId est remplacée ; sinon ajout en fin de liste.
 * Une personne en double doit d'abord être fusionnée.
 * @returns {string} nouvelle cellule
 */
export function setPersonHours(raw, teamId, heures) {
  if (!Number.isInteger(teamId) || teamId <= 0) throw new ChargesError('personne');
  const h = checkHours(heures);
  const items = itemsOf(raw);
  const idx = indicesOf(items, teamId);
  if (idx.length > 1) throw new ChargesError('doublon');
  const at = idx.length ? idx[0] : invalidIndicesOf(items, teamId)[0];
  if (at !== undefined) items[at] = touched({ ...items[at].value, teamId, heures: h });
  else items.push(touched({ teamId, heures: h }));
  return encodeItems(items);
}

/** Ajoute une personne (0 h par défaut) ; sans effet si elle a déjà une entrée valide. */
export function addPerson(raw, teamId, heures = 0) {
  if (indicesOf(itemsOf(raw), teamId).length) return raw;
  return setPersonHours(raw, teamId, heures);
}

/** Retire toutes les entrées valides de la personne ; le reste est conservé dans l'ordre. */
export function removePerson(raw, teamId) {
  const items = itemsOf(raw);
  const drop = new Set(indicesOf(items, teamId));
  if (!drop.size) return raw;
  return encodeItems(items.filter((_, i) => !drop.has(i)));
}

/** Fusionne les doublons d'une personne (sur accord de l'utilisateur) : une entrée, à la place de la première. */
export function mergeDuplicates(raw, teamId) {
  const items = itemsOf(raw);
  const idx = indicesOf(items, teamId);
  if (idx.length < 2) return raw;
  const total = roundHours(idx.reduce((s, i) => s + entryHours(items[i].value), 0));
  const out = [];
  items.forEach((x, i) => {
    if (i === idx[0]) out.push(touched({ ...x.value, teamId, heures: total }));
    else if (!idx.includes(i)) out.push(x);
  });
  return encodeItems(out);
}

/** Entrées d'une personne, sous forme canonique (comparaison des versions). */
const groupOf = (items, teamId) => canonical(indicesOf(items, teamId).map((i) => items[i].value));
const teamIds = (items) => [...new Set(items.filter((x) => isValidEntry(x.value)).map((x) => entryTeamId(x.value)))];

/**
 * Cellule de base où seules les personnes ids prennent leurs entrées valides de fromRaw (texte d'origine) ; les
 * autres gardent celles de la base (entrées invalides de la base comprises).
 * @param {string|null} baseRaw
 * @param {string|null} fromRaw
 * @param {Iterable<number>} ids
 * @returns {string|null} null si une des cellules est illisible
 */
export function withPeopleFrom(baseRaw, fromRaw, ids) {
  if (!readChargesCell(baseRaw).ok || !readChargesCell(fromRaw).ok) return null;
  const list = [...ids];
  if (!list.length) return baseRaw;
  const from = itemsOf(fromRaw);
  let out = itemsOf(baseRaw);
  for (const id of list) {
    const replacement = indicesOf(from, id).map((i) => from[i]);
    const idx = indicesOf(out, id);
    if (!idx.length) out = [...out, ...replacement];
    else out = out.flatMap((x, i) => (i === idx[0] ? replacement : idx.includes(i) ? [] : [x]));
  }
  return encodeItems(out);
}

/**
 * Fusion à trois voies, personne par personne : on part de la cellule relue (« leur » version) et on y reporte
 * seulement ce que l'utilisateur a changé depuis l'ouverture (base → mienne). Les modifications d'autres
 * personnes sur d'autres entrées survivent, avec leur texte d'origine. Une personne modifiée des deux côtés,
 * différemment, est en conflit (sa version « mienne » est quand même reportée dans raw, pour « Garder la mienne »).
 * @returns {{ok:true, raw:string, conflicts:number[]}|{ok:false}} ok faux si une version n'est pas modifiable
 */
export function mergeCharges(baseRaw, mineRaw, theirsRaw) {
  const cells = [baseRaw, mineRaw, theirsRaw].map(readChargesCell);
  if (cells.some((c) => !c.ok)) return { ok: false };
  if (sameCharges(baseRaw, theirsRaw)) return { ok: true, raw: mineRaw, conflicts: [] };
  if (sameCharges(baseRaw, mineRaw)) return { ok: true, raw: theirsRaw, conflicts: [] };
  const [b, m] = [itemsOf(baseRaw), itemsOf(mineRaw)];
  let out = itemsOf(theirsRaw);
  const conflicts = [];
  for (const id of new Set([...teamIds(b), ...teamIds(m)])) {
    const mine = groupOf(m, id);
    const base = groupOf(b, id);
    if (mine === base) continue;
    const theirs = groupOf(out, id);
    if (theirs !== base && theirs !== mine) conflicts.push(id);
    const replacement = indicesOf(m, id).map((i) => m[i]);
    const idx = indicesOf(out, id);
    if (!idx.length) out = [...out, ...replacement];
    else
      out = out.flatMap((x, i) => {
        if (i === idx[0]) return replacement;
        return idx.includes(i) ? [] : [x];
      });
  }
  return { ok: true, raw: encodeItems(out), conflicts };
}

/**
 * Contrôle strict avant écriture (grist-writer.js) : tableau JSON ; toute entrée dont le TEXTE ne figure pas tel
 * quel dans la cellule d'avant (entrée nouvelle ou modifiée) est un objet encodé compact, avec un teamId entier
 * existant dans Team et des heures finies, ≥ 0, au pas de 0,5 h et d'au plus 1 ETP sur la période (maxHours ;
 * ESTIMATION_MAX_ETP pour la personne estimation). Les entrées recopiées octet par octet (même invalides, même
 * au-dessus de la borne) sont admises.
 * @param {string} value cellule à écrire
 * @param {string|null|undefined} before cellule d'avant (relue)
 * @param {(id:number) => boolean} teamExists
 * @param {number|null} [fte] heures de 1 ETP sur la période de la tâche après la modification (periodFte)
 * @param {(id:number) => boolean} [isEstimation] la personne est-elle la personne estimation (Team.aph) ?
 * @returns {string|null} raison du refus, ou null
 */
export function chargesWriteProblem(value, before, teamExists, fte = null, isEstimation = null) {
  if (typeof value !== 'string') return 'texte JSON attendu';
  let data;
  try {
    data = JSON.parse(value);
  } catch {
    return 'JSON illisible';
  }
  if (!Array.isArray(data)) return 'tableau JSON attendu';
  const texts = scanArray(value).map((p) => p.text);
  const prev = readChargesCell(before);
  const kept = new Map();
  for (const t of prev.ok ? prev.texts : []) kept.set(t, (kept.get(t) ?? 0) + 1);
  for (const [i, e] of data.entries()) {
    const t = texts[i];
    if (kept.get(t)) {
      kept.set(t, kept.get(t) - 1);
      continue;
    }
    if (!isObject(e)) return 'entrée qui n’est pas un objet';
    if (JSON.stringify(e) !== t) return 'encodage non compact';
    if (!Number.isInteger(e.teamId) || e.teamId <= 0) return 'teamId entier attendu';
    if (typeof teamExists !== 'function' || !teamExists(e.teamId)) return `personne inconnue : ${e.teamId}`;
    if (typeof e.heures !== 'number' || !Number.isFinite(e.heures) || e.heures < 0)
      return 'heures : nombre fini positif ou nul attendu';
    if (roundHours(e.heures) !== e.heures) return 'heures : pas de 0,5 h attendu';
    const estimation = typeof isEstimation === 'function' && isEstimation(e.teamId) === true;
    const max = maxHours(fte, estimation);
    if (e.heures > max)
      return `heures : au plus ${max} h (${estimation ? ESTIMATION_MAX_ETP : MAX_ETP} ETP sur la période)`;
  }
  return null;
}

/** Décimales d'un ETP saisi : 2 entre 0 et 1 (0,25 ; 0,05), 1 à partir de 1 (1,5), après arrondi à 2 décimales. */
export function etpDecimals(etp) {
  const r = Math.abs(Math.round(etp * 100) / 100);
  return r > 0 && r < 1 ? 2 : 1;
}

/** ETP arrondi à ses décimales (etpDecimals). */
export function roundEtp(etp) {
  const k = 10 ** etpDecimals(etp);
  return Math.round(etp * k) / k;
}

/** Heures par semaine d'un temps plein : 35 h/semaine = 1 ETP (saisie en h/semaine, unité « hsem »). */
export const HOURS_PER_WEEK_FTE = HOURS_PER_FTE_WEEK;

/** h/semaine arrondies à une décimale. */
const roundHsem = (v) => Math.round(v * 10) / 10;

/**
 * Valeur affichée dans la case de saisie : ETP selon etpDecimals, ou h/semaine (heures ÷ heures de 1 ETP × 35) à une
 * décimale ; null sans période (fte null).
 * @param {number} heures heures totales stockées
 * @param {'etp'|'hsem'} unit
 * @param {number|null} fte heures de 1 ETP sur la période (periodFte)
 */
export function inputValue(heures, unit, fte) {
  if (!fte) return null;
  const etp = hoursToEtp(heures, fte);
  return unit === 'hsem' ? roundHsem(etp * HOURS_PER_WEEK_FTE) : roundEtp(etp);
}

/**
 * Saisie d'une ligne → heures totales à stocker (arrondies à 0,5 h). En ETP : 2 décimales sous 1, une au-delà ; en
 * h/semaine (quotité, 35 h/semaine = 1 ETP) : une décimale. Heures = ETP × heures de 1 ETP de la période (congés,
 * fériés et ralentissements déduits). Sans période : aucune saisie.
 * @param {string} text valeur saisie (« 1,5 »)
 * @param {'etp'|'hsem'} unit
 * @param {number|null} fte heures de 1 ETP sur la période (periodFte)
 * @param {number|null} [current] heures actuelles de la ligne : une saisie égale à la valeur affichée les
 *   conserve telles quelles (pas d'arrondi ni de dérive)
 * @param {{estimation?:boolean, shown?:number|null}} [opts] estimation : personne estimation (borne
 *   ESTIMATION_MAX_ETP, erreur 'maxEstimation') ; shown : valeur affichée dans la case (charges-rescale.js:
 *   displayValue), ressaisie sans effet elle aussi
 * @returns {{heures:number}|{error:'nombre'|'negatif'|'dates'|'vide'|'decimale'|'petit'|'max'|'maxEstimation',
 *   max?:number, min?:number}} min (h/semaine) : plus petite saisie permise sur la période
 */
export function hoursFromInput(text, unit, fte, current = null, { estimation = false, shown = null } = {}) {
  let n;
  try {
    n = parseNumberFr(text);
  } catch (err) {
    if (err instanceof EncodeError) return { error: 'nombre' };
    throw err;
  }
  if (n === null) return { error: 'vide' };
  if (n < 0) return { error: 'negatif' };
  if (!fte) return { error: 'dates' };
  if (current !== null && (n === inputValue(current, unit, fte) || n === shown)) return { heures: current };
  const k = unit === 'hsem' ? 10 : n < 1 ? 100 : 10;
  if (Math.abs(n * k - Math.round(n * k)) > 1e-9) return { error: 'decimale' };
  const etp = inputEtp(n, unit);
  const exact = etpToHours(etp, fte);
  if (n > 0 && exact < MIN_HOURS)
    return unit === 'hsem'
      ? { error: 'petit', min: Math.ceil(((MIN_HOURS * HOURS_PER_WEEK_FTE) / fte) * 10 - 1e-9) / 10 }
      : { error: 'petit' };
  // Borne sur l'ETP saisi (1 ETP, ou ESTIMATION_MAX_ETP) : 1 ETP tout juste reste permis quand la capacité de la
  // période s'arrondit vers le bas ; ses heures valent alors exactement maxHours
  const limit = estimation ? ESTIMATION_MAX_ETP : MAX_ETP;
  if (etp > limit + 1e-9) return { error: estimation ? 'maxEstimation' : 'max', max: maxHours(fte, estimation) };
  return { heures: roundHours(exact) };
}

/** ETP d'une saisie dans son unité (h/semaine ÷ 35). */
export const inputEtp = (n, unit) => (unit === 'hsem' ? n / HOURS_PER_WEEK_FTE : n);

/** ETP équivalent (null sans période). */
export const etpOf = (heures, fte) => (fte ? hoursToEtp(heures, fte) : null);

/**
 * Écart d'heures d'une ligne quand les dates changent (l'ETP fait foi : charges-rescale.js recalcule les heures).
 * @param {{heures:number}} ref référence de la ligne (ChargeRef)
 * @param {number} heures heures actuelles du brouillon
 * @returns {{from:number, to:number}|null} null si les heures n'ont pas changé
 */
export function hoursDelta(ref, heures) {
  return heures === ref.heures ? null : { from: ref.heures, to: heures };
}

/**
 * Pied de la section : total en heures, ETP total et par profil (même calcul que taskEtpByRole), période (fte :
 * heures de 1 ETP, null sans période ; days : jours calendaires affichés, null sans dates).
 * @param {{rows:{teamId:number, heures:number}[]}} rows résultat de chargeRows
 * @returns {{hours:number, fte:number|null, days:number|null, byRole:object|null}}
 */
export function chargesSummary(model, rows, start, end) {
  const hours = Math.round(rows.reduce((s, r) => s + r.heures, 0) * 1e6) / 1e6;
  const fte = periodFte(start, end);
  const days = periodDayCount(start, end);
  const byRole = fte
    ? taskEtpByRole({ start, end, charges: rows.map((r) => ({ personId: r.teamId, heures: r.heures })) }, model)
    : null;
  return { hours, fte, days, byRole };
}
