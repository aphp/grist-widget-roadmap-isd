/**
 * Personnes de l'équipe ISD (lot 2d) : rendu seul (fragments h``) du formulaire de la fiche personne (tenu par
 * ui/task-editor.js), et des fenêtres « Ajouter une personne », « Indisponibilité » et « Désactiver » (tenues par
 * ui/person-dialog.js). Liste courte : nom, e-mail, APH, rôle (choix existants), capacité, N+1 ; Domaine en lecture.
 * L'APH n'est modifiable que si Team.aph est une colonne de données (sinon champ désactivé et raison affichée).
 */
import { APH_MAX_DIGITS, CAPACITY_MAX, isdDomainValue, n1Candidates, roleOptions } from '../core/person-form.js';
import { NAME_MAX } from '../core/grist-writer.js';
import { isEstimationAph } from '../core/estimation.js';
import { raw } from '../core/sanitize.js';
import { roleShort } from '../core/team-directory.js';
import { MAX_YEAR, MIN_YEAR, inputFromDay } from '../core/write-encode.js';
import { label } from '../labels.js';
import { h } from '../ui/kit.js';
import { alertHtml, attrs, field } from './task-form.js';

const untitled = (s) => s || label('common.untitled');
const sel = (on) => raw(on ? 'selected' : '');
const num = (v) => (v === null || v === undefined ? '' : String(v));

/** Libellé d'un rôle dans le menu : « PO (PO Data) » pour le sigle court, sinon tel quel. */
const roleOption = (r) => (roleShort(r) !== r ? `${roleShort(r)} (${r})` : r);

/** Menu des rôles : choix existants de la Feuille (jamais de nouveau rôle). */
export function roleControl(st, model, { add = false } = {}) {
  const p = st.prefix ?? 'tf';
  const cur = st.draft.role ?? '';
  const list = roleOptions(model, add ? '' : (st.base?.role ?? cur), { add });
  return h`<select id="${p}-role" class="fr-select" data-input="role" ${attrs(st, 'role', true)}>
    ${add ? h`<option value="" ${sel(!cur)} disabled>${label('form.field.role.choose')}</option>` : ''}
    ${!add && !cur ? h`<option value="" selected>${label('form.field.role.none')}</option>` : ''}
    ${list.map((r) => h`<option value="${r}" ${sel(r === cur)}>${roleOption(r)}</option>`)}
  </select>`;
}

/** Capacité hebdomadaire : nombre (virgule acceptée), vide = 35 h par défaut. */
export function capacityControl(st) {
  const p = st.prefix ?? 'tf';
  // Saisie invalide : affichée telle quelle (pour la corriger) ; sinon la valeur du brouillon
  const bad = st.badCapacity || st.bad?.has('capaciteHebdo');
  const v = bad ? (st.capacityInput ?? '') : num(st.draft.capaciteHebdo).replace('.', ',');
  return h`<input type="text" inputmode="decimal" id="${p}-capaciteHebdo" class="fr-input tf-num" value="${v}" placeholder="35" data-input="capaciteHebdo" ${attrs(st, 'capaciteHebdo', true)}>`;
}

/**
 * N+1 : sélection simple, Management de tous les Domaines d'abord, puis l'équipe ISD par profil ; la personne
 * elle-même n'est pas proposée. Une valeur actuelle hors de ces groupes reste affichée et sélectionnée.
 */
export function n1Control(st, model, personId = null) {
  const p = st.prefix ?? 'tf';
  const cur = st.draft.n_1;
  const { management, isd, kept } = n1Candidates(model, personId, cur);
  const opt = (x) => h`<option value="${x.id}" ${sel(x.id === cur)}>${untitled(x.nom)}</option>`;
  const keptOpt = kept
    ? h`<option value="${kept.id}" selected>${untitled(kept.person?.nom ?? `n° ${kept.id}`)} (${label(kept.inactive ? 'form.person.inactive' : 'form.person.unlisted')})</option>`
    : '';
  return h`<select id="${p}-n_1" class="fr-select" data-input="n_1" ${attrs(st, 'n_1')}>
    <option value="" ${sel(cur === null)}>${label('form.field.n_1.none')}</option>
    ${keptOpt}
    ${management.length ? h`<optgroup label="${label('form.group.management')}">${management.map(opt)}</optgroup>` : ''}
    ${isd.map((g) => h`<optgroup label="${label('form.group.isd', { profil: label(`profile.group.${g.role}`) })}">${g.people.map(opt)}</optgroup>`)}
  </select>`;
}

