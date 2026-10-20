/**
 * Fenêtres « Nouvelle tâche », « Sous-tâche », « Nouveau chantier » et « Changer de chantier » (lot 2c) : rendu
 * seul (fragments h``), à partir de l'état tenu par ui/create-dialog.js. Champs obligatoires d'abord, puis le bloc
 * « Personnes » des tâches, le reste sous « Plus d'options ». Identifiants préfixés « cf- » (la fiche ouverte
 * dessous garde les siens).
 */
import { chantierOptions, parseTarget, targetValue } from '../core/create-form.js';
import { breadcrumb } from '../core/detail-data.js';
import { raw } from '../core/sanitize.js';
import { PRIORITIES, TITLE_MAX } from '../core/task-form.js';
import { CHANTIER_NAME_MAX } from '../core/chantier-form.js';
import { label, statusLabel } from '../labels.js';
import { h } from '../ui/kit.js';
import { contributeursControl, dateControl, projetsControl, responsableControl } from './chantier-form.js';
import { attrs, field, peopleBlockHtml, refusedText } from './task-form.js';

const untitled = (s) => s || label('common.untitled');
const sel = (on) => raw(on ? 'selected' : '');
const chk = (on) => raw(on ? 'checked' : '');

/** Chemin « Projet › Chantier » d'une tâche ou d'un chantier. */
export function pathText(model, ref) {
  const path = breadcrumb(model, ref).filter((c) => c.kind !== 'categorie');
  return path.length ? path.map((c) => untitled(c.title)).join(' › ') : label('edit.empty');
}

/** Projet du chantier choisi (le chantier seul est affiché dans la liste fermée ; il peut être partagé). */
function targetHint(model, value) {
  const { chantierId, projectId } = parseTarget(value);
  if (!chantierId) return '';
  return h`<p class="fr-hint-text tf-hint" id="cf-cible-path">${label('create.field.cible.path', {
    chemin: `${untitled(model.projects.get(projectId)?.title)} › ${untitled(model.chantiers.get(chantierId)?.title)}`,
  })}</p>`;
}

/** Liste « chantier dans un projet » (valeur chantier:projet), groupée par projet du périmètre ISD. */
function targetSelect(st, model, current) {
  return h`<select id="cf-cible" class="fr-select" data-cf="cible" ${attrs(st, 'cible')}>
    <option value="" ${sel(!current)}>${label('create.field.cible.choose')}</option>
    ${chantierOptions(model).map(
      (g) =>
        h`<optgroup label="${untitled(g.project.title)}">${g.chantiers.map((c) => {
          const v = targetValue(c.id, g.project.id);
          return h`<option value="${v}" ${sel(v === current)}>${untitled(c.title)}</option>`;
        })}</optgroup>`,
    )}
  </select>${targetHint(model, current)}`;
}

/** Alerte de la fenêtre : refus, échec, résultat inconnu ; la saisie reste copiable. */
function alertHtml(st) {
  const f = st.fail;
  if (!f) return '';
  const text =
    f.kind === 'refused'
      ? label('form.fail.refused', { raison: refusedText(f.message) })
      : f.kind === 'session'
        ? label(`form.fail.session.${f.message === 'viewer' ? 'viewer' : 'flags'}`)
        : label(
            `create.fail.${['acl', 'unknown', 'changed', 'missing', 'reread'].includes(f.kind) ? f.kind : 'other'}`,
          );
  return h`<div class="fr-alert fr-alert--error fr-alert--sm tf-alert" role="alert" id="cf-alert" tabindex="-1">
    <p>${text}</p>
    ${f.kind === 'other' && f.message ? h`<details class="tf-tech"><summary>${label('form.fail.detail')}</summary><pre>${f.message}</pre></details>` : ''}
    ${f.copy ? h`<label class="fr-label" for="cf-copy">${label('form.fail.copy')}</label><textarea id="cf-copy" class="fr-input tf-copy" readonly rows="3">${f.copy}</textarea>` : ''}
  </div>`;
}

/** Aide du bloc « Personnes » de la fenêtre (plus courte que dans la fiche ; « Je suis… » proposé par défaut). */
export const peopleHelp = (st) =>
  st.me ? `${label('create.people.help')} ${label('create.people.helpMe')}` : label('create.people.help');

/**
 * Corps de « Nouvelle tâche » ou « Sous-tâche ». Bloc « Personnes » de la fiche (views/task-form.js) juste après
 * les dates : assignés et charges en ETP ou en heures, ETP recalculés quand les dates changent.
 */
