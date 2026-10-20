/**
 * Plan de charge (lecture seule, affiché dans les Statistiques) : personnes ISD par profil sur 12 mois.
 * Chaque case donne le taux écrit (et sa couleur ok / tension / dépassement) ; Entrée ou clic liste ses tâches.
 */
import { MONTHS_FR } from '../core/dates.js';
import { teamLoad, teamTotals } from '../core/team-data.js';
import { taskPaths } from '../core/kanban-data.js';
import { h, icon, statusBadge } from '../ui/kit.js';
import { label, taskCount } from '../labels.js';

const MONTHS = 12;
const LEVELS = Object.freeze(['ok', 'tension', 'over']);
const SEP = ' › ';
const int = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const longMonth = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const monthLong = (ym) => longMonth.format(new Date(`${ym}-01T00:00:00Z`));
const monthShort = (ym) => MONTHS_FR[Number(ym.slice(5)) - 1];
const pctText = (c) => (c.rate === null ? label('plan.rate.none') : `${int.format(Math.round(c.rate * 100))}\u202f%`);
const hoursText = (x) => int.format(Math.round(x));
const LEVEL_ICON = Object.freeze({
  tension: icon('alert-line', 'tcell__icon'),
  over: icon('error-warning-line', 'tcell__icon'),
});

/**
 * Classe de la case : sans charge (taux 0 % ou capacité nulle sans charge), la case reste neutre
 * pour que les cases chargées ressortent.
 */
const cellClass = (c) => (c.load > 0 ? `tcell--${c.level}` : 'tcell--idle');

function cellButton(c, idAttr, who, r, col, extra) {
  const aria = label('plan.cell.aria', {
    nom: who,
    mois: monthLong(c.ym),
    taux: pctText(c),
    niveau: label(`plan.level.short.${c.level}`),
    charge: hoursText(c.load),
    capacite: hoursText(c.capacity),
  });
  const fill = c.capacity > 0 ? Math.min(100, (c.load / c.capacity) * 100) : c.load > 0 ? 100 : 0;
  return h`<button type="button" class="tcell ${cellClass(c)}" id="${idAttr}" ${extra} data-r="${r}" data-c="${col}" aria-label="${aria}" aria-pressed="false">
    <span class="tcell__rate" aria-hidden="true">${LEVEL_ICON[c.level] ?? ''}${pctText(c)}</span>
    <span class="tcell__hours" aria-hidden="true">${label('plan.hours', { charge: hoursText(c.load), capacite: hoursText(c.capacity) })}</span>
    <span class="tcell__meter" aria-hidden="true"><span style="width:${fill.toFixed(1)}%"></span></span>
  </button>`;
}

function legendHtml() {
  return h`<div class="plan__legend" role="group" aria-label="${label('plan.legend')}">
    <span class="plan__legend-title">${label('plan.legend')}</span>
    ${LEVELS.map(
      (l) =>
        h`<span class="plan__key"><span class="plan__swatch tcell--${l}" aria-hidden="true">${LEVEL_ICON[l] ?? ''}</span>${label(`plan.level.${l}`)}</span>`,
    )}
  </div>`;
}

function tableHtml(rows, totals, months) {
  let r = 0;
  const head = h`<tr>
    <th scope="col" class="plan__corner">${label('plan.person')}</th>
    ${months.map(
      (ym) =>
        h`<th scope="col" class="plan__month" abbr="${monthLong(ym)}"><span>${monthShort(ym)}</span><span class="plan__year">${ym.slice(0, 4)}</span></th>`,
    )}
  </tr>`;
  const groups = totals.map((t) => {
    const people = rows.filter((p) => p.role === t.role);
    const n = people.length === 1 ? label('plan.people.one') : label('plan.people', { n: people.length });
    const groupRow = h`<tr class="plan__group"><th scope="rowgroup" colspan="${months.length + 1}">
      <span class="plan__group-name">${label(`profile.group.${t.role}`)}</span><span class="plan__group-count">${n}</span>
    </th></tr>`;
    const personRows = people.map((p) => {
      const ri = r++;
      const who = p.nom || label('common.untitled');
      return h`<tr>
        <th scope="row" class="plan__name"><span class="plan__role">${label(`profile.${p.role}`)}</span><span class="plan__who" title="${who}">${who}</span></th>
        ${p.months.map((c, ci) => h`<td>${cellButton(c, `tc-${p.personId}-${c.ym}`, who, ri, ci, h`data-person="${p.personId}" data-ym="${c.ym}"`)}</td>`)}
      </tr>`;
    });
    const ri = r++;
    const totalName = label('plan.total', { profil: label(`profile.${t.role}`) });
    const totalRow = h`<tr class="plan__total">
      <th scope="row" class="plan__name">${totalName}</th>
      ${t.months.map((c, ci) => h`<td>${cellButton(c, `tt-${t.role}-${c.ym}`, totalName, ri, ci, h`data-role="${t.role}" data-ym="${c.ym}"`)}</td>`)}
    </tr>`;
    return h`<tbody>${groupRow}${personRows}${totalRow}</tbody>`;
  });
  return h`<div class="plan__scroll" tabindex="-1" data-scroll-key="plan">
    <table class="plan__grid">
      <caption class="fr-sr-only">${label('plan.caption', { debut: monthLong(months[0]), fin: monthLong(months.at(-1)) })}. ${label('plan.keys')}</caption>
      <thead>${head}</thead>
      ${groups}
    </table>
  </div>`;
}

