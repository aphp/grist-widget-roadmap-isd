/**
 * Panneau détail (à droite), modal (aria-modal="true" à l'ouverture) : le reste de la page est couvert d'un voile
 * qui capte les clics ; focus sur « Fermer » à l'ouverture, Tab boucle dans le panneau (et le message « … Annuler »,
 * [data-focus-cycle]) et tout focus qui en sort
 * (repeinture de la vue, raccourci) y est ramené ; fermeture par « Fermer », Échap ou clic sur le voile, focus rendu
 * à l'élément d'origine. Les liens internes ([data-ref-table]) et « Retour » sont confiés à main.js.
 *
 * Pas d'attribut inert sur l'application (P-PERF-3) : le poser ou le retirer restyle tous les nœuds de la page
 * (≈ 50 ms sur le Tableau complet, ×10 avec le suivi CSS), alors qu'aria-modal suffit aux technologies d'assistance
 * (motif « Dialog (Modal) » de l'APG) et que le voile et la garde de focus couvrent souris et clavier.
 */
import { label } from '../labels.js';
import { h } from './kit.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * @param {HTMLElement} root l'élément <aside role="dialog">
 * @param {{onCloseDetail():void, onDetailRef?(ref:{table:string,id:number}):void, onDetailBack?():void}} on
 */
export function createDrawer(root, on) {
  let opener = null;
  let openerId = '';
  /** Dernier élément focalisé dans la fiche, pour y revenir si le focus s'échappe. */
  let lastInside = null;

  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  backdrop.hidden = true;
  backdrop.setAttribute('aria-hidden', 'true');
  root.before(backdrop);
  backdrop.addEventListener('click', () => on.onCloseDetail());

  /**
   * Garde de focus : tant que la fiche est ouverte, un focus posé hors d'elle y est ramené. Les éléments marqués
   * data-keep-active (fenêtres <dialog> ouvertes depuis la fiche : création, changement de chantier ; message
   * « … Annuler ») gardent le focus.
   */
  function guardFocus(e) {
    if (root.dataset.open !== 'true') return;
    if (root.contains(e.target)) {
      lastInside = e.target;
      return;
    }
    if (e.target instanceof Element && e.target.closest('[data-keep-active]')) return;
    const back =
      lastInside?.isConnected && root.contains(lastInside) ? lastInside : document.getElementById('detail-title');
    back?.focus();
  }

  /**
   * Ouvre la fiche, ou remplace son contenu si elle est déjà ouverte (l'élément d'origine est conservé).
   * @param {*} kind niveau (texte ou fragment h``)
   * @param {string} title
   * @param {*} [body] contenu (fragment h``) ; par défaut, un texte d'attente
   * @param {{backTitle?:string, foot?:*, mode?:string}} [opts] titre de la fiche précédente (bouton « Retour »),
   *   pied fixe (formulaire : Enregistrer / Annuler), mode ('read' ou 'edit', posé sur data-mode)
   */
  function open(kind, title, body, opts = {}) {
    const wasOpen = root.dataset.open === 'true';
    if (!wasOpen) {
      opener = document.activeElement;
      openerId = opener?.id ?? '';
    }
    const back = opts.backTitle
      ? h`<button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary-no-outline fr-icon-arrow-left-line fr-btn--icon-left drawer__back" id="btn-detail-back" title="${label('detail.back', { titre: opts.backTitle })}">${label('detail.backShort')}</button>`
      : '';
    root.innerHTML = h`
      <div class="drawer__head">
        <h2 class="drawer__title" id="detail-title" tabindex="-1">
          <span class="drawer__kind">${kind}</span>${title}
        </h2>
        <div class="drawer__actions">
          ${back}
          <button type="button" class="fr-btn--close fr-btn" id="btn-detail-close" title="${label('detail.close')}" aria-label="${label('detail.close')}">
            ${label('detail.closeShort')}
          </button>
        </div>
      </div>
      <div class="drawer__body">${body ?? h`<p>${label('detail.pending')}</p>`}</div>
      ${opts.foot ? h`<div class="drawer__foot">${opts.foot}</div>` : ''}
    `;
    root.dataset.mode = opts.mode ?? 'read';
    if (!wasOpen) {
      backdrop.hidden = false;
      document.addEventListener('focusin', guardFocus, true);
    }
    root.dataset.open = 'true';
    root.setAttribute('aria-modal', 'true');
    root.removeAttribute('inert');
    // Navigation interne ou relecture des données : focus sur le titre ; première ouverture : sur « Fermer »
    const focusId = opts.focus ?? (wasOpen ? 'detail-title' : 'btn-detail-close');
    (document.getElementById(focusId) ?? document.getElementById('detail-title'))?.focus();
  }

  /** Ferme la fiche ; vrai si elle était ouverte. */
  function close() {
    if (root.dataset.open !== 'true') return false;
    root.dataset.open = 'false';
    root.setAttribute('inert', '');
    root.setAttribute('aria-modal', 'false');
    backdrop.hidden = true;
    document.removeEventListener('focusin', guardFocus, true);
    lastInside = null;
    // La vue a pu être redessinée (relecture des données) : on retrouve l'élément d'origine par son id
    const target = opener?.isConnected ? opener : openerId ? document.getElementById(openerId) : null;
    target?.focus();
    opener = null;
    openerId = '';
    return true;
  }

  root.setAttribute('inert', '');
  root.setAttribute('aria-modal', 'false');
  root.setAttribute('aria-label', label('detail.label'));
  root.addEventListener('click', (e) => {
    if (e.target.closest('#btn-detail-close')) return on.onCloseDetail();
    if (e.target.closest('#btn-detail-back')) return on.onDetailBack?.();
    const link = e.target.closest('[data-ref-table]');
    if (link) on.onDetailRef?.({ table: link.dataset.refTable, id: Number(link.dataset.refId) });
  });
  /**
   * Piège du focus : Tab et Maj+Tab bouclent dans le panneau tant qu'il est ouvert, en passant aussi par les zones
   * [data-focus-cycle] hors du panneau (message « … Annuler » : son bouton reste atteignable au clavier). Une
   * fenêtre <dialog> ouverte depuis la fiche garde son propre piège.
   */
  function trapTab(e) {
    if (e.key !== 'Tab' || root.dataset.open !== 'true') return;
    const active = document.activeElement;
    if (active?.closest?.('dialog[open]')) return;
    const visible = (x) => x.offsetParent !== null || x === active;
    const extra = [...document.querySelectorAll('[data-focus-cycle]')]
      .filter((z) => !root.contains(z))
      .flatMap((z) => [...z.querySelectorAll(FOCUSABLE)]);
    const items = [...root.querySelectorAll(FOCUSABLE), ...extra].filter(visible);
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(active);
    let next;
    if (at !== -1) next = items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length];
    else if (active && active !== document.body) {
      // Focus sur un élément non tabulable (titre de la fiche) : élément suivant ou précédent dans le document
      const after = (x) => active.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING;
      next = e.shiftKey ? items.findLast((x) => !after(x)) : items.find(after);
    }
    (next ?? (e.shiftKey ? items.at(-1) : items[0])).focus();
  }
  document.addEventListener('keydown', trapTab, true);
  return { open, close, isOpen: () => root.dataset.open === 'true', root };
}
