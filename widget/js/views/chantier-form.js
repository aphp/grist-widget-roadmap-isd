/**
 * Formulaire d'un chantier dans la fiche (lot 2c) : rendu seul (fragments h``), à partir de l'état tenu par
 * ui/task-editor.js. Liste courte (nom, statut, projets, dates, responsable, contributeurs), demandeur lu des
 * projets (Q12), priorité en lecture (Q5), tags en lecture (lot 2e) ; le reste sous « Plus de champs ».
 */
import {
  CHANTIER_NAME_MAX,
  chantierDemandeurs,
  chantierSpan,
  chantierTaskIds,
  reattachPlan,
} from '../core/chantier-form.js';
import { projectOptions } from '../core/create-form.js';
import { formatDateFr } from '../core/dates.js';
import { priorityText } from '../core/kanban-data.js';
import { raw } from '../core/sanitize.js';
import { MAX_YEAR, MIN_YEAR, inputFromDay } from '../core/write-encode.js';
import { label } from '../labels.js';
import { h } from '../ui/kit.js';
import { addTaskButton, refList, section, statusMenu } from './detail.js';
import { alertHtml, attrs, field, personChip, personGroups } from './task-form.js';

const untitled = (s) => s || label('common.untitled');
const sel = (on) => raw(on ? 'selected' : '');

/** Pastille d'un projet du chantier, retirable. */
function projectChip(model, id, removable) {
  const name = untitled(model.projects.get(id)?.title ?? `n° ${id}`);
  return h`<li class="tf-chip"><span class="tf-chip__text" title="${name}">${name}</span>${
    removable
      ? h`<button type="button" class="tf-chip__remove" data-remove-projet="${id}" title="${label('form.field.remove', { nom: name })}" aria-label="${label('form.field.remove', { nom: name })}">✕</button>`
      : ''
  }</li>`;
}

/**
 * Projets d'un chantier (fiche ou création) : pastilles, ajout parmi les projets du périmètre ISD.
 * @param {object} st état du formulaire (prefix, can, busy, draft.Projets)
 */
export function projetsControl(st, model) {
  const p = st.prefix ?? 'tf';
  const can = st.can('Projets').ok && !st.busy;
  const chosen = st.draft.Projets;
  const rest = projectOptions(model).filter((x) => !chosen.includes(x.id));
  return h`${
    chosen.length
      ? h`<ul class="list tf-chips" aria-label="${label('form.field.Projets')}">${chosen.map((id) => projectChip(model, id, can))}</ul>`
      : h`<p class="tf-empty">${label('form.field.Projets.empty')}</p>`
  }
    <label class="fr-sr-only" for="${p}-Projets">${label('form.field.Projets.addLabel')}</label>
    <select id="${p}-Projets" class="fr-select tf-add" data-add-projet ${attrs(st, 'Projets')}>
      <option value="" selected>${label('form.field.Projets.add')}</option>
      ${rest.map((x) => h`<option value="${x.id}">${untitled(x.title)}</option>`)}
    </select>`;
}

/** Contributeurs (fiche ou création) : pastilles et ajout d'une personne. */
export function contributeursControl(st, model) {
  const p = st.prefix ?? 'tf';
  const d = st.draft;
  const can = st.can('Contributeurs').ok && !st.busy;
  return h`${
    d.Contributeurs.length
      ? h`<ul class="list tf-chips" aria-label="${label('form.field.Contributeurs')}">${d.Contributeurs.map((id) => personChip(model, id, can, 'data-remove-contrib'))}</ul>`
      : h`<p class="tf-empty">${label('form.field.Contributeurs.empty')}</p>`
  }
    <label class="fr-sr-only" for="${p}-Contributeurs">${label('form.field.Contributeurs.addLabel')}</label>
    <select id="${p}-Contributeurs" class="fr-select tf-add" data-add-contrib ${attrs(st, 'Contributeurs')}>
      <option value="" selected>${label('form.field.assignees.add')}</option>
      ${personGroups(model, [], d.Contributeurs)}
    </select>`;
}

/** Responsable (fiche ou création) : sélection simple. */
export function responsableControl(st, model) {
  const p = st.prefix ?? 'tf';
  const r = st.draft.Responsable;
  return h`<select id="${p}-Responsable" class="fr-select" data-input="Responsable" ${attrs(st, 'Responsable')}>
    <option value="" ${sel(r === null)}>${label('form.field.Responsable.none')}</option>
    ${personGroups(model, r === null ? [] : [r])}
  </select>`;
}

/** Champ date (fiche ou création). */
export function dateControl(st, f) {
  const p = st.prefix ?? 'tf';
  return h`<input type="date" id="${p}-${f}" class="fr-input" min="${MIN_YEAR}-01-01" max="${MAX_YEAR}-12-31" value="${inputFromDay(st.draft[f])}" data-input="${f}" ${attrs(st, f)}>`;
}

