/**
 * Menu de statut des vues (P-UX-6) : liste de boutons (role="menu", entrées menuitemradio) posée sur la page, à
 * côté du contrôle qui l'ouvre (bouton ⋯ d'une carte, cellule Statut du Tableau, ligne de Mes tâches). Il n'est
 * jamais enfermé dans la carte ou la ligne (une carte est déjà un bouton, un groupe de Mes tâches coupe ce qui
 * déborde). Flèches, Début et Fin déplacent le focus sans rien écrire ; seul le choix (clic, Entrée, Espace)
 * appelle onPick, jamais une touche maintenue (auto-répétition). Sans statut actuel, le focus va sur le menu
 * lui-même (position neutre). Échap ou Tab ferme le menu et rend le focus ; un clic ailleurs le ferme.
 */
import { isRepeatedChoice, menuMove, menuStartIndex } from '../core/quick-status.js';
import { label, statusLabel } from '../labels.js';
import { h } from './kit.js';

const ID = 'qs-menu';
let current = null;

/** Ferme le menu ouvert ; focus rendu à l'élément d'origine si demandé. */
export function closeStatusPopover(restore = false) {
  const c = current;
  if (!c) return false;
  current = null;
  c.off.abort();
  c.root.remove();
  c.anchor.setAttribute('aria-expanded', 'false');
  c.anchor.removeAttribute('aria-controls');
  if (restore && c.returnFocus?.isConnected) c.returnFocus.focus();
  return true;
}

/** Position du menu : sous le contrôle, aligné à droite s'il déborde, au-dessus s'il manque de place en bas. */
function place(root, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = root.offsetWidth;
  const hgt = root.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let left = r.left;
  if (left + w > vw - 8) left = Math.max(8, r.right - w);
  const below = r.bottom + 4;
  const top = below + hgt > vh - 8 && r.top - hgt - 4 >= 8 ? r.top - hgt - 4 : below;
  root.style.left = `${Math.round(left + window.scrollX)}px`;
  root.style.top = `${Math.round(top + window.scrollY)}px`;
}

/**
 * Ouvre le menu de statut d'une tâche, ou un menu d'actions (menu de ligne du Gantt : items avec text, sans
 * statut courant, entrées menuitem).
 * @param {{anchor:HTMLElement, returnFocus?:HTMLElement, title:string, items:{value:string, current?:boolean,
 *   text?:string}[], onPick(value:string):void, menuLabel?:string, heading?:string}} opts anchor : contrôle visible
 *   (aria-expanded) ; returnFocus : élément rendu focalisé à la fermeture (la carte au clavier), l'ancre par
 *   défaut ; menuLabel / heading : nom et titre du menu (statut par défaut)
 */
export function openStatusPopover({ anchor, returnFocus = anchor, title, items, onPick, menuLabel, heading }) {
  const again = current?.anchor === anchor;
  closeStatusPopover(false);
  if (again) {
    returnFocus.focus();
    return;
  }
  const root = document.createElement('div');
  root.className = 'qs-menu';
  root.id = ID;
  root.setAttribute('role', 'menu');
  root.tabIndex = -1;
  root.setAttribute('aria-label', menuLabel ?? label('quickStatus.menu', { titre: title }));
  root.innerHTML = h`<p class="qs-menu__title" aria-hidden="true">${heading ?? label('quickStatus.menu.title')}</p>
    ${items.map((it) =>
      it.text !== undefined
        ? h`<button type="button" class="qs-menu__item" role="menuitem" tabindex="-1" data-qs-value="${it.value}">${it.text}</button>`
        : h`<button type="button" class="qs-menu__item" role="menuitemradio" tabindex="-1" aria-checked="${it.current ? 'true' : 'false'}" data-qs-value="${it.value}">${statusLabel(it.value)}${it.current ? h`<span class="fr-sr-only"> ${label('quickStatus.current')}</span>` : ''}</button>`,
    )}`.toString();
  document.body.append(root);
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', ID);
  place(root, anchor);
  const off = new AbortController();
  current = { root, anchor, returnFocus, off };
  const buttons = () => [...root.querySelectorAll('.qs-menu__item')];

  const pick = (b) => {
    const value = b.dataset.qsValue;
    closeStatusPopover(true);
    onPick(value);
  };
  // Menu du navigateur jamais par-dessus le nôtre (« contextmenu » d'une touche relâchée dans le menu)
  root.addEventListener('contextmenu', (e) => e.preventDefault());
  root.addEventListener('click', (e) => {
    const b = e.target.closest('.qs-menu__item');
    if (b) pick(b);
  });
  root.addEventListener('keydown', (e) => {
    if (isRepeatedChoice(e)) {
      e.preventDefault(); // Entrée maintenue : le clic n'a pas lieu
      return;
    }
    const list = buttons();
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      closeStatusPopover(true);
      return;
    }
    const next = menuMove(list.length, list.indexOf(document.activeElement), e.key);
    if (next !== null) {
      e.preventDefault();
      list[next].focus();
    }
  });
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!root.contains(e.target) && !anchor.contains(e.target)) closeStatusPopover(false);
    },
    { capture: true, signal: off.signal },
  );
  window.addEventListener('resize', () => closeStatusPopover(false), { signal: off.signal });
  const start = menuStartIndex(items);
  (start >= 0 ? buttons()[start] : root).focus();
}

/**
 * « contextmenu » sur une carte ou un bouton de statut (clic droit, Maj+F10, touche Menu) : le menu de statut
 * s'ouvre à la place du menu du navigateur. Ces éléments n'existent qu'en édition : en lecture seule, le menu du
 * navigateur reste intact. Un menu déjà ouvert sur ce contrôle (ouvert au clavier, « contextmenu » arrivant au
 * relâchement sous Windows) n'est pas refermé.
 * @param {MouseEvent} e
 * @param {(control:Element) => HTMLElement|null} anchorOf bouton qui porte le menu pour l'élément visé
 * @param {(anchor:HTMLElement, control:Element) => void} open ouverture du menu
 */
export function statusContextMenu(e, anchorOf, open) {
  const t = e.target instanceof Element ? e.target.closest('[data-qs-open], [data-qs-focus]') : null;
  const anchor = t ? anchorOf(t) : null;
  if (!anchor) return;
  e.preventDefault();
  if (current?.anchor !== anchor) open(anchor, t);
}

/** Vrai si un menu de statut est ouvert. */
export const isStatusPopoverOpen = () => current !== null;

/** Clé data-qs-focus de l'élément qui a ouvert le menu (pour le refocaliser après un rendu), sinon null. */
export const statusPopoverKey = () => current?.returnFocus?.dataset?.qsFocus ?? null;
