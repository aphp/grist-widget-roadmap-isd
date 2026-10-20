/**
 * Formulaire d'une tâche ou sous-tâche dans la fiche (lot 2a) : rendu seul (fragments h``), à partir de l'état
 * tenu par ui/task-editor.js. Liste courte de champs, le reste sous « Plus de champs » ; pied fixe
 * Enregistrer / Annuler. Bloc « Personnes » : assignés et charges en ETP ou en heures réunis ; rattachement et tags
 * en lecture.
 */
import {
  chargeRows,
  chargesSummary,
  etpDelta,
  etpOf,
  inputValue,
  maxHours,
  periodDays,
  readChargesCell,
} from '../core/charges-edit.js';
import { formatDateFr } from '../core/dates.js';
import { ETP_ROLES } from '../core/kanban-data.js';
import { priorityText, taskPriority } from '../core/kanban-data.js';
import { breadcrumb } from '../core/detail-data.js';
import { raw } from '../core/sanitize.js';
import { PRIORITIES, TITLE_MAX, parentCandidates, personCandidates, searchTasks } from '../core/task-form.js';
import { peopleLines } from '../core/task-people.js';
import { MAX_YEAR, MIN_YEAR, inputFromDay } from '../core/write-encode.js';
import { hasLabel, label, statusLabel } from '../labels.js';
import { isIsdTeamMember, pickerGroups } from '../core/team-directory.js';
import { h } from '../ui/kit.js';
import { addSubtaskButton, refList, roleBadge, section, statusMenu } from './detail.js';

const etpFormat = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const etpInputFormat = new Intl.NumberFormat('fr-FR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  useGrouping: false,
});
const hoursFormat = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1, useGrouping: false });
const shortDate = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const TRASH = raw(
  '<svg class="tf-charge__icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h1.5v-8H10Zm3.5 0v8H15v-8h-1.5Z"/></svg>',
);
const dayText = (d) => shortDate.format(new Date(d * 86400000));

/** Raison d'un refus du widget, en français (jamais le code brut). */
export function refusedText(reason) {
  const key = `form.refused.${reason}`;
  const text = label(key);
  return text === key ? label('form.refused.autre') : text;
}

const untitled = (s) => s || label('common.untitled');
const sel = (on) => raw(on ? 'selected' : '');
const chk = (on) => raw(on ? 'checked' : '');

/** Texte d'une valeur du brouillon (journal du mode essai, conflits). */
export function valueText(model, col, v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return label('edit.empty');
  if (['dateDebut', 'dateEcheance', 'dateCloture', 'Debut', 'Fin', 'dateFin'].includes(col)) return formatDateFr(v);
  if (col === 'Responsable' || col === 'n_1' || col === 'membre') return model.people.get(v)?.nom || `n° ${v}`;
  if (col === 'actif') return label(v ? 'edit.yes' : 'edit.no');
  if (col === 'capaciteHebdo') return label('edit.hoursWeek', { h: String(v).replace('.', ',') });
  if (col === 'dispo') return `${Math.round(v * 1000) / 10} %`.replace('.', ',');
  if (col === 'assignees' || col === 'Contributeurs')
    return v.map((id) => model.people.get(id)?.nom || `n° ${id}`).join(', ');
  if (col === 'Projets') return v.map((id) => untitled(model.projects.get(id)?.title ?? `n° ${id}`)).join(', ');
  if (col === 'projet') return untitled(model.projects.get(v)?.title ?? `n° ${v}`);
  if (col === 'Chantier') return untitled(model.chantiers.get(v)?.title ?? `n° ${v}`);
  if (col === 'parentTask') return untitled(model.tasks.get(v)?.title);
  if (col === 'dependDe') return v.map((id) => untitled(model.tasks.get(id)?.title)).join(', ');
  if (col === 'statut') return statusLabel(v);
  if (col === 'progression') return `${v} %`;
  if (col === 'charges') return chargesText(model, v);
  return String(v);
}

/** Nom affiché d'une personne d'une charge (absente de l'équipe : son numéro). */
const chargeName = (model, id) =>
  model.people.has(id) ? untitled(model.people.get(id).nom) : label('form.charges.unknown', { id });

/** Charges en texte (journal, conflits, saisie à copier). */
function chargesText(model, raw) {
  const cell = readChargesCell(raw);
  if (!cell.ok) return label('form.charges.valueUnreadable', { texte: cell.raw });
  const { rows } = chargeRows(cell.entries);
  if (!rows.length) return label('edit.empty');
  return rows
    .map((r) => label('form.charges.valueText', { nom: chargeName(model, r.teamId), h: hoursFormat.format(r.heures) }))
    .join(', ');
}

/** Libellé court d'une colonne du formulaire. */
export const fieldLabel = (col, table = '') =>
  label(
    col === 'type' ? (table === 'Disponibilites' ? 'form.field.unavType' : 'form.field.jalon') : `form.field.${col}`,
  );

