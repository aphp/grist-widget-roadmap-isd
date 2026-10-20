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
 * Ouvre le menu de statut d'une tâche.
 * @param {{anchor:HTMLElement, returnFocus?:HTMLElement, title:string, items:{value:string, current:boolean}[],
 *   onPick(value:string):void}} opts anchor : contrôle visible (aria-expanded) ; returnFocus : élément rendu
 *   focalisé à la fermeture (la carte au clavier), l'ancre par défaut
 */
export function openStatusPopover({ anchor, returnFocus = anchor, title, items, onPick }) {
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
  root.setAttribute('aria-label', label('quickStatus.menu', { titre: title }));
  root.innerHTML = h`<p class="qs-menu__title" aria-hidden="true">${label('quickStatus.menu.title')}</p>
    ${items.map(
      (it) =>
        h`<button type="button" class="qs-menu__item" role="menuitemradio" tabindex="-1" aria-checked="${it.current ? 'true' : 'false'}" data-qs-value="${it.value}">${statusLabel(it.value)}${it.current ? h`<span class="fr-sr-only"> ${label('quickStatus.current')}</span>` : ''}</button>`,
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
 * Menu contextuel du navigateur sur une carte ou un bouton qui ouvre le menu de statut : Maj+F10 et la touche Menu
 * émettent aussi « contextmenu » (au relâchement sous Windows), qui ouvrirait le menu du navigateur par-dessus.
 */
export function blockContextMenu(e) {
  if (e.target instanceof Element && e.target.closest('[data-qs-open], [data-qs-focus]')) e.preventDefault();
}

/** Vrai si un menu de statut est ouvert. */
export const isStatusPopoverOpen = () => current !== null;

/** Clé data-qs-focus de l'élément qui a ouvert le menu (pour le refocaliser après un rendu), sinon null. */
export const statusPopoverKey = () => current?.returnFocus?.dataset?.qsFocus ?? null;
