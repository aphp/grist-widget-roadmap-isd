/** Briques communes de la coquille : gabarit sûr, icônes, badges, constantes, personnes ISD, focus. */
import { html, raw } from '../core/sanitize.js';
import { pickerGroups } from '../core/team-directory.js';
import { label, statusLabel } from '../labels.js';

/** Onglets, dans l'ordre de la spec ; « Mes tâches » (vue personnelle, P-UX-1) en tête. */
export const TABS = Object.freeze(['mytasks', 'gantt', 'kanban', 'table', 'portfolio', 'stats', 'synthesis', 'team']);
/** Icône DSFR de chaque onglet (décorative, devant le libellé). */
export const TAB_ICONS = Object.freeze({
  mytasks: 'calendar-todo-line',
  kanban: 'layout-column-line',
  table: 'table-line',
  gantt: 'road-map-line',
  portfolio: 'stack-line',
  stats: 'bar-chart-box-line',
  synthesis: 'file-text-line',
  team: 'team-line',
});
export const PROFILES = Object.freeze(['PO', 'DA', 'DS', 'DE', 'Mgmt']);
export const THEMES = Object.freeze(['auto', 'light', 'dark']);
const KNOWN_STATUSES = new Set(['todo', 'inprogress', 'review', 'done']);

/** Gabarit html`` dont le résultat est un fragment sûr, imbriquable sans double échappement. */
export const h = (strings, ...values) => raw(html(strings, ...values));

/** Icône du Système de design de l'État (classe fr-icon-*), décorative. */
export const icon = (name, extra = '') =>
  raw(`<span class="fr-icon-${name}${extra ? ` ${extra}` : ''}" aria-hidden="true"></span>`);

export const ICONS = Object.freeze({
  mark: raw(
    '<svg class="brand__mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">' +
      '<rect width="32" height="32" rx="4" class="brand__mark-bg"/>' +
      '<path d="M6 21h20" class="brand__mark-line"/>' +
      '<rect x="7" y="9" width="10" height="4" rx="2" class="brand__mark-bar"/>' +
      '<rect x="13" y="15" width="12" height="4" rx="2" class="brand__mark-bar brand__mark-bar--2"/>' +
      '<circle cx="22" cy="21" r="2.5" class="brand__mark-dot"/></svg>',
  ),
  warning: icon('error-warning-line', 'fr-icon--lg'),
  lock: icon('lock-line', 'fr-icon--lg'),
  empty: icon('search-line', 'fr-icon--lg'),
  people: icon('team-line', 'fr-icon--lg'),
  grist: icon('table-line', 'fr-icon--lg'),
});

/** Variante de badge DSFR par statut connu ; les autres statuts restent gris. Le libellé est toujours affiché. */
const BADGE = Object.freeze({
  todo: '',
  inprogress: 'fr-badge--info',
  review: 'fr-badge--new',
  done: 'fr-badge--success',
});

/** Badge de statut : couleur ET libellé (jamais la couleur seule). */
export function statusBadge(status) {
  const variant = KNOWN_STATUSES.has(status) ? BADGE[status] : '';
  return h`<span class="fr-badge fr-badge--sm fr-badge--no-icon ${raw(variant)}">${statusLabel(status)}</span>`;
}

/** Personnes des sélecteurs groupées par profil (PO, DA, DS, DE) puis Management (voir pickerGroups). */
export const isdPeopleByProfile = pickerGroups;

/**
 * Badge écrit du rôle d'une personne (« PO », « DE », « Mgmt »…) ; « Mgmt » porte le libellé complet
 * « Management » en infobulle et pour les lecteurs d'écran.
 */
export function roleSpan(cls, role) {
  const short = label(`profile.${role}`);
  const full = label(`profile.group.${role}`);
  return full === short
    ? h`<span class="${raw(cls)}">${short}</span>`
    : h`<span class="${raw(cls)}" title="${full}"><span aria-hidden="true">${short}</span><span class="fr-sr-only">${full}</span></span>`;
}

