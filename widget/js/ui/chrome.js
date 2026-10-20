/**
 * Coquille du widget : compose l'en-tête, les bandeaux, les onglets, les filtres et le panneau détail,
 * et gère Échap (ferme d'abord un menu, puis l'invite « Qui êtes-vous ? », sinon la fiche). Rendu via h`` (toute donnée est échappée).
 */
import { createDrawer } from './drawer.js';
import { createFilters } from './filters.js';
import { createHeader } from './header.js';
import { createPopovers } from './popovers.js';
import { createAlerts } from './states.js';
import { createTabs } from './tabs.js';

/**
 * Crée la coquille sur les conteneurs de index.html.
 * @param {{header:HTMLElement, alerts:HTMLElement, tabs:HTMLElement, filters:HTMLElement, main:HTMLElement, detail:HTMLElement}} el
 * @param {{onFilters(partial:object):void, onClearFilters():void, onMe(id:number|null):void, onMeSkip():void,
 *          onHome(view:string):void, onTheme(t:string):void,
 *          onHidden(ids:number[]):void, onView(id:string):void, onRefresh():void, onCloseDetail():void}} on
 */
export function createChrome(el, on) {
  const popovers = createPopovers();
  const header = createHeader(el.header, on, popovers);
  const alerts = createAlerts(el.alerts);
  const tabs = createTabs(el.tabs, on);
  const filters = createFilters(el.filters, on, popovers);
  const drawer = createDrawer(el.detail, on);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (popovers.closeAny() || header.closeInvite()) e.preventDefault();
    // La fiche passe par main.js : un formulaire modifié demande confirmation avant de fermer
    else if (drawer.isOpen()) {
      e.preventDefault();
      on.onCloseDetail();
    }
  });

  return {
    renderHeader: header.render,
    renderAlerts: alerts.render,
    renderTabs: tabs.render,
    renderFilters: filters.render,
    syncSearch: header.syncSearch,
    cancelSearch: header.cancelSearch,
    setRefreshing: header.setRefreshing,
    syncMe: header.syncMe,
    syncHome: header.syncHome,
    syncTheme: header.syncTheme,
    openDetail: drawer.open,
    closeDetail: drawer.close,
    isDetailOpen: drawer.isOpen,
    detailOpener: drawer.opener,
    detailRoot: drawer.root,
    togglePopover: popovers.toggle,
  };
}
