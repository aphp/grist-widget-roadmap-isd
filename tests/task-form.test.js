import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feuille } from './fixtures/feuille.js';
import { buildModel } from '../widget/js/core/model.js';
import { decodeRow } from '../widget/js/core/grist-writer.js';
import {
  FORM_FIELDS,
  chantierOf,
  dependCycle,
  descendants,
  diffDraft,
  draftFrom,
  editAvailability,
  hasErrors,
  parentCandidates,
  rebaseDraft,
  parentCycle,
  personCandidates,
  searchTasks,
  setMilestone,
  statusChanges,
  taskInScope,
  validateTask,
} from '../widget/js/core/task-form.js';
import { detectConflicts, resolveConflicts } from '../widget/js/core/conflicts.js';
import { dayOfIso } from '../widget/js/core/dates.js';

const raw = feuille();
const model = buildModel(raw);
const base = (id) => decodeRow(raw.tables.Tasks, 'Tasks', id);
const ctx = (taskId) => ({ model, taskId, statuses: model.statuses.tasks, priorities: ['3'] });
const ON = { mode: 'on', canEdit: true, reason: 'ok' };

test('brouillon : copie indépendante, différences limitées aux champs modifiés', () => {
  const b = base(1002);
  const d = draftFrom(b);
  assert.deepEqual(Object.keys(d), [...FORM_FIELDS]);
  d.assignees.push(5);
  assert.deepEqual(b.assignees, [1]);
  d.titre = 'réalisation v2';
  assert.deepEqual(diffDraft(b, d), { titre: 'réalisation v2', assignees: [1, 5] });
  assert.deepEqual(diffDraft(b, draftFrom(b)), {});
});

test('statut rapide : done remplit la date de clôture vide ; réouverture la conserve', () => {
  const today = dayOfIso('2026-10-19');
  assert.deepEqual(statusChanges({ statut: 'todo', dateCloture: null }, 'done', today), {
    statut: 'done',
    dateCloture: today,
  });
  assert.deepEqual(statusChanges({ statut: 'todo', dateCloture: 5 }, 'done', today), { statut: 'done' });
  assert.deepEqual(statusChanges({ statut: 'done', dateCloture: 5 }, 'todo', today), { statut: 'todo' });
  assert.deepEqual(statusChanges({ statut: 'todo', dateCloture: null }, 'todo', today), {});
});

test('jalon : une seule date ; décoché, le type d’origine revient', () => {
  const d = { type: 'tache', dateDebut: 10, dateEcheance: 20 };
  assert.deepEqual(setMilestone(d, true, 'tache'), { type: 'jalon', dateDebut: 20, dateEcheance: 20 });
  assert.deepEqual(setMilestone({ ...d, dateEcheance: null }, true, '').dateDebut, 10);
  assert.equal(setMilestone(d, false, 'jalon').type, 'tache');
  assert.equal(setMilestone(d, false, 'reunion').type, 'reunion');
  assert.equal(setMilestone(d, false, '').type, '');
  assert.equal(setMilestone(d, false, undefined).type, '');
});

test('validation bloquante : titre, dates, lien, avancement, références disparues', () => {
  const d = draftFrom(base(1002));
  assert.ok(!hasErrors(validateTask(d, ctx(1002))));
  const bad = {
    ...d,
    titre: '  ',
    dateDebut: 30,
    dateEcheance: 10,
    Lien_utile: 'javascript:alert(1)',
    progression: 140,
    Responsable: 999,
    assignees: [1, 998],
    dependDe: [7777],
    parentTask: 8888,
  };
  const v = validateTask(bad, ctx(1002));
  assert.deepEqual(Object.keys(v.errors).sort(), [
    'Lien_utile',
    'Responsable',
    'assignees',
    'dateEcheance',
    'dependDe',
    'parentTask',
    'progression',
    'titre',
  ]);
  assert.equal(v.errors.titre.key, 'form.error.titleEmpty');
  assert.equal(validateTask({ ...d, titre: 'x'.repeat(301) }, ctx(1002)).errors.titre.key, 'form.error.titleLong');
  assert.ok(!validateTask({ ...d, Lien_utile: 'https://exemple.fr/a' }, ctx(1002)).errors.Lien_utile);
  assert.ok(validateTask({ ...d, progression: Number.NaN }, ctx(1002)).errors.progression);
});

