/**
 * Démarrage du widget : Grist (lecture) → modèle → filtres → vue active ; édition (lot 2a) seulement si
 * l'interrupteur de la page l'ouvre (edit-switch.js), et toujours par le writer (grist-writer.js).
 * Aucune variable globale ; le seul objet global lu est `grist` (grist-plugin-api.js).
 */
import { accessRefused, createGateway } from './core/grist-gateway.js';
import {
  flagsAllowEdition,
  flagsUrl,
  readEditMode,
  readTimeout,
  resolveEditState,
  writerMode,
} from './core/edit-switch.js';
import { FLAGS_FILE } from './config.js';
import { applyToTables, createWriter, decodeRow } from './core/grist-writer.js';
import { editAvailability, taskInScope } from './core/task-form.js';
import { chantierInScope } from './core/chantier-form.js';
import { parisToday } from './core/write-encode.js';
import { buildModel } from './core/model.js';
import { applyFilters, choosePerson, DEFAULT_FILTERS, loadPrefs, savePrefs, validFilters } from './core/filters.js';
import { dayInZone, monthKey, monthsFrom } from './core/dates.js';
import { openingView, sanitizeHomeView } from './core/home-view.js';
import { label } from './labels.js';
import { createChrome } from './ui/chrome.js';
import { TABS, THEMES } from './ui/kit.js';
import { emptyFiltersHtml, emptyPeopleHtml, screenHtml, skeletonHtml, viewErrorHtml } from './ui/states.js';
import * as placeholder from './views/placeholder.js';
import * as mytasks from './views/my-tasks.js';
import * as kanban from './views/kanban.js';
import * as table from './views/table.js';
import * as gantt from './views/gantt.js';
import * as portfolio from './views/portfolio.js';
import * as stats from './views/stats.js';
import * as synthesis from './views/synthesis.js';
import * as team from './views/team.js';
import { detailContent, detailExists, detailTitle } from './views/detail.js';
import { editPanelHtml } from './ui/edit-panel.js';
import { createTaskEditor } from './ui/task-editor.js';
import { closeStatusPopover, openStatusPopover, statusPopoverKey } from './ui/status-popover.js';
import { canQuickStatus, focusOrder, statusMenuItems } from './core/quick-status.js';
import { createCreateDialog } from './ui/create-dialog.js';
import { prefillFromFilters } from './core/create-form.js';
import { createToast } from './ui/toast.js';
import { createPersonDialog } from './ui/person-dialog.js';
import { isdDomainValue, personInScope, teamValuesInScope } from './core/person-form.js';
import { failureKind, runSetActive } from './core/task-session.js';
import { refusedText } from './views/task-form.js';

/** Vues par onglet ; chaque vue exporte `id` et `render(el, ctx)`. Factices jusqu'aux tâches suivantes. */
export const VIEWS = Object.freeze({
  ...Object.fromEntries(TABS.map((id) => [id, placeholder])),
  mytasks,
  kanban,
  table,
  gantt,
  portfolio,
  stats,
  synthesis,
  team,
});

/** Onglets sur lesquels les filtres globaux ne s'appliquent pas (ils y sont masqués). */
const UNFILTERED_VIEWS = new Set(['mytasks', 'team']);

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'),
  header: $('app-header'),
  alerts: $('app-alerts'),
  tabs: $('app-tabs'),
  filters: $('app-filters'),
  main: $('app-main'),
  detail: $('app-detail'),
};

/** Stockage local protégé : navigation privée ou stockage bloqué ne doivent rien casser. */
function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => {} };
  }
}
const storage = safeStorage();

/** Préférences au démarrage : l'onglet ouvert est la vue d'accueil (P-UX-2), sinon la dernière vue. */
function initialPrefs() {
  const p = loadPrefs(storage);
  const homeView = sanitizeHomeView(p.homeView, p.me, TABS);
  return {
    ...p,
    filters: { ...DEFAULT_FILTERS, ...p.filters },
    homeView,
    view: openingView({ homeView, view: p.view }, TABS),
    theme: THEMES.includes(p.theme) ? p.theme : 'auto',
  };
}

/** Jour courant à Paris (fuseau de l'équipe), au format des jours du modèle. */
function todayDay() {
  return dayInZone(new Date());
}

const state = { model: null, raw: null, problems: [], prefs: initialPrefs(), loaded: false };

/** Édition : coupée par défaut ; ouverte seulement par l'adresse de la page (edition=, doc=) et flags.json. */
const editRequest = readEditMode(window.location.search);
let editState = { mode: 'off', canEdit: false, reason: 'off' };
let writer = null;
let editSetup = null;
/** Délai maximal des requêtes d'édition (10 s ; ?delai= peut seulement le raccourcir, pour les essais). */
const timeoutMs = readTimeout(window.location.search);

