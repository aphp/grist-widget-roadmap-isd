/**
 * Vue Kanban : colonnes par statut (ordre du cycle de vie), priorité ou chantier ; une carte par tâche. Focus
 * itinérant : un seul arrêt de tabulation par colonne, flèches entre cartes et colonnes. La page défile seule (pas
 * d'ascenseur par colonne) ; les en-têtes de colonne restent visibles en haut de l'écran.
 * Statut depuis la carte (P-UX-6), seulement en édition et si la tâche est modifiable : bouton ⋯ en haut à droite
 * de la carte (souris), hors du focus itinérant (tabindex -1) pour garder un seul arrêt par colonne ; au clavier,
 * « S », Maj+F10 ou la touche Menu sur la carte focalisée ouvre le même menu. Après le changement, le focus reste
 * sur la carte, y compris quand elle change de colonne (Kanban groupé par statut).
 * Glisser (lot C) : une carte modifiable se dépose dans une autre colonne du Kanban groupé par statut ou par
 * priorité (souris, stylet ; doigt après un appui long). Colonnes permises soulignées, les autres grisées avec leur
 * raison ; aucun rendu pendant le geste (fantôme posé sur <body>, colonne visée par elementFromPoint) ; bord du
 * plateau tenu → défilement d'une colonne. Le dépôt passe par les statut et priorité rapides (ctx.drop.drop) ; la
 * carte reste à sa nouvelle place, « Enregistrement… », jusqu'à la réponse. Alternatives : menu ⋯ (« Statut… »,
 * « Priorité… »), touches S et P. Regroupement par chantier : pas de glisser (lot D).
 */
import { raw } from '../core/sanitize.js';
import { formatDateFr } from '../core/dates.js';
import { statusTone } from '../core/stats-data.js';
import {
  GROUPS,
  SORTS,
  etpRoleParts,
  isColumnCollapsed,
  kanbanColumns,
  peopleDisplay,
  priorityText,
  rovingMove,
  shortName,
  taskEtp,
  taskEtpByRole,
  taskPaths,
  taskPeopleRows,
  taskPriority,
  toggleColumn,
} from '../core/kanban-data.js';
import { displayRole } from '../core/team-directory.js';
import { isMenuShortcut, isPriorityShortcut, isStatusShortcut, limitToReveal } from '../core/quick-status.js';
import { columnName, dropChanges, dropColumns, hasDropTarget, isApplied, pendingModel } from '../core/kanban-drop.js';
import { h, icon, keepFocus, roleFullText, statusBadge } from '../ui/kit.js';
import { viewHeading } from '../ui/heading.js';
import { statusContextMenu } from '../ui/status-popover.js';
import { liveAnnouncer, trackPointer } from '../ui/drag.js';
import { etpLabel, label, statusLabel } from '../labels.js';

export const id = 'kanban';

/** Cartes affichées d'emblée par colonne ; « Afficher plus » ajoute un lot. */
const PAGE = 40;
const SEP = ' › ';
const NO_FIELDS = Object.freeze({ statut: false, priorite: false });
/** Éléments du focus itinérant d'une colonne, dans l'ordre : bouton de repli, cartes, « Afficher plus ». */
const ITEMS = '.kcol__toggle, .kcard, .kcol__more';

/** Écouteurs de fenêtre (défilement, redimensionnement) par conteneur, retirés au rendu suivant. */
const listeners = new WeakMap();

/**
 * Glisser d'une carte, gardé d'un rendu à l'autre (une relecture pendant le geste le rattache) : gesture ({ taskId,
 * group, fromKey, targets, ghost, over, … }), saving ({ taskId, group, changes } : carte affichée à sa nouvelle
 * place jusqu'à la réponse) et fonctions du dernier rendu (view).
 */
const memory = { gesture: null, saving: null, view: null };
/** Annonces du glisser (#kanban-live, hors de la vue redessinée). */
const announce = liveAnnouncer('kanban-live');

/**
 * « Afficher plus » et carte d'entrée de chaque colonne, gardés d'un rendu à l'autre tant que la vue montre la même
 * chose (filtres, projets masqués) : une relecture après une écriture ne replie pas les colonnes déjà dépliées.
 */
let kept = { key: '', limits: new Map(), active: new Map() };
const keepKey = (ctx) => JSON.stringify([ctx.prefs?.filters ?? null, ctx.prefs?.hiddenProjects ?? null]);

