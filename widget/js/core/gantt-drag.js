/**
 * Gantt : déplacer ou étirer une barre dans le temps. Fonctions pures, en jours entiers UTC : pas selon l'échelle,
 * décalage d'un jour, d'une semaine ou d'un mois, conversion d'un déplacement en pixels, bornes, droit de glisser,
 * rattachement du geste après un nouveau rendu.
 */
import { DAY_MS, formatDayShort } from './dates.js';
import { label } from '../labels.js';
import { chargeRefs, rescaleCharges } from './charges-rescale.js';
import { chargeMaxOf, entryHours, periodFte, readChargesCell } from './charges-edit.js';
import { isMilestone, isTaskLate, nodeBar } from './gantt-data.js';
import { editAvailability } from './task-form.js';

/** @typedef {'day'|'week'|'month'} Unit */

/**
 * Pas d'un déplacement : au jour (Semaine, ou Maj), à la semaine (Mois, Année), au mois (2 ans).
 * @param {'week'|'month'|'year'|'2y'} scale
 * @param {boolean} shift touche Maj tenue
 * @returns {Unit}
 */
export function snapUnit(scale, shift) {
  if (shift || scale === 'week') return 'day';
  return scale === '2y' ? 'month' : 'week';
}

/**
 * Jour décalé de n pas. Pour un mois, le jour du mois est gardé, ramené au dernier jour s'il n'existe pas.
 * @param {number} day
 * @param {Unit} unit
 * @param {number} n
 */
export function shiftDay(day, unit, n) {
  if (unit === 'day') return day + n;
  if (unit === 'week') return day + 7 * n;
  const date = new Date(day * DAY_MS);
  const target = date.getUTCFullYear() * 12 + date.getUTCMonth() + n;
  const year = Math.floor(target / 12);
  const month = target - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(date.getUTCDate(), last)) / DAY_MS;
}

/**
 * Période décalée de n pas, durée gardée.
 * @returns {{start:number, end:number}}
 */
export function movedDates(start, end, unit, n) {
  const s = shiftDay(start, unit, n);
  return { start: s, end: s + (end - start) };
}

/**
 * Nombre entier de pas le plus proche d'un déplacement en pixels.
 * @param {number} dx déplacement horizontal
 * @param {number} pxPerDay largeur d'un jour
 * @param {Unit} unit
 * @param {number} originDay jour de départ (pour les pas en mois)
 */
export function stepsFromPixels(dx, pxPerDay, unit, originDay) {
  if (!Number.isFinite(dx) || !Number.isFinite(pxPerDay) || pxPerDay <= 0) return 0;
  const days = dx / pxPerDay;
  const sign = Math.sign(days);
  if (unit === 'day') return sign * Math.round(Math.abs(days)) || 0;
  if (unit === 'week') return sign * Math.round(Math.abs(days) / 7) || 0;
  const aim = originDay + days;
  let n = sign * Math.round(Math.abs(days) / 30.4375);
  const dist = (k) => Math.abs(shiftDay(originDay, 'month', k) - aim);
  for (;;) {
    if (dist(n + 1) < dist(n)) n += 1;
    else if (dist(n - 1) < dist(n)) n -= 1;
    else return n || 0;
  }
}

/**
 * Plus grand décalage, du même signe et d'au plus |n| pas, qui garde la période dans [min, max].
 * @param {number} start
 * @param {number} end
 * @param {number} n
 * @param {Unit} unit
 * @param {{min?:number, max:number}} bounds max : voir maxPlanDay
 */
export function clampShift(start, end, n, unit, { min = 1, max }) {
  const sign = Math.sign(n);
  for (let k = Math.abs(n); k > 0; k -= 1) {
    const r = movedDates(start, end, unit, sign * k);
    if (r.start >= min && r.end <= max) return sign * k;
  }
  return 0;
}

/** Raisons de refus de dragTarget (chacune a son annonce du mode clavier, gantt.key.no.<raison>). */
export const DRAG_REASONS = Object.freeze([
  'list',
  'kind',
  'deduced',
  'nodates',
  'order',
  'virtual',
  'edit',
  'scope',
  'column',
]);
const refuse = (reason) => ({ ok: false, reason: DRAG_REASONS.includes(reason) ? reason : 'edit' });