/** Messages (erreur bloquante, avertissements, raison de lecture seule) sous un champ. */
export function messagesHtml(st, field) {
  const err = st.validation.errors[field];
  const warns = st.validation.warnings.filter((w) => w.field === field);
  const why = st.can(field).ok ? null : st.can(field).reason;
  return h`${err ? h`<p class="fr-error-text tf-error">${label(err.key, err.vars)}</p>` : ''}${warns.map(
    (w) => h`<p class="tf-warn">${label(w.key, w.vars)}</p>`,
  )}${why ? h`<p class="tf-locked">${label(`form.col.${why}`)}</p>` : ''}${
    err?.key === 'form.error.locked'
      ? h`<button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary tf-revert" data-revert="${field}">${label('form.revert', { champ: fieldLabel(field) })}</button>`
      : ''
  }`;
}

/** Préfixe des identifiants du formulaire (« tf » dans la fiche, « cf » dans une fenêtre de création). */
const pre = (st) => st.prefix ?? 'tf';

/** Enveloppe d'un champ : libellé, contrôle, aide, messages reliés par aria-describedby. */
export function field(st, f, control, opts = {}) {
  const err = Boolean(st.validation.errors[f]);
  const p = pre(st);
  const required = opts.required
    ? h`<span class="tf-req" aria-hidden="true"> *</span><span class="fr-sr-only"> (${label('form.required')})</span>`
    : '';
  return h`<div class="tf-field fr-input-group ${raw(err ? 'fr-input-group--error' : '')} ${raw(opts.wide ? 'tf-field--wide' : '')}" data-field="${f}" ${raw(opts.legend ? `role="group" aria-labelledby="${p}-${f}-label"` : '')}>
    ${opts.legend ? h`<p class="fr-label tf-label" id="${p}-${f}-label">${opts.labelText ?? fieldLabel(f)}${required}</p>` : h`<label class="fr-label tf-label" for="${p}-${f}">${opts.labelText ?? fieldLabel(f)}${required}${opts.help ? h`<span class="fr-hint-text" id="${p}-${f}-help">${opts.help}</span>` : ''}</label>`}
    ${control}
    ${opts.hintAfter ? h`<p class="fr-hint-text tf-hint" id="${p}-${f}-help">${opts.hintAfter}</p>` : ''}
    <div class="tf-msgs" id="${p}-${f}-msgs" aria-live="polite">${messagesHtml(st, f)}</div>
  </div>`;
}

/** Attributs communs des contrôles : désactivé si la colonne n'est pas modifiable, description, état d'erreur. */
export function attrs(st, f, help = false) {
  const off = !st.can(f).ok || st.busy;
  const p = pre(st);
  const ids = [help ? `${p}-${f}-help` : '', `${p}-${f}-msgs`].filter(Boolean).join(' ');
  return raw(
    `${off ? 'disabled' : ''} aria-describedby="${ids}" ${st.validation.errors[f] ? 'aria-invalid="true"' : ''}`,
  );
}

/**
 * Options de personnes : équipe ISD active seulement. Une valeur déjà choisie hors de ces groupes (personne hors
 * ISD posée via la Feuille de route, ou inactive) reste une option sélectionnée « Nom (hors ISD) » / « (inactif) ».
 */
export function personGroups(model, selectedIds, exclude = []) {
  const { kept } = personCandidates(model, selectedIds);
  const skip = new Set(exclude);
  const opt = (p) => h`<option value="${p.id}" ${sel(selectedIds.includes(p.id))}>${untitled(p.nom)}</option>`;
  const isd = pickerGroups(model).map((g) => {
    const list = g.people.filter((p) => !skip.has(p.id));
    return list.length
      ? h`<optgroup label="${label('form.group.isd', { profil: label(`profile.group.${g.role}`) })}">${list.map(opt)}</optgroup>`
      : '';
  });
  const current = kept
    .filter((id) => !skip.has(id))
    .map((id) => {
      const p = model.people.get(id);
      const note = label(p && isIsdTeamMember(model, p) ? 'form.person.inactive' : 'form.person.outside');
      return h`<option value="${id}" selected>${untitled(p?.nom ?? `n° ${id}`)} (${note})</option>`;
    });
  return h`${current}${isd}`;
}

export function personChip(model, id, removable, data) {
  const p = model.people.get(id);
  const name = untitled(p?.nom ?? `n° ${id}`);
  return h`<li class="tf-chip">
    <span class="tf-chip__text">${name}${p ? roleBadge(model, p) : ''}</span>
    ${removable ? h`<button type="button" class="tf-chip__remove" ${raw(data)}="${id}" title="${label('form.field.remove', { nom: name })}" aria-label="${label('form.field.remove', { nom: name })}">✕</button>` : ''}
  </li>`;
}

/** Résultats de la recherche de dépendances (mis à jour sans redessiner le formulaire). */
export function depResultsHtml(st, model) {
  const q = st.depQuery.trim();
  if (q.length < 2) return '';
  const ids = searchTasks(model, st.ref.id, q, st.draft.dependDe);
  if (!ids.length) return h`<p class="tf-empty">${label('form.field.dependDe.noResult')}</p>`;
  return h`<ul class="list tf-results">${ids.map((id) => {
    const t = model.tasks.get(id);
    return h`<li><button type="button" class="tf-result" data-add-dep="${id}" aria-label="${label('form.field.dependDe.add', { titre: untitled(t.title) })}">
      <span class="tf-result__title">${untitled(t.title)}</span><span class="tf-result__meta">${statusLabel(t.status)}</span></button></li>`;
  })}</ul>`;
}

/** Clé d'un message propre au chantier (« Ce chantier… ») quand elle existe, sinon celle de la tâche. */
const ITEM_SUFFIX = Object.freeze({ Chantiers: 'chantier', Team: 'personne', Disponibilites: 'unav' });
const itemKey = (st, key) => {
  const suffix = ITEM_SUFFIX[st.ref?.table ?? st.table];
  return suffix && hasLabel(`${key}.${suffix}`) ? `${key}.${suffix}` : key;
};

export function alertHtml(st, model) {
  if (st.conflict) {
    const c = st.conflict;
    return h`<div class="fr-alert fr-alert--warning fr-alert--sm tf-alert" role="alert" id="tf-alert" tabindex="-1">
      <h3 class="fr-alert__title">${label('form.conflict.title')}</h3>
      <p>${label('form.conflict.body')}</p>
      ${c.cols.map(
        (col) => h`<fieldset class="tf-conflict"><legend>${fieldLabel(col)}</legend>
          <div class="fr-radio-group fr-radio-group--sm"><input type="radio" id="tf-cf-${col}-mine" name="tf-cf-${col}" value="mine" data-conflict="${col}" ${chk(c.choices[col] !== 'theirs')}>
            <label class="fr-label" for="tf-cf-${col}-mine">${label('form.conflict.mine', { valeur: valueText(model, col, col in c.mine ? c.mine[col] : st.draft[col]) })}</label></div>
          <div class="fr-radio-group fr-radio-group--sm"><input type="radio" id="tf-cf-${col}-theirs" name="tf-cf-${col}" value="theirs" data-conflict="${col}" ${chk(c.choices[col] === 'theirs')}>
            <label class="fr-label" for="tf-cf-${col}-theirs">${label('form.conflict.theirs', { valeur: valueText(model, col, c.fresh[col]) })}</label></div>
        </fieldset>`,
      )}
      <div class="tf-alert__actions">
        <button type="button" class="fr-btn fr-btn--sm edit-primary" data-form="conflict-apply">${label('form.conflict.apply')}</button>
        <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-form="conflict-cancel">${label('form.conflict.cancel')}</button>
      </div>
    </div>`;
  }
  if (st.fail?.kind === 'session' || st.fail?.kind === 'unknown') {
    const f = st.fail;
    const session = f.kind === 'session';
    const text = session
      ? label(`form.fail.session.${f.message === 'viewer' ? 'viewer' : 'flags'}`)
      : label(itemKey(st, f.reread ? 'form.fail.unknown' : 'form.fail.unknownNoRead'));
    return h`<div class="fr-alert fr-alert--error fr-alert--sm tf-alert" role="alert" id="tf-alert" tabindex="-1">
      <p>${text}</p>
      ${
        !session && f.reread
          ? h`<ul class="tf-unknown">${f.lines.map(
              (l) =>
                h`<li>${label(l.feuille === l.saisie ? 'form.unknown.same' : 'form.unknown.diff', { champ: l.champ, feuille: l.feuille, saisie: l.saisie })}</li>`,
            )}</ul>`
          : ''
      }
      ${f.copy ? h`<label class="fr-label" for="tf-copy">${label('form.fail.copy')}</label><textarea id="tf-copy" class="fr-input tf-copy" readonly rows="4">${f.copy}</textarea>` : ''}
    </div>`;
  }
  if (st.fail) {
    const f = st.fail;
    const text =
      f.kind === 'refused'
        ? label('form.fail.refused', { raison: refusedText(f.message) })
        : label(itemKey(st, `form.fail.${['acl', 'missing', 'reread'].includes(f.kind) ? f.kind : 'other'}`));
    return h`<div class="fr-alert ${raw(f.kind === 'reread' ? 'fr-alert--warning' : 'fr-alert--error')} fr-alert--sm tf-alert" role="alert" id="tf-alert" tabindex="-1">
      <p>${text}</p>
      ${
        st.confirmNoCheck
          ? h`<div class="tf-alert__actions">
        <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-form="save">${label('form.fail.retry')}</button>
        <button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary" data-form="save-nocheck">${label('form.reread.force')}</button>
        <button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary-no-outline" data-form="nocheck-cancel">${label('form.conflict.cancel')}</button>
      </div>`
          : ''
      }
      ${f.kind !== 'reread' && f.copy ? h`<label class="fr-label" for="tf-copy">${label('form.fail.copy')}</label><textarea id="tf-copy" class="fr-input tf-copy" readonly rows="4">${f.copy}</textarea>` : ''}
      ${
        f.kind === 'other'
          ? h`<details class="tf-tech"><summary>${label('form.fail.detail')}</summary><pre>${f.message}</pre></details>
        <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-form="save">${label('form.fail.retry')}</button>`
          : ''
      }
    </div>`;
  }
  if (st.changedElsewhere)
    return h`<div class="fr-alert fr-alert--info fr-alert--sm tf-alert" role="status"><p>${label(itemKey(st, 'form.changedElsewhere'))}</p></div>`;
  return '';
}

/**
 * Une ligne du bloc « Personnes » : nom et profil (« non assignée » et « Assigner » pour une charge sans
 * assignation), charge facultative dans l'unité choisie, équivalent, retrait (assignation et charge), messages.
 * @param {{teamId:number, assigned:boolean, charged:boolean, heures:number|null, count:number, known:boolean}} l
 */
function personLineHtml(st, model, l, ctx) {
  const id = l.teamId;
  const p = model.people.get(id);
  const name = chargeName(model, id);
  const etpMode = st.chargesUnit === 'etp';
  const blocked = !ctx.readable || !ctx.canCharges || l.count > 1 || !l.known || (etpMode && !ctx.days);
  const value = !l.charged
    ? ''
    : etpMode
      ? ctx.days
        ? etpInputFormat.format(inputValue(l.heures, 'etp', ctx.days))
        : ''
      : hoursFormat.format(l.heures);
  const typed = st.chargeInputs.get(id);
  const err = st.chargeErrors.get(id);
  const unit = label(`form.charges.unit.${st.chargesUnit}`);
  // Retirer touche l'assignation et/ou la charge : chaque colonne concernée doit être modifiable
  const canRemove =
    (!l.assigned || ctx.canAssign) && (!l.charged || (ctx.canCharges && ctx.readable)) && (l.assigned || l.charged);
  return h`<li class="tf-charge tf-person ${raw(l.assigned ? '' : 'tf-person--unassigned')}" data-charge="${id}">
    <span class="tf-charge__who">${name}${p ? roleBadge(model, p, true) : ''}${
      l.assigned
        ? ''
        : h` <span class="tf-person__flag" id="tf-person-${id}-flag">${label('form.people.unassigned')}</span>${
            ctx.canAssign
              ? h`<button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary tf-person__assign" id="tf-person-${id}-assign" data-person-assign="${id}" aria-label="${label('form.people.assignLabel', { nom: name })}">${label('form.people.assign')}</button>`
              : ''
          }`
    }</span>
    ${
      ctx.readable
        ? h`<span class="tf-charge__value">
      <label class="fr-sr-only" for="tf-ch-${id}">${label('form.people.inputLabel', { nom: name, unite: unit })}</label>
      <input type="text" inputmode="decimal" id="tf-ch-${id}" class="fr-input tf-num tf-charge__input" value="${typed ?? value}" placeholder="—" data-charge-input="${id}" autocomplete="off" aria-describedby="tf-ch-${id}-msg" ${raw(blocked ? 'disabled' : '')} ${raw(err ? 'aria-invalid="true"' : '')}>
      <span class="tf-charge__unit">${unit}</span>
      <span class="tf-charge__eq" id="tf-ch-${id}-eq">${l.charged ? chargeEqText(st, l.heures, ctx.days) : ''}</span>
    </span>`
        : h`<span></span>`
    }
    ${canRemove ? h`<button type="button" class="tf-charge__remove fr-btn fr-btn--sm fr-btn--tertiary-no-outline" id="tf-person-${id}-remove" data-person-remove="${id}" title="${label('form.people.remove', { nom: name })}" aria-label="${label('form.people.remove', { nom: name })}">${TRASH}</button>` : h`<span></span>`}
    <div class="tf-charge__msgs" id="tf-ch-${id}-msg" aria-live="polite">${chargeRowMsgs(st, model, l, ctx)}</div>
  </li>`;
}

