/** Vue factice (en attendant les vraies vues) : nombre de tâches filtrées et premières tâches cliquables. */
import { h, statusBadge } from '../ui/kit.js';
import { taskCount } from '../labels.js';

export const id = 'placeholder';
const SAMPLE = 6;

function firstTasks(tree, max) {
  const out = [];
  const walk = (n) => {
    if (out.length >= max) return;
    if (n.taskId) out.push(n);
    n.children.forEach(walk);
  };
  tree.forEach(walk);
  return out;
}

/**
 * @param {HTMLElement} el
 * @param {object} ctx contexte fourni par main.js
 */
export function render(el, ctx) {
  const n = ctx.view.taskIds.size;
  const sample = firstTasks(ctx.view.tree, SAMPLE);
  el.innerHTML = h`<div class="placeholder card">
    <p class="placeholder__count">${taskCount(n)}</p>
    <h2 class="placeholder__title">${ctx.label('placeholder.title')}</h2>
    <p class="placeholder__body">${ctx.label('placeholder.body')}</p>
    ${
      sample.length
        ? h`<p class="placeholder__sample-title">${ctx.label('placeholder.sample')}</p>
          <ul class="list placeholder__list">
            ${sample.map(
              (t) =>
                h`<li>
                  <button type="button" class="placeholder__item" data-task="${t.taskId}">
                    <span class="placeholder__item-title">${t.title || ctx.label('common.untitled')}</span>
                    ${statusBadge(t.status)}
                  </button>
                </li>`,
            )}
          </ul>`
        : ''
    }
  </div>`;
  el.onclick = (e) => {
    const b = e.target.closest('[data-task]');
    if (b) ctx.openDetail({ table: 'Tasks', id: Number(b.dataset.task) });
  };
}
