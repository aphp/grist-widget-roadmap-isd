/**
 * Vue Gantt (lecture seule) : arbre catégorie → projet → chantier → tâche → sous-tâche, une ligne par élément,
 * barres positionnées en % de la fenêtre (un seul passage innerHTML, écouteurs délégués), export PDF.
 */
import { raw } from '../core/sanitize.js';
import { formatDateFr } from '../core/dates.js';
import {
  COLOR_BY,
  DEFAULT_LEVEL,
  GANTT_LEVELS,
  PHASES,
  SCALES,
  STATUS_COLORS,
  barGeometry,
  chronoItems,
  colorKey,
  expandableKeys,
  ganttRows,
  levelExpanded,
  isEmptyContainer,
  isLate,
  isMilestone,
  nodeBar,
  pctOf,
  pdfFilenameOfDay,
  phaseOf,
  prunedExpanded,
  shiftAnchor,
  timeScale,
  todayAnchor,
} from '../core/gantt-data.js';
import { h, icon, keepFocus, statusBadge } from '../ui/kit.js';
import { viewHeading } from '../ui/heading.js';
import { label, statusLabel } from '../labels.js';
import { VIZ_PRINT } from '../ui/viz-palette.js';

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
/** État conservé entre deux rendus de la vue (rechargement des données) : période affichée et génération. */
const memory = { anchor: null, scale: null, generation: 0 };
/** Écouteurs focusin / focusout par conteneur, pour ne jamais les empiler. */
const listeners = new WeakMap();

const pct = (x) => `${Math.round(x * 1000) / 1000}%`;

function colorName(key, colorBy) {
  if (colorBy === 'status') return key === 'other' ? label('gantt.status.other') : statusLabel(key);
  return label(`gantt.phase.${key}`);
}

/** Classe de couleur : un statut hors des quatre connus est dessiné creux (distinct de « À faire »). */
const fillOf = (ck, colorBy) => (colorBy === 'status' && ck === 'other' ? 'hollow' : ck);

function datesText(bar) {
  if (!bar) return label('gantt.noDates');
  const d =
    bar.start === bar.end
      ? label('gantt.date', { date: formatDateFr(bar.start) })
      : label('gantt.dates', { debut: formatDateFr(bar.start), fin: formatDateFr(bar.end) });
  return bar.deduced ? `${label('gantt.deduced')} : ${d.charAt(0).toLowerCase()}${d.slice(1)}` : d;
}

/** Description complète d'une ligne (infobulle et nom accessible des barres). */
function describe(ctx, r, colorBy) {
  const n = r.node;
  const bar = nodeBar(n);
  const parts = [`${label(`gantt.kind.${n.kind}`)} : ${n.title || label('common.untitled')}`, datesText(bar)];
  if (n.status) parts.push(label('gantt.status', { statut: statusLabel(n.status) }));
  if (LEAF_KINDS.has(n.kind) && colorBy === 'phase')
    parts.push(label('gantt.phase', { etape: colorName(phaseOf(n.title) ?? 'other', 'phase') }));
  if (isEmptyContainer(n)) parts.push(label('gantt.noTasks'));
  if (isMilestone(ctx.model, n)) parts.push(label('gantt.milestone'));
  if (isLate(ctx.model, n, ctx.today)) parts.push(label('gantt.late'));
  return parts.join('. ');
}

function tipHtml(ctx, r, colorBy) {
  const n = r.node;
  const bar = nodeBar(n);
  const late = isLate(ctx.model, n, ctx.today);
  const ms = isMilestone(ctx.model, n);
  const ck = colorKey(n, colorBy);
  const showColor = LEAF_KINDS.has(n.kind);
  return h`<span class="gtip__kind">${label(`gantt.kind.${n.kind}`)}</span>
    <strong class="gtip__title">${n.title || label('common.untitled')}</strong>
    <span class="gtip__line">${datesText(bar)}</span>
    ${n.status || late || ms ? h`<span class="gtip__badges">${n.status ? statusBadge(n.status) : ''}${ms ? h`<span class="fr-badge fr-badge--sm fr-badge--no-icon fr-badge--purple-glycine">${label('gantt.milestone')}</span>` : ''}${late ? h`<span class="fr-badge fr-badge--sm fr-badge--error">${label('gantt.late')}</span>` : ''}</span>` : ''}
    ${showColor ? h`<span class="gtip__line"><span class="gswatch gswatch--${fillOf(ck, colorBy)}" aria-hidden="true"></span>${colorBy === 'phase' ? label('gantt.phase', { etape: colorName(ck, colorBy) }) : label('gantt.status', { statut: colorName(ck, colorBy) })}</span>` : ''}`;
}

