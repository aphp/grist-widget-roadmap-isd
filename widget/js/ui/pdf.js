/**
 * Export PDF d'un élément de la page : html2canvas 1.4.1 et jsPDF 2.5.1 chargés à la demande depuis cdnjs,
 * avec contrôle d'intégrité (SRI). Rien n'est envoyé ailleurs : le fichier est produit dans le navigateur.
 */
import { label } from '../labels.js';

/** Bibliothèques figées ; empreintes : curl -s URL | openssl dgst -sha384 -binary | openssl base64 -A */
export const LIBS = Object.freeze({
  html2canvas: Object.freeze({
    url: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
    integrity: 'sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H',
  }),
  jspdf: Object.freeze({
    url: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    integrity: 'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk',
  }),
});

const pending = new Map();
/** Délai maximal de chargement d'une bibliothèque. */
const LOAD_TIMEOUT_MS = 20000;

/** Erreur d'export dont le message, en français, peut être montré tel quel. */
export class PdfError extends Error {}

/** Charge un script une seule fois (SRI + CORS anonyme) ; échec ou délai dépassé : nouvel essai possible. */
function loadScript({ url, integrity }) {
  if (!pending.has(url)) {
    const p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      const fail = () => {
        clearTimeout(timer);
        s.onload = s.onerror = null;
        s.remove();
        pending.delete(url);
        reject(new PdfError(label('pdf.loadError')));
      };
      const timer = setTimeout(fail, LOAD_TIMEOUT_MS);
      s.src = url;
      s.integrity = integrity;
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
    pending.set(url, p);
  }
  return pending.get(url);
}

/** Charge les deux bibliothèques et renvoie leurs points d'entrée. */
export async function loadPdfLibs() {
  await Promise.all([loadScript(LIBS.html2canvas), loadScript(LIBS.jspdf)]);
  const html2canvas = window.html2canvas;
  const JsPdf = window.jspdf?.jsPDF;
  if (typeof html2canvas !== 'function' || typeof JsPdf !== 'function') throw new PdfError(label('pdf.loadError'));
  return { html2canvas, JsPdf };
}

/** Plus grand côté et plus grande surface sûrs pour un canvas (navigateurs courants). */
const MAX_SIDE = 32000;
const MAX_AREA = 120e6;
const MIN_SCALE = 0.5;

/**
 * Échelle du rendu d'un élément de w × h px CSS : au plus 2, plus grand côté ≤ 32 000 px et surface ≤ 120 Mpx.
 * null si l'élément est vide ou si l'échelle tomberait sous 0,5 (illisible) : trop de lignes pour un PDF.
 * @returns {number|null}
 */
export function canvasScale(w, h) {
  if (!(w > 0 && h > 0)) return null;
  const s = Math.min(2, MAX_SIDE / h, MAX_SIDE / w, Math.sqrt(MAX_AREA / (w * h)));
  return s < MIN_SCALE ? null : s;
}

/** A4 paysage, en millimètres. */
const PAGE = Object.freeze({ w: 297, h: 210, margin: 10, head: 14, legend: 6, foot: 7 });

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Légende sur une ligne : pastille (pleine, claire, losange, contour ou trait) puis libellé. */
function drawLegend(pdf, items, y) {
  let x = PAGE.margin;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  for (const it of items) {
    const [r, g, b] = rgb(it.color);
    pdf.setDrawColor(r, g, b);
    pdf.setFillColor(r, g, b);
    pdf.setLineWidth(0.4);
    if (it.mark === 'diamond') {
      pdf.triangle(x + 1.75, y - 3, x + 3.5, y - 1.5, x + 1.75, y, 'F');
      pdf.triangle(x + 1.75, y - 3, x, y - 1.5, x + 1.75, y, 'F');
    } else if (it.mark === 'outline') pdf.rect(x, y - 2.6, 4, 2.2, 'S');
    else if (it.mark === 'line') pdf.line(x + 2, y - 3, x + 2, y + 0.4);
    else if (it.mark === 'light') {
      pdf.setFillColor(...rgb(it.light ?? '#d5d5d5'));
      pdf.rect(x, y - 2.6, 4, 2.2, 'FD');
    } else pdf.rect(x, y - 2.6, 4, 2.2, 'F');
    pdf.setTextColor(58, 58, 58);
    pdf.text(it.label, x + 5.5, y);
    x += 5.5 + pdf.getTextWidth(it.label) + 5;
  }
}