/** Champs communs de la fiche et de la création : nom, e-mail, APH, rôle, capacité, N+1. */
function personFields(st, model, { add, personId }) {
  const p = st.prefix ?? 'tf';
  const d = st.draft;
  const show = (f) => !add || st.optional?.(f) !== false;
  // APH de la personne estimation : en lecture (il se change dans la Feuille, jamais depuis le widget)
  const estimationRow = !add && isEstimationAph(model.people.get(personId)?.aph);
  const aphHelp = estimationRow
    ? label('person.error.aphEstimation')
    : label('form.field.aph.help', { max: APH_MAX_DIGITS });
  return h`
    ${field(st, 'nom', h`<input type="text" id="${p}-nom" class="fr-input tf-title" value="${d.nom}" maxlength="${NAME_MAX + 50}" required autocomplete="off" data-input="nom" ${attrs(st, 'nom')}>`, { required: true })}
    ${show('email') ? field(st, 'email', h`<input type="email" id="${p}-email" class="fr-input" value="${d.email}" autocomplete="off" spellcheck="false" data-input="email" ${attrs(st, 'email')}>`) : ''}
    ${show('aph') ? field(st, 'aph', h`<input type="text" inputmode="numeric" id="${p}-aph" class="fr-input tf-num" value="${d.aph ?? ''}" maxlength="${APH_MAX_DIGITS + 10}" autocomplete="off" spellcheck="false" data-input="aph" ${raw(estimationRow ? 'readonly' : '')} ${attrs(st, 'aph', true)}>`, { help: aphHelp }) : ''}
    ${field(st, 'role', roleControl(st, model, { add }), { required: add, help: label('form.field.role.help') })}
    ${show('capaciteHebdo') ? field(st, 'capaciteHebdo', capacityControl(st), { help: label('form.field.capaciteHebdo.help', { max: CAPACITY_MAX }) }) : ''}
    ${show('n_1') ? field(st, 'n_1', n1Control(st, model, personId)) : ''}`;
}

/** Corps du formulaire de la fiche personne (tiroir). */
export function personFormBody(st, model) {
  const person = model.people.get(st.ref.id);
  return h`<form class="tf" id="person-form" novalidate aria-describedby="tf-legend" data-person-id="${st.ref.id}">
    ${alertHtml(st, model)}
    <p class="tf-legend" id="tf-legend">${label('person.form.legend')}</p>
    ${personFields(st, model, { add: false, personId: st.ref.id })}
    <dl class="dt-fields tf-readonly">
      <div class="dt-field"><dt>${label('form.field.Domaine')}</dt><dd>${person?.domaine || label('team.noDomain')}</dd></div>
      <div class="dt-field"><dt>${label('form.field.actif')}</dt><dd>${label(person?.actif ? 'team.active' : 'team.inactive')}</dd></div>
    </dl>
  </form>`;
}

/** Fenêtre « Ajouter une personne » : Domaine ISD fixé, rôle parmi les profils ISD et Management. */
export function personAddBody(st, model) {
  return h`${alertHtml(st, model)}
    <p class="tf-legend">${label('personAdd.intro', { domaine: isdDomainValue(model) ?? '' })}</p>
    <div class="tf" id="pf-form">${personFields(st, model, { add: true, personId: null })}</div>`;
}

/** Champ date d'une indisponibilité. */
const dateControl = (st, f) =>
  h`<input type="date" id="pf-${f}" class="fr-input" min="${MIN_YEAR}-01-01" max="${MAX_YEAR}-12-31" value="${inputFromDay(st.draft[f])}" data-input="${f}" required ${attrs(st, f)}>`;

