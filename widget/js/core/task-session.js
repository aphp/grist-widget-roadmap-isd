/**
 * Enregistrements des fiches tâche et chantier, des créations et des changements de chantier, sans DOM :
 * relecture et contrôle de fraîcheur, envoi par le writer, statut rapide calculé sur la ligne relue. Chaque appel reçoit un instantané (identifiant, base, brouillon) : il
 * n'écrit jamais dans une autre ligne que celle de l'instantané, même si le formulaire a changé entre-temps.
 */
import { mergeCharges, periodFte, readChargesCell, sameCharges } from './charges-edit.js';
import { chargeRefs, rescaleCharges } from './charges-rescale.js';
import { detectConflicts, mergeChargesChange, periodConflictCols } from './conflicts.js';
import { DEFAULT_TIMEOUT_MS, WriteFailed, WriteRefused, withTimeout } from './grist-writer.js';
import { chantierStatusChanges, reattachRows, taskLinksFromTable } from './chantier-form.js';
import { moveRows } from './create-form.js';
import { mergeTags, mergeTagsChange } from './tags-edit.js';
import { diffDraft, statusChanges } from './task-form.js';

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

/** Relecture d'une ligne limitée dans le temps (une requête bloquée ne fige jamais la fiche). */
function readRow(fetchRow, id, ms) {
  return withTimeout(fetchRow(id), ms, () => new Error(`délai de ${ms / 1000} s dépassé`));
}

/**
 * Écriture sans réponse dans le délai : elle a pu avoir lieu. La ligne est relue (sans relance de l'écriture) pour
 * dire à l'utilisateur ce que contient maintenant la Feuille. stored : valeurs relues, null (ligne disparue) ou
 * undefined (relecture impossible).
 */
async function unknownOutcome(fetchRow, id, ms, changes) {
  let stored;
  try {
    stored = await readRow(fetchRow, id, ms);
  } catch {
    stored = undefined;
  }
  return { kind: 'unknown', stored, changes };
}

/**
 * Enregistre un brouillon.
 * @param {{taskId:number, base:object, draft:object, writer:object, fetchRow:(id:number)=>Promise<object|null>,
 *          skipCheck?:boolean, changes?:object, before?:object}} snap
 *   skipCheck : enregistrer sans relecture (seulement après l'accord explicite de l'utilisateur) ;
 *   changes/before : lot déjà arbitré (après une fenêtre de conflit, voir conflictBatch) ;
 *   chargesBase : avec un lot arbitré qui contient les charges, cellule de l'ouverture du formulaire : la ligne est
 *   relue et la saisie refusionnée personne par personne juste avant l'envoi (la saisie l'emporte sur une même
 *   personne, choix déjà fait ; les autres modifications faites entre-temps survivent).
 *   tagsSeen : avec un lot arbitré qui contient les tags, cellule montrée dans la fenêtre de conflit : la ligne est
 *   relue et la saisie refusionnée (mergeTags) juste avant l'envoi. tagsReplace : contenu d'une cellule de tags
 *   illisible dont l'utilisateur a confirmé le remplacement (sinon le writer refuse d'écrire les tags).
 *   timeoutMs : délai maximal de la relecture (l'envoi a le sien, dans le writer).
 *   table : 'Tasks' (défaut) ou 'Chantiers' ; diff : différences du brouillon (diffDraft par défaut) ; also : lignes
 *   dérivées envoyées dans le même lot (tâches rattachées à un autre projet du chantier) ; readTable et reattachTo :
 *   en envoi réel, ces lignes sont recalculées sur la table Tasks relue (projet d'arrivée reattachTo).
 *   Charges modifiées aussi dans la Feuille : fusion personne par personne ; conflit seulement sur une même
 *   personne (mine.charges = cellule fusionnée où la saisie l'emporte).
 * @returns {Promise<{kind:'nothing'}|{kind:'conflict', cols:string[], fresh:object, mine:object}
 *   |{kind:'reread-failed', error:string}
 *   |{kind:'missing'}|{kind:'saved', entry:object}|{kind:'failed', error:Error}
 *   |{kind:'unknown', stored:object|null|undefined, changes:object}>}
 */
