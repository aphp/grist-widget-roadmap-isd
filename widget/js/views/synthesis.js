/**
 * Vue Synthèse (lecture seule) : tableau de pilotage en Markdown (aperçu échappé, copie) et Gantt Mermaid
 * dessiné à la demande (mermaid chargé seulement ici).
 */
import { markdownToHtml, mermaidGanttPlan, synthesisMarkdown } from '../core/synthesis-data.js';
import { raw } from '../core/sanitize.js';
import { h } from '../ui/kit.js';
import { viewHeading } from '../ui/heading.js';
import { label } from '../labels.js';

export const id = 'synthesis';

/** Génération du rendu en cours : un dessin Mermaid terminé après un nouveau rendu est abandonné. */
const memory = { generation: 0 };
/** Observateur de thème par conteneur, pour ne jamais en empiler. */
const observers = new WeakMap();

/** Copie dans le presse-papiers ; repli : sélection du texte de la zone (Ctrl+C manuel). */
async function copyText(text, area, button) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      area.hidden = false;
      area.closest('details')?.setAttribute('open', '');
      area.focus();
      area.select();
      const done = document.execCommand('copy');
      button?.focus();
      return done;
    } catch {
      // repli manuel ci-dessous
    }
    return false;
  }
}

/**
 * @param {HTMLElement} el
 * @param {object} ctx contexte fourni par main.js
 */
export function render(el, ctx) {
  const gen = ++memory.generation;
  const md = synthesisMarkdown(ctx.model, ctx.view, { today: ctx.today });
  const plan = mermaidGanttPlan(ctx.model, ctx.view, { today: ctx.today });
  const st = { notice: { md: '', gantt: '' }, gantt: plan.count ? 'loading' : 'none', error: '' };

  const ganttBody = () => {
    if (st.gantt === 'none') return h`<p class="syn__empty" role="status">${label('synthesis.gantt.none')}</p>`;
    if (st.gantt === 'error')
      return h`<div class="syn__error" role="alert"><p>${label('synthesis.gantt.error', { raison: st.error })}</p>
        <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-retry>${label('synthesis.gantt.retry')}</button></div>`;
    if (st.gantt === 'loading') return h`<p class="syn__loading" role="status">${label('synthesis.gantt.loading')}</p>`;
    return h`<div class="syn__svg" data-svg></div>`;
  };

  function paintGantt() {
    const box = el.querySelector('[data-gantt-body]');
    if (box) box.innerHTML = ganttBody();
  }

  async function draw() {
    if (!plan.count) return;
    st.gantt = 'loading';
    paintGantt();
    let mod = null;
    try {
      mod = await import('../ui/mermaid.js');
      const svg = await mod.renderMermaid(plan.text);
      if (gen !== memory.generation || !el.isConnected) return;
      st.gantt = 'ready';
      paintGantt();
      // SVG produit par Mermaid en mode strict (assaini par la bibliothèque)
      el.querySelector('[data-svg]').innerHTML = svg;
    } catch (err) {
      if (gen !== memory.generation || !el.isConnected) return;
      st.gantt = 'error';
      st.error = mod && err instanceof mod.MermaidError ? err.message : label('mermaid.failed');
      paintGantt();
    }
  }

  el.innerHTML = h`<div class="syn">
    ${viewHeading(label('heading.synthesis.title'), label('heading.synthesis.sub'))}
    <section class="syn__section card" aria-labelledby="syn-md-title">
      <header class="syn__head">
        <div>
          <h3 id="syn-md-title" class="syn__title">${label('synthesis.md.heading')}</h3>
          <p class="syn__help">${label('synthesis.md.help')}</p>
        </div>
        <div class="syn__actions">
          <button type="button" class="fr-btn fr-btn--sm fr-btn--secondary fr-btn--icon-left fr-icon-clipboard-line" data-copy="md">${label('synthesis.copy')}</button>
        </div>
      </header>
      <p class="syn__notice" role="status" data-notice="md"></p>
      <div class="syn__preview" data-scroll-key="syn-preview" role="region" tabindex="0" aria-label="${label('synthesis.preview')}">${raw(markdownToHtml(md))}</div>
      <details class="syn__source">
        <summary>${label('synthesis.source')}</summary>
        <textarea class="fr-input syn__area" data-scroll-key="syn-md" readonly rows="12" spellcheck="false" aria-label="${label('synthesis.source')}" data-area="md">${md}</textarea>
      </details>
    </section>

    <section class="syn__section card" aria-labelledby="syn-gantt-title">
      <header class="syn__head">
        <div>
          <h3 id="syn-gantt-title" class="syn__title">${label('synthesis.gantt.heading')}</h3>
          <p class="syn__help">${label('synthesis.gantt.help')}${plan.count ? ` ${label('synthesis.gantt.count', { n: plan.count })}` : ''}</p>
        </div>
        <div class="syn__actions">
          ${plan.count ? h`<button type="button" class="fr-btn fr-btn--sm fr-btn--secondary fr-btn--icon-left fr-icon-clipboard-line" data-copy="gantt">${label('synthesis.gantt.copy')}</button>` : ''}
        </div>
      </header>
      <p class="syn__notice" role="status" data-notice="gantt"></p>
      ${plan.omitted ? h`<p class="fr-badge fr-badge--warning fr-badge--no-icon syn__omitted">${label('synthesis.gantt.omitted', { n: plan.omitted })}</p>` : ''}
      <div class="syn__gantt" data-scroll-key="syn-gantt" role="group" aria-label="${label('synthesis.gantt.label')}" tabindex="0" data-gantt-body>${ganttBody()}</div>
      ${
        plan.count
          ? h`<details class="syn__source">
        <summary>${label('synthesis.source')}</summary>
        <textarea class="fr-input syn__area" data-scroll-key="syn-gantt-src" readonly rows="10" spellcheck="false" aria-label="${label('synthesis.source')}" data-area="gantt">${plan.text}</textarea>
      </details>`
          : ''
      }
    </section>
  </div>`.toString();

  el.onclick = async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (btn) {
      const kind = btn.dataset.copy;
      const area = el.querySelector(`[data-area="${kind}"]`);
      const ok = await copyText(kind === 'md' ? md : plan.text, area, btn);
      const note = el.querySelector(`[data-notice="${kind}"]`);
      if (note)
        note.textContent = ok
          ? label(kind === 'md' ? 'synthesis.copy.done' : 'synthesis.gantt.copy.done')
          : label('synthesis.copy.fallback');
      return;
    }
    if (e.target.closest('[data-retry]')) return draw();
    // Barre du Gantt Mermaid (identifiant t<id> de la tâche) : ouvre sa fiche, comme dans les autres vues
    const bar = e.target.closest('[data-svg] [id]');
    const m = bar && /(?:^|-)t(\d+)(?:-text)?$/.exec(bar.id);
    if (m && ctx.model.tasks.has(Number(m[1]))) ctx.openDetail({ table: 'Tasks', id: Number(m[1]) });
  };

  // Les couleurs de Mermaid sont lues à l'instant du dessin : un changement de thème le redessine
  observers.get(el)?.disconnect();
  const obs = new MutationObserver(() => {
    if (gen !== memory.generation || !el.isConnected || !el.querySelector('[data-gantt-body]')) return obs.disconnect();
    if (st.gantt === 'ready') draw();
  });
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-fr-theme'] });
  observers.set(el, obs);

  draw();
}
