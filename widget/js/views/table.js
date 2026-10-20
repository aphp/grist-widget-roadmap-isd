/**
 * Vue Tableau (lecture seule) : une ligne par tâche (sous-tâches comprises, marquées « ↳ »), triée par défaut par
 * projet, chantier puis début, triable sur toute colonne. Colonnes masquables, export CSV (hiérarchie complète).
 * La hiérarchie projet → chantier se lit dans le Gantt. Un seul innerHTML par rendu, écouteurs délégués.
 * Pagination (P-PERF-2) : 100 lignes rendues, puis « Afficher 100 de plus » ajoute les suivantes sans tout redessiner ;
 * tri, compteur et export CSV portent sur toutes les lignes. Un filtre, une recherche ou un tri repart à 100 ; une
 * relecture (après une écriture) garde les lignes déjà affichées.
 * Statut depuis la ligne (P-UX-6) : en édition, la cellule Statut d'une tâche modifiable devient un bouton-menu ;
 * après le changement, le focus revient à ce bouton (la ligne reste affichée, même triée par statut).
 */
import { raw } from '../core/sanitize.js';
import { priorityText } from '../core/kanban-data.js';
import {
  COLUMNS,
  DEFAULT_COLUMNS,
  DISPLAY_COLUMNS,
  cellText,
  csvColumns,
  csvFilenameOfDay,
  defaultOrder,
  etpParts,
  isLate,
  nextLimit,
  pageRows,
  parentTitle,
  personInitials,
  priorityRank,
  sortRows,
  TABLE_PAGE,
  tableRows,
  toCsv,
} from '../core/table-data.js';
import { h, icon, roleFullText } from '../ui/kit.js';
import { limitToReveal } from '../core/quick-status.js';
import { viewHeading } from '../ui/heading.js';
import { etpLabel, label, statusLabel } from '../labels.js';

export const id = 'table';

/** Écouteurs focusout par conteneur, retirés au rendu suivant. */
const listeners = new WeakMap();

const KNOWN_STATUSES = new Set(['todo', 'inprogress', 'review', 'done']);
const ROLE_CLASS = Object.freeze({ PO: 'po', DA: 'da', DS: 'ds', DE: 'de', Mgmt: 'mgmt' });
/** Avatars affichés avant « +n ». */
const MAX_AVATARS = 2;

const statusKey = (s) => (KNOWN_STATUSES.has(s) ? s : 'other');

function headCell(key, sort) {
  const active = sort?.key === key;
  const dir = active ? sort.dir : null;
  const name = label(`table.col.${key}`);
  return h`<th scope="col" class="tbl__th tbl__th--${key}" aria-sort="${dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}">
    <button type="button" class="tbl__sort" data-sort="${key}" title="${label('table.sort', { colonne: name })}">
      <span>${name}</span>${icon(dir === 'asc' ? 'arrow-up-s-line' : dir === 'desc' ? 'arrow-down-s-line' : 'arrow-up-down-line', dir ? '' : 'tbl__sort-idle')}
    </button>
  </th>`;
}

/** Pastille de statut : point coloré et libellé (jamais la couleur seule). */
const statusPill = (status) =>
  h`<span class="tbl-status tbl-status--${statusKey(status)}"><span class="tbl-status__dot" aria-hidden="true"></span><span class="tbl-status__text" title="${statusLabel(status)}">${statusLabel(status)}</span></span>`;

/**
 * Colonne « Équipe (ETP) » : pastilles par profil écrites dans la cellule (« 0,3 PO », « 1,0 DA »…, retour à la
 * ligne possible), puis le total « Σ 1,8 ». Une phrase complète pour les lecteurs d'écran.
 */
function etpCell(r) {
  const e = etpParts(r);
  if (!e) return h`<td class="tbl__td tbl__td--etp"></td>`;
  const sr = e.parts.length
    ? label('table.etp.sr', { total: e.total, detail: e.parts.map((p) => `${p.text} ${etpLabel(p.role)}`).join(', ') })
    : label('table.etp.total', { total: e.total });
  return h`<td class="tbl__td tbl__td--etp"><span class="tbl-etp"><span class="fr-sr-only">${sr}</span>${e.parts.map(
    (p) =>
      h`<span class="tbl-chip tbl-chip--${ROLE_CLASS[p.role] ?? 'other'}" aria-hidden="true">${p.text}<span class="tbl-chip__role">${etpLabel(p.role)}</span></span>`,
  )}<span class="tbl-etp__total" aria-hidden="true">${label('table.etp.sum', { total: e.total })}</span></span></td>`;
}