const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;

/** Thème DSFR : data-fr-scheme (choix) et data-fr-theme (rendu) ; « auto » suit le système. */
function applyTheme(theme) {
  const root = document.documentElement;
  const dark = theme === 'dark' || (theme === 'auto' && darkQuery?.matches === true);
  root.setAttribute('data-fr-scheme', theme === 'auto' ? 'system' : theme);
  root.setAttribute('data-fr-theme', dark ? 'dark' : 'light');
}
darkQuery?.addEventListener('change', () => {
  applyTheme(state.prefs.theme);
  chrome.syncTheme(state.prefs.theme);
});

function persist() {
  savePrefs(storage, state.prefs);
}

// ---------- Contexte des vues ----------
/** Fiches ouvertes depuis la fiche courante (bouton « Retour ») ; vidée à chaque ouverture depuis une vue. */
const detailHistory = [];
let detailCurrent = null;

/** Créations permises (boutons « Nouvelle tâche », « Nouveau chantier », « + Sous-tâche ») ? */
function canCreate(table) {
  return Boolean(editState.canEdit && writer?.canAdd(table).ok);
}

/** Actions permises sur une personne (fiche) : actif, indisponibilités (création, modification). */
function personRights() {
  const ok = (t, c) => Boolean(editState.canEdit && writer?.can(t, c).ok);
  return {
    canActive: ok('Team', 'actif'),
    canUnavAdd: canCreate('Disponibilites'),
    canUnavEdit: ok('Disponibilites', 'dateDebut'),
  };
}

function showDetail(ref) {
  detailCurrent = ref;
  const edit = editAvailability(state.model, ref, editState);
  const c = detailContent(state.model, ref, todayDay(), {
    edit,
    canCreate: canCreate('Tasks'),
    person: ref.table === 'Team' ? personRights() : undefined,
  });
  const prev = detailHistory.at(-1);
  const backTitle = prev ? detailTitle(state.model, prev) : '';
  chrome.openDetail(c.kind, c.title, c.body, { backTitle });
}

/** Ouvre la fiche d'un élément depuis une vue. */
function openDetail(ref) {
  detailHistory.length = 0;
  showDetail(ref);
}

/** Lien interne de la fiche (sous-tâche, dépendance, fil d'Ariane) : la fiche courante devient « Retour ». */
function openDetailFromDetail(ref) {
  if (detailCurrent) detailHistory.push(detailCurrent);
  showDetail(ref);
}

/** Après relecture des données : la fiche ouverte est redessinée, ou fermée si l'élément a disparu. */
function refreshDetail() {
  if (!chrome.isDetailOpen() || !detailCurrent) return;
  if (editor.isEditing()) return editor.notifyReload();
  if (detailExists(state.model, detailCurrent)) showDetail(detailCurrent);
  else {
    detailHistory.length = 0;
    detailCurrent = null;
    chrome.closeDetail();
  }
}

function detailBack() {
  const prev = detailHistory.pop();
  if (prev) showDetail(prev);
}

function setFilters(partial) {
  const merged = { ...state.prefs.filters, ...partial };
  // Cascade : le projet dépend de la catégorie, le chantier du projet (sinon de la catégorie)
  const f = state.model ? validFilters(state.model, merged) : merged;
  if ('search' in partial) chrome.syncSearch(f.search);
  state.prefs = { ...state.prefs, filters: f };
  persist();
  renderFiltersAndView();
}

/** Préférences d'une vue (ex. colonnes repliées) : enregistrées sans redessiner, la vue se met à jour elle-même. */
function setPrefs(partial) {
  state.prefs = { ...state.prefs, ...partial };
  persist();
}

/** « Choisir qui je suis » (état vide de Mes tâches) : rouvre l'invite « Qui êtes-vous ? » sous « Je suis… ». */
function askMe() {
  state.prefs = { ...state.prefs, mePrompted: false };
  chrome.renderHeader(state.model, state.prefs);
}

function buildCtx(view) {
  const today = todayDay();
  return {
    model: state.model,
    view,
    prefs: state.prefs,
    label,
    openDetail,
    setFilters,
    setPrefs,
    askMe,
    months: monthsFrom(monthKey(today), 24),
    today,
    team: teamCtx(),
    quickStatus: quickStatusCtx(),
    reveal: viewFocus?.reveal ?? null,
  };
}

// ---------- Statut depuis la carte et la ligne (P-UX-6) ----------
/**
 * Élément à refocaliser après un changement de statut fait depuis une vue : clés data-qs-focus par ordre de
 * préférence (la tâche, puis ses voisines), tâche à garder visible malgré la pagination. Gardé jusqu'à la fin de
 * la relecture qui suit un envoi réel (deux rendus), puis oublié.
 */
