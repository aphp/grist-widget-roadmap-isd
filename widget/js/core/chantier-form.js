/**
 * Formulaire d'un chantier (lot 2c) : brouillon, différences, statut rapide, validation, rattachement des tâches
 * quand un projet est retiré, demandeurs lus des projets (Q12 : pas de colonne propre), droit de modifier.
 * Fonctions pures, sans écriture (l'envoi est grist-writer.js). Priorité en lecture (Q5) ; tags affectés (lot 2e).
 *
 * Le brouillon contient les valeurs du modèle des colonnes modifiables : jours (Debut, Fin), identifiants
 * (Responsable), listes d'identifiants (Projets, Contributeurs) et textes.
 */
import { dateMaxError, overMaxDay } from './dates.js';
import { mergeTags } from './tags-edit.js';
import { sameValue } from './write-encode.js';

/** Champs visibles par défaut, puis ceux de « Plus de champs ». */
export const CHANTIER_MAIN = Object.freeze([
  'Nom_du_chantier',
  'Statut',
  'Projets',
  'Debut',
  'Fin',
  'Responsable',
  'Contributeurs',
  'tags',
]);
export const CHANTIER_MORE = Object.freeze(['Description', 'Objectifs_resultats_attendus', 'Criteres_de_succes']);
export const CHANTIER_FIELDS = Object.freeze([...CHANTIER_MAIN, ...CHANTIER_MORE]);

export const CHANTIER_NAME_MAX = 300;
/** Statut d'un nouveau chantier (premier choix de la Feuille). */
export const DEFAULT_CHANTIER_STATUS = 'À cadrer';

const copy = (v) => (Array.isArray(v) ? [...v] : v);
const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

/** Brouillon initial (copie) depuis les valeurs relues de la ligne. */
export function chantierDraftFrom(base) {
  return Object.fromEntries(CHANTIER_FIELDS.map((f) => [f, copy(base[f])]));
}

/** Colonnes modifiées : seules celles-ci sont envoyées. Le nom saisi est nettoyé de ses espaces de bord. */
export function diffChantier(base, draft) {
  const out = {};
  for (const f of CHANTIER_FIELDS) {
    if (!(f in draft) || sameValue(base[f], draft[f])) continue;
    const v = f === 'Nom_du_chantier' && typeof draft[f] === 'string' ? draft[f].trim() : draft[f];
    if (!sameValue(base[f], v)) out[f] = v;
  }
  return out;
}

/**
 * Nouvelle base (ligne relue) : les champs que l'utilisateur n'a pas touchés suivent la Feuille ; les tags saisis
 * (ajouts, retraits) sont appliqués à la cellule relue.
 */
export function rebaseChantier(oldBase, draft, fresh) {
  const out = { ...draft };
  for (const f of CHANTIER_FIELDS) {
    if (!(f in fresh)) continue;
    if (sameValue(oldBase[f], draft[f])) out[f] = copy(fresh[f]);
    else if (f === 'tags') out.tags = mergeTags(oldBase.tags, draft.tags, fresh.tags);
  }
  return out;
}

/** Statut rapide d'un chantier : la seule colonne Statut ({} si rien ne change). */
export function chantierStatusChanges(base, status) {
  return sameValue(base.Statut, status) ? {} : { Statut: status };
}

/** Le chantier appartient-il au périmètre ISD (un de ses projets y est) ? */
export function chantierInScope(model, chantier) {
  return Boolean(chantier?.projectIds.some((p) => model.projects.get(p)?.inScope));
}

/**
 * Demandeurs du chantier, lus des projets (Projects.Commanditaires), en lecture : le chantier n'a pas de colonne
 * propre (Q12). Un projet sans demandeur est omis.
 * @returns {{projet:string, demandeur:string}[]}
 */
export function chantierDemandeurs(model, projectIds) {
  return projectIds
    .map((id) => model.projects.get(id))
    .filter((p) => p?.demandeur)
    .map((p) => ({ projet: p.title, demandeur: p.demandeur }));
}

/** Étendue déduite des tâches du chantier (affichée en grisé quand ses propres dates sont vides). */
export function chantierSpan(model, chantierId) {
  for (const n of model.nodes.values())
    if (n.kind === 'chantier' && n.ref?.table === 'Chantiers' && n.ref.id === chantierId && n.span) return n.span;
  return null;
}

/** Tâches portant ce chantier (colonne Chantier), par titre. */
export function chantierTaskIds(model, chantierId) {
  return [...model.tasks.values()]
    .filter((t) => t.chantierId === chantierId)
    .sort((a, b) => collator.compare(a.title, b.title))
    .map((t) => t.id);
}

/** Liens de hiérarchie des tâches (identifiant, parent, chantier, projet), depuis le modèle chargé. */
export const taskLinksFromModel = (model) =>
  [...model.tasks.values()].map((t) => ({
    id: t.id,
    parentId: t.parentId,
    chantierId: t.chantierId,
    projectId: t.projectId,
  }));

const refOf = (v) => (Number.isInteger(v) && v > 0 ? v : null);

/** Mêmes liens depuis la table Tasks brute relue dans la Feuille (sous-tâches ajoutées entre-temps comprises). */
export const taskLinksFromTable = (raw) =>
  (raw?.id ?? []).map((id, i) => ({
    id,
    parentId: refOf(raw.parentTask?.[i]),
    chantierId: refOf(raw.Chantier?.[i]),
    projectId: refOf(raw.projet?.[i]),
  }));

