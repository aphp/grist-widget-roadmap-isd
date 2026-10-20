/**
 * Personnes de l'équipe ISD (lot 2d) : fiche personne en formulaire, création d'une personne, désactivation et
 * réactivation, indisponibilités. Fonctions pures, sans écriture (l'envoi est grist-writer.js).
 *
 * Périmètre (Q14 A) : seules les personnes affichées par l'onglet Équipe (profil ISD ou Domaine ISD, Management
 * compris) sont modifiables, et leurs valeurs d'arrivée restent dans ce périmètre. Une personne créée l'est avec
 * le Domaine ISD de la Feuille et un rôle parmi les profils ISD ou Management. Aucun rôle n'est créé : les rôles
 * sont les choix existants de Team.role. « Supprimer » une personne = la désactiver (Q9), jamais de suppression.
 *
 * Le brouillon contient les valeurs du modèle : textes (nom, email, role), nombre ou null (capaciteHebdo : null =
 * 35 h par défaut), identifiant ou null (n_1). Indisponibilités : jours (dateDebut, dateFin), part disponible de 0
 * à 1 (dispo), textes (type, commentaire).
 */
import { CAPACITY_MAX, NAME_MAX, validCapacity } from './grist-writer.js';
import { ISD_ROLES } from './model.js';
import { ROLE_ORDER, inIsdTeam, isValidEmail, isdDomain, pickerGroups } from './team-directory.js';
import { sameValue } from './write-encode.js';

export { CAPACITY_MAX };

/** Champs du formulaire d'une personne (l'actif se change par « Désactiver » / « Réactiver »). */
export const PERSON_FIELDS = Object.freeze(['nom', 'email', 'role', 'capaciteHebdo', 'n_1']);
/** Champs d'une indisponibilité (le membre est fixé à la création). */
export const UNAV_FIELDS = Object.freeze(['dateDebut', 'dateFin', 'type', 'dispo', 'commentaire']);

/** Rôles proposés à la création : profils ISD et Management (Q14 A). */
export const ADD_ROLES = Object.freeze([...Object.keys(ISD_ROLES), 'Management']);

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
const ISD_NAME = /\bISD\b/i;
const trim = (v) => (typeof v === 'string' ? v.trim() : v);
/** Capacité du modèle : 0 ou vide = null (35 h par défaut). */
const cap = (v) => (typeof v === 'number' && v > 0 ? v : null);
/** Part disponible enregistrée de 0 à 1 ; une valeur ancienne en pourcentage (> 1) est ramenée à 0-1. */
const share = (v) => (typeof v === 'number' && Number.isFinite(v) ? (v > 1 ? v / 100 : v) : null);

/**
 * Domaine ISD de la Feuille : celui que portent les personnes (team-directory.js:isdDomain), sinon le choix de
 * Team.Domaine qui contient « ISD », sinon null.
 */
export function isdDomainValue(model) {
  const fromPeople = isdDomain(model);
  if (fromPeople && ISD_NAME.test(fromPeople)) return fromPeople;
  return (model.choices?.['Team.Domaine'] ?? []).find((d) => ISD_NAME.test(d)) ?? fromPeople;
}

/** La personne fait-elle partie du périmètre modifiable (équipe ISD, active ou non) ? */
export function personInScope(model, person) {
  return Boolean(person) && inIsdTeam(person, isdDomainValue(model));
}

/**
 * Valeurs d'arrivée d'une personne (création ou rôle changé) : elles doivent rester dans l'équipe ISD (profil ISD
 * ou Domaine ISD). À la création : Domaine ISD ET rôle parmi les profils ISD ou Management.
 * @param {{role?:string, Domaine?:string}} v valeurs du modèle (colonnes Team)
 */
export function teamValuesInScope(model, v, { add = false } = {}) {
  const isd = isdDomainValue(model);
  if (add) return isd !== null && v.Domaine === isd && ADD_ROLES.includes(v.role);
  return Boolean(ISD_ROLES[v.role]) || (isd !== null && v.Domaine === isd);
}

/**
 * Rôles proposés dans le formulaire : les choix de Team.role (jamais un nouveau rôle), profils ISD puis
 * Management, dans l'ordre de l'onglet Équipe ; la valeur actuelle est gardée si elle n'en fait pas partie.
 * @param {string} [current]
 * @param {{add?:boolean}} [opts] add : profils ISD et Management seulement
 */
export function roleOptions(model, current = '', { add = false } = {}) {
  const choices = model.choices?.['Team.role'] ?? model.roles ?? [];
  const allowed = add ? ADD_ROLES : choices;
  const ordered = [...ROLE_ORDER, ...choices.filter((r) => !ROLE_ORDER.includes(r))];
  const list = ordered.filter((r) => choices.includes(r) && allowed.includes(r));
  return current && !list.includes(current) ? [...list, current] : list;
}

