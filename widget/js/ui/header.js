/**
 * En-tête : titre et pastille « Lecture seule », recherche (anti-rebond 250 ms), « Je suis… » (avec l'invite
 * « Qui êtes-vous ? » au premier lancement), Actualiser, bascule clair / sombre, Préférences (thème, vue d'accueil,
 * projets masqués).
 */
import { shouldPromptMe } from '../core/filters.js';
import { HOME_LAST } from '../core/home-view.js';
import { raw } from '../core/sanitize.js';
import { label } from '../labels.js';
import { h, icon, ICONS, isdPeopleByProfile, keepFocus, personOptions, TABS, THEMES } from './kit.js';

/** Vrai si le thème rendu est sombre (attribut posé par main.js et theme-boot.js). */
const isDark = () => document.documentElement.getAttribute('data-fr-theme') === 'dark';

/**
 * Invite non bloquante « Qui êtes-vous ? » : personnes ISD groupées par profil, bouton « Passer ».
 * Boîte de dialogue non modale, ancrée sous « Je suis… » ; le reste du widget reste utilisable.
 */
export function meInviteHtml(model) {
  const groups = isdPeopleByProfile(model);
  return h`<div
    id="me-invite"
    class="popover popover--end me-invite"
    role="dialog"
    aria-modal="false"
    aria-labelledby="me-invite-title"
    aria-describedby="me-invite-help"
    tabindex="-1"
  >
    <h2 id="me-invite-title" class="me-invite__title">${label('me.invite.title')}</h2>
    <p id="me-invite-help" class="popover__help">${label('me.invite.help')}</p>
    <div class="me-invite__groups">
      ${groups.map(
        (g) =>
          h`<section class="me-invite__group" aria-labelledby="me-invite-g-${g.role}">
            <h3 id="me-invite-g-${g.role}" class="me-invite__role">${label(`profile.group.${g.role}`)}</h3>
            <ul class="list me-invite__list">
              ${g.people.map(
                (p) =>
                  h`<li><button type="button" class="me-invite__person" data-me-pick="${p.id}">${p.nom || label('common.untitled')}</button></li>`,
              )}
            </ul>
          </section>`,
      )}
    </div>
    <div class="me-invite__foot">
      <button type="button" id="btn-me-skip" class="fr-btn fr-btn--tertiary fr-btn--sm" data-me-skip>
        ${label('me.invite.skip')}
      </button>
    </div>
  </div>`;
}

/**
 * Choix « Vue d'accueil » des Préférences : dernière vue consultée, puis chaque onglet. Sans vue d'accueil
 * enregistrée (aucune personne choisie), « Dernière vue consultée » est sélectionnée : c'est le comportement réel.
 * @param {string|null} homeView
 */
export function homeViewFieldHtml(homeView) {
  const current = homeView ?? HOME_LAST;
  const option = (value, text) =>
    h`<option value="${value}" ${raw(value === current ? 'selected' : '')}>${text}</option>`;
  return h`<div class="popover__section prefs-home">
    <label class="fr-label popover__title" for="pref-home">${label('prefs.home')}</label>
    <p class="popover__help" id="pref-home-help">${label('prefs.home.help')}</p>
    <select id="pref-home" class="fr-select" aria-describedby="pref-home-help">
      ${option(HOME_LAST, label('prefs.home.last'))}
      ${TABS.map((t) => option(t, label(`view.${t}`)))}
    </select>
  </div>`;
}

export const SEARCH_DELAY_MS = 250;

/** Raison de lecture seule affichée dans la pastille de l'en-tête. */
const PILL_REASON = Object.freeze({ doc: 'edit.pill.doc', flags: 'edit.pill.flags', viewer: 'edit.pill.viewer' });

/**
 * Pastille d'état d'édition : « Lecture seule » (avec sa raison), « Édition » ou « Mode essai · n ». Ces deux
 * dernières ouvrent le panneau d'édition (journal de la session, « Annuler la dernière modification »).
 * @param {{mode:'off'|'dry-run'|'on', reason:string, canEdit?:boolean, count:number}} edit
 */
