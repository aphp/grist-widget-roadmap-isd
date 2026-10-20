/**
 * SEUL module du widget qui écrit dans Grist (vérifié par tests/write-guard.test.js).
 *
 * - Liste blanche figée : WRITABLE (table → colonnes modifiables, colonnes permises à la création).
 *   Tasks, Chantiers, Team et Disponibilites seulement ; Projects n'y figure pas ; aucune action de structure (pas
 *   de table, pas de colonne, pas d'options de colonne : un rôle ou un Domaine doit être un choix existant).
 * - Les vues ne construisent jamais d'action : elles passent des valeurs du modèle (jours, identifiants, textes)
 *   à writer.update() ou writer.add(), qui les encode selon le type attendu de la colonne (write-encode.js).
 * - Contrôle strict avant tout envoi (integrityProblem) : champs obligatoires, références vers des lignes
 *   existantes, projet compris dans les projets du chantier, tâche parente du même chantier et sans cycle, ordre
 *   des dates, sous-tâches qui suivent leur tâche quand elle change de chantier, tâches qui gardent un projet du
 *   chantier quand ses projets changent ; règle de périmètre ISD (canWriteRow, canWriteValues).
 * - Suppression : seulement pour annuler une création faite dans la session (Q9), jamais autrement, et jamais
 *   dans Team (NO_REMOVE) : une personne se désactive (actif à faux).
 * - Modes : 'off' (toute écriture refusée, défaut), 'dry-run' (mode essai : journalisé, rien n'est envoyé),
 *   'on' (envoi). Le mode vient de edit-switch.js (paramètre d'adresse, flags.json, verrou de document).
 * - Contrôle des colonnes au chargement : une colonne absente, devenue formule ou de type inattendu est retirée
 *   de la liste blanche pour la session. Une colonne refusée par une règle d'accès l'est aussi, au premier refus.
 */
import { chargesWriteProblem, periodDays } from './charges-edit.js';
import { aphText, estimationIdOfTable, isEstimationAph } from './estimation.js';
import { readTagsCell, tagsWriteProblem } from './tags-edit.js';
import { isValidEmail } from './team-directory.js';
import { EncodeError, decodeValue, encodeValue, sameValue } from './write-encode.js';

/**
 * Colonnes modifiables par table et par opération. update : mise à jour d'une ligne existante (lots 2a, 2b, 2c) ;
 * add : colonnes permises à la création (lot 2c ; Tasks.charges depuis le bloc « Personnes » des fenêtres de
 * création, avec les mêmes contrôles qu'en mise à jour). Priorite des chantiers en lecture (Q5). Tags (lot 2e,
 * Q3 B) : affectés et retirés dans les fiches, jamais à la création ; aucune option de colonne n'est jamais modifiée.
 */
export const WRITABLE = Object.freeze({
  Tasks: Object.freeze({
    update: Object.freeze([
      'titre',
      'statut',
      'type',
      'dateDebut',
      'dateEcheance',
      'dateCloture',
      'priorite',
      'Responsable',
      'assignees',
      'description',
      'Commentaire',
      'Lien_utile',
      'progression',
      'parentTask',
      'dependDe',
      'charges',
      'Chantier',
      'projet',
      'tags',
    ]),
    add: Object.freeze([
      'titre',
      'statut',
      'type',
      'dateDebut',
      'dateEcheance',
      'priorite',
      'Responsable',
      'assignees',
      'charges',
      'description',
      'Chantier',
      'projet',
      'parentTask',
      'Cree_par',
    ]),
  }),
  Chantiers: Object.freeze({
    update: Object.freeze([
      'Nom_du_chantier',
      'Projets',
      'Statut',
      'Debut',
      'Fin',
      'Responsable',
      'Contributeurs',
      'Description',
      'Objectifs_resultats_attendus',
      'Criteres_de_succes',
      'tags',
    ]),
    add: Object.freeze([
      'Nom_du_chantier',
      'Projets',
      'Statut',
      'Debut',
      'Fin',
      'Responsable',
      'Contributeurs',
      'Description',
    ]),
  }),
  // Lot 2d : personnes de l'équipe ISD (Q14 A). Domaine seulement à la création (forcé à l'ISD) ; jamais de
  // suppression d'une personne : « Supprimer » = actif à faux (Q9). aph : identifiant APH, chiffres seulement
  // (validAph) ; comme capaciteHebdo, jamais écrit tant que c'est une colonne formule (vide) de la Feuille.
  Team: Object.freeze({
    update: Object.freeze(['nom', 'email', 'aph', 'role', 'capaciteHebdo', 'actif', 'n_1']),
    add: Object.freeze(['nom', 'email', 'aph', 'role', 'Domaine', 'capaciteHebdo', 'actif', 'n_1']),
  }),
  // Lot 2d : indisponibilités d'une personne ISD ; membre fixé à la création.
  Disponibilites: Object.freeze({
    update: Object.freeze(['type', 'dateDebut', 'dateFin', 'dispo', 'commentaire']),
    add: Object.freeze(['membre', 'type', 'dateDebut', 'dateFin', 'dispo', 'commentaire']),
  }),
});

/** Colonnes lues en plus de la liste blanche (contrôle du périmètre : Domaine d'une personne, membre d'une indisponibilité). */
export const READ_ALSO = Object.freeze({
  Team: Object.freeze(['Domaine']),
  Disponibilites: Object.freeze(['membre']),
});

/** Tables dont aucune ligne n'est jamais supprimée, même pour annuler une création (une personne se désactive). */
export const NO_REMOVE = Object.freeze(['Team']);

/** Capacité hebdomadaire maximale d'une personne (h), au pas de 0,5 h ; 0 exclu (vide = 35 h par défaut). */
export const CAPACITY_MAX = 60;

/** Longueur maximale d'un APH (Team.aph) : de 1 à 10 chiffres, 7 le plus souvent. */
export const APH_MAX_DIGITS = 10;
/** Longueur habituelle d'un APH (avertissement seulement). */
export const APH_USUAL_DIGITS = 7;
/** APH accepté à l'écriture : texte de 1 à 10 chiffres, sans espace (le formulaire nettoie les bords). */
export const validAph = (v) => typeof v === 'string' && /^[0-9]{1,10}$/.test(v);

/** Colonnes obligatoires à la création (non vides). */
export const REQUIRED_ON_ADD = Object.freeze({
  Tasks: Object.freeze(['titre', 'Chantier', 'projet']),
  Chantiers: Object.freeze(['Nom_du_chantier', 'Projets']),
  Team: Object.freeze(['nom', 'role', 'Domaine', 'actif']),
  Disponibilites: Object.freeze(['membre', 'dateDebut', 'dateFin']),
});

/** Type Grist attendu de chaque colonne de la liste blanche (schéma de la Feuille). */
export const EXPECTED_TYPES = Object.freeze({
  'Tasks.titre': 'Text',
  'Tasks.statut': 'Choice',
  'Tasks.type': 'Choice',
  'Tasks.dateDebut': 'Date',
  'Tasks.dateEcheance': 'Date',
  'Tasks.dateCloture': 'Date',
  'Tasks.priorite': 'Choice',
  'Tasks.Responsable': 'Ref:Team',
  'Tasks.assignees': 'RefList:Team',
  'Tasks.description': 'Text',
  'Tasks.Commentaire': 'Text',
  'Tasks.Lien_utile': 'Text',
  'Tasks.progression': 'Numeric',
  'Tasks.parentTask': 'Ref:Tasks',
  'Tasks.dependDe': 'RefList:Tasks',
  'Tasks.charges': 'Text',
  'Tasks.Chantier': 'Ref:Chantiers',
  'Tasks.projet': 'Ref:Projects',
  'Tasks.Cree_par': 'Text',
  'Tasks.tags': 'ChoiceList',
  'Chantiers.Nom_du_chantier': 'Text',
  'Chantiers.Projets': 'RefList:Projects',
  'Chantiers.Statut': 'Choice',
  'Chantiers.Debut': 'Date',
  'Chantiers.Fin': 'Date',
  'Chantiers.Responsable': 'Ref:Team',
  'Chantiers.Contributeurs': 'RefList:Team',
  'Chantiers.Description': 'Text',
  'Chantiers.Objectifs_resultats_attendus': 'Text',
  'Chantiers.Criteres_de_succes': 'Text',
  'Chantiers.tags': 'ChoiceList',
  'Team.nom': 'Text',
  'Team.email': 'Text',
  'Team.aph': 'Text',
  'Team.role': 'Choice',
  'Team.Domaine': 'Choice',
  'Team.capaciteHebdo': 'Numeric',
  'Team.actif': 'Bool',
  'Team.n_1': 'Ref:Team',
  'Disponibilites.membre': 'Ref:Team',
  'Disponibilites.type': 'Text',
  'Disponibilites.dateDebut': 'Date',
  'Disponibilites.dateFin': 'Date',
  'Disponibilites.dispo': 'Numeric',
  'Disponibilites.commentaire': 'Text',
});