/** Équivalent de la saisie dans l'autre unité (« = 70 h » en ETP, « = 1,0 ETP » en heures). */
export function chargeEqText(st, heures, days) {
  if (st.chargesUnit === 'etp') return days ? label('form.charges.eqHours', { h: hoursFormat.format(heures) }) : '';
  return days
    ? label('form.charges.eqEtp', { valeur: etpFormat.format(etpOf(heures, days)) })
    : label('form.charges.eqNone');
}

/**
 * Écart d'ETP d'une ligne (Q8 A) : période de référence = celle de la dernière saisie de la ligne dans ce
 * formulaire, sinon celle de la tâche à l'ouverture. Aucun écart pour une ligne sans charge.
 */
const rowDelta = (st, l, ctx) =>
  l.heures === null
    ? null
    : etpDelta(l.heures, st.chargeRefDays?.has(l.teamId) ? st.chargeRefDays.get(l.teamId) : ctx.baseDays, ctx.days);

/** Messages d'une ligne : saisie invalide, plafond, doublon à fusionner, personne absente, écart d'ETP (Q8). */
export function chargeRowMsgs(st, model, l, ctx, delta = rowDelta(st, l, ctx)) {
  const err = st.chargeErrors.get(l.teamId);
  const from = delta ? etpFormat.format(delta.from) : '';
  const to = delta ? etpFormat.format(delta.to) : '';
  const errKey = err?.error === 'max' && !ctx.days ? 'maxNoDates' : err?.error;
  const over = ctx.days && l.heures !== null && l.heures > maxHours(ctx.days) && !err;
  return h`${err ? h`<p class="fr-error-text tf-error">${label(`form.charges.error.${errKey}`, { h: hoursFormat.format(err.max ?? 0) })}</p>` : ''}${
    over ? h`<p class="tf-warn">${label('form.charges.over', { h: hoursFormat.format(maxHours(ctx.days)) })}</p>` : ''
  }${
    l.count > 1
      ? h`<p class="tf-warn">${label('form.charges.duplicate', { n: l.count })}</p>${ctx.canCharges ? h`<button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary" data-charge-merge="${l.teamId}">${label('form.charges.merge', { n: l.count })}</button>` : ''}`
      : ''
  }${model.people.has(l.teamId) || !l.charged ? '' : h`<p class="tf-warn">${label('form.charges.unknownHelp')}</p>`}${
    delta && from !== to
      ? h`<p class="tf-charge__delta">${label('form.charges.delta', { avant: from, apres: to })}</p>`
      : ''
  }`;
}