test('cycles de parenté et de dépendance refusés', () => {
  assert.ok(parentCycle(model, 1000, 1001));
  assert.ok(parentCycle(model, 1000, 1000));
  assert.ok(!parentCycle(model, 1002, 1000));
  assert.ok(!parentCycle(model, 1002, null));
  const d = draftFrom(base(1000));
  assert.equal(validateTask({ ...d, parentTask: 1002 }, ctx(1000)).errors.parentTask.key, 'form.error.parentCycle');
  // 1002 dépend de 1000 dans ce modèle modifié : 1000 → 1002 ferait une boucle
  const m = buildModel(raw);
  m.tasks.get(1002).dependDe = [1000];
  assert.ok(dependCycle(m, 1000, [1002]));
  assert.ok(dependCycle(m, 1000, [1000]));
  assert.ok(!dependCycle(m, 1001, [1002, 1000]));
  assert.equal(
    validateTask({ ...d, dependDe: [1002] }, { ...ctx(1000), model: m }).errors.dependDe.key,
    'form.error.dependCycle',
  );
});

test('avertissements : hors des dates du parent, charges sans dates, done sans clôture, rouverte, choix non déclaré', () => {
  const d = { ...draftFrom(base(1002)), priorite: '3' };
  const keys = (x) => validateTask(x, ctx(1002)).warnings.map((w) => w.key);
  assert.deepEqual(keys(d), []);
  // Le parent 1000 n'a pas de dates : rien à signaler ; on donne des dates au parent dans une copie
  const m = buildModel(raw);
  Object.assign(m.tasks.get(1000), { start: dayOfIso('2026-10-01'), end: dayOfIso('2026-10-31') });
  const w = validateTask(d, { ...ctx(1002), model: m }).warnings.map((x) => x.key);
  assert.deepEqual(w, ['form.warn.outsideParent']);
  assert.deepEqual(keys({ ...d, dateDebut: null }), ['form.warn.chargesNoDates']);
  // Un samedi et un dimanche : aucun jour ouvré, l'ETP n'est pas calculable non plus
  assert.deepEqual(keys({ ...d, dateDebut: dayOfIso('2026-11-07'), dateEcheance: dayOfIso('2026-11-08') }), [
    'form.warn.chargesNoWorkdays',
  ]);
  assert.deepEqual(keys({ ...d, statut: 'done', dateCloture: null }), ['form.warn.doneNoClosure']);
  assert.deepEqual(keys({ ...d, dateCloture: 3 }), ['form.warn.reopened']);
  assert.deepEqual(keys({ ...d, statut: 'Inventé' }), ['form.warn.choice']);
  assert.deepEqual(keys({ ...d, priorite: '1' }), ['form.warn.choice']);
  assert.deepEqual(validateTask({ ...d, priorite: '1' }, { model, taskId: 1002 }).warnings, []);
});

test('candidats parents : même chantier, sans la tâche ni ses sous-tâches', () => {
  assert.deepEqual([...descendants(model, 1000)].sort(), [1001, 1002]);
  assert.deepEqual(parentCandidates(model, 1000), []);
  assert.deepEqual(parentCandidates(model, 1001), [1000, 1002]);
  // Sans chantier : même projet
  assert.deepEqual(parentCandidates(model, 1500), []);
  assert.deepEqual(parentCandidates(model, 2001), []);
  assert.deepEqual(parentCandidates(model, 4242), []);
  assert.equal(chantierOf(model, model.tasks.get(1001)), 100);
});

test('recherche de tâches : 2 lettres, sans accents, même chantier d’abord, exclusions', () => {
  assert.deepEqual(searchTasks(model, 1001, 'r'), []);
  const hits = searchTasks(model, 1001, 'REALIS');
  assert.deepEqual(hits, [1002]);
  assert.deepEqual(searchTasks(model, 1001, 'tâche', [2001]).includes(2001), false);
  const all = searchTasks(model, 1001, 'ta', [], 50);
  assert.ok(!all.includes(1001));
  assert.equal(searchTasks(model, 9999, 'rapport')[0], 3000);
});

test('personnes : seulement l\u2019équipe ISD active ; une valeur déjà choisie hors de ces groupes est conservée', () => {
  const { isd, kept } = personCandidates(model, [3, 4]);
  assert.ok(isd.includes(1) && isd.includes(2) && !isd.includes(3) && !isd.includes(4));
  assert.deepEqual(kept, [3, 4]);
  assert.deepEqual(personCandidates(model).kept, []);
});

