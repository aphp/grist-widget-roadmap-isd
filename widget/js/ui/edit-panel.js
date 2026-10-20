/**
 * Panneau d'édition de l'en-tête : journal de la session en clair (« Tâches n° 812 : Statut À faire → En cours »),
 * actions exactes en JSON (mode essai) et « Annuler la dernière modification ».
 */
import { label } from '../labels.js';
import { fieldLabel, valueText } from '../views/task-form.js';
import { h } from './kit.js';

const TABLE_TEXT = Object.freeze({
  Tasks: 'detail.table.Tasks',
  Chantiers: 'detail.table.Chantiers',
  Team: 'detail.table.Team',
  Disponibilites: 'detail.table.Disponibilites',
});

const tableText = (t) => label(TABLE_TEXT[t] ?? t);

/** Lignes d'une mise à jour (une par colonne). */
const updateLines = (model, e) =>
  Object.keys(e.after).map((col) =>
    label('edit.entry', {
      table: tableText(e.table),
      id: e.id,
      champ: fieldLabel(col, e.table),
      avant: valueText(model, col, e.before[col]),
      apres: valueText(model, col, e.after[col]),
    }),
  );

/** Nom d'une ligne créée (tâche, chantier, personne ; indisponibilité : nom de la personne). */
function entryName(model, entry) {
  const v = { ...entry.before, ...entry.after };
  if (v.membre) return model.people.get(v.membre)?.nom ?? `n° ${v.membre}`;
  return v.titre ?? v.Nom_du_chantier ?? v.nom ?? '';
}

/**
 * Lignes en clair d'une écriture du journal : une par colonne modifiée (et par ligne dérivée : sous-tâches qui
 * suivent, tâches rattachées), une pour une création ou son annulation.
 */
export function entryLines(model, entry) {
  if (entry.kind === 'add' || entry.kind === 'remove')
    return [
      label(entry.kind === 'add' ? 'edit.entry.add' : 'edit.entry.remove', {
        table: tableText(entry.table),
        id: entry.id,
        nom: entryName(model, entry),
      }),
    ];
  return [entry, ...(entry.rows ?? [])].flatMap((e) => updateLines(model, e));
}

/**
 * @param {object} model
 * @param {object[]} journal copie du journal du writer
 * @param {'dry-run'|'on'} mode
 * @param {boolean} canUndo
 */
export function editPanelHtml(model, journal, mode, canUndo) {
  const dry = mode === 'dry-run';
  const count = journal.length;
  return h`<p class="popover__title">${label(dry ? 'edit.panel.title' : 'edit.pill.on.short')}</p>
    <p class="popover__help">${label(dry ? 'edit.panel.count' : 'edit.panel.countOn', { n: count })}</p>
    ${
      count
        ? h`<ol class="edit-panel__list">${[...journal]
            .reverse()
            .map(
              (e) =>
                h`<li class="${e.undone ? 'is-undone' : ''}">${entryLines(model, e).map((l) => h`<span class="edit-panel__line">${l}</span>`)}${e.undone ? h` <span class="edit-panel__undone">${label('edit.panel.undone')}</span>` : ''}</li>`,
            )}</ol>`
        : h`<p class="popover__help">${label('edit.panel.empty')}</p>`
    }
    <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary fr-btn--icon-left fr-icon-arrow-go-back-line" data-edit-undo ${canUndo ? '' : 'disabled'}>${label('edit.undoLast')}</button>
    ${
      dry && count
        ? h`<details class="edit-panel__json"><summary>${label('edit.panel.json')}</summary><pre>${JSON.stringify(
            journal.map((e) => e.actions),
            null,
            1,
          )}</pre></details>`
        : ''
    }`;
}