export async function runSave(snap) {
  const { taskId, base, writer } = snap;
  const table = snap.table ?? 'Tasks';
  const ms = snap.timeoutMs || DEFAULT_TIMEOUT_MS;
  let changes = snap.changes ?? (snap.diff ?? diffDraft)(base, snap.draft);
  let keys = Object.keys(changes);
  if (!keys.length) return { kind: 'nothing' };
  let before = snap.before ?? pick(base, keys);
  let period; // dates de la ligne relue : borne de 1 ETP par personne (R4)
  let source = base; // ligne d'après laquelle le lot est envoyé (cellule de tags illisible ou non)
  const rechecksCharges = snap.chargesBase !== undefined && 'charges' in changes;
  const rechecksTags = snap.tagsSeen !== undefined && 'tags' in changes;
  if (writer.mode === 'on' && snap.changes && (rechecksCharges || rechecksTags)) {
    let fresh;
    try {
      fresh = await readRow(snap.fetchRow, taskId, ms);
    } catch (err) {
      return { kind: 'reread-failed', error: String(err?.message ?? err) };
    }
    if (fresh === null) return { kind: 'missing' };
    source = fresh;
    // Période changée ailleurs depuis la fenêtre : les charges recalculées ne valent plus, nouvelle fenêtre
    const moved = snap.datesSeen ? periodConflictCols(snap.datesSeen, fresh, changes) : [];
    if (moved.length) return { kind: 'conflict', cols: moved, fresh, mine: {} };
    if (rechecksCharges) {
      // Cellule que l'utilisateur a vue dans la fenêtre de conflit (ou à l'ouverture) et ce qu'il a choisi d'écrire
      // par rapport à elle (sa saisie l'emporte sur une même personne : choix déjà fait)
      const seen = snap.chargesSeen !== undefined ? snap.chargesSeen : snap.chargesBase;
      const decided = mergeCharges(snap.chargesBase, changes.charges, seen);
      let target;
      if (!decided.ok) {
        // Cellule illisible à l'ouverture ou dans la fenêtre (remplacement confirmé) : seulement si elle n'a pas
        // changé depuis ; sinon nouvelle fenêtre, rien n'est envoyé
        if (!sameCharges(seen, fresh.charges))
          return { kind: 'conflict', cols: ['charges'], fresh, mine: { charges: changes.charges } };
        target = changes.charges;
      } else {
        // Modifications faites depuis la fenêtre : refusionnées ; cellule devenue illisible (R1) ou même personne
        // modifiée entre-temps (R2) : nouvelle fenêtre de conflit pour les charges, rien n'est envoyé
        const m = mergeCharges(seen, decided.raw, fresh.charges);
        if (!m.ok || m.conflicts.length)
          return { kind: 'conflict', cols: ['charges'], fresh, mine: { charges: m.ok ? m.raw : decided.raw } };
        target = m.raw;
      }
      changes = { ...changes, charges: target };
      if (sameCharges(changes.charges, fresh.charges)) delete changes.charges;
      else before = { ...before, charges: fresh.charges };
      period = { start: fresh.dateDebut, end: fresh.dateEcheance };
    }
    if (rechecksTags) {
      // Tags : la saisie, déjà fusionnée sur la cellule vue dans la fenêtre, est refusionnée sur la cellule relue
      // juste avant l'envoi (un tag ajouté ou retiré ailleurs pendant la fenêtre survit)
      const tags = mergeTags(snap.tagsSeen, changes.tags, fresh.tags);
      changes = { ...changes, tags };
      if (JSON.stringify(tags) === JSON.stringify(fresh.tags ?? [])) delete changes.tags;
      else before = { ...before, tags: fresh.tags };
    }
    keys = Object.keys(changes);
    if (!keys.length) return { kind: 'nothing' };
    before = pick(before, keys);
  }
  if (writer.mode === 'on' && !snap.skipCheck && !snap.changes) {
    let fresh;
    try {
      fresh = await readRow(snap.fetchRow, taskId, ms);
    } catch (err) {
      return { kind: 'reread-failed', error: String(err?.message ?? err) };
    }
    if (fresh === null) return { kind: 'missing' };
    // Tags modifiés aussi dans la Feuille : fusion en ensemble (ajouts et retraits de chacun), jamais de conflit
    const merged = mergeChargesChange(base, fresh, mergeTagsChange(base, fresh, changes));
    const others = { ...merged.changes };
    delete others.charges;
    delete others.tags;
    const cols = detectConflicts(base, fresh, others);
    // Charges envoyées, période changée ailleurs : conflit sur les dates du lot (sans date : sur les charges)
    for (const c of periodConflictCols(base, fresh, changes)) if (!cols.includes(c)) cols.push(c);
    if (merged.conflict && !cols.includes('charges')) cols.push('charges');
    if (cols.length)
      return { kind: 'conflict', cols, fresh, mine: merged.mine === null ? {} : { charges: merged.mine } };
    changes = merged.changes;
    keys = Object.keys(changes);
    if (!keys.length) return { kind: 'nothing' };
    before = pick(fresh, keys);
    period = { start: fresh.dateDebut, end: fresh.dateEcheance };
    source = fresh;
  }
  // Cellule de tags illisible : jamais réécrite sans la confirmation de remplacement de ce contenu (writer)
  if ('tags' in changes && typeof source?.tagsUnreadable === 'string')
    before = { ...before, tagsUnreadable: source.tagsUnreadable };
  try {
    let also = snap.also?.length ? snap.also : undefined;
    // Projets d'un chantier modifiés : ses tâches (et leurs sous-tâches) à rattacher sont recalculées sur la table
    // Tasks relue juste avant l'envoi, pour qu'une tâche ajoutée entre-temps ne soit pas oubliée
    if (writer.mode === 'on' && table === 'Chantiers' && 'Projets' in changes && snap.readTable) {
      let raw;
      try {
        raw = await withTimeout(snap.readTable('Tasks'), ms, () => new Error(`délai de ${ms / 1000} s dépassé`));
      } catch (err) {
        return { kind: 'reread-failed', error: String(err?.message ?? err) };
      }
      const plan = reattachRows(taskLinksFromTable(raw), taskId, changes.Projets, snap.reattachTo ?? null);
      also = plan.also.length ? plan.also : undefined;
    }
    return {
      kind: 'saved',
      entry: await writer.update(table, taskId, changes, {
        before,
        period,
        also,
        replaceTags: snap.tagsReplace,
        // Ligne relue pour cet envoi : le writer y contrôle la cellule de tags sans relire la table
        ...(source !== base ? { fresh: source } : {}),
      }),
    };
  } catch (error) {
    if (error instanceof WriteFailed && error.kind === 'missing') return { kind: 'missing' };
    if (error instanceof WriteFailed && error.kind === 'timeout')
      return unknownOutcome(snap.fetchRow, taskId, ms, changes);
    return { kind: 'failed', error };
  }
}

