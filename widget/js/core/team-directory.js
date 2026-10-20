/**
 * Onglet Équipe (lecture seule) : rôles, équipes (Domaine) et utilisateurs de la table Team, fiche personne.
 * Fonctions pures.
 */
import { hoursToEtp } from './capacity.js';
import { isEstimationPerson } from './estimation.js';
import { ISD_ROLES } from './model.js';
import { normalize } from './text.js';

/** Capacité hebdomadaire par défaut (h) quand Team.capaciteHebdo est vide ou nul. */
export const DEFAULT_WEEKLY_HOURS = 35;

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
const EMAIL = /^[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"']+\.[^\s@<>()[\]\\,;:"']{2,}$/;
/** Statuts de chantier considérés comme clos. */
const CLOSED = /termin|clos|abandon|annul/i;
/** Équipe ISD : Domaine dont le nom contient le sigle « ISD ». */
const ISD_DOMAIN = /\bISD\b/i;

/** Vrai si le texte est une adresse électronique utilisable dans un lien mailto. */
export function isValidEmail(s) {
  return typeof s === 'string' && EMAIL.test(s.trim());
}

/** Libellé court d'un rôle de la Feuille : « PO » pour « PO Data » (comme le reste du widget), sinon tel quel. */
export function roleShort(roleText) {
  return ISD_ROLES[roleText] ?? roleText ?? '';
}

/** Capacité hebdomadaire effective d'une personne (h). */
export const weeklyHours = (p) => (p.capaciteHebdo > 0 ? p.capaciteHebdo : DEFAULT_WEEKLY_HOURS);

/**
 * Indisponibilités en cours ou à venir (fin ≥ aujourd'hui), par date de début.
 * @param {{unavailability?:{start:number, end:number, dispo:number, type?:string}[]}} person
 * @param {number} today
 */
export function upcomingUnavailability(person, today) {
  return (person.unavailability ?? []).filter((u) => u.end >= today).sort((a, b) => a.start - b.start);
}

/**
 * Nom de l'équipe ISD : le Domaine qui contient « ISD », sinon celui qui compte le plus de personnes de profil
 * ISD (DE, DA, DS, PO Data), sinon null.
 */
export function isdDomain(model) {
  const names = [...new Set([...model.people.values()].map((p) => p.domaine).filter(Boolean))];
  const named = names.find((d) => ISD_DOMAIN.test(d));
  if (named) return named;
  const counts = new Map();
  for (const p of model.people.values())
    if (p.domaine && p.role) counts.set(p.domaine, (counts.get(p.domaine) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]))[0]?.[0] ?? null;
}

/** Vrai si la personne fait partie de l'équipe ISD : profil ISD (DE, DA, DS, PO Data) ou Domaine ISD. */
export function inIsdTeam(person, isd) {
  return Boolean(person.role) || (isd !== null && person.domaine === isd);
}

/** Vrai si la personne fait partie de l'équipe ISD du modèle (voir inIsdTeam) ; faux pour une personne absente. */
export function isIsdTeamMember(model, person) {
  return Boolean(person) && inIsdTeam(person, isdDomain(model));
}

/**
 * Rôle affiché à côté du nom d'une personne : profil ISD (PO, DA, DS, DE), « Management » pour le Management de
 * l'équipe ISD (Domaine ISD), sinon null (pas de badge). Actif ou non : une valeur déjà saisie reste lisible.
 * @returns {'PO'|'DA'|'DS'|'DE'|'Management'|null}
 */
export function displayRole(model, person) {
  if (!person) return null;
  if (person.role) return person.role;
  return person.roleText === 'Management' && isIsdTeamMember(model, person) ? 'Management' : null;
}

/** Personnes actives de l'équipe ISD (voir inIsdTeam). */
function activeIsd(model) {
  const isd = isdDomain(model);
  return [...model.people.values()].filter((p) => p.actif && inIsdTeam(p, isd));
}

const byName = (a, b) => collator.compare(a.nom, b.nom);
/** Groupes des listes de personnes, dans l'ordre : profils ISD (libellés courts), puis Management. */
export const PICKER_GROUPS = Object.freeze(['PO', 'DA', 'DS', 'DE', 'Management']);

/**
 * Groupes des sélecteurs de personne (Je suis, Personne, Responsable, assignés…) : PO, DA, DS, DE (personnes
 * actives de profil ISD), puis Management (personnes actives de rôle Management qui font partie de l'équipe
 * ISD, c'est-à-dire du Domaine ISD ; le Management des autres domaines est exclu). Personnes triées par nom,
 * groupes vides omis.
 * @param {object} model
 * @returns {{role:string, people:object[]}[]}
 */
