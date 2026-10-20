/**
 * Fiche détail (en lecture) d'une tâche, d'un chantier ou d'un projet de la Feuille (spec §4.4, §5).
 * Le panneau lui-même (ouverture, focus, Échap) est ui/drawer.js ; ce module produit son contenu.
 */
import { formatDateFr } from '../core/dates.js';
import { ETP_SPLIT, priorityText, taskEtpByRole, taskPeopleRows, taskPriority } from '../core/kanban-data.js';
import {
  breadcrumb,
  chantierItems,
  dependents,
  detailLevel,
  projectItems,
  safeLink,
  splitEmptyFields,
} from '../core/detail-data.js';
import {
  displayRole,
  isIsdTeamMember,
  isValidEmail,
  personItems,
  upcomingUnavailability,
} from '../core/team-directory.js';
import { h, roleSpan, statusBadge } from '../ui/kit.js';
import { raw } from '../core/sanitize.js';
import { etpLabel, label, statusLabel } from '../labels.js';
import { activeBadge, capacityText, estimationBadge, roleText, unavailabilityText } from './team.js';
import { isEstimationPerson } from '../core/estimation.js';
import { tagChipsHtml } from './tags-field.js';

export const id = 'detail';

const etpFormat = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const hoursFormat = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const TABLES = Object.freeze({ Tasks: 'tasks', Chantiers: 'chantiers', Projects: 'projects', Team: 'people' });

const titleOrUntitled = (x) => x?.title || x?.nom || label('common.untitled');

function itemOf(model, ref) {
  return model[TABLES[ref.table]]?.get(ref.id) ?? null;
}

/** Bouton qui ouvre la fiche d'un autre élément (dans le même panneau). */
function refButton(model, ref, extra = '') {
  const item = itemOf(model, ref);
  const level = detailLevel(model, ref);
  return h`<button type="button" class="dt-link" data-ref-table="${ref.table}" data-ref-id="${ref.id}">
    <span class="dt-link__title">${titleOrUntitled(item)}</span>
    ${level ? h`<span class="dt-link__kind">${label(`detail.level.${level}`)}</span>` : ''}
    ${extra}
  </button>`;
}

/**
 * Badge du rôle d'une personne (profil ISD ou « Mgmt » pour le Management de l'équipe ISD, voir displayRole) ;
 * avec outside, « (hors ISD) » pour une personne qui n'est pas de l'équipe ISD.
 */
export function roleBadge(model, p, outside = false) {
  const role = displayRole(model, p);
  if (role) return roleSpan('dt-person__role', role);
  return outside && !isIsdTeamMember(model, p)
    ? h` <span class="dt-muted">(${label('detail.charges.outside')})</span>`
    : '';
}

export function person(model, pid) {
  const p = model.people.get(pid);
  if (!p) return null;
  return h`<span class="dt-person">${p.nom || label('common.untitled')}${roleBadge(model, p)}</span>`;
}

function people(model, ids) {
  const list = ids.map((i) => person(model, i)).filter(Boolean);
  return list.length ? h`<span class="dt-people">${list}</span>` : null;
}

// Valeur absente → null : le champ rejoint la ligne « Non renseignés » de fields()
const dateOr = (d) => (d === null || d === undefined ? null : formatDateFr(d));
const textOr = (s) => (s ? s : null);
/** Tags en lecture : pastilles, ou contenu d'une cellule illisible (montré tel quel). */
const tagsRead = (model, table, row) =>
  row.tagsUnreadable
    ? h`<span class="dt-muted">${label('detail.tags.unreadable', { texte: row.tagsUnreadable })}</span>`
    : tagChipsHtml(model, table, row.tags) || null;

/** Champs renseignés un par ligne, puis les champs vides regroupés sur une seule ligne. */
function fields(rows) {
  const { filled, empty } = splitEmptyFields(rows);
  return h`${filled.length ? h`<dl class="dt-fields">${filled.map(([k, v]) => h`<div class="dt-field"><dt>${label(k)}</dt><dd>${v}</dd></div>`)}</dl>` : ''}
    ${empty.length ? h`<p class="dt-unset">${label('detail.unset', { champs: empty.map((k) => label(k).toLowerCase()).join(', ') })}</p>` : ''}`;
}