test('droit de modifier : tâches et chantiers du périmètre ISD seulement ; projets en lecture', () => {
  assert.ok(taskInScope(model, model.tasks.get(1001)));
  assert.ok(!taskInScope(model, model.tasks.get(4001)));
  assert.deepEqual(editAvailability(model, { table: 'Tasks', id: 1001 }, ON), { editable: true, reason: 'ok' });
  assert.equal(editAvailability(model, { table: 'Tasks', id: 4001 }, ON).reason, 'scope');
  assert.equal(editAvailability(model, { table: 'Projects', id: 10 }, ON).reason, 'projet');
  assert.deepEqual(editAvailability(model, { table: 'Chantiers', id: 100 }, ON), { editable: true, reason: 'ok' });
  assert.equal(editAvailability(model, { table: 'Chantiers', id: 400 }, ON).reason, 'scope');
  assert.equal(editAvailability(model, { table: 'Chantiers', id: 999 }, ON).reason, 'autre');
  // Lot 2d : personnes de l'équipe ISD (profil ISD ou Domaine ISD, inactives comprises) ; les autres en lecture
  assert.deepEqual(editAvailability(model, { table: 'Team', id: 1 }, ON), { editable: true, reason: 'ok' });
  assert.equal(editAvailability(model, { table: 'Team', id: 3 }, ON).reason, 'ok');
  assert.equal(editAvailability(model, { table: 'Team', id: 4 }, ON).reason, 'scope');
  assert.equal(editAvailability(model, { table: 'Team', id: 999 }, ON).reason, 'autre');
  assert.equal(editAvailability(model, { table: 'Tasks', id: 4242 }, ON).reason, 'autre');
  const off = { mode: 'off', canEdit: false, reason: 'doc' };
  assert.equal(editAvailability(model, { table: 'Tasks', id: 1001 }, off).reason, 'doc');
  const viewer = { mode: 'on', canEdit: false, reason: 'viewer' };
  assert.equal(editAvailability(model, { table: 'Tasks', id: 1001 }, viewer).reason, 'viewer');
});

test('conflits : seulement les cellules saisies et modifiées ailleurs avec une autre valeur', () => {
  const b = { titre: 'A', statut: 'todo', assignees: [1] };
  const fresh = { titre: 'B', statut: 'review', assignees: [1] };
  assert.deepEqual(detectConflicts(b, fresh, { titre: 'C', assignees: [1, 2] }), ['titre']);
  assert.deepEqual(detectConflicts(b, fresh, { titre: 'B' }), []);
  assert.deepEqual(detectConflicts(b, fresh, { assignees: [2] }), []);
  assert.equal(detectConflicts(b, null, { titre: 'C' }), null);
  const r = resolveConflicts({ titre: 'C', assignees: [2] }, fresh, { titre: 'theirs' });
  assert.deepEqual(r, { changes: { assignees: [2] }, before: { assignees: [1] } });
  assert.deepEqual(resolveConflicts({ titre: 'C' }, fresh, { titre: 'mine' }).before, { titre: 'B' });
});

test('titre et lien nettoyés de leurs espaces seulement s’ils ont été modifiés (N2)', () => {
  const b = { ...draftFrom(base(1002)), titre: ' ancien ', Lien_utile: '' };
  assert.deepEqual(diffDraft(b, { ...b }), {});
  assert.deepEqual(diffDraft(b, { ...b, titre: '  nouveau  ', Lien_utile: ' https://a.fr ' }), {
    titre: 'nouveau',
    Lien_utile: 'https://a.fr',
  });
  assert.deepEqual(diffDraft({ ...b, titre: 'x' }, { ...b, titre: ' x ' }), {});
});

test('rebaseDraft : les champs saisis restent, les autres suivent la ligne relue', () => {
  const old = { ...draftFrom(base(1002)) };
  const draft = { ...old, titre: 'Mien', assignees: [1, 5] };
  const fresh = { ...old, titre: 'Leur', Commentaire: 'nouveau', assignees: [9] };
  const r = rebaseDraft(old, draft, fresh);
  assert.equal(r.titre, 'Mien');
  assert.deepEqual(r.assignees, [1, 5]);
  assert.equal(r.Commentaire, 'nouveau');
  assert.notEqual(r.dependDe, fresh.dependDe);
});

test('charges : avertissements doublon, personne absente de l’équipe, charges sans dates', () => {
  const keys = (x) => validateTask(x, ctx(2010)).warnings.map((w) => w.key);
  const d = draftFrom(base(2010));
  assert.ok(keys(d).includes('form.warn.chargesUnknown'));
  const dup = { ...d, charges: '[{"teamId":5,"heures":1},{"teamId":5,"heures":2}]' };
  assert.deepEqual(keys(dup), ['form.warn.chargesDuplicate']);
  assert.deepEqual(keys({ ...dup, dateDebut: null }), ['form.warn.chargesNoDates', 'form.warn.chargesDuplicate']);
  // Charges à 0 h sans dates : rien à calculer, pas d'avertissement
  assert.deepEqual(keys({ ...d, charges: '[{"teamId":5,"heures":0}]', dateDebut: null }), []);
  // Contenu illisible : pas d'erreur bloquante (la section l'explique)
  assert.deepEqual(validateTask({ ...d, charges: 'oops' }, ctx(2010)).errors, {});
});