/**
 * Une barre est-elle glissable ? Tâche, sous-tâche ou chantier avec ses deux dates propres, édition ouverte,
 * dans le périmètre, colonnes de dates permises par le writer.
 * @param {object} model
 * @param {object} node nœud de l'arbre (ou copie triée : seuls ses champs comptent)
 * @param {{edit:object, writer:{can(table:string, col:string):{ok:boolean}}|null, narrow:boolean}} ctx
 *   narrow : liste chronologique (petit écran), sans barres
 *   Un jalon à la seule échéance est glissable : cols = ['dateEcheance'] (voir periodOf).
 * @returns {{ok:true, table:'Tasks'|'Chantiers', id:number, cols:[string,string]|[string], milestone:boolean}
 *   |{ok:false, reason:'list'|'kind'|'deduced'|'nodates'|'order'|'virtual'|'edit'|'scope'|'column'}}
 */
export function dragTarget(model, node, { edit, writer, narrow }) {
  if (narrow) return refuse('list');
  const isTask = node.kind === 'tache' || node.kind === 'sous-tache';
  if (!isTask && node.kind !== 'chantier') return refuse('kind');
  if (!node.ref) return refuse('virtual');
  const hasStart = node.start !== null && node.start !== undefined;
  const hasEnd = node.end !== null && node.end !== undefined;
  // Jalon à la seule échéance : glissé sur l'échéance seule (début = fin = échéance)
  const endOnly = isTask && !hasStart && hasEnd && isMilestone(model, node);
  if ((!hasStart || !hasEnd) && !endOnly) return refuse(!hasStart && !hasEnd && nodeBar(node) ? 'deduced' : 'nodates');
  if (node.start > node.end) return refuse('order');
  const availability = editAvailability(model, node.ref, edit);
  if (!availability.editable) return refuse(availability.reason === 'scope' ? 'scope' : 'edit');
  const table = isTask ? 'Tasks' : 'Chantiers';
  const cols = endOnly ? ['dateEcheance'] : isTask ? ['dateDebut', 'dateEcheance'] : ['Debut', 'Fin'];
  if (!writer || !cols.every((c) => writer.can(table, c)?.ok)) return refuse('column');
  return { ok: true, table, id: node.ref.id, cols, milestone: isMilestone(model, node) };
}

/**
 * Période d'origine d'un glisser à partir des dates propres vues (seen) : un jalon à la seule échéance part de
 * début = fin = échéance.
 * @param {{start:number|null, end:number}} seen
 * @returns {{start:number, end:number}}
 */
export function periodOf(seen) {
  return { start: seen.start ?? seen.end, end: seen.end };
}

/**
 * Geste en cours après un nouveau rendu (relecture, période changée au bord) : ligne retrouvée par sa clé ; geste à
 * annuler si elle a disparu ou si ses dates propres ne sont plus celles du début du geste.
 * @param {{key:string, seen:{start:number, end:number}}} gesture
 * @param {{key:string, node:{start:number|null, end:number|null}}[]} rows lignes affichées (ganttRows)
 * @returns {{ok:true, index:number}|{ok:false, reason:'gone'|'changed'}}
 */
export function reattachDrag(gesture, rows) {
  const index = rows.findIndex((r) => r.key === gesture.key);
  if (index < 0) return { ok: false, reason: 'gone' };
  const { node } = rows[index];
  if (node.start !== gesture.seen.start || node.end !== gesture.seen.end) return { ok: false, reason: 'changed' };
  return { ok: true, index };
}

const sumHours = (raw) =>
  readChargesCell(raw).entries.reduce(
    (total, e) => total + (e !== null && typeof e === 'object' ? (entryHours(e) ?? 0) : 0),
    0,
  );

/**
 * Données d'un glisser qui ne dépendent que de l'élément et de sa période d'origine, calculées une fois au début
 * du geste : capacité de la période d'origine, cellule des charges et références, enfants, retard.
 * Les charges viennent des charges connues du modèle (le modèle ne garde pas le texte brut de la cellule : les
 * entrées inconnues ou invalides n'y figurent pas ; le writer les recopie telles quelles à l'envoi).
 * @param {object} model
 * @param {{table:'Tasks'|'Chantiers', id:number}} target voir dragTarget
 * @param {{start:number, end:number}} from période d'origine
 */