export function newTaskBody(st, model) {
  const d = st.draft;
  const jalon = d.type === 'jalon';
  const parent = d.parentTask ? model.tasks.get(d.parentTask) : null;
  const date = (f, key = null) => field(st, f, dateControl(st, f), key ? { labelText: label(key) } : {});
  return h`<form class="tf cf" id="create-form" novalidate aria-describedby="cf-legend">
    ${alertHtml(st)}
    <p class="tf-legend" id="cf-legend">${label('form.legend')}</p>
    ${
      parent
        ? h`<dl class="dt-fields tf-readonly">
        <div class="dt-field"><dt>${label('create.field.parent')}</dt><dd>${untitled(parent.title)}</dd></div>
        <div class="dt-field"><dt>${label('form.field.rattachement')}</dt><dd>${pathText(model, { table: 'Tasks', id: parent.id })}</dd></div>
      </dl>
      <div class="tf-msgs" id="cf-parentTask-msgs" aria-live="polite">${st.validation.errors.parentTask ? h`<p class="fr-error-text tf-error">${label(st.validation.errors.parentTask.key)}</p>` : ''}</div>`
        : ''
    }
    ${field(st, 'titre', h`<input type="text" id="cf-titre" class="fr-input tf-title" value="${d.titre}" maxlength="${TITLE_MAX + 50}" required autocomplete="off" data-cf="titre" ${attrs(st, 'titre')}>`, { required: true })}
    ${parent ? '' : field(st, 'cible', targetSelect(st, model, targetValue(d.Chantier, d.projet)), { required: true, labelText: label('create.field.cible') })}
    <div class="tf-row">
      ${field(
        st,
        'statut',
        h`<select id="cf-statut" class="fr-select" data-cf="statut" ${attrs(st, 'statut')}>
          ${(model.statuses.tasks.includes(d.statut) ? model.statuses.tasks : [...model.statuses.tasks, d.statut]).map(
            (s) => h`<option value="${s}" ${sel(s === d.statut)}>${statusLabel(s)}</option>`,
          )}
        </select>`,
      )}
      <div class="tf-field tf-field--check fr-checkbox-group fr-checkbox-group--sm" data-field="type">
        <input type="checkbox" id="cf-type" data-cf="type" ${chk(jalon)} ${attrs(st, 'type')}>
        <label class="fr-label" for="cf-type">${label('form.field.jalon')}</label>
      </div>
    </div>
    <div class="tf-row">
      ${jalon ? date('dateEcheance', 'form.field.date') : h`${date('dateDebut')}${date('dateEcheance')}`}
    </div>
    ${peopleBlockHtml(st, model, { help: peopleHelp(st) })}
    <details class="tf-more" id="cf-more" ${raw(st.moreOpen ? 'open' : '')}>
      <summary class="tf-more__summary">${label('create.more')} <span class="tf-more__hint">(${label('create.more.hint.task')})</span></summary>
      <div class="tf-more__body">
        ${st.optional('Responsable') ? field(st, 'Responsable', responsableControl(st, model)) : ''}
        ${
          st.optional('priorite')
            ? h`<fieldset class="tf-field fr-segmented fr-segmented--sm" data-field="priorite">
          <legend class="fr-segmented__legend tf-label">${label('form.field.priorite')}</legend>
          <div class="fr-segmented__elements">
            ${[...PRIORITIES, ''].map(
              (p) => h`<div class="fr-segmented__element">
                <input type="radio" name="cf-priorite" id="cf-priorite-${p || 'none'}" value="${p}" data-cf="priorite" ${chk(d.priorite === p)} ${raw(st.busy ? 'disabled' : '')}>
                <label class="fr-label" for="cf-priorite-${p || 'none'}">${p || label('form.field.priorite.none')}</label>
              </div>`,
            )}
          </div>
        </fieldset>`
            : ''
        }
        ${st.optional('description') ? field(st, 'description', h`<textarea id="cf-description" class="fr-input tf-area" rows="3" data-cf="description" ${attrs(st, 'description')}>${d.description}</textarea>`, { wide: true }) : ''}
        <p class="tf-note">${label('create.task.after')}</p>
      </div>
    </details>
  </form>`;
}

