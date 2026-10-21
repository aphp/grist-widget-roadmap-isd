/**
 * Vue Gantt (lecture seule) : arbre catégorie → projet → chantier → tâche → sous-tâche, une ligne par élément,
 * barres positionnées en % de la fenêtre (un seul passage innerHTML, écouteurs délégués), export PDF.
 * Mode « Chantier » : teintes calculées une fois par rendu (chantierSlots) ; chaque ligne d'un chantier porte
 * seulement la classe de sa teinte (gch-1 à gch-7), le CSS fait le reste (pastille, trait, bande, barres).
 */
import { raw } from '../core/sanitize.js';
import { formatDateFr, maxPlanDay } from '../core/dates.js';
import {
  clampShift,
  dragContext,
  dragSummary,
  gripAt,
  handleSides,
  keyEdges,
  keyMode,
  movedDates,
  periodOf,
  reattachDrag,
  resizedDates,
  snapUnit,
  stepsFromPixels,
  summaryText,
} from '../core/gantt-drag.js';
import {
  COLOR_BY,
  DEFAULT_LEVEL,
  GANTT_LEVELS,
  PHASES,
  SCALES,
  STATUS_COLORS,
  LABEL_WIDTH,
  barGeometry,
  chantierSlots,
  chantierTone,
  chronoItems,
  clampLabelWidth,
  colorKey,
  defaultLabelWidth,
  expandableKeys,
  fadedOnWhite,
  ganttRows,
  levelExpanded,
  isEmptyContainer,
  isLate,
  isMilestone,
  labelWidthAfterKey,
  labelWidthMax,
  nodeBar,
  pctOf,
  pdfFilenameOfDay,
  phaseOf,
  prunedExpanded,
  shiftAnchor,
  sortTreeByDate,
  timeScale,
  todayAnchor,
} from '../core/gantt-data.js';
import { h, icon, keepFocus, statusBadge } from '../ui/kit.js';
import { viewHeading } from '../ui/heading.js';
import { label, statusLabel } from '../labels.js';
import { VIZ_PRINT } from '../ui/viz-palette.js';
import { trackPointer } from '../ui/drag.js';
import { closeStatusPopover, isStatusPopoverOpen, openStatusPopover } from '../ui/status-popover.js';
import { isStatusShortcut } from '../core/quick-status.js';

export const id = 'gantt';

/** Hauteur d'une ligne (px) : identique au CSS (--gantt-row), sert à couper les pages du PDF entre deux lignes. */
const ROW_PX = 32;
/** Largeur minimale de la frise par échelle (px). */
const TIMELINE_MIN = Object.freeze({ week: 960, month: 900, year: 960, '2y': 880 });
const LEAF_KINDS = new Set(['chantier', 'tache', 'sous-tache']);
/** Sous cette largeur, le Gantt devient une liste chronologique (spec §10). */
const NARROW = '(max-width: 767.98px)';
/** Nombre maximal d'éléments de la liste chronologique. */
const LIST_MAX = 300;
/** Largeur maximale de l'infobulle (px, identique au CSS) et place qu'on lui réserve sous la barre. */
const TIP_MAX = 360;
const TIP_ROOM = 140;
/** Marge verticale (px) autour de la frise de la ligne où un dépôt compte encore. */
const DROP_SLACK = ROW_PX / 2;
/** Délai de regroupement des annonces (ms). */
const LIVE_DELAY = 300;
/** Délai entre la région vidée et le même texte reposé (ms). */
const REPEAT_DELAY = 60;
/**
 * État conservé entre deux rendus de la vue (rechargement des données) : période affichée, génération, poignée de
 * largeur (drag, applyWidth), glisser d'une barre (gesture, saving), barre choisie au doigt par un appui long
 * (touchSel, sa clé : poignées actives) et fonctions du dernier rendu (dragView).
 * gesture : { key, target, seen, now, edge, unit, startX, pxPerDay, anchor, … } (edge : 'move', 'start' ou 'end',
 * bord saisi) ; saving : { key, now } (barre dessinée à `now`, aria-busy, jusqu'à la réponse de l'enregistrement).
 */
const memory = {
  anchor: null,
  scale: null,
  generation: 0,
  drag: null,
  applyWidth: null,
  gesture: null,
  saving: null,
  dragView: null,
  liveTimer: null,
  notice: null,
  touchSel: null,
};
/** Durée pendant laquelle le message d'un geste annulé survit aux nouveaux rendus (ms). */
const NOTICE_MS = 5000;
/** Message d'un geste annulé, gardé en mémoire pour les rendus qui suivent. */
function dragNotice(text) {
  memory.notice = { text, until: Date.now() + NOTICE_MS };
  return text;
}
/** Écouteurs focusin / focusout par conteneur, pour ne jamais les empiler. */
const listeners = new WeakMap();

const pct = (x) => `${Math.round(x * 1000) / 1000}%`;

function colorName(key, colorBy) {
  if (colorBy === 'status') return key === 'other' ? label('gantt.status.other') : statusLabel(key);
  return label(`gantt.phase.${key}`);
}

/** Classe de couleur : un statut hors des quatre connus est dessiné creux (distinct de « À faire »). */
const fillOf = (ck, colorBy) => (colorBy === 'status' && ck === 'other' ? 'hollow' : ck);
/** Opacité d'une barre terminée en mode « chantier » (identique au CSS, sert à la légende du PDF). */
const DONE_OPACITY = 0.45;
/** Classe de la teinte d'un chantier (variables --ch, --ch-deep, --ch-band du CSS). */
const toneClass = (tone) => `gch-${tone.slot + 1}`;
/** Pastille d'un chantier (décorative : son nom est écrit à côté). */
const chipHtml = (tone) => h`<span class="grow__chip ${toneClass(tone)}" aria-hidden="true"></span>`;

/** Barre affichée d'une ligne : à sa nouvelle place pendant l'enregistrement d'un glisser (memory.saving). */
function shownBar(r) {
  const now = memory.saving?.key === r.key ? memory.saving.now : null;
  return now ? { start: now.start, end: now.end, deduced: false, saving: true } : nodeBar(r.node);
}

function datesText(bar) {
  if (!bar) return label('gantt.noDates');
  const d =
    bar.start === bar.end
      ? label('gantt.date', { date: formatDateFr(bar.start) })
      : label('gantt.dates', { debut: formatDateFr(bar.start), fin: formatDateFr(bar.end) });
  return bar.deduced ? `${label('gantt.deduced')} : ${d.charAt(0).toLowerCase()}${d.slice(1)}` : d;
}

/**
 * Description complète d'une ligne (infobulle et nom accessible des barres). En mode « chantier », l'étape
 * reste dite et le chantier d'une tâche est nommé (la couleur n'est jamais seule).
 */
function describe(ctx, r, colorBy, tone = null) {
  const n = r.node;
  const bar = shownBar(r);
  const parts = [`${label(`gantt.kind.${n.kind}`)} : ${n.title || label('common.untitled')}`, datesText(bar)];
  if (bar?.saving) parts.push(label('gantt.drag.saving'));
  if (n.status) parts.push(label('gantt.status', { statut: statusLabel(n.status) }));
  if (LEAF_KINDS.has(n.kind) && colorBy !== 'status')
    parts.push(label('gantt.phase', { etape: colorName(phaseOf(n.title) ?? 'other', 'phase') }));
  if (tone && n.kind !== 'chantier') parts.push(label('gantt.chantier', { titre: tone.title }));
  if (isEmptyContainer(n)) parts.push(label('gantt.noTasks'));
  if (isMilestone(ctx.model, n)) parts.push(label('gantt.milestone'));
  if (isLate(ctx.model, n, ctx.today)) parts.push(label('gantt.late'));
  return parts.join('. ');
}

/** Lignes « Étape » et « Chantier » de l'infobulle en mode « chantier » (pastille du chantier). */
function chantierTipHtml(n, tone) {
  return h`${LEAF_KINDS.has(n.kind) ? h`<span class="gtip__line">${label('gantt.phase', { etape: colorName(phaseOf(n.title) ?? 'other', 'phase') })}</span>` : ''}
    ${tone && n.kind !== 'chantier' ? h`<span class="gtip__line">${chipHtml(tone)}${label('gantt.chantier', { titre: tone.title })}</span>` : ''}`;
}

function tipHtml(ctx, r, colorBy, slots) {
  const n = r.node;
  const bar = shownBar(r);
  const late = isLate(ctx.model, n, ctx.today);
  const ms = isMilestone(ctx.model, n);
  const ck = colorKey(n, colorBy);
  const byChantier = colorBy === 'chantier';
  const showColor = LEAF_KINDS.has(n.kind) && !byChantier;
  return h`<span class="gtip__kind">${label(`gantt.kind.${n.kind}`)}</span>
    <strong class="gtip__title">${n.title || label('common.untitled')}</strong>
    <span class="gtip__line">${datesText(bar)}</span>
    ${bar?.saving ? h`<span class="gtip__line">${label('gantt.drag.saving')}</span>` : ''}
    ${n.status || late || ms ? h`<span class="gtip__badges">${n.status ? statusBadge(n.status) : ''}${ms ? h`<span class="fr-badge fr-badge--sm fr-badge--no-icon fr-badge--purple-glycine">${label('gantt.milestone')}</span>` : ''}${late ? h`<span class="fr-badge fr-badge--sm fr-badge--error">${label('gantt.late')}</span>` : ''}</span>` : ''}
    ${showColor ? h`<span class="gtip__line"><span class="gswatch gswatch--${fillOf(ck, colorBy)}" aria-hidden="true"></span>${colorBy === 'phase' ? label('gantt.phase', { etape: colorName(ck, colorBy) }) : label('gantt.status', { statut: colorName(ck, colorBy) })}</span>` : ''}
    ${byChantier ? chantierTipHtml(n, chantierTone(ctx.model, n, slots)) : ''}`;
}

/**
 * Classe de couleur d'une barre : en mode « chantier », le chantier a une barre de synthèse (teinte foncée de
 * sa teinte), ses tâches la teinte du chantier (gbar--ch) ; hors chantier, couleur neutre.
 */
