/**
 * Tags (lot 2e) : pastilles en lecture (fiche, Tableau) et sélecteur des formulaires tâche et chantier. Rendu seul
 * (fragments h``) ; l'état (saisie, option active, liste ouverte) est tenu par ui/task-editor.js.
 *
 * Sélecteur : pastilles retirables, puis une zone de recherche en « combobox » (liste de tags proposés, flèches
 * haut et bas, Entrée pour ajouter, Échap pour fermer). Un nom nouveau peut être affecté sans être déclaré dans la
 * Feuille : sa pastille est grise et en pointillés, comme tout tag non déclaré.
 */
import { TAGS_MAX_COUNT, TAG_MAX, declaredTags, searchTags, tagOptions } from '../core/tags-edit.js';
import { raw } from '../core/sanitize.js';
import { label } from '../labels.js';
import { h } from '../ui/kit.js';

/** Une pastille de tag ; non déclaré : grise, en pointillés, infobulle et texte pour les lecteurs d'écran. */
function chip(value, declared, remove = null, visibleNote = false) {
  const note = label('form.tags.undeclared');
  return h`<li class="tf-chip tf-tagchip${raw(declared ? '' : ' tf-tagchip--undeclared')}">
    <span class="tf-chip__text" title="${declared ? value : `${value} — ${label('form.tags.undeclaredTitle')}`}">${value === '' ? label('form.tags.emptyValue') : value}${
      declared
        ? ''
        : visibleNote
          ? h`<span class="tf-tagchip__note"> · ${note}</span>`
          : h`<span class="fr-sr-only"> (${note})</span>`
    }</span>
    ${remove ?? ''}
  </li>`;
}

/**
 * Pastilles d'une liste de tags en lecture (fiche, Tableau) ; '' si la liste est vide.
 * @param {object} model
 * @param {'Tasks'|'Chantiers'} table
 * @param {string[]} tags
 */
export function tagChipsHtml(model, table, tags) {
  if (!tags?.length) return '';
  const declared = declaredTags(model, table);
  return h`<ul class="list tf-chips tf-tags" aria-label="${label('form.field.tags')}">${tags.map((t) =>
    chip(t, declared.includes(t)),
  )}</ul>`;
}

/** Table de la fiche (les tags des tâches et des chantiers sont deux listes distinctes). */
const tableOf = (st) => (st.ref?.table === 'Chantiers' ? 'Chantiers' : 'Tasks');

/** Options affichées dans la liste (tags proposés, puis nouveau nom) pour la saisie en cours. */
export function tagItems(st, model) {
  return searchTags(tagOptions(model, tableOf(st)), st.tagQuery ?? '', st.draft.tags ?? []);
}

const usesText = (n) =>
  n === 0 ? label('form.tags.uses.none') : n === 1 ? label('form.tags.uses.one') : label('form.tags.uses.many', { n });

/**
 * Message de la zone de recherche (nombre de résultats, nom invalide, déjà choisi), dans la région
 * #tf-tags-status, mise à jour en place pendant la frappe. « Tag ajouté / retiré » est annoncé hors de la fiche
 * (ui/task-editor.js:speakTags).
 */
export function tagStatusHtml(st, model) {
  const { items, invalid, duplicate } = tagItems(st, model);
  const open = Boolean(st.tagOpen);
  const full = (st.draft.tags ?? []).length >= TAGS_MAX_COUNT;
  const status = !open
    ? ''
    : full
      ? label('form.tags.full', { max: TAGS_MAX_COUNT })
      : duplicate
        ? label('form.tags.duplicate')
        : invalid === 'long'
          ? label('form.tags.invalid.long', { max: TAG_MAX })
          : invalid === 'controle'
            ? label('form.tags.invalid.controle')
            : !items.length
              ? label('form.tags.noResult')
              : '';
  const known = items.filter((x) => !x.create).length;
  const count = !open
    ? ''
    : known === 0
      ? label('form.tags.count.none')
      : known === 1
        ? label('form.tags.count.one')
        : label('form.tags.count.many', { n: known });
  return h`${status ? h`<span class="tf-warn">${status}</span>` : ''}<span class="fr-sr-only">${count}</span>`;
}

/** Liste des tags proposés (mise à jour sans redessiner le formulaire). */
export function tagListHtml(st, model) {
  const { items } = tagItems(st, model);
  const open = Boolean(st.tagOpen);
  const active = Math.min(st.tagActive ?? 0, items.length - 1);
  return h`<ul class="tf-tagopts" id="tf-tags-list" role="listbox" aria-label="${label('form.tags.listLabel')}" ${raw(open && items.length ? '' : 'hidden')}>${items.map(
    (it, i) =>
      h`<li class="tf-tagopt${raw(i === active ? ' is-active' : '')}${raw(it.create ? ' tf-tagopt--create' : '')}" role="option" id="tf-tags-opt-${i}" data-tag-opt="${i}" aria-selected="${String(i === active)}">${
        it.create
          ? h`<span class="tf-tagopt__name">${label('form.tags.create', { nom: it.value })}</span><span class="tf-tagopt__meta">${label('form.tags.createNote')}</span>`
          : h`<span class="tf-tagopt__name${raw(it.declared ? '' : ' tf-tagopt__name--undeclared')}">${it.value}</span><span class="tf-tagopt__meta">${it.declared ? label('form.tags.declared') : label('form.tags.undeclared')} · ${usesText(it.count)}</span>`
      }</li>`,
  )}</ul>`;
}

