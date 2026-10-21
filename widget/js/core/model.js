/** Feuille de route EDS (tables colonnaires) → modèle du widget. Fonctions pures. Voir spec §4. */
import { dayOf } from './dates.js';
import { parseCharges } from './charges.js';
import { aphText, estimationOf } from './estimation.js';
import { readTagsCell } from './tags-edit.js';

export const ISD_ROLES = Object.freeze({ DE: 'DE', DA: 'DA', DS: 'DS', 'PO Data': 'PO' });
export const NO_CHANTIER = '(sans chantier)';
export const NO_CATEGORIE = 'Sans catégorie';
const DONE = new Set(['done']);
/** Équipe ISD : Domaine dont le nom contient le sigle « ISD ». */
const ISD_DOMAIN = /\bISD\b/i;

/**
 * Nom du Domaine ISD : le Domaine porté par une personne dont le nom contient le sigle « ISD », sinon le choix de
 * Team.Domaine qui le contient, sinon null. Jamais de repli sur un autre Domaine (par exemple le plus fourni en
 * profils ISD) : ce Domaine fixe le périmètre ISD et donc les écritures. Sans lui, l'équipe ISD se réduit aux
 * profils ISD (DE, DA, DS, PO Data), sans le Management.
 * @param {Iterable<{domaine:string}>} people
 * @param {string[]} [choices] choix de la colonne Team.Domaine
 */
export function isdDomainOf(people, choices = []) {
  for (const p of people) if (p.domaine && ISD_DOMAIN.test(p.domaine)) return p.domaine;
  return (Array.isArray(choices) ? choices : []).find((d) => typeof d === 'string' && ISD_DOMAIN.test(d)) ?? null;
}

/** Vrai si l'identifiant désigne un membre actif de l'équipe ISD (`isdTeam`, Management ISD compris). */
export const isIsdId = (people, id) => people.get(id)?.isdTeam === true;

/**
 * Vrai si la tâche implique l'ISD : un assigné, le responsable ou une personne chargée est membre actif de
 * l'équipe ISD. Règle du périmètre ISD (buildModel) et du filtre « ISD seulement ».
 * @param {{assignees:number[], responsable:number|null, charges:{personId:number}[]}} task
 * @param {Map<number, object>} people
 */
export function taskInvolvesIsd(task, people) {
  const isd = (id) => isIsdId(people, id);
  return task.assignees.some(isd) || isd(task.responsable) || task.charges.some((c) => isd(c.personId));
}

/** Vrai si le responsable ou un contributeur du chantier est membre actif de l'équipe ISD. */
export function chantierInvolvesIsd(chantier, people) {
  const isd = (id) => isIsdId(people, id);
  return isd(chantier.responsable) || chantier.contributeurs.some(isd);
}

/**
 * Vrai si le projet est porté par l'ISD par lui-même : responsable membre de l'équipe ISD, sponsor ou contributeur
 * clé profil ISD (DE, DA, DS, PO ; pas le Management, pour qu'un Management ISD sponsor d'un projet d'une autre
 * équipe ne l'y fasse pas entrer).
 */
export function projectInvolvesIsd(project, people) {
  const isd = (id) => isIsdId(people, id);
  const profile = (id) => people.get(id)?.isd === true;
  return isd(project.responsable) || project.sponsor.some(profile) || project.contributeursCles.some(profile);
}

/** Vrai si la personne fait partie de l'équipe ISD : profil ISD (DE, DA, DS, PO Data) ou Domaine ISD. */
export function inIsdTeam(person, isd) {
  return Boolean(person.role) || (isd !== null && person.domaine === isd);
}