export function section(titleKey, body, extraTitle = '') {
  return h`<section class="dt-section"><h3 class="dt-section__title">${label(titleKey)}${extraTitle}</h3>${body}</section>`;
}

const prose = (s) => h`<p class="dt-prose">${s}</p>`;

export function refList(model, refs, withStatus = true) {
  if (!refs.length) return h`<p class="dt-empty">${label('detail.items.empty')}</p>`;
  return h`<ul class="list dt-list">${refs.map((r) => {
    const item = itemOf(model, r);
    return h`<li>${refButton(model, r, withStatus && item ? statusBadge(item.status) : '')}</li>`;
  })}</ul>`;
}

export function crumbs(model, ref) {
  const path = breadcrumb(model, ref);
  if (!path.length) return '';
  return h`<nav class="dt-crumbs" aria-label="${label('detail.path')}"><ol>${path.map((c) =>
    c.kind === 'categorie'
      ? h`<li class="dt-crumbs__cat"><span class="fr-tag fr-tag--sm dt-tag" title="${label('detail.level.categorie')}"><span class="fr-sr-only">${label('detail.level.categorie')} : </span>${c.title || label('common.untitled')}</span></li>`
      : h`<li><span class="dt-crumbs__kind">${label(`detail.level.${c.kind}`)}</span>${
          c.ref
            ? h`<button type="button" class="dt-crumbs__link" data-ref-table="${c.ref.table}" data-ref-id="${c.ref.id}">${c.title || label('common.untitled')}</button>`
            : h`<span class="dt-crumbs__text">${c.title || label('common.untitled')}</span>`
        }</li>`,
  )}</ol></nav>`;
}

export function linkHtml(value) {
  if (!value) return null;
  const href = safeLink(value);
  if (!href) return value;
  return h`<a href="${href}" target="_blank" rel="noopener noreferrer" class="fr-link dt-url" title="${label('detail.link.external', { lien: value })}">${value}</a>`;
}

/**
 * Personnes de la tâche, en une seule liste (assignés et charges réunis) : nom, profil, heures et ETP. Une personne
 * qui a une charge sans être assignée porte la mention discrète « non assignée » ; un assigné sans charge, « — ».
 */
export function peopleHtml(model, task) {
  const rows = taskPeopleRows(model, task);
  if (!rows.length) return h`<p class="dt-empty">${label('detail.people.empty')}</p>`;
  const charged = rows.filter((r) => r.hours !== null);
  const total = charged.reduce((s, r) => s + r.hours, 0);
  const byRole = taskEtpByRole(task, model);
  const parts = byRole
    ? ETP_SPLIT.filter((k) => byRole[k] > 0.0005).map((k) => `${etpLabel(k)} ${etpFormat.format(byRole[k])}`)
    : [];
  const etpCell = (v) => (v === null ? '—' : label('detail.etp', { valeur: etpFormat.format(v) }));
  const name = (r) =>
    r.person ? r.person.nom || label('common.untitled') : label('form.charges.unknown', { id: r.personId });
  const profile = (r) => (r.person ? roleBadge(model, r.person, true) : '');
  return h`<table class="dt-charges dt-people-list">
    <caption class="fr-sr-only">${label('detail.section.people')}</caption>
    <thead><tr><th scope="col">${label('detail.charges.person')}</th><th scope="col">${label('detail.charges.hours')}</th><th scope="col">${label('detail.charges.etp')}</th></tr></thead>
    <tbody>${rows.map(
      (r) =>
        h`<tr class="${raw(r.assigned ? '' : 'dt-people-list__unassigned')}" data-person="${r.personId}"><th scope="row">${name(r)}${profile(r)}${
          r.assigned ? '' : h` <span class="dt-unassigned">${label('detail.people.unassigned')}</span>`
        }</th>
          <td>${r.hours === null ? h`<span aria-label="${label('detail.people.noCharge')}">—</span>` : label('detail.hours', { h: hoursFormat.format(r.hours) })}</td><td>${r.hours === null ? '—' : etpCell(r.etp)}</td></tr>`,
    )}</tbody>
    ${charged.length ? h`<tfoot><tr><th scope="row">${label('detail.charges.total')}</th><td>${label('detail.hours', { h: hoursFormat.format(total) })}</td><td>${etpCell(byRole ? byRole.total : null)}</td></tr></tfoot>` : ''}
  </table>
  ${charged.length ? (byRole ? (parts.length ? h`<p class="dt-note">${label('detail.etp.byRole', { detail: parts.join(', ') })}</p>` : '') : h`<p class="dt-note">${label('detail.etp.noDates')}</p>`) : ''}`;
}

