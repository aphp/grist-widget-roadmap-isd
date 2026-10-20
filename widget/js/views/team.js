/**
 * Vue Équipe (lecture seule), tirée de la table Team de la Feuille et limitée à l'équipe ISD : « Rôles »
 * (lignes cliquables qui filtrent la liste) et « Équipe ISD » (synthèse en une carte), puis « Utilisateurs »
 * groupés par rôle (une section repliable par rôle, puis « Sans rôle »). Les filtres globaux ne s'appliquent pas
 * ici : l'onglet a sa recherche et ses options. Clic ou Entrée sur un nom : fiche personne.
 * Lot 2d (édition) : « Ajouter une personne » dans l'en-tête des utilisateurs, « Réactiver » en fin de ligne d'une
 * personne inactive (cochez « Inclure les inactifs »), seulement si l'édition est ouverte et que les droits le
 * permettent (ctx.team). Aucun rôle n'est créé ici : les rôles sont les choix existants de la Feuille.
 */
import { formatDateFr } from '../core/dates.js';
import { groupUsersByRole, isdTeamSummary, roleShort, roleSummary, roleTone } from '../core/team-directory.js';
import { raw } from '../core/sanitize.js';
import { h, keepFocus } from '../ui/kit.js';
import { viewHeading } from '../ui/heading.js';
import { label } from '../labels.js';

export const id = 'team';

/** Choix de l'onglet, conservés le temps de la session (relecture des données, changement d'onglet). */
const local = { query: '', role: null, includeInactive: false, collapsed: new Set() };

const hours = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const pct = (x) => `${Math.round(x * 100)}\u202f%`;

/** Période d'indisponibilité lisible : dates, nature et disponibilité restante. */
export function unavailabilityText(u) {
  const parts = [u.type, u.dispo > 0 ? label('team.unav.dispo', { taux: pct(u.dispo) }) : ''].filter(Boolean);
  const when =
    u.start === u.end
      ? label('team.unav.day', { jour: formatDateFr(u.start) })
      : label('team.unav.period', { debut: formatDateFr(u.start), fin: formatDateFr(u.end) });
  return parts.length ? `${when} (${parts.join(', ')})` : when;
}

/** Libellé du rôle d'une personne (« PO » pour « PO Data »), sinon « non renseigné ». */
export const roleText = (p) => roleShort(p.roleText) || label('team.role.none');

/** Capacité hebdomadaire : celle de la Feuille, sinon 35 h par défaut. */
export const capacityText = (p) =>
  p.capaciteHebdo ? label('team.capacity.value', { h: hours.format(p.capaciteHebdo) }) : label('team.capacity.default');

export const activeBadge = (actif) =>
  actif
    ? h`<span class="fr-badge fr-badge--sm fr-badge--no-icon fr-badge--success">${label('team.active')}</span>`
    : h`<span class="fr-badge fr-badge--sm fr-badge--no-icon">${label('team.inactive')}</span>`;

const peopleText = (n) => (n === 1 ? label('team.people.one') : label('team.people', { n }));
const hoursText = (n) => label('team.roles.hours', { h: hours.format(n) });

/** Pastille de rôle : point de couleur ET libellé (jamais la couleur seule). */
const rolePill = (tone, text, extra = '') =>
  h`<span class="tpill tpill--${raw(tone)}"><span class="tpill__dot" aria-hidden="true"></span>${text}${extra}</span>`;

function rolesCard(roles) {
  return h`<section class="tsum card" aria-labelledby="team-roles-title">
    <h3 class="tsum__title" id="team-roles-title">${label('team.roles.title')}</h3>
    <p class="tsum__sub">${label('team.roles.sub')}</p>
    <ul class="list tsum__list">
      ${roles.map(
        (
          r,
          i,
        ) => h`<li><button type="button" class="tsum__row" id="team-role-${i}" data-filter-role="${r.role}" aria-pressed="${String(local.role === r.role)}" title="${label('team.roles.filter', { role: r.label })}">
          <span class="tsum__name"><span class="tdot tdot--${raw(roleTone(r.role))}" aria-hidden="true"></span>${r.label}</span>
          <span class="tsum__val">${peopleText(r.active)}</span>
          <span class="tsum__val tsum__val--muted">${hoursText(r.hours)}</span>
        </button></li>`,
      )}
    </ul>
  </section>`;
}