/** Pied du bloc : total en heures et en ETP, ETP par profil, période (rien sans charge). */
export function chargesFootHtml(st, model) {
  const cell = readChargesCell(st.draft.charges);
  const rows = cell.ok ? chargeRows(cell.entries).rows : [];
  if (!rows.length) return '';
  const { hours, days, byRole } = chargesSummary(model, rows, st.draft.dateDebut, st.draft.dateEcheance);
  const parts = byRole
    ? [...ETP_ROLES, 'Autre']
        .filter((k) => byRole[k] > 0.0005)
        .map(
          (k) => `${k === 'Autre' ? label('kanban.etpOther') : label(`profile.${k}`)} ${etpFormat.format(byRole[k])}`,
        )
    : [];
  const period = !days
    ? label('form.charges.periodNone')
    : days === 1
      ? label('form.charges.periodOne', { debut: dayText(st.draft.dateDebut) })
      : label('form.charges.period', {
          n: days,
          debut: dayText(st.draft.dateDebut),
          fin: dayText(st.draft.dateEcheance),
        });
  return h`<strong>${label('form.charges.total', { h: hoursFormat.format(hours) })}</strong>${
    byRole ? h` · <strong>${label('form.charges.totalEtp', { valeur: etpFormat.format(byRole.total) })}</strong>` : ''
  }${parts.length ? h` (${parts.join(' · ')})` : ''} · ${period}`;
}