/**
 * Types acceptés en plus du type attendu, pour une colonne que la Feuille peut avoir convertie. Team.aph : saisir
 * une valeur dans sa colonne vide la convertit en colonne de données dont Grist devine le type, Text ou Int. Int
 * est accepté (valeur du modèle toujours en texte, aphText ; écrite en nombre, encodeAph). Numeric, Choice et les
 * autres types restent refusés (raison 'type', champ en lecture) : décimales possibles, aller-retour non exact.
 */
export const ALSO_ACCEPTED_TYPES = Object.freeze({ 'Team.aph': Object.freeze(['Int']) });

/** Le type relu d'une colonne de la liste blanche est-il accepté ? */
const acceptedType = (k, type) => type === EXPECTED_TYPES[k] || Boolean(ALSO_ACCEPTED_TYPES[k]?.includes(type));

/** Colonnes dont les options (choix) pourraient être gérées : aucune avant le lot 2g (gestion des tags). */
export const CHOICE_COLUMNS = Object.freeze([]);

/**
 * Seules actions que le writer sait produire. RemoveRecord : uniquement pour annuler une création de la session.
 * BulkUpdateRecord : lignes dérivées d'un même enregistrement (sous-tâches qui suivent leur tâche).
 */
export const ALLOWED_ACTIONS = Object.freeze(['UpdateRecord', 'BulkUpdateRecord', 'AddRecord', 'RemoveRecord']);

export const MODES = Object.freeze(['off', 'dry-run', 'on']);

/** Longueur maximale d'un titre de tâche ou d'un nom de chantier. */
export const NAME_MAX = 300;
const MAX_DEPTH = 50;

/** Écriture refusée par le widget lui-même, avant tout envoi. */
export class WriteRefused extends Error {
  constructor(reason, detail = '') {
    super(detail ? `${reason} : ${detail}` : reason);
    this.name = 'WriteRefused';
    this.reason = reason;
  }
}

/**
 * Écriture refusée ou échouée côté Grist. kind : 'acl' (règle d'accès), 'missing' (ligne disparue), 'timeout'
 * (pas de réponse dans le délai : l'écriture a pu avoir lieu, résultat inconnu), 'other'.
 * document : vrai si le refus vaut pour tout le document (compte sans droit d'écriture).
 */
export class WriteFailed extends Error {
  constructor(kind, message, document = false) {
    super(message);
    this.name = 'WriteFailed';
    this.kind = kind;
    this.document = document;
  }
}

/** Délai maximal d'une requête vers Grist ou vers flags.json (ms). */
export const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Promesse limitée dans le temps : au-delà de ms, rejet avec l'erreur fournie (la requête d'origine n'est pas
 * annulée ; son résultat est ignoré).
 */
export function withTimeout(promise, ms, makeError) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
  });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), limit]);
}

const has = (obj, k) => typeof k === 'string' && Object.hasOwn(obj, k);
const isId = (v) => Number.isInteger(v) && v > 0;

/** Refus portant sur tout le document (compte lecteur) : « No write access » de Grist. */
export function isDocumentRefusal(message) {
  return /no write access|document is read[- ]only/i.test(String(message ?? ''));
}

/** Nature d'une erreur renvoyée par Grist, d'après son message. */
export function classifyError(message) {
  const m = String(message ?? '');
  if (/no write access|access rules|no permission|not authori[sz]ed|blocked by|forbidden|insufficient access/i.test(m))
    return 'acl';
  // Vrai Grist : « [Sandbox] AssertionError docactions.[Bulk]UpdateRecord for non-existent record #N » ; faux Grist :
  // « Invalid row id N in Table » (RemoveRecord d'une ligne absente : accepté sans erreur par le vrai Grist)
  if (/invalid row id|row id .* (not found|does not exist)|no such row|non-existent record|KeyError: \d+/i.test(m))
    return 'missing';
  return 'other';
}

const key = (table, col) => `${table}.${col}`;

/**
 * Colonnes de la liste blanche à retirer pour la session, d'après les métadonnées lues au chargement.
 * @param {Record<string,{type:string,isFormula:boolean}>|null} columns métadonnées 'Table.colonne' → type
 * @returns {Map<string,'absente'|'formule'|'vide'|'type'|'meta'>}
 */
export function checkColumns(columns) {
  const out = new Map();
  for (const k of Object.keys(EXPECTED_TYPES)) {
    const c = columns?.[k];
    if (!columns) out.set(k, 'meta');
    else if (!c) out.set(k, 'absente');
    // Colonne « vide » (formule sans formule) : l'écrire la convertirait en colonne de données (structure)
    else if (c.isFormula) out.set(k, c.empty ? 'vide' : 'formule');
    else if (!acceptedType(k, c.type)) out.set(k, 'type');
  }
  return out;
}

/**
 * Type d'écriture d'une colonne : son type relu s'il est accepté (ALSO_ACCEPTED_TYPES), sinon le type attendu
 * (une colonne d'un autre type est de toute façon retirée de la liste blanche par checkColumns).
 * @param {Record<string,{type:string}>|null} [columns] métadonnées lues
 */
export function columnTypeOf(columns, table, col) {
  const k = key(table, col);
  const type = columns?.[k]?.type;
  return type && acceptedType(k, type) ? type : (EXPECTED_TYPES[k] ?? null);
}

/**
 * Cellule Team.aph depuis la valeur du modèle (texte de 1 à 10 chiffres, ou vide), selon le type de la colonne.
 * Text : la chaîne telle quelle (vide → ''). Int : le nombre (vide → null) ; un zéro de tête est refusé (Int le
 * perdrait : la valeur relue ne serait plus celle saisie). Jamais l'APH d'estimation (refus 'aph-estimation').
 */
export function encodeAph(type, value) {
  if (isEstimationAph(value)) throw new WriteRefused('aph-estimation');
  if (type === 'Text') return encodeValue('Text', value);
  if (type !== 'Int') throw new EncodeError(`type de colonne non pris en charge : ${type}`);
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new EncodeError('APH en texte attendu');
  if (!validAph(value)) throw new WriteRefused('aph', 'Team.aph');
  if (value.startsWith('0')) throw new WriteRefused('aph-zero', 'Team.aph');
  return Number(value);
}

/** Valeur encodée d'une colonne de la liste blanche (WriteRefused 'encodage' si impossible). */
function encodeCol(table, col, value, columns = null) {
  const type = columnTypeOf(columns, table, col);
  try {
    if (key(table, col) === 'Team.aph') return encodeAph(type, value);
    return encodeValue(type, value);
  } catch (e) {
    if (e instanceof EncodeError) throw new WriteRefused('encodage', `${key(table, col)} : ${e.message}`);
    throw e;
  }
}

/**
 * Construit l'action UpdateRecord d'une ligne, après contrôle de la liste blanche et encodage. Fonction pure.
 * @param {string} table
 * @param {number} id
 * @param {Record<string,*>} changes valeurs du modèle, colonne → valeur
 * @param {Map<string,string>} [disabled] colonnes retirées pour la session
 * @param {{before?:object, refExists?:(table:string, id:number) => boolean, restoring?:string[],
 *          days?:number|null, isEstimation?:(teamId:number) => boolean}} [ctx] days : jours de la période de la
 *   tâche après modification (borne 1 ETP) ; isEstimation : personne estimation (Team.aph), exemptée de cette borne
 *   before : valeurs d'avant (les entrées de charges conservées telles quelles ne sont pas recontrôlées) ;
 *   refExists : existence d'une ligne (teamId des charges dans Team) ; restoring : colonnes remises à leur
 *   valeur d'avant par « Annuler » (contenu d'origine, éventuellement illisible : pas de contrôle) ; current : ligne
 *   lue par le writer lui-même (cellule de tags illisible, contrôlée même pour « Annuler ») ; columns : métadonnées
 *   lues (type d'écriture d'une colonne au type accepté en plus, columnTypeOf : Team.aph en Int).
 * @returns {['UpdateRecord', string, number, Record<string,*>]}
 */