/**
 * Cellule de tags illisible dans la Feuille (texte, erreur, éléments non textuels) : contenu montré, champ bloqué ;
 * « Remplacer » demande une confirmation, après quoi les tags choisis remplaceront ce contenu.
 */
function unreadableHtml(st, can) {
  const rawText = st.base.tagsUnreadable;
  return h`<div class="tf-charges__unreadable tf-tags__unreadable">
    <p class="tf-warn">${label('form.tags.unreadable')}</p>
    <p class="tf-sublabel">${label('form.charges.unreadableRaw')}</p>
    <pre class="tf-charges__raw">${rawText}</pre>
    ${
      !can
        ? ''
        : st.confirmTagsReplace
          ? h`<p class="tf-charges__ask" role="alert">${label('form.tags.replaceAsk')}</p>
            <div class="tf-alert__actions">
              <button type="button" class="fr-btn fr-btn--sm edit-primary" data-tags-replace="confirm" id="tf-tags-replace-confirm">${label('form.tags.replaceConfirm')}</button>
              <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-tags-replace="cancel">${label('form.charges.replaceCancel')}</button>
            </div>`
          : h`<button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-tags-replace="ask" id="tf-tags-replace">${label('form.tags.replace')}</button>`
    }
  </div>`;
}

/** Vrai si la cellule de tags lue est illisible et que son remplacement n'est pas confirmé (champ bloqué). */
export const tagsBlocked = (st) =>
  typeof st.base?.tagsUnreadable === 'string' && st.tagsReplace !== st.base.tagsUnreadable;

/**
 * Champ « Tags » d'un formulaire : pastilles retirables, recherche avec liste de tags proposés.
 * @param {object} st état du formulaire (draft.tags, can, busy, tagQuery, tagOpen, tagActive)
 * @param {object} model
 * @param {(st:object, f:string, control:any, opts?:object) => any} field enveloppe d'un champ (task-form.js)
 * @param {(st:object, f:string, help?:boolean) => any} attrs attributs communs des contrôles (task-form.js)
 */
export function tagsFieldHtml(st, model, field, attrs) {
  const table = tableOf(st);
  const declared = declaredTags(model, table);
  const tags = st.draft.tags ?? [];
  const editable = st.can('tags').ok && !st.busy;
  const blocked = tagsBlocked(st);
  const can = editable && !blocked;
  const items = st.tagOpen && can ? tagItems(st, model).items : [];
  const active = Math.min(st.tagActive ?? 0, items.length - 1);
  const remove = (t, i) =>
    can
      ? h`<button type="button" class="tf-chip__remove" data-remove-tag="${i}" title="${label('form.tags.remove', { nom: t })}" aria-label="${label('form.tags.remove', { nom: t })}">✕</button>`
      : null;
  return field(
    st,
    'tags',
    h`${
      tags.length
        ? h`<ul class="list tf-chips tf-tags" aria-label="${label('form.field.tags')}">${tags.map((t, i) =>
            chip(t, declared.includes(t), remove(t, i), true),
          )}</ul>`
        : blocked
          ? ''
          : h`<p class="tf-empty">${label('form.field.tags.none')}</p>`
    }
    ${blocked ? unreadableHtml(st, editable) : ''}
    <div class="tf-tags__box">
      <label class="fr-label tf-sublabel" for="tf-tags">${label('form.tags.search')}<span class="fr-hint-text">${label('form.tags.searchHelp')}</span></label>
      <input type="text" id="tf-tags" class="fr-input tf-tags__input" autocomplete="off" spellcheck="false" maxlength="${TAG_MAX + 20}" value="${st.tagQuery ?? ''}" data-tag-search role="combobox" aria-autocomplete="list" aria-controls="tf-tags-list" aria-expanded="${String(Boolean(st.tagOpen && items.length))}" ${raw(st.tagOpen && items.length ? `aria-activedescendant="tf-tags-opt-${active}"` : '')} ${attrs(st, 'tags', true)} ${raw(blocked ? 'disabled' : '')}>
      <div id="tf-tags-results">${tagListHtml(st, model)}</div>
      <p class="tf-tags__status" id="tf-tags-status" aria-live="polite">${tagStatusHtml(st, model)}</p>
    </div>`,
    {
      legend: true,
      wide: true,
      hintAfter: label(table === 'Chantiers' ? 'form.tags.helpChantier' : 'form.tags.help'),
    },
  );
}
