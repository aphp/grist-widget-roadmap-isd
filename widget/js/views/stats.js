/**
 * Vue Statistiques (lecture seule) : vue d'ensemble de l'équipe ISD sur les tâches filtrées.
 * « Données à compléter », graphiques en barres HTML (valeurs toujours écrites, tableau de valeurs repliable)
 * puis le plan de charge personnes × mois.
 */
import { raw } from '../core/sanitize.js';
import { MONTHS_FR } from '../core/dates.js';
import {
  barPercent,
  countBy,
  dataQuality,
  delays,
  priorityTones,
  qualityRows,
  statusTone,
  timeline,
  topN,
  visibleChantierIds,
  visibleProjectIds,
} from '../core/stats-data.js';
import { h } from '../ui/kit.js';
import { viewHeading } from '../ui/heading.js';
import { label, taskCount } from '../labels.js';
import { mountLoadPlan } from './load-plan.js';

export const id = 'stats';

const TOP_PEOPLE = 15;
const LATE = new Set(['w1', 'w4', 'more']);
const fr = (n) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
const monthLabel = (ym) => `${MONTHS_FR[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;
const tip = (text, value) => `${text} : ${label('stats.value', { valeur: fr(value) })}`;

/** Alternative textuelle : tableau lisible, replié sous le graphique. */
function dataTable(caption, heads, rows) {
  return h`<details class="stats__alt"><summary>${label('stats.table.show')}</summary>
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
function columns(title, rows, tones) {
  const max = Math.max(...rows.map((r) => r.value));
  return h`<ul class="list vbars" aria-label="${title}">
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

function legend(items) {
  return h`<ul class="list stats__legend">${items.map(([tone, text]) => h`<li><span class="stats__swatch tone--${tone}" aria-hidden="true"></span>${text}</li>`)}</ul>`;
}

function card(key, title, body, { wide = false, sub = '' } = {}) {
  return h`<section class="stats__card card${raw(wide ? ' stats__card--wide' : '')}" aria-labelledby="stats-${key}">
    <h3 class="stats__card-title" id="stats-${key}">${title}</h3>
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

function qualityCard(rows, n) {
  return h`<section class="stats__card stats__card--wide card stats__quality" aria-labelledby="stats-quality">
    <h3 class="stats__card-title" id="stats-quality">${label('stats.quality.title')}</h3>
    <p class="stats__sub">${label('stats.todo.help')}</p>
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
          <ul id="stats-l-${r.kind}" class="list stats__tasks" aria-label="${label('stats.todo.list', { anomalie: r.label })}" hidden>
            ${r.items.map((it) => todoHtml(it))}
          </ul>
        </li>`;
      })}
    </ul>
    <p class="stats__foot">${label('stats.scope', { taches: taskCount(n).toLowerCase() })}</p>
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
  const people = topN(person, TOP_PEOPLE);
  const T = (k) => label(`stats.chart.${k}`);

  el.innerHTML = h`<div class="stats">
    ${viewHeading(label('stats.title'), label('stats.subtitle'))}
    <div class="stats__cards">
      ${qualityCard(quality, ids.length)}
      ${card(
        'status',
        T('status'),
        status.length
          ? h`${columns(
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
          ? h`${columns(T('priority'), priority, priorityTones(priority))}${countTable(T('priority'), priority)}`
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
      <section class="stats__card stats__card--wide card" aria-labelledby="stats-plan">
        <h3 class="stats__card-title" id="stats-plan">${label('plan.title')}</h3>
        <div data-plan></div>
      </section>
    </div>
  </div>`.toString();

  mountLoadPlan(el.querySelector('[data-plan]'), ctx);

  el.onclick = (e) => {
    const k = e.target.closest('[data-kind]');
    if (k) {
      const on = k.getAttribute('aria-expanded') !== 'true';
      k.setAttribute('aria-expanded', String(on));
      k.querySelector('.stats__chev').textContent = on ? '▾' : '▸';
      el.querySelector(`#stats-l-${k.dataset.kind}`).hidden = !on;
      return;
    }
    const more = e.target.closest('button[data-more]');
    if (more) {
      const on = more.getAttribute('aria-expanded') !== 'true';
      more.setAttribute('aria-expanded', String(on));
      more.textContent = on ? label('stats.people.less') : label('stats.people.more', { n: people.hidden });
      for (const r of more.closest('.stats__card').querySelectorAll('li[data-more]')) r.hidden = !on;
      return;
    }
    const t = e.target.closest('[data-open]');
    if (t) ctx.openDetail({ table: t.dataset.table, id: Number(t.dataset.open) });
  };
}