/** Contexte de rendu des lignes : droits par colonne, lisibilité des charges, périodes. */
export function peopleCtx(st) {
  const cell = readChargesCell(st.draft.charges);
  return {
    readable: cell.ok,
    canAssign: st.can('assignees').ok && !st.busy,
    canCharges: st.can('charges').ok && !st.busy,
    days: periodDays(st.draft.dateDebut, st.draft.dateEcheance),
    baseDays: periodDays(st.base.dateDebut, st.base.dateEcheance),
  };
}

/**
 * Bloc « Personnes » (assignés et charges réunis) : une ligne par personne, bascule « Saisir en : ETP | heures »,
 * « Ajouter une personne… » (l'assigne ; charge facultative), pied (total, ETP par profil, période). Cellule de
 * charges illisible : les assignés restent modifiables, les charges sont bloquées, contenu montré et remplacement
 * par une saisie vide après confirmation.
 */
export function peopleBlockHtml(st, model) {
  const ctx = peopleCtx(st);
  const { readable, cell, invalid, lines } = peopleLines(model, st.draft.assignees, st.draft.charges);
  const err = Boolean(st.validation.errors.charges || st.validation.errors.assignees);
  const unitToggle = h`<fieldset class="fr-segmented fr-segmented--sm fr-segmented--no-legend tf-charges__unit">
      <legend class="fr-segmented__legend">${label('form.charges.unit')}</legend>
      <div class="fr-segmented__elements">${['etp', 'heures'].map(
        (u) => h`<div class="fr-segmented__element">
          <input type="radio" name="tf-charges-unit" id="tf-charges-unit-${u}" value="${u}" data-charges-unit ${chk(st.chargesUnit === u)}>
          <label class="fr-label" for="tf-charges-unit-${u}">${label(`form.charges.unit.${u}`)}</label>
        </div>`,
      )}</div>
    </fieldset>`;
  const unreadable = readable
    ? ''
    : h`<div class="tf-charges__unreadable">
      <p class="tf-warn">${label(cell.error === 'perte' ? 'form.charges.lossy' : 'form.charges.unreadable')}</p>
      <p class="tf-sublabel">${label('form.charges.unreadableRaw')}</p>
      <pre class="tf-charges__raw">${cell.raw}</pre>
      ${
        !ctx.canCharges
          ? ''
          : st.confirmReplace
            ? h`<p class="tf-charges__ask" role="alert">${label('form.charges.replaceAsk')}</p>
              <div class="tf-alert__actions">
                <button type="button" class="fr-btn fr-btn--sm edit-primary" data-charges="replace-confirm" id="tf-charges-replace-confirm">${label('form.charges.replaceConfirm')}</button>
                <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-charges="replace-cancel">${label('form.charges.replaceCancel')}</button>
              </div>`
            : h`<button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-charges="replace-ask" id="tf-charges-replace">${label('form.charges.replace')}</button>`
      }
    </div>`;
  return h`<section class="tf-field tf-charges tf-people ${raw(err ? 'fr-input-group--error' : '')}" id="tf-people" data-field="charges" aria-labelledby="tf-people-title">
    <div class="tf-charges__head">
      <h3 class="dt-section__title tf-charges__title" id="tf-people-title" tabindex="-1">${label('form.field.people')}</h3>
      ${readable ? unitToggle : ''}
    </div>
    <p class="fr-hint-text tf-hint">${label('form.people.help')} ${label('form.charges.help')}</p>
    ${readable && st.chargesUnit === 'etp' && !ctx.days ? h`<p class="tf-charges__nodates" id="tf-charges-nodates">${label('form.charges.noDates')}</p>` : ''}
    ${lines.length ? h`<ul class="list tf-charges__rows" aria-labelledby="tf-people-title">${lines.map((l) => personLineHtml(st, model, l, ctx))}</ul>` : h`<p class="tf-empty">${label('form.people.empty')}</p>`}
    ${invalid.map(
      (i) =>
        h`<p class="tf-charges__invalid">${
          i.teamId !== null
            ? label('form.charges.invalidPerson', { nom: chargeName(model, i.teamId), texte: i.text })
            : label('form.charges.invalid', { texte: i.text })
        }</p>`,
    )}
    ${unreadable}
    ${
      ctx.canAssign
        ? h`<div class="tf-charges__add">
      <label class="fr-sr-only" for="tf-assignees">${label('form.people.addLabel')}</label>
      <select id="tf-assignees" class="fr-select tf-add" data-person-add aria-describedby="tf-assignees-msgs">
        <option value="" selected>${label('form.people.add')}</option>
        ${personGroups(
          model,
          [],
          lines.map((l) => l.teamId),
        )}
      </select>
    </div>`
        : ''
    }
    ${readable ? h`<p class="tf-charges__foot" id="tf-charges-foot" aria-live="polite">${chargesFootHtml(st, model)}</p>` : ''}
    <div class="tf-msgs" id="tf-assignees-msgs" aria-live="polite">${messagesHtml(st, 'assignees')}</div>
    <div class="tf-msgs" id="tf-charges-msgs" aria-live="polite">${messagesHtml(st, 'charges')}</div>
  </section>`;
}