const etpText = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Texte complet d'une personne : nom, profil, ETP sur la tâche, « non assignée » s'il y a lieu. */
function personText(p) {
  const parts = [p.role ? `${p.nom} (${roleFullText(p.role)})` : p.nom];
  if (p.etp) parts.push(label('detail.etp', { valeur: etpText.format(p.etp) }));
  if (p.assigned === false) parts.push(label('detail.people.unassigned'));
  return parts.join(' · ');
}

/**
 * Personnes (assignés et charges réunis) : avatar à initiales (anneau de la couleur du profil) suivi du profil écrit,
 * jamais la couleur seule ; une personne chargée mais non assignée a un anneau pointillé. Infobulle et lecteurs
 * d'écran : nom, profil, ETP et « non assignée ».
 */
function avatars(persons) {
  if (!persons.length) return '';
  const shown = persons.slice(0, MAX_AVATARS);
  const rest = persons.length - shown.length;
  const names = persons.map(personText).join(', ');
  return h`<span class="tbl-people" title="${names}"><span class="fr-sr-only">${label('table.people.list', { noms: names })}</span>${shown.map(
    (p) =>
      h`<span class="tbl-person" aria-hidden="true"><span class="tbl-avatar tbl-avatar--${ROLE_CLASS[p.role] ?? 'other'}${raw(p.assigned === false ? ' tbl-avatar--unassigned' : '')}">${personInitials(p.nom)}</span>${p.role ? h`<span class="tbl-person__role">${label(`profile.${p.role}`)}</span>` : ''}</span>`,
  )}${rest > 0 ? h`<span class="tbl-avatar tbl-avatar--more" aria-hidden="true">${label('table.people.more', { n: rest })}</span>` : ''}</span>`;
}

function dateCell(r, key, today) {
  const text = cellText(r, key);
  if (!text) return h`<td class="tbl__td tbl__td--date"></td>`;
  const late = key === 'end' && isLate(r, today);
  return h`<td class="tbl__td tbl__td--date"><span class="tbl-date">${icon('calendar-line', 'tbl-ico')}${text}</span>${late ? h`<span class="tbl-late" title="${label('table.late')}">${icon('alarm-warning-line', 'tbl-ico')}<span class="fr-sr-only">${label('table.late')}</span></span>` : ''}</td>`;
}

/** Cellule « Tâche » : pictogramme (« ↳ » pour une sous-tâche), bouton qui ouvre la fiche, étiquette de jalon. */
function titleCell(r) {
  const sub = r.level === 'sous-tache';
  const parent = parentTitle(r);
  const full = [r.projet, r.chantier, r.tache, r.sousTache].filter(Boolean).join(' › ');
  const mark = r.milestone
    ? h`<span class="tbl-level tbl-level--jalon" title="${label('table.milestone')}">${icon('map-pin-2-line')}</span>`
    : sub
      ? h`<span class="tbl-sub" aria-hidden="true" title="${label('table.subtaskOf', { titre: parent })}">↳</span>`
      : h`<span class="tbl-level" aria-hidden="true">${icon('checkbox-circle-line')}</span>`;
  return h`<td class="tbl__td tbl__td--tache">
    <span class="tbl-title${raw(sub ? ' tbl-title--sub' : '')}">${mark}<button type="button" class="tbl__open" data-open="${r.taskId}" title="${full}">${parent ? h`<span class="fr-sr-only">${label('table.subtaskOf', { titre: parent })} </span>` : ''}${r.own}</button>${r.milestone ? h`<span class="tbl-tag tbl-tag--jalon">${label('table.milestone')}</span>` : ''}</span>
  </td>`;
}

/** Cellule Statut en édition : bouton-menu (pastille et ▾), nom accessible qui commence par le texte visible. */
const statusButton = (r) =>
  h`<td class="tbl__td tbl__td--qs"><button type="button" class="tbl-qs" data-qs-open="${r.taskId}" data-qs-focus="${r.taskId}" aria-haspopup="menu" aria-expanded="false" aria-label="${label('quickStatus.button', { statut: statusLabel(r.status), titre: r.own })}">${statusPill(r.status)}<span class="tbl-qs__caret" aria-hidden="true">▾</span></button></td>`;

