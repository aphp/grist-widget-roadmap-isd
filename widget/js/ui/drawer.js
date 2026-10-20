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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Élément atteignable au Tab : affiché, ni dans un bloc masqué, ni inerte, ni désactivé par son fieldset. */
const tabbable = (x) =>
  x.getClientRects().length > 0 && !x.closest('[hidden], [inert], fieldset[disabled]') && x.tabIndex >= 0;

/** Même groupe de boutons radio (même nom, même formulaire) : un seul arrêt au Tab. */
const sameRadioGroup = (a, b) =>
  a instanceof HTMLInputElement &&
  b instanceof HTMLInputElement &&
  a.type === 'radio' &&
  b.type === 'radio' &&
  a.name !== '' &&
  a.name === b.name &&
  a.form === b.form;

/**
 * Arrêts du Tab d'une zone, dans l'ordre du document : pour un groupe radio, le bouton coché, sinon le premier
 * (Tab) ou le dernier (Maj+Tab) du groupe, comme le navigateur.
 */
function tabStops(zone, back) {
  const all = [...zone.querySelectorAll(FOCUSABLE)].filter(tabbable);
  return all.filter((x) => {
    if (!(x instanceof HTMLInputElement) || x.type !== 'radio' || !x.name) return true;
    const group = all.filter((y) => sameRadioGroup(x, y));
    const checked = group.find((y) => y.checked);
    return checked ? x === checked : x === (back ? group.at(-1) : group[0]);
  });
}

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
    content().innerHTML = h`
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
      <div class="drawer__body" data-scroll-key="drawer">${body ?? h`<p>${label('detail.pending')}</p>`}</div>
      ${opts.foot ? h`<div class="drawer__foot">${opts.foot}</div>` : ''}
    `;
    root.dataset.mode = opts.mode ?? 'read';
    if (!wasOpen) {
      backdrop.hidden = false;
      document.addEventListener('focusin', guardFocus, true);
      attachTrap();
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
    detachTrap();
    lastInside = null;
    // La vue a pu être redessinée (relecture des données) : on retrouve l'élément d'origine par son id
    const target = opener?.isConnected ? opener : openerId ? document.getElementById(openerId) : null;
    target?.focus();
    opener = null;
    openerId = '';
    return true;
  }

  /**
   * Contenu redessiné à chaque ouverture (.drawer__content, sans boîte : la mise en page reste celle du panneau) et
   * région d'annonce persistante (#drawer-live) : jamais remplacée par un rendu, et dans le dialogue (aria-modal
   * masque le reste de la page à certains lecteurs d'écran). Voir announce().
   */
  root.innerHTML = h`<div class="drawer__content"></div><p class="fr-sr-only" id="drawer-live" role="status" aria-live="polite"></p>`;
  const content = () => root.querySelector('.drawer__content');
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
   * [data-focus-cycle] hors du panneau (message « … Annuler » : son bouton reste atteignable au clavier). Le
   * navigateur garde l'ordre natif (champs désactivés sautés, un seul arrêt par groupe de boutons radio) ; le piège
   * n'agit qu'en sortie d'une zone : après son dernier arrêt, ou avant son premier. Une fenêtre <dialog> ouverte
   * depuis la fiche garde son propre piège.
   */
  function trapTab(e) {
    if (e.key !== 'Tab' || root.dataset.open !== 'true') return;
    const active = document.activeElement;
    if (active?.closest?.('dialog[open]')) return;
    const back = e.shiftKey;
    const zones = [
      root,
      ...[...document.querySelectorAll('[data-focus-cycle]')].filter((z) => !root.contains(z)),
    ].filter((z) => tabStops(z, back).length);
    if (!zones.length) return;
    const at = zones.findIndex((z) => z.contains(active));
    if (at !== -1) {
      const before = (x) => x.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING;
      const others = tabStops(zones[at], back).filter((x) => x !== active && !sameRadioGroup(x, active));
      // Un arrêt reste dans cette zone dans le sens de la touche : le navigateur s'en charge
      if (others.some((x) => (back ? before(x) : !before(x)))) return;
    }
    e.preventDefault();
    const n = zones.length;
    const target = at === -1 ? (back ? zones[n - 1] : zones[0]) : zones[(at + (back ? -1 : 1) + n) % n];
    const stops = tabStops(target, back);
    (back ? stops.at(-1) : stops[0]).focus();
  }

  function attachTrap() {
    document.addEventListener('keydown', trapTab, true);
  }
  function detachTrap() {
    document.removeEventListener('keydown', trapTab, true);
  }
  return {
    open,
    close,
    isOpen: () => root.dataset.open === 'true',
    /** Élément qui avait le focus à l'ouverture de la fiche (focus rendu à la vue après une suppression). */
    opener: () => (opener?.isConnected ? opener : openerId ? document.getElementById(openerId) : null),
    root,
  };
}