/** Bouton « Ajouter une sous-tâche » (fiche tâche, en lecture ou en formulaire). */
export function addSubtaskButton(taskId, disabled = false) {
  return h`<button type="button" class="fr-btn fr-btn--sm fr-btn--secondary fr-btn--icon-left fr-icon-add-line tf-add-sub" id="btn-add-subtask" data-create="subtask" data-parent="${taskId}" ${raw(disabled ? 'disabled' : '')}>${label('create.subtask.open')}</button>`;
}

/** Bouton « + Tâche » d'un chantier (fiche en lecture ou en formulaire). */
export function addTaskButton(chantierId, disabled = false) {
  return h`<button type="button" class="fr-btn fr-btn--sm fr-btn--secondary fr-btn--icon-left fr-icon-add-line tf-add-sub" id="btn-add-task" data-create="task" data-chantier="${chantierId}" title="${label('create.task.inChantier')}" ${raw(disabled ? 'disabled' : '')}>${label('create.task.short')}</button>`;
}

function taskBody(model, task, today, canCreate = false) {
  const late = task.end !== null && task.end < today && !task.done;
  const priority = taskPriority(model, task);
  const tref = (i) => ({ table: 'Tasks', id: i });
  const subs = task.childIds.filter((i) => model.tasks.has(i)).map(tref);
  const deps = task.dependDe.filter((i) => model.tasks.has(i)).map(tref);
  const blocks = dependents(model, task.id).map(tref);
  return h`
    <div class="dt-badges">
      ${statusBadge(task.status)}
      ${late ? h`<span class="fr-badge fr-badge--sm fr-badge--error">${label('detail.late')}</span>` : ''}
      ${task.type === 'jalon' ? h`<span class="fr-badge fr-badge--sm fr-badge--no-icon fr-badge--blue-ecume">${label('detail.milestone')}</span>` : ''}
    </div>
    ${section(
      'detail.section.summary',
      fields([
        ['detail.field.start', dateOr(task.start)],
        ['detail.field.end', dateOr(task.end)],
        ['detail.field.closed', dateOr(task.closed)],
        ['detail.field.priority', textOr(priorityText(priority))],
        ['detail.field.responsable', task.responsable ? (person(model, task.responsable) ?? null) : null],
        [
          'detail.field.estimation',
          task.estimationH ? label('detail.hours', { h: hoursFormat.format(task.estimationH) }) : null,
        ],
        [
          'detail.field.spent',
          task.tempsPasse ? label('detail.hours', { h: hoursFormat.format(task.tempsPasse) }) : null,
        ],
        ['detail.field.link', linkHtml(task.lien)],
        ['detail.field.tags', tagsRead(model, 'Tasks', task)],
      ]),
    )}
    ${section('detail.section.people', peopleHtml(model, task), h` <span class="dt-count">${taskPeopleRows(model, task).length}</span>`)}
    ${task.description ? section('detail.section.description', prose(task.description)) : ''}
    ${task.criteres ? section('detail.section.criteres', prose(task.criteres)) : ''}
    ${task.commentaire ? section('detail.section.comment', prose(task.commentaire)) : ''}
    ${section(
      'detail.section.subtasks',
      h`${refList(model, subs)}${canCreate ? addSubtaskButton(task.id) : ''}`,
      h` <span class="dt-count">${subs.length}</span>`,
    )}
    ${deps.length ? section('detail.section.dependDe', refList(model, deps)) : ''}
    ${blocks.length ? section('detail.section.dependents', refList(model, blocks)) : ''}`;
}