export function editPill(edit, open = false) {
  // Session passée en lecture après des modifications : la pastille garde l'accès au journal (sans « Annuler »)
  const keepLog = edit.mode !== 'off' && edit.canEdit === false && edit.count > 0;
  if (keepLog) {
    const why = label(PILL_REASON[edit.reason] ?? 'app.readonly');
    return h`<span class="popover-anchor edit-anchor">
      <button type="button" id="btn-edit-pill" class="readonly-pill edit-pill" title="${why}" aria-haspopup="true" aria-expanded="${String(open)}" aria-controls="edit-panel">
        ${icon('lock-line', 'fr-icon--sm')}<span>${label('app.readonly.short')} · ${edit.count}</span>
      </button>
      <div id="edit-panel" class="popover edit-panel" role="group" aria-label="${why}" ${raw(open ? '' : 'hidden')}></div>
    </span>`;
  }
  if (edit.mode === 'off' || edit.canEdit === false) {
    const why = label(PILL_REASON[edit.reason] ?? 'app.readonly');
    return h`<span class="readonly-pill" title="${why}">
      ${icon('lock-line', 'fr-icon--sm')}
      <span aria-hidden="true">${label('app.readonly.short')}</span>
      <span class="fr-sr-only">${why}</span>
    </span>`;
  }
  const dry = edit.mode === 'dry-run';
  const text = dry ? `${label('edit.pill.dry.short')} · ${edit.count}` : label('edit.pill.on.short');
  return h`<span class="popover-anchor edit-anchor">
    <button type="button" id="btn-edit-pill" class="readonly-pill edit-pill ${raw(dry ? 'edit-pill--dry' : 'edit-pill--on')}"
      title="${label(dry ? 'edit.pill.dry' : 'edit.pill.on')}" aria-haspopup="true" aria-expanded="${String(open)}" aria-controls="edit-panel">
      ${icon(dry ? 'test-tube-line' : 'edit-line', 'fr-icon--sm')}
      <span>${text}</span>
    </button>
    <div id="edit-panel" class="popover edit-panel" role="group" aria-label="${label(dry ? 'edit.panel.title' : 'edit.pill.on.short')}" ${raw(open ? '' : 'hidden')}></div>
  </span>`;
}

/**
 * @param {HTMLElement} root conteneur de l'en-tête
 * @param {{onFilters(p:object):void, onMe(id:number|null):void, onMeSkip():void, onTheme(t:string):void,
 *          onHidden(ids:number[]):void, onRefresh():void}} on
 * @param {ReturnType<import('./popovers.js').createPopovers>} popovers
 */