/** Heures par tâche d'une case de personne, ou cumulées sur le profil pour une case de total. */
function cellTasks(rows, sel) {
  const people = sel.person ? rows.filter((p) => p.personId === sel.person) : rows.filter((p) => p.role === sel.role);
  const hours = {};
  for (const p of people) {
    const c = p.months.find((x) => x.ym === sel.ym);
    for (const [k, v] of Object.entries(c?.hours ?? {})) hours[k] = (hours[k] ?? 0) + v;
  }
  return Object.entries(hours)
    .map(([k, v]) => [Number(k), v])
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

function panelHtml(ctx, rows, totals, sel, paths) {
  const src = sel.person ? rows.find((p) => p.personId === sel.person) : totals.find((t) => t.role === sel.role);
  const c = src?.months.find((x) => x.ym === sel.ym);
  if (!c) return '';
  const who = sel.person
    ? src.nom || label('common.untitled')
    : label('plan.total', { profil: label(`profile.${sel.role}`) });
  const list = cellTasks(rows, sel);
  return h`<section class="plan__panel" aria-labelledby="plan-panel-title">
    <div class="plan__panel-head">
      <h3 class="plan__panel-title" id="plan-panel-title" tabindex="-1">${label('plan.cell.title', { nom: who, mois: monthLong(c.ym) })}</h3>
      <button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary-no-outline fr-icon-close-line fr-btn--icon-left" data-close-panel>${label('plan.cell.close')}</button>
    </div>
    <dl class="plan__stats">
      <div><dt>${label('plan.capacity')}</dt><dd>${hoursText(c.capacity)} h</dd></div>
      <div><dt>${label('plan.load')}</dt><dd>${hoursText(c.load)} h</dd></div>
      <div><dt>${label('plan.rate')}</dt><dd><span class="plan__badge ${cellClass(c)}">${LEVEL_ICON[c.level] ?? ''}${pctText(c)}</span> ${label(`plan.level.short.${c.level}`)}</dd></div>
    </dl>
    <h4 class="plan__panel-sub">${label('plan.cell.tasks')} (${list.length})</h4>
    ${
      list.length
        ? h`<ul class="list plan__tasks">${list.map(([tid, hrs]) => {
            const t = ctx.model.tasks.get(tid);
            const path = (paths.get(tid)?.path ?? []).join(SEP);
            return h`<li><button type="button" class="plan__task" data-task="${tid}">
              <span class="plan__task-main">
                ${path ? h`<span class="plan__task-path" title="${path}">${path}</span>` : ''}
                <span class="plan__task-title">${t?.title || label('common.untitled')}</span>
              </span>
              ${statusBadge(t?.status ?? '')}
              <span class="plan__task-hours" title="${label('plan.cell.hoursTitle', { h: hoursText(hrs) })}">${label('plan.cell.hours', { h: hoursText(hrs) })}</span>
            </button></li>`;
          })}</ul>`
        : h`<p class="plan__panel-empty">${label('plan.cell.empty')}</p>`
    }
  </section>`;
}

/**
 * Monte le plan de charge dans el (qui reçoit ses propres gestionnaires de clic et de clavier).
 * @param {HTMLElement} el
 * @param {object} ctx contexte fourni par main.js
 */
export function mountLoadPlan(el, ctx) {
  const months = ctx.months.slice(0, MONTHS);
  const rows = teamLoad(ctx.model, ctx.view.taskIds, months);
  const totals = teamTotals(rows);
  const paths = taskPaths(ctx.view.tree);
  const hasLoad = rows.some((p) => p.months.some((c) => c.load > 0));
  let sel = null;

  el.innerHTML = h`<div class="plan">
    <div class="plan__bar">
      <p class="plan__scope">${label('plan.scope', { taches: taskCount(ctx.view.taskIds.size).toLowerCase() })}</p>
      ${legendHtml()}
    </div>
    ${hasLoad ? '' : h`<div class="fr-alert fr-alert--info fr-alert--sm plan__notice"><p>${label('plan.noCharges')}</p></div>`}
    <div class="plan__body" role="region" aria-label="${label('plan.label')}">${tableHtml(rows, totals, months)}</div>
    <div class="plan__panel-slot" data-panel></div>
  </div>`;
  const slot = el.querySelector('[data-panel]');

  function select(btn) {
    for (const b of el.querySelectorAll('.tcell[aria-pressed="true"]')) b.setAttribute('aria-pressed', 'false');
    if (!btn) {
      sel = null;
      slot.innerHTML = '';
      return;
    }
    btn.setAttribute('aria-pressed', 'true');
    sel = {
      person: btn.dataset.person ? Number(btn.dataset.person) : null,
      role: btn.dataset.role ?? null,
      ym: btn.dataset.ym,
      btn: btn.id,
    };
    slot.innerHTML = panelHtml(ctx, rows, totals, sel, paths).toString();
    const title = document.getElementById('plan-panel-title');
    title?.focus({ preventScroll: true });
    slot.firstElementChild?.scrollIntoView?.({ block: 'nearest' });
  }

  function closePanel() {
    const back = sel && document.getElementById(sel.btn);
    select(null);
    back?.focus();
  }

  el.onclick = (e) => {
    const cell = e.target.closest('.tcell[data-ym]');
    if (cell) {
      if (cell.getAttribute('aria-pressed') === 'true') return closePanel();
      return select(cell);
    }
    if (e.target.closest('[data-close-panel]')) return closePanel();
    const t = e.target.closest('[data-task]');
    if (t) ctx.openDetail({ table: 'Tasks', id: Number(t.dataset.task) });
  };

  el.onkeydown = (e) => {
    if (e.key === 'Escape' && sel && slot.contains(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      return closePanel();
    }
    const cell = e.target.closest?.('.tcell[data-r]');
    const delta = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
    if (!cell || !delta) return;
    const r = Number(cell.dataset.r) + delta[0];
    const c = Number(cell.dataset.c) + delta[1];
    const next = el.querySelector(`.tcell[data-r="${r}"][data-c="${c}"]`);
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };
}