function rows(table) {
  if (!table?.id) return [];
  const cols = Object.keys(table);
  return table.id.map((_, i) => Object.fromEntries(cols.map((c) => [c, table[c][i]])));
}
const refs = (v) => (Array.isArray(v) && v[0] === 'L' ? v.slice(1).filter((x) => x > 0) : []);
const ref = (v) => (typeof v === 'number' && v > 0 ? v : null);
const text = (v) => (typeof v === 'string' ? v.trim() : '');
/** Tags d'une ligne : liste lue, et contenu brut si la cellule est illisible (null sinon). */
const tagFields = (v) => {
  const c = readTagsCell(v);
  return { tags: c.tags, tagsUnreadable: c.ok ? null : c.raw };
};
const byTitle = (a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' });

export function buildModel(raw) {
  const t = raw.tables;
  const issues = [];
  const people = new Map(
    rows(t.Team).map((r) => [
      r.id,
      {
        id: r.id,
        nom: text(r.nom),
        role: ISD_ROLES[r.role] ?? null,
        /** Profil ISD actif (DE, DA, DS, PO) : filtre Profil, ventilation des ETP par profil. */
        isd: Boolean(ISD_ROLES[r.role] && r.actif),
        /** Membre actif de l'équipe ISD (profil ISD ou Domaine ISD, Management compris) : périmètre ISD. */
        isdTeam: false,
        actif: Boolean(r.actif),
        roleText: text(r.role),
        email: text(r.email),
        // APH (Team.aph, facultative) : texte, colonne Text ou Int (aphText ; comparaison stricte de l'estimation)
        aph: aphText(r.aph),
        domaine: text(r.Domaine),
        n1: ref(r.n_1),
        capaciteHebdo: Number(r.capaciteHebdo) || 0,
        unavailability: [],
      },
    ]),
  );
  const isdName = isdDomainOf(people.values(), raw.choices?.['Team.Domaine']);
  for (const p of people.values()) p.isdTeam = p.actif && inIsdTeam(p, isdName);
  for (const r of rows(t.Disponibilites)) {
    const p = people.get(ref(r.membre)),
      start = dayOf(r.dateDebut),
      end = dayOf(r.dateFin);
    if (!p || start === null || end === null || end < start) continue;
    const d = Number(r.dispo);
    p.unavailability.push({
      id: r.id,
      start,
      end,
      dispo: Number.isFinite(d) ? Math.min(1, Math.max(0, d > 1 ? d / 100 : d)) : 0,
      type: text(r.type),
    });
  }

  const projects = new Map(
    rows(t.Projects).map((r) => [
      r.id,
      {
        id: r.id,
        title: text(r.nom),
        categorie: text(r.Categorie),
        status: text(r.Statut),
        start: dayOf(r.dateDebut),
        end: dayOf(r.dateFin),
        responsable: ref(r.responsable),
        sponsor: refs(r.Sponsor),
        contributeursCles: refs(r.Contributeurs_cles),
        priorite: text(r.Priorite_de_la_direction),
        demandeur: text(r.Commanditaires),
        description: text(r.Description),
        inScope: false,
      },
    ]),
  );
  const chantiers = new Map(
    rows(t.Chantiers).map((r) => [
      r.id,
      {
        id: r.id,
        title: text(r.Nom_du_chantier),
        projectIds: refs(r.Projets),
        status: text(r.Statut),
        start: dayOf(r.Debut),
        end: dayOf(r.Fin),
        responsable: ref(r.Responsable),
        contributeurs: refs(r.Contributeurs),
        priorite: text(r.Priorite),
        criteres: text(r.Criteres_de_succes),
        description: text(r.Description),
        // Dépendances du chantier (vers des tâches) : une tâche visée ne se supprime pas (delete-plan.js)
        dependDe: refs(r.dependDe),
        ...tagFields(r.tags),
      },
    ]),
  );
  const tasks = new Map();
  for (const r of rows(t.Tasks)) {
    const parsed = parseCharges(r.charges);
    if (parsed.error === 'json' || parsed.error === 'format' || parsed.error === 'entree')
      issues.push({ kind: 'charges-invalides', taskId: r.id });
    const known = parsed.charges.filter((c) => people.has(c.personId));
    if (known.length < parsed.charges.length) issues.push({ kind: 'charge-personne-inconnue', taskId: r.id });
    const task = {
      id: r.id,
      title: text(r.titre),
      description: text(r.description),
      status: text(r.statut),
      done: DONE.has(r.statut),
      start: dayOf(r.dateDebut),
      end: dayOf(r.dateEcheance),
      closed: dayOf(r.dateCloture),
      projectId: ref(r.projet),
      chantierId: ref(r.Chantier),
      parentId: ref(r.parentTask),
      childIds: [],
      assignees: refs(r.assignees),
      responsable: ref(r.Responsable),
      charges: known,
      dependDe: refs(r.dependDe),
      estimationH: Number(r.estimationH) || 0,
      tempsPasse: Number(r.tempsPasse) || 0,
      commentaire: text(r.Commentaire),
      lien: text(r.Lien_utile),
      criteres: text(r.Chantier_Criteres_de_succes),
      type: text(r.type),
      priorite: text(r.priorite),
      progression: typeof r.progression === 'number' && Number.isFinite(r.progression) ? r.progression : null,
      ...tagFields(r.tags),
    };
    if (task.start !== null && task.end !== null && task.end < task.start)
      issues.push({ kind: 'dates-incoherentes', taskId: r.id });
    if (known.length && (task.start === null || task.end === null))
      issues.push({ kind: 'charge-sans-dates', taskId: r.id });
    if (!task.projectId && !task.chantierId && !task.parentId) issues.push({ kind: 'tache-orpheline', taskId: r.id });
    tasks.set(r.id, task);
  }
  for (const task of tasks.values())
    if (!task.parentId) continue;
    else if (tasks.has(task.parentId)) tasks.get(task.parentId).childIds.push(task.id);
    else issues.push({ kind: 'parent-introuvable', taskId: task.id });
  for (const c of chantiers.values())
    if (!c.responsable) issues.push({ kind: 'chantier-sans-responsable', chantierId: c.id });

  // ---- Arbre (spec §4.2) : catégorie → projet → chantier → tâche → sous-tâche, sans cas particulier ----
  const nodes = new Map();
  const categories = new Map();
  const node = (key, kind, title, refObj, extra = {}) => {
    const n = {
      key,
      kind,
      title,
      ref: refObj,
      projectId: null,
      status: '',
      start: null,
      end: null,
      span: null,
      children: [],
      taskId: null,
      parentKey: null,
      ...extra,
    };
    nodes.set(key, n);
    return n;
  };
  // Tâche (premier niveau) puis sous-tâches, à toute profondeur
  const taskNode = (prefix, task, kind, parentKey, projectId) => {
    const key = `${prefix}/T${task.id}`;
    const n = node(
      key,
      kind,
      task.title,
      { table: 'Tasks', id: task.id },
      {
        taskId: task.id,
        status: task.status,
        start: task.start,
        end: task.end,
        milestone: task.type === 'jalon',
        parentKey,
        projectId,
      },
    );
    n.children = task.childIds
      .map((id) => tasks.get(id))
      .sort(byTitle)
      .map((c) => taskNode(key, c, 'sous-tache', key, projectId));
    return n;
  };
  const topTasks = (pred) => [...tasks.values()].filter((x) => !x.parentId && pred(x)).sort(byTitle);
  const categorie = (title) => {
    if (!categories.has(title)) categories.set(title, node(`C:${title}`, 'categorie', title, null));
    return categories.get(title);
  };

  for (const p of [...projects.values()].sort(byTitle)) {
    const cat = categorie(p.categorie || NO_CATEGORIE);
    const key = `P${p.id}`;
    const proj = node(
      key,
      'projet',
      p.title,
      { table: 'Projects', id: p.id },
      { projectId: p.id, status: p.status, start: p.start, end: p.end, parentKey: cat.key },
    );
    for (const c of [...chantiers.values()].filter((x) => x.projectIds.includes(p.id)).sort(byTitle)) {
      const ck = `${key}/C${c.id}`;
      const ch = node(
        ck,
        'chantier',
        c.title,
        { table: 'Chantiers', id: c.id },
        { projectId: p.id, status: c.status, start: c.start, end: c.end, parentKey: key },
      );
      ch.children = topTasks((x) => x.chantierId === c.id).map((x) => taskNode(ck, x, 'tache', ck, p.id));
      proj.children.push(ch);
    }
    // Tâches du projet sans chantier : chantier virtuel « (sans chantier) »
    const loose = topTasks((x) => x.projectId === p.id && !x.chantierId);
    if (loose.length) {
      const ck = `${key}/C0`;
      const ch = node(ck, 'chantier', NO_CHANTIER, null, { projectId: p.id, parentKey: key });
      ch.children = loose.map((x) => taskNode(ck, x, 'tache', ck, p.id));
      proj.children.push(ch);
    }
    cat.children.push(proj);
  }

  // Étendue : dates propres, sinon min/max des descendants
  const span = (n) => {
    const kids = n.children.map(span).filter(Boolean);
    const starts = [n.start, ...kids.map((k) => k.start)].filter((x) => x !== null);
    const ends = [n.end, ...kids.map((k) => k.end)].filter((x) => x !== null);
    n.span =
      starts.length && ends.length ? { start: n.start ?? Math.min(...starts), end: n.end ?? Math.max(...ends) } : null;
    return n.span;
  };
  categories.forEach(span);

  // ---- Périmètre ISD (spec §4.3) ----
  // Responsable du projet, rôle sur un chantier ou sur une tâche : toute personne active de l'équipe ISD
  // (Management ISD compris). Sponsor ou contributeur clé : profils ISD seulement, pour qu'un Management ISD
  // sponsor du projet d'une autre équipe ne le fasse pas entrer dans le périmètre (il reste visible dans « Mes
  // chantiers », non modifiable).
  const taskTouches = (task) => taskInvolvesIsd(task, people);
  const subtreeTasks = (n, acc = []) => {
    if (n.taskId) acc.push(tasks.get(n.taskId));
    n.children.forEach((c) => subtreeTasks(c, acc));
    return acc;
  };
  for (const p of projects.values()) {
    const projNode = nodes.get(`P${p.id}`);
    const chs = [...chantiers.values()].filter((c) => c.projectIds.includes(p.id));
    p.inScope =
      projectInvolvesIsd(p, people) ||
      chs.some((c) => chantierInvolvesIsd(c, people)) ||
      subtreeTasks(projNode).some(taskTouches);
  }

  const observed = [...new Set([...tasks.values()].map((x) => x.status).filter(Boolean))];
  return {
    people,
    /** Domaine ISD (isdDomainOf), calculé une fois : équipe ISD, périmètre, sélecteurs, onglet Équipe. */
    isdDomain: isdName,
    // Personnes estimation (Team.aph = ESTIMATION_APH, actives) : toutes exemptées de la borne de 1 ETP
    estimation: estimationOf(people.values()),
    projects,
    chantiers,
    tasks,
    nodes,
    issues,
    tree: [...categories.values()].sort(byTitle),
    choices: raw.choices ?? {},
    roles: raw.choices?.['Team.role'] ?? [...new Set([...people.values()].map((p) => p.roleText).filter(Boolean))],
    statuses: {
      tasks: raw.choices?.['Tasks.statut'] ?? observed,
      chantiers: raw.choices?.['Chantiers.Statut'] ?? [
        ...new Set([...chantiers.values()].map((c) => c.status).filter(Boolean)),
      ],
    },
  };
}