/** Synthèse de l'équipe ISD en une carte : effectif actif, capacité hebdomadaire, répartition par rôle. */
function isdCard(t) {
  const stat = (value, text) => h`<div class="tisd__stat"><dt>${text}</dt><dd>${value}</dd></div>`;
  const chip = (tone, text, n) =>
    h`<li>${rolePill(tone, text, h` <span class="tpill__n">${n.toLocaleString('fr-FR')}</span>`)}</li>`;
  return h`<section class="tsum tisd card" aria-labelledby="team-isd-title">
    <h3 class="tsum__title" id="team-isd-title">${label('team.isd.title')}</h3>
    <p class="tsum__sub">${t.domaine ?? label('team.isd.noDomain')}</p>
    <dl class="tisd__stats">
      ${stat(t.count.toLocaleString('fr-FR'), label('team.isd.people'))}
      ${stat(hoursText(t.hours), label('team.isd.capacity'))}
    </dl>
    <p class="tisd__label" id="team-isd-roles">${label('team.isd.roles')}</p>
    <ul class="list tsum__roles" aria-labelledby="team-isd-roles">
      ${t.roles.map((r) => chip(roleTone(r.role), r.label, r.n))}
      ${t.noRole ? chip('none', label('team.noRole'), t.noRole) : ''}
    </ul>
  </section>`;
}

/** Une personne : nom (fiche), Domaine, statut, capacité hebdomadaire ; « Réactiver » si elle est inactive. */
function personRow(p, team) {
  const reactivate =
    !p.actif && team?.canReactivate?.(p.id)
      ? h`<button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary tperson__action" data-person-reactivate="${p.id}" aria-label="${label('team.reactivate.aria', { nom: p.nom || label('common.untitled') })}">${label('team.reactivate')}</button>`
      : '';
  return h`<li class="tperson ${raw(p.actif ? '' : 'is-inactive')}" data-row="${p.id}">
    <button type="button" class="tperson__name" data-person="${p.id}" aria-haspopup="dialog">${p.nom || label('common.untitled')}</button>
    <span class="tperson__team">${p.domaine || h`<span class="tperson__none" title="${label('team.none.aria')}">${label('team.noDomain')}</span>`}</span>
    <span class="tperson__status">${activeBadge(p.actif)}</span>
    <span class="tperson__cap"><span class="fr-sr-only">${label('team.capacity.sr')} </span>${capacityText(p)}</span>
    ${team?.editing ? h`<span class="tperson__act">${reactivate}</span>` : ''}
  </li>`;
}

/** Une section de rôle repliable : en-tête (bouton aria-expanded) puis la liste de ses personnes. */
function roleSection(g, i, team) {
  const open = !local.collapsed.has(g.role);
  const title = g.role ? g.label : label('team.noRole');
  return h`<section class="trole trole--${raw(g.tone)}" data-section="${g.role}" aria-labelledby="team-sec-${i}-title">
    <div class="trole__head">
      <h4 class="trole__title">
        <button type="button" class="trole__toggle" id="team-sec-${i}-title" data-toggle="${g.role}" aria-expanded="${String(open)}" aria-controls="team-sec-${i}-body">
          <span class="trole__chev" aria-hidden="true"></span>
          ${rolePill(g.tone, title)}
          <span class="trole__count">${peopleText(g.count)}</span>
          ${g.inactive ? h`<span class="trole__meta">${g.inactive === 1 ? label('team.section.inactive.one') : label('team.section.inactive', { n: g.inactive })}</span>` : ''}
          <span class="trole__meta trole__hours">${hoursText(g.hours)}</span>
        </button>
      </h4>
    </div>
    <ul class="list trole__list" id="team-sec-${i}-body" ${raw(open ? '' : 'hidden')}>${g.people.map((p) => personRow(p, team))}</ul>
  </section>`;
}

function sectionsHtml(groups, team) {
  if (!groups.length) return h`<p class="tdir__empty">${label('team.empty')}</p>`;
  return h`<div class="tusers__sections ${raw(team?.editing ? 'tusers--edit' : '')}">${groups.map((g, i) => roleSection(g, i, team))}</div>`;
}

