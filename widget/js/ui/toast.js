/**
 * Message bref en bas de l'écran (« Modifications enregistrées. Annuler »), annoncé aux lecteurs d'écran.
 * Il reste actif quand la fiche (modale) est ouverte : data-keep-active le soustrait à la garde de focus de la fiche.
 */
import { label } from '../labels.js';
import { h } from './kit.js';

export const TOAST_MS = 10000;

/** Crée la zone de message, ajoutée à la fin de <body>. */
export function createToast() {
  const root = document.createElement('div');
  root.className = 'toast-region';
  root.dataset.keepActive = 'true';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  document.body.append(root);
  let timer = null;
  let action = null;

  function hide() {
    clearTimeout(timer);
    timer = null;
    action = null;
    root.innerHTML = '';
  }

  /**
   * @param {string} message texte (échappé)
   * @param {{actionLabel?:string, onAction?:() => void, tone?:'info'|'error', duration?:number}} [opts]
   */
  function show(message, opts = {}) {
    clearTimeout(timer);
    action = opts.onAction ?? null;
    root.innerHTML = h`<div class="toast ${opts.tone === 'error' ? 'toast--error' : ''}">
      <p class="toast__text">${message}</p>
      ${action ? h`<button type="button" class="fr-btn fr-btn--sm fr-btn--secondary toast__action" data-toast-action>${opts.actionLabel ?? label('toast.undo')}</button>` : ''}
      <button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary-no-outline fr-icon-close-line toast__close" data-toast-close title="${label('toast.close')}">${label('toast.close')}</button>
    </div>`.toString();
    timer = setTimeout(hide, opts.duration ?? TOAST_MS);
  }

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-toast-close]')) return hide();
    if (e.target.closest('[data-toast-action]')) {
      const fn = action;
      hide();
      fn?.();
    }
  });

  return { show, hide };
}