/**
 * Lot à envoyer après la fenêtre de conflit, recalculé depuis le brouillon et la base de l'ouverture (jamais
 * depuis un lot calculé avant la fusion des charges) : « theirs » retire la colonne, « mine » la garde. Les
 * charges partent avec chargesBase, pour être refusionnées sur la ligne relue au moment de l'envoi.
 * chargesSeen : cellule montrée dans la fenêtre ; une modification de la même personne faite après elle rouvre la
 * fenêtre au lieu d'être écrasée en silence.
 * tagsSeen : cellule de tags montrée dans la fenêtre (refusion sur la ligne relue à l'envoi). datesSeen : dates
 * de la ligne montrée (tâche) ; une période changée ailleurs ensuite rouvre la fenêtre (periodConflictCols).
 * @returns {{changes:object, before:object, chargesBase:string|null|undefined, chargesSeen:string|null|undefined,
 *   tagsSeen?:string[], datesSeen?:object}}
 */
export function conflictBatch(oldBase, draft, fresh, choices, diff = diffDraft) {
  const changes = {};
  for (const [c, v] of Object.entries(diff(oldBase, draft))) if (choices[c] !== 'theirs') changes[c] = v;
  // Tags : la saisie (ajouts, retraits) est refusionnée sur la cellule relue, jamais écrite par-dessus
  if ('tags' in changes) {
    changes.tags = mergeTags(oldBase.tags, changes.tags, fresh.tags);
    if (JSON.stringify(changes.tags) === JSON.stringify(fresh.tags ?? [])) delete changes.tags;
  }
  return {
    changes,
    before: pick(fresh, Object.keys(changes)),
    chargesBase: oldBase.charges,
    chargesSeen: fresh.charges,
    ...('tags' in changes ? { tagsSeen: fresh.tags ?? [] } : {}),
    ...('dateDebut' in fresh ? { datesSeen: { dateDebut: fresh.dateDebut, dateEcheance: fresh.dateEcheance } } : {}),
  };
}

