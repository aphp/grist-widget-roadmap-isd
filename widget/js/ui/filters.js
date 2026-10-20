/**
 * Filtres (catégorie, projet, chantier, personne, profil, statut, périmètre « Tout / Mes chantiers »,
 * case hors périmètre, et sous « + Filtres » : responsable, demandeur, tag) et étiquettes de filtres actifs supprimables.
 */
import { raw } from '../core/sanitize.js';
import { activeFilterChips, DEFAULT_FILTERS, EXTRA_FILTERS, filterChoices } from '../core/filters.js';
import { SCOPES } from '../core/home-view.js';
import { label, statusLabel } from '../labels.js';
import { h, keepFocus, personOptions, PROFILES, statusBadge } from './kit.js';

/** Libellés des étiquettes de filtres actifs (à partir de activeFilterChips). */
export function chipsFor(filters, model) {
  return activeFilterChips(filters, model).map((c) => {
    switch (c.field) {
      case 'search':
        return { field: c.field, label: label('chip.search', { valeur: filters.search }) };
      case 'statuses':
        return {
          field: c.field,
          label: label('chip.statuses', { valeur: filters.statuses.map(statusLabel).join(', ') }),
        };
      case 'profile':
        return { field: c.field, label: label('chip.profile', { valeur: label(`profile.group.${filters.profile}`) }) };
      case 'scope':
        return { field: c.field, label: label(`filters.scope.${filters.scope}`) };
      case 'includeOutOfScope':
        return { field: c.field, label: label('filters.outOfScope') };
      case 'isdOnly':
        return { field: c.field, label: label('filters.isdOnly') };
      default:
        return { field: c.field, label: label(`chip.${c.field}`, { valeur: c.label }) };
    }
  });
}

/**
 * Éléments à focaliser, par ordre de préférence, après le retrait de l'étiquette `field` :
 * l'étiquette suivante, sinon la précédente, sinon « Tout effacer », sinon la recherche.
 * @param {{field:string}[]} chips étiquettes avant le retrait
 * @param {string} field
 * @returns {string[]} ids
 */
export function focusAfterRemoval(chips, field) {
  const idx = chips.findIndex((c) => c.field === field);
  const neighbour = idx < 0 ? undefined : (chips[idx + 1] ?? chips[idx - 1]);
  return [...(neighbour ? [`chip-${neighbour.field}`] : []), 'btn-clear', 'f-search'];
}

/** Nombre de filtres actifs repliés sous « + Filtres ». */
export function extraCount(filters) {
  return EXTRA_FILTERS.filter((k) => filters[k] !== DEFAULT_FILTERS[k]).length;
}

/**
 * Périmètre en contrôle segmenté « Tout / Mes chantiers » (boutons radio d'un même groupe : flèches pour
 * changer). Sans « Je suis… », « Tout » est coché et « Mes chantiers » est indisponible, avec la raison
 * en infobulle (aria-disabled : ils restent atteignables au clavier et lus par les lecteurs d'écran).
 * @param {{scope:string}} f filtres
 * @param {boolean} disabled aucune personne choisie
 */
export function scopeHtml(f, disabled) {
  const current = disabled ? 'all' : f.scope;
  return h`<fieldset
    class="fr-segmented fr-segmented--sm filters__scope has-tooltip${raw(disabled ? ' is-disabled' : '')}"
    ${raw(disabled ? 'aria-describedby="tip-scope"' : '')}
  >
    <legend class="fr-segmented__legend filters__scope-legend">${label('filters.scope')}</legend>
    <div class="fr-segmented__elements">
      ${SCOPES.map(
        (s) =>
          h`<div class="fr-segmented__element">
            <input
              type="radio"
              name="f-perimetre"
              id="f-perimetre-${s}"
              value="${s}"
              data-scope="${s}"
              ${raw(s === current ? 'checked' : '')}
              ${raw(disabled && s !== 'all' ? 'aria-disabled="true"' : '')}
            />
            <label class="fr-label" for="f-perimetre-${s}" title="${label(`filters.scope.${s}.title`)}">
              ${label(`filters.scope.${s}`)}
            </label>
          </div>`,
      )}
    </div>
    ${disabled ? h`<span class="tooltip" role="tooltip" id="tip-scope">${label('filters.scope.disabled')}</span>` : ''}
  </fieldset>`;
}

