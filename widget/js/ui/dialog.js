/**
 * Fenêtre modale centrée (créations, changement de chantier) : élément <dialog> ouvert par showModal() (le reste
 * de la page devient inerte), Tab et Maj+Tab bouclent dans la fenêtre, Échap demande la fermeture (le
 * contrôleur confirme s'il reste une saisie), le focus revient à l'élément d'origine à la fermeture. L'Échap
 * n'atteint pas la fiche ouverte dessous. Contenu rendu par h`` (toute donnée est échappée).
 */
import { label } from '../labels.js';
import { h } from './kit.js';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Ouvre une fenêtre.
 * @param {{title:string, body:*, foot:*, onRequestClose():void, focus?:string, labelId?:string}} opts
 *   onRequestClose : Échap, bouton « Fermer » ; le contrôleur décide (confirmation, puis close())
 * @returns {{root:HTMLDialogElement, update(body:*, foot:*, focus?:string):void, close():void, isOpen():boolean}}
 */
export function openDialog(opts) {
  const opener = document.activeElement;
  const openerId = opener?.id ?? '';
  const root = document.createElement('dialog');
  root.className = 'cdlg';
  root.dataset.keepActive = 'true';
  root.setAttribute('aria-labelledby', 'cdlg-title');
  document.body.append(root);
  let open = true;

  function paint(body, foot, focusId) {
    const active = root.contains(document.activeElement) ? document.activeElement.id : '';
    const scroll = root.querySelector('.cdlg__body')?.scrollTop ?? 0;
    root.innerHTML = h`<div class="cdlg__panel">
      <div class="cdlg__head">
        <h2 class="cdlg__title" id="cdlg-title" tabindex="-1">${opts.title}</h2>
        <button type="button" class="fr-btn--close fr-btn cdlg__close" id="cdlg-close" title="${label('dialog.close')}" aria-label="${label('dialog.close')}">${label('detail.closeShort')}</button>
      </div>
      <div class="cdlg__body">${body}</div>
      <div class="cdlg__foot">${foot}</div>
    </div>`.toString();
    const b = root.querySelector('.cdlg__body');
    if (b) b.scrollTop = scroll;
    const target = document.getElementById(focusId || active) ?? root.querySelector(FOCUSABLE);
    target?.focus();
  }

  function close() {
    if (!open) return;
    open = false;
    if (root.open) root.close();
    root.remove();
    const target = opener?.isConnected ? opener : openerId ? document.getElementById(openerId) : null;
    target?.focus();
  }

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // La fiche ouverte sous la fenêtre ne doit pas recevoir cet Échap
      e.preventDefault();
      e.stopPropagation();
      opts.onRequestClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...root.querySelectorAll(FOCUSABLE)].filter(
      (x) => x.offsetParent !== null || x === document.activeElement,
    );
    if (!items.length) return;
    const first = items[0];
    const last = items.at(-1);
    if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
      e.preventDefault();
      first.focus();
    }
  });
  // Fermeture native (Échap du navigateur) : le contrôleur décide
  root.addEventListener('cancel', (e) => {
    e.preventDefault();
    opts.onRequestClose();
  });
  root.addEventListener('click', (e) => {
    if (e.target.closest('#cdlg-close')) opts.onRequestClose();
  });

  root.showModal();
  paint(opts.body, opts.foot, opts.focus);
  return {
    root,
    update: (body, foot, focusId) => paint(body, foot, focusId),
    close,
    isOpen: () => open,
  };
}