/** Brouillon initial (copie) depuis les valeurs relues de la ligne Team. */
export function personDraftFrom(base) {
  return {
    nom: base.nom ?? '',
    email: base.email ?? '',
    role: base.role ?? '',
    capaciteHebdo: cap(base.capaciteHebdo),
    n_1: base.n_1 ?? null,
  };
}

/** Colonnes modifiées : seules celles-ci sont envoyées (nom et e-mail nettoyés de leurs espaces de bord). */
export function diffPerson(base, draft) {
  const out = {};
  for (const f of PERSON_FIELDS) {
    if (!(f in draft)) continue;
    const b = f === 'capaciteHebdo' ? cap(base[f]) : (base[f] ?? (f === 'n_1' ? null : ''));
    // Champ non touché (même s'il porte des espaces de bord dans la Feuille) : jamais réécrit
    if (sameValue(b, draft[f] ?? (f === 'n_1' ? null : ''))) continue;
    const v = trim(draft[f]);
    if (!sameValue(b, f === 'n_1' ? (v ?? null) : v)) out[f] = v;
  }
  return out;
}

/** Nouvelle base (ligne relue) : les champs que l'utilisateur n'a pas touchés suivent la Feuille. */
export function rebasePerson(oldBase, draft, fresh) {
  const out = { ...draft };
  const from = personDraftFrom(oldBase);
  const next = personDraftFrom({ ...oldBase, ...fresh });
  for (const f of PERSON_FIELDS) if (f in fresh && sameValue(from[f], draft[f])) out[f] = next[f];
  return out;
}

/**
 * Règles du formulaire d'une personne (fiche ou création). Les erreurs bloquent l'enregistrement ; les
 * avertissements non.
 * @param {object} draft brouillon
 * @param {{model:object, personId?:number|null, domaine?:string}} ctx personId null : création ; domaine : Domaine
 *   de la personne (fiche) ou celui de la création
 * @returns {{errors:Record<string,{key:string, vars?:object}>, warnings:{field:string, key:string, vars?:object}[]}}
 */
export function validatePerson(draft, { model, personId = null, domaine = '' }) {
  const errors = {};
  const warnings = [];
  const add = personId === null;
  const nom = String(draft.nom ?? '').trim();
  if (!nom) errors.nom = { key: 'person.error.nameEmpty' };
  else if (nom.length > NAME_MAX) errors.nom = { key: 'form.error.titleLong', vars: { max: NAME_MAX } };
  const email = String(draft.email ?? '').trim();
  if (email && !isValidEmail(email)) errors.email = { key: 'person.error.email' };
  const choices = model.choices?.['Team.role'] ?? [];
  if (add && !draft.role) errors.role = { key: 'person.error.roleRequired' };
  else if (draft.role && (!choices.includes(draft.role) || (add && !ADD_ROLES.includes(draft.role))))
    errors.role = { key: 'person.error.role' };
  else if (!add && !teamValuesInScope(model, { role: draft.role, Domaine: domaine }))
    errors.role = { key: 'person.error.scope' };
  if (draft.capaciteHebdo !== null && !validCapacity(draft.capaciteHebdo))
    errors.capaciteHebdo = { key: 'person.error.capacity', vars: { max: CAPACITY_MAX } };
  if (draft.n_1 !== null) {
    if (!model.people.has(draft.n_1)) errors.n_1 = { key: 'form.error.missingRef' };
    else if (draft.n_1 === personId) errors.n_1 = { key: 'person.error.n1Self' };
  }
  if (email) {
    const same = [...model.people.values()].find(
      (p) => p.id !== personId && p.email && collator.compare(p.email.trim(), email) === 0,
    );
    if (same) warnings.push({ field: 'email', key: 'person.warn.emailDuplicate', vars: { nom: same.nom } });
  }
  if (add && nom) {
    const same = [...model.people.values()].find((p) => collator.compare(p.nom, nom) === 0);
    if (same) warnings.push({ field: 'nom', key: 'person.warn.nameDuplicate' });
  }
  return { errors, warnings };
}

/** Brouillon d'une nouvelle personne. */
export function newPersonDraft() {
  return { nom: '', email: '', role: '', capaciteHebdo: null, n_1: null };
}

/**
 * Valeurs de création d'une personne : nom, rôle, Domaine ISD, actif ; e-mail, capacité et N+1 seulement s'ils
 * sont renseignés et que la colonne peut être remplie (canAddField).
 */
export function newPersonFields(draft, { model, canAddField = () => true }) {
  const out = { nom: String(draft.nom ?? '').trim(), role: draft.role, Domaine: isdDomainValue(model), actif: true };
  const email = String(draft.email ?? '').trim();
  if (email && canAddField('email')) out.email = email;
  if (draft.capaciteHebdo !== null && canAddField('capaciteHebdo')) out.capaciteHebdo = draft.capaciteHebdo;
  if (draft.n_1 !== null && canAddField('n_1')) out.n_1 = draft.n_1;
  return out;
}