function barKind(n, colorBy, tone) {
  if (colorBy === 'chantier')
    return n.kind === 'tache' || n.kind === 'sous-tache' ? (tone ? 'ch' : 'other') : 'summary';
  return LEAF_KINDS.has(n.kind) ? fillOf(colorKey(n, colorBy), colorBy) : 'summary';
}

/** Poignées d'étirement d'une barre glissable (décoratives : le clavier passe par Tab dans le mode « D »). */
const gripsHtml = (sides) =>
  raw(
    (sides.start ? '<span class="gbar__grip gbar__grip--start" data-grip="start" aria-hidden="true"></span>' : '') +
      (sides.end ? '<span class="gbar__grip gbar__grip--end" data-grip="end" aria-hidden="true"></span>' : ''),
  );

/**
 * Frise d'une ligne. drag : droit de glisser ({target: dragTarget, canAdd()}, null en lecture seule, mémorisé par
 * rendu) ; une barre glissable porte seulement une classe et data-drag, et ses poignées si elle est assez large
 * (trackPx : largeur estimée de la frise, sans lecture de la page). Ligne en cours d'enregistrement : barre à sa
 * nouvelle place, aria-busy.
 */
function trackHtml(ctx, r, i, scale, colorBy, tone, drag, trackPx) {
  const info = drag?.target ?? null;
  const n = r.node;
  const bar = shownBar(r);
  const saving = Boolean(bar?.saving);
  if (!bar)
    return info?.reason === 'nodates' && drag.canAdd()
      ? h`<button type="button" class="grow__nodates grow__adddates" data-add-dates="${i}" tabindex="-1">${label('gantt.noDates.add')}</button>`
      : h`<span class="grow__nodates">${label('gantt.noDates')}</span>`;
  const desc = describe(ctx, r, colorBy, tone);
  const ms = isMilestone(ctx.model, n);
  const g = ms ? barGeometry(scale, bar.end, bar.end) : barGeometry(scale, bar.start, bar.end);
  if (g.outside) {
    const date = formatDateFr(g.outside === 'before' ? bar.end : bar.start);
    const text = label(g.outside === 'before' ? 'gantt.before' : 'gantt.after', { date });
    return h`<button type="button" class="gout gout--${g.outside}" data-i="${i}" tabindex="-1" aria-label="${desc}. ${text}">${icon(g.outside === 'before' ? 'arrow-left-s-line' : 'arrow-right-s-line')}<span class="gout__text">${date}</span></button>`;
  }
  const late = isLate(ctx.model, n, ctx.today);
  const ck = barKind(n, colorBy, tone);
  // Tâche terminée : barre délavée en mode « chantier » (le statut n'y a pas de couleur)
  const done = colorBy === 'chantier' && n.status === 'done' ? ' is-done' : '';
  const grab = info?.ok && !saving;
  const state = saving ? raw(' aria-busy="true"') : grab ? raw(` data-drag="${i}"`) : '';
  if (ms)
    return h`<button type="button" class="gms gms--${ck}${late ? ' is-late' : ''}${done}${grab ? ' gms--draggable' : ''}${saving ? ' is-saving' : ''}" style="left:${pct(g.left + g.width / 2)}" data-i="${i}" tabindex="-1"${state} aria-label="${desc}"></button>`;
  const cls = [
    'gbar',
    `gbar--${ck}`,
    ck === 'summary' ? 'gbar--summary' : '',
    bar.deduced ? 'gbar--deduced' : '',
    late ? 'is-late' : '',
    done.trim(),
    g.clipStart ? 'gbar--clip-start' : '',
    g.clipEnd ? 'gbar--clip-end' : '',
    grab ? 'gbar--draggable' : '',
    saving ? 'is-saving' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const text = LEAF_KINDS.has(n.kind) ? barText(n, colorBy) : '';
  // Nœuds des poignées pour la souris, le stylet et le clavier ; au doigt, actives seulement sur la barre choisie
  // par un appui long (is-touch-selected, voir startBarDrag)
  const sides = grab
    ? handleSides({
        milestone: false,
        deduced: bar.deduced,
        widthPx: (g.width / 100) * trackPx,
        clipStart: g.clipStart,
        clipEnd: g.clipEnd,
        touchSelected: true,
      })
    : null;
  const grips = sides ? gripsHtml(sides) : '';
  const picked = grab && memory.touchSel === r.key ? ' is-touch-selected' : '';
  return h`<button type="button" class="${cls}${picked}" style="left:${pct(g.left)};width:${pct(g.width)}" data-i="${i}" tabindex="-1"${state} aria-label="${desc}">${text ? h`<span class="gbar__text" aria-hidden="true">${text}</span>` : ''}${grips}</button>`;
}

/**
 * Tâche ou chantier sans ses deux dates : « Ajouter des dates » seulement si la ligne serait glissable avec des
 * dates (édition, périmètre, colonnes), même contrôle que dragTarget sur une période fictive.
 */
const canAddDates = (ctx, n) => Boolean(ctx.dates?.target({ ...n, start: 0, end: 0, span: null })?.ok);

/**
 * Droit de glisser de chaque ligne pour un rendu : ctx.dates.target appelé une fois par ligne (et « Ajouter des
 * dates » seulement pour une ligne sans barre), table construite au fil du rendu.
 * @returns {(r:object) => {target:object, canAdd():boolean}|null}
 */
function dragRights(ctx) {
  if (!ctx.dates) return () => null;
  const seen = new Map();
  return (r) => {
    const n = r.node;
    if (!n.ref || !LEAF_KINDS.has(n.kind)) return null;
    let v = seen.get(r.key);
    if (!v) {
      let add = null;
      v = { target: ctx.dates.target(n), canAdd: () => (add ??= canAddDates(ctx, n)) };
      seen.set(r.key, v);
    }
    return v;
  };
}

/**
 * Nom écrit dans la barre (masqué par le CSS si la barre est trop étroite) : étape connue, ou statut ; rien en
 * mode « chantier » (l'étape reste dans l'infobulle et le nom accessible).
 */
function barText(n, colorBy) {
  if (colorBy === 'chantier') return '';
  if (colorBy === 'status') return n.status ? statusLabel(n.status) : '';
  const phase = phaseOf(n.title);
  return phase ? colorName(phase, 'phase') : '';
}

/**
 * Ligne de l'arbre (role="row" d'un treegrid) : la ligne elle-même porte le focus (un seul arrêt de tabulation
 * pour tout l'arbre, focus itinérant), son niveau, sa position dans la fratrie et son état déplié.
 * Flèche et titre restent cliquables à la souris ; au clavier : ←/→, ↑/↓, Début/Fin, Entrée.
 */
function rowHtml(ctx, r, i, scale, colorBy, focusIndex, slots, dragOf, trackPx) {
  const n = r.node;
  const tone = slots ? chantierTone(ctx.model, n, slots) : null;
  const title = n.title || label('common.untitled');
  const toggle = r.hasChildren
    ? h`<span class="grow__toggle fr-icon-arrow-${r.expanded ? 'down' : 'right'}-s-line" data-toggle="${i}" data-expanded="${r.expanded}" title="${label(r.expanded ? 'gantt.collapse' : 'gantt.expand', { titre: title })}" aria-hidden="true"></span>`
    : h`<span class="grow__toggle grow__toggle--leaf" aria-hidden="true"></span>`;
  const name = n.ref
    ? h`<span class="grow__title" data-open="${i}" data-i="${i}" title="${title}">${title}</span>`
    : h`<span class="grow__title grow__title--static" data-i="${i}" title="${title}">${title}</span>`;
  const empty = isEmptyContainer(n) ? h`<span class="grow__empty">${label('gantt.noTasks')}</span>` : '';
  const chip = tone && n.kind === 'chantier' ? chipHtml(tone) : '';
  const cls = tone ? ` grow--ch ${toneClass(tone)}` : '';
  const drag = dragOf(r);
  const keys = drag?.target.ok ? raw(' aria-keyshortcuts="D"') : '';
  return h`<div class="grow grow--${n.kind}${cls}" role="row" id="gr-${r.key}" data-i="${i}" data-row="${i}" tabindex="${i === focusIndex ? 0 : -1}"${keys} aria-level="${r.depth + 1}" aria-posinset="${r.posinset}" aria-setsize="${r.setsize}" ${raw(r.hasChildren ? `aria-expanded="${r.expanded}"` : '')} aria-label="${describe(ctx, r, colorBy, tone)}">
    <div class="grow__label" role="gridcell" style="--depth:${r.depth}">${toggle}${chip}${name}${empty}</div>
    <div class="grow__track" role="gridcell">${trackHtml(ctx, r, i, scale, colorBy, tone, drag, trackPx)}</div>
  </div>`;
}

/**
 * Liste chronologique (petits écrans) : titre, chemin, dates, étape ou statut, barre mini dans la fenêtre ;
 * en mode « chantier », pastille du chantier devant le chemin et barre de sa teinte.
 */
function listHtml(ctx, items, colorBy, slots) {
  if (!items.length) return h`<p class="glist__empty">${label('gantt.list.none')}</p>`;
  return h`<ol class="list glist" aria-label="${label('gantt.list.label')}">
    ${items.slice(0, LIST_MAX).map((it) => {
      const n = it.node;
      const title = n.title || label('common.untitled');
      const tone = slots ? chantierTone(ctx.model, n, slots) : null;
      const ck = barKind(n, colorBy, tone);
      const late = isLate(ctx.model, n, ctx.today);
      const ms = isMilestone(ctx.model, n);
      const g = it.geometry;
      const step = barText(n, colorBy);
      return h`<li class="glist__item${late ? ' glist__item--late' : ''}${tone ? ` ${toneClass(tone)}` : ''}">
        ${n.ref ? h`<button type="button" class="glist__title" data-open-key="${it.key}">${title}</button>` : h`<span class="glist__title">${title}</span>`}
        ${it.path.length ? h`<span class="glist__path">${tone ? chipHtml(tone) : ''}${it.path.join(' › ')}</span>` : ''}
        <span class="glist__meta"><span>${datesText(it.bar)}</span>${step ? h`<span>${step}</span>` : ''}${ms ? h`<span class="fr-badge fr-badge--sm fr-badge--no-icon fr-badge--purple-glycine">${label('gantt.milestone')}</span>` : ''}${late ? h`<span class="fr-badge fr-badge--sm fr-badge--error">${label('gantt.late')}</span>` : ''}</span>
        <span class="glist__track" aria-hidden="true"><span class="glist__bar gbar--${ck}${it.bar.deduced ? ' glist__bar--deduced' : ''}${colorBy === 'chantier' && n.status === 'done' ? ' is-done' : ''}" style="left:${pct(g.left)};width:${pct(g.width)}"></span></span>
      </li>`;
    })}
  </ol>
  ${items.length > LIST_MAX ? h`<p class="glist__more">${label('gantt.list.more', { n: (items.length - LIST_MAX).toLocaleString('fr-FR') })}</p>` : ''}`;
}

/** Légende du mode « chantier » : pastilles, barre du chantier, terminé, puis les marques communes. */
function chantierLegendHtml() {
  return h`<ul class="list gantt__legend" aria-label="${label('gantt.legend')}">
    <li><span class="gswatch gswatch--chips" aria-hidden="true">${[0, 1, 2].map((slot) => chipHtml({ slot }))}</span>${label('gantt.legend.chantier')}</li>
    <li><span class="gswatch gswatch--chbar gch-1" aria-hidden="true"></span>${label('gantt.legend.chantierBar')}</li>
    <li><span class="gswatch gswatch--chdone gch-1" aria-hidden="true"></span>${label('gantt.legend.done')}</li>
    ${commonLegendHtml()}
  </ul>`;
}

/** Marques communes à toutes les légendes : déduite, jalon, retard, aujourd'hui. */
function commonLegendHtml() {
  return h`<li title="${label('gantt.deduced.help')}"><span class="gswatch gswatch--deduced" aria-hidden="true"></span>${label('gantt.deduced')}</li>
    <li><span class="gswatch gswatch--milestone" aria-hidden="true"></span>${label('gantt.milestone')}</li>
    <li><span class="gswatch gswatch--late" aria-hidden="true"></span>${label('gantt.late')}</li>
    <li><span class="gswatch gswatch--today" aria-hidden="true"></span>${label('gantt.todayLine')}</li>`;
}

function legendHtml(colorBy) {
  if (colorBy === 'chantier') return chantierLegendHtml();
  const keys = colorBy === 'phase' ? [...PHASES, 'other'] : [...STATUS_COLORS, 'other'];
  return h`<ul class="list gantt__legend" aria-label="${label('gantt.legend')}">
    ${keys.map((k) => h`<li><span class="gswatch gswatch--${fillOf(k, colorBy)}" aria-hidden="true"></span>${colorName(k, colorBy)}</li>`)}
    ${commonLegendHtml()}
  </ul>`;
}

/** Couleur imprimée (thème clair) de chaque clé de couleur. */
const PRINT_OF = Object.freeze({
  instruction: VIZ_PRINT[1],
  inprogress: VIZ_PRINT[1],
  realisation: VIZ_PRINT[2],
  review: VIZ_PRINT[2],
  mep: VIZ_PRINT[3],
  done: VIZ_PRINT[3],
  todo: VIZ_PRINT.neutral,
  other: VIZ_PRINT.neutral,
});

function pdfLegend(colorBy) {
  const keys = colorBy === 'phase' ? [...PHASES, 'other'] : [...STATUS_COLORS, 'other'];
  const [fill] = VIZ_PRINT.chantier;
  const colors =
    colorBy === 'chantier'
      ? [
          { label: label('gantt.legend.chantier'), color: fill, mark: 'box' },
          { label: label('gantt.legend.chantierBar'), color: VIZ_PRINT.chantierDeep[0], mark: 'box' },
          { label: label('gantt.legend.done'), color: fill, mark: 'light', light: fadedOnWhite(fill, DONE_OPACITY) },
        ]
      : keys.map((k) => ({
          label: colorName(k, colorBy),
          color: PRINT_OF[k],
          mark: fillOf(k, colorBy) === 'hollow' ? 'outline' : 'box',
        }));
  return [
    ...colors,
    { label: label('gantt.deduced'), color: VIZ_PRINT.summary, mark: 'light' },
    { label: label('gantt.milestone'), color: VIZ_PRINT.summary, mark: 'diamond' },
    { label: label('gantt.late'), color: VIZ_PRINT.late, mark: 'outline' },
    { label: label('gantt.todayLine'), color: VIZ_PRINT.today, mark: 'line' },
  ];
}

/** Texte de valeur de la poignée de largeur. */
const widthText = (w) => label('gantt.width.value', { n: w });

/** Poignée de la colonne des noms (séparateur focalisable : flèches, Maj, Début / Fin ; double-clic : défaut). */
function resizerHtml(width) {
  return h`<div class="gantt__resizer" id="gantt-resizer" role="separator" aria-orientation="vertical" tabindex="0" aria-label="${label('gantt.resizer')}" aria-describedby="gantt-resizer-help" aria-valuemin="${width.min}" aria-valuemax="${width.max}" aria-valuenow="${width.value}" aria-valuetext="${widthText(width.value)}" title="${label('gantt.resizer.title')}" data-resizer></div>`;
}

function headHtml(scale, today, width) {
  const showToday = today >= scale.start && today <= scale.end;
  return h`<div class="gantt__head" role="row">
    <div class="gantt__corner" role="columnheader" aria-labelledby="gantt-corner-label"><span id="gantt-corner-label">${label('gantt.element')}</span>${resizerHtml(width)}<span class="fr-sr-only" id="gantt-resizer-help">${label('gantt.resizer.help')}</span></div>
    <div class="gantt__scale" role="columnheader" aria-label="${label('gantt.period', { debut: formatDateFr(scale.start), fin: formatDateFr(scale.end) })}">
      <div class="gantt__groups">${scale.groups.map((g) => h`<span class="gantt__group" style="left:${pct(pctOf(scale, g.start))};width:${pct(((g.end - g.start + 1) / scale.days) * 100)}">${g.label}</span>`)}</div>
      <div class="gantt__cols">${scale.columns.map((c) => h`<span class="gantt__col${today >= c.start && today <= c.end ? ' is-current' : ''}" style="left:${pct(pctOf(scale, c.start))};width:${pct(((c.end - c.start + 1) / scale.days) * 100)}" title="${c.title}">${c.label}</span>`)}</div>
      ${showToday ? h`<span class="gantt__today-flag" style="left:${pct(pctOf(scale, today) + 50 / scale.days)}" aria-hidden="true"></span>` : ''}
    </div>
  </div>`;
}

function linesHtml(scale, today) {
  const showToday = today >= scale.start && today <= scale.end;
  return h`<div class="gantt__lines" aria-hidden="true">
    ${scale.columns.slice(1).map((c) => h`<span class="gantt__line" style="left:${pct(pctOf(scale, c.start))}"></span>`)}
    ${showToday ? h`<span class="gantt__today" style="left:${pct(pctOf(scale, today) + 50 / scale.days)}"></span>` : ''}
  </div>`;
}

/**
 * @param {HTMLElement} el
 * @param {object} ctx contexte fourni par main.js
 */
export function render(el, ctx) {
  const gen = ++memory.generation;
  const saved = ctx.prefs ?? {};
  // Arbre affiché : toujours trié par date, une fois par rendu (copies : l'arbre du modèle reste intact)
  const tree = sortTreeByDate(ctx.view.tree);
  const searching = Boolean(saved.filters?.search);
  const scaleMode = SCALES.includes(saved.ganttScale) ? saved.ganttScale : 'month';
  const level =
    GANTT_LEVELS.includes(saved.ganttLevel) || saved.ganttLevel === 'custom' ? saved.ganttLevel : DEFAULT_LEVEL;
  const narrow = typeof window !== 'undefined' ? window.matchMedia?.(NARROW) : null;
  const st = {
    scale: scaleMode,
    colorBy: COLOR_BY.includes(saved.ganttColorBy) ? saved.ganttColorBy : 'chantier',
    // La période choisie survit aux rechargements des données (nouveau rendu de la vue)
    anchor: memory.scale === scaleMode && memory.anchor !== null ? memory.anchor : todayAnchor(scaleMode, ctx.today),
    // Niveau choisi (Projets… Sous-tâches) ou dépliage ligne par ligne mémorisé (« custom »)
    level,
    // Recherche active : tout est déplié (sans toucher au dépliage mémorisé)
    expanded: new Set(
      searching
        ? expandableKeys(tree)
        : level === 'custom'
          ? Array.isArray(saved.ganttExpanded)
            ? saved.ganttExpanded
            : levelExpanded(tree, DEFAULT_LEVEL)
          : levelExpanded(tree, level),
    ),
    /** Largeur choisie pour la colonne des noms (px) ; null = largeur par défaut de l'écran. */
    // Glisser en cours pendant un nouveau rendu (relecture) : la largeur en cours est gardée
    labelWidth: memory.drag ? memory.drag.last : Number.isFinite(saved.ganttLabelWidth) ? saved.ganttLabelWidth : null,
    /** Ligne qui porte le focus itinérant (seul arrêt de tabulation de l'arbre). */
    focusKey: null,
    // Message d'un geste annulé à un rendu : gardé quelques secondes (la relecture peut redessiner deux fois)
    notice: memory.notice && memory.notice.until > Date.now() ? memory.notice.text : '',
    busy: false,
  };
  let rows = [];
  let items = [];
  /** Rendu en cours : le focus perdu au remplacement du contenu n'annule pas le mode clavier. */
  let painting = false;
  /** Menu de ligne ouvert depuis ce rendu (refermé au rendu suivant). */
  let rowMenuOpen = false;
  let scale = null;
  /** Teintes des chantiers (mode « chantier »), recalculées à chaque rendu, jamais par ligne. */
  let slots = null;

  const persistExpanded = () => {
    if (searching) return;
    // Clés du modèle entier (et non de l'arbre filtré) : un projet masqué par un filtre garde son dépliage
    const valid = new Set(expandableKeys(ctx.model.tree));
    ctx.setPrefs?.({ ganttLevel: 'custom', ganttExpanded: prunedExpanded(st.expanded, valid) });
  };

  /** Largeur affichée de la colonne des noms et ses bornes, pour la largeur actuelle de la vue. */
  function widthInfo(wanted = st.labelWidth) {
    const viewWidth = el.clientWidth;
    const fallback = defaultLabelWidth(typeof window !== 'undefined' ? window.innerWidth : 0);
    return {
      min: LABEL_WIDTH.min,
      max: labelWidthMax(viewWidth),
      value: clampLabelWidth(wanted ?? fallback, viewWidth, fallback),
      view: viewWidth,
    };
  }

  /**
   * Largeur posée sans redessiner (glisser, clavier) : variable CSS de la vue et valeurs de la poignée ; enregistrée dans les préférences si persist (null = retour à la largeur par défaut).
   */
  function applyWidth(wanted, persist) {
    const width = widthInfo(wanted);
    el.querySelector('.gantt')?.style.setProperty('--gantt-label', `${width.value}px`);
    const handle = el.querySelector('[data-resizer]');
    if (handle) {
      handle.setAttribute('aria-valuemax', String(width.max));
      handle.setAttribute('aria-valuenow', String(width.value));
      handle.setAttribute('aria-valuetext', widthText(width.value));
    }
    if (persist) {
      st.labelWidth = wanted === null ? null : width.value;
      ctx.setPrefs?.({ ganttLabelWidth: st.labelWidth });
    }
    return width.value;
  }

  function paint() {
    painting = true;
    try {
      paintNow();
    } finally {
      painting = false;
    }
  }

  function paintNow() {
    // Menu de ligne ouvert : il visait une ligne de l'ancien rendu
    if (rowMenuOpen) {
      rowMenuOpen = false;
      closeStatusPopover(false);
    }
    const box = el.querySelector('.gantt__scroll');
    const top = box?.scrollTop ?? 0;
    const left = box?.scrollLeft ?? 0;
    const isList = Boolean(narrow?.matches);
    scale = timeScale(st.scale, st.anchor);
    rows = isList ? [] : ganttRows(tree, st.expanded);
    items = isList ? chronoItems(tree, scale) : [];
    slots = st.colorBy === 'chantier' ? chantierSlots(ctx.model) : null;
    memory.anchor = st.anchor;
    memory.scale = st.scale;
    let focusIndex = rows.findIndex((r) => r.key === st.focusKey);
    if (focusIndex < 0) focusIndex = 0;
    // Glisser en cours pendant ce rendu (relecture, période changée au bord) : ligne retrouvée par sa clé
    const g = memory.gesture;
    // Édition fermée ou session verrouillée pendant le geste : il ne peut plus rien enregistrer
    if (g && !ctx.dates) {
      st.notice = dragNotice(label('gantt.drag.off'));
      abortGesture('edit');
    }
    const resume = memory.gesture ? (isList ? { ok: false, reason: 'list' } : reattachDrag(g, rows)) : null;
    if (resume && !resume.ok) {
      // Liste chronologique (fenêtre étroite) : pas de barres, geste annulé sans message
      if (resume.reason !== 'list') st.notice = dragNotice(label('gantt.drag.changed'));
      abortGesture(resume.reason);
    }
    const n = isList ? items.length : rows.length;
    const count = isList
      ? n === 1
        ? label('gantt.list.one')
        : label('gantt.list.count', { n: n.toLocaleString('fr-FR') })
      : n === 1
        ? label('gantt.rows.one')
        : label('gantt.rows', { n: n.toLocaleString('fr-FR') });
    const shownLevel = searching ? null : st.level;
    const width = widthInfo();
    const dragOf = dragRights(ctx);
    // Largeur de la frise estimée (vue moins colonne des noms et bordures, au moins sa largeur minimale) : décide
    // des poignées sans lire la géométrie d'une ligne
    const trackPx = Math.max(TIMELINE_MIN[st.scale], width.view - width.value - 2);
    keepFocus(
      el,
      h`<div class="gantt" style="--gantt-label:${width.value}px">
        ${viewHeading(
          label('heading.gantt.title'),
          label('heading.gantt.sub'),
          h`<button type="button" id="gantt-pdf" class="fr-btn fr-btn--sm fr-btn--secondary fr-btn--icon-left fr-icon-download-line" data-pdf ${raw(st.busy ? 'disabled aria-busy="true"' : '')}>${label(st.busy ? 'gantt.pdf.busy' : 'gantt.pdf')}</button>`,
        )}
        <div class="gantt__bar">
          <fieldset class="fr-segmented fr-segmented--sm gantt__scales">
            <legend class="fr-segmented__legend gantt__legend-title">${label('gantt.scale')}</legend>
            <div class="fr-segmented__elements">
              ${SCALES.map(
                (s) => h`<div class="fr-segmented__element">
                  <input type="radio" name="gantt-scale" id="gantt-scale-${s}" value="${s}" data-scale ${raw(s === st.scale ? 'checked' : '')} />
                  <label class="fr-label" for="gantt-scale-${s}">${label(`gantt.scale.${s}`)}</label>
                </div>`,
              )}
            </div>
          </fieldset>
          <div class="gantt__nav" role="group" aria-label="${label('gantt.period', { debut: formatDateFr(scale.start), fin: formatDateFr(scale.end) })}">
            <button type="button" id="gantt-prev" class="fr-btn fr-btn--sm fr-btn--tertiary fr-icon-arrow-left-s-line" data-nav="-1" title="${label('gantt.prev')}">${label('gantt.prev')}</button>
            <button type="button" id="gantt-today" class="fr-btn fr-btn--sm fr-btn--secondary" data-nav="0">${label('gantt.today')}</button>
            <button type="button" id="gantt-next" class="fr-btn fr-btn--sm fr-btn--tertiary fr-icon-arrow-right-s-line" data-nav="1" title="${label('gantt.next')}">${label('gantt.next')}</button>
            <p class="gantt__period" aria-live="polite">${label('gantt.period', { debut: formatDateFr(scale.start), fin: formatDateFr(scale.end) })}</p>
          </div>
          <fieldset class="fr-segmented fr-segmented--sm gantt__scales">
            <legend class="fr-segmented__legend gantt__legend-title">${label('gantt.colorBy')}</legend>
            <div class="fr-segmented__elements">
              ${COLOR_BY.map(
                (c) => h`<div class="fr-segmented__element">
                  <input type="radio" name="gantt-color" id="gantt-color-${c}" value="${c}" data-color ${raw(c === st.colorBy ? 'checked' : '')} />
                  <label class="fr-label" for="gantt-color-${c}">${label(`gantt.colorBy.${c}`)}</label>
                </div>`,
              )}
            </div>
          </fieldset>
          ${
            isList
              ? ''
              : h`<fieldset class="fr-segmented fr-segmented--sm gantt__scales gantt__levels">
            <legend class="fr-segmented__legend gantt__legend-title">${label('gantt.level')}</legend>
            <div class="fr-segmented__elements">
              ${GANTT_LEVELS.map(
                (l) => h`<div class="fr-segmented__element">
                  <input type="radio" name="gantt-level" id="gantt-level-${l}" value="${l}" data-level ${raw(l === shownLevel ? 'checked' : '')} />
                  <label class="fr-label" for="gantt-level-${l}">${label(`gantt.level.${l}`)}</label>
                </div>`,
              )}
            </div>
          </fieldset>`
          }
        </div>
        <div class="gantt__info">
          ${legendHtml(st.colorBy)}
          <p class="gantt__count" role="status">${count}${st.notice ? h` <span class="gantt__notice">— ${st.notice}</span>` : ''}</p>
        </div>
        ${
          isList
            ? h`<div class="gantt__list">${
                tree.length
                  ? listHtml(ctx, items, st.colorBy, slots)
                  : h`<div class="gantt__empty">
                    <p class="gantt__empty-title">${label('gantt.empty')}</p>
                    <p>${label('gantt.empty.hint')}</p>
                    <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-action="clear-filters">${label('empty.filters.action')}</button>
                  </div>`
              }</div>`
            : h`<div class="gantt__scroll" tabindex="-1" data-scroll-key="gantt">
          <div class="gantt__grid${st.colorBy === 'chantier' ? ' gantt__grid--chantier' : ''}" role="treegrid" aria-label="${label('gantt.label')}" aria-describedby="gantt-help" style="--timeline-min:${TIMELINE_MIN[st.scale]}px">
            ${headHtml(scale, ctx.today, width)}
            <div class="gantt__body" role="rowgroup">
              ${linesHtml(scale, ctx.today)}
              ${
                rows.length
                  ? raw(
                      rows
                        .map((r, i) => rowHtml(ctx, r, i, scale, st.colorBy, focusIndex, slots, dragOf, trackPx))
                        .join(''),
                    )
                  : h`<div class="gantt__empty" role="row"><div role="gridcell">
                    <p class="gantt__empty-title">${label('gantt.empty')}</p>
                    <p>${label('gantt.empty.hint')}</p>
                    <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-action="clear-filters">${label('empty.filters.action')}</button>
                  </div></div>`
              }
            </div>
          </div>
        </div>
        <p class="fr-sr-only" id="gantt-help">${label('gantt.tree.help')}</p>`
        }
        <div class="gtip" id="gantt-tip" role="tooltip" hidden></div>
        <div class="gghost" id="gantt-ghost" aria-hidden="true" hidden></div>
      </div>`.toString(),
    );
    const nb = el.querySelector('.gantt__scroll');
    if (nb) {
      nb.scrollTop = top;
      nb.scrollLeft = left;
    }
    if (resume?.ok && memory.gesture === g) {
      // Géométrie relue après la fin du rendu complet : main.js rend le défilement de la page juste après
      queueMicrotask(() => resumeGesture(g));
      return;
    }
    // Le focus rendu par keepFocus garde son infobulle
    const act = document.activeElement;
    if (act && el.contains(act) && act.dataset.i !== undefined) showTip(act);
  }

  /** Geste rattaché après un rendu : géométrie relue, résumé sur le modèle relu ; ligne perdue → message. */
  function resumeGesture(g) {
    if (memory.gesture !== g || gen !== memory.generation || !el.isConnected) return;
    const index = rows.findIndex((r) => r.key === g.key);
    const ok = guard(() => {
      if (index < 0 || !measure(g, index)) return false;
      g.model = ctx.model;
      g.dctx = dragContext(ctx.model, g.target, g.from);
      refresh(g);
      return true;
    });
    if (ok === false) abortGesture('gone');
    if (memory.gesture === g) return;
    // Geste perdu au rattachement : même message qu'une ligne disparue (un rendu de plus, sans geste)
    st.notice = dragNotice(label('gantt.drag.changed'));
    paint();
  }

  // ---------- Infobulle (survol et focus) ----------
  let tipFor = null;
  function showTip(target) {
    const i = Number(target.dataset.i);
    const r = rows[i];
    const tip = el.querySelector('#gantt-tip');
    if (!r || !tip) return;
    tipFor = target;
    tip.innerHTML = tipHtml(ctx, r, st.colorBy, slots).toString();
    tip.hidden = false;
    // Ancrage : la barre de la ligne si elle est visible, sinon l'élément lui-même
    const rowEl = target.closest('.grow');
    const mark = rowEl?.querySelector('.gbar, .gms, .gout');
    const box = el.querySelector('.gantt__scroll').getBoundingClientRect();
    let a = (mark ?? target).getBoundingClientRect();
    if (a.right < box.left || a.left > box.right) a = target.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const x = Math.min(Math.max(8, Math.max(a.left, box.left + 8)), vw - tw - 8);
    const y = a.bottom + 6 + th > vh - 8 ? a.top - th - 6 : a.bottom + 6;
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.max(8, y)}px`;
    tip.style.bottom = '';
  }
  function hideTip() {
    tipFor = null;
    const tip = el.querySelector('#gantt-tip');
    if (tip) tip.hidden = true;
  }
  el.onpointerover = (e) => {
    if (memory.gesture) return;
    const t = e.target.closest?.('[data-i]:not([role="row"])');
    if (t && t !== tipFor) showTip(t);
    else if (!t && tipFor && !el.contains(document.activeElement)) hideTip();
  };
  el.onpointerleave = () => {
    if (memory.gesture) return;
    if (!tipFor || tipFor !== document.activeElement) hideTip();
  };
  // focusin / focusout n'ont pas de propriété « on… » : écouteurs ajoutés, retirés au rendu suivant sur le même élément
  listeners.get(el)?.abort();
  const off = new AbortController();
  listeners.set(el, off);
  el.addEventListener(
    'focusin',
    (e) => {
      const row = e.target.closest?.('[data-row]');
      if (row) setRoving(row);
      if (memory.gesture) return;
      const t = e.target.closest?.('[data-i]');
      if (t) showTip(t);
      else hideTip();
    },
    { signal: off.signal },
  );
  el.addEventListener(
    'focusout',
    (e) => {
      // Focus sorti de la ligne pendant le mode clavier (clic ailleurs, autre fenêtre) : déplacement annulé. Vérifié
      // après le rendu en cours : une relecture remplace la vue puis rend le focus à la ligne (#gr-<clé>)
      const g = memory.gesture;
      if (g?.keyboard && !painting && !e.relatedTarget?.closest?.(`[id="gr-${CSS.escape(g.key)}"]`)) {
        queueMicrotask(() => {
          if (memory.gesture === g && document.activeElement?.id !== `gr-${g.key}`)
            memory.dragView?.key({ key: 'Escape' });
        });
        return;
      }
      if (g) return;
      if (!e.relatedTarget || !el.contains(e.relatedTarget)) hideTip();
    },
    { signal: off.signal },
  );

  /** Focus itinérant : la ligne focalisée devient le seul arrêt de tabulation de l'arbre. */
  function setRoving(row) {
    const i = Number(row.dataset.row);
    if (!rows[i]) return;
    st.focusKey = rows[i].key;
    for (const r of el.querySelectorAll('[data-row][tabindex="0"]')) if (r !== row) r.tabIndex = -1;
    row.tabIndex = 0;
  }

  // ---------- Actions ----------
  function toggle(i, open) {
    const r = rows[i];
    if (!r?.hasChildren) return false;
    const next = open ?? !r.expanded;
    if (next === r.expanded) return false;
    if (next) st.expanded.add(r.key);
    else st.expanded.delete(r.key);
    persistExpanded();
    paint();
    return true;
  }

  /**
   * Copie hors écran de la grille affichée, prise au clic : un rechargement des données pendant l'export
   * (nouveau rendu de la vue) ne la touche pas. Identifiants retirés, icônes DSFR (masques CSS, non rendus
   * par html2canvas) remplacées par des flèches en texte.
   */
  function printableCopy() {
    const live = el.querySelector('.gantt__grid');
    if (!live) return null;
    const host = document.createElement('div');
    host.className = 'gantt gantt--print gantt--offscreen';
    host.setAttribute('aria-hidden', 'true');
    const copy = live.cloneNode(true);
    copy.style.width = `${live.offsetWidth}px`;
    // Même largeur de colonne des noms qu'à l'écran ; la poignée n'est pas imprimée
    host.style.setProperty('--gantt-label', `${widthInfo().value}px`);
    for (const n of copy.querySelectorAll('[data-resizer], .gantt__corner .fr-sr-only')) n.remove();
    for (const n of copy.querySelectorAll('[id]')) n.removeAttribute('id');
    for (const b of copy.querySelectorAll('.grow__toggle[data-expanded]')) {
      b.className = 'grow__toggle';
      b.textContent = b.dataset.expanded === 'true' ? '▾' : '▸';
    }
    for (const i of copy.querySelectorAll('.gout [class^="fr-icon-"]'))
      i.replaceWith(document.createTextNode(i.closest('.gout--before') ? '‹ ' : ' ›'));
    host.append(copy);
    document.body.append(host);
    return { host, copy, repeatTop: live.querySelector('.gantt__head')?.offsetHeight ?? 0 };
  }

  async function exportGantt() {
    if (st.busy) return;
    const print = printableCopy();
    if (!print) return;
    const subtitle = label('gantt.pdf.subtitle', {
      periode: label('gantt.period', { debut: formatDateFr(scale.start), fin: formatDateFr(scale.end) }),
      couleur: label(`gantt.colorBy.${st.colorBy}`).toLowerCase(),
      date: formatDateFr(ctx.today),
    });
    const legend = pdfLegend(st.colorBy);
    st.busy = true;
    st.notice = '';
    paint();
    const name = pdfFilenameOfDay('gantt', ctx.today);
    let mod = null;
    try {
      mod = await import('../ui/pdf.js');
      await mod.exportPdf(print.copy, {
        filename: name,
        title: label('gantt.pdf.title'),
        subtitle,
        repeatTop: print.repeatTop,
        rowHeight: ROW_PX,
        legend,
      });
      st.notice = label('gantt.pdf.done', { nom: name });
    } catch (err) {
      console.error(err);
      const raison = mod && err instanceof mod.PdfError ? err.message : label('pdf.failed');
      st.notice = label('gantt.pdf.error', { raison });
    } finally {
      print.host.remove();
      st.busy = false;
      // Vue redessinée entre-temps (données rechargées) : ce rendu-ci n'est plus affiché
      if (gen === memory.generation && el.isConnected) paint();
    }
  }

  el.onclick = (e) => {
    const t = e.target.closest('[data-toggle]');
    if (t) return void toggle(Number(t.dataset.toggle));
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      const dir = Number(nav.dataset.nav);
      st.anchor = dir === 0 ? todayAnchor(st.scale, ctx.today) : shiftAnchor(st.scale, st.anchor, dir);
      return paint();
    }
    if (e.target.closest('[data-pdf]')) return void exportGantt();
    const add = e.target.closest('[data-add-dates]');
    if (add) {
      const ref = rows[Number(add.dataset.addDates)]?.node.ref;
      if (ref) (ctx.openDates ?? ctx.openDetail)(ref);
      return;
    }
    const li = e.target.closest('[data-open-key]');
    if (li) {
      const it = items.find((x) => x.key === li.dataset.openKey);
      if (it?.node.ref) ctx.openDetail(it.node.ref);
      return;
    }
    const o = e.target.closest('[data-open], .grow__title--static, .gbar, .gms, .gout');
    if (o) {
      const r = rows[Number(o.dataset.open ?? o.dataset.i)];
      if (r?.node.ref) ctx.openDetail(r.node.ref);
      else if (r) toggle(Number(o.dataset.i));
    }
  };

  el.onchange = (e) => {
    if (e.target.matches('[data-scale]') && SCALES.includes(e.target.value)) {
      const inWindow = ctx.today >= scale.start && ctx.today <= scale.end;
      st.scale = e.target.value;
      st.anchor = inWindow ? todayAnchor(st.scale, ctx.today) : scale.start;
      ctx.setPrefs?.({ ganttScale: st.scale });
    } else if (e.target.matches('[data-color]') && COLOR_BY.includes(e.target.value)) {
      st.colorBy = e.target.value;
      ctx.setPrefs?.({ ganttColorBy: st.colorBy });
    } else if (e.target.matches('[data-level]') && GANTT_LEVELS.includes(e.target.value)) {
      st.level = e.target.value;
      st.expanded = new Set(levelExpanded(tree, st.level));
      ctx.setPrefs?.({ ganttLevel: st.level });
    } else return;
    paint();
  };

  /**
   * Clavier dans l'arbre (motif treegrid, ligne focalisée) : ↑/↓ ligne précédente/suivante, Début/Fin,
   * → déplier ou aller au premier enfant, ← replier ou remonter au parent, Entrée/Espace ouvrir la fiche
   * (ou déplier un regroupement sans fiche).
   */
  el.onkeydown = (e) => {
    if (e.target.matches?.('[data-resizer]')) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const next = labelWidthAfterKey(widthInfo().value, e.key, e.shiftKey, el.clientWidth);
      if (next === null) return;
      e.preventDefault();
      applyWidth(next, true);
      return;
    }
    // Mode clavier « D » : ses touches ne vont ni à l'arbre, ni au panneau, ni à la page
    if (memory.gesture?.keyboard) {
      if (memory.dragView?.key(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    const row = e.target.closest?.('[data-row]');
    if (!row || e.altKey || e.ctrlKey || e.metaKey) return;
    const i = Number(row.dataset.row);
    const r = rows[i];
    if (!r) return;
    if (e.target === row && ctx.dates && !e.shiftKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      memory.dragView?.keyStart(i);
      return;
    }
    if (e.target === row && isStatusShortcut(e) && e.key !== 's' && e.key !== 'S' && openRowMenu(i)) {
      e.preventDefault();
      return;
    }
    const focusRow = (j) => document.getElementById(`gr-${rows[j]?.key}`)?.focus();
    if ((e.key === 'Enter' || e.key === ' ') && e.target === row) {
      e.preventDefault();
      if (r.node.ref) ctx.openDetail(r.node.ref);
      else if (toggle(i)) focusRow(i);
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'ArrowDown') focusRow(Math.min(rows.length - 1, i + 1));
    else if (e.key === 'ArrowUp') focusRow(Math.max(0, i - 1));
    else if (e.key === 'Home') focusRow(0);
    else if (e.key === 'End') focusRow(rows.length - 1);
    else if (e.key === 'ArrowRight') {
      if (r.hasChildren && !r.expanded) {
        toggle(i, true);
        focusRow(i);
      } else if (r.expanded) focusRow(i + 1);
    } else if (e.key === 'ArrowLeft') {
      if (r.expanded) {
        toggle(i, false);
        focusRow(i);
      } else {
        for (let j = i - 1; j >= 0; j--) if (rows[j].depth < r.depth) return void focusRow(j);
      }
    }
  };

  // ---------- Glisser une barre (tâche, sous-tâche, jalon, chantier), à la souris, au doigt ou au clavier (D) ----------
  // Le geste vit dans memory et ses écouteurs sur la fenêtre (ui/drag.js) : un nouveau rendu le poursuit
  // (memory.dragView = fonctions du dernier rendu). Pendant le geste, rien n'est redessiné : seuls le fantôme
  // (#gantt-ghost) et l'infobulle bougent, d'après la géométrie lue au début, après un rendu, et corrigée à chaque
  // défilement de la frise ou de la page (écouteurs passifs posés pour la durée du geste).
  const maxDay = maxPlanDay(ctx.today);

  /** Géométrie de la ligne du geste (lue une fois) ; barre d'origine en pointillés ; suivi des défilements. */
  function measure(g, index) {
    const rowEl = el.querySelector(`[data-row="${index}"]`);
    const track = rowEl?.querySelector('.grow__track');
    const sc = el.querySelector('.gantt__scroll');
    if (!track || !sc) return false;
    const tr = track.getBoundingClientRect();
    const sr = sc.getBoundingClientRect();
    const inner = sr.left + sc.clientLeft;
    g.pxPerDay = tr.width / scale.days;
    g.trackLeft = tr.left;
    g.rowTop = tr.top;
    g.rowBottom = tr.bottom;
    g.scaleStart = scale.start;
    g.scaleEnd = scale.end;
    g.colPx = tr.width / scale.columns.length;
    // Même objet d'un rendu à l'autre : ui/drag.js garde la boîte du bord lue au début du geste
    g.box = Object.assign(g.box ?? {}, {
      left: inner + widthInfo().value,
      right: inner + sc.clientWidth,
      top: sr.top,
      bottom: sr.bottom,
    });
    g.anchor = st.anchor;
    g.scrollLeft = sc.scrollLeft;
    g.scrollTop = sc.scrollTop;
    g.winX = window.scrollX;
    g.winY = window.scrollY;
    // Même jour sous le pointeur qu'au début du geste
    g.startX = g.trackLeft + (g.grabDay - g.scaleStart) * g.pxPerDay;
    rowEl.querySelector('[data-drag]')?.classList.add(g.target.milestone ? 'gms--origin' : 'gbar--origin');
    // Écouteurs posés une fois par geste (la frise, remplacée à chaque rendu, seulement quand elle change)
    if (g.watchedScroll !== sc) {
      g.watch?.abort();
      g.watch = new AbortController();
      g.watchedScroll = sc;
      sc.addEventListener('scroll', () => guard(() => followScroll(g, sc)), { passive: true, signal: g.watch.signal });
    }
    if (!g.watchPage) {
      g.watchPage = new AbortController();
      window.addEventListener('scroll', () => followPage(g), { passive: true, signal: g.watchPage.signal });
    }
    return true;
  }

  /** Géométrie décalée de (dx, dy) : la ligne a bougé à l'écran, même jour sous le pointeur. */
  function shiftGeometry(g, dx, dy) {
    g.trackLeft -= dx;
    g.startX -= dx;
    g.rowTop -= dy;
    g.rowBottom -= dy;
    refresh(g);
  }

  /** Frise défilée pendant le geste (molette, pavé, bord). */
  function followScroll(g, sc) {
    if (memory.gesture !== g) return;
    const dx = sc.scrollLeft - g.scrollLeft;
    const dy = sc.scrollTop - g.scrollTop;
    if (!dx && !dy) return;
    g.scrollLeft += dx;
    g.scrollTop += dy;
    shiftGeometry(g, dx, dy);
  }

  /**
   * Page (ou cadre du widget) défilée pendant le geste, y compris quand main.js rend le défilement après un
   * nouveau rendu : géométrie relue (hors de la boucle des mouvements), même jour sous le pointeur.
   */
  function followPage(g) {
    if (g.pageFrame) return; // une relecture par image au plus
    g.pageFrame = requestAnimationFrame(() => {
      g.pageFrame = 0;
      if (memory.gesture !== g || (window.scrollX === g.winX && window.scrollY === g.winY)) return;
      const index = rows.findIndex((r) => r.key === g.key);
      if (index < 0) return void abortGesture('gone');
      guard(() => {
        if (!measure(g, index)) return void abortGesture('gone');
        refresh(g);
      });
    });
  }

  /** Fantôme à la période g.now, coupé à la frise visible (transform et largeur, aucune lecture). */
  function placeGhost(g) {
    const ghost = el.querySelector('#gantt-ghost');
    if (!ghost) return;
    const dayX = (day) => g.trackLeft + (day - g.scaleStart) * g.pxPerDay;
    let x;
    let w;
    if (g.target.milestone) {
      // Losange centré sur le jour de l'échéance, comme le jalon dessiné
      x = dayX(g.now.end + 0.5) - g.barHeight / 2;
      w = g.barHeight;
    } else {
      x = Math.max(dayX(g.now.start), g.box.left);
      w = Math.max(4, Math.min(dayX(g.now.end + 1), g.box.right) - x);
    }
    ghost.hidden = x + w < g.box.left || x > g.box.right;
    // Poignées du fantôme : le bord saisi ; au clavier, les deux (le bord du mode en évidence)
    const grips = g.target.milestone
      ? ''
      : `${g.keyboard ? ' gghost--grips' : ''}${g.edge !== 'move' ? ` gghost--edge-${g.edge}` : ''}`;
    ghost.className = `gghost${g.target.milestone ? ' gghost--ms' : ''}${grips}${g.off ? ' gghost--off' : ''}`;
    ghost.style.cssText = `width:${w}px;height:${g.barHeight}px;transform:translate(${x}px,${g.rowTop + g.barOffset}px);--g-fill:${g.fill}`;
    g.ghostX = Math.min(Math.max(x, g.box.left), g.box.right);
  }

  /** Résumé du geste (dragSummary, mémorisé par période). */
  const summaryOf = (g) => dragSummary(g.model, g.target, g.from, g.now, ctx.today, g.dctx);

  /** Infobulle du geste : nouvelles dates, écart, heures, alertes. */
  function placeTip(g) {
    const tip = el.querySelector('#gantt-tip');
    if (!tip) return;
    const edges = g.keyboard && keyEdges(g.target).length > 1;
    tip.innerHTML = h`<strong class="gtip__title">${g.title}</strong>
      ${edges ? h`<span class="gtip__line gtip__mode">${label(`gantt.key.mode.${g.edge}`)}</span>` : ''}
      ${summaryText(summaryOf(g), g.edge).map((line) => h`<span class="gtip__line">${line}</span>`)}
      ${g.keyboard ? h`<span class="gtip__line gtip__hint">${label('gantt.key.hint')}</span>` : ''}
      ${edges ? h`<span class="gtip__line gtip__hint">${label('gantt.key.hint.edges')}</span>` : ''}`.toString();
    tip.hidden = false;
    tip.style.left = `${Math.max(8, Math.min(g.ghostX, g.vw - TIP_MAX - 8))}px`;
    if (g.tipAbove) {
      tip.style.top = 'auto';
      tip.style.bottom = `${g.vh - (g.rowTop + g.barOffset) + 6}px`;
    } else {
      tip.style.top = `${g.rowTop + g.barOffset + g.barHeight + 6}px`;
      tip.style.bottom = '';
    }
  }

  /**
   * Période alignée sous le pointeur (pas de l'échelle, Maj au jour, bornée), fantôme et infobulle. Bord saisi
   * (poignée) : seul ce bord bouge, en pas comptés depuis sa date d'origine.
   */
  function dragUpdate(g, force = false) {
    const { from, edge } = g;
    const unit = snapUnit(st.scale, g.shift);
    const n = stepsFromPixels(g.lastX - g.startX, g.pxPerDay, unit, edge === 'end' ? from.end : from.start);
    const now =
      edge === 'move'
        ? movedDates(from.start, from.end, unit, clampShift(from.start, from.end, n, unit, { max: maxDay }))
        : resizedDates(from.start, from.end, edge, unit, n, { max: maxDay });
    const off =
      g.lastX < g.box.left ||
      g.lastX > g.box.right ||
      g.lastY < g.rowTop - DROP_SLACK ||
      g.lastY > g.rowBottom + DROP_SLACK;
    const moved = !g.now || now.start !== g.now.start || now.end !== g.now.end;
    g.unit = unit;
    if (!moved && !force && off === g.off) return;
    g.now = now;
    g.off = off;
    placeGhost(g);
    if (moved || force) placeTip(g);
  }

  /** Fantôme et infobulle redessinés : au pointeur (dragUpdate), ou à la période choisie au clavier. */
  function refresh(g) {
    if (!g.keyboard) return dragUpdate(g, true);
    placeGhost(g);
    placeTip(g);
  }

  /** Fantôme et infobulle masqués (positions de l'infobulle remises), barre d'origine rendue. */
  function dragClear() {
    const ghost = el.querySelector('#gantt-ghost');
    if (ghost) ghost.hidden = true;
    hideTip();
    const tip = el.querySelector('#gantt-tip');
    if (tip) tip.style.bottom = '';
    for (const b of el.querySelectorAll('.gbar--origin, .gms--origin'))
      b.classList.remove('gbar--origin', 'gms--origin');
  }

  /** Écouteurs de défilement et image en attente d'un geste retirés. */
  function unwatch(g) {
    g?.watch?.abort();
    g?.watchPage?.abort();
    if (g?.pageFrame) cancelAnimationFrame(g.pageFrame);
  }

  /** Fin du geste (dépôt, annulation, erreur) : plus de geste en mémoire, suivi des défilements retiré. */
  function stopGesture() {
    const g = memory.gesture;
    memory.gesture = null;
    unwatch(g);
    document.documentElement.classList.remove('is-grabbing', 'is-resizing');
    dragClear();
    return g;
  }

  /** Geste interrompu par une situation attendue (vue retirée, ligne perdue) : annulé sans erreur. */
  function abortGesture(why) {
    const g = stopGesture();
    g?.handle?.cancel(why);
    return g;
  }

  /** Une erreur pendant le geste ne laisse jamais un geste en mémoire : il est annulé, la vue reste utilisable. */
  function guard(run) {
    try {
      return run();
    } catch (err) {
      abortGesture('error');
      console.error(err);
      return undefined;
    }
  }

  /** Fantôme d'une barre creuse (fond transparent) : couleur neutre des barres, jamais un fond vide. */
  function ghostFill(bar) {
    const bg = getComputedStyle(bar).backgroundColor;
    const empty = bg === 'transparent' || /^rgba\(.*,\s*0\)$/.test(bg);
    return empty || bar.matches('.gbar--hollow, .gms--hollow') ? 'var(--viz-neutral)' : bg;
  }

  // ---------- Annonces (#gantt-live, hors de la vue redessinée), regroupées à 300 ms ----------
  function announce(text) {
    clearTimeout(memory.liveTimer);
    memory.liveTimer = setTimeout(() => {
      const live = document.getElementById('gantt-live');
      if (!live) return;
      // Même texte qu'avant (pas refusé deux fois, même raison) : vidé d'abord pour être relu
      if (live.textContent !== text) live.textContent = text;
      else {
        live.textContent = '';
        memory.liveTimer = setTimeout(() => (live.textContent = text), REPEAT_DELAY);
      }
    }, LIVE_DELAY);
  }
  const fullDate = (d) => formatDateFr(d);
  /**
   * Période et écart dits (« Du 17 novembre au 12 décembre, plus 14 jours. » ; sur un bord : « …, échéance plus
   * 7 jours. », écart de ce bord depuis sa date d'origine), puis l'alerte des charges.
   */
  function stepText(g) {
    const s = summaryOf(g);
    const delta = g.edge === 'end' ? s.end - g.from.end : s.start - g.from.start;
    const ecart = delta
      ? label(delta > 0 ? 'gantt.key.delta.plus' : 'gantt.key.delta.minus', { n: Math.abs(delta) })
      : label('gantt.key.delta.none');
    const dates = { debut: fullDate(s.start), fin: fullDate(s.end) };
    const text =
      g.edge === 'move'
        ? label('gantt.key.step', { ...dates, ecart })
        : label(delta ? 'gantt.key.step.edge' : 'gantt.key.step.edgeSame', {
            ...dates,
            ecart,
            bord: label(`gantt.key.edgeName.${g.edge}`),
          });
    return s.keptOver.length ? `${text} ${label('gantt.key.over', { n: s.keptOver.length })}` : text;
  }

  /**
   * Geste préparé sur une ligne : cible relue (ctx.dates.target), dates vues, contexte du résumé, géométrie.
   * @returns {object|null} null si la ligne n'est pas glissable (ou la géométrie introuvable)
   */
  function prepare(index, extra) {
    const r = rows[index];
    const target = r ? ctx.dates.target(r.node) : null;
    if (!target?.ok) return null;
    const bar = el.querySelector(`[data-row="${index}"] [data-drag]`);
    const seen = { start: r.node.start, end: r.node.end };
    const from = periodOf(seen);
    const ms = target.milestone;
    const g = {
      key: r.key,
      target,
      seen,
      from,
      now: null,
      edge: 'move',
      base: from,
      unit: snapUnit(st.scale, false),
      startX: 0,
      pxPerDay: 0,
      anchor: st.anchor,
      handle: null,
      model: ctx.model,
      dctx: dragContext(ctx.model, target, from),
      title: r.node.title || label('common.untitled'),
      // Barre hors de la période affichée (mode clavier) : géométrie par défaut du CSS
      fill: bar ? ghostFill(bar) : 'var(--viz-neutral)',
      barOffset: bar ? bar.offsetTop : ms ? 9 : 7,
      barHeight: bar ? bar.offsetHeight : ms ? 14 : 18,
      vw: document.documentElement.clientWidth,
      vh: document.documentElement.clientHeight,
      grabDay: 0,
      lastX: 0,
      lastY: 0,
      shift: false,
      off: false,
      watch: null,
      keyboard: false,
      ...extra,
    };
    const rowBottom = el.querySelector(`[data-row="${index}"]`)?.getBoundingClientRect().bottom ?? 0;
    g.tipAbove = rowBottom + TIP_ROOM > g.vh;
    return measure(g, index) ? g : null;
  }

  /** Enregistrement d'une période choisie (dépôt ou Entrée) : barre à sa place, « Enregistrement… », réponse. */
  function commit(g) {
    if (!ctx.dates || (g.now.start === g.from.start && g.now.end === g.from.end)) return;
    const saving = { key: g.key, now: g.now };
    memory.saving = saving;
    let pending;
    try {
      paint();
      pending = Promise.resolve(ctx.dates.save({ target: g.target, seen: g.seen, next: g.now, key: g.key }));
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending
      .catch((err) => console.error(err))
      .finally(() => {
        if (memory.saving === saving) memory.saving = null;
        memory.dragView?.repaint();
      });
  }

  /** Texte dit au changement de bord : « Début : 2 novembre 2026. » (déplacer : la période). */
  function edgeText(g) {
    if (g.edge === 'move')
      return label('gantt.key.edge.move', { debut: fullDate(g.now.start), fin: fullDate(g.now.end) });
    return label(`gantt.key.edge.${g.edge}`, { date: fullDate(g.edge === 'start' ? g.now.start : g.now.end) });
  }

  /**
   * Mode clavier : la période suit les pas ; hors de la période affichée, celle-ci suit (un pas de navigation).
   * edgeSwitch : Tab, le bord du mode change (annonce du bord au lieu de la période).
   */
  function keyStep(g, next, edgeSwitch = false) {
    g.now = next.now;
    g.limit = next.limit;
    g.minimum = next.minimum;
    g.steps = next.steps ?? 0;
    g.days = next.days ?? 0;
    g.edge = next.edge;
    g.base = next.base ?? g.base;
    let anchor = st.anchor;
    for (let k = 0; k < 24; k += 1) {
      const sc = timeScale(st.scale, anchor);
      if (g.now.end < sc.start) anchor = shiftAnchor(st.scale, anchor, -1);
      else if (g.now.start > sc.end) anchor = shiftAnchor(st.scale, anchor, 1);
      else break;
    }
    if (anchor !== st.anchor) {
      st.anchor = anchor;
      paint(); // rattache le geste (measure, refresh)
    } else refresh(g);
    if (edgeSwitch) announce(edgeText(g));
    else if (g.limit) announce(label('gantt.key.limit', { date: fullDate(maxDay) }));
    else announce(g.minimum ? label('gantt.key.minimum') : stepText(g));
  }

  const dragView = {
    /** Geste au pointeur sur la barre d'une ligne ; edge : bord saisi par une poignée ('move' sinon). */
    begin(key, down, handle, edge = 'move') {
      if (!ctx.dates || memory.gesture || memory.saving || !el.isConnected) return false;
      const index = rows.findIndex((r) => r.key === key);
      if (!el.querySelector(`[data-row="${index}"] [data-drag]`)) return false;
      let g = null;
      try {
        g = prepare(index, { handle, lastX: down.clientX, lastY: down.clientY, shift: Boolean(down.shiftKey) });
        if (!g) return false;
        if (keyEdges(g.target).includes(edge)) g.edge = edge;
        g.grabDay = g.scaleStart + (down.clientX - g.trackLeft) / g.pxPerDay;
        g.startX = down.clientX;
        dragUpdate(g, true);
        // Geste en mémoire seulement une fois le premier affichage réussi
        memory.gesture = g;
      } catch (err) {
        unwatch(g);
        dragClear();
        console.error(err);
        return false;
      }
      tipFor = null;
      document.documentElement.classList.add(g.edge === 'move' ? 'is-grabbing' : 'is-resizing');
      announce(label(g.edge === 'move' ? 'gantt.drag.grab' : `gantt.drag.grab.${g.edge}`, { titre: g.title }));
      return true;
    },
    move(m) {
      if (memory.gesture && !el.isConnected) return void abortGesture('gone');
      guard(() => {
        const g = memory.gesture;
        if (!g) return;
        g.lastX = m.clientX;
        g.lastY = m.clientY;
        g.shift = Boolean(m.shiftKey);
        dragUpdate(g);
      });
    },
    edge(side) {
      const sc = el.querySelector('.gantt__scroll');
      if (memory.gesture && (!el.isConnected || !sc)) return void abortGesture('gone');
      guard(() => {
        const g = memory.gesture;
        if (!g) return;
        const before = sc.scrollLeft;
        const room = side > 0 ? sc.scrollWidth - sc.clientWidth - before : before;
        if (room >= 1) {
          // Défilement horizontal de la frise d'abord (followScroll garde le jour sous le pointeur)
          sc.scrollLeft = before + side * Math.min(g.colPx, room);
          followScroll(g, sc);
          return;
        }
        st.anchor = shiftAnchor(st.scale, st.anchor, side);
        paint(); // rattache le geste (measure) et replace le fantôme
      });
    },
    drop(m) {
      if (memory.gesture && !el.isConnected) return void abortGesture('gone');
      const g = guard(() => {
        const cur = memory.gesture;
        if (!cur) return null;
        cur.lastX = m.clientX;
        cur.lastY = m.clientY;
        cur.shift = Boolean(m.shiftKey);
        dragUpdate(cur);
        return stopGesture();
      });
      if (g && !g.off) commit(g);
    },
    cancel() {
      stopGesture();
    },
    repaint() {
      if (gen === memory.generation && el.isConnected) paint();
    },
    /**
     * Touche D (ou menu « Déplacer les dates », « Changer le début », « Changer l’échéance ») sur une ligne : mode
     * clavier sur ce bord, ou la raison du refus.
     */
    keyStart(index, edge = 'move') {
      if (!ctx.dates || memory.gesture || memory.saving) return;
      const r = rows[index];
      const why = r ? ctx.dates.target(r.node) : null;
      if (!why?.ok) {
        if (why) announce(label(`gantt.key.no.${why.reason}`));
        return;
      }
      const mode = keyEdges(why).includes(edge) ? edge : 'move';
      const g = guard(() =>
        prepare(index, { keyboard: true, edge: mode, steps: 0, days: 0, limit: false, minimum: false }),
      );
      if (!g) {
        announce(label('gantt.key.no.view'));
        return;
      }
      g.now = g.from;
      const shown = guard(() => {
        refresh(g);
        return true;
      });
      if (!shown) {
        unwatch(g);
        dragClear();
        return;
      }
      // Geste en mémoire seulement une fois le fantôme et l'infobulle affichés
      memory.gesture = g;
      tipFor = null;
      const s = summaryOf(g);
      const enter = label('gantt.key.enter', {
        debut: fullDate(s.start),
        fin: fullDate(s.end),
        pas: label(`gantt.key.unit.${g.unit}`),
      });
      const edges = keyEdges(g.target).length > 1 ? ` ${label('gantt.key.edges')}` : '';
      const side = g.edge === 'move' ? '' : ` ${edgeText(g)}`;
      announce(`${label('gantt.drag.grab', { titre: g.title })}.${side} ${enter}${edges}`);
    },
    /** Même chose depuis le menu de ligne, la ligne retrouvée par sa clé dans le dernier rendu. */
    keyStartKey(key, edge = 'move') {
      const index = rows.findIndex((r) => r.key === key);
      if (index >= 0) dragView.keyStart(index, edge);
    },
    /**
     * Appui long du doigt sur une barre : elle devient la barre choisie (poignées actives, touch-action: none),
     * sans nouveau rendu ; null : plus aucune.
     */
    select(key) {
      if (memory.touchSel === key) return;
      memory.touchSel = key;
      for (const b of el.querySelectorAll('.is-touch-selected')) b.classList.remove('is-touch-selected');
      if (key === null) return;
      const index = rows.findIndex((r) => r.key === key);
      el.querySelector(`[data-row="${index}"] [data-drag]`)?.classList.add('is-touch-selected');
    },
    /** Touche pendant le mode clavier : vrai si elle lui appartient (rien d'autre ne la traite). */
    key(e) {
      const g = memory.gesture;
      if (!g?.keyboard) return false;
      // Touches de l'arbre et du menu : sans effet dans le mode (Tab : déplacer, début, échéance)
      if (['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'ContextMenu', 'F10'].includes(e.key))
        return true;
      const r = keyMode(
        {
          target: g.target,
          seen: g.seen,
          now: g.now,
          edge: g.edge,
          base: g.base,
          unit: g.unit,
          max: maxDay,
          steps: g.steps,
          days: g.days,
          limit: g.limit,
          minimum: g.minimum,
        },
        e,
      );
      if (r.action === 'none') return ['Tab', ' '].includes(e.key);
      if (r.action === 'cancel') {
        stopGesture();
        announce(label('gantt.key.cancel'));
      } else if (r.action === 'save') {
        const done = stopGesture();
        if (done.now.start === done.from.start && done.now.end === done.from.end)
          announce(label('gantt.key.unchanged'));
        else commit(done);
      } else guard(() => keyStep(g, r.state, r.action === 'edge'));
      return true;
    },
  };
  memory.dragView = dragView;

  /**
   * Appui sur une barre glissable : à la souris ou au stylet, la poignée sous le pointeur choisit le bord ; au
   * doigt, un appui long choisit la barre (poignées actives), puis un appui dans la zone d'une poignée (24 px)
   * étire, ailleurs déplace, sans attendre (barre en touch-action: none).
   */
  function startBarDrag(e, bar) {
    if (!ctx.dates || memory.gesture || memory.saving) return;
    const key = rows[Number(bar.dataset.drag)]?.key;
    if (!key) return;
    const touch = e.pointerType === 'touch';
    const picked = touch && memory.touchSel === key && bar.classList.contains('is-touch-selected');
    let edge = 'move';
    if (!touch) edge = e.target.closest?.('[data-grip]')?.dataset.grip ?? 'move';
    else if (picked) {
      const box = bar.getBoundingClientRect(); // une lecture, au début du geste
      const sides = handleSides({
        milestone: bar.classList.contains('gms'),
        deduced: false,
        widthPx: box.width,
        clipStart: bar.classList.contains('gbar--clip-start'),
        clipEnd: bar.classList.contains('gbar--clip-end'),
        touchSelected: true,
      });
      edge = gripAt(e.clientX, box, sides);
    }
    let handle = null;
    handle = trackPointer(e, {
      immediate: picked,
      onArm: touch && !picked ? () => memory.dragView?.select(key) : undefined,
      onStart: () => memory.dragView?.begin(key, e, handle, edge) ?? false,
      onMove: (m) => memory.dragView?.move(m),
      onDrop: (m) => memory.dragView?.drop(m),
      onCancel: () => memory.dragView?.cancel(),
      onEdge: (side) => memory.dragView?.edge(side),
      edgeBox: () => memory.gesture?.box ?? null,
    });
  }

  // ---------- Poignée de la colonne des noms : glisser (souris, stylet, doigt), double-clic = largeur par défaut ----------
  // Même contrôleur que les barres ; memory.applyWidth = largeur posée par le dernier rendu (un nouveau rendu
  // pendant le glisser le poursuit), enregistrée au relâcher. Échap rend la largeur de départ.
  memory.applyWidth = applyWidth;
  if (memory.drag) el.querySelector('[data-resizer]')?.classList.add('is-dragging');
  function startResize(e, handle) {
    e.preventDefault();
    handle.focus({ preventScroll: true });
    const startW = widthInfo().value;
    const drag = { startW, last: startW };
    const stop = (persist) => {
      memory.drag = null;
      document.querySelector('[data-resizer].is-dragging')?.classList.remove('is-dragging');
      if (persist && drag.last !== drag.startW) memory.applyWidth(drag.last, true);
    };
    trackPointer(e, {
      immediate: true, // poignée en touch-action: none : le doigt la saisit sans appui long
      onStart: () => {
        memory.drag = drag;
        handle.classList.add('is-dragging');
      },
      onMove: (_m, dx) => {
        drag.last = memory.applyWidth(drag.startW + dx, false);
      },
      onDrop: () => stop(true),
      onCancel: (why) => {
        if (why === 'escape') {
          drag.last = memory.applyWidth(drag.startW, false);
          stop(false);
        } else stop(true);
      },
    });
  }
  el.onpointerdown = (e) => {
    if (e.button !== 0 || memory.drag) return;
    const handle = e.target.closest?.('[data-resizer]');
    if (handle) return void startResize(e, handle);
    const bar = e.target.closest?.('[data-drag]');
    // Appui hors de la barre choisie au doigt : elle ne l'est plus
    if (memory.touchSel !== null && rows[Number(bar?.dataset.drag)]?.key !== memory.touchSel)
      memory.dragView?.select(null);
    if (bar && !e.ctrlKey && !e.metaKey && !e.altKey) startBarDrag(e, bar);
  };
  // ---------- Menu de ligne (Maj+F10, touche Menu, clic droit sur une ligne glissable) ----------
  /**
   * Ouvre le menu d'une ligne glissable : « Déplacer les dates », « Changer le début », « Changer l’échéance »
   * (pas pour un jalon), « Ouvrir la fiche ». Faux si non glissable.
   */
  function openRowMenu(i) {
    const r = rows[i];
    const rowEl = el.querySelector(`[data-row="${i}"]`);
    const anchor = rowEl?.querySelector('[data-drag]');
    const target = r && anchor && ctx.dates && !memory.gesture && !memory.saving ? ctx.dates.target(r.node) : null;
    if (!target?.ok) return false;
    const { key } = r;
    const title = r.node.title || label('common.untitled');
    openStatusPopover({
      anchor,
      returnFocus: rowEl,
      title,
      menuLabel: label('gantt.menu', { titre: title }),
      heading: label('gantt.menu.title'),
      items: [
        { value: 'move', text: label('gantt.menu.dates') },
        ...keyEdges(target)
          .filter((edge) => edge !== 'move')
          .map((edge) => ({ value: edge, text: label(`gantt.menu.${edge}`) })),
        { value: 'open', text: label('gantt.menu.open') },
      ],
      start: 0,
      // Ligne retrouvée par sa clé au choix : un rendu a pu avoir lieu entre-temps
      onPick: (v) => {
        if (v === 'open') ctx.openDetail(r.node.ref);
        else memory.dragView?.keyStartKey(key, v);
      },
    });
    rowMenuOpen = true;
    return true;
  }
  el.oncontextmenu = (e) => {
    // Mode clavier : ni menu de ligne ni menu du navigateur (Maj+F10, touche Menu)
    if (memory.gesture?.keyboard) return void e.preventDefault();
    const row = e.target.closest?.('[data-row]');
    if (!row || !ctx.dates || memory.gesture || isStatusPopoverOpen()) {
      if (row && isStatusPopoverOpen()) e.preventDefault(); // « contextmenu » qui suit Maj+F10 : menu déjà ouvert
      return;
    }
    if (openRowMenu(Number(row.dataset.row))) e.preventDefault();
  };

  el.ondblclick = (e) => {
    if (e.target.closest?.('[data-resizer]')) applyWidth(null, true);
  };

  // Fenêtre redimensionnée : largeur affichée rebornée à 60 % de la nouvelle vue (préférence inchangée)
  window.addEventListener?.(
    'resize',
    () => el.isConnected && gen === memory.generation && !memory.drag && applyWidth(st.labelWidth, false),
    { passive: true, signal: off.signal },
  );

  // Passage liste ↔ arbre quand la largeur franchit 768 px (écouteur retiré au rendu suivant)
  narrow?.addEventListener?.('change', () => el.isConnected && gen === memory.generation && paint(), {
    signal: off.signal,
  });

  paint();
}