/**
 * Lot de la fenêtre de conflit avec les charges finales du brouillon (déjà décidées par rapport à la ligne relue,
 * puis recalculées sur les dates qui partent) : envoyées si elles diffèrent de la ligne relue, refusionnées à l'envoi
 * sur ce qui aura changé depuis (chargesBase = chargesSeen = cellule relue).
 * @param {ReturnType<typeof conflictBatch>} batch
 * @param {string|null} charges cellule finale du brouillon
 * @param {object} fresh ligne relue de la fenêtre
 */
export function batchWithCharges(batch, charges, fresh) {
  const changes = { ...batch.changes };
  if (sameCharges(charges, fresh.charges)) delete changes.charges;
  else changes.charges = charges;
  return {
    ...batch,
    changes,
    before: pick(fresh, Object.keys(changes)),
    chargesBase: fresh.charges,
    chargesSeen: fresh.charges,
  };
}

/**
 * Statut rapide : la ligne est relue (envoi réel) pour décider de la date de clôture sur des valeurs à jour,
 * puis statut (et clôture éventuelle) partent dans un seul lot.
 * @returns {Promise<{kind:'nothing'}|{kind:'saved', entry:object}|{kind:'missing'}|{kind:'reread-failed', error:string}
 *   |{kind:'failed', error:Error}>}
 */
export async function runQuickStatus({
  taskId,
  status,
  localBase,
  writer,
  fetchRow,
  today,
  timeoutMs,
  table = 'Tasks',
}) {
  timeoutMs ||= DEFAULT_TIMEOUT_MS;
  let base = localBase;
  if (writer.mode === 'on') {
    try {
      base = await readRow(fetchRow, taskId, timeoutMs);
    } catch (err) {
      return { kind: 'reread-failed', error: String(err?.message ?? err) };
    }
    if (base === null) return { kind: 'missing' };
  }
  if (!base) return { kind: 'missing' };
  const changes = table === 'Chantiers' ? chantierStatusChanges(base, status) : statusChanges(base, status, today);
  if (!Object.keys(changes).length) return { kind: 'nothing' };
  try {
    return {
      kind: 'saved',
      entry: await writer.update(table, taskId, changes, { before: pick(base, Object.keys(changes)) }),
    };
  } catch (error) {
    if (error instanceof WriteFailed && error.kind === 'timeout')
      return unknownOutcome(fetchRow, taskId, timeoutMs, changes);
    return { kind: 'failed', error };
  }
}

/**
 * Création d'une ligne (tâche, sous-tâche, chantier) : une seule création par le writer. Sans réponse dans le délai,
 * le résultat est inconnu : la ligne a pu être créée, il ne faut pas la recréer à l'aveugle.
 * @returns {Promise<{kind:'saved', entry:object}|{kind:'unknown'}|{kind:'failed', error:Error}>}
 */
export async function runCreate({ writer, table, fields }) {
  try {
    return { kind: 'saved', entry: await writer.add(table, fields) };
  } catch (error) {
    if (error instanceof WriteFailed && error.kind === 'timeout') return { kind: 'unknown' };
    return { kind: 'failed', error };
  }
}

