/**
 * Vue « Mes tâches » (P-UX-1, lecture seule) : tâches de la personne de « Je suis… » groupées par échéance
 * (En retard, Cette semaine, Semaine prochaine, Plus tard, Sans date), chacune avec son statut, son chantier et
 * son projet, ses dates et l'ETP de la personne. Une ligne ouvre la fiche. Sans « Je suis… », un état vide invite
 * à choisir. Vue légère : 20 lignes par groupe, puis « Afficher plus ». Les filtres globaux ne s'appliquent pas
 * (seuls les projets masqués des Préférences sont écartés).
 * Statut depuis la ligne (P-UX-6) : en édition, le statut d'une tâche modifiable devient un bouton-menu, à droite
 * de la ligne (la ligne elle-même reste le bouton qui ouvre la fiche). Une tâche passée à « Terminé » quitte la
 * liste : le focus va alors à la ligne voisine.
 */
import { formatDayShort, weekStart } from '../core/dates.js';
import { groupByPeriod, myTasks, PAGE_SIZE, visibleCount, weekLoad } from '../core/my-tasks.js';
import { raw } from '../core/sanitize.js';
import { label, statusLabel } from '../labels.js';
import { viewHeading } from '../ui/heading.js';
import { h, ICONS, statusBadge } from '../ui/kit.js';
import { blockContextMenu } from '../ui/status-popover.js';

export const id = 'mytasks';

/** « Afficher plus » déjà demandé, par groupe, pour la personne affichée (remis à zéro si elle change). */
const memory = { person: null, clicks: {} };

const fr1 = (n) => n.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const frN = (n) => n.toLocaleString('fr-FR');

function countText(n) {
  if (n === 0) return label('mytasks.count.none');
  return n === 1 ? label('mytasks.count.one') : label('mytasks.count.many', { n: frN(n) });
}

/** Période couverte par chaque groupe, en clair (semaines du lundi au dimanche). */
function rangeOf(period, today) {
  const monday = weekStart(today);
  const f = (d) => formatDayShort(d, today);
  if (period === 'thisWeek') return label('mytasks.range', { debut: f(monday), fin: f(monday + 6) });
  if (period === 'nextWeek') return label('mytasks.range', { debut: f(monday + 7), fin: f(monday + 13) });
  if (period === 'later') return label('mytasks.range.after', { date: f(monday + 13) });
  if (period === 'noDate') return label('mytasks.range.noDate');
  return '';
}

function datesOf(t, today) {
  const f = (d) => formatDayShort(d, today);
  if (t.start !== null && t.end !== null) return label('mytasks.dates', { debut: f(t.start), fin: f(t.end) });
  if (t.end !== null) return label('mytasks.due', { date: f(t.end) });
  if (t.start !== null) return label('mytasks.startOnly', { date: f(t.start) });
  return label('mytasks.noDates');
}

function etpOf(t) {
  if (t.etp !== null) return label('mytasks.etp', { v: fr1(t.etp) });
  if (t.hours > 0) return label('mytasks.etp.nodates', { h: frN(t.hours) });
  return label('mytasks.etp.none');
}

/**
 * Une ligne : un bouton (titre, lieu, statut, dates, ETP) qui ouvre la fiche ; en édition (qs), le statut est un
 * second bouton, à côté, qui ouvre le menu de statut.
 */