/**
 * Exporte `element` (dimensions complètes, hors défilement) en PDF A4 paysage, sur fond clair.
 * @param {HTMLElement} element
 * @param {object} opts
 * @param {string} opts.filename nom du fichier
 * @param {string} opts.title titre imprimé en tête de chaque page
 * @param {string} [opts.subtitle] ligne sous le titre
 * @param {{label:string, color:string, mark?:'box'|'light'|'diamond'|'outline'|'line', light?:string}[]} [opts.legend] légende imprimée sous le sous-titre
 * @param {number} [opts.repeatTop] hauteur (px CSS) du haut de l'élément répété sur chaque page (en-tête de colonnes)
 * @param {number} [opts.rowHeight] hauteur (px CSS) d'une ligne, pour couper les pages entre deux lignes
 * @param {(doc: Document, el: HTMLElement) => void} [opts.onclone] retouches de la copie rendue (ex. défilement retiré)
 * @throws {PdfError} bibliothèques inaccessibles ou contenu trop grand (message en français)
 */
export async function exportPdf(element, opts) {
  const w = element.scrollWidth;
  const h = element.scrollHeight;
  const scale = canvasScale(w, h);
  if (scale === null) throw new PdfError(label('pdf.tooLarge'));
  const { html2canvas, JsPdf } = await loadPdfLibs();
  const canvas = await html2canvas(element, {
    backgroundColor: '#ffffff',
    scale,
    logging: false,
    width: w,
    height: h,
    windowWidth: Math.max(w, document.documentElement.clientWidth),
    onclone: (doc, el) => {
      // Papier : toujours le thème clair
      doc.documentElement.setAttribute('data-fr-theme', 'light');
      doc.documentElement.setAttribute('data-fr-scheme', 'light');
      opts.onclone?.(doc, el);
    },
  });

  const pdf = new JsPdf({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  const contentW = PAGE.w - 2 * PAGE.margin;
  const head = PAGE.head + (opts.legend?.length ? PAGE.legend : 0);
  const contentH = PAGE.h - 2 * PAGE.margin - head - PAGE.foot;
  const mmPerPx = contentW / canvas.width;
  const drawW = contentW;
  const top = Math.round((opts.repeatTop ?? 0) * scale);
  const row = (opts.rowHeight ?? 0) * scale;
  let sliceMax = Math.floor(contentH / mmPerPx) - top;
  if (row > 0 && sliceMax > row) sliceMax = Math.floor(sliceMax / row) * row;
  sliceMax = Math.max(1, Math.floor(sliceMax));

  const slices = [];
  for (let y = top; y < canvas.height; y += sliceMax) slices.push([y, Math.min(sliceMax, canvas.height - y)]);
  if (!slices.length) slices.push([0, canvas.height]);

  const part = document.createElement('canvas');
  part.width = canvas.width;
  const ctx2d = part.getContext('2d');
  slices.forEach(([y, sh], i) => {
    if (i) pdf.addPage();
    // Chaque page : l'en-tête répété (0 → top), puis sa tranche (y → y + sh)
    part.height = top + sh;
    ctx2d.fillStyle = '#ffffff';
    ctx2d.fillRect(0, 0, part.width, part.height);
    if (top) ctx2d.drawImage(canvas, 0, 0, canvas.width, top, 0, 0, canvas.width, top);
    ctx2d.drawImage(canvas, 0, y, canvas.width, sh, 0, top, canvas.width, sh);

    pdf.setTextColor(22, 22, 22);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(13);
    pdf.text(opts.title, PAGE.margin, PAGE.margin + 5);
    if (opts.subtitle) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(80, 80, 80);
      pdf.text(opts.subtitle, PAGE.margin, PAGE.margin + 10);
    }
    if (opts.legend?.length) drawLegend(pdf, opts.legend, PAGE.margin + 16);
    pdf.addImage(
      part.toDataURL('image/jpeg', 0.92),
      'JPEG',
      PAGE.margin,
      PAGE.margin + head,
      drawW,
      part.height * mmPerPx,
    );
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(80, 80, 80);
    pdf.text(label('pdf.page', { n: i + 1, total: slices.length }), PAGE.w - PAGE.margin, PAGE.h - PAGE.margin + 2, {
      align: 'right',
    });
  });
  pdf.save(opts.filename);
}