/**
 * Suppression depuis la fiche (tâche avec ses sous-tâches, chantier vide) : le writer relit les tables, refait le
 * contrôle et envoie un seul lot ; chaque requête y est limitée dans le temps (timeoutMs du writer). expect :
 * identifiants listés dans la fenêtre de confirmation (lot changé entre-temps : refus, rien n'est envoyé). Sans
 * réponse dans le délai et lignes encore là : résultat inconnu.
 * @param {{writer:object, table:string, id:number, expect?:number[]}} snap
 * @returns {Promise<{kind:'saved', entry:object}|{kind:'refused', reason:string, error:Error}|{kind:'unknown'}
 *   |{kind:'failed', error:Error}>}
 */
export async function runDelete({ writer, table, id, expect }) {
  try {
    return { kind: 'saved', entry: await writer.remove(table, id, expect ? { expect } : {}) };
  } catch (error) {
    if (error instanceof WriteRefused) return { kind: 'refused', reason: error.reason, error };
    if (error instanceof WriteFailed && error.kind === 'timeout') return { kind: 'unknown' };
    return { kind: 'failed', error };
  }
}

/**
 * Changement de chantier d'une tâche (plan de create-form.js:movePlan) : la tâche est relue ; si son rattachement a
 * changé ailleurs depuis l'ouverture, rien n'est envoyé. Sinon, la tâche et ses sous-tâches partent dans un lot.
 * @returns {Promise<{kind:'saved', entry:object}|{kind:'changed', fresh:object}|{kind:'missing'}
 *   |{kind:'reread-failed', error:string}|{kind:'unknown', stored:object|null|undefined, changes:object}
 *   |{kind:'failed', error:Error}>}
 */
export async function runMove({ writer, taskId, plan, fetchRow, readTable, timeoutMs }) {
  const ms = timeoutMs || DEFAULT_TIMEOUT_MS;
  let also = plan.also;
  if (writer.mode === 'on') {
    let fresh;
    try {
      fresh = await readRow(fetchRow, taskId, ms);
      // Sous-tâches relues dans la Feuille : celles ajoutées entre-temps par d'autres suivent aussi
      if (fresh && readTable) {
        const raw = await withTimeout(readTable('Tasks'), ms, () => new Error(`délai de ${ms / 1000} s dépassé`));
        also = moveRows(taskLinksFromTable(raw), taskId, plan.changes);
      }
    } catch (err) {
      return { kind: 'reread-failed', error: String(err?.message ?? err) };
    }
    if (fresh === null) return { kind: 'missing' };
    if (fresh.Chantier !== plan.before.Chantier || fresh.projet !== plan.before.projet)
      return { kind: 'changed', fresh };
  }
  try {
    return {
      kind: 'saved',
      count: also.length,
      entry: await writer.update('Tasks', taskId, plan.changes, { before: plan.before, also }),
    };
  } catch (error) {
    if (error instanceof WriteFailed && error.kind === 'missing') return { kind: 'missing' };
    if (error instanceof WriteFailed && error.kind === 'timeout')
      return unknownOutcome(fetchRow, taskId, ms, plan.changes);
    return { kind: 'failed', error };
  }
}

/**
 * Dates glissées dans le Gantt (tâche ou chantier) : la ligne est relue (envoi réel) ; si ses dates ne sont plus
 * celles vues au début du geste, rien n'est envoyé. Seules les dates qui changent partent. Tâche dont la capacité
 * standard de la période change : l'ETP fait foi, les heures de la cellule RELUE sont recalculées (rescaleCharges ;
 * entrées au-dessus de la borne laissées telles quelles, keptOver) et partent dans le même lot.
 * @param {{writer:object, table:'Tasks'|'Chantiers', id:number, cols:[string, string],
 *   seen:{start:number|null, end:number|null}, next:{start:number|null, end:number|null}, localBase:object|null,
 *   fetchRow:(id:number)=>Promise<object|null>, maxOf:(teamId:number, fte:number|null)=>number, timeoutMs?:number}} snap
 *   cols : colonnes de début et de fin ; localBase : ligne des données chargées (mode essai) ; maxOf : heures
 *   maximales d'une personne sur la période d'arrivée (fte : heures de 1 ETP, periodFte)
 * @returns {Promise<{kind:'nothing'}|{kind:'saved', entry:object, keptOver:number[]}|{kind:'changed', fresh:object}
 *   |{kind:'missing'}|{kind:'reread-failed', error:string}|{kind:'refused', reason:'charges'}
 *   |{kind:'unknown', stored:object|null|undefined, changes:object}|{kind:'failed', error:Error}>}
 */