/**
 * Candidats N+1 : d'abord le Management actif de tous les Domaines (un N+1 est le plus souvent un manager), puis
 * l'équipe ISD des sélecteurs (pickerGroups : PO, DA, DS, DE ; son Management est déjà dans le premier groupe). La
 * personne elle-même est exclue. La valeur actuelle hors de ces groupes (inactive, autre rôle, autre Domaine, ou
 * ligne absente) est gardée dans `kept` pour rester affichée.
 * @returns {{management:object[], isd:{role:string, people:object[]}[],
 *   kept:{id:number, person:object|null, inactive:boolean}|null}}
 */
export function n1Candidates(model, personId = null, current = null) {
  const notSelf = (p) => p.id !== personId;
  const management = [...model.people.values()]
    .filter((p) => notSelf(p) && p.actif && p.roleText === 'Management')
    .sort((a, b) => collator.compare(a.nom, b.nom));
  const isd = pickerGroups(model)
    .filter((g) => g.role !== 'Management')
    .map((g) => ({ role: g.role, people: g.people.filter(notSelf) }))
    .filter((g) => g.people.length);
  const listed = new Set([...management, ...isd.flatMap((g) => g.people)].map((p) => p.id));
  let kept = null;
  if (current !== null && current !== personId && !listed.has(current)) {
    const person = model.people.get(current) ?? null;
    kept = { id: current, person, inactive: Boolean(person && !person.actif) };
  }
  return { management, isd, kept };
}

// ---------- Indisponibilités ----------

/** Indisponibilités d'une personne (lignes brutes de Disponibilites), par date de début. */
export function personUnavailabilities(rawTable, personId) {
  const t = rawTable ?? { id: [] };
  return t.id
    .map((id, i) => ({ id, i }))
    .filter(({ i }) => t.membre?.[i] === personId)
    .map(({ id }) => id);
}

/** Brouillon d'une indisponibilité depuis ses valeurs relues (null : nouvelle). */
export function unavDraftFrom(base) {
  return {
    dateDebut: base?.dateDebut ?? null,
    dateFin: base?.dateFin ?? null,
    type: base?.type ?? '',
    dispo: share(base?.dispo ?? null) ?? 0,
    commentaire: base?.commentaire ?? '',
  };
}

/** Colonnes modifiées d'une indisponibilité (type et commentaire nettoyés de leurs espaces de bord). */
export function diffUnav(base, draft) {
  const from = unavDraftFrom(base);
  const out = {};
  for (const f of UNAV_FIELDS) {
    if (!(f in draft) || sameValue(from[f], draft[f])) continue;
    const v = trim(draft[f]);
    if (!sameValue(from[f], v)) out[f] = v;
  }
  return out;
}

/** Nouvelle base d'une indisponibilité : les champs non touchés suivent la Feuille. */
export function rebaseUnav(oldBase, draft, fresh) {
  const from = unavDraftFrom(oldBase);
  const next = unavDraftFrom({ ...oldBase, ...fresh });
  const out = { ...draft };
  for (const f of UNAV_FIELDS) if (sameValue(from[f], draft[f])) out[f] = next[f];
  return out;
}

/** Part disponible saisie en pourcentage (0 à 100) → valeur enregistrée (0 à 1) ; null si invalide. */
export function shareFromPercent(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return Math.round(pct * 100) / 10000;
}

/** Règles d'une indisponibilité : début et fin obligatoires, fin ≥ début, part de 0 à 100 %. */
export function validateUnav(draft) {
  const errors = {};
  if (draft.dateDebut === null) errors.dateDebut = { key: 'unav.error.required' };
  if (draft.dateFin === null) errors.dateFin = { key: 'unav.error.required' };
  else if (draft.dateDebut !== null && draft.dateFin < draft.dateDebut)
    errors.dateFin = { key: 'form.error.finBeforeDebut' };
  if (draft.dispo === null || !(draft.dispo >= 0 && draft.dispo <= 1)) errors.dispo = { key: 'unav.error.dispo' };
  if (String(draft.type ?? '').trim().length > NAME_MAX)
    errors.type = { key: 'form.error.titleLong', vars: { max: NAME_MAX } };
  return { errors, warnings: [] };
}

/** Valeurs de création d'une indisponibilité (membre, dates, part ; type et commentaire s'ils sont saisis). */
export function newUnavFields(draft, membre) {
  const out = { membre, dateDebut: draft.dateDebut, dateFin: draft.dateFin, dispo: draft.dispo };
  const type = String(draft.type ?? '').trim();
  const commentaire = String(draft.commentaire ?? '').trim();
  if (type) out.type = type;
  if (commentaire) out.commentaire = commentaire;
  return out;
}