function cell(r, key, today, qs) {
  switch (key) {
    case 'tache':
      return titleCell(r);
    case 'chantier':
      return h`<td class="tbl__td tbl__td--chantier"><span class="tbl-chantier" title="${r.chantier}"><span class="tbl-chantier__dot" aria-hidden="true"></span><span class="tbl-ellipsis">${r.chantier}</span></span></td>`;
    case 'projet':
      return h`<td class="tbl__td tbl__td--projet">${r.projet ? h`<span class="tbl-projet" title="${r.projet}">${r.projet}</span>` : ''}</td>`;
    case 'status':
      return qs?.can(r.taskId) ? statusButton(r) : h`<td class="tbl__td">${statusPill(r.status)}</td>`;
    case 'start':
    case 'end':
      return dateCell(r, key, today);
    case 'people':
      return h`<td class="tbl__td tbl__td--people">${avatars(r.persons)}</td>`;
    case 'priority': {
      if (!r.priority) return h`<td class="tbl__td"></td>`;
      const rank = priorityRank(r.priority);
      return h`<td class="tbl__td"><span class="tbl-prio tbl-prio--${rank ?? 'none'}">${icon('flag-fill', 'tbl-ico')}${priorityText(r.priority)}</span></td>`;
    }
    case 'etp':
      return etpCell(r);
    case 'etpPO':
    case 'etpDA':
    case 'etpDS':
    case 'etpDE':
    case 'etpMgmt':
    case 'etpOther':
      return h`<td class="tbl__td tbl__td--num">${cellText(r, key)}</td>`;
    default: {
      const text = cellText(r, key);
      return h`<td class="tbl__td tbl__td--text"><span class="tbl-ellipsis" title="${text}">${text}</span></td>`;
    }
  }
}

/** Ligne de tâche ; `i` = rang dans toutes les lignes (zébrure stable quand des lignes sont ajoutées). */
const rowHtml = (r, i, cols, today, qs) =>
  h`<tr class="tbl__row tbl-s--${statusKey(r.status)}${raw(i % 2 ? ' tbl__row--alt' : '')}" data-task="${r.taskId}">${cols.map((c) => cell(r, c, today, qs))}</tr>`;

const fmt = (n) => n.toLocaleString('fr-FR');

/** Compteur : toutes les lignes ; « 100 sur 587 tâches affichées » tant que la pagination en masque. */
function countText(total, shown) {
  if (total === 0) return label('table.count.none');
  if (total === 1) return label('table.count.one');
  return shown < total
    ? label('table.count.page', { shown: fmt(shown), n: fmt(total) })
    : label('table.count', { n: fmt(total) });
}

const moreButton = (next) =>
  h`<div class="tbl__more"><button type="button" id="tbl-more" class="fr-btn fr-btn--sm fr-btn--tertiary" data-table-more aria-describedby="tbl-count-text">${label('table.more', { n: next })}</button></div>`;

function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Sélecteur permettant de retrouver l'élément focalisé après repeinture. */
function focusSelector(el) {
  const a = document.activeElement;
  if (!a || !el.contains(a)) return '';
  for (const k of ['sort', 'open', 'col', 'export'])
    if (a.dataset[k] !== undefined) return `[data-${k}="${CSS.escape(a.dataset[k])}"]`;
  if (a.dataset.qsOpen !== undefined) return `[data-qs-open="${CSS.escape(a.dataset.qsOpen)}"]`;
  return a.id ? `#${CSS.escape(a.id)}` : '';
}

/**
 * Nombre de lignes affichées du dernier Tableau, avec la clé de ce qu'il montrait (filtres, projets masqués, tri) :
 * une relecture après une écriture (onRecords) redessine la vue avec la même clé et garde ces lignes ; un autre
 * filtre, une recherche ou un tri repart à une page.
 */
let kept = { key: '', limit: TABLE_PAGE };
const pageKey = (ctx, sort) =>
  JSON.stringify([ctx.prefs?.filters ?? null, ctx.prefs?.hiddenProjects ?? null, sort ?? null]);

/**
 * @param {HTMLElement} el
 * @param {object} ctx contexte fourni par main.js
 */