export function createHeader(root, on, popovers) {
  let searchTimer = null;
  let inviteFocused = false; // le focus n'est donné à l'invite qu'à sa première apparition
  let inviteOpen = false;

  function render(model, prefs, edit = { mode: 'off', reason: 'off', count: 0 }) {
    inviteOpen = shouldPromptMe(prefs) && isdPeopleByProfile(model).length > 0;
    const dark = isDark();
    const projects = [...model.projects.values()]
      .filter((p) => p.inScope)
      .sort((a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }));
    const hidden = new Set(prefs.hiddenProjects);
    const prefsOpen = popovers.isOpen('prefs');
    keepFocus(
      root,
      h`
        <div class="app-header__row">
          <div class="brand">
            ${ICONS.mark}
            <h1 class="brand__title">${label('app.title')}</h1>
            ${editPill(edit, popovers.isOpen('edit'))}
          </div>
          <div class="header-search fr-input-wrap fr-icon-search-line">
            <label class="fr-sr-only" for="f-search">${label('search.label')}</label>
            <input
              id="f-search"
              class="fr-input"
              type="search"
              autocomplete="off"
              placeholder="${label('search.placeholder')}"
              value="${prefs.filters.search}"
            />
          </div>
          <div class="header-actions">
            <div class="popover-anchor me-anchor">
              <label class="fr-sr-only" for="f-me">${label('me.label')}</label>
              <select id="f-me" class="fr-select header-me">
                ${personOptions(model, prefs.me, label('me.none'))}
              </select>
              ${inviteOpen ? meInviteHtml(model) : ''}
            </div>
            <button
              id="btn-refresh"
              type="button"
              class="fr-btn fr-btn--secondary fr-btn--icon-left fr-icon-refresh-line"
              title="${label('app.refresh')}"
            >
              <span class="btn__text">${label('app.refresh')}</span>
            </button>
            <button
              id="btn-theme"
              type="button"
              class="fr-btn fr-btn--tertiary fr-btn--icon-left ${raw(dark ? 'fr-icon-sun-line' : 'fr-icon-moon-line')}"
              aria-pressed="${String(dark)}"
              title="${label(dark ? 'theme.toggle.title.dark' : 'theme.toggle.title.light')}"
            >
              <span class="btn__text">${label('theme.toggle')}</span>
            </button>
            <div class="popover-anchor prefs-anchor">
              <button
                id="btn-prefs"
                type="button"
                class="fr-btn fr-btn--tertiary fr-btn--icon-left fr-icon-equalizer-line"
                title="${label('prefs.button')}"
                aria-haspopup="true"
                aria-expanded="${String(prefsOpen)}"
                aria-controls="prefs-panel"
              >
                <span class="btn__text">${label('prefs.button')}</span>
              </button>
              <div
                id="prefs-panel"
                class="popover popover--end"
                role="group"
                aria-label="${label('prefs.button')}"
                ${raw(prefsOpen ? '' : 'hidden')}
              >
                <fieldset class="fr-segmented fr-segmented--sm popover__section">
                  <legend class="fr-segmented__legend popover__title">${label('prefs.theme')}</legend>
                  <div class="fr-segmented__elements">
                    ${THEMES.map(
                      (t) =>
                        h`<div class="fr-segmented__element">
                          <input
                            type="radio"
                            name="theme-choice"
                            id="theme-${t}"
                            value="${t}"
                            ${raw(prefs.theme === t ? 'checked' : '')}
                          />
                          <label class="fr-label" for="theme-${t}">${label(`prefs.theme.${t}`)}</label>
                        </div>`,
                    )}
                  </div>
                </fieldset>
                ${homeViewFieldHtml(prefs.homeView)}
                <fieldset class="popover__section">
                  <legend class="popover__title">${label('prefs.hidden')}</legend>
                  <p class="popover__help">${label('prefs.hidden.help')}</p>
                  ${
                    projects.length
                      ? h`<ul class="list popover__list">
                        ${projects.map(
                          (p) =>
                            h`<li class="fr-checkbox-group fr-checkbox-group--sm">
                              <input
                                type="checkbox"
                                id="hide-${p.id}"
                                data-hide-project="${p.id}"
                                ${raw(hidden.has(p.id) ? 'checked' : '')}
                              />
                              <label class="fr-label" for="hide-${p.id}">${p.title || label('common.untitled')}</label>
                            </li>`,
                        )}
                      </ul>`
                      : h`<p class="popover__help">${label('prefs.hidden.empty')}</p>`
                  }
                </fieldset>
              </div>
            </div>
          </div>
        </div>
      `,
    );
    if (inviteOpen && !inviteFocused) {
      inviteFocused = true;
      document.getElementById('me-invite')?.focus();
    }
  }

  /** Échap : l'invite ouverte vaut « Passer » ; vrai si elle a été fermée. */
  function closeInvite() {
    if (!inviteOpen || !document.getElementById('me-invite')) return false;
    skip();
    return true;
  }

  function skip() {
    inviteOpen = false;
    inviteFocused = false;
    on.onMeSkip();
    document.getElementById('f-me')?.focus();
  }

  /** Synchronise le champ de recherche quand le filtre est modifié ailleurs (étiquette, « Tout effacer »). */
  function syncSearch(value) {
    const input = document.getElementById('f-search');
    if (input && input.value !== value) input.value = value;
  }

  /** Annule une recherche en attente (anti-rebond), pour qu'elle ne soit pas réappliquée après un effacement. */
  function cancelSearch() {
    clearTimeout(searchTimer);
    searchTimer = null;
  }

  /** Après un choix de personne (invite ou liste) : liste à jour et invite retirée, sans redessiner l'en-tête. */
  function syncMe(id) {
    inviteOpen = false;
    inviteFocused = false;
    document.getElementById('me-invite')?.remove();
    const select = document.getElementById('f-me');
    if (select) select.value = id === null ? '' : String(id);
  }

  /** Après le premier choix d'une personne : « Vue d'accueil » des Préférences à jour, sans redessiner l'en-tête. */
  function syncHome(homeView) {
    const select = document.getElementById('pref-home');
    if (select) select.value = homeView ?? HOME_LAST;
  }

  /** Après un changement de thème : bouton soleil / lune et choix des préférences à jour. */
  function syncTheme(theme) {
    const dark = isDark();
    const b = document.getElementById('btn-theme');
    if (b) {
      b.classList.toggle('fr-icon-sun-line', dark);
      b.classList.toggle('fr-icon-moon-line', !dark);
      b.setAttribute('aria-pressed', String(dark));
      b.title = label(dark ? 'theme.toggle.title.dark' : 'theme.toggle.title.light');
    }
    const radio = document.getElementById(`theme-${theme}`);
    if (radio) radio.checked = true;
  }

  function setRefreshing(busy) {
    const b = document.getElementById('btn-refresh');
    if (!b) return;
    b.disabled = busy;
    b.querySelector('.btn__text').textContent = label(busy ? 'app.refreshing' : 'app.refresh');
  }

  root.addEventListener('input', (e) => {
    if (e.target.id !== 'f-search') return;
    cancelSearch();
    const value = e.target.value;
    searchTimer = setTimeout(() => {
      searchTimer = null;
      on.onFilters({ search: value });
    }, SEARCH_DELAY_MS);
  });
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'f-me') on.onMe(t.value ? Number(t.value) : null);
    else if (t.name === 'theme-choice') on.onTheme(t.value);
    else if (t.id === 'pref-home') on.onHome(t.value);
    else if (t.dataset.hideProject) {
      const ids = [...root.querySelectorAll('[data-hide-project]:checked')].map((x) => Number(x.dataset.hideProject));
      on.onHidden(ids);
    }
  });
  root.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'btn-refresh') on.onRefresh();
    else if (t.id === 'btn-theme') on.onTheme(isDark() ? 'light' : 'dark');
    else if (t.dataset.meSkip !== undefined) skip();
    else if (t.dataset.mePick) {
      inviteOpen = false;
      inviteFocused = false;
      on.onMe(Number(t.dataset.mePick));
      document.getElementById('f-me')?.focus();
    } else if (t.id === 'btn-prefs') popovers.toggle('prefs');
    else if (t.id === 'btn-edit-pill') on.onEditPanel?.();
    else if (t.dataset.editUndo !== undefined) on.onUndo?.();
  });

  return { render, syncSearch, cancelSearch, setRefreshing, closeInvite, syncMe, syncHome, syncTheme };
}