const etpFormat = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function initials(nom) {
  const words = (nom || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Texte complet d'une personne de la liste unique : nom, profil, ETP sur la tâche, « non assignée » s'il y a lieu
 * (infobulle et lecteurs d'écran).
 */
function fullName(r) {
  const p = r.person;
  const parts = [r.role ? `${p.nom} (${roleFullText(r.role)})` : p.nom];
  if (r.etp) parts.push(label('kanban.etp', { valeur: etpFormat.format(r.etp) }));
  if (!r.assigned) parts.push(label('detail.people.unassigned'));
  return parts.join(' · ');
}

/**
 * Personnes de la carte (assignés et charges réunis) : « Nom P. » pour une ou deux personnes, initiales et « +n »
 * au-delà ; une personne chargée mais non assignée est marquée discrètement (contour pointillé). Les noms complets,
 * avec profil et ETP, sont lus par les lecteurs d'écran et affichés en infobulle au survol comme au focus de la carte.
 */
function peopleHtml(rows) {
  if (!rows.length) return '';
  const { named, shown, more } = peopleDisplay(rows);
  const role = (r) => (r.role ? h`<span class="kcard__role">${label(`profile.${r.role}`)}</span>` : '');
  const off = (r) => raw(r.assigned ? '' : ' kcard__person--unassigned');
  const visible = named
    ? shown.map(
        (r) =>
          h`<span class="kcard__person kcard__person--named${off(r)}"><span class="kcard__name">${shortName(r.person.nom)}</span>${role(r)}</span>`,
      )
    : [
        ...shown.map(
          (r) =>
            h`<span class="kcard__person${off(r)}"><span class="kcard__avatar">${initials(r.person.nom)}</span>${role(r)}</span>`,
        ),
        more > 0 ? h`<span class="kcard__avatar kcard__avatar--more">+${more}</span>` : '',
      ];
  const names = rows.map(fullName);
  return h`<span class="kcard__people">
    <span class="fr-sr-only">${label('kanban.people', { noms: names.join(', ') })}</span>
    <span class="kcard__people-list" aria-hidden="true">${visible}</span>
    <span class="kcard__tip" aria-hidden="true">${names.map((n) => h`<span class="kcard__tip-line">${n}</span>`)}</span>
  </span>`;
}

/** Dates de la carte : plage complète, une seule date nommée, ou « Pas de dates ». */
function datesHtml(task) {
  const { start, end } = task;
  let body;
  if (start !== null && end !== null)
    body = h`<span class="fr-sr-only">${label('kanban.start')} </span>${formatDateFr(start)}<span aria-hidden="true"> → </span><span class="fr-sr-only"> ${label('kanban.end')} </span>${formatDateFr(end)}`;
  else if (start !== null) body = label('kanban.startOnly', { date: formatDateFr(start) });
  else if (end !== null) body = label('kanban.endOnly', { date: formatDateFr(end) });
  else body = label('kanban.noDates');
  return h`<span class="kcard__dates">${icon('calendar-line')}<span>${body}</span></span>`;
}

/** Ventilation de l’ETP par profil (« DE 1,0 · DA 0,5 ») ; null s’il n’y a aucune part affichable. */
function etpBreakdown(model, task) {
  const parts = etpRoleParts(taskEtpByRole(task, model)).map((p) => ({
    name: etpLabel(p.key),
    text: p.text,
  }));
  return parts.length ? parts : null;
}

/** Attributs du focus itinérant : seul l'élément d'entrée de la colonne est un arrêt de tabulation. */
const roving = (entry) => raw(entry ? 'tabindex="0" aria-describedby="kanban-help"' : 'tabindex="-1"');

/** Bouton ⋯ (P-UX-6, lot C) : menu « Statut… », « Priorité… », à côté de la carte, hors du focus itinérant. */
function actionsButton(task) {
  const title = task.title || label('common.untitled');
  return h`<button type="button" class="kcard__qs" data-qs-open="${task.id}" tabindex="-1" aria-haspopup="menu" aria-expanded="false" aria-label="${label('kanban.actions.open', { titre: title, statut: statusLabel(task.status) })}" title="${label('kanban.actions.title')}"><span aria-hidden="true">⋯</span></button>`;
}

/** Attributs d'édition de la carte : clé de focus, raccourcis, glisser, état « Enregistrement… ». */
function cardEditAttrs(taskId, fields, drag, saving) {
  if (!fields.statut && !fields.priorite) return '';
  const keys = [fields.statut && 'S', fields.priorite && 'P', 'Shift+F10'].filter(Boolean).join(' ');
  return raw(
    ` data-qs-focus="${taskId}" aria-keyshortcuts="${keys}"${drag ? ' data-drag-card' : ''}${saving ? ' aria-busy="true"' : ''}`,
  );
}

/**
 * @param {{model:object, group:string, open:Set<string>|null}} board modèle affiché (avec la carte en cours
 *   d'enregistrement à sa nouvelle place), regroupement, colonnes ouvertes au dépôt (null : pas de glisser)
 */
function cardHtml(ctx, board, taskId, paths, showStatus, entry) {
  const { model } = board;
  const task = model.tasks.get(taskId);
  const fields = ctx.quickStatus?.fields?.(taskId) ?? NO_FIELDS;
  const qs = fields.statut || fields.priorite;
  const saving = memory.saving?.taskId === taskId;
  const right = board.group === 'status' ? fields.statut : board.group === 'priority' && fields.priorite;
  const drag = Boolean(board.open && right && !saving && hasDropTarget(model, taskId, board.group, board.open));
  const path = (paths.get(taskId)?.path ?? []).join(SEP);
  const late = task.end !== null && task.end < ctx.today && !task.done;
  const etp = taskEtp(task) || null; // 0 (aucune charge) : rien à afficher
  const priority = taskPriority(model, task);
  const parts = etp ? etpBreakdown(model, task) : null;
  const people = taskPeopleRows(model, task)
    .filter((r) => r.person)
    .map((r) => ({ ...r, role: displayRole(model, r.person) }));
  return h`<li class="kcard-item${qs ? ' kcard-item--qs' : ''}">
    <button type="button" class="kcard${late ? ' kcard--late' : ''}${saving ? ' kcard--saving' : ''}" id="kc-${taskId}" data-task="${taskId}" ${roving(entry)}${cardEditAttrs(taskId, fields, drag, saving)}>
      ${path ? h`<span class="kcard__path" title="${path}">${path}</span>` : ''}
      <span class="kcard__title">${task.title || label('common.untitled')}</span>
      <span class="kcard__badges">
        ${saving ? h`<span class="fr-badge fr-badge--sm fr-badge--no-icon kcard__saving">${label('kanban.drop.saving')}</span>` : ''}
        ${showStatus ? statusBadge(task.status) : ''}
        ${late ? h`<span class="fr-badge fr-badge--sm fr-badge--error">${label('kanban.late')}</span>` : ''}
        ${priority ? h`<span class="fr-badge fr-badge--sm fr-badge--no-icon fr-badge--purple-glycine">${priorityText(priority)}</span>` : ''}
      </span>
      ${datesHtml(task)}
      ${
        people.length || etp
          ? h`<span class="kcard__foot">
              ${peopleHtml(people) || h`<span></span>`}
              ${
                etp
                  ? h`<span class="kcard__etp"><span>${label('kanban.etp', { valeur: etpFormat.format(etp) })}</span>${
                      parts
                        ? h`<span class="kcard__roles"><span class="fr-sr-only">${label('kanban.etpRoles', { detail: parts.map((p) => `${p.name} ${p.text}`).join(', ') })}</span><span aria-hidden="true">${parts.map((p) => `${p.name} ${p.text}`).join(' · ')}</span></span>`
                        : ''
                    }</span>`
                  : ''
              }
            </span>`
          : ''
      }
    </button>
    ${qs ? actionsButton(task) : ''}
  </li>`;
}

function columnHtml(ctx, board, col, st, paths) {
  const ckey = `${st.group}:${col.key}`;
  const collapsed = isColumnCollapsed(st.collapsed, ckey, !col.tasks.length);
  const shown = Math.min(col.tasks.length, st.limits.get(ckey) ?? PAGE);
  const visible = collapsed ? [] : col.tasks.slice(0, shown);
  const rest = col.tasks.length - shown;
  // Élément d'entrée (seul arrêt de tabulation) : le dernier focalisé s'il est encore affiché, sinon la première
  // carte, sinon le bouton de repli
  const ids = [`kt-${ckey}`, ...visible.map((t) => `kc-${t}`), ...(!collapsed && rest > 0 ? [`km-${ckey}`] : [])];
  // Tâche dont le statut vient de changer : elle devient l'entrée de sa colonne (nouvelle colonne comprise)
  if (ctx.reveal !== null && ctx.reveal !== undefined && visible.includes(ctx.reveal))
    st.active.set(ckey, `kc-${ctx.reveal}`);
  const entry = ids.includes(st.active.get(ckey)) ? st.active.get(ckey) : (ids[1] ?? ids[0]);
  const toggle = label(collapsed ? 'kanban.expand' : 'kanban.collapse', { colonne: col.label });
  // Colonnes par statut : couleur du statut sur la colonne, badge de statut inutile sur les cartes.
  const byStatus = st.group === 'status';
  const tone = byStatus ? ` kcol--${statusTone(col.key)}` : '';
  return h`<section class="kcol${collapsed ? ' kcol--collapsed' : ''}${raw(tone)}" data-col="${ckey}" aria-label="${col.label}">
    <header class="kcol__head">
      <button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary-no-outline fr-icon-arrow-${collapsed ? 'right' : 'down'}-s-line kcol__toggle" id="kt-${ckey}" ${roving(entry === `kt-${ckey}`)} data-toggle="${ckey}" data-empty="${!col.tasks.length}" aria-expanded="${!collapsed}" title="${toggle}">${toggle}</button>
      <h3 class="kcol__title">${col.label}</h3>
      <span class="fr-badge fr-badge--sm fr-badge--no-icon kcol__count" title="${label('kanban.count', { n: col.tasks.length })}">${col.tasks.length}</span>
    </header>
    ${
      collapsed
        ? ''
        : h`<div class="kcol__body" data-body="${ckey}">
          ${
            col.tasks.length
              ? h`<ul class="list kcol__list">${visible.map((t) => cardHtml(ctx, board, t, paths, !byStatus, entry === `kc-${t}`))}</ul>`
              : h`<p class="kcol__empty">${label('kanban.empty')}</p>`
          }
          ${rest > 0 ? h`<button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary kcol__more" id="km-${ckey}" ${roving(entry === `km-${ckey}`)} data-more="${ckey}">${label('kanban.more', { n: Math.min(rest, PAGE) })}</button>` : ''}
        </div>`
    }
  </section>`;
}

function selectHtml(idAttr, name, values, current, labelKey) {
  return h`<div class="fr-select-group kanban__field">
    <label class="fr-label" for="${idAttr}">${label(name)}</label>
    <select class="fr-select" id="${idAttr}" data-field="${idAttr}">
      ${values.map((v) => h`<option value="${v}" ${raw(v === current ? 'selected' : '')}>${label(`${labelKey}.${v}`)}</option>`)}
    </select>
  </div>`;
}

/**
 * @param {HTMLElement} el
 * @param {object} ctx contexte fourni par main.js
 */
export function render(el, ctx) {
  const saved = ctx.prefs ?? {};
  if (kept.key !== keepKey(ctx)) kept = { key: keepKey(ctx), limits: new Map(), active: new Map() };
  const st = {
    group: GROUPS.includes(saved.kanbanGroup) ? saved.kanbanGroup : 'status',
    sort: SORTS.includes(saved.kanbanSort) ? saved.kanbanSort : 'due',
    collapsed: [...(saved.kanbanCollapsed ?? [])],
    limits: kept.limits,
    /** Carte d'entrée retenue par colonne (focus itinérant). */
    active: kept.active,
  };
  const qsOn = Boolean(ctx.quickStatus);
  const paths = taskPaths(ctx.view.tree);

  /** Colonnes du dernier rendu (verdicts du glisser au début du geste). */
  let shownCols = [];

  function paint() {
    const board = el.querySelector('.kanban__board');
    const left = board?.scrollLeft ?? 0;
    // Carte en cours d'enregistrement : déjà dans sa nouvelle colonne (Q11)
    // Valeurs déjà dans le modèle (correction locale après l'écriture) : l'état d'enregistrement s'arrête là, la
    // réponse ne redessine pas une fois de plus
    if (memory.saving && isApplied(ctx.model, memory.saving.taskId, memory.saving.changes)) memory.saving = null;
    const saving = memory.saving?.group === st.group ? memory.saving : null;
    const model = saving ? pendingModel(ctx.model, saving.taskId, saving.changes) : ctx.model;
    const cols = kanbanColumns(model, ctx.view.taskIds, st.group, st.sort);
    shownCols = cols;
    const dnd = { model, group: st.group, open: ctx.drop ? dropColumns(model, st.group, cols) : null };
    reveal(cols);
    keepFocus(
      el,
      h`<div class="kanban">
        ${viewHeading(
          label('heading.kanban.title'),
          label('heading.kanban.sub'),
          h`<div class="kanban__bar">
          ${selectHtml('kanban-group', 'kanban.group', GROUPS, st.group, 'kanban.group')}
          ${selectHtml('kanban-sort', 'kanban.sort', SORTS, st.sort, 'kanban.sort')}
        </div>`,
        )}
        <p id="kanban-help" class="fr-sr-only">${label(qsOn ? (ctx.quickStatus.priority ? 'kanban.help.editPriority' : 'kanban.help.edit') : 'kanban.help')}</p>
        <div class="kanban__peeks" hidden>
          ${['left', 'right'].map((side) => h`<button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary kanban__peek kanban__peek--${side}" data-peek="${side}" aria-controls="kanban-board" hidden>${icon(`arrow-${side}-s-line`)}<span class="kanban__peek-text"></span><span class="fr-sr-only kanban__peek-sr"></span></button>`)}
        </div>
        <div class="kanban__viewport">
          <div class="kanban__board" id="kanban-board" data-scroll-key="kanban" role="group" aria-label="${label('kanban.label')}" aria-describedby="kanban-help">
            ${cols.map((c) => columnHtml(ctx, dnd, c, st, paths))}
          </div>
        </div>
      </div>`.toString(),
    );
    const nb = el.querySelector('.kanban__board');
    if (nb) nb.scrollLeft = left;
    layout();
    if (memory.gesture) resumeGesture(memory.gesture, cols);
  }

  /**
   * Tâche dont le statut vient de changer (ctx.reveal) : sa colonne est dépliée assez loin pour qu'elle reste
   * affichée malgré « Afficher plus ». Une colonne repliée le reste (le focus va alors à une voisine).
   */
  function reveal(cols) {
    if (ctx.reveal === null || ctx.reveal === undefined) return;
    for (const col of cols) {
      const i = col.tasks.indexOf(ctx.reveal);
      if (i < 0) continue;
      const k = `${st.group}:${col.key}`;
      st.limits.set(k, limitToReveal(st.limits.get(k) ?? PAGE, i, PAGE));
    }
  }

  /** Colonnes du plateau hors champ à gauche et à droite (1 px de tolérance). */
  function hiddenColumns() {
    const board = el.querySelector('.kanban__board');
    if (!board) return { board, left: [], right: [] };
    const b = board.getBoundingClientRect();
    const cols = [...board.children].map((c) => ({ c, r: c.getBoundingClientRect() }));
    return {
      board,
      left: cols.filter((x) => x.r.left < b.left - 1),
      right: cols.filter((x) => x.r.right > b.right + 1),
    };
  }

  /** Indices « +n colonnes » (barre au-dessus du plateau, dans le flux) et ombres de bord quand le plateau déborde. */
  function updatePeeks() {
    const { board, left, right } = hiddenColumns();
    if (!board) return;
    const viewport = board.parentElement;
    const bar = el.querySelector('.kanban__peeks');
    bar.hidden = !left.length && !right.length;
    for (const [side, list] of [
      ['left', left],
      ['right', right],
    ]) {
      const n = list.length;
      const btn = bar.querySelector(`[data-peek="${side}"]`);
      viewport.classList.toggle(`kanban__viewport--more-${side}`, n > 0);
      if (!n) {
        // Bouton masqué alors qu'il a le focus (bord atteint) : le focus passe à l'autre indice
        if (btn === document.activeElement) bar.querySelector(`[data-peek]:not([data-peek="${side}"])`)?.focus();
        btn.hidden = true;
        continue;
      }
      btn.hidden = false;
      btn.querySelector('.kanban__peek-text').textContent = label(n === 1 ? 'kanban.peek.one' : 'kanban.peek.many', {
        n,
      });
      // Nom accessible = texte visible suivi du sens de défilement (WCAG 2.5.3)
      btn.querySelector('.kanban__peek-sr').textContent = ` ${label(`kanban.peek.${side}`)}`;
      btn.title = label(`kanban.peek.${side}`);
    }
  }

  /** En-têtes de colonne maintenus en haut de l'écran pendant le défilement de la page (le plateau défile en x). */
  function stickHeads() {
    for (const col of el.querySelectorAll('.kcol:not(.kcol--collapsed)')) {
      const head = col.querySelector('.kcol__head');
      const r = col.getBoundingClientRect();
      const y = Math.max(0, Math.min(-r.top, r.height - head.offsetHeight));
      head.style.transform = y ? `translateY(${Math.round(y)}px)` : '';
      head.classList.toggle('kcol__head--stuck', y > 0);
    }
  }

  let frame = 0;
  function layout() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!el.isConnected) return listeners.get(el)?.abort();
      updatePeeks();
      stickHeads();
    });
  }

  /** Donne le focus à un élément de colonne et en fait l'arrêt de tabulation de cette colonne. */
  function focusItem(item, focus = true) {
    const col = item.closest('.kcol');
    for (const c of col.querySelectorAll(ITEMS)) {
      c.tabIndex = c === item ? 0 : -1;
      // Consignes annoncées à l'entrée dans la colonne, pas à chaque flèche
      if (c !== item) c.removeAttribute('aria-describedby');
    }
    st.active.set(col.dataset.col, item.id);
    if (focus) item.focus();
  }

  el.onchange = (e) => {
    const f = e.target.closest('[data-field]')?.dataset.field;
    if (f === 'kanban-group' && GROUPS.includes(e.target.value)) {
      st.group = e.target.value;
      ctx.setPrefs?.({ kanbanGroup: st.group });
    } else if (f === 'kanban-sort' && SORTS.includes(e.target.value)) {
      st.sort = e.target.value;
      ctx.setPrefs?.({ kanbanSort: st.sort });
    } else return;
    paint();
  };
  el.onclick = (e) => {
    const t = e.target.closest('[data-toggle]');
    if (t) {
      const k = t.dataset.toggle;
      const empty = t.dataset.empty === 'true';
      st.collapsed = toggleColumn(st.collapsed, k, empty);
      st.active.set(k, t.id); // le focus reste sur le bouton, qui reste l'arrêt de tabulation de la colonne
      ctx.setPrefs?.({ kanbanCollapsed: [...st.collapsed] });
      return paint();
    }
    const m = e.target.closest('[data-more]');
    if (m) {
      const k = m.dataset.more;
      const before = st.limits.get(k) ?? PAGE;
      st.limits.set(k, before + PAGE);
      paint();
      // Le focus passe à la première carte ajoutée (le bouton peut avoir disparu)
      const added = el.querySelector(`.kcol[data-col="${CSS.escape(k)}"]`)?.querySelectorAll('.kcard')[before];
      if (added) focusItem(added);
      return;
    }
    const peek = e.target.closest('[data-peek]');
    if (peek) {
      const { board, left, right } = hiddenColumns();
      const b = board.getBoundingClientRect();
      const pad = 16;
      const dx = peek.dataset.peek === 'right' ? right[0].r.right - b.right + pad : left.at(-1).r.left - b.left - pad;
      const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      board.scrollBy({ left: dx, behavior: smooth ? 'smooth' : 'auto' });
      return;
    }
    const q = e.target.closest('[data-qs-open]');
    if (q) return void openActions(q);
    const c = e.target.closest('[data-task]');
    if (c) ctx.openDetail({ table: 'Tasks', id: Number(c.dataset.task) });
  };
  el.onkeydown = (e) => {
    const card = e.target.closest?.('.kcard[data-qs-focus]');
    if (card && el.contains(card) && cardShortcut(e, card)) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const item = e.target.closest?.(ITEMS);
    if (!item || !el.contains(item)) return;
    if (e.key === 'Escape' && item.matches('.kcard')) {
      item.classList.add('kcard--tipoff'); // ferme l'infobulle des personnes (WCAG 1.4.13)
      return;
    }
    const cols = [...el.querySelectorAll('.kcol')];
    const lists = cols.map((c) => [...c.querySelectorAll(ITEMS)]);
    const col = cols.indexOf(item.closest('.kcol'));
    const next = rovingMove(
      lists.map((l) => l.length),
      { col, row: lists[col].indexOf(item) },
      e.key,
    );
    if (!next) return;
    e.preventDefault();
    focusItem(lists[next.col][next.row]);
  };

  listeners.get(el)?.abort();
  const off = new AbortController();
  listeners.set(el, off);
  window.addEventListener('scroll', layout, { passive: true, signal: off.signal });
  // Défilement du plateau rendu après un rendu complet (main.js) : indices et en-têtes recalculés tout de suite
  el.addEventListener(
    'scroll-restored',
    () => {
      updatePeeks();
      stickHeads();
    },
    { signal: off.signal },
  );
  window.addEventListener('resize', layout, { passive: true, signal: off.signal });
  el.addEventListener('scroll', (e) => e.target.matches?.('.kanban__board') && layout(), {
    capture: true,
    passive: true,
    signal: off.signal,
  });
  el.addEventListener('focusin', (e) => e.target.classList?.remove('kcard--tipoff'), { signal: off.signal });
  // Clic droit (ou Maj+F10 relâché) sur une carte modifiable ou son ⋯ : menu ⋯, la carte en est le retour. Pendant
  // un glisser ou au doigt (appui long qui saisit la carte) : ni ce menu ni celui du navigateur
  el.addEventListener(
    'contextmenu',
    (e) => {
      if (memory.gesture || e.pointerType === 'touch') return void e.preventDefault();
      statusContextMenu(
        e,
        (t) => (ctx.drop ? t.closest('.kcard-item')?.querySelector('[data-qs-open]') : null),
        (q) => openActions(q),
      );
    },
    { signal: off.signal },
  );

  /** Menu ⋯ d'une carte : la carte devient l'entrée de sa colonne, le focus y revient ensuite. */
  function openActions(q) {
    const card = q.parentElement.querySelector('.kcard');
    if (card) focusItem(card, false);
    ctx.drop?.openActions(q, Number(q.dataset.qsOpen), card ?? q);
  }

  /** Raccourcis d'une carte modifiable : Maj+F10 ou Menu (menu ⋯), S (statut), P (priorité). Vrai si traité. */
  function cardShortcut(e, card) {
    const q = card.parentElement.querySelector('[data-qs-open]');
    const id = Number(card.dataset.qsFocus);
    const keys = (card.getAttribute('aria-keyshortcuts') ?? '').split(' ');
    let open = null;
    if (isMenuShortcut(e)) open = () => openActions(q);
    else if (isStatusShortcut(e) && keys.includes('S')) open = () => ctx.quickStatus?.open(q, id, card);
    else if (isPriorityShortcut(e) && keys.includes('P')) open = () => ctx.drop?.openPriority(q, id, card);
    if (!open || !q || memory.gesture) return false;
    e.preventDefault();
    open();
    return true;
  }

  // ---------- Glisser une carte (lot C) ----------
  // Rien n'est redessiné pendant le geste : fantôme (sur <body>) déplacé par transform, classes posées une fois sur
  // les colonnes au début, colonne visée lue par elementFromPoint. Un rendu complet (relecture) rattache le geste.

  const colKey = (col) => col.dataset.col.slice(st.group.length + 1);

  /** Classes du geste posées sur les colonnes et la carte d'origine (début du geste, ou après un rendu). */
  function markBoard(g) {
    for (const col of el.querySelectorAll('.kcol')) {
      const key = colKey(col);
      const v = g.targets.get(key);
      if (key === g.fromKey) col.classList.add('kcol--origin');
      else if (v?.ok) col.classList.add('kcol--target');
      else {
        col.classList.add('kcol--refused');
        // Raison affichée sur la colonne pendant le geste (une infobulle title ne s'affiche pas sous la capture)
        col.dataset.dropReason = label('kanban.drop.ghostRefused', {
          raison: label(`kanban.drop.no.${v?.reason ?? 'undeclared'}`),
        });
      }
    }
    el.querySelector(`#kc-${g.taskId}`)?.classList.add('kcard--origin');
    el.querySelector('.kanban__board')?.classList.add('kanban__board--dragging');
    g.box = el.querySelector('.kanban__board')?.getBoundingClientRect() ?? null;
    g.over = undefined;
  }

  /** Classes du geste retirées (vue du geste, même si elle a été remplacée entre-temps). */
  function unmarkBoard(view) {
    for (const col of view.querySelectorAll('.kcol--target, .kcol--refused, .kcol--origin, .kcol--over')) {
      col.classList.remove('kcol--target', 'kcol--refused', 'kcol--origin', 'kcol--over');
      delete col.dataset.dropReason;
    }
    view.querySelector('.kcard--origin')?.classList.remove('kcard--origin');
    view.querySelector('.kanban__board--dragging')?.classList.remove('kanban__board--dragging');
  }

  /** Fantôme : copie du contenu de la carte, de sa largeur, posée sur <body> (un rendu de la vue ne l'efface pas). */
  function makeGhost(card, r) {
    const ghost = document.createElement('div');
    ghost.className = 'kghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.width = `${Math.round(r.width)}px`;
    const inner = document.createElement('div');
    inner.className = 'kcard kghost__card';
    inner.innerHTML = card.innerHTML; // contenu déjà échappé de la carte, sans identifiant
    const note = document.createElement('p');
    note.className = 'kghost__note';
    note.hidden = true;
    ghost.append(inner, note);
    document.body.append(ghost);
    return ghost;
  }

  function placeGhost(g) {
    g.ghost.style.transform = `translate(${Math.round(g.lastX - g.offX)}px, ${Math.round(g.lastY - g.offY)}px)`;
  }

  /** Colonne sous le pointeur : contour « visée », raison du refus sur le fantôme, annonce si elle change. */
  function updateOver(g) {
    const hit = document.elementFromPoint(g.lastX, g.lastY)?.closest?.('.kcol');
    const col = hit && el.contains(hit) ? hit : null;
    const key = col ? colKey(col) : null;
    if (key === g.over) return;
    el.querySelector('.kcol--over')?.classList.remove('kcol--over');
    col?.classList.add('kcol--over');
    g.over = key;
    const v = key === null || key === g.fromKey ? null : g.targets.get(key);
    const note = g.ghost.querySelector('.kghost__note');
    const reason = v && !v.ok ? label(`kanban.drop.no.${v.reason}`) : '';
    note.hidden = !reason;
    note.textContent = reason ? label('kanban.drop.ghostRefused', { raison: reason }) : '';
    g.ghost.classList.toggle('kghost--refused', Boolean(reason));
    document.documentElement.classList.toggle('is-drop-refused', Boolean(reason));
    if (!v) return;
    const colonne = columnName(g.group, key);
    announce(
      v.ok ? label('kanban.drop.over', { colonne }) : label('kanban.drop.overRefused', { colonne, raison: reason }),
    );
  }

  /** Fin du geste (dépôt, annulation, erreur) : plus de geste en mémoire, fantôme et classes retirés. */
  function stopGesture() {
    const g = memory.gesture;
    memory.gesture = null;
    if (!g) return null;
    g.ghost?.remove();
    unmarkBoard(g.view);
    document.documentElement.classList.remove('is-card-grabbing', 'is-drop-refused');
    return g;
  }

  /** Geste interrompu (vue retirée, carte perdue, édition fermée) : annulé, message s'il y a lieu. */
  function abortGesture(why, notice) {
    const g = stopGesture();
    g?.handle?.cancel(why);
    if (notice) (ctx.notify ?? announce)(notice);
  }

  /** Une erreur pendant le geste ne laisse jamais un geste en mémoire : il est annulé, la vue reste utilisable. */
  function guard(run) {
    try {
      return run();
    } catch (err) {
      abortGesture('error');
      console.error(err);
      return undefined;
    }
  }

  /**
   * Geste en cours au moment d'un rendu (relecture) : rattaché à la carte du même identifiant, colonnes relues ;
   * carte disparue, déplacée ailleurs ou édition fermée → annulé avec un message.
   */
  function resumeGesture(g, cols) {
    if (!ctx.drop) return abortGesture('edit', label('kanban.drop.off'));
    const now = cols.find((c) => c.tasks.includes(g.taskId));
    if (st.group !== g.group || (now && now.key !== g.fromKey))
      return abortGesture('changed', label('kanban.drop.changed'));
    if (!now || !el.querySelector(`#kc-${g.taskId}`)) return abortGesture('gone', label('kanban.drop.gone'));
    guard(() => {
      if (g.view !== el) unmarkBoard(g.view);
      g.view = el;
      g.targets = ctx.drop.targets(g.taskId, g.group, cols);
      markBoard(g);
      updateOver(g);
    });
  }

  /** Dépôt dans une colonne permise : carte à sa nouvelle place, « Enregistrement… », puis réponse. */
  function commit(g, key) {
    const card = el.querySelector(`#kc-${g.taskId}`);
    const r = dropChanges(ctx.model, g.taskId, g.group, key, ctx.today);
    const saving = { taskId: g.taskId, group: g.group, changes: r.changes ?? {} };
    memory.saving = saving;
    let pending;
    try {
      // Appel d'abord : les voisines de la carte (repli du focus) sont lues sur le rendu d'avant
      pending = Promise.resolve(ctx.drop.drop(g.taskId, g.group, key, card));
      paint();
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending
      .catch((err) => console.error(err))
      .finally(() => {
        // Échec, refus, mode essai sans correction : la carte revient (seul cas où la réponse redessine)
        if (memory.saving !== saving) return;
        memory.saving = null;
        memory.view?.repaint();
      });
  }

  const view = {
    begin(taskId, down, m, handle) {
      if (!ctx.drop || memory.gesture || memory.saving || !el.isConnected) return false;
      const card = el.querySelector(`#kc-${taskId}[data-drag-card]`);
      if (!card) return false;
      let g = null;
      try {
        const targets = ctx.drop.targets(taskId, st.group, shownCols);
        if (![...targets.values()].some((v) => v.ok)) return false;
        const r = card.getBoundingClientRect(); // une lecture, au début du geste
        const first = el.querySelector('.kcol');
        const gap = parseFloat(getComputedStyle(el.querySelector('.kanban__board')).columnGap) || 0;
        const task = ctx.model.tasks.get(taskId);
        g = {
          taskId,
          group: st.group,
          fromKey: colKey(card.closest('.kcol')),
          title: task?.title || label('common.untitled'),
          targets,
          handle,
          view: el,
          offX: down.clientX - r.left,
          offY: down.clientY - r.top,
          lastX: m.clientX,
          lastY: m.clientY,
          step: (first?.getBoundingClientRect().width ?? 300) + gap,
          ghost: makeGhost(card, r),
          box: null,
          over: undefined,
        };
        markBoard(g);
        placeGhost(g);
        memory.gesture = g;
        updateOver(g);
      } catch (err) {
        g?.ghost?.remove();
        if (g) unmarkBoard(el);
        memory.gesture = null;
        console.error(err);
        return false;
      }
      el.querySelector('.kcard--armed')?.classList.remove('kcard--armed');
      document.documentElement.classList.add('is-card-grabbing');
      const colonnes = [...g.targets]
        .filter(([, v]) => v.ok)
        .map(([k]) => columnName(g.group, k))
        .join(', ');
      announce(label('kanban.drop.grab', { titre: g.title, colonnes }));
      return true;
    },
    move(m) {
      if (memory.gesture && !el.isConnected) return void abortGesture('gone');
      guard(() => {
        const g = memory.gesture;
        if (!g) return;
        g.lastX = m.clientX;
        g.lastY = m.clientY;
        placeGhost(g);
        updateOver(g);
      });
    },
    edge(side) {
      const board = el.querySelector('.kanban__board');
      if (memory.gesture && (!el.isConnected || !board)) return void abortGesture('gone');
      guard(() => {
        const g = memory.gesture;
        if (!g) return;
        board.scrollLeft += side * g.step;
        updateOver(g);
      });
    },
    drop(m) {
      if (memory.gesture && !el.isConnected) return void abortGesture('gone');
      const g = guard(() => {
        const cur = memory.gesture;
        if (!cur) return null;
        cur.lastX = m.clientX;
        cur.lastY = m.clientY;
        updateOver(cur);
        return stopGesture();
      });
      if (!g) return;
      const key = g.over;
      // Hors du plateau ou dans sa colonne : rien, sans message
      if (key === null || key === undefined || key === g.fromKey) return void announce(label('kanban.drop.cancel'));
      if (g.targets.get(key)?.ok) return commit(g, key);
      // Colonne refusée : la raison est dite (ctx.drop.drop n'écrit rien)
      ctx.drop?.drop(g.taskId, g.group, key, el.querySelector(`#kc-${g.taskId}`));
    },
    cancel(why) {
      if (stopGesture() && why === 'escape') announce(label('kanban.drop.cancel'));
    },
    repaint() {
      if (el.isConnected) paint();
    },
    /** Appui long du doigt atteint : la carte paraît saisie jusqu'au relâcher ou au début du glisser. */
    arm(taskId) {
      const card = el.querySelector(`#kc-${taskId}`);
      if (!card) return;
      card.classList.add('kcard--armed');
      const task = ctx.model.tasks.get(taskId);
      announce(label('kanban.drop.armed', { titre: task?.title || label('common.untitled') }));
      const off = new AbortController();
      const clear = () => {
        card.classList.remove('kcard--armed');
        off.abort();
      };
      for (const type of ['pointerup', 'pointercancel'])
        window.addEventListener(type, clear, { capture: true, signal: off.signal });
    },
  };
  memory.view = view;

  /** Appui sur une carte glissable : le contrôleur commun suit le geste (souris, stylet, doigt après appui long). */
  function startCardDrag(e, card) {
    if (!ctx.drop || memory.gesture || memory.saving) return;
    const taskId = Number(card.dataset.task);
    let handle = null;
    handle = trackPointer(e, {
      // Doigt : l'appui long saisit la carte (contour, annonce) ; relâchée sans glisser, elle n'ouvre pas la fiche
      onArm: () => memory.view?.arm(taskId),
      onStart: (m) => memory.view?.begin(taskId, e, m, handle) ?? false,
      onMove: (m) => memory.view?.move(m),
      onDrop: (m) => memory.view?.drop(m),
      onCancel: (why) => memory.view?.cancel(why),
      onEdge: (side) => memory.view?.edge(side),
      edgeBox: () => memory.gesture?.box ?? null,
    });
  }
  el.onpointerdown = (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const card = e.target.closest?.('.kcard[data-drag-card]');
    if (card && el.contains(card)) startCardDrag(e, card);
  };

  paint();
}