/** Choix du projet d'arrivée des tâches dont le projet est retiré du chantier. */
function reattachHtml(st, model) {
  const plan = reattachPlan(model, st.ref.id, st.draft.Projets, st.reattachTo ?? null);
  if (!plan.taskIds.length || !st.draft.Projets.length) return '';
  return h`<div class="tf-reattach" role="group" aria-labelledby="tf-reattach-label">
    <p class="tf-warn" id="tf-reattach-label">${label(plan.taskIds.length === 1 ? 'form.reattach.one' : 'form.reattach.many', { n: plan.taskIds.length })}</p>
    <label class="fr-label" for="tf-reattach">${label('form.reattach.to')}</label>
    <select id="tf-reattach" class="fr-select" data-reattach ${raw(st.busy ? 'disabled' : '')}>
      ${st.draft.Projets.map((id) => h`<option value="${id}" ${sel(id === plan.target)}>${untitled(model.projects.get(id)?.title)}</option>`)}
    </select>
  </div>`;
}

/** Corps du formulaire chantier. */
export function chantierFormBody(st, model) {
  const c = model.chantiers.get(st.ref.id);
  const d = st.draft;
  const demandeurs = chantierDemandeurs(model, d.Projets);
  const span = d.Debut === null && d.Fin === null ? chantierSpan(model, st.ref.id) : null;
  const tasks = chantierTaskIds(model, st.ref.id)
    .filter((id) => !model.tasks.get(id).parentId)
    .map((id) => ({ table: 'Tasks', id }));
  return h`<form class="tf" id="chantier-form" novalidate aria-describedby="tf-legend" data-chantier-id="${st.ref.id}">
    ${alertHtml(st, model)}
    <p class="tf-legend" id="tf-legend">${label('form.legend')}</p>
    ${field(st, 'Nom_du_chantier', h`<input type="text" id="tf-Nom_du_chantier" class="fr-input tf-title" value="${d.Nom_du_chantier}" maxlength="${CHANTIER_NAME_MAX + 50}" required data-input="Nom_du_chantier" ${attrs(st, 'Nom_du_chantier')}>`, { required: true })}
    ${field(st, 'Statut', statusMenu(model.statuses.chantiers, d.Statut, !st.can('Statut').ok || st.busy), {
      legend: true,
      hintAfter: label('form.field.statut.help'),
    })}
    ${field(st, 'Projets', h`${projetsControl(st, model)}${reattachHtml(st, model)}`, { legend: true, required: true })}
    <dl class="dt-fields tf-readonly">
      <div class="dt-field"><dt>${label('form.field.demandeur')}</dt><dd>${
        demandeurs.length
          ? h`${demandeurs.map((x) => `${x.demandeur} (${x.projet})`).join(' · ')} <span class="dt-muted">${label('form.field.demandeur.read')}</span>`
          : label('form.field.demandeur.none')
      }</dd></div>
    </dl>
    <div class="tf-row">
      ${field(st, 'Debut', dateControl(st, 'Debut'))}
      ${field(st, 'Fin', dateControl(st, 'Fin'))}
    </div>
    ${span ? h`<p class="fr-hint-text tf-inherited">${label('form.field.span', { debut: formatDateFr(span.start), fin: formatDateFr(span.end) })}</p>` : ''}
    ${field(st, 'Responsable', responsableControl(st, model))}
    ${field(st, 'Contributeurs', contributeursControl(st, model), { legend: true })}
    <dl class="dt-fields tf-readonly">
      <div class="dt-field"><dt>${label('form.field.priorite')}</dt><dd>${priorityText(c?.priorite ?? '') || label('form.field.priorite.none')} <span class="dt-muted">${label('form.field.Priorite.read')}</span></dd></div>
      <div class="dt-field"><dt>${label('form.field.tags')}</dt><dd>${label('form.field.tags.later')}</dd></div>
    </dl>
    <details class="tf-more" id="tf-more" ${raw(st.moreOpen ? 'open' : '')}>
      <summary class="tf-more__summary">${label('form.more')} <span class="tf-more__hint">(${label('form.more.hint.chantier')})</span></summary>
      <div class="tf-more__body">
        ${['Description', 'Objectifs_resultats_attendus', 'Criteres_de_succes'].map((f) =>
          field(
            st,
            f,
            h`<textarea id="tf-${f}" class="fr-input tf-area" rows="3" data-input="${f}" ${attrs(st, f)}>${d[f]}</textarea>`,
            {
              wide: true,
            },
          ),
        )}
      </div>
    </details>
    ${section(
      'detail.section.items.task',
      h`${refList(model, tasks)}${st.canCreate ? addTaskButton(st.ref.id, st.busy) : ''}`,
      h` <span class="dt-count">${tasks.length}</span>`,
    )}
  </form>`;
}