export function render(el, ctx) {
  const saved = ctx.prefs ?? {};
  const st = {
    columns: Array.isArray(saved.tableColumns) && saved.tableColumns.length ? saved.tableColumns : [...DEFAULT_COLUMNS],
    sort: saved.tableSort ?? null,
    menu: false,
    /** Lignes rendues (pagination) : gardées après une relecture, remises à une page par un filtre ou un tri. */
    limit: TABLE_PAGE,
    cols: [],
  };
  if (kept.key === pageKey(ctx, st.sort)) st.limit = kept.limit;
  const remember = () => (kept = { key: pageKey(ctx, st.sort), limit: st.limit });
  remember();
  const base = defaultOrder(tableRows(ctx.model, ctx.view));
  let rows = base;
  let notice = '';

  function paint() {
    rows = st.sort ? sortRows(base, st.sort.key, st.sort.dir) : base;
    // Tâche dont le statut vient de changer : sa ligne reste affichée malgré la pagination
    if (ctx.reveal !== null && ctx.reveal !== undefined) {
      st.limit = limitToReveal(
        st.limit,
        rows.findIndex((r) => r.taskId === ctx.reveal),
        TABLE_PAGE,
      );
      remember();
    }
    const cols = COLUMNS.filter((c) => c === 'tache' || (st.columns.includes(c) && DISPLAY_COLUMNS.includes(c)));
    st.cols = cols;
    const page = pageRows(rows, st.limit);
    const focusSel = focusSelector(el);
    const hint = st.sort ? '' : h` <span class="tbl__hint">· ${label('table.sort.default')}</span>`;
    el.innerHTML = h`<div class="tbl">
      ${viewHeading(
        label('heading.table.title'),
        h`<p class="tbl__count" role="status"><span id="tbl-count-text">${countText(page.total, page.shown.length)}</span>${hint}${notice ? h` <span class="tbl__notice">— ${notice}</span>` : ''}</p>`,
        h`<div class="tbl__actions">
          <div class="popover-anchor">
            <button type="button" id="tbl-cols-btn" class="fr-btn fr-btn--sm fr-btn--tertiary fr-btn--icon-left fr-icon-layout-grid-line" aria-haspopup="true" aria-expanded="${st.menu}" aria-controls="tbl-cols">${label('table.columns')}</button>
            <div id="tbl-cols" class="popover popover--end" role="group" aria-label="${label('table.columns')}" ${raw(st.menu ? '' : 'hidden')}>
              <p class="popover__help">${label('table.columns.help')}</p>
              <ul class="list popover__list">
                <li class="fr-checkbox-group fr-checkbox-group--sm"><input type="checkbox" id="tbl-col-tache" checked disabled /><label class="fr-label" for="tbl-col-tache">${label('table.col.tache')} <span class="tbl__muted">(${label('table.columns.always')})</span></label></li>
                ${DISPLAY_COLUMNS.map((c) => {
                  const on = st.columns.includes(c);
                  return h`<li class="fr-checkbox-group fr-checkbox-group--sm"><input type="checkbox" id="tbl-col-${c}" data-col="${c}" ${raw(on ? 'checked' : '')} /><label class="fr-label" for="tbl-col-${c}">${label(`table.col.${c}`)}</label></li>`;
                })}
              </ul>
            </div>
          </div>
          <button type="button" id="tbl-export" class="fr-btn fr-btn--sm fr-btn--secondary fr-btn--icon-left fr-icon-download-line" data-export>${label('table.export')}</button>
        </div>`,
      )}
      <div class="fr-table fr-table--sm tbl__table" role="region" aria-label="${label('table.label')}" tabindex="-1">
        <div class="fr-table__wrapper"><div class="fr-table__container"><div class="fr-table__content">
          <table class="tbl__grid">
            <caption class="fr-sr-only">${label('table.caption')}</caption>
            <thead><tr>${cols.map((c) => headCell(c, st.sort))}</tr></thead>
            <tbody>${
              rows.length
                ? page.shown.map((r, i) => rowHtml(r, i, cols, ctx.today, ctx.quickStatus))
                : h`<tr><td class="tbl__empty" colspan="${cols.length}">${label('table.empty')}</td></tr>`
            }</tbody>
          </table>
        </div></div></div>
      </div>
      ${page.rest > 0 ? moreButton(page.next) : ''}
    </div>`.toString();
    if (focusSel) el.querySelector(focusSel)?.focus();
  }

  /**
   * « Afficher plus » : ajoute la page suivante au corps du tableau sans repeindre le reste (en-tête, compteur
   * persistant, donc annoncé par la zone role="status") ; le focus passe au titre de la première ligne ajoutée.
   */
  function showMore() {
    const from = pageRows(rows, st.limit).shown.length;
    st.limit = nextLimit(st.limit, rows.length);
    remember();
    const page = pageRows(rows, st.limit);
    const tbody = el.querySelector('.tbl__grid tbody');
    if (!tbody) return paint();
    tbody.insertAdjacentHTML(
      'beforeend',
      h`${page.shown.slice(from).map((r, k) => rowHtml(r, from + k, st.cols, ctx.today, ctx.quickStatus))}`.toString(),
    );
    el.querySelector('#tbl-count-text').textContent = countText(page.total, page.shown.length);
    const more = el.querySelector('.tbl__more');
    if (page.rest > 0) more.querySelector('button').textContent = label('table.more', { n: page.next });
    else more.remove();
    tbody.rows[from]?.querySelector('.tbl__open')?.focus();
  }

  el.onclick = (e) => {
    const t = e.target;
    if (t.closest('[data-table-more]')) return showMore();
    const q = t.closest('[data-qs-open]');
    if (q) return ctx.quickStatus?.open(q, Number(q.dataset.qsOpen));
    if (t.closest('#tbl-cols-btn')) {
      st.menu = !st.menu;
      if (st.menu) document.addEventListener('pointerdown', outside, true);
      else document.removeEventListener('pointerdown', outside, true);
      paint();
      if (st.menu) el.querySelector('#tbl-cols input:not(:disabled)')?.focus();
      return;
    }
    const s = t.closest('[data-sort]');
    if (s) {
      // Croissant, décroissant, puis retour à l'ordre par défaut (projet, chantier, début)
      const key = s.dataset.sort;
      st.sort = st.sort?.key !== key ? { key, dir: 'asc' } : st.sort.dir === 'asc' ? { key, dir: 'desc' } : null;
      st.limit = TABLE_PAGE;
      remember();
      notice = '';
      ctx.setPrefs?.({ tableSort: st.sort });
      return paint();
    }
    if (t.closest('[data-export]')) {
      const name = csvFilenameOfDay(ctx.today);
      download(toCsv(rows, csvColumns(st.columns)), name);
      notice = label('table.exported', { nom: name });
      return paint();
    }
    if (t.closest('.popover-anchor')) return;
    // Toute la ligne ouvre la fiche (souris) ; au clavier, le bouton du titre le fait
    const r = t.closest('tr[data-task]');
    if (r) ctx.openDetail({ table: 'Tasks', id: Number(r.dataset.task) });
  };
  el.onchange = (e) => {
    const c = e.target.closest('input[data-col]')?.dataset.col;
    if (!c) return;
    const next = e.target.checked ? [...st.columns, c] : st.columns.filter((x) => x !== c);
    st.columns = COLUMNS.filter((x) => x === 'tache' || next.includes(x));
    notice = '';
    ctx.setPrefs?.({ tableColumns: st.columns, tableColumnsV: 3 });
    paint();
  };
  el.onkeydown = (e) => {
    if (e.key === 'Escape' && st.menu) {
      e.stopPropagation();
      closeMenu();
      el.querySelector('#tbl-cols-btn')?.focus();
    }
  };
  const outside = (e) => {
    if (!el.isConnected) document.removeEventListener('pointerdown', outside, true);
    else if (!e.target.closest?.('.tbl .popover-anchor')) closeMenu();
  };
  function closeMenu() {
    st.menu = false;
    document.removeEventListener('pointerdown', outside, true);
    el.querySelector('#tbl-cols')?.setAttribute('hidden', '');
    el.querySelector('#tbl-cols-btn')?.setAttribute('aria-expanded', 'false');
  }
  // focusout n'a pas de propriété « on… » : écouteur ajouté, retiré au rendu suivant sur le même élément
  listeners.get(el)?.abort();
  const off = new AbortController();
  listeners.set(el, off);
  el.addEventListener(
    'focusout',
    (e) => {
      // relatedTarget nul (fenêtre, clic hors élément focalisable ou repeinture) : le clic extérieur est géré à part.
      // Focus passé à un ancêtre (clic sur le libellé d'une case, non focalisable) : le menu reste ouvert.
      const to = e.relatedTarget;
      if (st.menu && to && !to.closest?.('.popover-anchor') && !to.contains(e.target)) closeMenu();
    },
    { signal: off.signal },
  );
  paint();
}