test('dates ajoutées ou changées : avertit des seules charges laissées telles quelles au-dessus de la borne', () => {
  const d = { ...draftFrom(base(2010)), dateDebut: dayOfIso('2026-10-01'), dateEcheance: dayOfIso('2026-10-14') };
  const week = { ...d, dateEcheance: dayOfIso('2026-10-07') };
  const charged = (x) => ({ ...x, charges: '[{"teamId":5,"heures":60}]' });
  const keys = (x, b, keptOver) => validateTask(x, { ...ctx(2010), base: b, keptOver }).warnings.map((w) => w.key);
  // Recalculées (keptOver vide ou absent) : pas d'avertissement, la ligne montre l'écart d'heures
  assert.ok(!keys(charged(week), d).includes('form.warn.chargesOverDates'));
  assert.ok(!keys(charged(week), d, new Set()).includes('form.warn.chargesOverDates'));
  // Laissées telles quelles (au-dessus de la borne sur la nouvelle période) : avertissement
  assert.ok(keys(charged(week), d, new Set([5])).includes('form.warn.chargesOverDates'));
  const none = { ...week, dateDebut: null, dateEcheance: null };
  assert.ok(keys(charged(week), none, new Set([5])).includes('form.warn.chargesOverDates'));
  // Dates inchangées ou sans période de référence : pas d'avertissement de ce type
  assert.ok(!keys(charged(week), week, new Set([5])).includes('form.warn.chargesOverDates'));
  assert.ok(!keys(charged(week), undefined, new Set([5])).includes('form.warn.chargesOverDates'));
  // Personne retirée depuis : plus comptée
  assert.ok(!keys({ ...week, charges: '[]' }, d, new Set([5])).includes('form.warn.chargesOverDates'));
});

test('avertissement de dates : seulement les charges laissées telles quelles', () => {
  const D = dayOfIso('2026-10-01');
  const draftWith = (x) => ({ ...draftFrom(base(2010)), ...x });
  const v = validateTask(draftWith({ dateDebut: D, dateEcheance: D + 6, charges: '[{"teamId":1,"heures":70}]' }), {
    model,
    taskId: 2010,
    base: { dateDebut: D, dateEcheance: D + 13 },
    keptOver: new Set([1]),
  });
  assert.deepEqual(v.warnings.find((w) => w.key === 'form.warn.chargesOverDates').vars, { n: 1 });
  const ok = validateTask(draftWith({ dateDebut: D, dateEcheance: D + 6, charges: '[{"teamId":1,"heures":35}]' }), {
    model,
    taskId: 2010,
    base: { dateDebut: D, dateEcheance: D + 13 },
    keptOver: new Set(),
  });
  assert.equal(
    ok.warnings.some((w) => w.key === 'form.warn.chargesOverDates'),
    false,
  );
});

test('fiche : date de planification au-delà de la borne = erreur, sauf valeur déjà là', () => {
  const MAX = dayOfIso('2027-12-31');
  const draftWith = (x) => ({ ...draftFrom(base(2010)), ...x });
  const v = (x, ctx = {}) => validateTask(draftWith(x), { model, taskId: 2010, maxDay: MAX, ...ctx });
  const e = v({ dateDebut: MAX - 5, dateEcheance: MAX + 1 }).errors.dateEcheance;
  assert.equal(e.key, 'form.error.dateMax');
  assert.equal(e.vars.date, '31 déc. 2027');
  assert.equal(v({ dateDebut: MAX + 1, dateEcheance: MAX + 2 }).errors.dateDebut.key, 'form.error.dateMax');
  assert.equal(v({ dateDebut: MAX - 5, dateEcheance: MAX }).errors.dateEcheance, undefined);
  // L'ordre garde la priorité
  assert.equal(v({ dateDebut: MAX + 5, dateEcheance: MAX + 1 }).errors.dateEcheance.key, 'form.error.endBeforeStart');
  // Valeur d'une ligne ancienne laissée telle quelle : pas d'erreur
  const old = { dateDebut: MAX + 3, dateEcheance: MAX + 9 };
  assert.deepEqual(v(old, { base: old }).errors, {});
  assert.equal(validateTask(draftWith(old), { model, taskId: 2010 }).errors.dateEcheance, undefined);
});

test('recalcul des charges refusé : avertissement explicite', () => {
  const d = draftFrom(base(2010));
  const keys = (notRescaled) => validateTask(d, { ...ctx(2010), notRescaled }).warnings.map((w) => w.key);
  assert.ok(keys(true).includes('form.warn.chargesNotRescaled'));
  assert.ok(!keys(false).includes('form.warn.chargesNotRescaled'));
});