/** Fenêtre « Indisponibilité » (création ou modification) : dates, type, part disponible, commentaire. */
export function unavBody(st, model) {
  const d = st.draft;
  const pct = st.bad?.has('dispo')
    ? (st.dispoInput ?? '')
    : String(Math.round((d.dispo ?? 0) * 1000) / 10).replace('.', ',');
  const conflict = st.unavConflict
    ? h`<div class="fr-alert fr-alert--warning fr-alert--sm tf-alert" role="alert" id="pf-alert" tabindex="-1">
        <p>${label('unav.conflict', { champs: st.unavConflict.names })}</p>
        <div class="tf-alert__actions">
          <button type="button" class="fr-btn fr-btn--sm edit-primary" data-pd-action="conflict-mine">${label('unav.conflict.mine')}</button>
          <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-pd-action="conflict-theirs">${label('unav.conflict.theirs')}</button>
        </div>
      </div>`
    : '';
  return h`${conflict}${alertHtml(st, model)}
    <p class="tf-legend">${label('unav.for', { nom: untitled(model.people.get(st.personId)?.nom) })}</p>
    <div class="tf" id="pf-form">
      <div class="tf-row">
        ${field(st, 'dateDebut', dateControl(st, 'dateDebut'), { required: true })}
        ${field(st, 'dateFin', dateControl(st, 'dateFin'), { required: true })}
      </div>
      ${field(st, 'dispo', h`<input type="text" inputmode="decimal" id="pf-dispo" class="fr-input tf-num" value="${pct}" data-input="dispo" ${attrs(st, 'dispo', true)}>`, { help: label('form.field.dispo.help') })}
      ${field(st, 'type', h`<input type="text" id="pf-type" class="fr-input" value="${d.type}" maxlength="${NAME_MAX}" autocomplete="off" data-input="type" ${attrs(st, 'type', true)}>`, { labelText: label('form.field.unavType'), help: label('form.field.unavType.help') })}
      ${field(st, 'commentaire', h`<textarea id="pf-commentaire" class="fr-input tf-area" rows="2" data-input="commentaire" ${attrs(st, 'commentaire')}>${d.commentaire}</textarea>`, { wide: true })}
    </div>`;
}

/** Fenêtre « Désactiver » : ce qui change, ce qui reste intact, et comment réactiver. */
export function activeBody(st, model) {
  const nom = untitled(model.people.get(st.personId)?.nom);
  return h`${alertHtml(st, model)}
    <p>${label('active.off.body', { nom })}</p>
    <p class="fr-hint-text">${label('active.off.after')}</p>`;
}

/** Pied des fenêtres : confirmation avant d'abandonner une saisie, sinon Annuler et le bouton d'envoi. */
export function personDialogFoot(st, errorCount) {
  if (st.leave)
    return h`<div class="tf-foot tf-foot--leave" role="alert">
      <p class="tf-foot__text">${label('pd.leave.title')}</p>
      <div class="tf-foot__actions">
        <button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary" data-pd-action="leave-continue" id="pf-leave-continue">${label('form.leave.continue')}</button>
        <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-pd-action="leave-discard" id="pf-leave-discard">${label('form.leave.discard')}</button>
      </div>
    </div>`;
  const dry = st.mode === 'dry-run';
  const text = {
    add: dry ? 'personAdd.submit.dry' : 'personAdd.submit',
    'unav-add': dry ? 'unav.submit.add.dry' : 'unav.submit.add',
    'unav-edit': dry ? 'unav.submit.save.dry' : 'unav.submit.save',
    off: dry ? 'active.off.submit.dry' : 'active.off.submit',
  }[st.kind];
  const off = raw(errorCount || st.busy || st.locked || st.unavConflict ? 'disabled' : '');
  const hint = st.busy
    ? label('pd.busy')
    : errorCount
      ? errorCount === 1
        ? label('form.error.summary.create')
        : label('form.error.summaryMany.create', { n: errorCount })
      : st.kind === 'off'
        ? ''
        : label('pd.shortcut');
  return h`<div class="tf-foot">
    <p class="tf-foot__text" id="pf-pending" aria-live="polite"><span class="${raw(errorCount ? 'tf-foot__error' : 'tf-foot__hint')}">${hint}</span></p>
    <div class="tf-foot__actions">
      <button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary" data-pd-action="cancel" id="pf-cancel" ${raw(st.busy ? 'disabled' : '')}>${label('pd.cancel')}</button>
      <button type="button" class="fr-btn fr-btn--sm edit-primary" data-pd-action="submit" id="pf-submit" ${off} ${raw(st.busy ? 'aria-busy="true"' : '')}>${label(text)}</button>
    </div>
  </div>`;
}