function chantierBody(model, c, canCreate = false) {
  const items = chantierItems(model, c.id).map((i) => ({ table: 'Tasks', id: i }));
  return h`
    ${section(
      'detail.section.summary',
      fields([
        ['detail.field.status', textOr(c.status)],
        ['detail.field.start', dateOr(c.start)],
        ['detail.field.endProject', dateOr(c.end)],
        ['detail.field.priority', textOr(priorityText(c.priorite))],
        ['detail.field.responsable', c.responsable ? (person(model, c.responsable) ?? null) : null],
        ['detail.field.contributeurs', people(model, c.contributeurs)],
        ['detail.field.tags', tagsRead(model, 'Chantiers', c)],
      ]),
    )}
    ${c.criteres ? section('detail.section.criteres', prose(c.criteres)) : ''}
    ${c.description ? section('detail.section.description', prose(c.description)) : ''}
    ${section(
      'detail.section.items.task',
      h`${refList(model, items)}${canCreate ? addTaskButton(c.id) : ''}`,
      h` <span class="dt-count">${items.length}</span>`,
    )}`;
}

function projectBody(model, p) {
  const items = projectItems(model, p.id);
  return h`
    ${section(
      'detail.section.summary',
      fields([
        ['detail.field.status', textOr(p.status)],
        ['detail.field.start', dateOr(p.start)],
        ['detail.field.endProject', dateOr(p.end)],
        ['detail.field.responsable', p.responsable ? (person(model, p.responsable) ?? null) : null],
        ['detail.field.priority', textOr(priorityText(p.priorite))],
        ['detail.field.requester', textOr(p.demandeur)],
      ]),
    )}
    ${p.description ? section('detail.section.description', prose(p.description)) : ''}
    ${section('detail.section.items.chantier', refList(model, items), h` <span class="dt-count">${items.length}</span>`)}`;
}

/** Rôles d'une personne sur une tâche ou un chantier, en texte. */
const rolesText = (roles) => roles.map((r) => label(`person.role.${r}`)).join(', ');

/**
 * Bandeau d'édition de la fiche personne (lot 2d) : « Modifier », « Désactiver » ou « Réactiver » (jamais de
 * suppression), « Ajouter une indisponibilité » ; sinon la raison de la lecture seule.
 * @param {{editable:boolean, reason:string}|undefined} avail
 * @param {{canActive?:boolean, canUnavAdd?:boolean}} [person]
 */
function personEditBar(avail, p, person = {}) {
  if (!avail?.editable) return h`<p class="dt-readonly">${label(`detail.why.${avail?.reason ?? 'off'}`)}</p>`;
  const active = person.canActive
    ? p.actif
      ? h`<button type="button" id="btn-person-active" class="fr-btn fr-btn--sm fr-btn--tertiary" data-person-active="0" title="${label('person.edit.deactivate.title')}">${label('person.edit.deactivate')}</button>`
      : h`<button type="button" id="btn-person-active" class="fr-btn fr-btn--sm fr-btn--secondary" data-person-active="1" title="${label('person.edit.reactivate.title')}">${label('person.edit.reactivate')}</button>`
    : '';
  return h`<div class="dt-edit dt-edit--person">
    <button type="button" id="btn-edit-open" class="fr-btn fr-btn--sm fr-btn--icon-left fr-icon-edit-line edit-primary" data-edit-open title="${label('form.edit.title.person')}">
      ${label('form.edit')}
    </button>
    ${person.canUnavAdd ? h`<button type="button" id="btn-unav-add" class="fr-btn fr-btn--sm fr-btn--secondary" data-unav-add="${p.id}">${label('person.edit.unavAdd')}</button>` : ''}
    ${active}
  </div>
  ${p.actif ? '' : h`<p class="dt-inactive-note">${label('person.inactive.note')}</p>`}`;
}

