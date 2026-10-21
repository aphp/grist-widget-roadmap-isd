/**
 * Message bref en bas de l'écran (« Modifications enregistrées. Annuler »), annoncé aux lecteurs d'écran.
 * Il reste actif quand la fiche (modale) est ouverte : data-keep-active le soustrait à la garde de focus de la fiche,
 * data-focus-cycle place ses boutons dans la boucle Tab de la fiche (« Annuler » atteignable au clavier).
 */
import { label } from '../labels.js';
import { h } from './kit.js';

export const TOAST_MS = 10000;

/** Crée la zone de message, ajoutée à la fin de <body>. */
export function createToast() {
  const root = document.createElement('div');
  root.className = 'toast-region';
  root.dataset.keepActive = 'true';
  root.dataset.focusCycle = 'true';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  document.body.append(root);
  let timer = null;
  let action = null;
  let more = null;
  let duration = TOAST_MS;
  /** Élément focalisé avant d'entrer dans le message : il retrouve le focus quand le message disparaît. */
  let returnTo = null;

  function hide() {
    const hadFocus = root.contains(document.activeElement);
    clearTimeout(timer);
    timer = null;
    action = null;
    more = null;
    root.innerHTML = '';
    if (hadFocus && returnTo?.isConnected) returnTo.focus();
    returnTo = null;
  }

  // Focus dans le message (clavier) : il ne disparaît pas sous le curseur ; le délai repart à la sortie
  root.addEventListener('focusin', (e) => {
    // Sans élément d'origine (contenu remplacé sous le focus) : l'élément d'origine déjà noté est gardé
    if (e.relatedTarget instanceof HTMLElement && !root.contains(e.relatedTarget)) returnTo = e.relatedTarget;
    clearTimeout(timer);
  });
  root.addEventListener('focusout', (e) => {
    if (root.contains(e.relatedTarget) || !root.firstChild) return;
    clearTimeout(timer);
    timer = setTimeout(hide, duration);
  });

  /**
   * @param {string} message texte (échappé)
   * @param {{actionLabel?:string, onAction?:() => void, tone?:'info'|'error', duration?:number,
   *   more?:{label:string, onAction:() => void}}} [opts] more : second bouton (après « Annuler »)
   */
  function show(message, opts = {}) {
    clearTimeout(timer);
    // Un bouton du message a le focus : il le garde sur le nouveau message (même bouton, sinon « Fermer »)
    const focused = root.contains(document.activeElement)
      ? document.activeElement.hasAttribute('data-toast-action')
        ? '[data-toast-action]'
        : '[data-toast-close]'
      : null;
    action = opts.onAction ?? null;
    more = opts.more ?? null;
    root.innerHTML = h`<div class="toast ${opts.tone === 'error' ? 'toast--error' : ''}">
      <p class="toast__text">${message}</p>
      ${action ? h`<button type="button" class="fr-btn fr-btn--sm fr-btn--secondary toast__action" data-toast-action>${opts.actionLabel ?? label('toast.undo')}</button>` : ''}
      ${more ? h`<button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary toast__action" data-toast-more>${more.label}</button>` : ''}
      <button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary-no-outline fr-icon-close-line toast__close" data-toast-close title="${label('toast.close')}">${label('toast.close')}</button>
    </div>`.toString();
    duration = opts.duration ?? TOAST_MS;
    if (focused) {
      (root.querySelector(focused) ?? root.querySelector('[data-toast-close]'))?.focus();
      // Focus gardé dans le message : le délai repartira à sa sortie (focusout)
      return;
    }
    timer = setTimeout(hide, duration);
  }

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-toast-close]')) return hide();
    if (e.target.closest('[data-toast-more]')) {
      const fn = more?.onAction;
      hide();
      fn?.();
      return;
    }
    if (e.target.closest('[data-toast-action]')) {
      const fn = action;
      hide();
      fn?.();
    }
  });

  return { show, hide };
}