function rowHtml(t, today, qs) {
  const place = [t.chantier ?? label('mytasks.noChantier'), t.projet ?? label('mytasks.noProjet')].join(' · ');
  const roles = t.roles.map((r) => label(`mytasks.role.${r}`)).join(', ');
  const edit = Boolean(qs?.can(t.id));
  const title = t.title || label('common.untitled');
  return h`<li class="mt__item${edit ? ' mt__item--qs' : ''}">
    <button type="button" class="mt__row" data-task="${t.id}">
      <span class="mt__main">
        <span class="mt__title">${t.title || label('common.untitled')}</span>
        <span class="mt__place">
          ${place}${t.parent ? h`<span class="mt__parent"> · ${label('mytasks.subtask', { parent: t.parent })}</span>` : ''}
        </span>
      </span>
      ${edit ? '' : h`<span class="mt__status">${statusBadge(t.status)}</span>`}
      <span class="mt__dates">
        <span>${datesOf(t, today)}</span>
        ${t.lateDays > 0 ? h`<span class="mt__late">${label('mytasks.lateBy', { n: frN(t.lateDays) })}</span>` : ''}
      </span>
      <span class="mt__etp">
        <span class="fr-sr-only">${label('mytasks.etp.label')} : </span>${etpOf(t)}
        <span class="mt__roles">${roles}</span>
      </span>
    </button>
    ${
      edit
        ? h`<button type="button" class="mt__qs" data-qs-open="${t.id}" data-qs-focus="${t.id}" aria-haspopup="menu" aria-expanded="false" aria-label="${label('quickStatus.button', { statut: statusLabel(t.status), titre: title })}">${statusBadge(t.status)}<span class="mt__qs-caret" aria-hidden="true">▾</span></button>`
        : ''
    }
  </li>`;
}

function groupHtml(g, today, clicks, qs) {
  const total = g.items.length;
  const shown = visibleCount(total, clicks);
  const titleId = `mt-g-${g.period}`;
  const rest = Math.min(PAGE_SIZE, total - shown);
  return h`<section class="mt__group mt__group--${g.period}" aria-labelledby="${titleId}">
    <h3 class="mt__group-title" id="${titleId}" tabindex="-1">
      <span>${label(`mytasks.period.${g.period}`)}</span>
      <span class="mt__count">(${frN(total)})</span>
      ${g.period === 'late' ? '' : h`<span class="mt__range">${rangeOf(g.period, today)}</span>`}
    </h3>
    <ul class="list mt__list" role="list">
      ${g.items.slice(0, shown).map((t) => rowHtml(t, today, qs))}
    </ul>
    ${
      rest > 0
        ? h`<div class="mt__more">
            <button type="button" class="fr-btn fr-btn--tertiary fr-btn--sm" data-more="${g.period}">
              ${label('mytasks.more', { n: frN(rest) })}
            </button>
            <span class="mt__shown">${label('mytasks.shown', { shown: frN(shown), total: frN(total) })}</span>
          </div>`
        : ''
    }
  </section>`;
}

function loadHtml(load) {
  if (!load) return '';
  const over = load.capacity > 0 && load.hours > load.capacity + 1e-6;
  const value =
    load.capacity > 0
      ? label('mytasks.load.value', { etp: fr1(load.etp), cap: fr1(load.capacityEtp) })
      : `${label('mytasks.etp', { v: fr1(load.etp) })}, ${label('mytasks.load.none')}`;
  return h`<p class="mt__load${raw(over ? ' mt__load--over' : '')}">
    <span class="mt__load-label">${label('mytasks.load')}</span>
    <strong>${value}</strong>
    ${over ? h`<span class="mt__load-over">${label('mytasks.load.over')}</span>` : ''}
  </p>`;
}

/** État vide orienté action (P-UX-12) : sans « Je suis… », ou personne sans tâche en cours. */
function emptyHtml(kind, nom) {
  if (kind === 'me')
    return h`<div class="empty mt__empty" role="status">
      ${ICONS.people}
      <p class="empty__title">${label('mytasks.empty.me')}</p>
      <p class="empty__hint">${label('mytasks.empty.me.hint')}</p>
      <button type="button" class="fr-btn fr-btn--sm" data-choose-me>${label('mytasks.empty.me.action')}</button>
    </div>`;
  return h`<div class="empty mt__empty" role="status">
    ${ICONS.empty}
    <p class="empty__title">${label('mytasks.empty.none', { nom })}</p>
    <p class="empty__hint">${label('mytasks.empty.none.hint')}</p>
  </div>`;
}