let viewFocus = null;
/** Dernier changement de statut fait depuis une vue : « Annuler » y ramène le focus. */
let lastQuick = null;

/** Contrôle de statut des vues : null en lecture seule (rien n'est affiché), sinon droit par tâche et ouverture. */
function quickStatusCtx() {
  const m = state.model;
  if (!m || !writer || writer.mode === 'off' || !editState.canEdit) return null;
  return { can: (id) => canQuickStatus(m, id, editState, writer), open: openQuickStatus };
}

/**
 * Ouvre le menu de statut d'une tâche depuis une vue.
 * @param {HTMLElement} anchor contrôle visible (bouton ⋯, cellule, statut de la ligne)
 * @param {number} taskId
 * @param {HTMLElement} [focusEl] élément focalisé à la fermeture et après le changement (data-qs-focus)
 */
function openQuickStatus(anchor, taskId, focusEl = anchor) {
  const m = state.model;
  const t = m?.tasks.get(taskId);
  if (!t || !canQuickStatus(m, taskId, editState, writer)) return;
  openStatusPopover({
    anchor,
    returnFocus: focusEl,
    title: t.title || label('common.untitled'),
    items: statusMenuItems(m.statuses?.tasks ?? [], t.status),
    onPick: (status) => changeStatusFromView(taskId, status, focusEl),
  });
}

/** Garde un élément à refocaliser pendant une écriture (et la relecture qui la suit). */
async function withViewFocus(focus, run) {
  const prev = viewFocus;
  focus.expires = Date.now() + 30000; // garde-fou : jamais retenu au-delà d'une relecture lente
  viewFocus = focus;
  let out;
  try {
    out = await run();
  } finally {
    if (viewFocus === focus) {
      if (out === 'busy') viewFocus = prev;
      else if (loading) focus.untilReload = true;
      else viewFocus = null;
    }
  }
  return out;
}

/** Changement choisi dans le menu : statut rapide de la fiche (relecture, clôture, refus, mode essai). */
async function changeStatusFromView(taskId, status, focusEl) {
  const list = focusEl.closest('ul, tbody');
  const keys = list ? [...list.querySelectorAll('[data-qs-focus]')].map((x) => x.dataset.qsFocus) : [];
  const focus = { keys: focusOrder(keys, String(taskId)), reveal: taskId, untilReload: false };
  const kind = await withViewFocus(focus, () => editor.quickStatus({ table: 'Tasks', id: taskId }, status));
  // Autre envoi en cours (statut rapide ou formulaire) : le choix n'est pas perdu en silence
  if (kind === 'busy') toast.show(label('quickStatus.busy'), { tone: 'error' });
  lastQuick = kind === 'saved' ? { entry: writer?.lastUndoable() ?? null, keys: [String(taskId)], taskId } : lastQuick;
}

const qsSelector = (k) => `[data-qs-focus="${CSS.escape(k)}"]`;

/**
 * Sélecteur stable de l'élément focalisé dans la vue (carte, bouton de statut, titre d'une ligne…), pour le
 * retrouver après un rendu complet ; null si le focus n'est pas dans la vue.
 */
function focusedSelector() {
  const a = document.activeElement;
  if (!a || !$('view-panel')?.contains(a)) return null;
  if (a.dataset.qsFocus) return qsSelector(a.dataset.qsFocus);
  if (a.id) return `#${CSS.escape(a.id)}`;
  for (const [k, attr] of [
    ['qsOpen', 'data-qs-open'],
    ['task', 'data-task'],
    ['open', 'data-open'],
  ])
    if (a.dataset[k]) return `[${attr}="${CSS.escape(a.dataset[k])}"]`;
  return null;
}

/**
 * Après un rendu : focus rendu au premier élément trouvé parmi les sélecteurs, seulement s'il est tombé sur
 * <body> (jamais pris à un autre élément) ; sinon au panneau de la vue. Le défilement restauré n'est pas déplacé,
 * sauf si l'élément est hors de l'écran (carte passée dans une colonne hors champ).
 */
function restoreViewFocus(selectors) {
  const a = document.activeElement;
  if (!selectors?.length || (a && a !== document.body)) return;
  const panel = $('view-panel');
  for (const sel of selectors) {
    const target = panel?.querySelector(sel);
    if (!target) continue;
    target.focus({ preventScroll: true });
    const r = target.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > vw)
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  panel?.focus({ preventScroll: true });
}

/**
 * Élément à refocaliser après un rendu complet, par ordre de préférence : la tâche dont le statut vient de changer
 * (puis ses voisines) si le focus est encore sur elle ou est tombé sur <body> ; sinon l'élément de la vue que
 * l'utilisateur a focalisé depuis ; rien si le focus est hors de la vue (message « Annuler », en-tête).
 */
