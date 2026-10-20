/**
 * Fenêtre de confirmation d'une suppression depuis la fiche (tâche avec ses sous-tâches, chantier vide) : rendu
 * seul (fragments h``), à partir de l'état tenu par ui/task-editor.js et du plan de core/delete-plan.js. Refus
 * expliqué avant tout envoi (chantier non vide, dépendance, périmètre) avec un seul bouton « Fermer ».
 */
import { raw } from '../core/sanitize.js';
import { label } from '../labels.js';
import { h } from '../ui/kit.js';
import { refusedText } from './task-form.js';

/** Sous-tâches listées au plus dans la fenêtre (puis « et n autres »). */
export const DELETE_LIST_MAX = 10;

/** Titre de la fenêtre. */
export function deleteTitle(d) {
  return label(d.ref.table === 'Chantiers' ? 'delete.title.chantier' : 'delete.title.task', { titre: d.titre });
}

/** Explication d'un refus du plan (données chargées), avant tout envoi. */
export function deleteRefusalText(plan) {
  const { reason, vars } = plan;
  if (reason === 'chantier-non-vide')
    return label(`delete.refused.chantier-non-vide.${vars.n === 1 ? 'one' : 'many'}`, { n: vars.n });
  if (reason === 'reference')
    return label(`delete.refused.reference.${vars.n === 1 ? 'one' : 'many'}`, { noms: vars.noms });
  if (reason === 'perimetre') return label('delete.refused.perimetre', { noms: vars.noms });
  if (reason === 'ligne') return label('delete.refused.ligne');
  return label('form.fail.refused', { raison: refusedText(reason) });
}

/** Corps : sous-tâches emportées, rappel « Annuler » ; refus ou échec à la place. */
export function deleteBody(d) {
  if (d.fail)
    return h`<div class="fr-alert fr-alert--error fr-alert--sm tf-alert" role="alert" id="del-alert" tabindex="-1">
      <p>${d.fail.text}</p>
      ${d.fail.detail ? h`<details class="tf-tech"><summary>${label('form.fail.detail')}</summary><pre>${d.fail.detail}</pre></details>` : ''}
    </div>`;
  if (!d.plan.ok)
    return h`<div class="fr-alert fr-alert--warning fr-alert--sm tf-alert" role="alert" id="del-alert" tabindex="-1">
      <p>${deleteRefusalText(d.plan)}</p>
    </div>`;
  const subs = d.plan.rows.slice(1);
  const shown = subs.slice(0, DELETE_LIST_MAX);
  const more = subs.length - shown.length;
  const list = subs.length
    ? h`<p class="del__lead">${subs.length === 1 ? label('delete.subtasks.one') : label('delete.subtasks.many', { n: subs.length })}</p>
      <ul class="del__list" id="del-list">${shown.map((r) => h`<li>${r.title || label('common.untitled')}</li>`)}${more ? h`<li class="del__more">${label('delete.subtasks.more', { n: more })}</li>` : ''}</ul>`
    : d.ref.table === 'Chantiers'
      ? h`<p class="del__lead">${label('delete.chantier.empty')}</p>`
      : '';
  return h`${list}<p class="del__hint" id="del-hint">${label(d.mode === 'dry-run' ? 'delete.dryHint' : 'delete.undoHint')}</p>`;
}

/** Pied : « Annuler » (focus par défaut) et « Supprimer » ; un seul bouton « Fermer » après un refus ou un échec. */
export function deleteFoot(d) {
  if (d.fail || !d.plan.ok)
    return h`<div class="tf-foot"><div class="tf-foot__actions">
      <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-del="close" id="del-close">${label('delete.close')}</button>
    </div></div>`;
  const off = raw(d.busy ? 'disabled' : '');
  const confirm = d.busy ? label('delete.busy') : label(d.mode === 'dry-run' ? 'delete.confirm.dry' : 'delete.confirm');
  return h`<div class="tf-foot"><div class="tf-foot__actions">
    <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-del="cancel" id="del-cancel" ${off}>${label('delete.cancel')}</button>
    <button type="button" class="fr-btn fr-btn--sm del__confirm" data-del="confirm" id="del-confirm" ${off} ${raw(d.busy ? 'aria-busy="true"' : '')}>${confirm}</button>
  </div></div>`;
}