/** Corps du formulaire. */
export function taskFormBody(st, model) {
  const task = model.tasks.get(st.ref.id);
  const d = st.draft;
  const jalon = d.type === 'jalon';
  const path = breadcrumb(model, st.ref).filter((c) => c.kind !== 'categorie');
  const inherited = d.priorite ? '' : priorityText(taskPriority(model, { ...task, priorite: '' }));
  const parents = parentCandidates(model, st.ref.id);
  if (d.parentTask !== null && !parents.includes(d.parentTask)) parents.unshift(d.parentTask);
  const tref = (i) => ({ table: 'Tasks', id: i });
  const subs = task.childIds.filter((i) => model.tasks.has(i)).map(tref);
  const date = (f, labelKey = null) =>
    field(
      st,
      f,
      h`<input type="date" id="tf-${f}" class="fr-input" min="${MIN_YEAR}-01-01" max="${MAX_YEAR}-12-31" value="${inputFromDay(d[f])}" data-input="${f}" ${attrs(st, f)}>`,
      labelKey ? { labelText: label(labelKey) } : {},
    );
  return h`<form class="tf" id="task-form" novalidate aria-describedby="tf-legend" data-task-id="${st.ref.id}">
    ${alertHtml(st, model)}
    <p class="tf-legend" id="tf-legend">${label('form.legend')}</p>
    ${field(st, 'titre', h`<input type="text" id="tf-titre" class="fr-input tf-title" value="${d.titre}" maxlength="${TITLE_MAX + 50}" required data-input="titre" ${attrs(st, 'titre')}>`, { required: true })}
    <div class="tf-row">
      ${field(st, 'statut', statusMenu(model.statuses.tasks, d.statut, !st.can('statut').ok || st.busy), {
        legend: true,
        hintAfter: label('form.field.statut.help'),
      })}
      <div class="tf-field tf-field--check fr-checkbox-group fr-checkbox-group--sm" data-field="type">
        <input type="checkbox" id="tf-type" data-input="type" ${chk(jalon)} ${attrs(st, 'type')}>
        <label class="fr-label" for="tf-type">${label('form.field.jalon')}</label>
        <div class="tf-msgs" id="tf-type-msgs" aria-live="polite">${messagesHtml(st, 'type')}</div>
      </div>
    </div>
    <div class="tf-row">
      ${jalon ? date('dateEcheance', 'form.field.date') : h`${date('dateDebut')}${date('dateEcheance')}`}
    </div>
    <fieldset class="tf-field fr-segmented fr-segmented--sm" data-field="priorite" aria-describedby="tf-priorite-msgs">
      <legend class="fr-segmented__legend tf-label">${label('form.field.priorite')}</legend>
      <div class="fr-segmented__elements">
        ${[...PRIORITIES, ''].map(
          (p) => h`<div class="fr-segmented__element">
            <input type="radio" name="tf-priorite" id="tf-priorite-${p || 'none'}" value="${p}" data-input="priorite" ${chk(d.priorite === p)} ${raw(!st.can('priorite').ok || st.busy ? 'disabled' : '')}>
            <label class="fr-label" for="tf-priorite-${p || 'none'}">${p || label('form.field.priorite.none')}</label>
          </div>`,
        )}
      </div>
      ${inherited ? h`<p class="fr-hint-text tf-inherited">${label('form.field.priorite.inherited', { valeur: inherited })}</p>` : ''}
      <div class="tf-msgs" id="tf-priorite-msgs" aria-live="polite">${messagesHtml(st, 'priorite')}</div>
    </fieldset>
    ${field(
      st,
      'Responsable',
      h`<select id="tf-Responsable" class="fr-select" data-input="Responsable" ${attrs(st, 'Responsable')}>
        <option value="" ${sel(d.Responsable === null)}>${label('form.field.Responsable.none')}</option>
        ${personGroups(model, d.Responsable === null ? [] : [d.Responsable])}
      </select>`,
    )}
    <dl class="dt-fields tf-readonly">
      <div class="dt-field tf-attach"><dt>${label('form.field.rattachement')}</dt><dd>
        <span class="tf-attach__path" id="tf-attach-path">${path.length ? path.map((c) => c.title || label('common.untitled')).join(' › ') : label('edit.empty')}</span>
        ${
          st.canMove
            ? h`<button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary tf-attach__change" id="tf-move" data-move-open aria-describedby="tf-attach-path" ${raw(st.busy ? 'disabled' : '')}>${label('move.open')}</button>`
            : task.parentId
              ? h`<span class="tf-hint tf-attach__hint">${label('move.followsParent')}</span>`
              : ''
        }
      </dd></div>
      <div class="dt-field"><dt>${label('form.field.tags')}</dt><dd>${task.tags.length ? h`<span class="tf-tags">${task.tags.map((t) => h`<span class="fr-tag fr-tag--sm">${t}</span>`)}</span>` : label('form.field.tags.none')}</dd></div>
    </dl>
    <p class="tf-note">${label('form.later')}</p>
    ${peopleBlockHtml(st, model)}
    <details class="tf-more" id="tf-more" ${raw(st.moreOpen ? 'open' : '')}>
      <summary class="tf-more__summary">${label('form.more')} <span class="tf-more__hint">(${label('form.more.hint')})</span></summary>
      <div class="tf-more__body">
        ${field(st, 'description', h`<textarea id="tf-description" class="fr-input tf-area" rows="4" data-input="description" ${attrs(st, 'description')}>${d.description}</textarea>`, { wide: true })}
        ${field(st, 'Commentaire', h`<textarea id="tf-Commentaire" class="fr-input tf-area" rows="3" data-input="Commentaire" ${attrs(st, 'Commentaire')}>${d.Commentaire}</textarea>`, { wide: true })}
        ${field(st, 'Lien_utile', h`<input type="url" id="tf-Lien_utile" class="fr-input" value="${d.Lien_utile}" inputmode="url" data-input="Lien_utile" ${attrs(st, 'Lien_utile', true)}>`, { help: label('form.field.Lien_utile.help') })}
        ${field(st, 'progression', h`<input type="number" id="tf-progression" class="fr-input tf-num" min="0" max="100" step="1" value="${d.progression ?? ''}" data-input="progression" ${attrs(st, 'progression', true)}>`, { help: label('form.field.progression.help') })}
        ${field(
          st,
          'parentTask',
          h`<select id="tf-parentTask" class="fr-select" data-input="parentTask" ${attrs(st, 'parentTask', true)}>
            <option value="" ${sel(d.parentTask === null)}>${label('form.field.parentTask.none')}</option>
            ${parents.map((id) => h`<option value="${id}" ${sel(id === d.parentTask)}>${untitled(model.tasks.get(id)?.title ?? `n° ${id}`)}</option>`)}
          </select>`,
          { help: label('form.field.parentTask.help') },
        )}
        ${field(
          st,
          'dependDe',
          h`${
            d.dependDe.length
              ? h`<ul class="list tf-chips tf-chips--tasks" aria-label="${label('form.field.dependDe')}">${d.dependDe.map(
                  (id) => {
                    const name = untitled(model.tasks.get(id)?.title ?? `n° ${id}`);
                    return h`<li class="tf-chip"><span class="tf-chip__text">${name}</span>${st.can('dependDe').ok && !st.busy ? h`<button type="button" class="tf-chip__remove" data-remove-dep="${id}" title="${label('form.field.remove', { nom: name })}" aria-label="${label('form.field.remove', { nom: name })}">✕</button>` : ''}</li>`;
                  },
                )}</ul>`
              : h`<p class="tf-empty">${label('form.field.dependDe.none')}</p>`
          }
          <label class="fr-label tf-sublabel" for="tf-dep-search">${label('form.field.dependDe.search')}<span class="fr-hint-text">${label('form.field.dependDe.searchHelp')}</span></label>
          <input type="search" id="tf-dep-search" class="fr-input" autocomplete="off" value="${st.depQuery}" data-dep-search ${attrs(st, 'dependDe')}>
          <div id="tf-dep-results" aria-live="polite">${depResultsHtml(st, model)}</div>`,
          { legend: true, wide: true },
        )}
        <div class="tf-row">
          ${date('dateCloture')}
          ${d.dateCloture !== null && st.can('dateCloture').ok ? h`<button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary tf-clear" data-form="clear-closure" ${raw(st.busy ? 'disabled' : '')}>${label('form.field.dateCloture.clear')}</button>` : ''}
        </div>
      </div>
    </details>
    ${section(
      'detail.section.subtasks',
      h`${refList(model, subs)}${st.canCreate ? addSubtaskButton(st.ref.id, st.busy) : ''}`,
      h` <span class="dt-count">${subs.length}</span>`,
    )}
  </form>`;
}

/** Nombre de modifications en attente, en texte. */
export function pendingText(n) {
  if (!n) return label('form.pending.none');
  return n === 1 ? label('form.pending.one') : label('form.pending.many', { n });
}

/** Résumé des erreurs bloquantes (pied du formulaire). */
export function errorSummary(n) {
  if (!n) return '';
  return n === 1 ? label('form.error.summary') : label('form.error.summaryMany', { n });
}

/** Pied fixe du formulaire. */
export function taskFormFoot(st, changes, errorCount) {
  if (st.locked)
    return h`<div class="tf-foot">
      <p class="tf-foot__text">${label('form.locked.foot')}</p>
      <div class="tf-foot__actions">
        <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-form="cancel" id="btn-form-cancel">${label('form.close')}</button>
      </div>
    </div>`;
  if (st.leave)
    return h`<div class="tf-foot tf-foot--leave" role="alert">
      <p class="tf-foot__text">${label('form.leave.title')}</p>
      <div class="tf-foot__actions">
        <button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary" data-form="leave-continue" id="btn-leave-continue" ${raw(st.busy ? 'disabled' : '')}>${label('form.leave.continue')}</button>
        <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-form="leave-discard" ${raw(st.busy ? 'disabled' : '')}>${label('form.leave.discard')}</button>
        <button type="button" class="fr-btn fr-btn--sm edit-primary" data-form="leave-save" ${raw(errorCount || st.busy ? 'disabled' : '')}>${label('form.leave.save')}</button>
      </div>
    </div>`;
  const n = Object.keys(changes).length;
  const saveText = st.busy ? label('form.saving') : label(st.mode === 'dry-run' ? 'form.save.dry' : 'form.save');
  return h`<div class="tf-foot">
    <p class="tf-foot__text" id="tf-pending" aria-live="polite">
      <span class="tf-foot__count">${pendingText(n)}</span>
      ${errorCount ? h`<span class="tf-foot__error">${errorSummary(errorCount)}</span>` : h`<span class="tf-foot__hint">${label('form.shortcut')}</span>`}
    </p>
    <div class="tf-foot__actions">
      <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-form="cancel" id="btn-form-cancel" ${raw(st.busy ? 'disabled' : '')}>${label(n ? 'form.cancel' : 'form.close')}</button>
      <button type="button" class="fr-btn fr-btn--sm edit-primary" data-form="save" id="btn-form-save" ${raw(!n || errorCount || st.busy ? 'disabled' : '')} ${raw(st.busy ? 'aria-busy="true"' : '')}>${saveText}</button>
    </div>
  </div>`;
}