function focusTargets() {
  const a = document.activeElement;
  const inView = Boolean(a && $('view-panel')?.contains(a));
  const own = viewFocus && (!a || a === document.body || (inView && a.dataset.qsFocus === viewFocus.keys[0]));
  if (own) return viewFocus.keys.map(qsSelector);
  const sel = focusedSelector();
  return sel ? [sel] : null;
}

/** Défilements de la page et des zones qui défilent en largeur (plateau du Kanban, Tableau). */
const SCROLLERS = ['.kanban__board', '.tbl__table .fr-table__wrapper', '.tbl__table .fr-table__container'];
function captureScroll() {
  const panel = $('view-panel');
  return {
    view: state.prefs.view,
    x: window.scrollX,
    y: window.scrollY,
    inner: SCROLLERS.map((sel) => {
      const e = panel?.querySelector(sel);
      return e ? { left: e.scrollLeft, top: e.scrollTop } : null;
    }),
  };
}
function restoreScroll(saved) {
  if (saved.view !== state.prefs.view) return;
  const panel = $('view-panel');
  SCROLLERS.forEach((sel, i) => {
    const e = saved.inner[i] && panel?.querySelector(sel);
    if (e) {
      e.scrollLeft = saved.inner[i].left;
      e.scrollTop = saved.inner[i].top;
    }
  });
  window.scrollTo(saved.x, saved.y);
}

/** Onglet Équipe (lot 2d) : « Ajouter une personne » et « Réactiver », selon l'édition et les droits. */
function teamCtx() {
  const m = state.model;
  const editing = Boolean(editState.canEdit && writer && writer.mode !== 'off');
  return {
    editing,
    canAdd: editing && canCreate('Team') && isdDomainValue(m) !== null,
    canReactivate: (id) => editing && writer.can('Team', 'actif').ok && personInScope(m, m.people.get(id)),
    add: () => personDialog.open('add'),
    reactivate: (id) => setPersonActive(id, true),
  };
}

// ---------- Rendu ----------
function renderView() {
  // Menu de statut ouvert pendant un rendu (relecture, onglet, filtre) : fermé, focus rendu à son déclencheur
  const openKey = statusPopoverKey();
  closeStatusPopover(false);
  const m = state.model;
  const view = applyFilters(m, state.prefs.filters, state.prefs);
  // Onglet Équipe : annuaire hors filtres (barre de filtres, étiquettes et recherche globale masquées en CSS)
  const unfiltered = UNFILTERED_VIEWS.has(state.prefs.view);
  el.app.dataset.view = state.prefs.view;
  chrome.renderTabs(state.prefs.view, unfiltered ? null : view.taskIds.size, {
    task: canCreate('Tasks'),
    chantier: canCreate('Chantiers'),
  });
  el.main.innerHTML = '<div id="view-panel" class="view-panel" role="tabpanel" tabindex="0"></div>';
  const panel = $('view-panel');
  panel.setAttribute('aria-labelledby', `tab-${state.prefs.view}`);
  panel.dataset.view = state.prefs.view;
  if (![...m.people.values()].some((p) => p.isd)) {
    panel.innerHTML = emptyPeopleHtml();
    return;
  }
  if (view.taskIds.size === 0 && !unfiltered) {
    panel.innerHTML = emptyFiltersHtml();
    return;
  }
  const v = VIEWS[state.prefs.view];
  const container = document.createElement('div');
  container.className = `view view--${state.prefs.view}`;
  panel.append(container);
  try {
    v.render(container, buildCtx(view));
  } catch (err) {
    panel.innerHTML = viewErrorHtml(err?.message ?? String(err));
  }
  if (openKey) restoreViewFocus([qsSelector(openKey)]);
}

function renderFiltersAndView() {
  chrome.renderFilters(state.model, state.prefs);
  renderView();
}

function editInfo() {
  return { ...editState, count: writer?.journal().length ?? 0 };
}

/** Panneau d'édition de l'en-tête (journal, « Annuler la dernière modification »), rempli à l'ouverture. */
function fillEditPanel() {
  const panel = document.getElementById('edit-panel');
  if (panel && writer)
    panel.innerHTML = editPanelHtml(
      state.model,
      writer.journal(),
      writer.mode,
      Boolean(writer.lastUndoable()) && !writer.isBlocked(),
    ).toString();
}

/**
 * Tout redessiner (après une écriture, une annulation ou une relecture) : la page garde son défilement, et le
 * focus revient à l'élément retenu (changement de statut depuis une vue) ou au contrôle dont le menu était ouvert.
 */