/** Sous-tâches d'une tâche, à toute profondeur, dans des liens de hiérarchie (par identifiant croissant). */
export function descendantsIn(links, taskId) {
  const kids = new Map();
  for (const l of links) if (l.parentId) kids.set(l.parentId, [...(kids.get(l.parentId) ?? []), l.id]);
  const out = new Set();
  const stack = [...(kids.get(taskId) ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id) || id === taskId) continue;
    out.add(id);
    stack.push(...(kids.get(id) ?? []));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Projets retirés du chantier qui portent encore des tâches du chantier : ces tâches, ET toutes leurs sous-tâches
 * (elles suivent le projet de leur tâche), sont rattachées à un projet restant, dans le même lot (sinon le writer
 * refuse : 'taches-projet', 'sous-taches').
 * @param {{id:number, parentId:number|null, chantierId:number|null, projectId:number|null}[]} links
 * @returns {{taskIds:number[], target:number|null, also:{table:'Tasks', id:number, changes:{projet:number},
 *   before:{projet:number|null}}[]}}
 */
export function reattachRows(links, chantierId, projets, target) {
  const byId = new Map(links.map((l) => [l.id, l]));
  const to = projets.includes(target) ? target : (projets[0] ?? null);
  const roots = links.filter(
    (l) => l.chantierId === chantierId && l.projectId !== null && !projets.includes(l.projectId),
  );
  const ids = new Set(roots.map((l) => l.id));
  for (const r of roots) for (const d of descendantsIn(links, r.id)) if (byId.get(d).projectId !== to) ids.add(d);
  const taskIds = [...ids].sort((a, b) => a - b);
  return {
    taskIds,
    target: to,
    also:
      to === null
        ? []
        : taskIds.map((id) => ({
            table: 'Tasks',
            id,
            changes: { projet: to },
            before: { projet: byId.get(id).projectId },
          })),
  };
}

/** Le même plan sur le modèle chargé (affichage, mode essai) ; l'envoi réel le refait sur la table relue. */
export function reattachPlan(model, chantierId, projets, target) {
  return reattachRows(taskLinksFromModel(model), chantierId, projets, target);
}

/**
 * Règles du formulaire chantier (fiche et création). Les erreurs bloquent l'enregistrement ; les avertissements non.
 * @param {object} draft brouillon
 * @param {{model:object, chantierId?:number|null, statuses?:string[], maxDay?:number}} ctx chantierId null : création ;
 *   maxDay : dernier jour de planification (date plus tardive refusée, sauf valeur d'origine)
 * @returns {{errors:Record<string,{key:string, vars?:object}>, warnings:{field:string, key:string, vars?:object}[]}}
 */
export function validateChantier(draft, { model, chantierId = null, statuses = [], maxDay }) {
  const errors = {};
  const warnings = [];
  const name = String(draft.Nom_du_chantier ?? '').trim();
  if (!name) errors.Nom_du_chantier = { key: 'form.error.nameEmpty' };
  else if (name.length > CHANTIER_NAME_MAX)
    errors.Nom_du_chantier = { key: 'form.error.titleLong', vars: { max: CHANTIER_NAME_MAX } };
  const projets = draft.Projets ?? [];
  if (!projets.length) errors.Projets = { key: 'form.error.noProject' };
  else if (projets.some((p) => !model.projects.has(p))) errors.Projets = { key: 'form.error.missingRef' };
  else if (!projets.some((p) => model.projects.get(p).inScope)) errors.Projets = { key: 'form.error.projectScope' };
  if (draft.Debut !== null && draft.Fin !== null && draft.Fin < draft.Debut)
    errors.Fin = { key: 'form.error.finBeforeDebut' };
  else {
    const orig = model.chantiers.get(chantierId);
    if (overMaxDay(draft.Debut, maxDay, orig?.start ?? null)) errors.Debut = dateMaxError(maxDay);
    if (overMaxDay(draft.Fin, maxDay, orig?.end ?? null)) errors.Fin = dateMaxError(maxDay);
  }
  if (draft.Responsable !== null && !model.people.has(draft.Responsable))
    errors.Responsable = { key: 'form.error.missingRef' };
  if ((draft.Contributeurs ?? []).some((p) => !model.people.has(p)))
    errors.Contributeurs = { key: 'form.error.missingRef' };

  if (draft.Statut && statuses.length && !statuses.includes(draft.Statut))
    warnings.push({ field: 'Statut', key: 'form.warn.choice', vars: { valeur: draft.Statut } });
  const same = [...model.chantiers.values()].find(
    (c) =>
      c.id !== chantierId &&
      name &&
      collator.compare(c.title, name) === 0 &&
      c.projectIds.some((p) => projets.includes(p)),
  );
  if (same) warnings.push({ field: 'Nom_du_chantier', key: 'form.warn.duplicateChantier' });
  if (chantierId !== null && projets.length) {
    const n = reattachPlan(model, chantierId, projets, null).taskIds.length;
    if (n)
      warnings.push({ field: 'Projets', key: n === 1 ? 'form.warn.reattachOne' : 'form.warn.reattach', vars: { n } });
  }
  return { errors, warnings };
}
