/**
 * Dessin d'un Gantt Mermaid : mermaid 10.9.1 chargé à la demande depuis jsDelivr, avec contrôle d'intégrité (SRI).
 * Mode strict (pas de HTML ni de clic dans le graphique) ; couleurs lues dans les variables CSS au moment du dessin.
 */
import { label } from '../labels.js';

/** Bibliothèque figée ; empreinte : curl -s URL | openssl dgst -sha384 -binary | openssl base64 -A */
export const LIB = Object.freeze({
  url: 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js',
  integrity: 'sha384-WmdflGW9aGfoBdHc4rRyWzYuAjEmDwMdGdiPNacbwfGKxBW/SO6guzuQ76qjnSlr',
});

/** Délai maximal de chargement. */
const LOAD_TIMEOUT_MS = 20000;
let pending = null;
let counter = 0;

/** Erreur de dessin dont le message, en français, peut être montré tel quel. */
export class MermaidError extends Error {}

/** Charge le script une seule fois (SRI + CORS anonyme) ; échec ou délai dépassé : nouvel essai possible. */
function loadScript() {
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      const fail = () => {
        clearTimeout(timer);
        s.onload = s.onerror = null;
        s.remove();
        pending = null;
        reject(new MermaidError(label('mermaid.loadError')));
      };
      const timer = setTimeout(fail, LOAD_TIMEOUT_MS);
      s.src = LIB.url;
      s.integrity = LIB.integrity;
      s.crossOrigin = 'anonymous';
      s.referrerPolicy = 'no-referrer';
      s.async = true;
      s.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      s.onerror = fail;
      document.head.append(s);
    });
  }
  return pending;
}

/** Valeur calculée d'une variable CSS (couleur déjà résolue), ou la valeur de repli. */
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Thème « base » de Mermaid habillé avec les variables du widget (clair ou sombre). */
export function themeVariables() {
  const c = (name, fb) => cssVar(name, fb);
  return {
    fontFamily: c('--font-sans', 'sans-serif'),
    fontSize: '13px',
    background: c('--color-surface', 'transparent'),
    primaryColor: c('--viz-1', 'blue'),
    primaryTextColor: c('--color-on-accent', 'white'),
    primaryBorderColor: c('--viz-1', 'blue'),
    lineColor: c('--color-border-strong', 'gray'),
    textColor: c('--color-text', 'black'),
    titleColor: c('--color-title', 'black'),
    gridColor: c('--color-border', 'gray'),
    sectionBkgColor: c('--color-surface-2', 'white'),
    sectionBkgColor2: c('--color-surface', 'white'),
    altSectionBkgColor: c('--color-surface', 'white'),
    taskBkgColor: c('--viz-1', 'blue'),
    taskBorderColor: c('--viz-1', 'blue'),
    taskTextColor: c('--color-on-accent', 'white'),
    taskTextLightColor: c('--color-on-accent', 'white'),
    taskTextDarkColor: c('--color-text', 'black'),
    taskTextOutsideColor: c('--color-text', 'black'),
    taskTextClickableColor: c('--color-text', 'black'),
    activeTaskBkgColor: c('--viz-2', 'orange'),
    activeTaskBorderColor: c('--viz-2', 'orange'),
    doneTaskBkgColor: c('--viz-3', 'green'),
    doneTaskBorderColor: c('--viz-3', 'green'),
    critBkgColor: c('--viz-late', 'red'),
    critBorderColor: c('--viz-late', 'red'),
    todayLineColor: c('--viz-today', 'red'),
  };
}

/**
 * Dessine une source Mermaid et renvoie le SVG (déjà assaini par Mermaid en mode strict).
 * @param {string} text source Mermaid
 * @returns {Promise<string>}
 * @throws {MermaidError} bibliothèque inaccessible ou source rejetée (message en français)
 */
export async function renderMermaid(text) {
  await loadScript();
  const mermaid = window.mermaid;
  if (typeof mermaid?.initialize !== 'function' || typeof mermaid.render !== 'function')
    throw new MermaidError(label('mermaid.loadError'));
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: themeVariables(),
      gantt: { useMaxWidth: false, barHeight: 22, barGap: 6, topPadding: 44, leftPadding: 120, fontSize: 12 },
    });
    const { svg } = await mermaid.render(`syn-gantt-svg-${++counter}`, text);
    return svg;
  } catch (err) {
    console.error(err);
    throw new MermaidError(label('mermaid.failed'));
  }
}