function trackHtml(ctx, r, i, scale, colorBy) {
  const n = r.node;
  const bar = nodeBar(n);
  if (!bar) return h`<span class="grow__nodates">${label('gantt.noDates')}</span>`;
  const desc = describe(ctx, r, colorBy);
  const ms = isMilestone(ctx.model, n);
  const g = ms ? barGeometry(scale, bar.end, bar.end) : barGeometry(scale, bar.start, bar.end);
  if (g.outside) {
    const date = formatDateFr(g.outside === 'before' ? bar.end : bar.start);
    const text = label(g.outside === 'before' ? 'gantt.before' : 'gantt.after', { date });
    return h`<button type="button" class="gout gout--${g.outside}" data-i="${i}" tabindex="-1" aria-label="${desc}. ${text}">${icon(g.outside === 'before' ? 'arrow-left-s-line' : 'arrow-right-s-line')}<span class="gout__text">${date}</span></button>`;
  }
  const late = isLate(ctx.model, n, ctx.today);
  const ck = LEAF_KINDS.has(n.kind) ? fillOf(colorKey(n, colorBy), colorBy) : 'summary';
  if (ms)
    return h`<button type="button" class="gms gms--${ck}${late ? ' is-late' : ''}" style="left:${pct(g.left + g.width / 2)}" data-i="${i}" tabindex="-1" aria-label="${desc}"></button>`;
  const cls = [
    'gbar',
    `gbar--${ck}`,
    LEAF_KINDS.has(n.kind) ? '' : 'gbar--summary',
    bar.deduced ? 'gbar--deduced' : '',
    late ? 'is-late' : '',
    g.clipStart ? 'gbar--clip-start' : '',
    g.clipEnd ? 'gbar--clip-end' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const text = LEAF_KINDS.has(n.kind) ? barText(n, colorBy) : '';
  return h`<button type="button" class="${cls}" style="left:${pct(g.left)};width:${pct(g.width)}" data-i="${i}" tabindex="-1" aria-label="${desc}">${text ? h`<span class="gbar__text" aria-hidden="true">${text}</span>` : ''}</button>`;
}

/** Nom écrit dans la barre (masqué par le CSS si la barre est trop étroite) : étape connue, ou statut. */
function barText(n, colorBy) {
  if (colorBy === 'status') return n.status ? statusLabel(n.status) : '';
  const phase = phaseOf(n.title);
  return phase ? colorName(phase, 'phase') : '';
}

/**
 * Ligne de l'arbre (role="row" d'un treegrid) : la ligne elle-même porte le focus (un seul arrêt de tabulation
 * pour tout l'arbre, focus itinérant), son niveau, sa position dans la fratrie et son état déplié.
 * Flèche et titre restent cliquables à la souris ; au clavier : ←/→, ↑/↓, Début/Fin, Entrée.
 */
function rowHtml(ctx, r, i, scale, colorBy, focusIndex) {
  const n = r.node;
  const title = n.title || label('common.untitled');
  const toggle = r.hasChildren
    ? h`<span class="grow__toggle fr-icon-arrow-${r.expanded ? 'down' : 'right'}-s-line" data-toggle="${i}" data-expanded="${r.expanded}" title="${label(r.expanded ? 'gantt.collapse' : 'gantt.expand', { titre: title })}" aria-hidden="true"></span>`
    : h`<span class="grow__toggle grow__toggle--leaf" aria-hidden="true"></span>`;
  const name = n.ref
    ? h`<span class="grow__title" data-open="${i}" data-i="${i}">${title}</span>`
    : h`<span class="grow__title grow__title--static" data-i="${i}">${title}</span>`;
  const empty = isEmptyContainer(n) ? h`<span class="grow__empty">${label('gantt.noTasks')}</span>` : '';
  return h`<div class="grow grow--${n.kind}" role="row" id="gr-${r.key}" data-i="${i}" data-row="${i}" tabindex="${i === focusIndex ? 0 : -1}" aria-level="${r.depth + 1}" aria-posinset="${r.posinset}" aria-setsize="${r.setsize}" ${raw(r.hasChildren ? `aria-expanded="${r.expanded}"` : '')} aria-label="${describe(ctx, r, colorBy)}">
    <div class="grow__label" role="gridcell" style="--depth:${r.depth}">${toggle}${name}${empty}</div>
    <div class="grow__track" role="gridcell">${trackHtml(ctx, r, i, scale, colorBy)}</div>
  </div>`;
}

/** Liste chronologique (petits écrans) : titre, chemin, dates, étape ou statut, barre mini dans la fenêtre. */
function listHtml(ctx, items, colorBy) {
  if (!items.length) return h`<p class="glist__empty">${label('gantt.list.none')}</p>`;
  return h`<ol class="list glist" aria-label="${label('gantt.list.label')}">
    ${items.slice(0, LIST_MAX).map((it) => {
      const n = it.node;
      const title = n.title || label('common.untitled');
      const ck = fillOf(colorKey(n, colorBy), colorBy);
      const late = isLate(ctx.model, n, ctx.today);
      const ms = isMilestone(ctx.model, n);
      const g = it.geometry;
      const tone = barText(n, colorBy);
      return h`<li class="glist__item${late ? ' glist__item--late' : ''}">
        ${n.ref ? h`<button type="button" class="glist__title" data-open-key="${it.key}">${title}</button>` : h`<span class="glist__title">${title}</span>`}
        ${it.path.length ? h`<span class="glist__path">${it.path.join(' › ')}</span>` : ''}
        <span class="glist__meta"><span>${datesText(it.bar)}</span>${tone ? h`<span>${tone}</span>` : ''}${ms ? h`<span class="fr-badge fr-badge--sm fr-badge--no-icon fr-badge--purple-glycine">${label('gantt.milestone')}</span>` : ''}${late ? h`<span class="fr-badge fr-badge--sm fr-badge--error">${label('gantt.late')}</span>` : ''}</span>
        <span class="glist__track" aria-hidden="true"><span class="glist__bar gbar--${ck}${it.bar.deduced ? ' glist__bar--deduced' : ''}" style="left:${pct(g.left)};width:${pct(g.width)}"></span></span>
      </li>`;
    })}
  </ol>
  ${items.length > LIST_MAX ? h`<p class="glist__more">${label('gantt.list.more', { n: (items.length - LIST_MAX).toLocaleString('fr-FR') })}</p>` : ''}`;
}

function legendHtml(colorBy) {
  const keys = colorBy === 'phase' ? [...PHASES, 'other'] : [...STATUS_COLORS, 'other'];
  return h`<ul class="list gantt__legend" aria-label="${label('gantt.legend')}">
    ${keys.map((k) => h`<li><span class="gswatch gswatch--${fillOf(k, colorBy)}" aria-hidden="true"></span>${colorName(k, colorBy)}</li>`)}
    <li title="${label('gantt.deduced.help')}"><span class="gswatch gswatch--deduced" aria-hidden="true"></span>${label('gantt.deduced')}</li>
    <li><span class="gswatch gswatch--milestone" aria-hidden="true"></span>${label('gantt.milestone')}</li>
    <li><span class="gswatch gswatch--late" aria-hidden="true"></span>${label('gantt.late')}</li>
    <li><span class="gswatch gswatch--today" aria-hidden="true"></span>${label('gantt.todayLine')}</li>
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
  return [
    ...keys.map((k) => ({
      label: colorName(k, colorBy),
      color: PRINT_OF[k],
      mark: fillOf(k, colorBy) === 'hollow' ? 'outline' : 'box',
    })),
    { label: label('gantt.deduced'), color: VIZ_PRINT.summary, mark: 'light' },
    { label: label('gantt.milestone'), color: VIZ_PRINT.summary, mark: 'diamond' },
    { label: label('gantt.late'), color: VIZ_PRINT.late, mark: 'outline' },
    { label: label('gantt.todayLine'), color: VIZ_PRINT.today, mark: 'line' },
  ];
}

function headHtml(scale, today) {
  const showToday = today >= scale.start && today <= scale.end;
  return h`<div class="gantt__head" role="row">
    <div class="gantt__corner" role="columnheader">${label('gantt.element')}</div>
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
  const tree = ctx.view.tree;
  const searching = Boolean(saved.filters?.search);
  const scaleMode = SCALES.includes(saved.ganttScale) ? saved.ganttScale : 'month';
  const level =
    GANTT_LEVELS.includes(saved.ganttLevel) || saved.ganttLevel === 'custom' ? saved.ganttLevel : DEFAULT_LEVEL;
  const narrow = typeof window !== 'undefined' ? window.matchMedia?.(NARROW) : null;
  const st = {
    scale: scaleMode,
    colorBy: COLOR_BY.includes(saved.ganttColorBy) ? saved.ganttColorBy : 'phase',
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
    /** Ligne qui porte le focus itinérant (seul arrêt de tabulation de l'arbre). */
    focusKey: null,
    notice: '',
    busy: false,
  };
  let rows = [];
  let items = [];
  let scale = null;

  const persistExpanded = () => {
    if (searching) return;
    // Clés du modèle entier (et non de l'arbre filtré) : un projet masqué par un filtre garde son dépliage
    const valid = new Set(expandableKeys(ctx.model.tree));
    ctx.setPrefs?.({ ganttLevel: 'custom', ganttExpanded: prunedExpanded(st.expanded, valid) });
  };

  function paint() {
    const box = el.querySelector('.gantt__scroll');
    const top = box?.scrollTop ?? 0;
    const left = box?.scrollLeft ?? 0;
    const isList = Boolean(narrow?.matches);
    scale = timeScale(st.scale, st.anchor);
    rows = isList ? [] : ganttRows(tree, st.expanded);
    items = isList ? chronoItems(tree, scale) : [];
    memory.anchor = st.anchor;
    memory.scale = st.scale;
    let focusIndex = rows.findIndex((r) => r.key === st.focusKey);
    if (focusIndex < 0) focusIndex = 0;
    const n = isList ? items.length : rows.length;
    const count = isList
      ? n === 1
        ? label('gantt.list.one')
        : label('gantt.list.count', { n: n.toLocaleString('fr-FR') })
      : n === 1
        ? label('gantt.rows.one')
        : label('gantt.rows', { n: n.toLocaleString('fr-FR') });
    const shownLevel = searching ? null : st.level;
    keepFocus(
      el,
      h`<div class="gantt">
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
                  ? listHtml(ctx, items, st.colorBy)
                  : h`<div class="gantt__empty">
                    <p class="gantt__empty-title">${label('gantt.empty')}</p>
                    <p>${label('gantt.empty.hint')}</p>
                    <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-action="clear-filters">${label('empty.filters.action')}</button>
                  </div>`
              }</div>`
            : h`<div class="gantt__scroll" tabindex="-1">
          <div class="gantt__grid" role="treegrid" aria-label="${label('gantt.label')}" aria-describedby="gantt-help" style="--timeline-min:${TIMELINE_MIN[st.scale]}px">
            ${headHtml(scale, ctx.today)}
            <div class="gantt__body" role="rowgroup">
              ${linesHtml(scale, ctx.today)}
              ${
                rows.length
                  ? raw(rows.map((r, i) => rowHtml(ctx, r, i, scale, st.colorBy, focusIndex)).join(''))
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
      </div>`.toString(),
    );
    const nb = el.querySelector('.gantt__scroll');
    if (nb) {
      nb.scrollTop = top;
      nb.scrollLeft = left;
    }
    // Le focus rendu par keepFocus garde son infobulle
    const act = document.activeElement;
    if (act && el.contains(act) && act.dataset.i !== undefined) showTip(act);
  }

  // ---------- Infobulle (survol et focus) ----------
  let tipFor = null;
  function showTip(target) {
    const i = Number(target.dataset.i);
    const r = rows[i];
    const tip = el.querySelector('#gantt-tip');
    if (!r || !tip) return;
    tipFor = target;
    tip.innerHTML = tipHtml(ctx, r, st.colorBy).toString();
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
  }
  function hideTip() {
    tipFor = null;
    const tip = el.querySelector('#gantt-tip');
    if (tip) tip.hidden = true;
  }
  el.onpointerover = (e) => {
    const t = e.target.closest?.('[data-i]:not([role="row"])');
    if (t && t !== tipFor) showTip(t);
    else if (!t && tipFor && !el.contains(document.activeElement)) hideTip();
  };
  el.onpointerleave = () => {
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
      const t = e.target.closest?.('[data-i]');
      if (t) showTip(t);
      else hideTip();
    },
    { signal: off.signal },
  );
  el.addEventListener(
    'focusout',
    (e) => {
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
    const row = e.target.closest?.('[data-row]');
    if (!row || e.altKey || e.ctrlKey || e.metaKey) return;
    const i = Number(row.dataset.row);
    const r = rows[i];
    if (!r) return;
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

  // Passage liste ↔ arbre quand la largeur franchit 768 px (écouteur retiré au rendu suivant)
  narrow?.addEventListener?.('change', () => el.isConnected && gen === memory.generation && paint(), {
    signal: off.signal,
  });

  paint();
}
