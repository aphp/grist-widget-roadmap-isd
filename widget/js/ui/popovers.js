/** Menus surgissants de la coquille (préférences, statuts, édition) : ouverture, clic extérieur, Échap. */

const IDS = Object.freeze({
  prefs: { panel: 'prefs-panel', button: 'btn-prefs' },
  status: { panel: 'status-panel', button: 'btn-status' },
  edit: { panel: 'edit-panel', button: 'btn-edit-pill' },
});

/** Crée le gestionnaire des menus ; l'état ouvert survit aux nouveaux rendus (lu via isOpen). */
export function createPopovers() {
  const open = { prefs: false, status: false, edit: false };

  /** Ouvre, ferme (force) ou bascule un menu, et place le focus dans le menu ouvert. */
  function toggle(which, force) {
    open[which] = force ?? !open[which];
    const panel = document.getElementById(IDS[which].panel);
    const btn = document.getElementById(IDS[which].button);
    if (panel) panel.hidden = !open[which];
    if (btn) btn.setAttribute('aria-expanded', String(open[which]));
    if (open[which]) panel?.querySelector('input, button')?.focus();
  }

  document.addEventListener('click', (e) => {
    for (const which of Object.keys(IDS)) {
      const { panel, button } = IDS[which];
      if (open[which] && !e.target.closest(`#${panel}, #${button}`)) toggle(which, false);
    }
  });

  /** Échap : ferme le menu ouvert et rend le focus à son bouton ; vrai si un menu a été fermé. */
  function closeAny() {
    for (const which of ['status', 'prefs', 'edit']) {
      if (open[which]) {
        toggle(which, false);
        document.getElementById(IDS[which].button)?.focus();
        return true;
      }
    }
    return false;
  }

  return { toggle, closeAny, isOpen: (which) => open[which] };
}
