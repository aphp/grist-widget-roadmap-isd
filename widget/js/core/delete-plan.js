/**
 * Suppression depuis la fiche, sur les données chargées : lot d'une tâche (avec toutes ses sous-tâches) ou d'un
 * chantier vide, titres pour la fenêtre de confirmation, refus à montrer AVANT tout envoi. Même règle que le writer
 * (grist-writer.js:deletionBatch), qui la refait sur les tables relues juste avant l'envoi. Fonctions pures.
 */
import { deletionBatch } from './grist-writer.js';

/** Liens entre lignes depuis le modèle (même forme que grist-writer.js:linksFromTables). */
export function linksFromModel(model) {
  return {
    tasks: [...model.tasks.values()].map((t) => ({
      id: t.id,
      parentId: t.parentId,
      chantierId: t.chantierId,
      dependDe: t.dependDe ?? [],
    })),
    chantiers: [...model.chantiers.values()].map((c) => ({ id: c.id, dependDe: c.dependDe ?? [] })),
  };
}

/** Titre d'une ligne du modèle (tâche ou chantier). */
const titleOf = (model, r) => (r.table === 'Tasks' ? model.tasks : model.chantiers).get(r.id)?.title ?? '';

/** Noms entre guillemets, séparés par des virgules. */
const names = (model, rows) => rows.map((r) => `« ${titleOf(model, r) || `n° ${r.id}`} »`).join(', ');

/**
 * @param {object} model
 * @param {string} table 'Tasks' ou 'Chantiers'
 * @param {number} id
 * @param {{canWriteRow?:(table:string, id:number) => boolean}} [opts] règle de périmètre (write-scope.js)
 * @returns {{ok:true, rows:{table:string, id:number, title:string}[], count:number}
 *   |{ok:false, reason:string, vars:object}} reason : 'table', 'ligne', 'chantier-non-vide' (vars.n tâches),
 *   'reference' (vars.n lignes qui en dépendent, vars.noms), 'perimetre' (vars.n, vars.noms)
 */
export function deletePlan(model, table, id, opts = {}) {
  const r = deletionBatch(linksFromModel(model), table, id);
  if (!r.ok) {
    if (r.reason === 'chantier-non-vide') return { ok: false, reason: r.reason, vars: { n: r.n } };
    if (r.reason === 'reference')
      return { ok: false, reason: r.reason, vars: { n: r.refs.length, noms: names(model, r.refs) } };
    return { ok: false, reason: r.reason, vars: {} };
  }
  const out = opts.canWriteRow ? r.rows.filter((x) => !opts.canWriteRow(x.table, x.id)) : [];
  if (out.length) return { ok: false, reason: 'perimetre', vars: { n: out.length, noms: names(model, out) } };
  const rows = r.rows.map((x) => ({ ...x, title: titleOf(model, x) }));
  return { ok: true, rows, count: rows.length };
}