function renderAll() {
  const scroll = captureScroll();
  if (viewFocus && viewFocus.expires < Date.now()) viewFocus = null;
  const targets = focusTargets();
  el.app.removeAttribute('aria-busy');
  chrome.renderHeader(state.model, state.prefs, editInfo());
  fillEditPanel();
  chrome.renderAlerts(state.problems);
  renderFiltersAndView();
  restoreScroll(scroll);
  restoreViewFocus(targets);
}

function renderScreen(kind, vars) {
  el.app.removeAttribute('aria-busy');
  for (const k of ['header', 'alerts', 'tabs', 'filters']) el[k].innerHTML = '';
  el.main.innerHTML = screenHtml(kind, vars);
}

function renderLoading() {
  el.tabs.innerHTML = '';
  el.main.innerHTML = skeletonHtml();
}

/** Efface tous les filtres, y compris une recherche encore en attente (anti-rebond). */
function clearFilters() {
  chrome.cancelSearch();
  setFilters({ ...DEFAULT_FILTERS });
}

const chrome = createChrome(el, {
  onFilters: setFilters,
  onClearFilters: clearFilters,
  onMe(id) {
    // Périmètre du profil posé au premier choix ; il suit ensuite la personne choisie. Tout premier choix : vue
    // d'accueil du profil enregistrée et ouverte.
    state.prefs = choosePerson(state.prefs, id, state.model?.people.get(id) ?? null);
    persist();
    chrome.syncMe(state.prefs.me);
    chrome.syncHome(state.prefs.homeView);
    renderFiltersAndView();
  },
  onHome(value) {
    state.prefs = { ...state.prefs, homeView: value };
    persist();
  },
  onMeSkip() {
    state.prefs = { ...state.prefs, mePrompted: true };
    persist();
    chrome.syncMe(state.prefs.me);
  },
  onTheme(theme) {
    state.prefs = { ...state.prefs, theme };
    applyTheme(theme);
    chrome.syncTheme(theme);
    persist();
  },
  onHidden(ids) {
    state.prefs = { ...state.prefs, hiddenProjects: ids };
    persist();
    renderFiltersAndView();
  },
  onView(id) {
    if (!TABS.includes(id) || id === state.prefs.view) return;
    state.prefs = { ...state.prefs, view: id };
    persist();
    renderView();
  },
  onRefresh: () => reload(),
  // Un formulaire modifié demande Enregistrer / Abandonner / Continuer avant de quitter la fiche
  onCloseDetail: () => editor.requestLeave(() => chrome.closeDetail()),
  onDetailRef: (ref) => editor.requestLeave(() => openDetailFromDetail(ref)),
  onDetailBack: () => editor.requestLeave(detailBack),
  onEditPanel() {
    fillEditPanel();
    chrome.togglePopover('edit');
  },
  onUndo: () => undoLast(),
});

const toast = createToast();

/** Après une écriture (envoyée ou notée en mode essai) : modèle corrigé localement, puis relecture si envoyée. */
function onWritten(entry) {
  if (!entry || !state.raw) return;
  state.raw = { ...state.raw, tables: applyToTables(state.raw.tables, entry.applied ?? entry.actions) };
  state.model = buildModel(state.raw);
  renderAll();
  if (!editor.isEditing()) refreshDetail();
  // Mode essai : la correction locale vaut jusqu'à la prochaine relecture (rien n'a été envoyé)
  if (entry.sent) reload();
}

async function undoLast() {
  if (!writer) return;
  // « Annuler » d'un changement de statut fait depuis une vue : le focus revient à sa carte ou à sa ligne
  const quick = lastQuick && lastQuick.entry === writer.lastUndoable() ? lastQuick : null;
  lastQuick = null;
  try {
    const undo = () => writer.undoLast((table, id) => gateway.fetchRow(table, id));
    const r = quick
      ? await withViewFocus({ keys: quick.keys, reveal: quick.taskId, untilReload: false }, undo)
      : await undo();
    if (r.busy) return; // annulation déjà en cours
    if (!r.entry) return toast.show(label('toast.nothing'));
    if (r.undoEntry) onWritten(r.undoEntry);
    else renderAll();
    const names = r.skipped.map((c) => label(`form.field.${c}`)).join(', ');
    if (r.entry.kind === 'add')
      return toast.show(label(r.undoEntry ? 'toast.undoneAdd' : `toast.undoAdd.${r.reason ?? 'modifiee'}`));
    toast.show(
      !r.undoEntry
        ? label('toast.undoNone')
        : r.skipped.length
          ? label('toast.undonePartial', { champs: names })
          : label('toast.undone'),
    );
  } catch (err) {
    toast.show(label('toast.error', { message: err?.message ?? String(err) }), { tone: 'error' });
  }
}