/** Corps de « Nouveau chantier ». */
export function newChantierBody(st, model) {
  const d = st.draft;
  return h`<form class="tf cf" id="create-form" novalidate aria-describedby="cf-legend">
    ${alertHtml(st)}
    <p class="tf-legend" id="cf-legend">${label('form.legend')}</p>
    ${field(st, 'Nom_du_chantier', h`<input type="text" id="cf-Nom_du_chantier" class="fr-input tf-title" value="${d.Nom_du_chantier}" maxlength="${CHANTIER_NAME_MAX + 50}" required autocomplete="off" data-cf="Nom_du_chantier" ${attrs(st, 'Nom_du_chantier')}>`, { required: true })}
    ${field(st, 'Projets', projetsControl(st, model), { legend: true, required: true, hintAfter: label('create.field.Projets.help') })}
    ${field(
      st,
      'Statut',
      h`<select id="cf-Statut" class="fr-select" data-cf="Statut" ${attrs(st, 'Statut')}>
        ${(model.statuses.chantiers.includes(d.Statut)
          ? model.statuses.chantiers
          : [...model.statuses.chantiers, d.Statut]
        ).map((s) => h`<option value="${s}" ${sel(s === d.Statut)}>${s}</option>`)}
      </select>`,
    )}
    <div class="tf-row">
      ${field(st, 'Debut', dateControl(st, 'Debut'))}
      ${field(st, 'Fin', dateControl(st, 'Fin'))}
    </div>
    ${st.optional('Responsable') ? field(st, 'Responsable', responsableControl(st, model)) : ''}
    <details class="tf-more" id="cf-more" ${raw(st.moreOpen ? 'open' : '')}>
      <summary class="tf-more__summary">${label('create.more')} <span class="tf-more__hint">(${label('create.more.hint.chantier')})</span></summary>
      <div class="tf-more__body">
        ${st.optional('Contributeurs') ? field(st, 'Contributeurs', contributeursControl(st, model), { legend: true }) : ''}
        ${st.optional('Description') ? field(st, 'Description', h`<textarea id="cf-Description" class="fr-input tf-area" rows="3" data-cf="Description" ${attrs(st, 'Description')}>${d.Description}</textarea>`, { wide: true }) : ''}
        <p class="tf-note">${label('create.chantier.after')}</p>
      </div>
    </details>
  </form>`;
}

/** Corps de « Changer de chantier » : rattachement actuel, chantier d'arrivée, sous-tâches qui suivent. */
export function moveBody(st, model) {
  const task = model.tasks.get(st.taskId);
  return h`<form class="tf cf" id="create-form" novalidate>
    ${alertHtml(st)}
    <dl class="dt-fields tf-readonly">
      <div class="dt-field"><dt>${label('move.task')}</dt><dd>${untitled(task?.title)}</dd></div>
      <div class="dt-field"><dt>${label('move.current')}</dt><dd>${pathText(model, { table: 'Tasks', id: st.taskId })}</dd></div>
    </dl>
    ${field(st, 'cible', targetSelect(st, model, st.target), { required: true, labelText: label('move.target') })}
    <p class="fr-hint-text tf-hint" id="cf-follow" aria-live="polite">${
      st.count === 0
        ? label('move.follow.none')
        : label(st.count === 1 ? 'move.follow.one' : 'move.follow.many', { n: st.count })
    }</p>
  </form>`;
}

/** Résumé des erreurs et boutons du pied ; confirmation d'abandon de la saisie. */
export function dialogFoot(st, errorCount) {
  if (st.leave)
    return h`<div class="tf-foot tf-foot--leave" role="alert">
      <p class="tf-foot__text">${label('create.leave.title')}</p>
      <div class="tf-foot__actions">
        <button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary" data-cf-action="leave-continue" id="cf-leave-continue">${label('form.leave.continue')}</button>
        <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-cf-action="leave-discard" id="cf-leave-discard">${label('form.leave.discard')}</button>
      </div>
    </div>`;
  const dry = st.mode === 'dry-run';
  const off = raw(errorCount || st.busy || st.locked ? 'disabled' : '');
  const busy = st.busy ? label('create.busy') : '';
  const error = errorCount
    ? h`<span class="tf-foot__error">${errorCount === 1 ? label('form.error.summary.create') : label('form.error.summaryMany.create', { n: errorCount })}</span>`
    : h`<span class="tf-foot__hint">${busy || label(st.kind === 'move' ? 'move.shortcut' : 'create.shortcut')}</span>`;
  const actions =
    st.kind === 'move'
      ? h`<button type="button" class="fr-btn fr-btn--sm edit-primary" data-cf-action="submit" id="cf-submit" ${off}>${label(dry ? 'move.submit.dry' : 'move.submit')}</button>`
      : h`<button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-cf-action="create" id="cf-create" ${off}>${label(dry ? 'create.submit.dry' : 'create.submit')}</button>
        <button type="button" class="fr-btn fr-btn--sm create-primary" data-cf-action="create-open" id="cf-create-open" ${off}>${label(dry ? 'create.submitOpen.dry' : 'create.submitOpen')}</button>`;
  return h`<div class="tf-foot">
    <p class="tf-foot__text" id="cf-pending" aria-live="polite">${error}</p>
    <div class="tf-foot__actions">
      <button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary" data-cf-action="cancel" id="cf-cancel" ${raw(st.busy ? 'disabled' : '')}>${label('create.cancel')}</button>
      ${actions}
    </div>
  </div>`;
}
