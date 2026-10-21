/**
 * Menus de choix des vues (statut P-UX-6, priorité, actions) : liste de boutons (role="menu") posée sur la page, à
 * côté du contrôle qui l'ouvre (bouton ⋯ d'une carte, cellule Statut du Tableau, ligne de Mes tâches). Il n'est
 * jamais enfermé dans la carte ou la ligne (une carte est déjà un bouton, un groupe de Mes tâches coupe ce qui
 * déborde). Flèches, Début et Fin déplacent le focus sans rien écrire ; seul le choix (clic, Entrée, Espace)
 * appelle onPick, jamais une touche maintenue (auto-répétition). Sans statut actuel, le focus va sur le menu
 * lui-même (position neutre). Échap ou Tab ferme le menu et rend le focus ; un clic ailleurs le ferme.
 */
import { menuKey, menuStartIndex } from '../core/quick-status.js';
import { label, statusLabel } from '../labels.js';
import { raw } from '../core/sanitize.js';
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
 * Ouvre un menu de choix à côté d'un contrôle : statut, priorité (entrées menuitemradio, `current` défini) ou
 * actions (menu ⋯ du Kanban, menu de ligne du Gantt : entrées menuitem, sans `current`). Une entrée `disabled`
 * reste focalisable, dit sa raison (`note`) et ne choisit rien.
 * @param {{anchor:HTMLElement, returnFocus?:HTMLElement, title:string, items:{value:string, text:string,
 *   current?:boolean, disabled?:boolean, note?:string}[], onPick(value:string):void, menuLabel:string,
 *   heading:string, start?:number}} opts anchor : contrôle visible (aria-expanded) ; returnFocus : élément rendu
 *   focalisé à la fermeture (la carte au clavier), l'ancre par défaut ; menuLabel / heading : nom et titre du menu ;
 *   start : entrée focalisée à l'ouverture (par défaut l'entrée courante, sinon le menu lui-même)
 */
export function openChoicePopover({ anchor, returnFocus = anchor, items, onPick, menuLabel, heading, start }) {
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
  root.setAttribute('aria-label', menuLabel);
  const note = (it) => (it.note ? h`<span class="qs-menu__note">${it.note}</span>` : '');
  const disabled = (it) => raw(it.disabled ? ' aria-disabled="true"' : '');
  root.innerHTML = h`<p class="qs-menu__title" aria-hidden="true">${heading}</p>
    ${items.map((it) =>
      it.current === undefined
        ? h`<button type="button" class="qs-menu__item" role="menuitem" tabindex="-1"${disabled(it)} data-qs-value="${it.value}">${it.text}${note(it)}</button>`
        : h`<button type="button" class="qs-menu__item" role="menuitemradio" tabindex="-1"${disabled(it)} aria-checked="${it.current ? 'true' : 'false'}" data-qs-value="${it.value}">${it.text}${it.current ? h`<span class="fr-sr-only"> ${label('quickStatus.current')}</span>` : ''}${note(it)}</button>`,
    )}`.toString();
  document.body.append(root);
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', ID);
  place(root, anchor);
  const off = new AbortController();
  current = { root, anchor, returnFocus, off };
  const buttons = () => [...root.querySelectorAll('.qs-menu__item')];

  const pick = (b) => {
    if (b.getAttribute('aria-disabled') === 'true') return; // raison dite dans l'entrée : rien n'est choisi
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
    const list = buttons();
    const k = menuKey(e, list.length, list.indexOf(document.activeElement));
    if (!k) return;
    e.preventDefault(); // Entrée maintenue : le clic n'a pas lieu
    if (k.action === 'close') {
      e.stopPropagation();
      closeStatusPopover(true);
    } else if (k.action === 'move') list[k.index].focus();
  });
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!root.contains(e.target) && !anchor.contains(e.target)) closeStatusPopover(false);
    },
    { capture: true, signal: off.signal },
  );
  window.addEventListener('resize', () => closeStatusPopover(false), { signal: off.signal });
  const first = start ?? menuStartIndex(items);
  (first >= 0 ? buttons()[first] : root).focus();
}

/**
 * Menu de statut d'une tâche (P-UX-6) : cas de openChoicePopover, statuts nommés par statusLabel ; entrées avec
 * `text` : menu d'actions.
 * @param {{anchor:HTMLElement, returnFocus?:HTMLElement, title:string, items:{value:string, current?:boolean}[],
 *   onPick(value:string):void}} opts
 */
export function openStatusPopover({ title, items, ...opts }) {
  openChoicePopover({
    ...opts,
    menuLabel: label('quickStatus.menu', { titre: title }),
    heading: label('quickStatus.menu.title'),
    items: items.map((it) => ({ ...it, text: statusLabel(it.value) })),
  });
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