const editor = createTaskEditor({
  root: el.detail,
  chrome,
  getModel: () => state.model,
  getBase: (table, id) => (state.raw?.tables[table] ? decodeRow(state.raw.tables[table], table, id) : null),
  getWriter: () => writer,
  fetchRow: (table, id) => gateway.fetchRow(table, id),
  readTable: (table) => gateway.fetchTableRaw(table),
  today: () => parisToday(),
  storage,
  toast,
  kindOf: (ref) => detailContent(state.model, ref, todayDay()).kind,
  titleOf: (ref) => detailTitle(state.model, ref),
  currentRef: () => detailCurrent,
  showRead: (ref) => showDetail(ref),
  onWritten,
  onUndo: () => undoLast(),
  onSessionReadOnly: sessionReadOnly,
  onUnknown: () => reload(),
  timeoutMs: () => timeoutMs,
  onCreate: (data) => openCreate(data),
  onMove: (ref) => createDialog.open('move', { taskId: ref.id }),
});

/** Ouvre le formulaire d'une ligne (après « Créer et ouvrir ») ; la fiche courante devient « Retour ». */
function openForm(ref) {
  editor.requestLeave(() => {
    if (chrome.isDetailOpen() && detailCurrent) detailHistory.push(detailCurrent);
    else detailHistory.length = 0;
    showDetail(ref);
    editor.open(ref);
  });
}

const createDialog = createCreateDialog({
  getModel: () => state.model,
  getWriter: () => writer,
  storage,
  toast,
  onWritten,
  onUndo: () => undoLast(),
  openForm,
  onSessionReadOnly: sessionReadOnly,
  // Changement de chantier ou sous-tâche créée depuis un formulaire : il suit les données, saisie conservée
  afterMove: () => (editor.isEditing() ? editor.refreshFromModel() : refreshDetail()),
  afterCreate: () => (editor.isEditing() ? editor.refreshFromModel() : refreshDetail()),
  fetchRow: (table, id) => gateway.fetchRow(table, id),
  readTable: (table) => gateway.fetchTableRaw(table),
  onUnknown: () => reload(),
  timeoutMs: () => timeoutMs,
  onAddRefused: () => {
    renderAll();
    if (!editor.isEditing()) refreshDetail();
  },
});

const personDialog = createPersonDialog({
  getModel: () => state.model,
  getWriter: () => writer,
  getBase: (table, id) => (state.raw?.tables[table] ? decodeRow(state.raw.tables[table], table, id) : null),
  toast,
  onWritten,
  onUndo: () => undoLast(),
  onSessionReadOnly: sessionReadOnly,
  // Personne ajoutée : sa fiche s'ouvre (« Modifier » pour compléter)
  afterCreate: (ref) => openDetail(ref),
  fetchRow: (table, id) => gateway.fetchRow(table, id),
  onUnknown: () => reload(),
  timeoutMs: () => timeoutMs,
  onAddRefused: () => {
    renderAll();
    if (!editor.isEditing()) refreshDetail();
  },
});

/** « Réactiver » (ligne de l'onglet Équipe ou fiche) : une seule colonne actif, ligne relue avant l'envoi. */
async function setPersonActive(id, actif) {
  if (!writer || !state.model) return;
  const nom = state.model.people.get(id)?.nom || label('common.untitled');
  const r = await runSetActive({
    writer,
    personId: id,
    actif,
    localBase: state.raw?.tables.Team ? decodeRow(state.raw.tables.Team, 'Team', id) : null,
    fetchRow: (x) => gateway.fetchRow('Team', x),
    timeoutMs,
  });
  if (r.kind === 'nothing') return refreshDetail();
  if (r.kind === 'saved') {
    onWritten(r.entry);
    const key = actif ? 'active.toast.on' : 'active.toast.off';
    return toast.show(label(r.entry.sent ? key : `${key}Dry`, { nom }), { onAction: () => undoLast() });
  }
  if (r.kind === 'unknown') {
    reload();
    return toast.show(label('toast.unknownPerson'), { tone: 'error' });
  }
  const kind = r.kind === 'failed' ? failureKind(r.error) : r.kind;
  if (kind === 'document') return sessionReadOnly('viewer');
  if (kind === 'refused:coupe' || kind === 'refused:flags') return sessionReadOnly('flags');
  const text = kind.startsWith('refused:')
    ? label('form.fail.refused', { raison: refusedText(kind.slice(8)) })
    : label(`form.fail.${['acl', 'missing', 'reread'].includes(kind) ? kind : 'other'}.personne`);
  toast.show(text, { tone: 'error' });
}

// Fiche personne : « Désactiver » (confirmation), « Réactiver », indisponibilités
el.detail.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || editor.isEditing() || !detailCurrent) return;
  if (b.dataset.personActive !== undefined) {
    if (b.dataset.personActive === '1') setPersonActive(detailCurrent.id, true);
    else personDialog.open('off', { personId: detailCurrent.id });
  } else if (b.dataset.unavAdd !== undefined) personDialog.open('unav-add', { personId: detailCurrent.id });
  else if (b.dataset.unavEdit !== undefined) personDialog.open('unav-edit', { unavId: Number(b.dataset.unavEdit) });
});