function chipsHtml() {
  const chips = [
    local.role !== null ? ['role', label('team.chip.role', { role: roleShort(local.role) })] : null,
  ].filter(Boolean);
  if (!chips.length) return '';
  return h`<div class="tdir__chips">${chips.map(
    ([k, text]) =>
      h`<button type="button" class="fr-tag fr-tag--sm fr-tag--dismiss" id="team-chip-${k}" data-clear="${k}" aria-label="${label('team.chip.remove', { filtre: text })}">${text}</button>`,
  )}</div>`;
}

/**
 * @param {HTMLElement} el
 * @param {object} ctx contexte fourni par main.js
 */
export function render(el, ctx) {
  const team = ctx.team ?? null;
  el.innerHTML = h`<div class="team">
    ${viewHeading(label('team.title'), label('team.subtitle'))}
    <div class="team__summary" data-summary></div>
    <section class="tusers card" aria-labelledby="team-users-title">
      <div class="tusers__head">
        <h3 class="tsum__title" id="team-users-title">${label('team.users.title')} <span class="tusers__count" data-count></span></h3>
        ${team?.canAdd ? h`<button type="button" id="btn-person-add" class="fr-btn fr-btn--sm fr-btn--icon-left fr-icon-add-line create-primary tusers__add" data-person-add title="${label('team.add.title')}">${label('team.add')}</button>` : ''}
        <div class="tusers__tools" role="search" aria-label="${label('team.tools')}">
          <div class="fr-input-wrap fr-icon-search-line tusers__search">
            <label class="fr-label fr-sr-only" for="team-search">${label('team.search.label')}</label>
            <input class="fr-input" id="team-search" type="search" autocomplete="off" placeholder="${label('team.search.placeholder')}" value="${local.query}" />
          </div>
          <div class="fr-checkbox-group fr-checkbox-group--sm">
            <input type="checkbox" id="team-inactive" data-opt="includeInactive" ${raw(local.includeInactive ? 'checked' : '')} />
            <label class="fr-label" for="team-inactive">${label('team.includeInactive')}</label>
          </div>
        </div>
      </div>
      <p class="tusers__scope">${label('team.scope.isd')}</p>
      <div data-chips></div>
      <div data-users aria-live="polite"></div>
    </section>
    <p class="team__note">${label(team?.editing ? 'team.editHint' : 'team.readonly')}</p>
  </div>`.toString();

  const summary = el.querySelector('[data-summary]');
  const users = el.querySelector('[data-users]');
  const chips = el.querySelector('[data-chips]');

  function paint() {
    keepFocus(summary, h`${rolesCard(roleSummary(ctx.model))}${isdCard(isdTeamSummary(ctx.model))}`.toString());
    const groups = groupUsersByRole(ctx.model, local);
    const n = groups.reduce((s, g) => s + g.count, 0);
    el.querySelector('[data-count]').textContent = `(${n.toLocaleString('fr-FR')})`;
    keepFocus(chips, chipsHtml().toString());
    keepFocus(users, sectionsHtml(groups, team).toString());
  }
  paint();

  el.oninput = (e) => {
    if (e.target.id !== 'team-search') return;
    local.query = e.target.value;
    paint();
  };
  el.onchange = (e) => {
    const opt = e.target.dataset?.opt;
    if (!opt) return;
    local[opt] = e.target.checked;
    paint();
  };
  el.onclick = (e) => {
    if (e.target.closest('a[href]')) return;
    const r = e.target.closest('[data-filter-role]');
    if (r) {
      const role = r.dataset.filterRole;
      local.role = local.role === role ? null : role;
      if (local.role !== null) local.collapsed.delete(role);
      paint();
      if (local.role !== null)
        el.querySelector('[data-section]')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      return;
    }
    const t = e.target.closest('[data-toggle]');
    if (t) {
      const role = t.dataset.toggle;
      if (local.collapsed.has(role)) local.collapsed.delete(role);
      else local.collapsed.add(role);
      return paint();
    }
    if (e.target.closest('[data-person-add]')) return team?.add?.();
    const re = e.target.closest('[data-person-reactivate]');
    if (re) return team?.reactivate?.(Number(re.dataset.personReactivate));
    const c = e.target.closest('[data-clear]');
    if (c) {
      local[c.dataset.clear] = null;
      paint();
      return el.querySelector('#team-search')?.focus();
    }
    const b = e.target.closest('[data-person]') ?? e.target.closest('[data-row]')?.querySelector('[data-person]');
    if (!b) return;
    b.focus();
    ctx.openDetail({ table: 'Team', id: Number(b.dataset.person) });
  };
}
