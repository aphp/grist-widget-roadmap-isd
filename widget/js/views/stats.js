/**
 * Vue Statistiques (lecture seule) : vue d'ensemble de l'équipe ISD sur les tâches filtrées.
 * « Contrôle qualité des données » (carte repliable), graphiques en barres HTML (valeurs toujours écrites, tableau de valeurs repliable)
 * puis le plan de charge personnes × mois.
 */
import { raw } from '../core/sanitize.js';
import { MONTHS_FR, monthKey } from '../core/dates.js';
import {
  barPercent,
  countBy,
  dataQuality,
  delays,
  priorityTones,
  qualityRows,
  qualityTotal,
  statusTone,
  timeline,
  topN,
  visibleChantierIds,
  visibleProjectIds,
} from '../core/stats-data.js';
import { PROFILE_KEYS, taskPaths } from '../core/kanban-data.js';
import {
  profileHeadcount,
  roleLoad,
  roleSeries,
  segmentMove,
  segmentTasks,
  summarizeMonths,
} from '../core/role-load.js';
import { h, infoTip } from '../ui/kit.js';
import { viewHeading } from '../ui/heading.js';
import { etpLabel, label, taskCount } from '../labels.js';
import { mountLoadPlan } from './load-plan.js';
import { LEVEL_ICON, hoursText, loadPanelHtml, panelTasks, pctText } from './load-panel.js';

/**
 * Listes dépliées (anomalies, « Voir plus » des personnes) et segment de la charge par profil dont le détail est
 * ouvert, gardés d'un rendu à l'autre (relecture) : sinon la page raccourcirait et le défilement remonterait.
 */
const opened = { kinds: new Set(), more: false, segment: null };

export const id = 'stats';

