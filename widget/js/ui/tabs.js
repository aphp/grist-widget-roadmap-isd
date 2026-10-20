/**
 * Onglets des vues : rôle tablist, focus itinérant, flèches gauche/droite, Début/Fin, icônes décoratives. Au bout
 * de la ligne : compteur de tâches et boutons de création (« Nouveau chantier », « Nouvelle tâche »).
 * Barre qui défile (390 px) : l'onglet actif est ramené dans le champ à chaque rendu, et un dégradé de bord signale
 * les onglets hors champ.
 */
import { label, taskCount } from '../labels.js';
import { createButtons } from './heading.js';
import { h, icon, keepFocus, TAB_ICONS, TABS } from './kit.js';

/**
 * Bords de la barre où des onglets sont masqués (dégradé à afficher).
 * @param {{scrollLeft:number, scrollWidth:number, clientWidth:number}} box
 * @returns {{start:boolean, end:boolean}}
 */
export function edgeFade({ scrollLeft, scrollWidth, clientWidth }) {
  if (scrollWidth <= clientWidth + 1) return { start: false, end: false };
  return { start: scrollLeft > 1, end: scrollLeft + clientWidth < scrollWidth - 1 };
}

/**
 * Défilement qui rend l'onglet [left, left + width] entièrement visible dans la barre, avec une marge pour le
 * dégradé ; la position est inchangée s'il l'est déjà.
 * @returns {number} nouveau scrollLeft
 */
export function revealScroll({ scrollLeft, clientWidth }, left, width, margin = 24) {
  if (left - margin < scrollLeft) return Math.max(0, left - margin);
  if (left + width + margin > scrollLeft + clientWidth) return left + width + margin - clientWidth;
  return scrollLeft;
}

/**
 * @param {HTMLElement} root conteneur des onglets
 * @param {{onView(id:string):void}} on
 */
export function createTabs(root, on) {
  const list = () => root.querySelector('[role="tablist"]');

  function updateFade() {
    const l = list();
    if (!l) return;
    const f = edgeFade(l);
    l.dataset.fadeStart = String(f.start);
    l.dataset.fadeEnd = String(f.end);
  }

  /** Ramène l'onglet sélectionné dans la barre (sans faire défiler la page). */
  function reveal() {
    const l = list();
    const tab = l?.querySelector('[aria-selected="true"]');
    if (!l || !tab) return;
    const left = tab.getBoundingClientRect().left - l.getBoundingClientRect().left + l.scrollLeft;
    l.scrollLeft = revealScroll(l, left, tab.offsetWidth);
    updateFade();
  }

  /**
   * @param {string} view onglet actif
   * @param {number|null} count tâches affichées (null : compteur masqué)
   * @param {{task:boolean, chantier:boolean}|null} [create] boutons de création à montrer (édition ouverte et permise)
   */
  function render(view, count, create = null) {
    const previous = list()?.scrollLeft ?? 0;
    keepFocus(
      root,
      h`
        <ul class="fr-tabs__list tabs" role="tablist" aria-label="${label('tabs.label')}">
          ${TABS.map(
            (id) =>
              h`<li role="presentation">
                <button
                  type="button"
                  role="tab"
                  id="tab-${id}"
                  class="fr-tabs__tab"
                  data-view="${id}"
                  aria-selected="${String(id === view)}"
                  aria-controls="view-panel"
                  tabindex="${id === view ? '0' : '-1'}"
                >
                  ${icon(TAB_ICONS[id], 'fr-icon--sm tab__icon')}
                  <span>${label(`view.${id}`)}</span>
                </button>
              </li>`,
          )}
        </ul>
        <div class="tabs-end">
          <p class="task-count" aria-live="polite">${count === null ? '' : taskCount(count)}</p>
          ${createButtons(create)}
        </div>
      `,
    );
    // La barre est redessinée : garder sa position, puis ramener l'onglet actif s'il est hors champ
    const l = list();
    if (l) l.scrollLeft = previous;
    reveal();
  }

  // scroll ne remonte pas : écouté en phase de capture (la liste est recréée à chaque rendu)
  root.addEventListener('scroll', updateFade, true);
  // Largeurs définitives après chargement des polices ou redimensionnement : onglet actif ramené, dégradé à jour
  if (typeof ResizeObserver === 'function') new ResizeObserver(reveal).observe(root);
  else window.addEventListener('resize', reveal);
  document.fonts?.ready.then(reveal);

  root.addEventListener('click', (e) => {
    const t = e.target.closest('[role="tab"]');
    if (t) on.onView(t.dataset.view);
  });
  root.addEventListener('keydown', (e) => {
    const t = e.target.closest('[role="tab"]');
    if (!t) return;
    const i = TABS.indexOf(t.dataset.view);
    const next = {
      ArrowRight: (i + 1) % TABS.length,
      ArrowLeft: (i - 1 + TABS.length) % TABS.length,
      Home: 0,
      End: TABS.length - 1,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    on.onView(TABS[next]);
    document.getElementById(`tab-${TABS[next]}`)?.focus();
  });

  return { render };
}