export function dragContext(model, target, from) {
  const task = target.table === 'Tasks' ? (model.tasks.get(target.id) ?? null) : null;
  const fromFte = periodFte(from.start, from.end);
  const raw = task?.charges.length
    ? JSON.stringify(task.charges.map((c) => ({ teamId: c.personId, heures: c.heures })))
    : null;
  const ids = task
    ? task.childIds
    : [...model.tasks.values()].filter((t) => t.chantierId === target.id && !t.parentId).map((t) => t.id);
  return {
    task,
    fromFte,
    raw,
    refs: raw && fromFte ? chargeRefs(raw, fromFte) : new Map(),
    fromHours: raw ? sumHours(raw) : 0,
    children: ids.map((id) => model.tasks.get(id)).filter(Boolean),
    last: null,
  };
}

/**
 * Heures de Tasks.charges avant et après le recalcul à ETP constant, ou null (pas de charges, capacité égale, ou
 * cellule inchangée : toutes les entrées laissées telles quelles).
 */
function hoursEffect(model, ctx, to) {
  const toFte = periodFte(to.start, to.end);
  if (!ctx.raw || !ctx.fromFte || !toFte || toFte === ctx.fromFte) return { hours: null, keptOver: [] };
  const bound = chargeMaxOf(model);
  const maxOf = (teamId) => bound(teamId, toFte);
  const r = rescaleCharges(ctx.raw, ctx.refs, toFte, { maxOf });
  // Cellule inchangée (toutes les entrées laissées telles quelles) : pas de ligne d'heures ; réécrite : la ligne,
  // même si le total ne bouge pas
  if (r.raw === ctx.raw) return { hours: null, keptOver: r.over };
  return { hours: { from: ctx.fromHours, to: sumHours(r.raw) }, keptOver: r.over };
}

/**
 * Effets d'un glisser sur la période d'une tâche ou d'un chantier, pour l'infobulle et les annonces.
 * Le contexte (dragContext) se crée une fois au début du geste ; on n'appelle dragSummary que lorsque la période
 * alignée `to` change (le dernier résultat est gardé : même `to`, même objet).
 * @param {object} model
 * @param {{table:'Tasks'|'Chantiers', id:number}} target voir dragTarget
 * @param {{start:number, end:number}} from période d'origine
 * @param {{start:number, end:number}} to nouvelle période
 * @param {number} today
 * @param {ReturnType<typeof dragContext>} [ctx]
 * @returns {{start:number, end:number, days:number, delta:number, hours:{from:number, to:number}|null,
 *   keptOver:number[], childrenOutside:number, childKind:'sous-tache'|'tache', lateCleared:boolean}}
 *   days : jours calendaires ; hours : null sans charges, si la capacité standard ne change pas ou si la cellule
 *   des charges reste la même (toutes les entrées laissées telles quelles) ; keptOver :
 *   personnes dont l'entrée dépasse la borne et reste telle quelle ; childrenOutside : enfants dont une date
 *   propre sort de `to` (même ceux qui en sortaient déjà)
 */
export function dragSummary(model, target, from, to, today, ctx = dragContext(model, target, from)) {
  const last = ctx.last;
  if (last && last.today === today && last.to.start === to.start && last.to.end === to.end) return last.summary;
  const { hours, keptOver } = hoursEffect(model, ctx, to);
  const summary = {
    start: to.start,
    end: to.end,
    days: to.end - to.start + 1,
    delta: to.start - from.start,
    hours,
    keptOver,
    childrenOutside: ctx.children.filter(
      (t) => (t.start !== null && t.start < to.start) || (t.end !== null && t.end > to.end),
    ).length,
    childKind: target.table === 'Tasks' ? 'sous-tache' : 'tache',
    lateCleared: Boolean(ctx.task && isTaskLate(ctx.task, today) && to.end >= today),
  };
  ctx.last = { to: { start: to.start, end: to.end }, today, summary };
  return summary;
}

const fr = (n) => String(n).replace('.', ',');
const plural = (key, n) => label(`${key}.${n === 1 ? 'one' : 'many'}`, { n });

/**
 * Lignes de l'infobulle d'un glisser. Les alertes portent « ⚠ » et un texte : jamais la couleur seule.
 * @param {ReturnType<typeof dragSummary>} s
 * @param {'move'|'start'|'end'} mode le décalage n'est affiché qu'en déplacement
 * @returns {string[]}
 */