/**
 * Contenu de la vue (fragment sûr).
 * @param {object} model
 * @param {{me:number|null, today:number, hiddenProjects?:number[], clicks?:Record<string, number>,
 *   qs?:{can(id:number):boolean}|null}} opts qs : statut depuis la ligne (édition ouverte), sinon lecture seule
 */
export function myTasksHtml(model, { me, today, hiddenProjects = [], clicks = {}, qs = null }) {
  const person = me === null ? null : model.people.get(me);
  if (!person) return h`<section class="mt">${viewHeading(label('mytasks.title'))}${emptyHtml('me')}</section>`;
  const nom = person.nom || label('common.untitled');
  const items = myTasks(model, me, today, { hiddenProjects });
  const groups = groupByPeriod(items);
  const heading = viewHeading(
    label('mytasks.title'),
    h`<p>${label('mytasks.sub', { nom })}</p><p class="mt__total" role="status">${countText(items.length)}</p>`,
    '',
    { id: 'mt-title' },
  );
  if (!items.length)
    return h`<section class="mt" aria-labelledby="mt-title">${heading}${emptyHtml('none', nom)}</section>`;
  return h`<section class="mt" aria-labelledby="mt-title">
    ${heading}
    <div class="mt__top">
      <nav class="mt__jump" aria-label="${label('mytasks.jump')}">
        <ul class="list mt__jump-list" role="list">
          ${groups.map(
            (g) =>
              h`<li>
                ${
                  g.items.length
                    ? h`<button type="button" class="mt__chip mt__chip--${g.period}" data-jump="${g.period}">
                        ${label(`mytasks.period.${g.period}`)} <span class="mt__chip-n">${frN(g.items.length)}</span>
                      </button>`
                    : h`<span class="mt__chip mt__chip--empty">
                        ${label(`mytasks.period.${g.period}`)} <span class="mt__chip-n">0</span>
                      </span>`
                }
              </li>`,
          )}
        </ul>
      </nav>
      ${loadHtml(weekLoad(model, me, today))}
    </div>
    ${groups.filter((g) => g.items.length).map((g) => groupHtml(g, today, clicks[g.period] ?? 0, qs))}
  </section>`;
}

/**
 * @param {HTMLElement} el
 * @param {object} ctx contexte fourni par main.js (model, prefs, today, openDetail, askMe)
 */
export function render(el, ctx) {
  const me = ctx.prefs.me;
  if (memory.person !== me) {
    memory.person = me;
    memory.clicks = {};
  }
  const opts = () => ({
    me,
    today: ctx.today,
    hiddenProjects: ctx.prefs.hiddenProjects,
    clicks: memory.clicks,
    qs: ctx.quickStatus,
  });
  el.innerHTML = myTasksHtml(ctx.model, opts());

  el.oncontextmenu = blockContextMenu;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !el.contains(b)) return;
    if (b.dataset.qsOpen) ctx.quickStatus?.open(b, Number(b.dataset.qsOpen));
    else if (b.dataset.task) ctx.openDetail({ table: 'Tasks', id: Number(b.dataset.task) });
    else if (b.dataset.more) {
      const period = b.dataset.more;
      const before = el.querySelectorAll(`.mt__group--${period} .mt__row`).length;
      memory.clicks = { ...memory.clicks, [period]: (memory.clicks[period] ?? 0) + 1 };
      el.innerHTML = myTasksHtml(ctx.model, opts());
      // Focus sur la première ligne ajoutée (sinon le titre du groupe)
      const rows = el.querySelectorAll(`.mt__group--${period} .mt__row`);
      (rows[before] ?? document.getElementById(`mt-g-${period}`))?.focus();
    } else if (b.dataset.jump) {
      const title = document.getElementById(`mt-g-${b.dataset.jump}`);
      title?.scrollIntoView({ block: 'start' });
      title?.focus({ preventScroll: true });
    } else if (b.dataset.chooseMe !== undefined) ctx.askMe?.();
  });
}
