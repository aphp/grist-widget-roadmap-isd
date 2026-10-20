/**
 * Vue Portfolio (lecture seule) : indicateurs du périmètre, puis quatre sous-vues — frises des projets,
 * des chantiers et des tâches (une ligne par élément), et charge hebdomadaire par profil comparée à la capacité.
 * Un passage innerHTML par rendu, écouteurs délégués sur le conteneur, export PDF.
 */
import { raw } from '../core/sanitize.js';
import { DAY_MS, MONTHS_FR, dayOfIso, formatDateFr, isoOfDay } from '../core/dates.js';
import { hoursToEtp } from '../core/capacity.js';
import { ETP_ROLES, PROFILE_KEYS, profileKey } from '../core/kanban-data.js';
import { barGeometry, isoWeek, pctOf, pdfFilenameOfDay } from '../core/gantt-data.js';
import {
  PORTFOLIO_MONTHS,
  PORTFOLIO_TABS,
  TAB_KIND,
  defaultStart,
  loadRate,
  portfolioItems,
  portfolioKpis,
  portfolioScale,
  summarizeWeeks,
  weekCount,
  weeklyLoadByProfile,
} from '../core/portfolio-data.js';
import { h, icon, keepFocus, statusBadge } from '../ui/kit.js';
import { viewHeading } from '../ui/heading.js';
import { label } from '../labels.js';
import { VIZ_PRINT } from '../ui/viz-palette.js';

export const id = 'portfolio';

/** Lignes affichées d'emblée dans une frise ; « Afficher plus » ajoute un lot. */
const PAGE = 150;
/** Hauteurs de ligne (px), identiques au CSS : coupent les pages du PDF entre deux lignes. */
const ROW_PX = Object.freeze({ timeline: 40, load: 44 });
/** Couleur de chaque profil : rang dans la palette partagée (--viz-1 … --viz-4), --viz-mgmt pour le Management. */
const PROFILE_SLOT = Object.freeze({ PO: 1, DA: 2, DS: 3, DE: 4, Mgmt: 'mgmt' });
/** État conservé entre deux rendus (rechargement des données) : recherche locale par sous-vue et génération. */
const memory = { query: { projets: '', chantiers: '', taches: '' }, generation: 0 };

const etpFormat = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const intFormat = new Intl.NumberFormat('fr-FR');
const pct = (x) => `${Math.round(x * 1000) / 1000}%`;
const etpOfWeek = (hours) => etpFormat.format(hoursToEtp(hours, 7));

function datesText(bar) {
  if (!bar) return label('portfolio.noDates');
  return bar.start === bar.end
    ? label('gantt.date', { date: formatDateFr(bar.start) })
    : label('gantt.dates', { debut: formatDateFr(bar.start), fin: formatDateFr(bar.end) });
}

// ---------- Indicateurs ----------
function kpisHtml(k) {
  const tile = (name, value, hint) =>
    h`<li class="pf-kpi"><p class="pf-kpi__label">${label(name)}</p><p class="pf-kpi__value">${intFormat.format(value)}</p>${hint}</li>`;
  const people = h`<ul class="list pf-kpi__profiles">${PROFILE_KEYS.map(
    (r) =>
      h`<li><span class="pf-swatch pf-swatch--${r}" aria-hidden="true"></span>${label('portfolio.kpi.people.detail', { profil: label(`profile.${r}`), n: k.personnes[r] })}</li>`,
  )}</ul>`;
  return h`<ul class="list pf-kpis" aria-label="${label('portfolio.kpis')}">
    ${tile('portfolio.kpi.projets', k.projets, h`<p class="pf-kpi__hint">${label('portfolio.kpi.projets.hint')}</p>`)}
    ${tile('portfolio.kpi.chantiers', k.chantiers, h`<p class="pf-kpi__hint">${label('portfolio.kpi.chantiers.hint')}</p>`)}
    ${tile('portfolio.kpi.tasks', k.taches, h`<p class="pf-kpi__hint">${label('portfolio.kpi.tasks.hint')}</p>`)}
    ${tile('portfolio.kpi.people', k.personnes.total, h`<p class="pf-kpi__hint">${label('portfolio.kpi.people.hint')}</p>${people}`)}
  </ul>`;
}