export function summaryText(s, mode) {
  const lines = [
    label('gantt.drag.range', { debut: formatDayShort(s.start, s.end), fin: formatDayShort(s.end), n: s.days }),
  ];
  if (mode === 'move' && s.delta !== 0)
    lines.push(label('gantt.drag.delta', { signe: s.delta > 0 ? '+' : '−', n: Math.abs(s.delta) }));
  // Charges laissées telles quelles : l'ETP n'est conservé que pour les autres (alerte ⚠ à part)
  if (s.hours)
    lines.push(
      label(s.keptOver.length ? 'gantt.drag.hours.others' : 'gantt.drag.hours', {
        avant: fr(s.hours.from),
        apres: fr(s.hours.to),
      }),
    );
  if (s.keptOver.length) lines.push(plural('gantt.drag.keptOver', s.keptOver.length));
  if (s.childrenOutside)
    lines.push(plural(s.childKind === 'tache' ? 'gantt.drag.tasksOut' : 'gantt.drag.subtasksOut', s.childrenOutside));
  if (s.lateCleared) lines.push(label('gantt.drag.notLate'));
  return lines;
}

/**
 * Période d'un déplacement compté depuis la période de base : n pas de l'échelle puis d jours (pas relatifs aux
 * dates d'origine, Q1 : 31 janv. + 2 mois = 31 mars).
 */
function keyPeriod(base, unit, steps, days) {
  const start = shiftDay(base.start, unit, steps) + days;
  return { start, end: start + (base.end - base.start) };
}

/**
 * Modes du mode clavier d'une barre, dans l'ordre de Tab : un jalon se déplace seulement (pas de poignée).
 * @param {{milestone:boolean}} target voir dragTarget
 * @returns {('move'|'start'|'end')[]}
 */
export function keyEdges(target) {
  return target.milestone ? ['move'] : ['move', 'start', 'end'];
}

/**
 * Mode clavier « D » d'une ligne : ←/→ d'un pas de l'échelle (Maj : d'un jour), comptés depuis la période de base
 * (compteurs steps et days, Q1). En déplacement (move), la durée est gardée ; sur un bord (start, end), seul ce
 * bord bouge et s'arrête sur l'autre (un jour au moins : un pas de plus est refusé, minimum). Un pas qui passerait
 * la borne du 31/12 de l'année suivante est refusé (limit) sans toucher aux compteurs. Tab / Maj+Tab passent de
 * move à start puis end (keyEdges) : la période choisie devient la base, compteurs remis à zéro. Retour arrière
 * remet les dates vues ; Entrée enregistre, Échap annule. Pure.
 * @param {{target:object, seen:{start:number|null, end:number}, now:{start:number, end:number},
 *   edge:'move'|'start'|'end', unit:Unit, max:number, base?:{start:number, end:number}, steps?:number,
 *   days?:number, limit?:boolean, minimum?:boolean}} state
 *   unit : pas de l'échelle (snapUnit(scale, false)) ; max : voir maxPlanDay ; base : dates vues par défaut
 * @param {{key:string, shiftKey?:boolean}} e
 * @returns {{state:object, action:'none'|'save'|'cancel'|'announce'|'edge'}}
 */