const TOP_PEOPLE = 15;
const LATE = new Set(['w1', 'w4', 'more']);
/** Formats créés une fois : toLocaleString en recrée un à chaque appel (des centaines par rendu). */
const FR1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const ETP1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fr = (n) => FR1.format(n);
const monthLabel = (ym) => `${MONTHS_FR[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;
const tip = (text, value) => `${text} : ${label('stats.value', { valeur: fr(value) })}`;

/** Alternative textuelle : tableau lisible, replié sous le graphique. */
function dataTable(caption, heads, rows, note = '') {
  return h`<details class="stats__alt"><summary>${label('stats.table.show')}</summary>
    ${note ? h`<p class="stats__table-note">${note}</p>` : ''}
    <table class="stats__table"><caption class="fr-sr-only">${caption}</caption>
      <thead><tr>${heads.map((x) => h`<th scope="col">${x}</th>`)}</tr></thead>
      <tbody>${rows.map((r) => h`<tr>${r.map((c, i) => (i ? h`<td>${c}</td>` : h`<th scope="row">${c}</th>`))}</tr>`)}</tbody>
    </table></details>`;
}

const countTable = (title, rows) =>
  dataTable(
    title,
    [label('stats.col.item'), label('stats.col.count')],
    rows.map((r) => [r.label, fr(r.value)]),
  );

/** Colonnes verticales : valeur au-dessus, libellé en dessous, une couleur par ligne (tone). */
/** Histogramme en colonnes ; key = nom stable de sa zone défilante (un par graphique). */
function columns(key, title, rows, tones) {
  const max = Math.max(...rows.map((r) => r.value));
  return h`<ul class="list vbars" data-scroll-key="stats-vbars-${key}" aria-label="${title}">
    ${rows.map(
      (r, i) => h`<li class="vbars__col" title="${tip(r.label, r.value)}">
        <span class="vbars__plot">
          <span class="vbars__value">${fr(r.value)}</span>
          <span class="vbars__bar tone--${tones[i]}" style="height:${barPercent(r.value, max).toFixed(1)}%"></span>
        </span>
        <span class="vbars__label">${r.label}</span>
      </li>`,
    )}
  </ul>`;
}

/** Barres horizontales : libellé à gauche, barre, valeur écrite au bout. */
function bars(title, rows, { tone = () => 'viz-1', hiddenFrom = Infinity } = {}) {
  const max = Math.max(...rows.map((r) => r.value));
  return h`<ul class="list hbars" aria-label="${title}">
    ${rows.map(
      (
        r,
        i,
      ) => h`<li class="hbars__row" title="${tip(r.label, r.value)}" ${raw(i >= hiddenFrom ? 'hidden data-more' : '')}>
        <span class="hbars__label">${r.label}</span>
        <span class="hbars__track">
          <span class="hbars__bar tone--${tone(r)}" style="--p:${barPercent(r.value, max).toFixed(1)}"></span>
          <span class="hbars__value">${fr(r.value)}</span>
        </span>
      </li>`,
    )}
  </ul>`;
}

/** Chronologie : par mois, deux barres horizontales (démarrées, terminées), valeurs écrites. */
function timelineBars(line) {
  const max = Math.max(...line.flatMap((d) => [d.started, d.closed]));
  const bar = (v, tone, text) =>
    h`<span class="hbars__track" title="${text}">
      <span class="hbars__bar hbars__bar--thin tone--${tone}" style="--p:${barPercent(v, max).toFixed(1)}"></span>
      <span class="hbars__value">${fr(v)}</span>
    </span>`;
  return h`<ul class="list hbars hbars--pairs" aria-label="${label('stats.chart.timeline')}">
    ${line.map((d) => {
      const m = monthLabel(d.month);
      return h`<li class="hbars__row">
        <span class="hbars__label">${m}</span>
        <span class="hbars__pair">
          ${bar(d.started, 'viz-1', `${m}, ${label('stats.timeline.started')} : ${d.started}`)}
          ${bar(d.closed, 'viz-2', `${m}, ${label('stats.timeline.closed')} : ${d.closed}`)}
        </span>
      </li>`;
    })}
  </ul>`;
}

const etp1 = (n) => ETP1.format(n);
const ZERO = etp1(0);
const roleName = (k) => (k === 'Mgmt' ? label('stats.roles.Mgmt') : etpLabel(k));
const roleTone = (k) => `role-${k.toLowerCase()}`;
const longMonth = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthLong = (ym) => longMonth.format(new Date(`${ym}-01T00:00:00Z`));
const hasCapacity = (k) => PROFILE_KEYS.includes(k);
/** Classe d'un taux (mêmes couleurs que le plan de charge) : sans charge, neutre. */
const levelClass = (load, level) => (load > 0 && level !== 'none' ? `tcell--${level}` : 'tcell--idle');

/**
 * Texte d'un segment (infobulle, nom accessible, sans l'action) : profil, mois, charge en ETP et en heures,
 * capacité et taux du profil, puis l'état s'il est en tension ou en dépassement.
 * @returns {{text:string, state:string}}
 */
export function segmentText(r, k) {
  const base = { profil: roleName(k), mois: monthLong(r.month), etp: etp1(r[k]), h: hoursText(r.hours[k]) };
  if (!hasCapacity(k)) return { text: label('stats.roles.seg.other', base), state: '' };
  const rate = r.rates[k];
  const text =
    rate.rate === null
      ? label('stats.roles.seg.noCap', base)
      : label('stats.roles.seg', { ...base, cap: etp1(r.capacity[k]), taux: pctText(rate.rate) });
  const state = rate.level === 'tension' || rate.level === 'over' ? label(`stats.roles.state.${rate.level}`) : '';
  return { text, state };
}

/**
 * Charge par profil : une ligne par mois, barre empilée par profil (ordre fixe PO DA DS DE Mgmt Autre, mêmes
 * teintes que l'onglet Équipe), repère de la capacité PO, DA, DS, DE, total écrit au bout ; le mois courant est
 * marqué. Chaque segment est un bouton (infobulle au survol et au focus, clic ou Entrée : tâches du segment), un
 * seul dans l'ordre de tabulation (focus itinérant, flèches). Un segment qui s'afficherait « 0,0 » est omis.
 */
function roleBars(rows, keys, current) {
  const max = Math.max(...rows.map((r) => Math.max(r.total, r.isdCapacity)));
  let r0 = 0;
  return h`<div class="rbars" data-rbars>
    <p class="rbars__axis rbars__axis--y" aria-hidden="true">${label('stats.roles.axisMonth')}</p>
    <ul class="list hbars rbars__list" aria-label="${label('stats.chart.roles')}">
      ${rows.map((r) => {
        const m = monthLabel(r.month);
        const cur = r.month === current;
        const shown = keys.filter((k) => etp1(r[k]) !== ZERO);
        const ri = shown.length ? r0++ : -1;
        return h`<li class="hbars__row${raw(cur ? ' rbars__row--current' : '')}">
          <span class="hbars__label">${m}${cur ? h`<span class="fr-sr-only"> (${label('stats.roles.current')})</span>` : ''}</span>
          <span class="rbars__track">
            <span class="rbars__plot">
              <span class="rbars__stack" style="--p:${barPercent(r.total, max).toFixed(1)}">
                ${shown.map((k, ci) => {
                  const t = segmentText(r, k);
                  const aria = [t.text, t.state, label('stats.roles.seg.action')].filter(Boolean).join('. ');
                  return h`<button type="button" class="rbars__seg tone--${roleTone(k)}" style="flex-grow:${r[k].toFixed(4)}" data-seg="${k}" data-month="${r.month}" data-r="${ri}" data-c="${ci}" tabindex="-1" aria-pressed="false" aria-label="${aria}" aria-describedby="stats-roles-keys" data-tip="${t.text}" data-state="${t.state}"></button>`;
                })}
              </span>
              ${r.isdCapacity > 0 ? h`<span class="rbars__cap" style="--c:${barPercent(r.isdCapacity, max).toFixed(1)}" aria-hidden="true"></span>` : ''}
            </span>
            <span class="hbars__value">${etp1(r.total)}</span>
          </span>
        </li>`;
      })}
    </ul>
    <p class="rbars__axis rbars__axis--x" aria-hidden="true">${label('stats.roles.axisEtp')}</p>
    <div class="rbars__tip" data-tip-box aria-hidden="true" hidden><span data-tip-text></span><strong data-tip-state></strong></div>
  </div>`;
}

const peopleText = (n) =>
  n === 0
    ? label('stats.roles.people.none')
    : n === 1
      ? label('stats.roles.people.one')
      : label('stats.roles.people', { n });

/** Synthèse par profil, du mois courant à la fin de la fenêtre : pic, mois en dépassement et en tension, moyenne. */
function summaryHtml(rows, current, headcount) {
  const from = rows.some((r) => r.month === current) ? current : rows[0].month;
  const sum = summarizeMonths(rows, from);
  const title = label('stats.roles.summary', { debut: monthLabel(from), fin: monthLabel(rows.at(-1).month) });
  return h`<h4 class="rsum__title">${title}</h4>
    <ul class="list rsum" aria-label="${title}">
    ${PROFILE_KEYS.map((k) => {
      const s = sum[k];
      const peak = s.peak;
      const value = peak ? (peak.rate === null ? label('stats.roles.sum.noCapacity') : pctText(peak.rate)) : '';
      return h`<li class="rsum__item rsum__item--${s.level}">
        <p class="rsum__name"><span class="stats__swatch tone--${roleTone(k)}" aria-hidden="true"></span>${roleName(k)}</p>
        ${
          peak
            ? h`<p class="rsum__value">${s.level === 'over' || s.level === 'tension' ? LEVEL_ICON[s.level] : ''}${label('stats.roles.sum.peak', { valeur: value })}</p>
              <p class="rsum__rate">${label('stats.roles.sum.peakMonth', { niveau: label(`stats.roles.level.${s.level}`), mois: monthLong(peak.month) })}</p>
              <p class="rsum__line">${label('stats.roles.sum.over', { n: s.overMonths, total: s.loadedMonths })}${s.tensionMonths ? `, ${label('stats.roles.sum.tension', { n: s.tensionMonths })}` : ''}</p>
              <p class="rsum__line">${label('stats.roles.sum.avg', { charge: etp1(s.avgLoaded.load), capacite: etp1(s.avgLoaded.capacity) })}</p>`
            : h`<p class="rsum__value">${label('stats.roles.sum.none')}</p>`
        }
        ${headcount ? h`<p class="rsum__hint">${peopleText(headcount[k])}</p>` : ''}
      </li>`;
    })}
  </ul>`;
}

/** Cellule du tableau de valeurs : « charge / capacité (taux) » pour un profil, la charge seule pour « Autre ». */
function roleCell(r, k) {
  if (!hasCapacity(k)) return etp1(r[k]);
  const rate = r.rates[k];
  const taux = rate.rate === null ? label('stats.roles.sum.noCapacity') : pctText(rate.rate);
  return `${etp1(r[k])} / ${etp1(r.capacity[k])} (${taux})`;
}

export function rolesCard(rows, keys, ctx) {
  const T = label('stats.chart.roles');
  const tip = infoTip('tip-fte-stats', label('capacity.fte.about'), label('capacity.fte.help'));
  if (!rows.length) return card('roles', T, empty(), { wide: true, tip });
  const current = monthKey(ctx.today);
  const sub = label('stats.roles.sub', { debut: monthLabel(rows[0].month), fin: monthLabel(rows.at(-1).month) });
  const other = keys.includes('Autre') ? label('stats.roles.other') : label('stats.roles.noOther');
  const headcount = ctx.model ? profileHeadcount(ctx.model) : null;
  return card(
    'roles',
    T,
    h`${summaryHtml(rows, current, headcount)}
      <h4 class="rsum__title">${label('stats.roles.byMonth')}</h4>
      <ul class="list stats__legend">
        ${keys.map((k) => h`<li><span class="stats__swatch tone--${roleTone(k)}" aria-hidden="true"></span>${roleName(k)}</li>`)}
        <li><span class="rbars__cap-key" aria-hidden="true"></span>${label('stats.roles.capacity')}</li>
      </ul>
      <p class="stats__help" id="stats-roles-keys">${label('stats.roles.keys')}</p>
      ${roleBars(rows, keys, current)}
      <p class="stats__foot">${other} ${label('stats.roles.thresholds')}</p>
      <div class="rbars__panel-slot" data-roles-panel></div>
      ${dataTable(
        T,
        [label('stats.col.month'), ...keys.map(roleName), label('stats.roles.total'), label('stats.roles.capacity')],
        rows.map((r) => [monthLabel(r.month), ...keys.map((k) => roleCell(r, k)), etp1(r.total), etp1(r.isdCapacity)]),
        label('stats.roles.table.note'),
      )}`,
    { wide: true, sub, tip },
  );
}

/** Panneau des tâches d'un segment (profil k, mois) : chiffres du segment puis la liste des tâches. */
function segmentPanelHtml(ctx, r, k, paths) {
  const seg = segmentTasks(ctx.model, ctx.view.taskIds, k, r.month);
  const rate = r.rates[k];
  const stats = [[label('plan.load'), label('stats.roles.panel.etp', { etp: etp1(r[k]), h: hoursText(r.hours[k]) })]];
  if (hasCapacity(k))
    stats.push(
      [
        label('plan.capacity'),
        label('stats.roles.panel.etp', { etp: etp1(r.capacity[k]), h: hoursText(r.capacityHours[k]) }),
      ],
      [
        label('plan.rate'),
        h`<span class="plan__badge ${levelClass(r.hours[k], rate.level)}">${LEVEL_ICON[rate.level] ?? ''}${pctText(rate.rate)}</span> ${label(`stats.roles.level.${rate.level}`)}`,
      ],
    );
  else stats.push([label('plan.capacity'), label('stats.roles.panel.noCapacity')]);
  return loadPanelHtml({
    titleId: 'roles-panel-title',
    title: label('stats.roles.panel.title', { profil: roleName(k), mois: monthLong(r.month) }),
    stats,
    tasks: panelTasks(
      ctx.model,
      paths,
      seg.tasks.map((t) => [t.taskId, t.hours, t.people.map((p) => p.nom || label('common.untitled'))]),
    ),
  });
}

/**
 * Comportement du graphique de charge par profil : infobulle (survol, focus), focus itinérant (flèches, Début,
 * Fin), détail d'un segment (clic, Entrée, Espace ; même segment, ou Échap dans le graphique ou le panneau :
 * fermeture, focus rendu au segment ouvert).
 * @param {HTMLElement} box carte de la charge par profil
 */
function mountRoles(box, rows, ctx) {
  const chart = box.querySelector('[data-rbars]');
  const slot = box.querySelector('[data-roles-panel]');
  if (!chart || !slot) return;
  const tipBox = chart.querySelector('[data-tip-box]');
  const segs = [...chart.querySelectorAll('.rbars__seg')];
  const grid = [];
  for (const b of segs) (grid[Number(b.dataset.r)] ??= []).push(b);
  /** Profils de chaque mois, construits une fois par rendu (focus itinérant). */
  const keys = grid.map((row) => row.map((x) => x.dataset.seg));
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  let paths = null;
  let sel = null;

  const segOf = (k, month) => segs.find((b) => b.dataset.seg === k && b.dataset.month === month) ?? null;
  const setRoving = (btn) => {
    for (const b of segs) b.tabIndex = b === btn ? 0 : -1;
  };
  const curRow = segs.find((b) => b.closest('.rbars__row--current'));
  setRoving(curRow ?? segs[0]);

  function showTip(btn) {
    tipBox.querySelector('[data-tip-text]').textContent = btn.dataset.tip;
    const state = tipBox.querySelector('[data-tip-state]');
    state.textContent = btn.dataset.state;
    state.hidden = !btn.dataset.state;
    tipBox.hidden = false;
    const c = chart.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    const w = tipBox.offsetWidth;
    const left = Math.max(0, Math.min(c.width - w, b.left - c.left + b.width / 2 - w / 2));
    tipBox.style.left = `${left}px`;
    // Au-dessus du segment, ou au-dessous s'il n'y a pas la place dans la fenêtre
    const above = b.top - tipBox.offsetHeight - 6 >= 0;
    tipBox.style.top = `${above ? b.top - c.top - tipBox.offsetHeight - 6 : b.bottom - c.top + 6}px`;
  }
  const hideTip = () => {
    tipBox.hidden = true;
  };

  /** Ouvre (ou ferme, btn null) le détail d'un segment ; restore : rendu suivant une relecture, ni focus ni défilement. */
  function select(btn, { restore = false } = {}) {
    for (const b of segs) b.setAttribute('aria-pressed', 'false');
    if (!btn) {
      sel = null;
      opened.segment = null;
      slot.innerHTML = '';
      return;
    }
    btn.setAttribute('aria-pressed', 'true');
    setRoving(btn);
    sel = btn;
    opened.segment = { k: btn.dataset.seg, month: btn.dataset.month };
    paths ??= taskPaths(ctx.view.tree);
    slot.innerHTML = segmentPanelHtml(ctx, byMonth.get(btn.dataset.month), btn.dataset.seg, paths).toString();
    if (restore) return;
    box.querySelector('#roles-panel-title')?.focus({ preventScroll: true });
    slot.firstElementChild?.scrollIntoView?.({ block: 'nearest' });
  }
  function closePanel() {
    const back = sel;
    select(null);
    back?.focus();
  }

  if (opened.segment) {
    const btn = segOf(opened.segment.k, opened.segment.month);
    if (btn) select(btn, { restore: true });
    else opened.segment = null;
  }

  chart.addEventListener('pointerover', (e) => {
    const b = e.target.closest?.('.rbars__seg');
    if (b) showTip(b);
  });
  chart.addEventListener('pointerout', (e) => {
    if (e.target.closest?.('.rbars__seg') && !e.relatedTarget?.closest?.('.rbars__seg')) hideTip();
  });
  chart.addEventListener('focusin', (e) => {
    const b = e.target.closest?.('.rbars__seg');
    if (!b) return;
    setRoving(b);
    showTip(b);
  });
  chart.addEventListener('focusout', hideTip);
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.rbars__seg');
    if (b) {
      e.stopPropagation();
      return b === sel ? closePanel() : select(b);
    }
    if (e.target.closest('[data-roles-panel] [data-close-panel]')) {
      e.stopPropagation();
      return closePanel();
    }
    const t = e.target.closest('[data-roles-panel] [data-task]');
    if (t) {
      e.stopPropagation();
      ctx.openDetail({ table: 'Tasks', id: Number(t.dataset.task) });
    }
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const wasTip = !tipBox.hidden;
      hideTip();
      if (sel && (slot.contains(e.target) || chart.contains(e.target))) {
        e.preventDefault();
        e.stopPropagation();
        return closePanel();
      }
      if (wasTip) e.stopPropagation();
      return;
    }
    const b = e.target.closest?.('.rbars__seg');
    if (!b) return;
    const pos = { row: Number(b.dataset.r), col: Number(b.dataset.c) };
    const next = segmentMove(keys, pos, e.key);
    if (!next) return;
    e.preventDefault();
    grid[next.row][next.col].focus();
  });
}

function legend(items) {
  return h`<ul class="list stats__legend">${items.map(([tone, text]) => h`<li><span class="stats__swatch tone--${tone}" aria-hidden="true"></span>${text}</li>`)}</ul>`;
}

function card(key, title, body, { wide = false, sub = '', tip = '' } = {}) {
  const head = h`<h3 class="stats__card-title" id="stats-${key}">${title}</h3>`;
  return h`<section class="stats__card card${raw(wide ? ' stats__card--wide' : '')}" aria-labelledby="stats-${key}">
    ${tip ? h`<div class="stats__card-head">${head}${tip}</div>` : head}
    ${sub ? h`<p class="stats__sub">${sub}</p>` : ''}
    ${body}
  </section>`;
}

const empty = (text = label('stats.chart.empty')) => h`<p class="stats__empty">${text}</p>`;

/** Une chose à faire : titre (lien vers la fiche si elle existe), niveau et emplacement dans la Feuille. */
function todoHtml(it) {
  const level = it.level ? label(`detail.level.${it.level}`) : '';
  return h`<li class="stats__todo">
    ${
      it.openable
        ? h`<button type="button" class="stats__task" data-table="${it.table}" data-open="${it.id}" title="${label('stats.todo.open', { titre: it.title })}">${it.title}</button>`
        : h`<span class="stats__task stats__task--static">${it.title}</span>`
    }
    <span class="stats__todo-meta">${level ? h`<span class="stats__todo-level">${level}</span>` : ''}${it.context ? h`<span class="stats__todo-path">${it.context}</span>` : ''}</span>
  </li>`;
}

/**
 * Carte « Contrôle qualité des données », repliable en entier (repliée par défaut, état dans les préférences) : l'en-tête
 * (bouton dans le titre h3) donne toujours le total, ou « Aucune anomalie ».
 */
export function qualityCard(rows, n, open) {
  const total = qualityTotal(rows);
  const count = total
    ? h`<span class="stats__count">${total.toLocaleString('fr-FR')}</span>`
    : h`<span class="stats__count stats__count--ok"><span aria-hidden="true">✓</span>${label('stats.quality.zero')}</span>`;
  return h`<section class="stats__card stats__card--wide card stats__quality" aria-labelledby="stats-quality">
    <h3 class="stats__card-title stats__quality-title">
      <button type="button" class="stats__quality-toggle" id="stats-quality" data-quality-toggle aria-expanded="${String(open)}" aria-controls="stats-quality-body">
        <span class="stats__chev" aria-hidden="true">${open ? '▾' : '▸'}</span>
        <span class="stats__quality-name">${label('stats.quality.title')}</span>
        <span class="stats__quality-sep" aria-hidden="true">·</span>
        ${count}
      </button>
    </h3>
    <p class="stats__sub">${label('stats.quality.sub')}</p>
    <div id="stats-quality-body" ${raw(open ? '' : 'hidden')}>
    <p class="stats__help">${label('stats.todo.help')}</p>
    <ul class="list stats__issues">
      ${rows.map((r) => {
        const count = r.items.length;
        if (!count)
          return h`<li class="stats__issue">
            <span class="stats__issue-row">
              <span class="stats__chev" aria-hidden="true"></span>
              <span class="stats__issue-label">${r.label}</span>
              <span class="stats__count stats__count--ok"><span aria-hidden="true">✓</span><span class="fr-sr-only">${label('stats.quality.none')}</span></span>
            </span>
          </li>`;
        return h`<li class="stats__issue">
          <button type="button" class="stats__issue-row stats__issue-btn" data-kind="${r.kind}" aria-expanded="false" aria-controls="stats-l-${r.kind}">
            <span class="stats__chev" aria-hidden="true">▸</span>
            <span class="stats__issue-label">${r.label}</span>
            <span class="stats__count">${count.toLocaleString('fr-FR')}</span>
          </button>
          <ul id="stats-l-${r.kind}" class="list stats__tasks" data-scroll-key="stats-tasks-${r.kind}" aria-label="${label('stats.todo.list', { anomalie: r.label })}" hidden>
            ${r.items.map((it) => todoHtml(it))}
          </ul>
        </li>`;
      })}
    </ul>
    <p class="stats__foot">${label('stats.scope', { taches: taskCount(n).toLowerCase() })}</p>
    </div>
  </section>`;
}

/**
 * @param {HTMLElement} el
 * @param {object} ctx contexte fourni par main.js
 */
export function render(el, ctx) {
  const ids = [...ctx.view.taskIds];
  const quality = qualityRows(
    dataQuality(ctx.model, ids, visibleChantierIds(ctx.view.tree), visibleProjectIds(ctx.view.tree)),
  );
  const status = countBy(ctx.model, ids, 'status');
  const priority = countBy(ctx.model, ids, 'priority');
  const person = countBy(ctx.model, ids, 'person');
  const line = timeline(ctx.model, ids, ctx.today);
  const dl = delays(ctx.model, ids);
  const roles = roleLoad(ctx.model, ids, ctx.today);
  const people = topN(person, TOP_PEOPLE);
  const T = (k) => label(`stats.chart.${k}`);
  const setKind = (k, on) => {
    k.setAttribute('aria-expanded', String(on));
    k.querySelector('.stats__chev').textContent = on ? '▾' : '▸';
    el.querySelector(`#stats-l-${k.dataset.kind}`).hidden = !on;
  };
  const setMore = (more, on) => {
    more.setAttribute('aria-expanded', String(on));
    more.textContent = on ? label('stats.people.less') : label('stats.people.more', { n: people.hidden });
    for (const r of more.closest('.stats__card').querySelectorAll('li[data-more]')) r.hidden = !on;
  };

  el.innerHTML = h`<div class="stats">
    ${viewHeading(label('stats.title'), label('stats.subtitle'))}
    <div class="stats__cards">
      ${qualityCard(quality, ids.length, ctx.prefs?.statsQualityOpen === true)}
      ${card(
        'status',
        T('status'),
        status.length
          ? h`${columns(
              'status',
              T('status'),
              status,
              status.map((r) => statusTone(r.key)),
            )}${countTable(T('status'), status)}`
          : empty(),
      )}
      ${card(
        'priority',
        T('priority'),
        priority.length
          ? h`${columns('priority', T('priority'), priority, priorityTones(priority))}${countTable(T('priority'), priority)}`
          : empty(),
      )}
      ${card(
        'person',
        T('person'),
        person.length
          ? h`${bars(T('person'), person, { hiddenFrom: TOP_PEOPLE })}
            ${
              people.hidden
                ? h`<button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary stats__more" data-more aria-expanded="false">${label('stats.people.more', { n: people.hidden })}</button>`
                : ''
            }
            ${countTable(T('person'), person)}`
          : empty(),
        { sub: label('stats.person.sub') },
      )}
      ${card(
        'timeline',
        T('timeline'),
        line.length
          ? h`${legend([
              ['viz-1', label('stats.timeline.started')],
              ['viz-2', label('stats.timeline.closed')],
            ])}${timelineBars(line)}${dataTable(
              T('timeline'),
              [label('stats.col.month'), label('stats.timeline.started'), label('stats.timeline.closed')],
              line.map((d) => [monthLabel(d.month), d.started, d.closed]),
            )}`
          : empty(),
      )}
      ${card(
        'delays',
        T('delays'),
        dl.count
          ? h`${bars(T('delays'), dl.buckets, { tone: (r) => (LATE.has(r.key) ? 'late' : 'viz-3') })}${countTable(T('delays'), dl.buckets)}`
          : empty(label('stats.delay.none')),
        {
          wide: true,
          sub: dl.count
            ? label('stats.delay.mean', { valeur: (dl.mean > 0 ? '+' : '') + fr(dl.mean), n: dl.count })
            : '',
        },
      )}
      ${rolesCard(roles, roleSeries(roles), ctx)}
      <section class="stats__card stats__card--wide card" aria-labelledby="stats-plan">
        <h3 class="stats__card-title" id="stats-plan">${label('plan.title')}</h3>
        <div data-plan></div>
      </section>
    </div>
  </div>`.toString();

  mountLoadPlan(el.querySelector('[data-plan]'), ctx);
  const rolesBox = el.querySelector('#stats-roles')?.closest('section');
  if (rolesBox) mountRoles(rolesBox, roles, ctx);
  // Listes dépliées avant une relecture : rouvertes, pour que la page garde sa hauteur et son défilement
  for (const kind of opened.kinds) {
    const k = el.querySelector(`[data-kind="${CSS.escape(kind)}"]`);
    if (k) setKind(k, true);
    else opened.kinds.delete(kind);
  }
  const moreBtn = el.querySelector('button[data-more]');
  if (moreBtn && opened.more) setMore(moreBtn, true);

  el.onclick = (e) => {
    const q = e.target.closest('[data-quality-toggle]');
    if (q) {
      const on = q.getAttribute('aria-expanded') !== 'true';
      q.setAttribute('aria-expanded', String(on));
      q.querySelector('.stats__chev').textContent = on ? '▾' : '▸';
      el.querySelector('#stats-quality-body').hidden = !on;
      ctx.setPrefs?.({ statsQualityOpen: on });
      return;
    }
    const k = e.target.closest('[data-kind]');
    if (k) {
      const on = k.getAttribute('aria-expanded') !== 'true';
      setKind(k, on);
      if (on) opened.kinds.add(k.dataset.kind);
      else opened.kinds.delete(k.dataset.kind);
      return;
    }
    const more = e.target.closest('button[data-more]');
    if (more) {
      opened.more = more.getAttribute('aria-expanded') !== 'true';
      setMore(more, opened.more);
      return;
    }
    const t = e.target.closest('[data-open]');
    if (t) ctx.openDetail({ table: t.dataset.table, id: Number(t.dataset.open) });
  };
}