// ---------- Frises ----------
function scaleHeadHtml(scale, today) {
  const showToday = today >= scale.start && today <= scale.end;
  const w = (a, b) => pct(((b - a + 1) / scale.days) * 100);
  return h`<div class="pf-tl__head" aria-hidden="true">
    <div class="pf-tl__corner">${label('portfolio.element')}</div>
    <div class="pf-tl__scale">
      <div class="pf-tl__groups">${scale.groups.map((g) => h`<span class="pf-tl__group" style="left:${pct(pctOf(scale, g.start))};width:${w(g.start, g.end)}">${g.label}</span>`)}</div>
      <div class="pf-tl__cols">${scale.columns.map((c) => h`<span class="pf-tl__col${today >= c.start && today <= c.end ? ' is-current' : ''}" style="left:${pct(pctOf(scale, c.start))};width:${w(c.start, c.end)}">${c.label}</span>`)}</div>
      ${showToday ? h`<span class="pf-tl__flag" style="left:${pct(pctOf(scale, today) + 50 / scale.days)}"></span>` : ''}
    </div>
  </div>`;
}

function linesHtml(scale, today) {
  const showToday = today >= scale.start && today <= scale.end;
  return h`<div class="pf-tl__lines" aria-hidden="true">
    ${scale.columns.slice(1).map((c) => h`<span class="pf-tl__line" style="left:${pct(pctOf(scale, c.start))}"></span>`)}
    ${showToday ? h`<span class="pf-tl__today" style="left:${pct(pctOf(scale, today) + 50 / scale.days)}"></span>` : ''}
  </div>`;
}

