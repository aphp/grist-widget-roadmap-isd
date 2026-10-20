/** Titre de vue commun : filet d'accent, titre et sous-titre sur une ligne, contrôles de la vue à droite. */
import { label } from '../labels.js';
import { h } from './kit.js';

/**
 * Boutons de création, une seule fois dans l'en-tête global (bout droit de la ligne des onglets) : « Nouveau
 * chantier » (secondaire) et « Nouvelle tâche » (bouton rouge, réservé à la création). Absents si l'édition est
 * coupée, sans droit, ou si la Feuille refuse l'ajout.
 * @param {{task:boolean, chantier:boolean}|null} [c]
 */
export function createButtons(c) {
  if (!c?.task && !c?.chantier) return '';
  return h`<div class="create-actions" role="group" aria-label="${label('create.group')}">
    ${c.chantier ? h`<button type="button" class="fr-btn fr-btn--sm fr-btn--secondary fr-btn--icon-left fr-icon-add-line" id="btn-new-chantier" data-create="chantier">${label('create.chantier.open')}</button>` : ''}
    ${c.task ? h`<button type="button" class="fr-btn fr-btn--sm fr-btn--icon-left fr-icon-add-line create-primary" id="btn-new-task" data-create="task">${label('create.task.open')}</button>` : ''}
  </div>`;
}

/**
 * En-tête d'une vue, sur une seule ligne (repli sous le titre en étroit).
 * @param {string} title titre de la vue (h2)
 * @param {string|object} [subtitle] texte, ou fragment sûr h`` (ex. compteur avec role="status")
 * @param {object|string} [controls] fragment sûr h`` des contrôles (listes, exports…)
 * @param {{id?:string}} [opts] id du titre, pour aria-labelledby
 * @returns {object} fragment sûr
 */
export function viewHeading(title, subtitle = '', controls = '', opts = {}) {
  const sub =
    typeof subtitle === 'string'
      ? subtitle
        ? h`<p class="view-heading__sub">${subtitle}</p>`
        : ''
      : h`<div class="view-heading__sub">${subtitle}</div>`;
  return h`<header class="view-heading">
    <div class="view-heading__text">
      <h2 class="view-heading__title"${opts.id ? h` id="${opts.id}"` : ''}>${title}</h2>
      ${sub}
    </div>
    ${controls ? h`<div class="view-heading__controls">${controls}</div>` : ''}
  </header>`;
}
