/**
 * Détail d'une charge (case du plan de charge, segment de la charge par profil) : titre, chiffres, puis la liste
 * des tâches qui la portent (chemin, titre qui ouvre la fiche, statut, personnes, heures). Commun aux deux vues.
 */
import { h, icon, statusBadge } from '../ui/kit.js';
import { label } from '../labels.js';

const SEP = ' › ';
const int = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

/** Heures arrondies à l'unité, écrites à la française. */
export const hoursText = (x) => int.format(Math.round(x));
/** Taux en pourcentage arrondi (« 112 % »), « n/d » sans capacité. */
export const pctText = (rate) =>
  rate === null ? label('plan.rate.none') : `${int.format(Math.round(rate * 100))}\u202f%`;
/** Icône d'un niveau de charge (tension, dépassement), en plus du texte. */
export const LEVEL_ICON = Object.freeze({
  tension: icon('alert-line', 'tcell__icon'),
  over: icon('error-warning-line', 'tcell__icon'),
});

/**
 * Lignes de tâches pour le panneau : titre, chemin (projet › chantier), statut, heures et personnes.
 * @param {object} model
 * @param {Map<number, {path:string[]}>} paths chemins des tâches (taskPaths)
 * @param {[number, number, string[]?][]} list [identifiant, heures, noms des personnes]
 */
export function panelTasks(model, paths, list) {
  return list.map(([taskId, hours, people = []]) => {
    const t = model.tasks.get(taskId);
    return {
      taskId,
      hours,
      people,
      title: t?.title || label('common.untitled'),
      status: t?.status ?? '',
      path: (paths.get(taskId)?.path ?? []).join(SEP),
    };
  });
}

/**
 * Panneau de détail.
 * @param {{titleId:string, title:string, stats:[string, unknown][], tasks:ReturnType<typeof panelTasks>}} p
 */
export function loadPanelHtml({ titleId, title, stats, tasks }) {
  return h`<section class="plan__panel" aria-labelledby="${titleId}">
    <div class="plan__panel-head">
      <h3 class="plan__panel-title" id="${titleId}" tabindex="-1">${title}</h3>
      <button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary-no-outline fr-icon-close-line fr-btn--icon-left" data-close-panel>${label('plan.cell.close')}</button>
    </div>
    <dl class="plan__stats">
      ${stats.map(([term, value]) => h`<div><dt>${term}</dt><dd>${value}</dd></div>`)}
    </dl>
    <h4 class="plan__panel-sub">${label('plan.cell.tasks')} (${tasks.length})</h4>
    ${
      tasks.length
        ? h`<ul class="list plan__tasks">${tasks.map(
            (t) => h`<li><button type="button" class="plan__task" data-task="${t.taskId}">
              <span class="plan__task-main">
                ${t.path ? h`<span class="plan__task-path" title="${t.path}">${t.path}</span>` : ''}
                <span class="plan__task-title">${t.title}</span>
                ${t.people.length ? h`<span class="plan__task-people">${t.people.join(', ')}</span>` : ''}
              </span>
              ${statusBadge(t.status)}
              <span class="plan__task-hours" title="${label('plan.cell.hoursTitle', { h: hoursText(t.hours) })}">${label('plan.cell.hours', { h: hoursText(t.hours) })}</span>
            </button></li>`,
          )}</ul>`
        : h`<p class="plan__panel-empty">${label('plan.cell.empty')}</p>`
    }
  </section>`;
}