/** Texte complet d'un rôle (infobulles, lecteurs d'écran) : « Management » plutôt que « Mgmt ». */
export const roleFullText = (role) => label(`profile.group.${role}`);

/** Options d'une liste de personnes ISD groupées par profil. */
export function personOptions(model, selected, emptyLabel) {
  const groups = isdPeopleByProfile(model).map(
    (g) =>
      h`<optgroup label="${label(`profile.group.${g.role}`)}">
        ${g.people.map(
          (p) =>
            h`<option value="${p.id}" ${raw(p.id === selected ? 'selected' : '')}>
              ${p.nom || label('common.untitled')}
            </option>`,
        )}
      </optgroup>`,
  );
  return h`<option value="">${emptyLabel}</option>${raw(groups.join(''))}`;
}

/** Rend un contenu en gardant le focus sur l'élément de même id (les filtres sont redessinés à chaque changement). */
export function keepFocus(container, markup) {
  const active = document.activeElement;
  const id = active && container.contains(active) ? active.id : '';
  container.innerHTML = markup;
  if (id) document.getElementById(id)?.focus();
}

/**
 * Pastille « i » : bouton qui montre une explication en infobulle (survol et focus clavier), lue par les
 * lecteurs d'écran via aria-describedby.
 * @param {string} id identifiant de l'infobulle (unique dans la page)
 * @param {string} name nom accessible du bouton (« À propos de … »)
 * @param {string} text explication
 */
export const infoTip = (id, name, text) => {
  setupTooltips();
  return h`<span class="info-tip has-tooltip">
    <button type="button" class="info-tip__btn" aria-label="${name}" aria-describedby="${id}">i</button>
    <span class="tooltip" role="tooltip" id="${id}">${text}</span>
  </span>`;
};

const TIP_MARGIN = 8;
let tipsReady = false;
/**
 * Infobulles (.has-tooltip > .tooltip, WCAG 1.4.13), écouteurs délégués posés une seule fois : l'infobulle d'une
 * pastille « i » est recalée dans la fenêtre ; Échap masque l'infobulle montrée (survol ou focus) sans déplacer le
 * focus, jusqu'à ce que le pointeur quitte l'élément et que le focus en sorte. Le survol de l'infobulle elle-même la
 * garde ouverte (feuille de style).
 */
export function setupTooltips() {
  if (tipsReady || typeof document === 'undefined') return;
  tipsReady = true;
  const place = (e) => {
    const wrap = e.target instanceof Element ? e.target.closest('.info-tip') : null;
    const tip = wrap?.querySelector('.tooltip');
    if (!tip) return;
    // Décalage par translate : la position de la feuille de style (ancrée à gauche, ou à droite) reste la base
    tip.style.translate = '';
    const box = tip.getBoundingClientRect();
    const right = document.documentElement.clientWidth - TIP_MARGIN;
    const shift = Math.max(Math.min(0, right - box.right), TIP_MARGIN - box.left);
    tip.style.translate = shift ? `${shift}px 0` : '';
  };
  document.addEventListener('mouseover', place);
  document.addEventListener('focusin', place);
  const shown = (wrap) => wrap.matches(':hover') || wrap.contains(document.activeElement);
  // Phase de capture sur window : Échap ferme l'infobulle avant le panneau ou la fenêtre qui la contient
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      const open = [...document.querySelectorAll('.has-tooltip:not(.is-dismissed)')].filter(shown);
      if (!open.length) return;
      for (const wrap of open) wrap.classList.add('is-dismissed');
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  const restore = (e) => {
    const wrap = e.target instanceof Element ? e.target.closest('.has-tooltip.is-dismissed') : null;
    if (!wrap || wrap.contains(e.relatedTarget)) return;
    // Masquée jusqu'à ce que le pointeur ET le focus aient quitté l'élément
    if (e.type === 'mouseout' ? wrap.contains(document.activeElement) : wrap.matches(':hover')) return;
    wrap.classList.remove('is-dismissed');
  };
  document.addEventListener('mouseout', restore);
  document.addEventListener('focusout', restore);
}
