/** Synthèse : tableau de pilotage Markdown, rendu sûr de ce Markdown et Gantt Mermaid. Fonctions pures (spec §4.4). */
import { formatDateFr, isoOfDay } from './dates.js';
import { taskEtpByRole, taskPeople } from './kanban-data.js';
import { sanitize } from './sanitize.js';
import { label, statusLabel } from '../labels.js';

/** Nombre maximal de tâches dans le Gantt Mermaid (au-delà, illisible) ; le reste est signalé. */
export const MAX_GANTT_TASKS = 60;
/** Début de chaque ligne de tâche du Gantt (voir mermaidGanttPlan). */
export const TITLE_PREFIX = '▸ ';
const ROLES = ['PO', 'DA', 'DS', 'DE', 'Mgmt', 'Autre'];

const etpFormat = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const etpText = (v) => `${etpFormat.format(v)} ETP`;

// ---------- Markdown ----------

/** Texte littéral dans le Markdown produit : les caractères qui auraient un sens (\ | * _ ` < > [ ]) sont précédés d'un « \ ». */
export function mdEscape(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\|*_`<>[\]]/g, (c) => `\\${c}`);
}

/** Tâches d'un nœud (lui compris), avec leur profondeur relative, dans l'ordre de l'arbre. */
function tasksOf(node, depth = 0, out = []) {
  if (node.taskId) out.push({ node, depth });
  node.children.forEach((c) => tasksOf(c, node.taskId ? depth + 1 : depth, out));
  return out;
}

/** Colonnes du tableau de chaque chantier ; les deux dernières (ETP) disparaissent si le chantier n'a aucune charge. */
const COLS = Object.freeze(['task', 'status', 'end', 'people', 'etp', 'roles']);
const KEY_OF = Object.freeze({
  task: 'title',
  status: 'status',
  end: 'end',
  people: 'people',
  etp: 'etp',
  roles: 'roles',
});

function taskRow(model, { node, depth }) {
  const task = model.tasks.get(node.taskId);
  const byRole = taskEtpByRole(task, model);
  const parts = byRole ? ROLES.filter((r) => byRole[r] > 0).map((r) => `${r} ${etpFormat.format(byRole[r])}`) : [];
  return {
    title: `${depth ? `${'↳ '.repeat(depth)}` : ''}${node.title || label('common.untitled')}`,
    status: statusLabel(task.status),
    end: task.end === null ? '' : formatDateFr(task.end),
    people: taskPeople(model, task)
      .map((p) => p.nom)
      .join(', '),
    etp: byRole && byRole.total > 0 ? etpFormat.format(byRole.total) : '',
    roles: parts.join(' · '),
    etpTotal: byRole?.total ?? 0,
  };
}

/**
 * Tableau de pilotage : projets → chantiers → tâches (statut, échéance, personnes, ETP total et par profil).
 * Un titre de niveau 2 par projet (avec sa catégorie), de niveau 3 par chantier visible (« (sans chantier) »
 * compris), puis un tableau des tâches et sous-tâches. Un chantier partagé n'est détaillé que sous son premier projet.
 * @param {object} model
 * @param {{tree:object[], taskIds:Set<number>}} view
 * @param {{today?:number}} [opts]
 * @returns {string}
 */
export function synthesisMarkdown(model, view, opts = {}) {
  const lines = [`# ${label('synthesis.md.title')}`, ''];
  const seenTasks = new Set();
  const body = [];
  let projets = 0;
  // Chantiers distincts : un chantier partagé compte une fois, le « (sans chantier) » virtuel une fois par projet
  const chantiers = new Set();
  let total = 0;
  let etpSum = 0;
  for (const categorie of view.tree) {
    for (const projet of categorie.children) {
      const groups = projet.children.map((c) => {
        const tasks = tasksOf(c).filter((t) => view.taskIds.has(t.node.taskId));
        const fresh = tasks.filter((t) => !seenTasks.has(t.node.taskId));
        fresh.forEach((t) => seenTasks.add(t.node.taskId));
        return {
          node: c,
          rows: fresh.map((t) => taskRow(model, t)),
          dup: tasks.length > fresh.length && !fresh.length,
        };
      });
      if (!groups.some((g) => g.rows.length || g.dup)) continue;
      projets++;
      body.push(`## ${mdEscape(projet.title || label('common.untitled'))} (${mdEscape(categorie.title)})`, '');
      for (const g of groups) {
        if (!g.rows.length && !g.dup) continue;
        chantiers.add(g.node.ref ? `${g.node.ref.table}:${g.node.ref.id}` : g.node.key);
        const status = g.node.status;
        body.push(
          `### ${mdEscape(g.node.title || label('common.untitled'))}${status ? ` — ${mdEscape(status)}` : ''}`,
          '',
        );
        if (g.dup) {
          body.push(label('synthesis.md.shared'), '');
          continue;
        }
        // Colonnes ETP seulement si au moins une tâche du chantier a une charge
        const withEtp = g.rows.some((r) => r.etp || r.roles);
        const cols = withEtp ? COLS : COLS.slice(0, 4);
        body.push(
          `| ${cols.map((k) => label(`synthesis.md.col.${k}`)).join(' | ')} |`,
          withEtp ? '| --- | --- | --- | --- | ---: | --- |' : '| --- | --- | --- | --- |',
        );
        for (const r of g.rows) {
          body.push(`| ${cols.map((k) => mdEscape(r[KEY_OF[k]])).join(' | ')} |`);
          total++;
          etpSum += r.etpTotal;
        }
        body.push('');
      }
    }
  }
  const stamp = opts.today === undefined ? '' : ` ${label('synthesis.md.date', { date: formatDateFr(opts.today) })}`;
  lines.push(
    `${label('synthesis.md.summary', { projets, chantiers: chantiers.size, taches: total, etp: etpText(etpSum) })}${stamp}`,
    '',
    ...body,
  );
  return `${lines.join('\n').trimEnd()}\n`;
}

