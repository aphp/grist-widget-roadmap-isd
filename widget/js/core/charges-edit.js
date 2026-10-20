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
 * Conversion (1 ETP = 35 h par semaine pour tous, jours calendaires de dateDebut à dateEcheance) :
 * h = ETP × 35 × jours / 7 ; ETP = h × 7 / (35 × jours).
 */
import { etpToHours, hoursToEtp } from './capacity.js';
import { taskEtpByRole } from './kanban-data.js';
import { EncodeError, parseNumberFr } from './write-encode.js';

/** Pas de stockage des heures. */
export const HOURS_STEP = 0.5;
/** Plus petite charge non nulle acceptée en saisie (en dessous, l'arrondi donnerait 0 h sans le dire). */
export const MIN_HOURS = 0.25;
/** Au plus 1 ETP par personne sur une tâche (décision utilisateur) : 35 h × jours / 7 sur la période. */
export const MAX_ETP = 1;
/** Sans période connue, borne de bon sens : 2 000 h par personne et par tâche. */
export const MAX_HOURS = 2000;

/** Heures arrondies à 0,5 h près. */
export const roundHours = (h) => Math.round(h / HOURS_STEP) * HOURS_STEP;

/** Nombre de jours calendaires de la période, ou null sans dates exploitables. */
export function periodDays(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
  return end - start + 1;
}

/** Heures maximales d'une personne : 1 ETP sur la période (5 h par jour calendaire) ; 2 000 h sans dates. */
export function maxHours(days) {
  return days ? roundHours(etpToHours(MAX_ETP, days)) : MAX_HOURS;
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
 * existant dans Team et des heures finies, ≥ 0, au pas de 0,5 h et d'au plus 1 ETP sur la période (maxHours).
 * Les entrées recopiées octet par octet (même invalides, même au-dessus de la borne) sont admises.
 * @param {string} value cellule à écrire
 * @param {string|null|undefined} before cellule d'avant (relue)
 * @param {(id:number) => boolean} teamExists
 * @param {number|null} [days] jours calendaires de la période de la tâche (après la modification)
 * @returns {string|null} raison du refus, ou null
 */
export function chargesWriteProblem(value, before, teamExists, days = null) {
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
    if (e.heures > maxHours(days)) return `heures : au plus ${maxHours(days)} h (1 ETP sur la période)`;
  }
  return null;
}

/** Valeur affichée dans la case de saisie, à une décimale (ETP au pas de 0,1 ; heures). */
export function inputValue(heures, unit, days) {
  if (unit === 'heures') return Math.round(heures * 10) / 10;
  return days ? Math.round(hoursToEtp(heures, days) * 10) / 10 : null;
}

/**
 * Saisie d'une ligne → heures à stocker (arrondies à 0,5 h).
 * @param {string} text valeur saisie (« 1,5 »)
 * @param {'etp'|'heures'} unit
 * @param {number|null} days jours calendaires de la période
 * @param {number|null} [current] heures actuelles de la ligne : une saisie égale à la valeur affichée les
 *   conserve telles quelles (pas d'arrondi ni de dérive)
 * @returns {{heures:number}|{error:'nombre'|'negatif'|'dates'|'vide'|'decimale'|'petit'|'max', max?:number}}
 */
export function hoursFromInput(text, unit, days, current = null) {
  let n;
  try {
    n = parseNumberFr(text);
  } catch (err) {
    if (err instanceof EncodeError) return { error: 'nombre' };
    throw err;
  }
  if (n === null) return { error: 'vide' };
  if (n < 0) return { error: 'negatif' };
  if (unit !== 'heures' && !days) return { error: 'dates' };
  if (current !== null && n === inputValue(current, unit, days)) return { heures: current };
  if (unit !== 'heures' && Math.abs(n * 10 - Math.round(n * 10)) > 1e-9) return { error: 'decimale' };
  const exact = unit === 'heures' ? n : etpToHours(n, days);
  if (n > 0 && exact < MIN_HOURS) return { error: 'petit' };
  const max = maxHours(days);
  if (exact > max + 1e-9) return { error: 'max', max };
  return { heures: roundHours(exact) };
}

/** ETP équivalent (null sans période). */
export const etpOf = (heures, days) => (days ? hoursToEtp(heures, days) : null);

/**
 * Écart d'ETP quand les dates changent (Q8 A : les heures, valeur stockée, sont conservées).
 * @returns {{from:number, to:number}|null} null si les périodes sont égales ou l'une manque
 */
export function etpDelta(heures, oldDays, newDays) {
  if (!oldDays || !newDays || oldDays === newDays) return null;
  return { from: hoursToEtp(heures, oldDays), to: hoursToEtp(heures, newDays) };
}

/**
 * Pied de la section : total en heures, ETP total et par profil (même calcul que taskEtpByRole), période.
 * @param {{rows:{teamId:number, heures:number}[]}} rows résultat de chargeRows
 * @returns {{hours:number, days:number|null, byRole:object|null}}
 */
export function chargesSummary(model, rows, start, end) {
  const hours = Math.round(rows.reduce((s, r) => s + r.heures, 0) * 1e6) / 1e6;
  const days = periodDays(start, end);
  const byRole = days
    ? taskEtpByRole({ start, end, charges: rows.map((r) => ({ personId: r.teamId, heures: r.heures })) }, model)
    : null;
  return { hours, days, byRole };
}