export function pickerGroups(model) {
  const isd = isdDomain(model);
  const people = [...model.people.values()].sort(byName);
  const members = (role) =>
    role === 'Management'
      ? people.filter((p) => p.actif && p.roleText === 'Management' && inIsdTeam(p, isd))
      : people.filter((p) => p.isd && p.role === role);
  return PICKER_GROUPS.map((role) => ({ role, people: members(role) })).filter((g) => g.people.length);
}

/** Ordre des rôles (onglet Équipe) : profils ISD, puis Management ; les autres rôles suivent. */
export const ROLE_ORDER = Object.freeze(['DE', 'DA', 'DS', 'PO Data', 'Management']);

/**
 * Rôles portés par des personnes : ceux de ROLE_ORDER dans cet ordre, puis les autres de la liste de choix
 * Team.role (dans son ordre), puis les valeurs saisies hors liste (triées).
 */
function orderedRoles(model, roles) {
  const choices = (model.roles ?? []).filter((r) => !ROLE_ORDER.includes(r));
  const extra = [...roles].filter((r) => !ROLE_ORDER.includes(r) && !choices.includes(r)).sort(collator.compare);
  return [...ROLE_ORDER, ...choices, ...extra].filter((r) => roles.has(r));
}

/**
 * Rôles de l'équipe ISD : chaque rôle porté par au moins une personne active de l'équipe ISD (ordre de
 * orderedRoles), avec ses personnes actives et leur capacité
 * hebdomadaire totale (35 h par défaut chacune). Les personnes sans rôle n'ont pas de ligne (voir
 * isdTeamSummary.noRole).
 * @returns {{role:string, label:string, active:number, hours:number}[]}
 */
export function roleSummary(model) {
  const people = activeIsd(model);
  const roles = new Set(people.map((p) => p.roleText ?? '').filter(Boolean));
  return orderedRoles(model, roles).map((role) => {
    const group = people.filter((p) => p.roleText === role);
    return { role, label: roleShort(role), active: group.length, hours: group.reduce((s, p) => s + weeklyHours(p), 0) };
  });
}

/**
 * Synthèse de l'équipe ISD (personnes actives) : effectif, répartition par rôle, capacité hebdomadaire totale
 * et personnes sans rôle.
 * @param {object} model
 * @returns {{domaine:string|null, count:number, roles:{role:string, label:string, n:number}[], hours:number,
 *   noRole:number}}
 */
export function isdTeamSummary(model) {
  const people = activeIsd(model);
  return {
    domaine: isdDomain(model),
    count: people.length,
    roles: roleSummary(model).map((r) => ({ role: r.role, label: r.label, n: r.active })),
    hours: people.reduce((s, p) => s + weeklyHours(p), 0),
    noRole: people.filter((p) => !p.roleText).length,
  };
}

/**
 * Utilisateurs de l'équipe ISD (inIsdTeam), triés par nom ; actifs seulement sauf includeInactive.
 * @param {object} model
 * @param {{query?:string, role?:string|null, includeInactive?:boolean}} [opts]
 *   query : nom, adresse, rôle, équipe (sans accents ni casse) ; role : valeur de Team.role
 * @returns {{id:number, nom:string, email:string, aph:string, estimation:boolean, emailValid:boolean, roleText:string, roleLabel:string,
 *   domaine:string, actif:boolean, isd:boolean, n1:{id:number, nom:string}|null, capaciteHebdo:number|null}[]}
 */
export function filterUsers(model, { query = '', role = null, includeInactive = false } = {}) {
  const isd = isdDomain(model);
  const q = normalize(query);
  return [...model.people.values()]
    .filter((p) => (includeInactive || p.actif) && inIsdTeam(p, isd))
    .filter((p) => role === null || (p.roleText ?? '') === role)
    .filter((p) => !q || [p.nom, p.email, p.roleText, p.domaine].some((x) => normalize(x).includes(q)))
    .sort((a, b) => collator.compare(a.nom, b.nom))
    .map((p) => {
      const boss = p.n1 && p.n1 !== p.id ? model.people.get(p.n1) : null;
      return {
        id: p.id,
        nom: p.nom,
        email: p.email ?? '',
        aph: p.aph ?? '',
        estimation: isEstimationPerson(model, p.id),
        emailValid: isValidEmail(p.email),
        roleText: p.roleText ?? '',
        roleLabel: roleShort(p.roleText),
        domaine: p.domaine ?? '',
        actif: Boolean(p.actif),
        isd: p.isd,
        n1: boss ? { id: boss.id, nom: boss.nom } : null,
        capaciteHebdo: p.capaciteHebdo > 0 ? p.capaciteHebdo : null,
      };
    });
}

