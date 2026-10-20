/** États de la coquille : bandeaux de schéma, écrans pleins, squelette, états vides, erreur de vue. */
import { raw } from '../core/sanitize.js';
import { label } from '../labels.js';
import { h, ICONS } from './kit.js';

/** Erreur de lecture signifiant que la table n'existe pas (le reste est « illisible »). */
const MISSING_TABLE = /KeyError|not found|introuvable|does not exist|unknown table/i;
const clean = (msg) =>
  String(msg)
    .trim()
    .replace(/[.\s]+$/, '');

function consequenceOf(table, column) {
  const key = column === null ? `schema.consequence.table.${table}` : `schema.consequence.${table}.${column}`;
  const text = label(key);
  return text === key ? label('schema.consequence.default') : text;
}

/**
 * Message d'un problème de schéma renvoyé par la passerelle.
 * @param {{table:string, column:string|null, optional:boolean, error?:string}} p
 * @returns {{key:string, tone:'danger'|'warning', text:string}}
 */
export function schemaMessage(p) {
  const tone = p.optional ? 'warning' : 'danger';
  const consequence = consequenceOf(p.table, p.column);
  if (p.column === null && p.error && !MISSING_TABLE.test(p.error)) {
    return {
      key: `${p.optional ? 'opt:' : ''}${p.table}`,
      tone,
      text: label('schema.unreadable', { table: p.table, message: clean(p.error), consequence }),
    };
  }
  if (p.optional)
    return { key: `opt:${p.table}`, tone, text: label('schema.optional', { table: p.table, consequence }) };
  if (p.column === null) return { key: p.table, tone, text: label('schema.table', { table: p.table, consequence }) };
  return {
    key: `${p.table}.${p.column}`,
    tone,
    text: label('schema.column', { table: p.table, column: p.column, consequence }),
  };
}

/** Bandeaux de schéma regroupés par gravité (un seul message par clé), refermables pour la session. */
export function createAlerts(root) {
  const dismissed = new Set();

  function render(problems) {
    const seen = new Map();
    for (const p of problems) {
      const m = schemaMessage(p);
      if (!seen.has(m.key) && !dismissed.has(m.key)) seen.set(m.key, m);
    }
    const msgs = [...seen.values()];
    const group = (tone) => msgs.filter((m) => m.tone === tone);
    root.innerHTML = ['danger', 'warning']
      .filter((tone) => group(tone).length)
      .map(
        (tone) =>
          h`<div
            class="fr-alert fr-alert--sm ${raw(tone === 'danger' ? 'fr-alert--error' : 'fr-alert--warning')}"
            role="${tone === 'danger' ? 'alert' : 'status'}"
          >
            ${group(tone).map((m) => h`<p>${m.text}</p>`)}
            <button
              type="button"
              class="fr-btn--close fr-btn"
              data-dismiss="${group(tone)
                .map((m) => m.key)
                .join('|')}"
              title="${label('schema.dismiss')}"
            >
              ${label('schema.dismiss')}
            </button>
          </div>`,
      )
      .join('');
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dismiss]');
    if (!b) return;
    b.dataset.dismiss.split('|').forEach((k) => dismissed.add(k));
    b.closest('.fr-alert').remove();
  });

  return { render };
}

/** Écran plein : 'outside' (hors Grist), 'noapi' (API Grist non chargée), 'access' (accès insuffisant), 'error'. */
export function screenHtml(kind, vars = {}) {
  if (kind === 'access') {
    return h`<div class="screen card">
      ${ICONS.lock}
      <h2 class="fr-h4 screen__title">${label('screen.access.title')}</h2>
      <p>${label('screen.access.body')}</p>
      <ol class="screen__steps">
        <li>${label('screen.access.step1')}</li>
        <li>${label('screen.access.step2')}</li>
        <li>${label('screen.access.step3')}</li>
      </ol>
    </div>`;
  }
  if (kind === 'error') {
    return h`<div class="screen card" role="alert">
      ${ICONS.warning}
      <h2 class="fr-h4 screen__title">${label('screen.error.title')}</h2>
      <p>${label('screen.error.body', { message: vars.message ?? '' })}</p>
      <button type="button" class="fr-btn fr-btn--icon-left fr-icon-refresh-line" data-action="refresh">
        ${label('app.refresh')}
      </button>
    </div>`;
  }
  if (kind === 'noapi') {
    return h`<div class="screen card" role="alert">
      ${ICONS.warning}
      <h2 class="fr-h4 screen__title">${label('screen.noapi.title')}</h2>
      <p>${label('screen.noapi.body')}</p>
    </div>`;
  }
  return h`<div class="screen card">
    ${ICONS.grist}
    <h2 class="fr-h4 screen__title">${label('screen.outside.title')}</h2>
    <p>${label('screen.outside.body')}</p>
  </div>`;
}

/** Squelette de chargement d'une vue. */
export function skeletonHtml() {
  const cols = [5, 3, 4, 2];
  return h`<div class="skeleton-view" aria-hidden="true">
      ${cols.map(
        (n) =>
          h`<div class="skeleton-col">
            <span class="skeleton skeleton--head"></span>
            ${Array.from({ length: n }, () => h`<span class="skeleton skeleton--card"></span>`)}
          </div>`,
      )}
    </div>
    <p class="fr-sr-only" role="status">${label('app.loading')}</p>`;
}

/** État vide : aucune tâche ne correspond aux filtres. */
export function emptyFiltersHtml() {
  return h`<div class="empty" role="status">
    ${ICONS.empty}
    <p class="empty__title">${label('empty.filters')}</p>
    <p class="empty__hint">${label('empty.filters.hint')}</p>
    <button type="button" class="fr-btn" data-action="clear-filters">${label('empty.filters.action')}</button>
  </div>`;
}

/** État vide : aucune personne ISD dans Team. */
export function emptyPeopleHtml() {
  return h`<div class="empty" role="status">
    ${ICONS.people}
    <p class="empty__title">${label('empty.people')}</p>
    <p class="empty__hint">${label('empty.people.hint')}</p>
  </div>`;
}

/** Erreur de rendu d'une vue (les autres restent disponibles). */
export function viewErrorHtml(message) {
  return h`<div class="fr-alert fr-alert--error fr-alert--sm" role="alert">
    <p>${label('view.error', { message })}</p>
  </div>`;
}
