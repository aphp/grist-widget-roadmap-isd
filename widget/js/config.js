/**
 * Configuration publique du widget (aucun secret) : origine de l'instance Grist autorisée dans la CSP
 * (connect-src de index.html, vérifiée par tests/write-guard.test.js) et nom du fichier d'arrêt d'urgence.
 */
export const GRIST_ORIGIN = 'https://grist.numerique.gouv.fr';
export const FLAGS_FILE = 'flags.json';