// ---------- Rendu Markdown sûr ----------

/** Texte d'une ligne : « \x » littéral, « **gras** » en <strong>, tout le reste échappé. */
function inline(s) {
  let out = '';
  let bold = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) out += sanitize(s[++i]);
    else if (s[i] === '*' && s[i + 1] === '*') {
      out += bold ? '</strong>' : '<strong>';
      bold = !bold;
      i++;
    } else out += sanitize(s[i]);
  }
  return bold ? `${out}</strong>` : out;
}

/** Cellules d'une ligne de tableau (barres non précédées d'un « \ »). */
function cells(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && i + 1 < line.length) cur += line[i] + line[++i];
    else if (line[i] === '|') {
      out.push(cur);
      cur = '';
    } else cur += line[i];
  }
  out.push(cur);
  if (out[0].trim() === '') out.shift();
  if (out.length && cur.trim() === '') out.pop();
  return out.map((c) => c.trim());
}

/**
 * Rend le Markdown de la synthèse en HTML : seulement titres, listes, tableaux, gras et paragraphes.
 * Tout texte est échappé ; aucune balise, aucun lien ni aucune image du texte source n'est interprété.
 * @param {string} md
 * @returns {string} HTML sûr
 */
export function markdownToHtml(md) {
  const lines = String(md).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = /^(#{1,3}) (.*)$/.exec(line);
    if (head) {
      const n = head[1].length + 1; // le titre de la page est déjà un h2 : # → h3
      out.push(`<h${n + 1}>${inline(head[2])}</h${n + 1}>`);
    } else if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
      const right = cells(lines[i + 1]).map((c) => c.endsWith(':'));
      const th = cells(line).map((c, k) => `<th scope="col"${right[k] ? ' class="num"' : ''}>${inline(c)}</th>`);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].startsWith('|')) {
        const tds = cells(lines[i]).map((c, k) => `<td${right[k] ? ' class="num"' : ''}>${inline(c)}</td>`);
        rows.push(`<tr>${tds.join('')}</tr>`);
        i++;
      }
      i--;
      out.push(`<table><thead><tr>${th.join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`);
    } else if (/^- /.test(line)) {
      const items = [];
      while (i < lines.length && /^- /.test(lines[i])) items.push(`<li>${inline(lines[i++].slice(2))}</li>`);
      i--;
      out.push(`<ul>${items.join('')}</ul>`);
    } else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  return out.join('');
}