export function buildUpdate(table, id, changes, disabled = new Map(), ctx = {}) {
  if (typeof table !== 'string' || table.startsWith('_grist')) throw new WriteRefused('table', String(table));
  const allowed = has(WRITABLE, table) ? WRITABLE[table].update : null;
  if (!allowed) throw new WriteRefused('table', table);
  if (!isId(id)) throw new WriteRefused('identifiant', String(id));
  const cols = Object.keys(changes ?? {});
  if (!cols.length) throw new WriteRefused('vide');
  const fields = {};
  for (const col of cols) {
    if (!allowed.includes(col)) throw new WriteRefused('colonne', key(table, col));
    if (disabled.has(key(table, col))) throw new WriteRefused('colonne-retiree', key(table, col));
    if (key(table, col) === 'Tasks.charges' && !ctx.restoring?.includes(col)) {
      const problem = chargesWriteProblem(
        changes[col],
        ctx.before?.[col],
        (n) => Boolean(ctx.refExists?.('Team', n)),
        ctx.days ?? null,
        ctx.isEstimation ?? null,
      );
      if (problem) throw new WriteRefused('charges', problem);
    }
    // Cellule de tags illisible dans la ligne lue par le writer (current) ou d'après l'appelant (before) : remplacée
    // seulement sur confirmation de CE contenu (replaceTags), jamais par « Annuler »
    if (col === 'tags') {
      const unreadable = [ctx.current?.tagsUnreadable, ctx.before?.tagsUnreadable].find((x) => typeof x === 'string');
      if (unreadable !== undefined && ctx.replaceTags !== unreadable)
        throw new WriteRefused('tags-illisible', key(table, col));
    }
    // Tags : liste de chaînes, nouveaux tags nettoyés et bornés, aucun doublon ajouté ; valeurs d'avant recopiées
    if (col === 'tags' && !ctx.restoring?.includes(col)) {
      const problem = tagsWriteProblem(changes[col], ctx.before?.[col] ?? []);
      if (problem) throw new WriteRefused(problem === 'trop' ? 'tags-trop' : 'tags', problem);
    }
    fields[col] = encodeCol(table, col, changes[col], ctx.columns);
  }
  return ['UpdateRecord', table, id, fields];
}

/** Valeur vide d'une colonne obligatoire (texte vide, référence absente, liste vide). */
const isBlank = (v) =>
  v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length) || v === 0;

/**
 * Charges d'une tâche à créer : mêmes règles qu'en mise à jour (chargesWriteProblem, sans cellule d'avant : chaque
 * entrée est contrôlée, borne de 1 ETP sur la période des dates du même AddRecord, exemption de la personne
 * estimation) et cohérence du bloc « Personnes » : une seule entrée par personne, chaque personne chargée assignée
 * (ajouter une personne l'assigne ; une charge sans assignation ne se crée pas). Fonction pure.
 * @returns {string|null} raison du refus
 */
export function newChargesProblem(fields, teamExists, isEstimation = null) {
  const value = fields.charges;
  const days = periodDays(fields.dateDebut ?? null, fields.dateEcheance ?? null);
  const problem = chargesWriteProblem(value, null, teamExists, days, isEstimation);
  if (problem) return problem;
  const assigned = new Set(Array.isArray(fields.assignees) ? fields.assignees : []);
  const seen = new Set();
  for (const e of JSON.parse(value)) {
    if (seen.has(e.teamId)) return `personne en double : ${e.teamId}`;
    seen.add(e.teamId);
    if (!assigned.has(e.teamId)) return `personne chargée non assignée : ${e.teamId}`;
  }
  return null;
}

/**
 * Construit l'action AddRecord d'une nouvelle ligne, après contrôle de la liste blanche (colonnes de création),
 * des colonnes obligatoires et de l'encodage. Fonction pure.
 * @param {{refExists?:(table:string, id:number) => boolean, isEstimation?:(teamId:number) => boolean,
 *          columns?:object|null}} [ctx] contrôle des charges d'une tâche (newChargesProblem) : personnes existantes, personne estimation ; columns :
 *   métadonnées lues (type d'écriture de Team.aph, Text ou Int, columnTypeOf)
 * @returns {['AddRecord', string, null, Record<string,*>]}
 */
export function buildAdd(table, fields, disabled = new Map(), ctx = {}) {
  if (typeof table !== 'string' || table.startsWith('_grist')) throw new WriteRefused('table', String(table));
  const allowed = has(WRITABLE, table) ? WRITABLE[table].add : null;
  if (!allowed) throw new WriteRefused('table', table);
  const cols = Object.keys(fields ?? {});
  for (const col of REQUIRED_ON_ADD[table])
    if (!cols.includes(col) || isBlank(fields[col])) throw new WriteRefused('requis', key(table, col));
  const out = {};
  for (const col of cols) {
    if (!allowed.includes(col)) throw new WriteRefused('colonne', key(table, col));
    if (disabled.has(key(table, col))) throw new WriteRefused('colonne-retiree', key(table, col));
    if (key(table, col) === 'Tasks.charges') {
      const problem = newChargesProblem(fields, (n) => Boolean(ctx.refExists?.('Team', n)), ctx.isEstimation ?? null);
      if (problem) throw new WriteRefused('charges', problem);
    }
    out[col] = encodeCol(table, col, fields[col], ctx.columns);
  }
  return ['AddRecord', table, null, out];
}

/**
 * Lignes dérivées d'un enregistrement (déjà encodées en UpdateRecord) : regroupées par table et par jeu de
 * colonnes, une BulkUpdateRecord par groupe de deux lignes ou plus.
 */
