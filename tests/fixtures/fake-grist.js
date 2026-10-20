import { decodeRow } from '../../widget/js/core/grist-writer.js';

/**
 * Faux Grist pour les tests Node : tables colonnaires en mémoire, lots enregistrés dans `batches`, actions
 * appliquées comme le ferait Grist (lot atomique), retValues réalistes, messages d'erreur de Grist.
 * Ne contacte jamais un vrai Grist.
 */

/**
 * Messages renvoyés par Grist (à reconfirmer dans le document de test, voir le rapport du lot 2a) :
 * viewer = compte lecteur ; aclTable / aclColumn / aclRow = règles d'accès ; missing = ligne disparue.
 */
export const GRIST_ERRORS = Object.freeze({
  viewer: 'No write access',
  aclTable: 'Blocked by table update access rules',
  aclColumn: 'Blocked by column update access rules',
  aclRow: 'Blocked by row update access rules',
  missing: 'Invalid row id 999',
});

/**
 * Lignes lues pour le contrôle strict du writer (lookup) : valeurs actuelles du faux Grist (decodeRow), sous-tâches
 * directes d'une tâche, tâches portant un chantier, références à une ligne (annulation d'une création).
 */
export function lookupOf(g) {
  const tasks = () => g.data.Tasks;
  const col = (c) => tasks()[c] ?? [];
  return {
    row: (t, id) => decodeRow(g.data[t], t, id),
    childIds: (id) => tasks().id.filter((_, i) => col('parentTask')[i] === id),
    chantierTasks: (id) => tasks().id.filter((_, i) => col('Chantier')[i] === id),
    referenced: (t, id) =>
      t === 'Tasks' ? col('parentTask').includes(id) : t === 'Chantiers' ? col('Chantier').includes(id) : false,
  };
}

/**
 * @param {Record<string, object>} tables tables colonnaires (format de fetchTable)
 * @param {{fail?:string|((actions:any[]) => string|null), docId?:string, hang?:'before'|'after'}} [opts]
 */
export function createFakeGrist(tables, opts = {}) {
  let data = structuredClone(tables);
  const batches = [];
  const docId = opts.docId ?? 'doc-faux-test';
  const tokens = [];

  /** Actions appliquées comme Grist : UpdateRecord, BulkUpdateRecord, AddRecord (id = max + 1), RemoveRecord. */
  function applyOne([name, table, id, fields]) {
    const t = data[table];
    if (!t) throw new Error(`KeyError: ${table}`);
    const set = (i, f) => {
      for (const [c, v] of Object.entries(f)) {
        if (!t[c]) throw new Error(`KeyError: ${c}`);
        t[c][i] = v;
      }
    };
    if (name === 'UpdateRecord') {
      const i = t.id.indexOf(id);
      if (i < 0) throw new Error(`Invalid row id ${id}`);
      set(i, fields);
      return null;
    }
    if (name === 'BulkUpdateRecord') {
      id.forEach((rowId, n) => {
        const i = t.id.indexOf(rowId);
        if (i < 0) throw new Error(`Invalid row id ${rowId}`);
        set(i, Object.fromEntries(Object.entries(fields).map(([c, vs]) => [c, vs[n]])));
      });
      return null;
    }
    if (name === 'AddRecord') {
      const newId = Math.max(0, ...t.id) + 1;
      for (const c of Object.keys(t)) t[c].push(c === 'id' ? newId : null);
      set(t.id.length - 1, fields);
      return newId;
    }
    if (name === 'RemoveRecord') {
      const i = t.id.indexOf(id);
      if (i < 0) throw new Error(`Invalid row id ${id}`);
      for (const c of Object.keys(t)) t[c].splice(i, 1);
      return null;
    }
    throw new Error(`KeyError: ${name}`);
  }

  return {
    batches,
    tokens,
    get data() {
      return data;
    },
    onRecords() {},
    docApi: {
      async fetchTable(name) {
        if (!data[name]) throw new Error(`KeyError ${name}`);
        return structuredClone(data[name]);
      },
      async getAccessToken(o) {
        tokens.push(o);
        return { token: 'jeton', baseUrl: `https://grist.exemple/api/docs/${docId}`, ttl: 300 };
      },
      async applyUserActions(actions) {
        batches.push(structuredClone(actions));
        // Grist bloqué : jamais de réponse, sans écrire ('before') ou après avoir écrit ('after')
        if (opts.hang === 'before') return new Promise(() => {});
        const fail = typeof opts.fail === 'function' ? opts.fail(actions) : opts.fail;
        if (fail) throw new Error(fail);
        const backup = structuredClone(data);
        try {
          const retValues = actions.map(applyOne);
          if (opts.hang === 'after') return new Promise(() => {});
          return { actionNum: batches.length, retValues };
        } catch (err) {
          data = backup;
          throw err;
        }
      },
    },
    /** Ligne créée « par quelqu'un d'autre » (non enregistrée dans batches) ; renvoie son identifiant. */
    otherUserAdds(table, fields) {
      return applyOne(['AddRecord', table, null, fields]);
    },
    /** Modification faite « par quelqu'un d'autre » (hors du widget, non enregistrée dans batches). */
    otherUserSets(table, id, fields) {
      const i = data[table].id.indexOf(id);
      for (const [c, v] of Object.entries(fields)) data[table][c][i] = v;
    },
  };
}