export async function runDates({ writer, table, id, cols, seen, next, localBase, fetchRow, maxOf, timeoutMs }) {
  const ms = timeoutMs || DEFAULT_TIMEOUT_MS;
  const [startCol, endCol] = cols;
  let row = localBase ?? null;
  if (writer.mode === 'on') {
    try {
      row = await readRow(fetchRow, id, ms);
    } catch (err) {
      return { kind: 'reread-failed', error: String(err?.message ?? err) };
    }
    if (row && (row[startCol] !== seen.start || row[endCol] !== seen.end)) return { kind: 'changed', fresh: row };
  }
  if (!row) return { kind: 'missing' };
  const changes = {};
  if (next.start !== row[startCol]) changes[startCol] = next.start;
  if (next.end !== row[endCol]) changes[endCol] = next.end;
  if (!Object.keys(changes).length) return { kind: 'nothing' };
  const before = pick(row, Object.keys(changes));
  let keptOver = [];
  const fromFte = periodFte(row[startCol], row[endCol]);
  const toFte = periodFte(next.start, next.end);
  if (table === 'Tasks' && fromFte !== toFte && readChargesCell(row.charges).ok) {
    const res = rescaleCharges(row.charges, chargeRefs(row.charges, fromFte), toFte, {
      baseRaw: row.charges,
      maxOf: (teamId) => (maxOf ? maxOf(teamId, toFte) : Infinity),
    });
    keptOver = res.over;
    if (res.raw !== row.charges) {
      // Heures à recalculer mais charges non modifiables : rien n'est envoyé (l'ETP changerait sans message)
      if (!writer.can('Tasks', 'charges').ok) return { kind: 'refused', reason: 'charges' };
      changes.charges = res.raw;
      before.charges = row.charges;
    }
  }
  try {
    return { kind: 'saved', entry: await writer.update(table, id, changes, { before, period: next }), keptOver };
  } catch (error) {
    if (error instanceof WriteFailed && error.kind === 'missing') return { kind: 'missing' };
    if (error instanceof WriteFailed && error.kind === 'timeout') return unknownOutcome(fetchRow, id, ms, changes);
    return { kind: 'failed', error };
  }
}

/**
 * « Désactiver » ou « Réactiver » une personne (lot 2d, jamais de suppression) : la ligne est relue (envoi réel) ;
 * si elle est déjà dans l'état demandé, rien n'est envoyé. Sinon la seule colonne actif part dans un lot.
 * @returns {Promise<{kind:'nothing'}|{kind:'saved', entry:object}|{kind:'missing'}|{kind:'reread-failed', error:string}
 *   |{kind:'failed', error:Error}|{kind:'unknown', stored:object|null|undefined, changes:object}>}
 */
export async function runSetActive({ writer, personId, actif, localBase, fetchRow, timeoutMs }) {
  const ms = timeoutMs || DEFAULT_TIMEOUT_MS;
  let base = localBase;
  if (writer.mode === 'on') {
    try {
      base = await readRow(fetchRow, personId, ms);
    } catch (err) {
      return { kind: 'reread-failed', error: String(err?.message ?? err) };
    }
  }
  if (!base) return { kind: 'missing' };
  if (base.actif === actif) return { kind: 'nothing' };
  const changes = { actif };
  try {
    return { kind: 'saved', entry: await writer.update('Team', personId, changes, { before: { actif: base.actif } }) };
  } catch (error) {
    if (error instanceof WriteFailed && error.kind === 'missing') return { kind: 'missing' };
    if (error instanceof WriteFailed && error.kind === 'timeout')
      return unknownOutcome(fetchRow, personId, ms, changes);
    return { kind: 'failed', error };
  }
}

/** Raison lisible d'un échec : 'refused:<raison>', 'acl', 'document', 'missing' ou 'other'. */
export function failureKind(error) {
  if (error instanceof WriteRefused) return `refused:${error.reason}`;
  if (error instanceof WriteFailed) return error.document ? 'document' : error.kind;
  return 'other';
}
