/* global process, console */
/**
 * Banc d'essai des ÉCRITURES du widget contre le VRAI Grist, dans le DOCUMENT DE TEST seulement (lancer par run.py).
 *
 * Le writer du widget (core/grist-writer.js) est construit comme dans main.js (lookup, périmètre, relectures), avec
 * pour transport POST /apply au lieu de grist.docApi.applyUserActions ; les lectures passent par /records et /sql.
 * Les scénarios passent par les mêmes fonctions que l'interface (runSave, runQuickStatus, runCreate, runMove,
 * runSetActive, formulaires purs), puis relisent les lignes dans Grist et comparent exactement à ce qui a été envoyé.
 * Les écritures « d'un autre utilisateur » (conflits) sont envoyées directement par le transport, dans le même
 * document de test.
 */
import { writeFileSync } from 'node:fs';
import { createGateway } from '../../widget/js/core/grist-gateway.js';
import { buildModel } from '../../widget/js/core/model.js';
import {
  WriteFailed,
  WriteRefused,
  classifyError,
  createWriter,
  decodeRow,
  isDocumentRefusal,
} from '../../widget/js/core/grist-writer.js';
import { runCreate, runMove, runQuickStatus, runSave, runSetActive } from '../../widget/js/core/task-session.js';
import {
  hoursFromInput,
  maxHours,
  periodDays,
  readChargesCell,
  setPersonHours,
} from '../../widget/js/core/charges-edit.js';
import { tagOptions } from '../../widget/js/core/tags-edit.js';
import {
  diffPerson,
  diffUnav,
  isdDomainValue,
  newPersonFields,
  newUnavFields,
  personDraftFrom,
  shareFromPercent,
  unavDraftFrom,
} from '../../widget/js/core/person-form.js';
import { movePlan, newChantierFields, newTaskFields } from '../../widget/js/core/create-form.js';
import { chantierDraftFrom, diffChantier } from '../../widget/js/core/chantier-form.js';
import { draftFrom, taskInScope } from '../../widget/js/core/task-form.js';
import { SECONDS_PER_DAY, parisToday } from '../../widget/js/core/write-encode.js';
import { canWriteRowIn, canWriteValuesIn } from '../../widget/js/core/write-scope.js';
import {
  ESTIMATION_APH,
  estimationIdsOfTable,
  isEstimationAph,
  isEstimationPerson,
} from '../../widget/js/core/estimation.js';
import { createRest, guardedConfig } from './rest.js';