export function keyMode(state, e) {
  if (e.key === 'Enter') return { state, action: 'save' };
  if (e.key === 'Escape') return { state, action: 'cancel' };
  const reset = { steps: 0, days: 0, limit: false, minimum: false };
  if (e.key === 'Backspace') {
    const seen = periodOf(state.seen);
    return { state: { ...state, ...reset, now: seen, base: seen }, action: 'announce' };
  }
  if (e.key === 'Tab') {
    const edges = keyEdges(state.target);
    if (edges.length < 2) return { state, action: 'none' };
    const i = Math.max(0, edges.indexOf(state.edge));
    const edge = edges[(i + (e.shiftKey ? edges.length - 1 : 1)) % edges.length];
    return { state: { ...state, ...reset, edge, base: state.now }, action: 'edge' };
  }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return { state, action: 'none' };
  const sign = e.key === 'ArrowRight' ? 1 : -1;
  const steps = (state.steps ?? 0) + (e.shiftKey ? 0 : sign);
  const days = (state.days ?? 0) + (e.shiftKey ? sign : 0);
  const base = state.base ?? periodOf(state.seen);
  const refused = (why) => ({
    state: { ...state, limit: why === 'limit', minimum: why === 'minimum' },
    action: 'announce',
  });
  if (state.edge === 'start' || state.edge === 'end') {
    const from = state.edge === 'start' ? base.start : base.end;
    const day = shiftDay(from, state.unit, steps) + days;
    // Seul un pas qui éloigne encore le bord hors des bornes est refusé (une date déjà au-delà se ramène)
    if (state.edge === 'end' ? day > state.max && day > state.now.end : day < 1 && day < state.now.start)
      return refused('limit');
    const now = resizedDates(base.start, base.end, state.edge, 'day', day - from, { max: state.max });
    if (now.start === state.now.start && now.end === state.now.end && day !== from) return refused('minimum');
    return { state: { ...state, now, steps, days, limit: false, minimum: false }, action: 'announce' };
  }
  const now = keyPeriod(base, state.unit, steps, days);
  if (now.start < 1 || now.end > state.max) return refused('limit');
  return { state: { ...state, now, steps, days, limit: false, minimum: false }, action: 'announce' };
}

/**
 * Période dont seul le bord saisi bouge de n pas, comptés depuis la date d'origine de ce bord (Q1). Le bord
 * s'arrête sur l'autre (durée minimale d'un jour) et sur les bornes : jour 1 et max (voir maxPlanDay) ; un bord
 * déjà au-delà se ramène vers elles sans y être tiré.
 * @param {number} start
 * @param {number} end
 * @param {'start'|'end'} edge
 * @param {Unit} unit
 * @param {number} n
 * @param {{max:number}} bounds
 * @returns {{start:number, end:number}}
 */
export function resizedDates(start, end, edge, unit, n, { max }) {
  if (n === 0) return { start, end };
  // Bord déjà hors des bornes : il se ramène, ne s'éloigne pas davantage, n'est jamais tiré jusqu'à la borne
  if (edge === 'start') return { start: Math.max(Math.min(1, start), Math.min(shiftDay(start, unit, n), end)), end };
  return { start, end: Math.min(Math.max(max, end), Math.max(shiftDay(end, unit, n), start)) };
}

/** Largeur minimale d'une barre qui porte des poignées, en pixels. */
const HANDLE_MIN_WIDTH = 20;

/**
 * Côtés où une barre porte une poignée d'étirement. Aucune pour un jalon, une barre déduite ou de moins de 20 px ;
 * pas de poignée du côté coupé par la frise ; au doigt, seulement quand la barre est sélectionnée par un appui long
 * (touchSelected à false : au doigt, non sélectionnée ; à la souris, true ou absent).
 * @param {{milestone:boolean, deduced:boolean, widthPx:number, clipStart:boolean, clipEnd:boolean,
 *   touchSelected?:boolean}} bar
 * @returns {{start:boolean, end:boolean}}
 */
export function handleSides({ milestone, deduced, widthPx, clipStart, clipEnd, touchSelected = true }) {
  if (milestone || deduced || !touchSelected || !(widthPx >= HANDLE_MIN_WIDTH)) return { start: false, end: false };
  return { start: !clipStart, end: !clipEnd };
}

/** Zone de saisie d'une poignée au doigt, en pixels, à l'intérieur de la barre. */
const TOUCH_GRIP = 24;

/**
 * Bord saisi par un appui en x sur une barre : poignée de début ou d'échéance si x tombe dans sa zone (24 px au
 * doigt, au plus un tiers de la barre : le milieu reste au déplacement), sinon déplacement.
 * @param {number} x
 * @param {{left:number, right:number}} box rectangle de la barre (lu une fois, au début du geste)
 * @param {{start:boolean, end:boolean}} sides voir handleSides
 * @param {number} [zone]
 * @returns {'move'|'start'|'end'}
 */
export function gripAt(x, box, sides, zone = TOUCH_GRIP) {
  const reach = Math.min(zone, (box.right - box.left) / 3);
  if (sides.start && x - box.left <= reach) return 'start';
  if (sides.end && box.right - x <= reach) return 'end';
  return 'move';
}