/** Clé de section des personnes sans rôle. */
export const NO_ROLE = '';

/** Teinte d'un rôle (classe CSS) : profils ISD comme le Portfolio, Management, autres rôles, sans rôle. */
export function roleTone(roleText) {
  if (!roleText) return 'none';
  if (roleText === 'Management') return 'mgmt';
  return ISD_ROLES[roleText]?.toLowerCase() ?? 'other';
}

/**
 * Utilisateurs de l'équipe ISD groupés par rôle (filterUsers : recherche, rôle, inactifs) : une section par
 * rôle dans l'ordre de orderedRoles, puis « Sans rôle » ; les sections vides ne sont pas rendues.
 * hours = capacité hebdomadaire des seules personnes actives de la section (35 h par défaut chacune).
 * @param {object} model
 * @param {{query?:string, role?:string|null, includeInactive?:boolean}} [opts]
 * @returns {{role:string, label:string, tone:string, people:object[], count:number, inactive:number,
 *   hours:number}[]}
 */
export function groupUsersByRole(model, opts = {}) {
  const users = filterUsers(model, opts);
  const section = (role, people) => ({
    role,
    label: roleShort(role),
    tone: roleTone(role),
    people,
    count: people.length,
    inactive: people.filter((p) => !p.actif).length,
    hours: people.filter((p) => p.actif).reduce((s, p) => s + weeklyHours(p), 0),
  });
  const roles = new Set(users.map((u) => u.roleText).filter(Boolean));
  const groups = orderedRoles(model, roles).map((role) =>
    section(
      role,
      users.filter((u) => u.roleText === role),
    ),
  );
  const none = users.filter((u) => !u.roleText);
  return none.length ? [...groups, section(NO_ROLE, none)] : groups;
}

const taskDays = (t) => (t.start !== null && t.end !== null && t.end >= t.start ? t.end - t.start + 1 : 0);
const current = (start, end, today) => end === null || end >= today || start === null;

/**
 * Tâches et chantiers en cours ou à venir d'une personne. Une tâche est retenue si elle n'est pas terminée,
 * que la personne y est assignée, responsable ou chargée, et que son échéance n'est pas passée (ou absente).
 * Un chantier est retenu s'il n'est pas clos, pas terminé avant aujourd'hui, et que la personne en est
 * responsable, contributrice ou chargée sur l'une de ses tâches retenues.
 * @param {object} model
 * @param {number} personId
 * @param {number} today
 * @returns {{tasks:{id:number, title:string, status:string, start:number|null, end:number|null,
 *   chantierId:number|null, roles:string[], hours:number, etp:number|null}[],
 *   chantiers:{id:number, title:string, status:string, start:number|null, end:number|null,
 *   roles:string[], hours:number}[]}}
 */
export function personItems(model, personId, today) {
  const tasks = [];
  for (const t of model.tasks.values()) {
    if (t.done || !current(t.start, t.end, today)) continue;
    const roles = [];
    if (t.responsable === personId) roles.push('responsable');
    if (t.assignees.includes(personId)) roles.push('assignee');
    const hours = t.charges.filter((c) => c.personId === personId).reduce((s, c) => s + c.heures, 0);
    if (hours > 0) roles.push('charge');
    if (!roles.length) continue;
    const days = taskDays(t);
    tasks.push({
      id: t.id,
      title: t.title,
      status: t.status,
      start: t.start,
      end: t.end,
      chantierId: t.chantierId,
      roles,
      hours,
      etp: hours > 0 && days ? hoursToEtp(hours, days) : null,
    });
  }
  const byDate = (a, b) =>
    (a.start ?? Infinity) - (b.start ?? Infinity) ||
    (a.end ?? Infinity) - (b.end ?? Infinity) ||
    collator.compare(a.title, b.title);
  tasks.sort(byDate);

  const chantiers = [];
  for (const c of model.chantiers.values()) {
    if (CLOSED.test(c.status) || !current(c.start, c.end, today)) continue;
    const roles = [];
    if (c.responsable === personId) roles.push('responsable');
    if (c.contributeurs.includes(personId)) roles.push('contributeur');
    const hours = tasks.filter((t) => t.chantierId === c.id).reduce((s, t) => s + t.hours, 0);
    if (hours > 0) roles.push('charge');
    if (!roles.length) continue;
    chantiers.push({ id: c.id, title: c.title, status: c.status, start: c.start, end: c.end, roles, hours });
  }
  chantiers.sort(byDate);
  return { tasks, chantiers };
}