function trackHtml(item, scale) {
  if (!item.bar) return h`<span class="pf-tl__nodates">${label('portfolio.noDates')}</span>`;
  const g = barGeometry(scale, item.bar.start, item.bar.end);
  if (g.outside) {
    const date = formatDateFr(g.outside === 'before' ? item.bar.end : item.bar.start);
    return h`<span class="pf-tl__out pf-tl__out--${g.outside}">${icon(g.outside === 'before' ? 'arrow-left-s-line' : 'arrow-right-s-line')}${label(g.outside === 'before' ? 'portfolio.before' : 'portfolio.after', { date })}</span>`;
  }
  const cls = [
    'pf-tl__bar',
    item.bar.deduced ? 'pf-tl__bar--deduced' : '',
    g.clipStart ? 'is-clip-start' : '',
    g.clipEnd ? 'is-clip-end' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return h`<span class="${cls}" style="left:${pct(g.left)};width:${pct(g.width)}" data-bar="${item.i}"></span>`;
}

function timelineRowHtml(item, scale) {
  const title = item.title || label('common.untitled');
  return h`<li class="pf-tl__row">
    <div class="pf-tl__label">
      <button type="button" class="pf-tl__title" id="pf-row-${item.i}" data-open="${item.i}">
        <span class="pf-tl__name">${title}</span>
        ${item.context ? h`<span class="pf-tl__context">${item.context}</span>` : ''}
        <span class="fr-sr-only">. ${datesText(item.bar)}${item.bar?.deduced ? ` (${label('portfolio.legend.deduced').toLowerCase()})` : ''}</span>
      </button>
      <span class="pf-tl__status">${item.status ? statusBadge(item.status) : ''}</span>
    </div>
    <div class="pf-tl__track">${trackHtml(item, scale)}</div>
  </li>`;
}

function timelineLegendHtml() {
  return h`<ul class="list pf-legend" aria-label="${label('portfolio.legend')}">
    <li><span class="pf-swatch pf-swatch--bar" aria-hidden="true"></span>${label('portfolio.legend.period')}</li>
    <li><span class="pf-swatch pf-swatch--deduced" aria-hidden="true"></span>${label('portfolio.legend.deduced')}</li>
    <li><span class="pf-swatch pf-swatch--today" aria-hidden="true"></span>${label('portfolio.legend.today')}</li>
  </ul>`;
}

function timelineHtml(ctx, st, items, scale) {
  const tab = st.tab;
  const query = memory.query[tab];
  const shown = items.slice(0, st.limit);
  const rest = items.length - shown.length;
  const count =
    items.length === 1 ? label('portfolio.rows.one') : label('portfolio.rows', { n: intFormat.format(items.length) });
  let body;
  if (!items.length && query)
    body = h`<div class="pf-empty"><p class="pf-empty__title">${label('portfolio.empty.search', { q: query })}</p><p>${label('portfolio.empty.search.hint')}</p>
      <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-clear-search>${label('portfolio.empty.search.action')}</button></div>`;
  else if (!items.length)
    body = h`<div class="pf-empty"><p class="pf-empty__title">${label('portfolio.empty.kind')}</p><p>${label('portfolio.empty.kind.hint')}</p>
      <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-action="clear-filters">${label('empty.filters.action')}</button></div>`;
  else
    body = h`<div class="pf-tl__scroll" tabindex="-1">
      <div class="pf-tl" style="--tl-min:${st.months * 64}px">
        ${scaleHeadHtml(scale, ctx.today)}
        <div class="pf-tl__body">
          ${linesHtml(scale, ctx.today)}
          <ul class="list" aria-label="${label(`portfolio.tab.${tab}`)}">${raw(shown.map((it) => timelineRowHtml(it, scale)).join(''))}</ul>
        </div>
      </div>
    </div>
    ${rest > 0 ? h`<button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary pf-more" id="pf-more" data-more>${label('portfolio.more', { n: intFormat.format(Math.min(rest, PAGE)) })}</button>` : ''}`;
  return h`<div class="pf-info">${timelineLegendHtml()}<p class="pf-count" role="status">${count}</p></div>${body}`;
}

// ---------- Charge ----------
function rateText(r) {
  return r.rate === null ? '' : label('portfolio.load.rate', { n: Math.round(r.rate * 100) });
}

function cellHtml(load, capacity, extra = '') {
  const r = loadRate(load, capacity);
  const charge = etpOfWeek(load);
  const capacite = etpOfWeek(capacity);
  if (r.level === 'none')
    return h`<td class="pf-load__cell pf-load__cell--none${extra}"><span aria-hidden="true">—</span><span class="fr-sr-only">${label('portfolio.load.level.none')}</span></td>`;
  return h`<td class="pf-load__cell pf-load__cell--${r.level}${extra}">
    <span class="pf-load__value" aria-hidden="true">${label('portfolio.load.cell', { charge, capacite })}</span>
    <span class="pf-load__rate">${r.level === 'over' ? icon('warning-fill', 'pf-load__warn') : ''}${r.rate === null ? label('portfolio.load.noCapacity') : rateText(r)}</span>
    <span class="fr-sr-only">${label('portfolio.load.cellSr', { charge, capacite })}, ${label(`portfolio.load.level.${r.level}`)}</span>
  </td>`;
}

/**
 * Total, barre et repère de capacité : profils ISD seulement (TOTAL_KEYS). Le Management garde sa colonne et sa
 * carte : sa capacité, rarement chargée, ferait baisser mécaniquement le taux de l'équipe.
 */
const TOTAL_KEYS = ETP_ROLES;

function loadRowHtml(row, max, today) {
  const load = TOTAL_KEYS.reduce((s, k) => s + row[k], 0);
  const capacity = TOTAL_KEYS.reduce((s, k) => s + row.capacity[k], 0);
  const { week } = isoWeek(row.weekStart);
  const current = today >= row.weekStart && today <= row.weekStart + 6;
  const seg = TOTAL_KEYS.filter((k) => row[k] > 0).map(
    (k) => h`<span class="pf-seg pf-seg--${k}" style="width:${pct((row[k] / max) * 100)}"></span>`,
  );
  return h`<tr class="pf-load__row${current ? ' is-current' : ''}">
    <th scope="row" class="pf-load__week" title="${label('portfolio.load.weekTitle', { n: week, debut: formatDateFr(row.weekStart), fin: formatDateFr(row.weekStart + 6) })}">
      ${label('portfolio.load.weekLabel', { n: week, date: formatDateFr(row.weekStart).replace(/ \d{4}$/, '') })}${current ? h` <span class="fr-sr-only">${label('portfolio.load.current')}</span>` : ''}
    </th>
    <td class="pf-load__chart" aria-hidden="true">
      <span class="pf-stack">${seg}${capacity > 0 ? h`<span class="pf-cap" style="left:${pct((capacity / max) * 100)}"></span>` : ''}</span>
    </td>
    ${PROFILE_KEYS.map((k) => raw(cellHtml(row[k], row.capacity[k], ' pf-load__prof')))}
    ${raw(cellHtml(load, capacity))}
  </tr>`.toString();
}

/** « du 9 au 15 nov. » ou « du 28 sept. au 4 oct. ». */
function weekRange(start) {
  const a = new Date(start * DAY_MS);
  const b = new Date((start + 6) * DAY_MS);
  const ma = MONTHS_FR[a.getUTCMonth()];
  const mb = MONTHS_FR[b.getUTCMonth()];
  return ma === mb
    ? label('portfolio.range', { debut: a.getUTCDate(), fin: `${b.getUTCDate()} ${mb}` })
    : label('portfolio.range', { debut: `${a.getUTCDate()} ${ma}`, fin: `${b.getUTCDate()} ${mb}` });
}

const weeksText = (n) => (n <= 1 ? label('portfolio.sum.week.one', { n }) : label('portfolio.sum.weeks', { n }));

function summaryHtml(ctx, rows) {
  const t = summarizeWeeks(rows);
  const people = Object.fromEntries(PROFILE_KEYS.map((k) => [k, 0]));
  for (const p of ctx.model.people.values()) {
    const key = profileKey(p, ctx.model);
    if (key) people[key]++;
  }
  return h`<ul class="list pf-sum" aria-label="${label('portfolio.load.summary')}">
    ${PROFILE_KEYS.map((k) => {
      const s = t[k];
      const nb = people[k];
      const peak = s.peak;
      const peakWeek = peak
        ? label('portfolio.sum.peakWeek', { n: isoWeek(peak.weekStart).week, periode: weekRange(peak.weekStart) })
        : '';
      const peakValue = peak ? (peak.rate === null ? label('portfolio.load.noCapacity') : rateText(peak)) : '';
      return h`<li class="pf-sum__item pf-sum__item--${s.level}">
        <p class="pf-sum__name"><span class="pf-swatch pf-swatch--${k}" aria-hidden="true"></span>${label(`profile.group.${k}`)}</p>
        ${
          peak
            ? h`<p class="pf-sum__value">${s.level === 'over' ? icon('warning-fill', 'pf-load__warn') : ''}${label('portfolio.sum.peak', { valeur: peakValue })}</p>
              <p class="pf-sum__rate">${label(`portfolio.load.level.${s.level}`)} ${peakWeek}</p>
              <p class="pf-sum__line">${label('portfolio.sum.over', { semaines: weeksText(s.overWeeks), total: s.loadedWeeks })}${s.tensionWeeks ? `, ${label('portfolio.sum.tension', { n: s.tensionWeeks })}` : ''}</p>
              <p class="pf-sum__line">${label('portfolio.sum.avg', { charge: etpOfWeek(s.avgLoaded.load), capacite: etpOfWeek(s.avgLoaded.capacity) })}</p>`
            : h`<p class="pf-sum__value">${label('portfolio.sum.none')}</p>`
        }
        <p class="pf-sum__hint">${nb === 0 ? label('portfolio.load.summary.people.none') : nb === 1 ? label('portfolio.load.summary.people.one') : label('portfolio.load.summary.people', { n: nb })}</p>
      </li>`;
    })}
  </ul>`;
}

function loadHtml(ctx, st, startDay) {
  const rows = weeklyLoadByProfile(ctx.model, ctx.view.taskIds, startDay, weekCount(startDay, st.months));
  const max = Math.max(
    1e-9,
    ...rows.map((r) =>
      Math.max(
        TOTAL_KEYS.reduce((s, k) => s + r[k], 0),
        TOTAL_KEYS.reduce((s, k) => s + r.capacity[k], 0),
      ),
    ),
  );
  return h`<p class="pf-scope">${label('portfolio.load.scope')}</p>
    <h3 class="pf-subtitle">${label('portfolio.load.summary')}</h3>
    ${summaryHtml(ctx, rows)}
    <h3 class="pf-subtitle">${label('portfolio.load.byWeek')}</h3>
    <div class="pf-info">
      <ul class="list pf-legend" aria-label="${label('portfolio.legend')}">
        ${TOTAL_KEYS.map((k) => h`<li><span class="pf-swatch pf-swatch--${k}" aria-hidden="true"></span>${label(`profile.group.${k}`)}</li>`)}
        <li><span class="pf-swatch pf-swatch--cap" aria-hidden="true"></span>${label('portfolio.load.capacity')}</li>
      </ul>
      <p class="pf-count">${label('portfolio.load.unit')} ${label('portfolio.load.thresholds')}</p>
    </div>
    <div class="pf-load__scroll" tabindex="0" role="region" aria-label="${label('portfolio.load.caption')}">
      <table class="pf-load">
        <caption class="fr-sr-only">${label('portfolio.load.caption')}</caption>
        <thead><tr>
          <th scope="col" class="pf-load__week">${label('portfolio.load.week')}</th>
          <th scope="col" class="pf-load__chart"><span aria-hidden="true">${label('portfolio.load.chart')}</span></th>
          ${PROFILE_KEYS.map((k) => h`<th scope="col" class="pf-load__cell pf-load__prof"><span class="pf-swatch pf-swatch--${k}" aria-hidden="true"></span>${label(`profile.${k}`)}</th>`)}
          <th scope="col" class="pf-load__cell" title="${label('portfolio.load.total.title')}">${label('portfolio.load.total')}</th>
        </tr></thead>
        <tbody>${raw(rows.map((r) => loadRowHtml(r, max, ctx.today)).join(''))}</tbody>
      </table>
    </div>`;
}

// ---------- PDF ----------
const PROFILE_PRINT = Object.freeze(Object.fromEntries(PROFILE_KEYS.map((k) => [k, VIZ_PRINT[PROFILE_SLOT[k]]])));

function pdfLegend(tab) {
  if (tab === 'load')
    return [
      ...TOTAL_KEYS.map((k) => ({ label: label(`profile.group.${k}`), color: PROFILE_PRINT[k], mark: 'box' })),
      { label: label('portfolio.load.capacity'), color: VIZ_PRINT.summary, mark: 'line' },
    ];
  return [
    { label: label('portfolio.legend.period'), color: VIZ_PRINT[1], mark: 'box' },
    { label: label('portfolio.legend.deduced'), color: VIZ_PRINT.summary, mark: 'light' },
    { label: label('portfolio.legend.today'), color: VIZ_PRINT.today, mark: 'line' },
  ];
}

/**
 * @param {HTMLElement} el
 * @param {object} ctx contexte fourni par main.js
 */
export function render(el, ctx) {
  const gen = ++memory.generation;
  const saved = ctx.prefs ?? {};
  const st = {
    tab: PORTFOLIO_TABS.includes(saved.portfolioTab) ? saved.portfolioTab : 'projets',
    months: PORTFOLIO_MONTHS.includes(saved.portfolioMonths) ? saved.portfolioMonths : 12,
    start: typeof saved.portfolioStart === 'string' ? saved.portfolioStart : null,
    limit: PAGE,
    busy: false,
    notice: '',
  };
  const kpis = portfolioKpis(ctx.model, ctx.view);
  let items = [];

  const startDay = () => {
    const d = st.start ? dayOfIso(st.start) : NaN;
    return Number.isFinite(d) ? d : defaultStart(ctx.today);
  };

  function panelHtml() {
    const start = startDay();
    if (st.tab === 'load') return loadHtml(ctx, st, start);
    const scale = portfolioScale(start, st.months);
    items = portfolioItems(ctx.model, ctx.view.tree, TAB_KIND[st.tab], memory.query[st.tab]).map((it, i) => ({
      ...it,
      i,
    }));
    return timelineHtml(ctx, st, items, scale);
  }

  function periodText() {
    const scale = portfolioScale(startDay(), st.months);
    return label('portfolio.period', { debut: formatDateFr(scale.start), fin: formatDateFr(scale.end) });
  }

  /** Redessine seulement la sous-vue (la recherche garde son curseur). */
  function paintPanel() {
    const panel = el.querySelector('#pf-panel');
    if (!panel) return paint();
    keepFocus(panel, panelHtml().toString());
  }

  function paint() {
    const searchable = st.tab !== 'load';
    keepFocus(
      el,
      h`<div class="pf">
        ${viewHeading(
          label('heading.portfolio.title'),
          label('heading.portfolio.sub'),
          h`<button type="button" id="pf-pdf" class="fr-btn fr-btn--sm fr-btn--secondary fr-btn--icon-left fr-icon-download-line pf-pdf" data-pdf ${raw(st.busy ? 'disabled aria-busy="true"' : '')}>${label(st.busy ? 'portfolio.pdf.busy' : 'portfolio.pdf')}</button>`,
        )}
        ${kpisHtml(kpis)}
        <div class="pf-bar">
          <div class="pf-tabs" role="tablist" aria-label="${label('portfolio.tabs')}">
            ${PORTFOLIO_TABS.map(
              (t) =>
                h`<button type="button" role="tab" class="pf-tab" id="pf-tab-${t}" data-tab="${t}" aria-selected="${String(t === st.tab)}" aria-controls="pf-panel" tabindex="${t === st.tab ? '0' : '-1'}">${label(`portfolio.tab.${t}`)}</button>`,
            )}
          </div>
          <div class="pf-controls">
            ${
              searchable
                ? h`<div class="fr-input-group pf-field pf-field--search">
                    <label class="fr-label" for="pf-search">${label('portfolio.search')}</label>
                    <input class="fr-input" type="search" id="pf-search" value="${memory.query[st.tab]}" placeholder="${label('portfolio.search.placeholder')}" autocomplete="off" />
                  </div>`
                : ''
            }
            <div class="fr-input-group pf-field">
              <label class="fr-label" for="pf-start">${label('portfolio.start')}</label>
              <input class="fr-input" type="date" id="pf-start" value="${isoOfDay(startDay())}" required />
            </div>
            <fieldset class="fr-segmented fr-segmented--sm pf-field">
              <legend class="fr-segmented__legend pf-field__legend">${label('portfolio.duration')}</legend>
              <div class="fr-segmented__elements">
                ${PORTFOLIO_MONTHS.map(
                  (n) => h`<div class="fr-segmented__element">
                    <input type="radio" name="pf-months" id="pf-months-${n}" value="${n}" data-months ${raw(n === st.months ? 'checked' : '')} />
                    <label class="fr-label" for="pf-months-${n}">${label('portfolio.months', { n })}</label>
                  </div>`,
                )}
              </div>
            </fieldset>
          </div>
        </div>
        <p class="pf-period" aria-live="polite">${periodText()}${st.notice ? h` <span class="pf-notice">— ${st.notice}</span>` : ''}</p>
        <div class="pf-panel" id="pf-panel" role="tabpanel" aria-labelledby="pf-tab-${st.tab}" data-tab="${st.tab}">${panelHtml()}</div>
      </div>`.toString(),
    );
  }

  function selectTab(t, focus) {
    if (!PORTFOLIO_TABS.includes(t)) return;
    if (t !== st.tab) {
      st.tab = t;
      st.limit = PAGE;
      ctx.setPrefs?.({ portfolioTab: t });
      paint();
    }
    if (focus) el.querySelector(`#pf-tab-${t}`)?.focus();
  }

  // ---------- Export PDF ----------
  /** Copie hors écran (indicateurs + sous-vue), prise au clic : un rechargement pendant l'export ne la touche pas. */
  function printableCopy() {
    const live = el.querySelector('.pf');
    if (!live) return null;
    const host = document.createElement('div');
    host.className = 'pf-offscreen';
    host.setAttribute('aria-hidden', 'true');
    const sheet = document.createElement('div');
    sheet.className = 'pf pf--print';
    sheet.style.width = `${Math.max(1100, live.offsetWidth)}px`;
    for (const part of [
      live.querySelector('.pf-kpis'),
      live.querySelector('.pf-period'),
      live.querySelector('#pf-panel'),
    ])
      if (part) sheet.append(part.cloneNode(true));
    for (const n of sheet.querySelectorAll('[id]')) n.removeAttribute('id');
    for (const n of sheet.querySelectorAll('.pf-more, .pf-notice, .pf-empty .fr-btn')) n.remove();
    for (const n of sheet.querySelectorAll('[class*="fr-icon-"]')) {
      if (n.closest('.pf-tl__out'))
        n.replaceWith(document.createTextNode(n.closest('.pf-tl__out--before') ? '‹ ' : '› '));
      else if (n.classList.contains('pf-load__warn')) n.replaceWith(document.createTextNode('! '));
    }
    host.append(sheet);
    document.body.append(host);
    return { host, sheet };
  }

  async function exportPortfolio() {
    if (st.busy) return;
    const print = printableCopy();
    if (!print) return;
    const name = pdfFilenameOfDay(`portfolio-${st.tab}`, ctx.today);
    const opts = {
      filename: name,
      title: label('portfolio.pdf.title', { vue: label(`portfolio.tab.${st.tab}`).toLowerCase() }),
      subtitle: label('portfolio.pdf.subtitle', { periode: periodText(), date: formatDateFr(ctx.today) }),
      rowHeight: st.tab === 'load' ? ROW_PX.load : ROW_PX.timeline,
      legend: pdfLegend(st.tab),
    };
    st.busy = true;
    st.notice = '';
    paint();
    let mod = null;
    try {
      mod = await import('../ui/pdf.js');
      await mod.exportPdf(print.sheet, opts);
      st.notice = label('portfolio.pdf.done', { nom: name });
    } catch (err) {
      console.error(err);
      const raison = mod && err instanceof mod.PdfError ? err.message : label('pdf.failed');
      st.notice = label('portfolio.pdf.error', { raison });
    } finally {
      print.host.remove();
      st.busy = false;
      if (gen === memory.generation && el.isConnected) paint();
    }
  }

  // ---------- Événements ----------
  el.onclick = (e) => {
    const tab = e.target.closest('[data-tab][role="tab"]');
    if (tab) return selectTab(tab.dataset.tab, false);
    if (e.target.closest('[data-pdf]')) return void exportPortfolio();
    if (e.target.closest('[data-more]')) {
      st.limit += PAGE;
      paintPanel();
      const rows = el.querySelectorAll('.pf-tl__title');
      return void rows[Math.min(rows.length - 1, st.limit - PAGE)]?.focus();
    }
    if (e.target.closest('[data-clear-search]')) {
      memory.query[st.tab] = '';
      paint();
      return void el.querySelector('#pf-search')?.focus();
    }
    const o = e.target.closest('[data-open], [data-bar]');
    if (o) {
      const it = items[Number(o.dataset.open ?? o.dataset.bar)];
      if (it?.ref) ctx.openDetail(it.ref);
    }
  };

  el.oninput = (e) => {
    if (e.target.id !== 'pf-search') return;
    memory.query[st.tab] = e.target.value;
    st.limit = PAGE;
    paintPanel();
  };

  el.onchange = (e) => {
    if (e.target.matches('[data-months]')) {
      const n = Number(e.target.value);
      if (!PORTFOLIO_MONTHS.includes(n)) return;
      st.months = n;
      ctx.setPrefs?.({ portfolioMonths: n });
    } else if (e.target.id === 'pf-start') {
      const v = e.target.value;
      const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? dayOfIso(v) : NaN;
      // Champ vidé ou date impossible : retour au début par défaut (premier jour du mois courant)
      st.start = Number.isFinite(d) && isoOfDay(d) === v ? v : null;
      ctx.setPrefs?.({ portfolioStart: st.start });
    } else return;
    paint();
  };

  /** Sous-onglets : flèches gauche / droite, Début / Fin (activation automatique). */
  el.onkeydown = (e) => {
    const t = e.target.closest?.('[role="tab"][data-tab]');
    if (!t) return;
    const i = PORTFOLIO_TABS.indexOf(t.dataset.tab);
    const n = PORTFOLIO_TABS.length;
    const next = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    selectTab(PORTFOLIO_TABS[next], true);
  };

  paint();
}