// ---------- Mermaid ----------

/**
 * Texte sûr dans un Gantt Mermaid : retire « : », « # », « ; », « % » et les retours à la ligne, neutralise les
 * guillemets (typographiques) et les chevrons. Jamais vide.
 * @param {unknown} s
 * @returns {string}
 */
export function mermaidEscape(s) {
  const t = String(s ?? '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[:#;%]/g, ' ')
    .replace(/["'`]/g, '’')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/\s+/g, ' ')
    .trim();
  return t || label('common.untitled');
}

/**
 * Plan du Gantt : source Mermaid, nombre de tâches tracées et omises (au-delà de MAX_GANTT_TASKS).
 * Seules les tâches datées (début et échéance cohérents) sont tracées, une section par projet.
 * @returns {{text:string, count:number, omitted:number}}
 */
export function mermaidGanttPlan(model, view, opts = {}) {
  const max = opts.max ?? MAX_GANTT_TASKS;
  const seen = new Set();
  const cands = [];
  for (const categorie of view.tree) {
    for (const projet of categorie.children) {
      for (const { node } of tasksOf(projet)) {
        const task = model.tasks.get(node.taskId);
        if (!task || seen.has(task.id) || !view.taskIds.has(task.id)) continue;
        if (task.start === null || task.end === null || task.end < task.start) continue;
        seen.add(task.id);
        cands.push({ projet, node, task });
      }
    }
  }
  // Plafond : d'abord les tâches en cours ou à venir (non terminées, échéance non passée), par date ; puis le reste
  const current = (c) => !c.task.done && (opts.today === undefined || c.task.end >= opts.today);
  const byDate = (a, b) => a.task.start - b.task.start || a.task.end - b.task.end || a.task.id - b.task.id;
  const ranked = [...cands.filter(current).sort(byDate), ...cands.filter((c) => !current(c)).sort(byDate)];
  const kept = new Set(ranked.slice(0, max).map((c) => c.task.id));
  const sections = [];
  let last = null;
  for (const { projet, node, task } of cands) {
    if (!kept.has(task.id)) continue;
    if (last !== projet) {
      sections.push(`  section ${mermaidEscape(projet.title)}`);
      last = projet;
    }
    const ms = task.type === 'jalon';
    const tags = [
      ms ? 'milestone' : '',
      task.done ? 'done' : task.status === 'inprogress' ? 'active' : '',
      opts.today !== undefined && task.end < opts.today && !task.done ? 'crit' : '',
    ].filter(Boolean);
    const dates = ms ? `${isoOfDay(task.end)}, 0d` : `${isoOfDay(task.start)}, ${isoOfDay(task.end)}`;
    // Préfixe : aucun titre issu des données ne peut commencer une ligne par un mot-clé Mermaid (title, section, click…)
    sections.push(`  ${TITLE_PREFIX}${mermaidEscape(node.title)} :${[...tags, `t${task.id}`, dates].join(', ')}`);
  }
  const count = kept.size;
  const text = count
    ? [
        'gantt',
        `  title ${mermaidEscape(label('synthesis.gantt.title'))}`,
        '  dateFormat YYYY-MM-DD',
        '  axisFormat %m/%Y',
        ...sections,
      ].join('\n')
    : '';
  return { text, count, omitted: cands.length - count };
}

/** Source Mermaid du Gantt (chaîne vide sans tâche datée). */
export const mermaidGantt = (model, view, opts) => mermaidGanttPlan(model, view, opts).text;
