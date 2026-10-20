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
  roleLoad,
  roleSeries,
  statusTone,
  timeline,
  topN,
  visibleChantierIds,
  visibleProjectIds,
} from '../core/stats-data.js';
import { h } from '../ui/kit.js';
import { viewHeading } from '../ui/heading.js';
import { etpLabel, label, taskCount } from '../labels.js';
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

const etp1 = (n) => n.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const roleName = (k) => (k === 'Mgmt' ? label('stats.roles.Mgmt') : etpLabel(k));
const roleTone = (k) => `role-${k.toLowerCase()}`;

/**
 * Charge par profil : une ligne par mois, barre empilée par profil (ordre fixe PO DA DS DE Mgmt Autre, mêmes
 * teintes que l'onglet Équipe), total écrit au bout ; le mois courant est marqué. Infobulle par segment.
 */
function roleBars(rows, keys, current) {
  const max = Math.max(...rows.map((r) => r.total));
  return h`<div class="rbars">
    <p class="rbars__axis rbars__axis--y" aria-hidden="true">${label('stats.roles.axisMonth')}</p>
    <ul class="list hbars rbars__list" aria-label="${label('stats.chart.roles')}">
      ${rows.map((r) => {
        const m = monthLabel(r.month);
        const cur = r.month === current;
        return h`<li class="hbars__row${raw(cur ? ' rbars__row--current' : '')}">
          <span class="hbars__label">${m}${cur ? h`<span class="fr-sr-only"> (${label('stats.roles.current')})</span>` : ''}</span>
          <span class="hbars__track">
            <span class="rbars__stack" style="--p:${barPercent(r.total, max).toFixed(1)}">
              ${keys
                .filter((k) => r[k] > 0)
                .map(
                  (k) =>
                    h`<span class="rbars__seg tone--${roleTone(k)}" style="flex-grow:${r[k].toFixed(4)}" title="${label('stats.roles.tip', { mois: m, profil: roleName(k), valeur: etp1(r[k]) })}"></span>`,
                )}
            </span>
            <span class="hbars__value" title="${label('stats.roles.totalTip', { mois: m, valeur: etp1(r.total) })}">${etp1(r.total)}</span>
          </span>
        </li>`;
      })}
    </ul>
    <p class="rbars__axis rbars__axis--x" aria-hidden="true">${label('stats.roles.axisEtp')}</p>
  </div>`;
}

function rolesCard(rows, keys, ctx) {
  const T = label('stats.chart.roles');
  if (!rows.length) return card('roles', T, empty(), { wide: true });
  const sub = label('stats.roles.sub', { debut: monthLabel(rows[0].month), fin: monthLabel(rows.at(-1).month) });
  const other = keys.includes('Autre') ? label('stats.roles.other') : label('stats.roles.noOther');
  return card(
    'roles',
    T,
    h`${legend(keys.map((k) => [roleTone(k), roleName(k)]))}${roleBars(rows, keys, monthKey(ctx.today))}
      <p class="stats__foot">${other}</p>
      ${dataTable(
        T,
        [label('stats.col.month'), ...keys.map(roleName), label('stats.roles.total')],
        rows.map((r) => [monthLabel(r.month), ...keys.map((k) => etp1(r[k])), etp1(r.total)]),
      )}`,
    { wide: true, sub },
  );
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
          <ul id="stats-l-${r.kind}" class="list stats__tasks" aria-label="${label('stats.todo.list', { anomalie: r.label })}" hidden>
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

  el.innerHTML = h`<div class="stats">
    ${viewHeading(label('stats.title'), label('stats.subtitle'))}
    <div class="stats__cards">
      ${qualityCard(quality, ids.length, ctx.prefs?.statsQualityOpen === true)}
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
      ${rolesCard(roles, roleSeries(roles), ctx)}
      <section class="stats__card stats__card--wide card" aria-labelledby="stats-plan">
        <h3 class="stats__card-title" id="stats-plan">${label('plan.title')}</h3>
        <div data-plan></div>
      </section>
    </div>
  </div>`.toString();

  mountLoadPlan(el.querySelector('[data-plan]'), ctx);

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