export function groupRows(actions) {
  const groups = new Map();
  for (const a of actions) {
    const k = `${a[1]}|${Object.keys(a[3]).sort().join(',')}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  return [...groups.values()].map((g) => {
    if (g.length === 1) return g[0];
    const cols = Object.keys(g[0][3]).sort();
    return [
      'BulkUpdateRecord',
      g[0][1],
      g.map((a) => a[2]),
      Object.fromEntries(cols.map((c) => [c, g.map((a) => a[3][c])])),
    ];
  });
}

/**
 * Vérifie un lot avant envoi : actions connues, tables et colonnes de la liste blanche ; RemoveRecord seulement
 * sur une ligne créée dans la session (removable). Lève WriteRefused.
 * @param {any[]} actions
 * @param {{removable?:(table:string, id:number) => boolean}} [opts]
 */
export function assertActions(actions, opts = {}) {
  if (!Array.isArray(actions) || !actions.length) throw new WriteRefused('vide');
  for (const a of actions) {
    if (!Array.isArray(a) || !ALLOWED_ACTIONS.includes(a[0])) throw new WriteRefused('action', String(a?.[0]));
    const [name, table, id, fields] = a;
    if (typeof table !== 'string' || table.startsWith('_grist') || !has(WRITABLE, table))
      throw new WriteRefused('table', String(table));
    if (name === 'AddRecord') {
      if (id !== null) throw new WriteRefused('identifiant', String(id));
      if (!fields || typeof fields !== 'object') throw new WriteRefused('vide');
      for (const col of Object.keys(fields))
        if (!WRITABLE[table].add.includes(col)) throw new WriteRefused('colonne', key(table, col));
      continue;
    }
    if (name === 'RemoveRecord') {
      if (NO_REMOVE.includes(table)) throw new WriteRefused('suppression', `${table} ${id}`);
      if (!isId(id) || a.length !== 3) throw new WriteRefused('identifiant', String(id));
      if (!opts.removable?.(table, id)) throw new WriteRefused('suppression', `${table} ${id}`);
      continue;
    }
    if (name === 'BulkUpdateRecord') {
      if (!Array.isArray(id) || !id.length || !id.every(isId) || new Set(id).size !== id.length)
        throw new WriteRefused('identifiant', String(id));
      for (const [col, values] of Object.entries(fields ?? {})) {
        if (!WRITABLE[table].update.includes(col)) throw new WriteRefused('colonne', key(table, col));
        if (!Array.isArray(values) || values.length !== id.length) throw new WriteRefused('encodage', col);
      }
      continue;
    }
    if (!isId(id)) throw new WriteRefused('identifiant', String(id));
    for (const col of Object.keys(fields ?? {}))
      if (!WRITABLE[table].update.includes(col)) throw new WriteRefused('colonne', key(table, col));
  }
}

/**
 * Copie des tables brutes avec les actions appliquées (correction locale du modèle). Fonction pure.
 * AddRecord doit porter l'identifiant attribué (actions « appliquées » du journal) ; une colonne inconnue de la
 * table est ignorée, les autres reçoivent null.
 */
export function applyToTables(tables, actions) {
  const out = { ...tables };
  const copy = (table) => {
    const t = { ...out[table] };
    for (const c of Object.keys(t)) t[c] = [...t[c]];
    out[table] = t;
    return t;
  };
  const setRow = (t, i, fields) => {
    for (const [col, v] of Object.entries(fields)) if (t[col]) t[col][i] = v;
  };
  for (const [name, table, id, fields] of actions) {
    if (!out[table]?.id) continue;
    if (name === 'UpdateRecord') {
      const i = out[table].id.indexOf(id);
      if (i >= 0) setRow(copy(table), i, fields);
    } else if (name === 'BulkUpdateRecord' && Array.isArray(id)) {
      const t = copy(table);
      id.forEach((rowId, n) => {
        const i = t.id.indexOf(rowId);
        if (i >= 0) setRow(t, i, Object.fromEntries(Object.entries(fields).map(([c, vs]) => [c, vs[n]])));
      });
    } else if (name === 'AddRecord' && isId(id) && !out[table].id.includes(id)) {
      const t = copy(table);
      for (const c of Object.keys(t)) t[c].push(c === 'id' ? id : null);
      setRow(t, t.id.length - 1, fields ?? {});
    } else if (name === 'RemoveRecord') {
      const i = out[table].id.indexOf(id);
      if (i < 0) continue;
      const t = copy(table);
      for (const c of Object.keys(t)) t[c].splice(i, 1);
    }
  }
  return out;
}

/** Valeurs du modèle d'une ligne brute (format colonnaire de fetchTable), pour les colonnes de la liste blanche. */
export function decodeRow(tableData, table, id) {
  const i = tableData?.id?.indexOf(id) ?? -1;
  if (i < 0) return null;
  const out = {};
  // Team.aph : texte, que la colonne soit Text ou Int (aphText : 0 ou vide → '')
  for (const col of [...(WRITABLE[table]?.update ?? []), ...(READ_ALSO[table] ?? [])])
    out[col] =
      key(table, col) === 'Team.aph'
        ? aphText(tableData[col]?.[i])
        : decodeValue(EXPECTED_TYPES[key(table, col)], tableData[col]?.[i]);
  // Cellule de tags illisible (texte, ['E', …], éléments non textuels) : son contenu, pour ne jamais l'écraser en
  // silence ; null si elle est lisible (toujours présente : un ancien signalement ne survit pas à une relecture)
  if ('tags' in out) {
    const cell = readTagsCell(tableData.tags?.[i]);
    out.tagsUnreadable = cell.ok ? null : cell.raw;
  }
  return out;
}

/**
 * Plan d'annulation d'une écriture : remet les valeurs d'avant, sauf sur les cellules modifiées depuis par
 * quelqu'un d'autre (valeur relue différente de celle écrite). Fonction pure.
 * @param {{before:object, after:object}} entry
 * @param {object|null} fresh valeurs relues de la ligne (null : ligne disparue)
 * @returns {{changes:object, skipped:string[]}}
 */
export function planUndo(entry, fresh) {
  const changes = {};
  const skipped = [];
  for (const [col, v] of Object.entries(entry.after)) {
    // Cellule de tags devenue illisible (texte importé…) : jamais réécrite par une annulation
    if (col === 'tags' && typeof fresh?.tagsUnreadable === 'string') skipped.push(col);
    else if (fresh && sameValue(fresh[col], v)) changes[col] = entry.before[col];
    else skipped.push(col);
  }
  return { changes, skipped };
}

/**
 * Contrôle strict d'un lot (création ou mise à jour d'une ou plusieurs lignes), sur les valeurs du modèle.
 * Seules les règles qui portent sur des colonnes du lot sont contrôlées (une ligne déjà incohérente dans la Feuille
 * reste modifiable sur ses autres colonnes). Fonction pure.
 * @param {{table:string, id:number|null, values:object}[]} items id null : création
 * @param {{row(table:string, id:number):object|null, childIds?(taskId:number):number[],
 *          chantierTasks?(chantierId:number):number[]}} lookup valeurs actuelles (decodeRow des données lues),
 *   sous-tâches directes d'une tâche, tâches portant le chantier
 * @returns {string|null} raison du refus
 */
export function integrityProblem(items, lookup) {
  const overlay = new Map();
  const touched = new Map();
  const rk = (t, id) => `${t}:${id}`;
  for (const it of items) {
    if (it.id === null) continue;
    const cur = lookup.row(it.table, it.id);
    if (!cur) return 'ligne';
    overlay.set(rk(it.table, it.id), { ...cur, ...it.values });
    touched.set(rk(it.table, it.id), new Set(Object.keys(it.values)));
  }
  const current = (t, id) => overlay.get(rk(t, id)) ?? lookup.row(t, id);
  const exists = (t, id) => Boolean(lookup.row(t, id));
  /** Chantier effectif d'une tâche (le sien, sinon celui d'un ancêtre). */
  const chantierOf = (taskId) => {
    for (let id = taskId, i = 0; id && i < MAX_DEPTH; i++) {
      const r = current('Tasks', id);
      if (!r) return null;
      if (r.Chantier) return r.Chantier;
      id = r.parentTask;
    }
    return null;
  };
  for (const it of items) {
    const add = it.id === null;
    const after = add ? it.values : overlay.get(rk(it.table, it.id));
    const ch = new Set(Object.keys(it.values));
    const touches = (...cols) => add || cols.some((c) => ch.has(c));
    const nameBad = (s) => typeof s !== 'string' || !s.trim() || s.trim().length > NAME_MAX;
    // Personnes (Responsable, assignees, Contributeurs, teamId des charges) : toute ligne existante de Team est
    // admise, Management compris ; le périmètre ISD porte sur la tâche ou le chantier (canWriteRow, canWriteValues)
    if (touches('Responsable') && after.Responsable && !exists('Team', after.Responsable)) return 'reference';
    if (it.table === 'Tasks') {
      if (touches('titre') && nameBad(after.titre)) return 'titre';
      if (touches('Chantier') && after.Chantier && !exists('Chantiers', after.Chantier)) return 'reference';
      if (touches('projet') && after.projet && !exists('Projects', after.projet)) return 'reference';
      if (touches('Chantier', 'projet') && after.Chantier && after.projet) {
        const c = current('Chantiers', after.Chantier);
        if (!c?.Projets?.includes(after.projet)) return 'projet-chantier';
      }
      if (touches('parentTask', 'Chantier') && after.parentTask) {
        if (!current('Tasks', after.parentTask)) return 'reference';
        if (!add)
          for (let p = after.parentTask, i = 0; p && i < MAX_DEPTH; p = current('Tasks', p)?.parentTask, i++)
            if (p === it.id) return 'cycle';
        if (after.Chantier && chantierOf(after.parentTask) !== after.Chantier) return 'parent-chantier';
      }
      // Une tâche qui change de chantier ou de projet emmène toutes ses sous-tâches (même chantier, même projet)
      if (!add && (ch.has('Chantier') || ch.has('projet')))
        for (const c of lookup.childIds?.(it.id) ?? []) {
          const o = current('Tasks', c);
          if (!o) return 'sous-taches';
          if (ch.has('Chantier') && (!touched.get(rk('Tasks', c))?.has('Chantier') || o.Chantier !== after.Chantier))
            return 'sous-taches';
          if (o.projet !== after.projet) return 'sous-taches';
        }
      if (touches('dateDebut', 'dateEcheance') && after.dateDebut && after.dateEcheance)
        if (after.dateEcheance < after.dateDebut) return 'dates';
      if (touches('assignees') && (after.assignees ?? []).some((p) => !exists('Team', p))) return 'reference';
      if (touches('dependDe') && (after.dependDe ?? []).some((t) => !current('Tasks', t))) return 'reference';
      if (!add && ch.has('dependDe')) {
        // Cycle de dépendances : la tâche dépendrait, directement ou non, d'elle-même
        const seen = new Set();
        const stack = [...(after.dependDe ?? [])];
        while (stack.length) {
          const d = stack.pop();
          if (d === it.id) return 'cycle-dependance';
          if (seen.has(d) || seen.size > 5000) continue;
          seen.add(d);
          stack.push(...(current('Tasks', d)?.dependDe ?? []));
        }
      }
      if (add && 'Cree_par' in after && after.Cree_par !== '' && !/^[^\s@]{1,100}$/.test(String(after.Cree_par)))
        return 'cree-par';
    } else if (it.table === 'Chantiers') {
      if (touches('Nom_du_chantier') && nameBad(after.Nom_du_chantier)) return 'nom';
      if (touches('Projets')) {
        if (!after.Projets?.length) return 'projets';
        if (after.Projets.some((p) => !exists('Projects', p))) return 'reference';
        if (!add)
          for (const t of lookup.chantierTasks?.(it.id) ?? []) {
            const o = current('Tasks', t);
            if (o?.projet && !after.Projets.includes(o.projet)) return 'taches-projet';
          }
      }
      if (touches('Debut', 'Fin') && after.Debut && after.Fin && after.Fin < after.Debut) return 'dates';
      if (touches('Contributeurs') && (after.Contributeurs ?? []).some((p) => !exists('Team', p))) return 'reference';
    } else if (it.table === 'Team') {
      const problem = personProblem(it, after, touches, add, lookup, nameBad);
      if (problem) return problem;
    } else if (it.table === 'Disponibilites') {
      if (touches('membre') && !exists('Team', after.membre)) return 'reference';
      if (touches('dateDebut', 'dateFin')) {
        if (!after.dateDebut || !after.dateFin) return 'dates-requises';
        if (after.dateFin < after.dateDebut) return 'dates';
      }
      if (
        touches('dispo') &&
        after.dispo !== null &&
        !(Number.isFinite(after.dispo) && after.dispo >= 0 && after.dispo <= 1)
      )
        return 'dispo';
      if (touches('type') && String(after.type ?? '').length > NAME_MAX) return 'texte';
    }
  }
  return null;
}

/** Capacité hebdomadaire acceptée : nombre fini, 0 < h ≤ 60, au pas de 0,5 h. */
export const validCapacity = (h) =>
  typeof h === 'number' && Number.isFinite(h) && h > 0 && h <= CAPACITY_MAX && Number.isInteger(h * 2);

/**
 * Contrôle strict d'une personne (Team) : nom obligatoire, e-mail au bon format (ou vide), rôle et Domaine parmi
 * les choix de la Feuille (aucun nouveau choix : ce serait une modification de structure), capacité, N+1
 * existant et différent de la personne, actif booléen (vrai à la création). Fonction pure.
 */
function personProblem(it, after, touches, add, lookup, nameBad) {
  const choices = (col) => lookup.choices?.(`Team.${col}`) ?? null;
  if (touches('nom') && nameBad(after.nom)) return 'nom-personne';
  if (touches('email') && after.email && !isValidEmail(after.email)) return 'email';
  // APH vide permis (non renseigné) ; sinon chiffres seulement, sans espace
  if (touches('aph') && after.aph !== null && after.aph !== undefined && after.aph !== '' && !validAph(after.aph))
    return 'aph';
  // Personne estimation : se désigne dans la Feuille, jamais depuis le widget (ni poser l'APH, ni le retirer)
  if (touches('aph') && (isEstimationAph(after.aph) || (!add && isEstimationAph(lookup.row('Team', it.id)?.aph))))
    return 'aph-estimation';
  if (touches('role') && !(choices('role') ?? []).includes(after.role)) return 'role';
  if (touches('Domaine') && !(choices('Domaine') ?? []).includes(after.Domaine)) return 'domaine';
  // À la création, une capacité absente ou vide vaut 35 h par défaut
  if (
    touches('capaciteHebdo') &&
    !(add && (after.capaciteHebdo === null || after.capaciteHebdo === undefined)) &&
    !validCapacity(after.capaciteHebdo)
  )
    return 'capacite';
  if (touches('n_1') && after.n_1) {
    if (!lookup.row('Team', after.n_1)) return 'reference';
    if (!add && after.n_1 === it.id) return 'n1-soi';
  }
  if (touches('actif') && typeof after.actif !== 'boolean') return 'actif';
  if (add && after.actif !== true) return 'actif';
  return null;
}

/**
 * Lignes lues (lookup du contrôle strict) à partir de tables brutes colonnaires : valeurs du modèle des colonnes de la
 * liste blanche, sous-tâches directes, tâches portant un chantier, références à une ligne. Les tables absentes de
 * `tables` sont lues dans `base` (lookup des données chargées). Fonction pure.
 */
export function lookupFromTables(tables, base = null) {
  const tasks = () => tables.Tasks;
  const col = (c) => tasks()?.[c] ?? [];
  const ids = (pred) => (tasks()?.id ?? []).filter((_, i) => pred(i));
  return {
    choices: (k) => base?.choices?.(k) ?? null,
    row: (t, id) => (tables[t] ? decodeRow(tables[t], t, id) : (base?.row(t, id) ?? null)),
    estimationId: () => (tables.Team ? estimationIdOfTable(tables.Team) : (base?.estimationId?.() ?? null)),
    childIds: (id) => (tasks() ? ids((i) => col('parentTask')[i] === id) : (base?.childIds?.(id) ?? [])),
    chantierTasks: (id) => (tasks() ? ids((i) => col('Chantier')[i] === id) : (base?.chantierTasks?.(id) ?? [])),
  };
}

/** Colonnes d'une ligne brute qui ne comptent pas pour « ligne intacte » (ordre des vues, affichage calculé). */
const IGNORED = (c) => c === 'id' || c === 'manualSort' || c.startsWith('gristHelper_');

/** Ligne brute (toutes les colonnes) d'une table colonnaire, ou null. */
export function rawRow(tableData, id) {
  const i = tableData?.id?.indexOf(id) ?? -1;
  if (i < 0) return null;
  return Object.fromEntries(Object.keys(tableData).map((c) => [c, tableData[c][i]]));
}

const blankCell = (v) =>
  v === null ||
  v === undefined ||
  v === '' ||
  v === 0 ||
  v === false ||
  (Array.isArray(v) && (v.length === 0 || (v.length === 1 && v[0] === 'L')));

/**
 * Colonnes d'une ligne créée qui ne sont plus celles de la création : comparaison sur TOUTES les colonnes de la
 * ligne relue (hors manualSort et colonnes d'affichage calculées), avec la photo prise juste après la création ;
 * sans photo, les colonnes écrites doivent être identiques et toutes les autres encore vides. Les colonnes
 * formules (isFormula dans les métadonnées déjà lues) sont ignorées : elles peuvent changer sans aucune saisie
 * (avancement, comptes, NOW()…). Fonction pure.
 * @param {object} fresh ligne brute relue
 * @param {object|null} snapshot ligne brute relue juste après la création
 * @param {object} written cellules encodées envoyées par l'AddRecord
 * @param {(col:string) => boolean} [formula] vrai pour une colonne formule de la table
 * @returns {string[]}
 */
export function changedSinceCreation(fresh, snapshot, written, formula = () => false) {
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const cols = new Set([...Object.keys(fresh), ...Object.keys(snapshot ?? {})]);
  return [...cols].filter((c) => {
    if (IGNORED(c) || (!(c in written) && formula(c))) return false;
    if (snapshot) return !same(fresh[c], snapshot[c]);
    return c in written ? !same(fresh[c], written[c]) : !blankCell(fresh[c]);
  });
}

/**
 * Lignes qui référencent une ligne (relues dans la Feuille) : sous-tâches (parentTask), dépendances (dependDe des
 * tâches et des chantiers) pour une tâche ; tâches du chantier (Chantier) pour un chantier. Fonction pure.
 */
export function referencesTo(tables, table, id) {
  // Une indisponibilité n'est référencée par aucune ligne
  if (table !== 'Tasks' && table !== 'Chantiers') return [];
  const t = tables.Tasks ?? { id: [] };
  const list = (v) => Array.isArray(v) && v[0] === 'L' && v.includes(id);
  if (table === 'Chantiers') return t.id.filter((_, i) => t.Chantier?.[i] === id);
  const c = tables.Chantiers ?? { id: [] };
  return [
    ...t.id.filter((_, i) => t.parentTask?.[i] === id || list(t.dependDe?.[i])),
    ...c.id.filter((_, i) => list(c.dependDe?.[i])).map((x) => `chantier ${x}`),
  ];
}

/** Colonnes dont un changement modifie le périmètre d'une ligne (contrôlé sur les valeurs d'après). */
const SCOPE_COLUMNS = Object.freeze({
  Tasks: ['Chantier', 'projet'],
  Chantiers: ['Projets'],
  Team: ['role', 'Domaine'],
  Disponibilites: ['membre'],
});

/**
 * Crée le writer de la session.
 * @param {{docApi:{applyUserActions(a:any[]):Promise<any>}|null, mode:'off'|'dry-run'|'on',
 *          columns:Record<string,{type:string,isFormula:boolean}>|null,
 *          canWriteRow?:(table:string, id:number) => boolean,
 *          canWriteValues?:(table:string, values:object, opts:{add:boolean}) => boolean,
 *          refExists?:(table:string, id:number) => boolean,
 *          lookup?:{row(table:string, id:number):object|null, childIds?(id:number):number[],
 *                   chantierTasks?(id:number):number[], referenced?(table:string, id:number):boolean},
 *          readTable?:(table:string) => Promise<object>,
 *          tempId?:(table:string) => number,
 *          periodOf?:(table:string, id:number) => {start:number|null, end:number|null}|null,
 *          preflight?:() => Promise<boolean>}} opts
 *   lookup.choices(cle) : choix de la colonne 'Table.colonne' lus dans la Feuille (rôle et Domaine d'une personne) ;
 *   canWriteRow : règle de périmètre (Q15 B, Q14 A) d'une ligne existante, contrôlée ici aussi, pas seulement dans
 *   l'interface ; canWriteValues : la même règle sur les valeurs d'une ligne créée ou rattachée ailleurs ;
 *   lookup : lignes lues (contrôle strict des créations, des chantiers et des changements de rattachement : sans
 *   lui, ces écritures sont refusées) ; readTable : relecture d'une table brute dans la Feuille, juste avant l'envoi
 *   (sous-tâches et tâches d'un chantier à jour, ligne créée intacte et non référencée avant de l'annuler, création
 *   sans réponse retrouvée) ; tempId : identifiant local d'une création en mode essai ;
 *   preflight : relu juste avant chaque envoi réel (arrêt d'urgence flags.json) ; faux = rien n'est envoyé.
 */
export function createWriter({
  docApi,
  mode = 'off',
  columns = null,
  canWriteRow = null,
  canWriteValues = null,
  refExists = null,
  lookup = null,
  readTable = null,
  tempId = null,
  periodOf = null,
  preflight = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!MODES.includes(mode)) throw new WriteRefused('mode', String(mode));
  const disabled = checkColumns(columns);
  // Métadonnées des colonnes (type d'écriture de Team.aph, Text ou Int), remplacées à chaque relecture lisible
  let meta = columns;
  const journal = [];
  const created = new Set(); // 'Table:id' créées dans la session (seules lignes supprimables, pour « Annuler »)
  const addRefused = new Set(); // tables où une règle d'accès refuse l'ajout
  const exists = refExists ?? (lookup ? (t, id) => Boolean(lookup.row(t, id)) : null);
  // Personne estimation (titulaire UNIQUE de ESTIMATION_APH dans les données chargées, lookup.estimationId) : seule
  // exemptée de la borne de 1 ETP ; sans lookup, sans titulaire ou avec plusieurs, personne ne l'est
  const isEstimation = (n) => {
    const id = lookup?.estimationId?.() ?? null;
    return Number.isInteger(id) && n === id;
  };
  let seq = 0;
  let blocked = null; // refus sur tout le document : la session passe en lecture
  let undoing = false;

  /** La colonne est-elle modifiable ? reason : 'off', 'viewer', 'table', 'colonne', ou la raison du retrait. */
  function can(table, col) {
    if (mode === 'off') return { ok: false, reason: 'off' };
    if (blocked) return { ok: false, reason: blocked };
    if (!has(WRITABLE, table)) return { ok: false, reason: 'table' };
    if (!WRITABLE[table].update.includes(col)) return { ok: false, reason: 'colonne' };
    const r = disabled.get(key(table, col));
    return r ? { ok: false, reason: r } : { ok: true, reason: 'ok' };
  }

  /** Peut-on créer une ligne dans cette table ? (colonnes obligatoires disponibles, ajout non refusé) */
  function canAdd(table) {
    if (mode === 'off') return { ok: false, reason: 'off' };
    if (blocked) return { ok: false, reason: blocked };
    if (!has(WRITABLE, table) || !WRITABLE[table].add) return { ok: false, reason: 'table' };
    if (addRefused.has(table)) return { ok: false, reason: 'acl' };
    for (const c of REQUIRED_ON_ADD[table]) {
      const r = disabled.get(key(table, c));
      if (r) return { ok: false, reason: r };
    }
    return { ok: true, reason: 'ok' };
  }

  /** Une colonne facultative peut-elle être remplie à la création ? */
  const canAddField = (table, col) =>
    canAdd(table).ok && WRITABLE[table].add.includes(col) && !disabled.has(key(table, col));

  const removable = (table, id) => created.has(`${table}:${id}`);

  async function send(actions) {
    assertActions(actions, { removable });
    try {
      return await withTimeout(
        docApi.applyUserActions(actions),
        timeoutMs,
        () => new WriteFailed('timeout', `délai de ${timeoutMs / 1000} s dépassé`),
      );
    } catch (err) {
      if (err instanceof WriteFailed) throw err;
      const msg = String(err?.message ?? err ?? '');
      throw new WriteFailed(classifyError(msg), msg, isDocumentRefusal(msg));
    }
  }

  /** Arrêt d'urgence relu : sans réponse dans le délai (ou erreur réseau), rien n'est envoyé. */
  async function checkFlags() {
    if (!preflight) return;
    let ok;
    try {
      ok = await withTimeout(preflight(), timeoutMs, () => new WriteRefused('flags-indisponible'));
    } catch {
      throw new WriteRefused('flags-indisponible');
    }
    if (!ok) throw new WriteRefused('coupe');
  }

  /** Contrôle strict et périmètre des valeurs d'après (création, rattachement). */
  function checkItems(items, look = lookup, members = null) {
    const needsLookup = items.some(
      (it) =>
        it.id === null ||
        it.table === 'Chantiers' ||
        it.table === 'Team' ||
        it.table === 'Disponibilites' ||
        ['Chantier', 'projet', 'parentTask', 'dependDe'].some((c) => c in it.values),
    );
    if (needsLookup && !look) throw new WriteRefused('verification');
    if (look) {
      const problem = integrityProblem(items, look);
      if (problem) throw new WriteRefused(problem);
    }
    items.forEach((it, i) => {
      // Ligne dérivée ajoutée par d'autres après le chargement : inconnue du modèle, elle n'est admise que si la
      // relecture prouve qu'elle appartient à la hiérarchie de la ligne principale (sous-tâche, tâche du chantier)
      const newcomer = i > 0 && it.id !== null && !lookup?.row(it.table, it.id) && members?.has(`${it.table}:${it.id}`);
      if (it.id !== null && canWriteRow && !newcomer && !canWriteRow(it.table, it.id))
        throw new WriteRefused('perimetre', `${it.table} ${it.id}`);
      const scopeChange = it.id === null || SCOPE_COLUMNS[it.table]?.some((c) => c in it.values);
      if (scopeChange && canWriteValues) {
        const after = it.id === null ? it.values : { ...(look?.row(it.table, it.id) ?? {}), ...it.values };
        if (!canWriteValues(it.table, after, { add: it.id === null })) throw new WriteRefused('perimetre', it.table);
      }
    });
  }

  /** Lot qui touche la hiérarchie (chantier, projet, parent, dépendances, projets d'un chantier). */
  const structural = (items) =>
    items.some(
      (it) =>
        (it.table === 'Tasks' && ['Chantier', 'projet', 'parentTask', 'dependDe'].some((c) => c in it.values)) ||
        (it.table === 'Chantiers' && 'Projets' in it.values),
    );
  /** En envoi réel, le contrôle d'un tel lot est fait sur les tables relues juste avant l'envoi (checkFresh). */
  const deferred = (items) => mode === 'on' && Boolean(readTable) && structural(items);

  /** Hiérarchie relue de la ligne principale : ses sous-tâches (tâche), ses tâches et leurs sous-tâches (chantier). */
  function hierarchyMembers(main, look) {
    const out = new Set();
    const walk = (id) => {
      for (const c of look.childIds(id))
        if (!out.has(`Tasks:${c}`)) {
          out.add(`Tasks:${c}`);
          walk(c);
        }
    };
    if (main.id === null) return out;
    if (main.table === 'Tasks') walk(main.id);
    else
      for (const t of look.chantierTasks(main.id)) {
        out.add(`Tasks:${t}`);
        walk(t);
      }
    return out;
  }

  /** Table brute relue dans la Feuille, dans le délai ; WriteRefused('relecture') sinon. */
  async function readFresh(table) {
    try {
      const t = await withTimeout(readTable(table), timeoutMs, () => new Error('délai de relecture dépassé'));
      if (!t?.id) throw new Error('table illisible');
      return t;
    } catch {
      throw new WriteRefused('relecture', table);
    }
  }

  /**
   * Envoi réel d'un lot qui touche la hiérarchie (chantier, projet, parent, dépendances, projets d'un chantier) :
   * le contrôle strict est refait sur Tasks et Chantiers relues juste avant l'envoi, pour qu'une sous-tâche ou une
   * tâche ajoutée entre-temps par quelqu'un d'autre ne soit jamais oubliée.
   */
  async function checkFresh(items) {
    if (!deferred(items)) return;
    const [Tasks, Chantiers] = [await readFresh('Tasks'), await readFresh('Chantiers')];
    const look = lookupFromTables({ Tasks, Chantiers }, lookup);
    checkItems(items, look, hierarchyMembers(items[0], look));
  }

  /** Refus d'une règle d'accès ou du document : session ou colonne retirée. */
  function noteFailure(err, cols, table) {
    if (err instanceof WriteFailed && err.document) blocked = 'viewer';
    // Refus d'une règle d'accès : la colonne n'est retirée que si elle est seule dans le lot (sinon on ne
    // sait pas laquelle est visée ; l'utilisateur peut rétablir un champ et réessayer le reste)
    else if (err instanceof WriteFailed && err.kind === 'acl' && cols?.length === 1)
      disabled.set(key(table, cols[0]), 'acl');
  }

  /**
   * Met à jour une ligne : un seul lot, qui ne contient que les colonnes données, plus les lignes dérivées
   * (sous-tâches qui suivent leur tâche, tâches rattachées à un autre projet du chantier).
   * @param {string} table
   * @param {number} id
   * @param {object} changes valeurs du modèle des colonnes modifiées
   * @param {{before?:object, undoOf?:number, period?:{start:number|null, end:number|null},
   *          also?:{table:string, id:number, changes:object, before?:object}[], replaceTags?:string,
   *          fresh?:object}} [opts] fresh : ligne relue par l'appelant juste avant cet envoi (decodeRow) ;
   *   valeurs d'avant (pour « Annuler » ; before.tagsUnreadable : contenu d'une cellule de tags illisible) ;
   *   period : dates de la ligne relue (borne de 1 ETP des charges) ; also : lignes dérivées ; replaceTags :
   *   contenu illisible dont l'utilisateur a confirmé le remplacement
   * @returns {Promise<{seq:number, table:string, id:number, before:object, after:object, actions:any[], sent:boolean}>}
   */
  async function update(table, id, changes, opts = {}) {
    if (mode === 'off') throw new WriteRefused('off');
    if (blocked) throw new WriteRefused(blocked);
    // « Annuler » : seules les colonnes remises exactement à la valeur d'avant de l'écriture annulée échappent
    // au contrôle des charges (le contenu d'origine, même illisible, est rendu tel quel)
    const undone = opts.undoOf ? journal.find((e) => e.seq === opts.undoOf) : null;
    const restoring = undone ? Object.keys(changes).filter((c) => changes[c] === undone.before[c]) : [];
    // Période de la tâche après modification (dates du lot, sinon celles des données) : borne de 1 ETP
    const ch = changes ?? {};
    // APH de la personne estimation d'après la valeur relue juste avant l'envoi (before) : jamais retiré, même si
    // les données chargées sont en retard (conflit « garder la mienne » après une désignation dans la Feuille)
    const holderTouched = (t, c, b) => t === 'Team' && 'aph' in (c ?? {}) && isEstimationAph(b?.aph);
    if (
      holderTouched(table, ch, opts.before) ||
      (opts.also ?? []).some((r) => holderTouched(r.table, r.changes, r.before))
    )
      throw new WriteRefused('aph-estimation');
    // Dates relues juste avant l'envoi si l'appelant les fournit, sinon celles des données chargées
    const period = 'charges' in ch ? (opts.period ?? periodOf?.(table, id) ?? {}) : {};
    const days = periodDays(
      'dateDebut' in ch ? ch.dateDebut : period.start,
      'dateEcheance' in ch ? ch.dateEcheance : period.end,
    );
    // Tags : le writer contrôle lui-même la ligne, pour ne jamais écraser une cellule illisible, quel que soit
    // l'appelant (« Annuler » compris). Envoi réel : la ligne que l'appelant vient de relire pour ce même envoi
    // (opts.fresh, relecture complète de decodeRow) évite une seconde lecture ; sinon la table est relue ici.
    // Mode essai : les données chargées.
    let current = null;
    if (changes && 'tags' in changes) {
      const reread = opts.fresh && 'tagsUnreadable' in opts.fresh && 'tags' in opts.fresh ? opts.fresh : null;
      if (mode !== 'on' || !readTable) current = reread ?? lookup?.row(table, id) ?? null;
      else if (reread) current = reread;
      else {
        try {
          current = decodeRow(await readFresh(table), table, id);
        } catch (err) {
          if (err instanceof WriteRefused) throw new WriteRefused('tags-relecture', key(table, 'tags'));
          throw err;
        }
      }
    }
    const action = buildUpdate(table, id, changes, disabled, {
      current,
      before: opts.before,
      refExists: exists,
      restoring,
      days,
      isEstimation,
      replaceTags: opts.replaceTags,
      columns: meta,
    });
    const also = opts.also ?? [];
    const derived = also.map((r) =>
      buildUpdate(r.table, r.id, r.changes, disabled, { before: r.before, columns: meta }),
    );
    const items = [{ table, id, values: ch }, ...also.map((r) => ({ table: r.table, id: r.id, values: r.changes }))];
    if (new Set(items.map((x) => `${x.table}:${x.id}`)).size !== items.length)
      throw new WriteRefused('identifiant', 'ligne en double dans le lot');
    // « Annuler » compris : contrôle strict et périmètre (une annulation ne doit pas laisser de données incohérentes)
    if (!deferred(items)) checkItems(items);
    const actions = [action, ...groupRows(derived)];
    const before = Object.fromEntries(Object.keys(changes).map((c) => [c, opts.before?.[c] ?? null]));
    const rows = also.map((r) => ({
      table: r.table,
      id: r.id,
      before: Object.fromEntries(Object.keys(r.changes).map((c) => [c, r.before?.[c] ?? null])),
      after: { ...r.changes },
    }));
    const entry = {
      seq: ++seq,
      kind: 'update',
      table,
      id,
      before,
      after: { ...changes },
      rows,
      actions,
      applied: actions,
      sent: false,
      undone: false,
    };
    if (opts.undoOf) entry.undoOf = opts.undoOf;
    if (mode === 'on') {
      await checkFlags();
      await checkFresh(items);
      try {
        await send(actions);
      } catch (err) {
        noteFailure(err, also.length ? null : Object.keys(changes), table);
        throw err;
      }
      entry.sent = true;
    }
    journal.push(entry);
    return entry;
  }

  /**
   * Crée une ligne (tâche, sous-tâche ou chantier) : un seul AddRecord ; le nouvel identifiant est lu dans
   * retValues[0] (en mode essai : identifiant local tempId, rien n'est envoyé).
   * @param {string} table
   * @param {object} fields valeurs du modèle des colonnes de création
   * @returns {Promise<{seq:number, kind:'add', table:string, id:number, after:object, actions:any[], sent:boolean}>}
   */
  async function add(table, fields) {
    if (mode === 'off') throw new WriteRefused('off');
    if (blocked) throw new WriteRefused(blocked);
    const action = buildAdd(table, fields, disabled, { refExists: exists, isEstimation, columns: meta });
    if (addRefused.has(table)) throw new WriteRefused('ajout-refuse', table);
    if (!deferred([{ table, id: null, values: fields }])) checkItems([{ table, id: null, values: fields }]);
    const entry = {
      seq: ++seq,
      kind: 'add',
      table,
      id: null,
      before: {},
      after: { ...fields },
      rows: [],
      actions: [action],
      sent: false,
      undone: false,
    };
    let newId;
    if (mode === 'on') {
      await checkFlags();
      await checkFresh([{ table, id: null, values: fields }]);
      let res;
      try {
        res = await send(entry.actions);
      } catch (err) {
        if (err instanceof WriteFailed && err.document) blocked = 'viewer';
        else if (err instanceof WriteFailed && err.kind === 'acl') addRefused.add(table);
        // Sans réponse : la ligne a peut-être été créée ; retrouvée sans ambiguïté, elle reste annulable
        if (err instanceof WriteFailed && err.kind === 'timeout') {
          const found = await recoverCreated(table, action[3]);
          if (found) {
            entry.recovered = true;
            res = { retValues: [found] };
          } else throw err;
        } else throw err;
      }
      newId = res?.retValues?.[0];
      if (!isId(newId)) throw new WriteFailed('other', 'identifiant de la ligne créée inconnu');
      entry.sent = true;
      entry.snapshot = await snapshotOf(table, newId);
    } else newId = tempId?.(table) ?? 900000000 + entry.seq;
    entry.id = newId;
    entry.applied = [['AddRecord', table, newId, action[3]]];
    created.add(`${table}:${newId}`);
    journal.push(entry);
    return entry;
  }

  /** Photo brute de la ligne juste après sa création (null si la relecture échoue : contrôle par défaut). */
  async function snapshotOf(table, id) {
    if (!readTable) return null;
    try {
      return rawRow(await readFresh(table), id);
    } catch {
      return null;
    }
  }

  /**
   * Création sans réponse dans le délai : la ligne est cherchée dans la table relue. Elle n'est retenue que si une
   * seule ligne inconnue des données chargées porte exactement les cellules envoyées ; sinon null (on ne devine pas).
   */
  async function recoverCreated(table, written) {
    if (!readTable) return null;
    let t;
    try {
      t = await readFresh(table);
    } catch {
      return null;
    }
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const hits = t.id.filter(
      (id, i) =>
        !lookup?.row(table, id) &&
        !created.has(`${table}:${id}`) &&
        Object.entries(written).every(([c, v]) => same(t[c]?.[i], v)),
    );
    return hits.length === 1 ? hits[0] : null;
  }

  /** Dernière écriture qui peut être annulée (ni déjà annulée, ni elle-même une annulation). */
  const lastUndoable = () => [...journal].reverse().find((e) => !e.undone && !e.undoOf) ?? null;

  const reread = (readRow, table, id) =>
    mode === 'on'
      ? withTimeout(readRow(table, id), timeoutMs, () => new Error('délai de relecture dépassé'))
      : Promise.resolve(null);

  /**
   * Annule une création (seule suppression possible, Q9). En envoi réel, la ligne ENTIÈRE est relue juste avant :
   * elle n'est supprimée que si elle est identique à la création sur toutes ses colonnes, et si aucune tâche ni aucun
   * chantier relus ne la référencent (parentTask, Chantier, dependDe). Sinon rien n'est envoyé, avec la raison.
   */
  async function undoAdd(entry) {
    const keep = (reason, skipped = []) => ({ entry, skipped, undoEntry: null, busy: false, reason });
    // Une personne créée ne se supprime jamais : elle se désactive (Q9)
    if (NO_REMOVE.includes(entry.table)) return keep('personne');
    if (mode === 'on') {
      if (!readTable) return keep('relecture');
      // Tâches et chantiers : ligne et références relues ; une indisponibilité n'est référencée par rien
      const names = entry.table === 'Tasks' || entry.table === 'Chantiers' ? ['Tasks', 'Chantiers'] : [entry.table];
      const tables = {};
      try {
        for (const n of names) tables[n] = await readFresh(n);
      } catch {
        return keep('relecture');
      }
      const fresh = rawRow(tables[entry.table], entry.id);
      if (!fresh) {
        entry.undone = true;
        return keep('disparue');
      }
      const skipped = changedSinceCreation(
        fresh,
        entry.snapshot ?? null,
        entry.actions[0][3],
        (c) => columns?.[`${entry.table}.${c}`]?.isFormula === true,
      );
      if (skipped.length) return keep('modifiee', skipped);
      if (referencesTo(tables, entry.table, entry.id).length) return keep('reference');
    } else if (lookup?.referenced?.(entry.table, entry.id)) return keep('reference');
    const actions = [['RemoveRecord', entry.table, entry.id]];
    const undoEntry = {
      seq: ++seq,
      kind: 'remove',
      table: entry.table,
      id: entry.id,
      before: { ...entry.after },
      after: {},
      rows: [],
      actions,
      applied: actions,
      sent: false,
      undone: false,
      undoOf: entry.seq,
    };
    if (mode === 'on') {
      await checkFlags();
      await send(actions);
      undoEntry.sent = true;
    } else assertActions(actions, { removable });
    created.delete(`${entry.table}:${entry.id}`);
    journal.push(undoEntry);
    entry.undone = true;
    return { entry, skipped: [], undoEntry, busy: false };
  }

  /**
   * Annule la dernière écriture.
   * @param {(table:string, id:number) => Promise<object|null>} readRow relecture des valeurs actuelles de la ligne
   * @returns {Promise<{entry:object|null, skipped:string[], undoEntry:object|null, busy:boolean, reason?:string}>}
   */
  async function undoLast(readRow) {
    const entry = lastUndoable();
    // Double déclenchement (message et panneau) : une seule annulation à la fois
    if (!entry || undoing) return { entry: null, skipped: [], undoEntry: null, busy: undoing };
    undoing = true;
    try {
      if (entry.kind === 'add') return await undoAdd(entry);
      // Mode essai : rien n'a été envoyé, la valeur écrite est celle du journal
      const fresh = mode === 'on' ? await reread(readRow, entry.table, entry.id) : entry.after;
      const { changes, skipped } = planUndo(entry, fresh);
      const also = [];
      for (const r of entry.rows ?? []) {
        const f = mode === 'on' ? await reread(readRow, r.table, r.id) : r.after;
        const p = planUndo(r, f);
        skipped.push(...p.skipped.filter((c) => !skipped.includes(c)));
        if (Object.keys(p.changes).length) also.push({ table: r.table, id: r.id, changes: p.changes, before: r.after });
      }
      let undoEntry = null;
      if (Object.keys(changes).length)
        undoEntry = await update(entry.table, entry.id, changes, {
          before: entry.after,
          undoOf: entry.seq,
          also,
          ...(mode === 'on' && fresh ? { fresh } : {}),
        });
      entry.undone = true;
      return { entry, skipped, undoEntry, busy: false };
    } finally {
      undoing = false;
    }
  }

  return {
    mode,
    can,
    canAdd,
    canAddField,
    /** Type d'écriture de la colonne (columnTypeOf) : 'Int' pour un Team.aph converti en entier, sinon le type attendu. */
    columnType: (table, col) => columnTypeOf(meta, table, col),
    update,
    add,
    undoLast,
    lastUndoable,
    /** Copie du journal de la session (mode essai : actions non envoyées). */
    journal: () => journal.map((e) => ({ ...e })),
    /** Vrai si un refus a mis toute la session en lecture (compte sans droit d'écriture). */
    isBlocked: () => blocked !== null,
    /** Met toute la session en lecture (arrêt d'urgence, compte lecteur), en gardant le journal et son affichage. */
    lock: (reason) => {
      blocked ??= reason;
    },
    /** Retire une colonne pour la session (refus constaté ailleurs). */
    refuse: (table, col, reason = 'acl') => disabled.set(key(table, col), reason),
    /**
     * Métadonnées relues (à chaque relecture) : une colonne devenue formule, absente ou d'un autre type est retirée
     * à son tour. Rien n'est jamais rétabli en cours de session ; métadonnées illisibles : rien ne change.
     */
    recheckColumns: (cols) => {
      if (!cols) return;
      meta = cols;
      for (const [k, r] of checkColumns(cols)) if (!disabled.has(k)) disabled.set(k, r);
    },
  };
}