/**
 * Filtres sur une seule ligne : listes compactes dont l'option par défaut porte le libellé (« — Catégorie — »),
 * libellé visible seulement des lecteurs d'écran ; Responsable et Demandeur sous « + Filtres ». La ligne
 * d'étiquettes n'existe que si un filtre est actif.
 * @param {HTMLElement} root conteneur des filtres
 * @param {{onFilters(p:object):void, onClearFilters():void}} on
 * @param {ReturnType<import('./popovers.js').createPopovers>} popovers
 */
export function createFilters(root, on, popovers) {
  let filtersOpen = false; // en dessous de 1 280 px : panneau replié derrière « Filtres (n) »
  let moreOpen = null; // « + Filtres » : ouvert d'office au premier rendu si un de ses filtres est actif
  let current = null; // dernier état rendu : { model, prefs, chips }

  function render(model, prefs) {
    const f = prefs.filters;
    const chips = chipsFor(f, model);
    current = { model, prefs, chips };
    const choices = filterChoices(model, f, prefs);
    const statuses = model.statuses.tasks;
    const extras = extraCount(f);
    if (moreOpen === null) moreOpen = extras > 0;
    const statusText = f.statuses.length
      ? f.statuses.length === 1
        ? statusLabel(f.statuses[0])
        : label('filters.status.some', { n: f.statuses.length })
      : label('filters.status.all');
    const scopeDisabled = prefs.me === null;
    // Valeur choisie lisible en entier au survol, même si la liste la tronque
    const titleOf = (key, fallback) => (key ? (model.nodes.get(key)?.title ?? fallback) : fallback);
    const option = (n, selected) =>
      h`<option value="${n.key}" ${raw(n.key === selected ? 'selected' : '')}>${n.title || label('common.untitled')}</option>`;
    // Liste groupée par niveau au-dessus (projets par catégorie, chantiers par projet)
    const grouped = (groups, selected) =>
      groups.map(
        (g) =>
          h`<optgroup label="${g.group.title || label('common.untitled')}">${g.items.map((n) => option(n, selected))}</optgroup>`,
      );
    // Liste compacte : libellé caché, rappelé par l'option par défaut et par l'infobulle
    const field = (name, title, options) =>
      h`<div class="fr-select-group field">
        <label class="fr-label fr-sr-only" for="f-${name}">${label(`filters.${name}`)}</label>
        <select id="f-${name}" class="fr-select" data-filter="${name}" title="${title}">
          <option value="">${label(`filters.${name}.any`)}</option>
          ${options}
        </select>
      </div>`;
    const select = (name, groups, flat) =>
      field(
        name,
        titleOf(f[name], label(`filters.${name}.all`)),
        flat ? groups.map((n) => option(n, f[name])) : grouped(groups, f[name]),
      );
    const personTitle = f.person ? (model.people.get(f.person)?.nom ?? '') : label('filters.person.all');
    const respTitle = f.responsable ? (model.people.get(f.responsable)?.nom ?? '') : label('filters.responsable.all');
    keepFocus(
      root,
      h`
        <div class="filters">
          <button
            id="btn-filters"
            type="button"
            class="fr-btn fr-btn--secondary fr-btn--sm fr-btn--icon-left fr-icon-filter-line filters__toggle"
            aria-expanded="${String(filtersOpen)}"
            aria-controls="filters-panel"
          >
            ${label('filters.toggle', { n: chips.length })}
          </button>
          <div
            id="filters-panel"
            class="filters__panel"
            data-open="${String(filtersOpen)}"
            role="group"
            aria-label="${label('filters.title')}"
          >
            ${select('categorie', choices.categories, true)}
            ${select('projet', choices.projets, false)}
            ${select('chantier', choices.chantiers, false)}
            <div class="fr-select-group field">
              <label class="fr-label fr-sr-only" for="f-person">${label('filters.person')}</label>
              <select id="f-person" class="fr-select" data-filter="person" title="${personTitle}">
                ${personOptions(model, f.person, label('filters.person.any'))}
              </select>
            </div>
            ${field(
              'profile',
              f.profile ? label(`profile.group.${f.profile}`) : label('filters.profile.all.title'),
              PROFILES.map(
                (p) =>
                  h`<option value="${p}" ${raw(f.profile === p ? 'selected' : '')}>${label(`profile.${p}`)}</option>`,
              ),
            )}
            <div class="fr-select-group field popover-anchor">
              <span class="fr-label fr-sr-only" id="lbl-status">${label('filters.status')}</span>
              <button
                id="btn-status"
                type="button"
                class="fr-select select--button"
                aria-haspopup="true"
                aria-expanded="${String(popovers.isOpen('status'))}"
                aria-controls="status-panel"
                aria-describedby="lbl-status"
                title="${f.statuses.length ? f.statuses.map(statusLabel).join(', ') : statusText}"
              >
                ${statusText}
              </button>
              <div
                id="status-panel"
                class="popover"
                role="group"
                aria-labelledby="lbl-status"
                ${raw(popovers.isOpen('status') ? '' : 'hidden')}
              >
                <ul class="list popover__list">
                  ${statuses.map(
                    (s, i) =>
                      h`<li class="fr-checkbox-group fr-checkbox-group--sm">
                        <input
                          type="checkbox"
                          id="status-${i}"
                          data-status="${s}"
                          ${raw(f.statuses.includes(s) ? 'checked' : '')}
                        />
                        <label class="fr-label" for="status-${i}">${statusBadge(s)}</label>
                      </li>`,
                  )}
                </ul>
              </div>
            </div>
            ${scopeHtml(f, scopeDisabled)}
            <div class="filters__checks">
              <div class="fr-checkbox-group fr-checkbox-group--sm">
                <input
                  type="checkbox"
                  id="f-scope"
                  data-filter-check="includeOutOfScope"
                  ${raw(f.includeOutOfScope ? 'checked' : '')}
                />
                <label class="fr-label" for="f-scope">${label('filters.outOfScope')}</label>
              </div>
              <div class="fr-checkbox-group fr-checkbox-group--sm">
                <input
                  type="checkbox"
                  id="f-isd-only"
                  data-filter-check="isdOnly"
                  ${raw(f.isdOnly ? 'checked' : '')}
                />
                <label class="fr-label" for="f-isd-only">
                  ${label('filters.isdOnly')}
                  <span class="fr-hint-text">${label('filters.isdOnly.title')}</span>
                </label>
              </div>
            </div>
            <button
              id="btn-more"
              type="button"
              class="fr-btn fr-btn--tertiary fr-btn--sm filters__more-toggle"
              aria-expanded="${String(moreOpen)}"
              aria-controls="filters-more"
            >
              ${extras ? label('filters.more.n', { n: extras }) : label('filters.more')}
            </button>
            <div
              id="filters-more"
              class="filters__more"
              role="group"
              aria-label="${label('filters.more.label')}"
              ${raw(moreOpen ? '' : 'hidden')}
            >
              ${field(
                'responsable',
                respTitle,
                [
                  // Responsable choisi absent des choix (projet masqué ou hors périmètre) : gardé pour rester visible
                  ...(f.responsable &&
                  !choices.responsables.some((p) => p.id === f.responsable) &&
                  model.people.has(f.responsable)
                    ? [model.people.get(f.responsable)]
                    : []),
                  ...choices.responsables,
                ].map(
                  (p) =>
                    h`<option value="${p.id}" ${raw(p.id === f.responsable ? 'selected' : '')}>${p.nom || label('common.untitled')}</option>`,
                ),
              )}
              ${field(
                'demandeur',
                f.demandeur || label('filters.demandeur.all'),
                [
                  // Demandeur choisi absent des choix (projet masqué) : gardé pour rester visible
                  ...(f.demandeur && !choices.demandeurs.includes(f.demandeur) ? [f.demandeur] : []),
                  ...choices.demandeurs,
                ].map((d) => h`<option value="${d}" ${raw(d === f.demandeur ? 'selected' : '')}>${d}</option>`),
              )}
              ${field(
                'tag',
                f.tag || label('filters.tag.all'),
                [
                  // Tag choisi absent des données (retiré entre-temps) : gardé pour rester visible
                  ...(f.tag && !choices.tags.includes(f.tag) ? [f.tag] : []),
                  ...choices.tags,
                ].map((t) => h`<option value="${t}" ${raw(t === f.tag ? 'selected' : '')}>${t}</option>`),
              )}
            </div>
          </div>
        </div>
        ${
          chips.length
            ? h`<div class="chips" role="region" aria-label="${label('filters.active')}">
                <ul class="fr-tags-group chips__list">
                  ${chips.map(
                    (c) =>
                      h`<li>
                        <button
                          type="button"
                          id="chip-${c.field}"
                          class="fr-tag fr-tag--sm fr-tag--dismiss"
                          data-remove="${c.field}"
                          aria-label="${label('chip.remove', { filtre: c.label })}"
                        >
                          ${c.label}
                        </button>
                      </li>`,
                  )}
                </ul>
                <button id="btn-clear" type="button" class="fr-btn fr-btn--tertiary-no-outline fr-btn--sm">
                  ${label('filters.clear')}
                </button>
              </div>`
            : ''
        }
      `,
    );
  }

  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.filter) {
      const v = t.value;
      const key = t.dataset.filter;
      const isId = key === 'person' || key === 'responsable';
      on.onFilters({ [key]: isId ? (v ? Number(v) : null) : key === 'profile' ? v || null : v });
    } else if (t.dataset.filterCheck) {
      on.onFilters({ [t.dataset.filterCheck]: t.checked });
    } else if (t.dataset.scope) {
      // Choix indisponible (sans « Je suis… ») atteint aux flèches : « Tout » reste coché
      if (t.getAttribute('aria-disabled') === 'true') {
        document.getElementById('f-perimetre-all').checked = true;
        return;
      }
      on.onFilters({ scope: t.dataset.scope });
    } else if (t.dataset.status !== undefined) {
      const sel = [...root.querySelectorAll('[data-status]:checked')].map((x) => x.dataset.status);
      on.onFilters({ statuses: sel });
    }
  });
  root.addEventListener('click', (e) => {
    const disabled = e.target.closest('input[aria-disabled="true"]');
    if (disabled) {
      e.preventDefault();
      return;
    }
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'btn-filters') {
      filtersOpen = !filtersOpen;
      b.setAttribute('aria-expanded', String(filtersOpen));
      document.getElementById('filters-panel').dataset.open = String(filtersOpen);
    } else if (b.id === 'btn-more') {
      moreOpen = !moreOpen;
      b.setAttribute('aria-expanded', String(moreOpen));
      document.getElementById('filters-more').hidden = !moreOpen;
      if (moreOpen) document.getElementById('f-responsable')?.focus();
    } else if (b.id === 'btn-status') {
      popovers.toggle('status');
    } else if (b.dataset.remove) {
      const field = b.dataset.remove;
      const ids = focusAfterRemoval(current.chips, field);
      on.onFilters({ [field]: DEFAULT_FILTERS[field] });
      ids
        .map((id) => document.getElementById(id))
        .find(Boolean)
        ?.focus();
    } else if (b.id === 'btn-clear') {
      on.onClearFilters();
      document.getElementById('f-search')?.focus();
    }
  });

  return { render };
}