/** Fiche d'une personne : identité, tâches et chantiers en cours ou à venir (spec §5, onglet Équipe). */
function personBody(model, p, today, canUnavEdit = false) {
  const { tasks, chantiers } = personItems(model, p.id, today);
  const boss = p.n1 && p.n1 !== p.id ? model.people.get(p.n1) : null;
  const upcoming = upcomingUnavailability(p, today);
  const email = p.email
    ? isValidEmail(p.email)
      ? h`<a class="fr-link" href="mailto:${p.email}">${p.email}</a>`
      : p.email
    : null;
  const range = (x) =>
    x.start === null && x.end === null
      ? label('person.noDates')
      : label('person.range', { debut: formatDateFr(x.start), fin: formatDateFr(x.end) });
  const taskList = tasks.length
    ? h`<ul class="list dt-list">${tasks.map(
        (t) =>
          h`<li>${refButton(
            model,
            { table: 'Tasks', id: t.id },
            h`${statusBadge(t.status)}<span class="dt-link__meta">${rolesText(t.roles)} · ${range(t)}${
              t.hours > 0
                ? ` · ${label('detail.hours', { h: hoursFormat.format(t.hours) })}${t.etp === null ? '' : ` · ${label('detail.etp', { valeur: etpFormat.format(t.etp) })}`}`
                : ''
            }</span>`,
          )}</li>`,
      )}</ul>`
    : h`<p class="dt-empty">${label('person.tasks.empty')}</p>`;
  const chantierList = chantiers.length
    ? h`<ul class="list dt-list">${chantiers.map(
        (c) =>
          h`<li>${refButton(
            model,
            { table: 'Chantiers', id: c.id },
            h`<span class="dt-link__meta">${rolesText(c.roles)}${c.status ? ` · ${c.status}` : ''}${
              c.hours > 0 ? ` · ${label('detail.hours', { h: hoursFormat.format(c.hours) })}` : ''
            }</span>`,
          )}</li>`,
      )}</ul>`
    : h`<p class="dt-empty">${label('person.chantiers.empty')}</p>`;
  return h`
    <div class="dt-badges">${activeBadge(p.actif)}</div>
    ${section(
      'person.section.identity',
      fields([
        ['person.field.role', roleText(p)],
        ['person.field.email', email],
        [
          'person.field.aph',
          p.aph.trim()
            ? h`<span class="dt-aph">${p.aph}</span>${estimationBadge(isEstimationPerson(model, p.id))}`
            : null,
        ],
        ['person.field.domaine', textOr(p.domaine)],
        [
          'person.field.n1',
          boss
            ? h`<button type="button" class="dt-crumbs__link" data-ref-table="Team" data-ref-id="${boss.id}">${boss.nom || label('common.untitled')}</button>`
            : null,
        ],
        ['person.field.capacity', capacityText(p)],
        [
          'person.field.unav',
          upcoming.length
            ? h`<ul class="list dt-unav">${upcoming.map(
                (u) =>
                  h`<li>${unavailabilityText(u)}${
                    canUnavEdit && u.id
                      ? h` <button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary-no-outline dt-unav__edit" data-unav-edit="${u.id}" aria-label="${label('person.edit.unavEdit.aria', { periode: unavailabilityText(u) })}">${label('person.edit.unavEdit')}</button>`
                      : ''
                  }</li>`,
              )}</ul>`
            : null,
        ],
      ]),
    )}
    ${section('person.section.tasks', taskList, h` <span class="dt-count">${tasks.length}</span>`)}
    ${section('person.section.chantiers', chantierList, h` <span class="dt-count">${chantiers.length}</span>`)}`;
}

/**
 * Statut rapide : un bouton-menu (« Statut : À faire ▾ ») qui déplie des boutons. Rien n'est enregistré avant
 * le choix explicite d'un statut (clic ou Entrée) : les flèches du clavier ne déclenchent aucune écriture.
 */
export function statusMenu(statuses, current, disabled = false) {
  const list = current && !statuses.includes(current) ? [...statuses, current] : statuses;
  return h`<div class="status-menu">
    <button type="button" id="btn-status-menu" class="fr-btn fr-btn--sm fr-btn--secondary status-menu__toggle" data-status-toggle
      aria-haspopup="true" aria-expanded="false" aria-controls="status-menu-list" ${raw(disabled ? 'disabled' : '')}>
      ${label('detail.quickStatus.button', { statut: statusLabel(current) })}<span aria-hidden="true"> ▾</span>
    </button>
    <ul id="status-menu-list" class="status-menu__list" hidden>
      ${list.map(
        (s) =>
          h`<li><button type="button" class="status-menu__item" data-set-status="${s}" ${raw(s === current ? 'aria-current="true"' : '')}>${statusLabel(s)}</button></li>`,
      )}
    </ul>
  </div>`;
}

/**
 * Bandeau d'édition de la fiche en lecture : statut rapide et « Modifier » si l'élément est modifiable,
 * sinon la raison de la lecture seule.
 * @param {{editable:boolean, reason:string}|undefined} avail
 */
function editBar(avail, item, statuses, table = 'Tasks') {
  if (!avail?.editable) return h`<p class="dt-readonly">${label(`detail.why.${avail?.reason ?? 'off'}`)}</p>`;
  return h`<div class="dt-edit">
    <div class="dt-edit__status">
      <span class="dt-edit__label">${label('detail.quickStatus')}</span>
      ${statusMenu(statuses, item.status)}
      <span class="dt-edit__help">${label('detail.quickStatus.help')}</span>
    </div>
    <button type="button" id="btn-edit-open" class="fr-btn fr-btn--sm fr-btn--icon-left fr-icon-edit-line edit-primary" data-edit-open title="${label(table === 'Chantiers' ? 'form.edit.title.chantier' : 'form.edit.title')}">
      ${label('form.edit')}
    </button>
  </div>`;
}

/** Vrai si la ligne existe encore dans le modèle. */
export function detailExists(model, ref) {
  return Boolean(itemOf(model, ref) && detailLevel(model, ref));
}

/** Titre seul d'une fiche (bouton « Retour »), sans construire son contenu. */
export function detailTitle(model, ref) {
  const item = itemOf(model, ref);
  return item ? titleOrUntitled(item) : label('detail.unknown');
}

/**
 * Contenu de la fiche d'une ligne de la Feuille.
 * @param {object} model
 * @param {{table:'Tasks'|'Chantiers'|'Projects', id:number}} ref
 * @param {number} today jour courant (retards)
 * @param {{edit?:{editable:boolean, reason:string}, canCreate?:boolean,
 *          person?:{canActive?:boolean, canUnavAdd?:boolean, canUnavEdit?:boolean}}} [opts] droit de modifier
 *   (task-form.js:editAvailability) ; canCreate : boutons « Ajouter une sous-tâche » et « + Tâche »
 * @returns {{kind:object, title:string, body:object}} fragments sûrs (h``) et titre en texte brut
 */
export function detailContent(model, ref, today, opts = {}) {
  const item = itemOf(model, ref);
  const level = detailLevel(model, ref);
  if (!item || !level)
    return {
      kind: label(`detail.kind.${ref.table}`),
      title: label('detail.unknown'),
      body: h`<p class="dt-empty">${label('detail.unknown.body')}</p>`,
    };
  if (ref.table === 'Team')
    return {
      kind: label('detail.level.personne'),
      title: titleOrUntitled(item),
      body: h`${personEditBar(opts.edit, item, opts.person)}${personBody(model, item, today, Boolean(opts.edit?.editable && opts.person?.canUnavEdit))}`,
    };
  const levelText = label(`detail.level.${level}`);
  const tableText = label(`detail.kind.${ref.table}`);
  const kind =
    levelText === tableText
      ? levelText
      : h`${levelText}<span class="dt-source">${label('detail.source', { table: label(`detail.table.${ref.table}`) })}</span>`;
  const create = Boolean(opts.edit?.editable && opts.canCreate);
  const body =
    ref.table === 'Tasks'
      ? taskBody(model, item, today, create)
      : ref.table === 'Chantiers'
        ? chantierBody(model, item, create)
        : projectBody(model, item);
  const statuses = ref.table === 'Chantiers' ? (model.statuses?.chantiers ?? []) : (model.statuses?.tasks ?? []);
  return {
    kind,
    title: titleOrUntitled(item),
    body: h`${crumbs(model, ref)}${editBar(opts.edit, item, statuses, ref.table)}${body}`,
  };
}
