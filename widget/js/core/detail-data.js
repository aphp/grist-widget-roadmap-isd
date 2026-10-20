/** Fiche détail : niveau du widget, fil d'Ariane, éléments contenus. Fonctions pures (spec §4.2, §4.4, §5). */

const MAX_DEPTH = 20;
const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
const byTitle = (items) => (a, b) => collator.compare(items.get(a)?.title ?? '', items.get(b)?.title ?? '');

/** Premier nœud de l'arbre pour chaque ligne source ('Table:id'), calculé une fois par modèle. */
const indexCache = new WeakMap();
function nodeIndex(model) {
  if (!indexCache.has(model)) {
    const idx = new Map();
    for (const n of model.nodes.values())
      if (n.ref && !idx.has(`${n.ref.table}:${n.ref.id}`)) idx.set(`${n.ref.table}:${n.ref.id}`, n);
    indexCache.set(model, idx);
  }
  return indexCache.get(model);
}

function depthOf(model, task) {
  let d = 0;
  for (let t = task; t?.parentId && model.tasks.has(t.parentId) && d < MAX_DEPTH; t = model.tasks.get(t.parentId)) d++;
  return d;
}

/**
 * Niveau d'une ligne de la Feuille (spec §4.2) : projet, chantier, tâche (sans parent), sous-tâche ou personne.
 * @param {object} model
 * @param {{table:string, id:number}} ref
 * @returns {'projet'|'chantier'|'tache'|'sous-tache'|'personne'|null} null si la ligne est introuvable
 */
export function detailLevel(model, ref) {
  if (ref.table === 'Projects') return model.projects.has(ref.id) ? 'projet' : null;
  if (ref.table === 'Team') return model.people.has(ref.id) ? 'personne' : null;
  if (ref.table === 'Chantiers') return model.chantiers.has(ref.id) ? 'chantier' : null;
  if (ref.table === 'Tasks') {
    const t = model.tasks.get(ref.id);
    if (!t) return null;
    return depthOf(model, t) ? 'sous-tache' : 'tache';
  }
  return null;
}

/**
 * Ancêtres de l'élément dans l'arbre (catégorie → projet → chantier → tâche…), premier emplacement si l'élément
 * est partagé. Une catégorie et un chantier virtuel n'ont pas de référence.
 * @returns {{kind:string, title:string, ref:{table:string,id:number}|null}[]}
 */
export function breadcrumb(model, ref) {
  const start = nodeIndex(model).get(`${ref.table}:${ref.id}`);
  const out = [];
  for (let n = model.nodes.get(start?.parentKey), i = 0; n && i < MAX_DEPTH; n = model.nodes.get(n.parentKey), i++)
    out.unshift({ kind: n.kind, title: n.title, ref: n.ref });
  return out;
}

/** Tâches de premier niveau d'un chantier, par titre. */
export function chantierItems(model, chantierId) {
  return [...model.tasks.values()]
    .filter((t) => t.chantierId === chantierId && !t.parentId)
    .map((t) => t.id)
    .sort(byTitle(model.tasks));
}

/** Chantiers d'un projet, par titre (références). */
export function projectItems(model, projectId) {
  return [...model.chantiers.values()]
    .filter((c) => c.projectIds.includes(projectId))
    .map((c) => c.id)
    .sort(byTitle(model.chantiers))
    .map((id) => ({ table: 'Chantiers', id }));
}

/** Tâches qui dépendent de la tâche donnée (inverse de dependDe). */
export function dependents(model, taskId) {
  return [...model.tasks.values()].filter((t) => t.dependDe.includes(taskId)).map((t) => t.id);
}

/** Adresse sûre d'un lien utile (http ou https seulement), sinon null : le texte est alors affiché tel quel. */
export function safeLink(value) {
  try {
    const u = new URL(String(value ?? '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Sépare les champs renseignés des champs vides (valeur null, undefined ou chaîne vide) : les premiers sont
 * affichés un par ligne, les seconds regroupés sur une seule ligne « Non renseignés : … ».
 * @template T
 * @param {[string, T|null|undefined|''][]} rows paires [clé de libellé, valeur]
 * @returns {{filled:[string, T][], empty:string[]}}
 */
export function splitEmptyFields(rows) {
  const filled = [];
  const empty = [];
  for (const [k, v] of rows) {
    if (v === null || v === undefined || v === '') empty.push(k);
    else filled.push([k, v]);
  }
  return { filled, empty };
}