/**
 * Bouton de création (en-tête d'une vue, fiche d'un chantier ou d'une tâche) : fenêtre préremplie selon le
 * contexte (filtres projet et chantier, statut filtré, « Je suis… », tâche parente, chantier de la fiche).
 * @param {{create:string, parent?:string, chantier?:string}} data attributs data-* du bouton
 */
function openCreate(data) {
  if (!state.model) return;
  const ctx = prefillFromFilters(state.model, state.prefs.filters, state.prefs);
  if (data.chantier) {
    ctx.chantierId = Number(data.chantier);
    if (!state.model.chantiers.get(ctx.chantierId)?.projectIds.includes(ctx.projectId)) ctx.projectId = null;
  }
  if (data.create === 'subtask') ctx.parentId = Number(data.parent);
  if (['task', 'subtask', 'chantier'].includes(data.create)) createDialog.open(data.create, ctx);
}

/**
 * Arrêt d'urgence : flags.json, lu à une adresse FIXE commune à toutes les versions publiées (flagsUrl), sans
 * cache, au démarrage, à chaque relecture et juste avant chaque envoi réel. Absent ou illisible : édition coupée.
 */
async function flagsCheck() {
  const r = await fetch(flagsUrl(window.location.pathname, FLAGS_FILE), {
    method: 'GET',
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) return false;
  try {
    return flagsAllowEdition(await r.json());
  } catch {
    return false;
  }
}

/** Au démarrage : toute erreur (réseau, délai dépassé) coupe l'édition par prudence. */
async function flagsOk() {
  try {
    return await flagsCheck();
  } catch {
    return false;
  }
}

/** Règle de périmètre (Q15 B), contrôlée aussi par le writer : seules les tâches et chantiers ISD s'écrivent. */
function canWriteRow(table, id) {
  const m = state.model;
  // Personnes (Q14 A) : équipe ISD affichée par l'onglet, inactives comprises ; indisponibilités de ces personnes
  if (table === 'Team') return Boolean(m && personInScope(m, m.people.get(id)));
  if (table === 'Disponibilites') return Boolean(m && personInScope(m, m.people.get(lookup.row(table, id)?.membre)));
  if (table === 'Chantiers') return Boolean(m?.chantiers.has(id) && chantierInScope(m, m.chantiers.get(id)));
  const task = table === 'Tasks' ? m?.tasks.get(id) : null;
  return Boolean(task && taskInScope(m, task));
}

/** Même règle sur les valeurs d'une ligne créée ou rattachée ailleurs (projet, chantier, projets du chantier). */
function canWriteValues(table, v, opts = {}) {
  const m = state.model;
  if (!m) return false;
  // Valeurs d'arrivée d'une personne : elle reste dans l'équipe ISD (création : Domaine ISD, rôle ISD ou Management)
  if (table === 'Team') return teamValuesInScope(m, v, opts);
  if (table === 'Disponibilites') return personInScope(m, m.people.get(v.membre));
  const inScope = (p) => m.projects.get(p)?.inScope === true;
  if (table === 'Chantiers') return (v.Projets ?? []).some(inScope);
  if (table !== 'Tasks') return false;
  return inScope(v.projet) || (m.chantiers.get(v.Chantier)?.projectIds ?? []).some(inScope);
}

/** Existence d'une ligne dans les données lues (teamId des charges : la personne doit exister dans Team). */
function refExists(table, id) {
  return Boolean(state.raw?.tables[table]?.id?.includes(id));
}

/**
 * Lignes lues, pour le contrôle strict du writer : valeurs actuelles (colonnes de la liste blanche), sous-tâches
 * directes, tâches d'un chantier, lignes qui référencent une création (son annulation est alors refusée).
 */
const lookup = {
  choices: (key) => state.model?.choices?.[key] ?? null,
  row: (table, id) => (state.raw?.tables[table] ? decodeRow(state.raw.tables[table], table, id) : null),
  childIds: (id) => {
    const t = state.raw?.tables.Tasks;
    return t?.parentTask ? t.id.filter((_, i) => t.parentTask[i] === id) : [];
  },
  chantierTasks: (id) => {
    const t = state.raw?.tables.Tasks;
    return t?.Chantier ? t.id.filter((_, i) => t.Chantier[i] === id) : [];
  },
  referenced: (table, id) =>
    table === 'Tasks' ? lookup.childIds(id).length > 0 : table === 'Chantiers' && lookup.chantierTasks(id).length > 0,
};

/** Identifiant local d'une création en mode essai (rien n'est envoyé) : après le plus grand identifiant lu. */
function tempId(table) {
  return Math.max(0, ...(state.raw?.tables[table]?.id ?? [])) + 1;
}

/** Période d'une tâche dans les données lues (borne de 1 ETP par personne sur les charges). */
function periodOf(table, id) {
  const t = table === 'Tasks' ? state.model?.tasks.get(id) : null;
  return t ? { start: t.start, end: t.end } : null;
}

/** Toute la session passe en lecture (compte lecteur constaté, ou édition coupée à distance), une seule fois. */
function sessionReadOnly(reason) {
  if (!editState.canEdit) return;
  editState = { ...editState, canEdit: false, reason };
  // Le writer est verrouillé, pas remplacé : le journal de la session reste affiché dans le panneau
  writer?.lock(reason);
  if (state.model) renderAll();
  toast.show(label('toast.readOnly'), { tone: 'error' });
  // Formulaire ouvert : il passe en lecture, la saisie reste copiable ; sinon la fiche est redessinée
  if (editor.isEditing()) editor.lockSession(reason);
  else refreshDetail();
}

/**
 * Prépare l'édition une seule fois, après la première lecture (types des colonnes connus). Sans edition= dans
 * l'adresse, rien n'est lu ni créé : le writer reste en mode 'off'.
 */
async function setupEdit(columns) {
  if (editRequest.requested === 'off') {
    writer = createWriter({ docApi: null, mode: 'off', columns });
    return;
  }
  const [access, flags] = await Promise.all([gateway.fetchAccess(), flagsOk()]);
  editState = resolveEditState({ ...editRequest, docId: access.docId, flagsOk: flags, access: access.access });
  writer = createWriter({
    docApi: grist.docApi,
    mode: writerMode(editState),
    columns,
    canWriteRow,
    canWriteValues,
    refExists,
    lookup,
    tempId,
    periodOf,
    readTable: (table) => gateway.fetchTableRaw(table),
    preflight: flagsCheck,
    timeoutMs,
  });
}

/** À chaque relecture : l'arrêt d'urgence est relu ; s'il coupe l'édition, la session passe en lecture. */
async function recheckFlags() {
  if (!editState.canEdit) return;
  let ok;
  try {
    ok = await flagsCheck();
  } catch {
    return; // pas de réponse : la vérification avant chaque envoi reste la garde
  }
  if (!ok) sessionReadOnly('flags');
}

// Boutons de création de l'en-tête global (ligne des onglets) : fenêtre préremplie, focus rendu au bouton
el.tabs.addEventListener('click', (e) => {
  const c = e.target.closest('[data-create]');
  if (c) openCreate({ ...c.dataset });
});

el.main.addEventListener('click', (e) => {
  const c = e.target.closest('[data-create]');
  if (c) return openCreate({ ...c.dataset });
  const b = e.target.closest('[data-action]');
  if (!b) return;
  if (b.dataset.action === 'clear-filters') {
    clearFilters();
    $('f-search')?.focus();
  } else if (b.dataset.action === 'refresh') reload();
});

// ---------- Grist ----------
let gateway = null;
let loading = false;
let pending = false; // changement reçu pendant une lecture : relire à la fin

async function reload() {
  if (loading) {
    pending = true;
    return;
  }
  loading = true;
  pending = false;
  if (state.loaded) chrome.setRefreshing(true);
  else renderLoading();
  try {
    const raw = await gateway.fetchAll();
    if (accessRefused(raw.problems)) {
      renderScreen('access');
      return;
    }
    state.raw = raw;
    state.model = buildModel(raw);
    state.problems = raw.problems;
    const first = !editSetup;
    editSetup ??= setupEdit(raw.columns);
    await editSetup;
    if (!first) await recheckFlags();
    // Préférence ancienne ou ligne supprimée : un filtre qui ne désigne plus rien est retiré
    const f = validFilters(state.model, state.prefs.filters);
    if (f !== state.prefs.filters) {
      state.prefs = { ...state.prefs, filters: f };
      persist();
    }
    state.loaded = true;
    renderAll();
    refreshDetail();
  } catch (err) {
    renderScreen('error', { message: err?.message ?? String(err) });
  } finally {
    loading = false;
    chrome.setRefreshing(false);
    if (pending) reload();
    else if (viewFocus?.untilReload) viewFocus = null;
  }
}

function boot() {
  applyTheme(state.prefs.theme);
  if (window === window.parent) {
    renderScreen('outside');
    return;
  }
  if (typeof grist === 'undefined') {
    renderScreen('noapi');
    return;
  }
  grist.ready({ requiredAccess: 'full', allowSelectBy: false });
  gateway = createGateway(grist);
  gateway.onChange(reload);
  reload();
}

boot();
