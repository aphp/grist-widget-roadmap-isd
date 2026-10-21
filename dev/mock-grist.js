// FAUX GRIST, développement uniquement (jamais servi en production) : lit dev/data/snapshot.json (non versionné),
// ou le jeu synthétique de dev/synthetic-snapshot.js s'il est absent ou si ?donnees=synthetiques (tests de bout en
// bout : toujours les mêmes données inventées). Ne contacte jamais un vrai Grist. Un échec de lecture des données
// est noté dans window.__mockError. Les lectures (tables, flags.json) sont notées dans window.__reads. Toute écriture
// est journalisée dans window.__writes, puis traitée selon ?ecritures= :
//   refus (défaut)  : refusée ;
//   memoire         : appliquée à la copie en mémoire du snapshot (l'interface se met à jour), onRecords simulé ;
//   acl:<Table>     : refus de type règle d'accès sur cette table (« Blocked by table update access rules »), toute
//                     action comprise (mise à jour, création, suppression) ;
//   acl-ajout:<Table> : la règle d'accès refuse seulement les créations dans cette table (« Blocked by table create access rules ») ;
//   lecteur         : compte lecteur (access = viewers), toute écriture refusée ;
//   acces-inconnu   : la lecture du niveau d'accès échoue (comme sous une CSP qui la bloque) ;
//   bloque          : applyUserActions ne répond jamais (rien n'est écrit) ;
//   bloque-apres    : l'écriture est appliquée, mais la réponse ne vient jamais ;
//   flags-bloque    : flags.json ne répond jamais (window.__flagsBloque = true en cours de session) ;
//   lent            : 1,5 s de latence avant la réponse ;
//   coupe           : flags.json répond { "edition": false } (arrêt d'urgence ; window.__coupe = true en cours de session) ;
//   statut-vide     : la tâche n° 1 n'a pas de statut (menu de statut sans entrée cochée) ;
//   capacite-donnee : Team.capaciteHebdo devient une colonne de données (comme après sa conversion dans Grist par un
//                     responsable) ; sans cette option, elle reste la colonne vide de la Feuille, non modifiable.
//   aph-donnee      : Team.aph devient une colonne de données ; avec le jeu synthétique, des APH inventés et des
//                     personnes estimation (APH 9999999) : « Estimation DE », « Estimation DS », et « Estimation DA »
//                     inactive (non exemptée). Sans cette option : formule vide.
//   aph-entier      : comme aph-donnee, mais colonne Int (ce que Grist devine après une saisie de chiffres dans la
//                     colonne vide) : APH en nombres, 0 = vide (la personne n° 2 du jeu synthétique).
// grist.__simulateChange([action]) simule onRecords (modification faite ailleurs), avec ou sans donnée changée ;
// grist.__simulateChange([action], { silencieux: true }) change la donnée sans prévenir le widget.
// window.__accesRefuse = true : les tables de la Feuille sont refusées pour niveau d'accès (écran « accès »).
// En cours de session, window.__lectureEchoue = true fait échouer toute lecture de table (relecture avant l'envoi).
// Les options se combinent par des virgules : ?ecritures=memoire,lent. Le document s'appelle « doc-dev-local ».
(function () {
  const params = new URLSearchParams(window.location.search);
  const opts = (params.get('ecritures') || 'refus').split(',').map((s) => s.trim());
  const has = (o) => opts.includes(o);
  const aclTable = (opts.find((o) => o.startsWith('acl:')) || '').slice(4) || null;
  const aclAdd = (opts.find((o) => o.startsWith('acl-ajout:')) || '').slice(10) || null;
  const DOC = 'doc-dev-local';
  const baseUrl = `${window.location.origin}/api/docs/${DOC}`;
  let data = null;
  let recordsCb = null;
  window.__writes = [];
  const load = async () => {
    if (data) return data;
    try {
      data = await readSnapshot();
    } catch (err) {
      window.__mockError = `[faux Grist] données indisponibles : ${err?.message ?? err}`;
      throw err;
    }
    if (has('statut-vide')) {
      const i = data.Tasks.id.indexOf(1);
      if (i >= 0) data.Tasks.statut[i] = '';
    }
    if (has('capacite-donnee')) {
      const t = data._grist_Tables;
      const team = t.id[t.tableId.indexOf('Team')];
      const c = data._grist_Tables_column;
      const i = c.id.findIndex((_, k) => c.parentId[k] === team && c.colId[k] === 'capaciteHebdo');
      if (i >= 0) c.isFormula[i] = 0;
    }
    if (has('aph-donnee') || has('aph-entier')) {
      const t = data._grist_Tables;
      const team = t.id[t.tableId.indexOf('Team')];
      const c = data._grist_Tables_column;
      const i = c.id.findIndex((_, k) => c.parentId[k] === team && c.colId[k] === 'aph');
      if (i >= 0) c.isFormula[i] = 0;
      // Données réelles : conversion en Int comme Grist (chiffres → nombre, le reste → 0)
      if (i >= 0 && has('aph-entier') && c.type[i] !== 'Int') {
        c.type[i] = 'Int';
        data.Team.aph = (data.Team.aph ?? data.Team.id.map(() => '')).map((v) =>
          /^[0-9]{1,10}$/.test(String(v)) ? Number(v) : 0,
        );
      }
    }
    return data;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const synthetic = async () =>
    (await import('/dev/synthetic-snapshot.js')).syntheticSnapshot(undefined, {
      aph: has('aph-entier') ? 'entier' : has('aph-donnee'),
    });
  async function readSnapshot() {
    if (params.get('donnees') === 'synthetiques') return synthetic();
    const r = await fetch('/dev/data/snapshot.json');
    if (r.status === 404) {
      console.warn('[faux Grist] dev/data/snapshot.json absent : jeu de données synthétique');
      return synthetic();
    }
    if (!r.ok) throw new Error(`dev/data/snapshot.json : HTTP ${r.status}`);
    return r.json();
  }

  // Réponse de GET {baseUrl} (niveau d'accès), sans réseau
  const realFetch = window.fetch.bind(window);
  // Lectures faites par le widget (tables lues, flags.json) : un test vérifie qu'une action refusée ne lit rien
  window.__reads = [];
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (/\/flags\.json$/.test(new URL(url, window.location.href).pathname)) window.__reads.push('flags.json');
    // flags.json sans réponse : ?ecritures=…,flags-bloque (ou window.__flagsBloque = true en cours de session)
    if (
      (has('flags-bloque') || window.__flagsBloque) &&
      /\/flags\.json$/.test(new URL(url, window.location.href).pathname)
    )
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal.reason)));
    // Arrêt d'urgence simulé : ?ecritures=…,coupe → flags.json { "edition": false }
    if ((has('coupe') || window.__coupe) && /\/flags\.json$/.test(new URL(url, window.location.href).pathname))
      return new Response('{"edition": false}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    // Niveau d'accès illisible (CSP, réseau) : ?ecritures=…,acces-inconnu
    if (url.startsWith(baseUrl) && has('acces-inconnu')) throw new TypeError('Failed to fetch');
    if (url.startsWith(baseUrl)) {
      const body = JSON.stringify({
        id: DOC,
        name: 'Document de développement',
        access: has('lecteur') ? 'viewers' : 'owners',
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };

  function applyOne([name, table, id, fields]) {
    const t = data[table];
    if (!t) throw new Error(`KeyError: ${table}`);
    const set = (i, f) => {
      for (const [col, v] of Object.entries(f)) {
        if (!t[col]) throw new Error(`KeyError: ${col}`);
        t[col][i] = v;
      }
    };
    if (name === 'UpdateRecord') {
      const i = t.id.indexOf(id);
      if (i < 0) throw new Error(`Invalid row id ${id} in ${table}`);
      set(i, fields);
      return null;
    }
    if (name === 'BulkUpdateRecord') {
      id.forEach((rowId, n) => {
        const i = t.id.indexOf(rowId);
        if (i < 0) throw new Error(`Invalid row id ${rowId} in ${table}`);
        set(i, Object.fromEntries(Object.entries(fields).map(([c, vs]) => [c, vs[n]])));
      });
      return null;
    }
    if (name === 'AddRecord') {
      // Identifiant fixe (« Annuler » une suppression : ligne recréée à son numéro) ; déjà pris : erreur, comme Grist
      if (Number.isInteger(id) && t.id.includes(id)) throw new Error(`Duplicate row id ${id} in ${table}`);
      const newId = Number.isInteger(id) && id > 0 ? id : Math.max(0, ...t.id) + 1;
      for (const c of Object.keys(t)) t[c].push(c === 'id' ? newId : null);
      set(t.id.length - 1, fields);
      return newId;
    }
    if (name === 'RemoveRecord') {
      const i = t.id.indexOf(id);
      if (i < 0) throw new Error(`Invalid row id ${id} in ${table}`);
      for (const c of Object.keys(t)) t[c].splice(i, 1);
      return null;
    }
    throw new Error(`[faux Grist] action non simulée : ${name}`);
  }

  async function applyUserActions(actions) {
    const rec = {
      name: 'applyUserActions',
      args: [structuredClone(actions)],
      at: new Date().toISOString(),
      result: '',
    };
    window.__writes.push(rec);
    if (has('lent')) await wait(1500);
    // Grist ne répond jamais : sans écrire (bloque) ou après avoir écrit (bloque-apres)
    if (has('bloque')) {
      rec.result = 'sans réponse';
      return new Promise(() => {});
    }
    if (has('lecteur')) {
      rec.result = 'refusée (lecteur)';
      throw new Error('No write access');
    }
    if (aclTable && actions.some((a) => a[1] === aclTable)) {
      rec.result = `refusée (acl:${aclTable})`;
      throw new Error('Blocked by table update access rules');
    }
    if (aclAdd && actions.some((a) => a[0] === 'AddRecord' && a[1] === aclAdd)) {
      rec.result = `refusée (acl-ajout:${aclAdd})`;
      throw new Error('Blocked by table create access rules');
    }
    if (!has('memoire')) {
      rec.result = 'refusée';
      throw new Error('[faux Grist] écriture refusée : applyUserActions');
    }
    await load();
    // Lot atomique : appliqué sur une copie, puis remplacé d'un coup
    const backup = structuredClone(data);
    try {
      const retValues = actions.map(applyOne);
      rec.result = 'appliquée';
      if (has('bloque-apres')) {
        rec.result = 'appliquée, sans réponse';
        return new Promise(() => {});
      }
      setTimeout(() => recordsCb && recordsCb([]), 50);
      return { actionNum: window.__writes.length, retValues };
    } catch (err) {
      data = backup;
      rec.result = `erreur : ${err.message}`;
      throw err;
    }
  }

  const refuse =
    (name) =>
    async (...args) => {
      window.__writes.push({ name, args, at: new Date().toISOString(), result: 'refusée' });
      throw new Error(`[faux Grist] écriture refusée : ${name}`);
    };
  window.grist = {
    ready: () => {},
    onRecords: (cb) => {
      recordsCb = cb;
    },
    onRecord: () => {},
    onOptions: () => {},
    setOption: refuse('setOption'),
    setOptions: refuse('setOptions'),
    docApi: {
      fetchTable: async (t) => {
        window.__reads.push(t);
        // Relecture en échec (tests de bout en bout) : window.__lectureEchoue = true en cours de session
        if (window.__lectureEchoue) throw new Error('lecture impossible (simulée)');
        // Accès complet retiré au widget (écran « accès ») : window.__accesRefuse = true en cours de session
        if (window.__accesRefuse && !t.startsWith('_grist')) throw new Error('Widget does not have full access');
        const d = await load();
        if (!d[t]) throw new Error(`KeyError: ${t}`);
        return structuredClone(d[t]);
      },
      listTables: async () => Object.keys(await load()).filter((t) => !t.startsWith('_grist')),
      getAccessToken: async () => ({ token: 'jeton-dev', baseUrl, ttl: 300 }),
      applyUserActions,
    },
    // Modification faite ailleurs (autre utilisateur) : sans argument, onRecords seul (aucune donnée changée) ;
    // avec ['UpdateRecord', table, id, champs] (ou une liste de ces actions), la copie en mémoire change d'abord.
    // { silencieux: true } : la donnée change sans onRecords (conflit découvert seulement à la relecture d'un envoi).
    __simulateChange: async (actions, { silencieux = false } = {}) => {
      if (actions) {
        await load();
        (Array.isArray(actions[0]) ? actions : [actions]).forEach(applyOne);
      }
      if (recordsCb && !silencieux) recordsCb([]);
    },
  };
})();
