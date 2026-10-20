/*
 * Thème DSFR posé avant les feuilles de style (script classique, externe : la CSP interdit les scripts en ligne).
 * Évite un flash clair pour qui a choisi le sombre ou dont le système est en sombre. main.js gère ensuite le thème.
 */
(function () {
  let theme = 'auto';
  try {
    const prefs = JSON.parse(window.localStorage.getItem('roadmap-isd:prefs') || '{}');
    if (prefs && (prefs.theme === 'light' || prefs.theme === 'dark')) theme = prefs.theme;
  } catch {
    /* stockage indisponible ou préférences illisibles : thème automatique */
  }
  let dark = theme === 'dark';
  if (theme === 'auto') {
    try {
      dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      dark = false;
    }
  }
  const root = document.documentElement;
  root.setAttribute('data-fr-scheme', theme === 'auto' ? 'system' : theme);
  root.setAttribute('data-fr-theme', dark ? 'dark' : 'light');
})();
