/**
 * Point de contact de LECTURE avec Grist : fetchTable, onRecords et getAccessToken (lecture seule).
 * Aucune méthode d'écriture ici : les écritures passent uniquement par grist-writer.js.
 */
import { docIdFromBaseUrl } from './edit-switch.js';
import { decodeRow } from './grist-writer.js';

/** Colonnes attendues par table ; une colonne absente est signalée, pas bloquante. */
export const REQUIRED = Object.freeze({
  Team: ['nom', 'role', 'actif', 'capaciteHebdo'],
  Projects: [
    'nom',
    'Categorie',
    'Statut',
    'dateDebut',
    'dateFin',
    'responsable',
    'Sponsor',
    'Contributeurs_cles',
    'Priorite_de_la_direction',
    'Commanditaires',
    'Description',
  ],
  Chantiers: [
    'Nom_du_chantier',
    'Projets',
    'Statut',
    'Debut',
    'Fin',
    'Responsable',
    'Contributeurs',
    'Priorite',
    'Criteres_de_succes',
    'Description',
  ],
  Tasks: [
    'titre',
    'description',
    'statut',
    'dateDebut',
    'dateEcheance',
    'dateCloture',
    'projet',
    'Chantier',
    'parentTask',
    'priorite',
    'assignees',
    'Responsable',
    'charges',
    'dependDe',
    'estimationH',
    'tempsPasse',
    'Commentaire',
    'Lien_utile',
    'type',
    'Chantier_Criteres_de_succes',
  ],
  Disponibilites: ['membre', 'dateDebut', 'dateFin', 'dispo'],
});

/**
 * Colonnes lues quand elles existent, jamais signalées si elles manquent (annuaire de l'équipe : adresse,
 * domaine, N+1 ; nature de l'indisponibilité). Une colonne absente donne simplement une valeur vide.
 */
export const OPTIONAL_COLUMNS = Object.freeze({
  Team: ['email', 'n_1', 'Domaine'],
  Tasks: ['progression', 'tags'],
  Chantiers: ['tags'],
  Disponibilites: ['type'],
});

/** Tables dont l'absence n'empêche pas l'affichage. */
export const OPTIONAL_TABLES = Object.freeze(['Disponibilites']);

/** Tables de la Feuille indispensables à l'affichage. */
export const USER_TABLES = Object.freeze(Object.keys(REQUIRED).filter((t) => !OPTIONAL_TABLES.includes(t)));

const errorText = (e) => String(e?.message ?? e ?? '');

/**
 * Vrai si le message signale un niveau d'accès insuffisant du widget (et non une règle d'accès de la Feuille,
 * du type « Blocked by table read access rules »).
 */
export function isAccessLevelError(message) {
  return /access/i.test(message) && !/access rules?/i.test(message);
}

/**
 * Vrai si l'accès complet n'est pas accordé au widget : toutes les tables indispensables sont refusées pour une
 * raison de niveau d'accès. Un refus partiel (règles d'accès sur une table) reste un problème de table.
 * @param {{table:string, column:string|null, error?:string}[]} problems
 */
export function accessRefused(problems) {
  return USER_TABLES.every((t) =>
    problems.some((p) => p.table === t && p.column === null && isAccessLevelError(p.error ?? '')),
  );
}

/**
 * Métadonnées des colonnes, lues dans _grist_Tables_column : choix déclarés des colonnes Choice/ChoiceList,
 * et type de chaque colonne ('Table.colonne' → {type, isFormula}), contrôlé par le writer au chargement.
 */
async function fetchColumnMeta(docApi) {
  const [tables, cols] = await Promise.all([
    docApi.fetchTable('_grist_Tables'),
    docApi.fetchTable('_grist_Tables_column'),
  ]);
  const tableId = new Map(tables.id.map((id, i) => [id, tables.tableId[i]]));
  const out = {};
  const columns = {};
  cols.id.forEach((_, i) => {
    const t = tableId.get(cols.parentId[i]);
    // isFormula : booléen dans Grist (1 dans une photo exportée) ; formule vide = colonne « vide » de Grist,
    // qu'une écriture convertirait en colonne de données (modification de structure, refusée)
    const formula = cols.isFormula?.[i] === true || cols.isFormula?.[i] === 1;
    if (t && cols.type)
      columns[`${t}.${cols.colId[i]}`] = {
        type: cols.type[i],
        isFormula: formula,
        ...(formula && cols.formula && !String(cols.formula[i] ?? '').trim() ? { empty: true } : {}),
      };
    let choices;
    try {
      choices = JSON.parse(cols.widgetOptions[i] || '{}').choices;
    } catch {
      choices = undefined;
    }
    if (Array.isArray(choices)) out[`${t}.${cols.colId[i]}`] = choices;
  });
  return { choices: out, columns: cols.type ? columns : null };
}

/** Crée la passerelle Grist en lecture seule. */
export function createGateway(grist) {
  return {
    /**
     * Lit les tables utiles et les choix ; retourne { tables, choices, problems }, sans jamais lever.
     * Une table refusée donne { table, column: null, optional, error } (error = message de Grist).
     */
    async fetchAll() {
      const names = Object.keys(REQUIRED);
      const settled = await Promise.allSettled(names.map((n) => grist.docApi.fetchTable(n)));
      const tables = {};
      const problems = [];
      settled.forEach((r, i) => {
        const name = names[i];
        const optional = OPTIONAL_TABLES.includes(name);
        if (r.status === 'rejected') {
          problems.push({ table: name, column: null, optional, error: errorText(r.reason) });
          return;
        }
        tables[name] = r.value;
        for (const col of REQUIRED[name]) {
          if (!(col in r.value)) problems.push({ table: name, column: col, optional });
        }
      });
      let choices = {};
      let columns = null;
      try {
        ({ choices, columns } = await fetchColumnMeta(grist.docApi));
      } catch {
        choices = {};
        columns = null;
      }
      return { tables, choices, columns, problems };
    },

    /** Relit une table entière, brute (toutes les colonnes), pour les contrôles du writer juste avant un envoi. */
    async fetchTableRaw(table) {
      return grist.docApi.fetchTable(table);
    },

    /** Relit une ligne (valeurs du modèle des colonnes modifiables) ; null si elle a disparu. */
    async fetchRow(table, id) {
      return decodeRow(await grist.docApi.fetchTable(table), table, id);
    },

    /**
     * Identifiant du document et niveau d'accès du compte ('owners', 'editors', 'viewers'), sans rien écrire :
     * jeton en lecture seule puis GET de l'adresse du document. access vaut null si la lecture échoue (CSP,
     * réseau) : les droits se découvrent alors au premier refus.
     * @returns {Promise<{docId:string|null, access:string|null}>}
     */
    async fetchAccess(fetchImpl = globalThis.fetch) {
      let docId = null;
      try {
        const { token, baseUrl } = await grist.docApi.getAccessToken({ readOnly: true });
        docId = docIdFromBaseUrl(baseUrl);
        const r = await fetchImpl(`${baseUrl}?auth=${encodeURIComponent(token)}`, { method: 'GET' });
        if (!r.ok) return { docId, access: null };
        const j = await r.json();
        return { docId, access: ['owners', 'editors', 'viewers'].includes(j?.access) ? j.access : null };
      } catch {
        return { docId, access: null };
      }
    },

    /** Appelle cb après une rafale de modifications (anti-rebond). */
    onChange(cb, delayMs = 500) {
      let timer = null;
      grist.onRecords(() => {
        clearTimeout(timer);
        timer = setTimeout(cb, delayMs);
      });
    },
  };
}