const cfg = guardedConfig();
const rest = createRest(cfg);
const grist = { docApi: { fetchTable: (t) => rest.fetchTable(t), applyUserActions: (a) => rest.apply(a) } };
const gateway = createGateway(grist);
const ONLY = String(process.env.REAL_GRIST_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const STAMP = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

// ---- État de la session, comme main.js (state.raw, state.model) -------------------------------------------------
const state = { raw: null, model: null };
async function load() {
  const raw = await gateway.fetchAll();
  if (raw.problems.some((p) => p.column === null && !p.optional)) throw new Error(JSON.stringify(raw.problems));
  state.raw = raw;
  state.model = buildModel(raw);
  return raw;
}
const lookup = {
  choices: (key) => state.model?.choices?.[key] ?? null,
  row: (table, id) => (state.raw?.tables[table] ? decodeRow(state.raw.tables[table], table, id) : null),
  estimationIds: () => estimationIdsOfTable(state.raw?.tables.Team),
  childIds: (id) => {
    const t = state.raw?.tables.Tasks;
    return t?.parentTask ? t.id.filter((_, i) => t.parentTask[i] === id) : [];
  },
  chantierTasks: (id) => {
    const t = state.raw?.tables.Tasks;
    return t?.Chantier ? t.id.filter((_, i) => t.Chantier[i] === id) : [];
  },
  referenced: (table, id) =>
    table === 'Tasks' ? lookup.childIds(id).length > 0 : table === 'Chantiers' && lookup.chantierTasks(id).length > 0,
};
const fetchRow = (table, id) => gateway.fetchRow(table, id);
const readTable = (table) => gateway.fetchTableRaw(table);
const rowOf = (table) => (id) => fetchRow(table, id);

function makeWriter(columns) {
  return createWriter({
    docApi: grist.docApi,
    mode: 'on',
    columns,
    canWriteRow: (table, id) =>
      canWriteRowIn(state.model, table, id, (rowId) => lookup.row('Disponibilites', rowId)?.membre ?? null),
    canWriteValues: (table, v, opts = {}) => canWriteValuesIn(state.model, table, v, opts),
    refExists: (table, id) => Boolean(state.raw?.tables[table]?.id?.includes(id)),
    lookup,
    tempId: () => 0,
    periodOf: (table, id) => {
      const t = table === 'Tasks' ? state.model?.tasks.get(id) : null;
      return t ? { start: t.start, end: t.end } : null;
    },
    readTable,
    preflight: async () => true,
  });
}

// ---- Assertions et journal ---------------------------------------------------------------------------------------
const results = [];
const observations = [];
const J = (v) => JSON.stringify(v);
let cur = null;
function eq(actual, expected, what) {
  if (J(actual) !== J(expected)) cur.failures.push(`${what} : attendu ${J(expected)}, lu ${J(actual)}`);
}
function ok(cond, what) {
  if (!cond) cur.failures.push(what);
}
function note(text) {
  cur.notes.push(text);
}
function observe(text) {
  if (!observations.includes(text)) observations.push(text);
}
async function scenario(name, fn) {
  if (ONLY.length && !ONLY.some((p) => name.startsWith(p))) return;
  cur = { name, failures: [], notes: [], sent: 0, ms: 0 };
  const sent0 = rest.sentCount();
  const t0 = Date.now();
  try {
    await fn();
  } catch (err) {
    cur.failures.push(`exception : ${err?.stack ?? err}`);
  }
  cur.sent = rest.sentCount() - sent0;
  cur.ms = Date.now() - t0;
  cur.ok = cur.failures.length === 0;
  results.push(cur);
  console.log(`${cur.ok ? 'OK' : 'KO'}  ${name}  (${cur.sent} envoi(s), ${cur.ms} ms)`);
  for (const f of cur.failures) console.log(`      ✗ ${f}`);
  for (const n of cur.notes) console.log(`      · ${n}`);
  try {
    await load();
  } catch (err) {
    console.log(`      ! relecture impossible : ${err}`);
  }
}

/** Dernier lot envoyé par le transport (actions et réponse de Grist). */
const lastSent = () => rest.log[rest.log.length - 1];

/** Relit la ligne brute dans Grist (/records) et compare chaque cellule envoyée par la dernière action du writer. */
async function expectStored(table, id, fields, what = `${table} ${id}`) {
  const raw = await rest.row(table, id);
  if (!raw) return cur.failures.push(`${what} : ligne introuvable`);
  for (const [c, v] of Object.entries(fields)) eq(raw[c], v, `${what}.${c}`);
  return raw;
}

/** Valeur stockée en SQL (pour comparer à la valeur rendue par /records). */
async function sqlCell(table, id, col) {
  const r = await rest.sql(`select "${col}" as v from "${table}" where id = ${Number(id)}`);
  return r[0]?.v;
}

/** Écriture « d'un autre utilisateur » : envoi direct au document de test, hors writer. */
const otherUser = (actions) => rest.apply(actions);

/** Écriture refusée par le writer avant tout envoi. */
async function expectRefused(promise, reason, what) {
  const sent0 = rest.sentCount();
  try {
    await promise;
    cur.failures.push(`${what} : écriture acceptée, refus « ${reason} » attendu`);
  } catch (err) {
    if (!(err instanceof WriteRefused)) cur.failures.push(`${what} : ${err?.name} ${err?.message}`);
    else if (err.reason !== reason) cur.failures.push(`${what} : refus « ${err.reason} », « ${reason} » attendu`);
  }
  eq(rest.sentCount() - sent0, 0, `${what} : envois`);
}

// ---- Choix des lignes d'essai dans les données du document de test -----------------------------------------------
function pickSubjects() {
  const m = state.model;
  const people = [...m.people.values()];
  const isd = people.filter((p) => p.isd && p.actif).sort((a, b) => a.id - b.id);
  const mgmt = people.filter((p) => p.isdTeam && !p.isd).sort((a, b) => a.id - b.id);
  const tasks = [...m.tasks.values()].sort((a, b) => a.id - b.id);
  const readable = (t) => readChargesCell(lookup.row('Tasks', t.id)?.charges).ok && t.tagsUnreadable === null;
  const A = tasks.find(
    (t) =>
      taskInScope(m, t) &&
      !t.parentId &&
      !t.childIds.length &&
      t.chantierId &&
      t.projectId &&
      m.chantiers.get(t.chantierId)?.projectIds.includes(t.projectId) &&
      t.start !== null &&
      t.end !== null &&
      t.end - t.start >= 13 &&
      !t.done &&
      t.closed === null &&
      readable(t) &&
      tasks.filter((x) => x.chantierId === t.chantierId && !x.parentId && x.id !== t.id).length >= 2,
  );
  if (!A) throw new Error('aucune tâche d’essai trouvée');
  const siblings = tasks.filter((x) => x.chantierId === A.chantierId && !x.parentId && x.id !== A.id);
  const D = siblings.find((x) => !x.dependDe.includes(A.id));
  const P = siblings.find((x) => x.id !== D.id);
  const C0 = [...m.chantiers.values()]
    .sort((a, b) => a.id - b.id)
    .find(
      (c) => c.id !== A.chantierId && c.projectIds.some((p) => m.projects.get(p)?.inScope) && c.tagsUnreadable === null,
    );
  const p0 = C0.projectIds.find((p) => m.projects.get(p)?.inScope);
  const inScopeProject = m.projects.get(A.projectId);
  return { A, D, P, C0, p0, isd, mgmt, inScopeProject };
}

/** Projet du périmètre dont le seul lien avec l'équipe ISD est un responsable Management ISD. */
function mgmtOnlyProject() {
  const m = state.model;
  const isdP = (id) => m.people.get(id)?.isdTeam === true;
  const prof = (id) => m.people.get(id)?.isd === true;
  for (const p of [...m.projects.values()].sort((a, b) => a.id - b.id)) {
    if (!p.inScope || !p.responsable || !isdP(p.responsable) || prof(p.responsable)) continue;
    if (p.sponsor.some(prof) || p.contributeursCles.some(prof)) continue;
    const chs = [...m.chantiers.values()].filter((c) => c.projectIds.includes(p.id));
    if (chs.some((c) => isdP(c.responsable) || c.contributeurs.some(isdP))) continue;
    // Un chantier partagé avec un autre projet du périmètre donnerait un second lien : exclu
    if (chs.some((c) => c.projectIds.some((q) => q !== p.id && m.projects.get(q)?.inScope))) continue;
    const ts = [...m.tasks.values()].filter((t) => t.projectId === p.id || chs.some((c) => c.id === t.chantierId));
    if (ts.some((t) => t.assignees.some(isdP) || isdP(t.responsable) || t.charges.some((c) => isdP(c.personId))))
      continue;
    return { project: p, chantiers: chs, tasks: ts };
  }
  return null;
}

// ---- Scénarios ---------------------------------------------------------------------------------------------------
async function main() {
  const raw0 = await load();
  const writer = makeWriter(raw0.columns);
  const S = pickSubjects();
  const today = parisToday();
  const W = () => writer;
  const [P1, P2, P3] = S.isd;
  console.log(
    `Lignes d'essai : tâche ${S.A.id} (chantier ${S.A.chantierId}), dépendance ${S.D.id}, parent ${S.P.id}, ` +
      `chantier cible ${S.C0.id}, personnes ${P1.id}/${P2.id}/${P3.id}`,
  );
  const retired = Object.keys(raw0.columns ?? {}).filter((k) => {
    const [t, c] = k.split('.');
    return !['ok', 'colonne', 'table'].includes(W().can(t, c).reason);
  });
  console.log(`Colonnes de la liste blanche retirées au chargement : ${retired.join(', ')}`);

  const save = (table, id, base, draft, extra = {}) =>
    runSave({ table, taskId: id, base, draft, writer: W(), fetchRow: rowOf(table), readTable, ...extra });

  // 1. Champs de la fiche tâche
  await scenario(
    '1a tâche : titre, statut, dates, priorité, description, lien, progression, personnes, dépendance',
    async () => {
      const base = await fetchRow('Tasks', S.A.id);
      const draft = {
        ...draftFrom(base),
        titre: `${base.titre} [essai réel ${STAMP}]`,
        statut: 'review',
        dateDebut: base.dateDebut + 1,
        dateEcheance: base.dateEcheance + 2,
        priorite: '2',
        description: 'Ligne 1\nLigne 2 « guillemets » é\t€',
        Lien_utile: '  https://example.org/essai-reel  ',
        progression: 42.5,
        Responsable: P1.id,
        assignees: [P2.id, P3.id],
        dependDe: [S.D.id],
      };
      const r = await save('Tasks', S.A.id, base, draft);
      eq(r.kind, 'saved', 'résultat');
      if (r.kind !== 'saved') return note(J(r.error?.message ?? r));
      const sent = r.entry.actions[0];
      eq(sent[0], 'UpdateRecord', 'action');
      eq(sent[3].Lien_utile, 'https://example.org/essai-reel', 'lien nettoyé avant envoi');
      eq(sent[3].dateDebut, (base.dateDebut + 1) * SECONDS_PER_DAY, 'date encodée en secondes');
      await expectStored('Tasks', S.A.id, sent[3]);
      const back = await fetchRow('Tasks', S.A.id);
      for (const c of Object.keys(sent[3])) eq(back[c], r.entry.after[c] ?? draft[c], `relu (modèle).${c}`);
      note(`réponse /apply : ${J(lastSent().response)}`);
      note(
        `SQL assignees = ${J(await sqlCell('Tasks', S.A.id, 'assignees'))}, dateDebut = ${J(await sqlCell('Tasks', S.A.id, 'dateDebut'))}, priorite = ${J(await sqlCell('Tasks', S.A.id, 'priorite'))}`,
      );
    },
  );

  await scenario(
    '1b tâche : vider responsable, assignés, dépendances, progression, priorité, description',
    async () => {
      const base = await fetchRow('Tasks', S.A.id);
      const draft = {
        ...draftFrom(base),
        Responsable: null,
        assignees: [],
        dependDe: [],
        progression: null,
        priorite: '',
        description: '',
      };
      const r = await save('Tasks', S.A.id, base, draft);
      eq(r.kind, 'saved', 'résultat');
      if (r.kind !== 'saved') return note(J(r.error?.message ?? r));
      const sent = r.entry.actions[0][3];
      eq(
        sent,
        { priorite: '', Responsable: 0, assignees: null, description: '', progression: null, dependDe: null },
        'cellules envoyées',
      );
      const stored = await expectStored('Tasks', S.A.id, sent);
      note(`relu brut : ${J(Object.fromEntries(Object.keys(sent).map((c) => [c, stored?.[c]])))}`);
      note(
        `SQL assignees vide = ${J(await sqlCell('Tasks', S.A.id, 'assignees'))}, Responsable vide = ${J(await sqlCell('Tasks', S.A.id, 'Responsable'))}`,
      );
      const back = await fetchRow('Tasks', S.A.id);
      eq([back.Responsable, back.assignees, back.dependDe, back.progression], [null, [], [], null], 'relu (modèle)');
    },
  );

  await scenario('1c tâche : parentTask posé puis retiré (même chantier)', async () => {
    let base = await fetchRow('Tasks', S.A.id);
    let r = await save('Tasks', S.A.id, base, { ...draftFrom(base), parentTask: S.P.id });
    eq(r.kind, 'saved', 'résultat (pose)');
    if (r.kind === 'saved') await expectStored('Tasks', S.A.id, { parentTask: S.P.id });
    await load();
    base = await fetchRow('Tasks', S.A.id);
    r = await save('Tasks', S.A.id, base, { ...draftFrom(base), parentTask: null });
    eq(r.kind, 'saved', 'résultat (retrait)');
    if (r.kind === 'saved') {
      eq(r.entry.actions[0][3], { parentTask: 0 }, 'Ref vide envoyée');
      await expectStored('Tasks', S.A.id, { parentTask: 0 });
    }
  });

  // 2. Règle de la date de clôture et statut rapide
  await scenario('2 statut rapide « done » : date de clôture du jour, puis conservée', async () => {
    let r = await runQuickStatus({ taskId: S.A.id, status: 'done', writer: W(), fetchRow: rowOf('Tasks'), today });
    eq(r.kind, 'saved', 'done');
    if (r.kind === 'saved') {
      eq(r.entry.actions[0][3], { statut: 'done', dateCloture: today * SECONDS_PER_DAY }, 'lot');
      await expectStored('Tasks', S.A.id, { statut: 'done', dateCloture: today * SECONDS_PER_DAY });
    }
    r = await runQuickStatus({ taskId: S.A.id, status: 'inprogress', writer: W(), fetchRow: rowOf('Tasks'), today });
    eq(r.kind === 'saved' && r.entry.actions[0][3], { statut: 'inprogress' }, 'retour en cours : clôture non touchée');
    await expectStored('Tasks', S.A.id, { statut: 'inprogress', dateCloture: today * SECONDS_PER_DAY });
    r = await runQuickStatus({
      taskId: S.A.id,
      status: 'done',
      writer: W(),
      fetchRow: rowOf('Tasks'),
      today: today + 3,
    });
    eq(r.kind === 'saved' && r.entry.actions[0][3], { statut: 'done' }, 'done avec clôture déjà posée');
    r = await runQuickStatus({ taskId: S.A.id, status: 'done', writer: W(), fetchRow: rowOf('Tasks'), today });
    eq(r.kind, 'nothing', 'même statut : rien');
    await load();
    const base = await fetchRow('Tasks', S.A.id);
    r = await save('Tasks', S.A.id, base, { ...draftFrom(base), statut: 'inprogress', dateCloture: null });
    eq(r.kind, 'saved', 'clôture effacée par la fiche');
    if (r.kind === 'saved') await expectStored('Tasks', S.A.id, { statut: 'inprogress', dateCloture: null });
  });

  // 3. Charges
  const days = periodDays((await fetchRow('Tasks', S.A.id)).dateDebut, (await fetchRow('Tasks', S.A.id)).dateEcheance);
  const t1 = `{"teamId": ${P1.id}, "heures": 10, "note": "garder"}`;
  const t2 = `{"heures":3.25,"teamId":"${P2.id}"}`;
  await scenario('3a charges : ajout en ETP, entrées non touchées recopiées octet par octet', async () => {
    await otherUser([['UpdateRecord', 'Tasks', S.A.id, { charges: `[ ${t1} ,\n ${t2}]` }]]);
    await load();
    const base = await fetchRow('Tasks', S.A.id);
    const h = hoursFromInput('0,2', 'etp', days);
    ok('heures' in h, `saisie 0,2 ETP : ${J(h)}`);
    const draft = { ...draftFrom(base), charges: setPersonHours(base.charges, P3.id, h.heures) };
    const r = await save('Tasks', S.A.id, base, draft);
    eq(r.kind, 'saved', 'résultat');
    const expected = `[${t1},${t2},{"teamId":${P3.id},"heures":${h.heures}}]`;
    eq(r.kind === 'saved' && r.entry.actions[0][3].charges, expected, 'cellule envoyée');
    await expectStored('Tasks', S.A.id, { charges: expected });
    note(`${days} jours, 0,2 ETP = ${h.heures} h`);
  });

  await scenario('3b charges : modification en heures', async () => {
    const base = await fetchRow('Tasks', S.A.id);
    const h = hoursFromInput('7,5', 'heures', days);
    const r = await save('Tasks', S.A.id, base, {
      ...draftFrom(base),
      charges: setPersonHours(base.charges, P3.id, h.heures),
    });
    eq(r.kind, 'saved', 'résultat');
    await expectStored('Tasks', S.A.id, { charges: `[${t1},${t2},{"teamId":${P3.id},"heures":7.5}]` });
  });

  await scenario('3c charges : plafond de 1 ETP refusé (saisie et writer), rien envoyé', async () => {
    const base = await fetchRow('Tasks', S.A.id);
    const max = maxHours(days);
    const h = hoursFromInput(String(max + 1), 'heures', days);
    eq(h.error, 'max', 'saisie au-delà de 1 ETP');
    await expectRefused(
      W().update(
        'Tasks',
        S.A.id,
        { charges: setPersonHours(base.charges, P3.id, max + 0.5) },
        { before: { charges: base.charges } },
      ),
      'charges',
      'writer',
    );
  });

  await scenario('3d charges : modification concurrente d’une autre personne fusionnée', async () => {
    const base = await fetchRow('Tasks', S.A.id);
    const theirs = setPersonHours(base.charges, P2.id, 4);
    await otherUser([['UpdateRecord', 'Tasks', S.A.id, { charges: theirs }]]);
    const r = await save('Tasks', S.A.id, base, {
      ...draftFrom(base),
      charges: setPersonHours(base.charges, P1.id, 12),
    });
    eq(r.kind, 'saved', 'résultat');
    const stored = (await rest.row('Tasks', S.A.id))?.charges;
    const entries = readChargesCell(stored).entries?.map((e) => [Number(e.teamId), e.heures]);
    eq(
      entries,
      [
        [P1.id, 12],
        [P2.id, 4],
        [P3.id, 7.5],
      ],
      'charges fusionnées par personne',
    );
    note(`cellule finale : ${stored}`);
  });

  await scenario('3e charges : même personne modifiée des deux côtés → conflit, rien envoyé', async () => {
    const base = await fetchRow('Tasks', S.A.id);
    await otherUser([['UpdateRecord', 'Tasks', S.A.id, { charges: setPersonHours(base.charges, P1.id, 20) }]]);
    const sent0 = rest.sentCount();
    const r = await save('Tasks', S.A.id, base, {
      ...draftFrom(base),
      charges: setPersonHours(base.charges, P1.id, 14),
    });
    eq(r.kind, 'conflict', 'résultat');
    eq(r.cols, ['charges'], 'colonnes en conflit');
    eq(rest.sentCount() - sent0, 0, 'envois');
  });

  // 4. Tags
  const NEW_TAG = `Essai réel ${STAMP}`;
  await scenario('4a tags tâche : tag existant et nouveau tag non déclaré', async () => {
    const opts = tagOptions(state.model, 'Tasks');
    const existing = opts.find((o) => o.count > 0)?.value ?? null;
    note(`tags proposés pour Tasks : ${opts.length} (déclarés : ${opts.filter((o) => o.declared).length})`);
    const base = await fetchRow('Tasks', S.A.id);
    const tags = [...base.tags, ...(existing && !base.tags.includes(existing) ? [existing] : []), NEW_TAG];
    const colBefore = (await rest.columns('Tasks')).find((c) => c.id === 'tags').fields;
    const r = await save('Tasks', S.A.id, base, { ...draftFrom(base), tags });
    eq(r.kind, 'saved', 'résultat');
    if (r.kind !== 'saved') return note(J(r.error?.message ?? r));
    eq(r.entry.actions[0][3].tags, ['L', ...tags], 'cellule envoyée');
    await expectStored('Tasks', S.A.id, { tags: ['L', ...tags] });
    note(`SQL tags = ${J(await sqlCell('Tasks', S.A.id, 'tags'))}`);
    const colAfter = (await rest.columns('Tasks')).find((c) => c.id === 'tags').fields;
    eq([colAfter.type, colAfter.widgetOptions], [colBefore.type, colBefore.widgetOptions], 'colonne tags inchangée');
    await load();
    const o = tagOptions(state.model, 'Tasks').find((x) => x.value === NEW_TAG);
    eq(o && o.declared, false, 'nouveau tag proposé « non déclaré »');
  });

  await scenario('4b tags tâche : retrait d’un tag', async () => {
    const base = await fetchRow('Tasks', S.A.id);
    const tags = base.tags.filter((t) => t !== NEW_TAG);
    const r = await save('Tasks', S.A.id, base, { ...draftFrom(base), tags });
    eq(r.kind, 'saved', 'résultat');
    await expectStored('Tasks', S.A.id, { tags: tags.length ? ['L', ...tags] : null });
  });

  await scenario('4c tags tâche : ajout concurrent fusionné, liste vidée', async () => {
    const base = await fetchRow('Tasks', S.A.id);
    const theirs = `Autre ${STAMP}`;
    await otherUser([['UpdateRecord', 'Tasks', S.A.id, { tags: ['L', ...base.tags, theirs] }]]);
    const r = await save('Tasks', S.A.id, base, { ...draftFrom(base), tags: [...base.tags, NEW_TAG] });
    eq(r.kind, 'saved', 'résultat');
    await expectStored('Tasks', S.A.id, { tags: ['L', ...base.tags, theirs, NEW_TAG] });
    await load();
    const b2 = await fetchRow('Tasks', S.A.id);
    const r2 = await save('Tasks', S.A.id, b2, { ...draftFrom(b2), tags: [] });
    eq(r2.kind, 'saved', 'liste vidée');
    if (r2.kind === 'saved') eq(r2.entry.actions[0][3].tags, null, 'liste vide envoyée');
    const stored = await rest.row('Tasks', S.A.id);
    note(`tags vidés relus : ${J(stored?.tags)}`);
    eq(stored?.tags, null, 'liste vide relue');
  });

  await scenario('4d tags chantier : tag déclaré puis nouveau, retrait', async () => {
    const declared = state.model.choices['Chantiers.tags'] ?? [];
    const base = await fetchRow('Chantiers', S.C0.id);
    const add = [...declared.filter((d) => !base.tags.includes(d)).slice(0, 1), NEW_TAG];
    const r = await save(
      'Chantiers',
      S.C0.id,
      base,
      { ...chantierDraftFrom(base), tags: [...base.tags, ...add] },
      { diff: diffChantier },
    );
    eq(r.kind, 'saved', 'ajout');
    await expectStored('Chantiers', S.C0.id, { tags: ['L', ...base.tags, ...add] });
    await load();
    const b2 = await fetchRow('Chantiers', S.C0.id);
    const r2 = await save(
      'Chantiers',
      S.C0.id,
      b2,
      { ...chantierDraftFrom(b2), tags: base.tags },
      { diff: diffChantier },
    );
    eq(r2.kind, 'saved', 'retrait');
    await expectStored('Chantiers', S.C0.id, { tags: base.tags.length ? ['L', ...base.tags] : null });
  });

  // 5. Créations, changement de chantier, annulations
  const created = {};
  await scenario('5a création d’un chantier (retValues)', async () => {
    const fields = newChantierFields({
      Nom_du_chantier: `  [Essai réel ${STAMP}] Chantier  `,
      Projets: [S.inScopeProject.id],
      Statut: 'À cadrer',
      Debut: today,
      Fin: today + 60,
      Responsable: P1.id,
      Contributeurs: [P2.id],
      Description: 'Chantier créé par le banc d’essai',
    });
    const r = await runCreate({ writer: W(), table: 'Chantiers', fields });
    eq(r.kind, 'saved', 'résultat');
    if (r.kind !== 'saved') return note(J(r.error?.message ?? r));
    created.chantier = r.entry.id;
    const resp = lastSent().response;
    note(`réponse /apply : ${J(resp)}`);
    eq(resp.retValues?.[0], r.entry.id, 'retValues[0] = id créé');
    await expectStored('Chantiers', r.entry.id, r.entry.actions[0][3]);
  });

  await scenario('5b création d’une tâche dans le chantier, puis de deux sous-tâches', async () => {
    if (!created.chantier) throw new Error('chantier non créé');
    const base = {
      titre: `[Essai réel ${STAMP}] Tâche`,
      Chantier: created.chantier,
      projet: S.inScopeProject.id,
      parentTask: null,
      statut: 'todo',
      type: 'tache',
      dateDebut: today,
      dateEcheance: today + 20,
      assignees: [P1.id],
      Responsable: P1.id,
      priorite: '3',
      description: 'Créée par le banc d’essai',
    };
    const fields = newTaskFields(base, { creePar: 'essai.reel', canAddField: (c) => W().canAddField('Tasks', c) });
    let r = await runCreate({ writer: W(), table: 'Tasks', fields });
    eq(r.kind, 'saved', 'tâche');
    if (r.kind !== 'saved') return note(J(r.error?.message ?? r));
    created.task = r.entry.id;
    eq(lastSent().response.retValues?.[0], r.entry.id, 'retValues[0]');
    const stored = await expectStored('Tasks', r.entry.id, r.entry.actions[0][3]);
    note(`Cree_par envoyé « essai.reel », relu ${J(stored?.Cree_par)} (colonne à formule de déclenchement user.Name)`);
    await load();
    created.subs = [];
    for (const n of [1, 2]) {
      const sub = newTaskFields({
        ...base,
        titre: `[Essai réel ${STAMP}] Sous-tâche ${n}`,
        parentTask: created.task,
        assignees: [],
      });
      r = await runCreate({ writer: W(), table: 'Tasks', fields: sub });
      eq(r.kind, 'saved', `sous-tâche ${n}`);
      if (r.kind === 'saved') {
        created.subs.push(r.entry.id);
        await expectStored('Tasks', r.entry.id, { parentTask: created.task, Chantier: created.chantier });
      }
      await load();
    }
  });

  await scenario(
    '5c changement de chantier d’une tâche et de ses sous-tâches (BulkUpdateRecord), puis annulation',
    async () => {
      if (!created.subs?.length) throw new Error('sous-tâches non créées');
      const plan = movePlan(state.model, created.task, S.C0.id, S.p0);
      ok(!plan.error, `plan : ${plan.error}`);
      const r = await runMove({ writer: W(), taskId: created.task, plan, fetchRow: rowOf('Tasks'), readTable });
      eq(r.kind, 'saved', 'résultat');
      if (r.kind !== 'saved') return note(J(r.error?.message ?? r));
      const acts = lastSent().actions;
      eq(
        acts.map((a) => a[0]),
        ['UpdateRecord', 'BulkUpdateRecord'],
        'actions',
      );
      eq(
        acts[1][2],
        [...created.subs].sort((a, b) => a - b),
        'lignes du BulkUpdateRecord',
      );
      note(`réponse /apply : ${J(lastSent().response)}`);
      for (const id of [created.task, ...created.subs])
        await expectStored('Tasks', id, { Chantier: S.C0.id, projet: S.p0 });
      await load();
      const u = await W().undoLast(fetchRow);
      ok(u.undoEntry?.sent, `annulation : ${J({ skipped: u.skipped, reason: u.reason })}`);
      eq(
        lastSent().actions.map((a) => a[0]),
        ['UpdateRecord', 'BulkUpdateRecord'],
        'actions de l’annulation',
      );
      for (const id of [created.task, ...created.subs])
        await expectStored('Tasks', id, { Chantier: created.chantier, projet: S.inScopeProject.id });
    },
  );

  await scenario('5d annulation d’une création intacte (RemoveRecord)', async () => {
    const fields = newTaskFields({
      titre: `[Essai réel ${STAMP}] À annuler`,
      Chantier: created.chantier,
      projet: S.inScopeProject.id,
      parentTask: null,
      statut: 'todo',
      type: 'tache',
      dateDebut: null,
      dateEcheance: null,
      assignees: [],
      Responsable: null,
      priorite: '',
      description: '',
    });
    const r = await runCreate({ writer: W(), table: 'Tasks', fields });
    eq(r.kind, 'saved', 'création');
    if (r.kind !== 'saved') return;
    note(`photo après création : ${Object.keys(r.entry.snapshot ?? {}).length} colonnes`);
    await load();
    const u = await W().undoLast(fetchRow);
    ok(u.undoEntry?.sent, `annulation : ${J({ skipped: u.skipped, reason: u.reason })}`);
    eq(lastSent().actions, [['RemoveRecord', 'Tasks', r.entry.id]], 'action');
    note(`réponse /apply : ${J(lastSent().response)}`);
    eq(await rest.row('Tasks', r.entry.id), null, 'ligne supprimée');
  });

  await scenario('5e annulation refusée d’une création modifiée par un autre', async () => {
    const fields = newTaskFields({
      titre: `[Essai réel ${STAMP}] Modifiée ailleurs`,
      Chantier: created.chantier,
      projet: S.inScopeProject.id,
      parentTask: null,
      statut: 'todo',
      type: 'tache',
      dateDebut: null,
      dateEcheance: null,
      assignees: [],
      Responsable: null,
      priorite: '',
      description: '',
    });
    const r = await runCreate({ writer: W(), table: 'Tasks', fields });
    eq(r.kind, 'saved', 'création');
    if (r.kind !== 'saved') return;
    created.touched = r.entry.id;
    await otherUser([['UpdateRecord', 'Tasks', r.entry.id, { Commentaire: 'modifiée par un autre' }]]);
    await load();
    const sent0 = rest.sentCount();
    const u = await W().undoLast(fetchRow);
    eq([u.reason, u.skipped], ['modifiee', ['Commentaire']], 'refus');
    eq(rest.sentCount() - sent0, 0, 'envois');
    ok(Boolean(await rest.row('Tasks', r.entry.id)), 'ligne conservée');
  });

  await scenario('6 statut rapide d’un chantier', async () => {
    const r = await runQuickStatus({
      table: 'Chantiers',
      taskId: created.chantier,
      status: 'En réalisation',
      writer: W(),
      fetchRow: rowOf('Chantiers'),
      today,
    });
    eq(r.kind, 'saved', 'résultat');
    eq(r.kind === 'saved' && r.entry.actions[0][3], { Statut: 'En réalisation' }, 'lot');
    await expectStored('Chantiers', created.chantier, { Statut: 'En réalisation' });
  });

  // 10. Team.aph colonne Int (convertie par Grist) et personnes estimation. Seule la cellule aph d'une personne
  // ordinaire est écrite, puis remise à sa valeur d'origine ; aucune autre table n'est touchée.
  await scenario('10a APH : métadonnées de Team.aph et personnes estimation détectées', async () => {
    const col = (await rest.columns('Team')).find((c) => c.id === 'aph')?.fields;
    note(`Team.aph : type ${J(col?.type)}, isFormula ${J(col?.isFormula)}, formule ${J(col?.formula ?? '')}`);
    eq(W().columnType('Team', 'aph'), col?.type === 'Int' ? 'Int' : 'Text', 'type d’écriture du writer');
    const t = state.raw.tables.Team;
    const holders = t.id.filter((_, i) => isEstimationAph(t.aph[i]));
    const active = holders.filter((id) => t.actif[t.id.indexOf(id)] === true);
    note(
      `titulaires de ${ESTIMATION_APH} : ${J(holders.map((id) => `${id} ${state.model.people.get(id)?.nom} (${state.model.people.get(id)?.roleText}${state.model.people.get(id)?.actif ? '' : ', inactive'})`))}`,
    );
    eq(
      [...estimationIdsOfTable(t)].sort((a, b) => a - b),
      active,
      'estimationIdsOfTable = titulaires actifs',
    );
    eq(
      [...state.model.estimation.ids].sort((a, b) => a - b),
      active,
      'model.estimation.ids = titulaires actifs',
    );
    for (const id of active) ok(isEstimationPerson(state.model, id), `${id} personne estimation (badge, exemption)`);
    note(`valeurs de Team.aph : ${[...new Set(t.aph.map((v) => (v === null ? 'null' : typeof v)))].join(', ')}`);
  });

  await scenario(
    '10b APH : écrit selon le type de la colonne (nombre si Int), vidé, relu en texte, remis à l’origine',
    async () => {
      if (!W().can('Team', 'aph').ok) return note(`Team.aph non modifiable : ${W().can('Team', 'aph').reason}`);
      const type = W().columnType('Team', 'aph');
      const who = S.isd.find((p) => !isEstimationAph(p.aph) && !p.aph);
      if (!who) return cur.failures.push('aucune personne ISD sans APH pour l’essai');
      const origSql = await sqlCell('Team', who.id, 'aph');
      note(`personne ${who.id}, aph d’origine en SQL ${J(origSql)}`);
      let base = await fetchRow('Team', who.id);
      let r = await save('Team', who.id, base, { ...personDraftFrom(base), aph: ' 7000123 ' }, { diff: diffPerson });
      eq(r.kind, 'saved', 'écriture');
      if (r.kind !== 'saved') return note(J(r.error?.message ?? r));
      eq(r.entry.actions[0][3], { aph: type === 'Int' ? 7000123 : '7000123' }, 'cellule envoyée');
      await expectStored('Team', who.id, { aph: type === 'Int' ? 7000123 : '7000123' });
      eq((await fetchRow('Team', who.id)).aph, '7000123', 'relu (modèle)');
      await load();
      base = await fetchRow('Team', who.id);
      r = await save('Team', who.id, base, { ...personDraftFrom(base), aph: '' }, { diff: diffPerson });
      eq(r.kind, 'saved', 'vidage');
      if (r.kind !== 'saved') return note(J(r.error?.message ?? r));
      eq(r.entry.actions[0][3], { aph: type === 'Int' ? null : '' }, 'cellule envoyée (vide)');
      const stored = await rest.row('Team', who.id);
      note(`relu après vidage : /records ${J(stored?.aph)}, SQL ${J(await sqlCell('Team', who.id, 'aph'))}`);
      eq((await fetchRow('Team', who.id)).aph, '', 'relu (modèle) vide');
      // Remise à la valeur d'origine exacte (0 d'une cellule Int jamais remplie), hors writer
      if (J(await sqlCell('Team', who.id, 'aph')) !== J(origSql)) {
        await otherUser([['UpdateRecord', 'Team', who.id, { aph: origSql }]]);
        note(`remis à ${J(origSql)}`);
      }
      eq(await sqlCell('Team', who.id, 'aph'), origSql, 'valeur d’origine rendue');
    },
  );

  await scenario('10c APH : 9999999 jamais posé ni retiré, zéro de tête refusé en Int, rien envoyé', async () => {
    const who = S.isd.find((p) => !isEstimationAph(p.aph));
    await expectRefused(W().update('Team', who.id, { aph: ESTIMATION_APH }), 'aph-estimation', 'poser « 9999999 »');
    await expectRefused(W().update('Team', who.id, { aph: 9999999 }), 'aph-estimation', 'poser le nombre 9999999');
    const holder = [...state.model.people.values()].find((p) => isEstimationAph(p.aph));
    if (holder) {
      await expectRefused(W().update('Team', holder.id, { aph: '' }), 'aph-estimation', `retirer (${holder.id})`);
      await expectRefused(
        W().update('Team', holder.id, { aph: '1234567' }),
        'aph-estimation',
        `changer (${holder.id})`,
      );
    } else note('aucun titulaire de 9999999 dans le document de test');
    if (W().columnType('Team', 'aph') === 'Int')
      await expectRefused(W().update('Team', who.id, { aph: '0123456' }), 'aph-zero', 'zéro de tête (Int)');
    const col = (await rest.columns('Team')).find((c) => c.id === 'aph')?.fields;
    note(`Team.aph après : type ${J(col?.type)}, isFormula ${J(col?.isFormula)}`);
  });

  // 7. Équipe
  const person = {};
  // Team.aph : colonne formule vide de la Feuille, ou colonne de données (Text ou Int) après conversion dans Grist
  const aphData = () => W().can('Team', 'aph').ok;
  await scenario(
    '7a équipe : ajout d’une personne ISD (capacité omise ; aph omis tant que colonne formule)',
    async () => {
      const mgr = S.mgmt[0] ?? P1;
      const draft = {
        nom: `  Essai RÉEL ${STAMP}  `,
        email: ' essai.reel@example.org ',
        aph: '1234567',
        role: 'DE',
        capaciteHebdo: 35,
        n_1: mgr.id,
      };
      const fields = newPersonFields(draft, { model: state.model, canAddField: (c) => W().canAddField('Team', c) });
      ok(!('capaciteHebdo' in fields), `capacité omise : ${J(Object.keys(fields))}`);
      ok(
        'aph' in fields === aphData(),
        `aph ${aphData() ? 'envoyé (colonne de données)' : 'omis'} : ${J(Object.keys(fields))}`,
      );
      eq(fields.Domaine, isdDomainValue(state.model), 'Domaine ISD');
      const r = await runCreate({ writer: W(), table: 'Team', fields });
      eq(r.kind, 'saved', 'résultat');
      if (r.kind !== 'saved') return note(J(r.error?.message ?? r));
      person.id = r.entry.id;
      eq(lastSent().response.retValues?.[0], r.entry.id, 'retValues[0]');
      const stored = await expectStored('Team', r.entry.id, r.entry.actions[0][3]);
      note(`relu : aph ${J(stored?.aph)}, capaciteHebdo ${J(stored?.capaciteHebdo)}, actif ${J(stored?.actif)}`);
    },
  );

  await scenario('7b équipe : aph et capaciteHebdo refusés par le writer, colonnes non converties', async () => {
    const before = Object.fromEntries((await rest.columns('Team')).map((c) => [c.id, c.fields]));
    const aphFormula = !aphData();
    if (aphFormula)
      await expectRefused(W().update('Team', person.id, { aph: '7654321' }), 'colonne-retiree', 'aph (mise à jour)');
    else note('Team.aph colonne de données : refus de l’aph non vérifiés ici (scénario 10)');
    await expectRefused(
      W().update('Team', person.id, { capaciteHebdo: 30 }),
      'colonne-retiree',
      'capacité (mise à jour)',
    );
    if (aphFormula)
      await expectRefused(
        W().add('Team', { nom: 'X', role: 'DE', Domaine: isdDomainValue(state.model), actif: true, aph: '1' }),
        'colonne-retiree',
        'aph (création)',
      );
    const after = Object.fromEntries((await rest.columns('Team')).map((c) => [c.id, c.fields]));
    for (const c of ['aph', 'capaciteHebdo'])
      eq(
        [after[c]?.isFormula, after[c]?.formula, after[c]?.type],
        [before[c]?.isFormula, before[c]?.formula, before[c]?.type],
        `colonne ${c}`,
      );
    if (aphFormula) eq(after.aph?.isFormula, true, 'aph reste une colonne formule');
  });

  await scenario('7c équipe : e-mail, rôle et N+1 modifiés (fiche personne)', async () => {
    await load();
    const base = await fetchRow('Team', person.id);
    const other = S.isd.find((p) => p.id !== base.n_1 && p.id !== person.id);
    const draft = { ...personDraftFrom(base), email: 'essai.reel2@example.org', role: 'DA', n_1: other.id };
    const r = await save('Team', person.id, base, draft, { diff: diffPerson });
    eq(r.kind, 'saved', 'résultat');
    if (r.kind !== 'saved') return note(J(r.error?.message ?? r));
    eq(Object.keys(r.entry.actions[0][3]).sort(), ['email', 'n_1', 'role'], 'colonnes envoyées');
    await expectStored('Team', person.id, r.entry.actions[0][3]);
  });

  await scenario('7d équipe : désactiver puis réactiver', async () => {
    let r = await runSetActive({ writer: W(), personId: person.id, actif: false, fetchRow: rowOf('Team') });
    eq(r.kind, 'saved', 'désactiver');
    await expectStored('Team', person.id, { actif: false });
    await load();
    r = await runSetActive({ writer: W(), personId: person.id, actif: false, fetchRow: rowOf('Team') });
    eq(r.kind, 'nothing', 'déjà inactive : rien');
    r = await runSetActive({ writer: W(), personId: person.id, actif: true, fetchRow: rowOf('Team') });
    eq(r.kind, 'saved', 'réactiver');
    await expectStored('Team', person.id, { actif: true });
  });

  await scenario('7e équipe : indisponibilité ajoutée puis modifiée', async () => {
    await load();
    const fields = newUnavFields(
      {
        dateDebut: today + 7,
        dateFin: today + 11,
        dispo: shareFromPercent(50),
        type: 'Congés',
        commentaire: ' essai ',
      },
      person.id,
    );
    const r = await runCreate({ writer: W(), table: 'Disponibilites', fields });
    eq(r.kind, 'saved', 'ajout');
    if (r.kind !== 'saved') return note(J(r.error?.message ?? r));
    eq(lastSent().response.retValues?.[0], r.entry.id, 'retValues[0]');
    await expectStored('Disponibilites', r.entry.id, r.entry.actions[0][3]);
    await load();
    const base = await fetchRow('Disponibilites', r.entry.id);
    const draft = { ...unavDraftFrom(base), dispo: shareFromPercent(25), dateFin: today + 12 };
    const r2 = await save('Disponibilites', r.entry.id, base, draft, { diff: diffUnav });
    eq(r2.kind, 'saved', 'modification');
    if (r2.kind === 'saved') await expectStored('Disponibilites', r.entry.id, r2.entry.actions[0][3]);
  });

  // 8. Périmètre
  await scenario('8a périmètre : projet relié à l’ISD par son seul responsable Management', async () => {
    let found = mgmtOnlyProject();
    let restore = null;
    if (!found) {
      // Aucun projet de ce type dans la copie : un projet hors périmètre reçoit (dans le document de test seulement,
      // comme le ferait un autre utilisateur dans la Feuille) un responsable Management ISD, rendu à la fin
      const m = state.model;
      const mgr = S.mgmt[0];
      if (!mgr) return note('aucune personne Management ISD : scénario sans objet');
      const q = [...m.projects.values()]
        .sort((a, b) => a.id - b.id)
        .find((p) => {
          if (p.inScope) return false;
          const chs = [...m.chantiers.values()].filter((c) => c.projectIds.includes(p.id));
          const ts = [...m.tasks.values()].filter((t) => t.projectId === p.id && !t.parentId && t.chantierId);
          return chs.length && ts.length && chs.every((c) => c.projectIds.length === 1);
        });
      if (!q) return note('aucun projet hors périmètre utilisable : scénario sans objet');
      const t0 = [...m.tasks.values()].find((t) => t.projectId === q.id && !t.parentId && t.chantierId);
      await expectRefused(W().update('Tasks', t0.id, { Commentaire: 'avant' }), 'perimetre', 'avant le responsable');
      const prev = (await rest.row('Projects', q.id)).responsable;
      restore = [['UpdateRecord', 'Projects', q.id, { responsable: prev }]];
      await otherUser([['UpdateRecord', 'Projects', q.id, { responsable: mgr.id }]]);
      await load();
      found = mgmtOnlyProject();
      note(`projet ${q.id} hors périmètre : responsable Management ISD ${mgr.id} posé pour l’essai (rendu ensuite)`);
      if (!found || found.project.id !== q.id) {
        await otherUser(restore);
        return cur.failures.push('le projet préparé n’est pas reconnu comme relié par son seul responsable Management');
      }
    }
    try {
      await mgmtWrite(found);
    } finally {
      if (restore) await otherUser(restore);
    }
  });

  async function mgmtWrite(found) {
    const t = found.tasks.find((x) => !x.done && lookup.row('Tasks', x.id)) ?? found.tasks[0];
    note(`projet ${found.project.id}, ${found.chantiers.length} chantier(s), ${found.tasks.length} tâche(s)`);
    if (t) {
      const base = await fetchRow('Tasks', t.id);
      const r = await save('Tasks', t.id, base, {
        ...draftFrom(base),
        Commentaire: `${base.Commentaire}${base.Commentaire ? '\n' : ''}essai ${STAMP}`,
      });
      eq(r.kind, 'saved', `tâche ${t.id}`);
      if (r.kind === 'saved') await expectStored('Tasks', t.id, r.entry.actions[0][3]);
      else note(J(r.error?.message ?? r));
    } else if (found.chantiers[0]) {
      const c = found.chantiers[0];
      const base = await fetchRow('Chantiers', c.id);
      const r = await save(
        'Chantiers',
        c.id,
        base,
        { ...chantierDraftFrom(base), Description: `${base.Description} essai` },
        { diff: diffChantier },
      );
      eq(r.kind, 'saved', `chantier ${c.id}`);
    }
  }

  await scenario('8b périmètre : tâche hors périmètre refusée, rien envoyé', async () => {
    const m = state.model;
    const t = [...m.tasks.values()].sort((a, b) => a.id - b.id).find((x) => !taskInScope(m, x) && x.chantierId);
    if (!t) return note('aucune tâche hors périmètre');
    note(`tâche ${t.id}`);
    await expectRefused(W().update('Tasks', t.id, { Commentaire: 'hors périmètre' }), 'perimetre', 'mise à jour');
    const base = await fetchRow('Tasks', t.id);
    const r = await save('Tasks', t.id, base, { ...draftFrom(base), titre: `${base.titre} x` });
    eq(r.kind === 'failed' && r.error?.reason, 'perimetre', 'fiche');
    const ch = m.chantiers.get(t.chantierId);
    await expectRefused(
      W().add('Tasks', { titre: 'hors périmètre', Chantier: ch.id, projet: ch.projectIds[0], statut: 'todo' }),
      'perimetre',
      'création',
    );
  });

  // 9. Erreurs réelles de Grist
  await scenario('9a erreurs de Grist : textes réels et classifyError', async () => {
    const cases = [
      ['colonne inconnue', [['UpdateRecord', 'Tasks', S.A.id, { colonneInexistante: 1 }]]],
      ['ligne absente (UpdateRecord)', [['UpdateRecord', 'Tasks', 99999999, { Commentaire: 'x' }]]],
      [
        'ligne absente (BulkUpdateRecord)',
        [['BulkUpdateRecord', 'Tasks', [S.A.id, 99999999], { Commentaire: ['', 'x'] }]],
      ],
      ['ligne absente (RemoveRecord)', [['RemoveRecord', 'Tasks', 99999999]]],
      ['table inconnue', [['AddRecord', 'TableInexistante', null, { a: 1 }]]],
      ['action inconnue', [['ActionInexistante', 'Tasks', 1, {}]]],
      ['valeur de mauvais type (Date en texte)', [['UpdateRecord', 'Tasks', S.A.id, { dateCloture: 'pas une date' }]]],
      ['Ref vers une ligne absente', [['UpdateRecord', 'Tasks', S.A.id, { Responsable: 99999999 }]]],
    ];
    const before = await rest.row('Tasks', S.A.id);
    for (const [label, actions] of cases) {
      try {
        const res = await otherUser(actions);
        note(`${label} : ACCEPTÉ par Grist, réponse ${J(res)}`);
      } catch (err) {
        note(
          `${label} : HTTP ${err.status} « ${err.message} » → classifyError = ${classifyError(err.message)}, document = ${isDocumentRefusal(err.message)}`,
        );
      }
    }
    const after = await rest.row('Tasks', S.A.id);
    const changed = Object.keys(after).filter((c) => J(after[c]) !== J(before[c]));
    note(
      `cellules de la tâche ${S.A.id} changées par ces envois : ${J(Object.fromEntries(changed.map((c) => [c, after[c]])))}`,
    );
    if (changed.length)
      await otherUser([['UpdateRecord', 'Tasks', S.A.id, Object.fromEntries(changed.map((c) => [c, before[c]]))]]);
  });

  await scenario('9b erreur réelle vue par le writer : ligne supprimée ailleurs après le chargement', async () => {
    const fields = newTaskFields({
      titre: `[Essai réel ${STAMP}] Supprimée ailleurs`,
      Chantier: created.chantier,
      projet: S.inScopeProject.id,
      parentTask: null,
      statut: 'todo',
      type: 'tache',
      dateDebut: null,
      dateEcheance: null,
      assignees: [],
      Responsable: null,
      priorite: '',
      description: '',
    });
    const r = await runCreate({ writer: W(), table: 'Tasks', fields });
    if (r.kind !== 'saved') throw new Error('création impossible');
    await load();
    await otherUser([['RemoveRecord', 'Tasks', r.entry.id]]);
    try {
      await W().update('Tasks', r.entry.id, { Commentaire: 'après suppression' });
      cur.failures.push('écriture acceptée sur une ligne supprimée');
    } catch (err) {
      ok(err instanceof WriteFailed, `WriteFailed attendu : ${err?.name}`);
      note(`WriteFailed kind = ${err.kind}, document = ${err.document}, message « ${err.message} »`);
      eq(err.kind, 'missing', 'kind');
    }
    const base = { ...lookup.row('Tasks', r.entry.id) };
    const r2 = await save('Tasks', r.entry.id, base, { ...draftFrom(base), Commentaire: 'x' });
    eq(r2.kind, 'missing', 'fiche : ligne relue absente');
  });

  await scenario('9c relectures : coût mesuré', async () => {
    const n = rest.stats.reads;
    const ms = rest.stats.readMs;
    const t0 = Date.now();
    await readTable('Tasks');
    const one = Date.now() - t0;
    note(
      `relecture de Tasks (${state.raw.tables.Tasks.id.length} lignes, /columns + /records) : ${one} ms ; moyenne de toutes les lectures de la session : ${Math.round(ms / Math.max(1, n))} ms sur ${n} requêtes`,
    );
  });

  // ---- Observations sur les valeurs rendues par le vrai Grist --------------------------------------------------
  const sample = state.raw.tables.Tasks;
  const kinds = (col) => [
    ...new Set(
      sample[col].map((v) =>
        v === null ? 'null' : Array.isArray(v) ? `liste[${v[0]}${v.length === 1 ? ' seul' : ''}]` : typeof v,
      ),
    ),
  ];
  for (const col of [
    'assignees',
    'dependDe',
    'tags',
    'Responsable',
    'parentTask',
    'dateCloture',
    'progression',
    'charges',
    'priorite',
  ])
    observe(`Tasks.${col} : ${kinds(col).join(', ')}`);
  observe(
    `Team.capaciteHebdo : ${[...new Set(state.raw.tables.Team.capaciteHebdo.map((v) => J(v)))].join(', ')} ; Team.aph : ${[...new Set(state.raw.tables.Team.aph.map((v) => typeof v))].join(', ')}`,
  );
  observe(
    `métadonnées /sql : isFormula ${J([...new Set(state.raw.columns ? Object.values(state.raw.columns).map((c) => c.isFormula) : [])])}`,
  );
  console.log('\nObservations :');
  for (const o of observations) console.log(`  · ${o}`);
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n${okCount} OK, ${results.length - okCount} KO, ${rest.sentCount()} envoi(s) au document de test`);
  writeFileSync(
    process.env.REAL_GRIST_OUT,
    J({
      subjects: { A: S.A.id, D: S.D.id, P: S.P.id, C0: S.C0.id, created, person },
      results,
      observations,
      log: rest.log,
    }),
  );
  process.exitCode = okCount === results.length ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
