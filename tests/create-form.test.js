import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feuille } from './fixtures/feuille.js';
import { buildModel } from '../widget/js/core/model.js';
import {
  chantierDemandeurs,
  chantierDraftFrom,
  chantierInScope,
  chantierSpan,
  chantierStatusChanges,
  chantierTaskIds,
  diffChantier,
  rebaseChantier,
  reattachPlan,
  validateChantier,
} from '../widget/js/core/chantier-form.js';
import {
  chantierOptions,
  creePar,
  movePlan,
  newChantierDraft,
  newChantierFields,
  newTaskDraft,
  newTaskFields,
  parseTarget,
  prefillFromFilters,
  projectOptions,
  setNewMilestone,
  targetValue,
  validateNewChantier,
  validateNewTask,
} from '../widget/js/core/create-form.js';

const model = buildModel(feuille());
const base = {
  Nom_du_chantier: 'Chantier partagé',
  Projets: [20, 30],
  Statut: '',
  Debut: null,
  Fin: null,
  Responsable: null,
  Contributeurs: [],
  Description: '',
  Objectifs_resultats_attendus: '',
  Criteres_de_succes: '',
};

test('fiche chantier : brouillon copié, différences (nom nettoyé), rebase, statut rapide', () => {
  const d = chantierDraftFrom(base);
  assert.notEqual(d.Projets, base.Projets);
  assert.deepEqual(diffChantier(base, d), {});
  d.Nom_du_chantier = '  Chantier partagé  ';
  assert.deepEqual(diffChantier(base, d), {});
  d.Nom_du_chantier = ' Nouveau nom ';
  d.Projets = [20];
  assert.deepEqual(diffChantier(base, d), { Nom_du_chantier: 'Nouveau nom', Projets: [20] });
  const fresh = { ...base, Statut: 'Planifié', Projets: [30] };
  const r = rebaseChantier(base, d, fresh);
  assert.equal(r.Statut, 'Planifié');
  assert.deepEqual(r.Projets, [20]);
  assert.deepEqual(chantierStatusChanges(base, ''), {});
  assert.deepEqual(chantierStatusChanges(base, 'Terminé'), { Statut: 'Terminé' });
});

test('chantier : périmètre, demandeurs lus des projets (Q12), étendue déduite, tâches du chantier', () => {
  assert.ok(chantierInScope(model, model.chantiers.get(200)));
  assert.ok(!chantierInScope(model, model.chantiers.get(400)));
  assert.ok(!chantierInScope(model, null));
  assert.deepEqual(chantierDemandeurs(model, [20, 30, 999]), [{ projet: 'ChatDPI', demandeur: 'DIM' }]);
  assert.deepEqual(chantierSpan(model, 201), { start: model.tasks.get(2010).start, end: model.tasks.get(2010).end });
  assert.equal(chantierSpan(model, 999), null);
  assert.deepEqual(chantierTaskIds(model, 100), [1000, 1001, 1002]);
});

test('validateChantier : nom, au moins un projet du périmètre, dates, références ; avertissements', () => {
  const v = (d, ctx = {}) => validateChantier({ ...base, ...d }, { model, chantierId: 201, ...ctx });
  assert.deepEqual(v({}).errors, {});
  assert.equal(v({ Nom_du_chantier: ' ' }).errors.Nom_du_chantier.key, 'form.error.nameEmpty');
  assert.equal(v({ Nom_du_chantier: 'x'.repeat(301) }).errors.Nom_du_chantier.key, 'form.error.titleLong');
  assert.equal(v({ Projets: [] }).errors.Projets.key, 'form.error.noProject');
  assert.equal(v({ Projets: [999] }).errors.Projets.key, 'form.error.missingRef');
  assert.equal(v({ Projets: [40] }).errors.Projets.key, 'form.error.projectScope');
  assert.equal(v({ Debut: 10, Fin: 9 }).errors.Fin.key, 'form.error.finBeforeDebut');
  assert.equal(v({ Responsable: 99 }).errors.Responsable.key, 'form.error.missingRef');
  assert.equal(v({ Contributeurs: [1, 99] }).errors.Contributeurs.key, 'form.error.missingRef');
  const w = v({ Statut: 'Inventé', Projets: [30] }, { statuses: ['À cadrer'] }).warnings.map((x) => x.key);
  assert.ok(w.includes('form.warn.choice'));
  assert.ok(w.includes('form.warn.reattachOne'));
  // Nom déjà pris par un autre chantier d'un même projet
  const dup = validateChantier({ ...base, Nom_du_chantier: 'reporting', Projets: [30] }, { model });
  assert.ok(dup.warnings.some((x) => x.key === 'form.warn.duplicateChantier'));
});

test('reattachPlan : tâches dont le projet est retiré du chantier, rattachées au projet choisi', () => {
  assert.deepEqual(reattachPlan(model, 201, [20, 30], null).taskIds, []);
  const p = reattachPlan(model, 201, [30], 30);
  assert.deepEqual(p.taskIds, [2010]);
  assert.deepEqual(p.also, [{ table: 'Tasks', id: 2010, changes: { projet: 30 }, before: { projet: 20 } }]);
  // Projet d'arrivée hors du brouillon : le premier restant
  assert.equal(reattachPlan(model, 201, [30], 10).target, 30);
  assert.deepEqual(reattachPlan(model, 201, [], null).also, []);
});

test('Cree_par : partie locale de l’e-mail de « Je suis… » (Q11), sinon rien', () => {
  assert.equal(creePar(model, 1), 'alice');
  assert.equal(creePar(model, 2), null); // « pas-une-adresse »
  assert.equal(creePar(model, 99), null);
  assert.equal(creePar(model, null), null);
});

test('options de rattachement : chantiers sous chaque projet ISD ; valeurs « chantier:projet »', () => {
  const opts = chantierOptions(model);
  assert.ok(opts.every((g) => model.projects.get(g.project.id).inScope));
  assert.ok(!opts.some((g) => g.project.id === 40));
  const shared = opts.filter((g) => g.chantiers.some((c) => c.id === 201)).map((g) => g.project.id);
  assert.deepEqual(shared.sort(), [20, 30]);
  assert.ok(projectOptions(model).every((p) => p.id !== 40));
  assert.equal(targetValue(201, 30), '201:30');
  assert.equal(targetValue(null, 30), '');
  assert.deepEqual(parseTarget('201:30'), { chantierId: 201, projectId: 30 });
  assert.deepEqual(parseTarget('x'), { chantierId: null, projectId: null });
});

test('préremplissage depuis les filtres : chantier, projet, statut unique, « Je suis… »', () => {
  const ck = [...model.nodes.values()].find(
    (n) => n.kind === 'chantier' && n.ref?.id === 201 && n.projectId === 30,
  ).key;
  assert.deepEqual(prefillFromFilters(model, { chantier: ck, statuses: ['inprogress'] }, { me: 1 }), {
    chantierId: 201,
    projectId: 30,
    status: 'inprogress',
    me: 1,
  });
  assert.deepEqual(prefillFromFilters(model, { projet: 'P20', statuses: [] }, {}), {
    chantierId: null,
    projectId: 20,
    status: null,
    me: null,
  });
  // Chantier virtuel « (sans chantier) » : seulement son projet
  assert.equal(prefillFromFilters(model, { chantier: 'P20/C0' }).chantierId, null);
  assert.deepEqual(prefillFromFilters(model), { chantierId: null, projectId: null, status: null, me: null });
});

test('nouvelle tâche : valeurs par défaut du contexte ; sous-tâche copiée du parent', () => {
  const d = newTaskDraft(model, { chantierId: 201, projectId: 30, status: 'review', me: 1 });
  assert.equal(d.Chantier, 201);
  assert.equal(d.projet, 30);
  assert.equal(d.statut, 'review');
  assert.deepEqual(d.assignees, [1]);
  assert.equal(d.type, 'tache');
  // Projet absent du chantier : le premier projet ISD du chantier ; statut inconnu : todo
  const d2 = newTaskDraft(model, { chantierId: 201, projectId: 10, status: 'inventé', me: 99 });
  assert.equal(d2.projet, 20);
  assert.equal(d2.statut, 'todo');
  assert.deepEqual(d2.assignees, []);
  const none = newTaskDraft(model, { chantierId: 999 });
  assert.equal(none.Chantier, null);
  assert.equal(none.projet, null);
  const sub = newTaskDraft(model, { parentId: 1002, chantierId: 200, me: 2 });
  assert.equal(sub.parentTask, 1002);
  assert.equal(sub.Chantier, 100);
  assert.equal(sub.projet, 10);
  assert.equal(sub.dateDebut, model.tasks.get(1002).start);
  assert.equal(sub.dateEcheance, model.tasks.get(1002).end);
  const j = setNewMilestone({ ...sub, dateEcheance: null }, true);
  assert.equal(j.type, 'jalon');
  assert.equal(j.dateEcheance, sub.dateDebut);
  assert.equal(setNewMilestone(j, false).type, 'tache');
  assert.equal(newTaskDraft({ ...model, statuses: { tasks: ['A faire'] } }, {}).statut, 'A faire');
});

test('validateNewTask : titre, chantier, projet du chantier, périmètre, parent, dates, références', () => {
  const ok = newTaskDraft(model, { chantierId: 100, me: 1 });
  const v = (d) => validateNewTask({ ...ok, titre: 'Tâche', ...d }, { model, statuses: model.statuses.tasks });
  assert.deepEqual(v({}).errors, {});
  assert.equal(v({ titre: '' }).errors.titre.key, 'form.error.titleEmpty');
  assert.equal(v({ titre: 'x'.repeat(301) }).errors.titre.key, 'form.error.titleLong');
  assert.equal(v({ Chantier: null }).errors.cible.key, 'form.error.chantierRequired');
  assert.equal(v({ Chantier: 999 }).errors.cible.key, 'form.error.missingRef');
  assert.equal(v({ projet: 20 }).errors.cible.key, 'form.error.projetChantier');
  assert.equal(v({ Chantier: 400, projet: 40 }).errors.cible.key, 'form.error.scope');
  assert.equal(v({ parentTask: 9999 }).errors.parentTask.key, 'form.error.missingRef');
  assert.equal(v({ parentTask: 2000 }).errors.parentTask.key, 'form.error.parentChantier');
  assert.equal(v({ dateDebut: 10, dateEcheance: 9 }).errors.dateEcheance.key, 'form.error.endBeforeStart');
  assert.equal(v({ Responsable: 99 }).errors.Responsable.key, 'form.error.missingRef');
  assert.equal(v({ assignees: [99] }).errors.assignees.key, 'form.error.missingRef');
  const w = (d) => v(d).warnings.map((x) => x.key);
  assert.ok(w({ titre: 'ajout table fhir adresse' }).includes('form.warn.duplicateTitle'));
  assert.ok(w({ statut: 'Inventé' }).includes('form.warn.choice'));
  const sub = newTaskDraft(model, { parentId: 1002 });
  assert.ok(
    validateNewTask({ ...sub, titre: 'S', dateEcheance: sub.dateEcheance + 5 }, { model }).warnings.some(
      (x) => x.key === 'form.warn.outsideParent',
    ),
  );
});

test('newTaskFields : valeurs renseignées seulement, Cree_par, colonnes non permises omises', () => {
  const d = { ...newTaskDraft(model, { parentId: 1002, me: 1 }), titre: '  Sous-tâche  ', description: ' ' };
  assert.deepEqual(newTaskFields(d, { creePar: 'alice' }), {
    titre: 'Sous-tâche',
    Chantier: 100,
    projet: 10,
    statut: 'todo',
    type: 'tache',
    parentTask: 1002,
    dateDebut: d.dateDebut,
    dateEcheance: d.dateEcheance,
    assignees: [1],
    Cree_par: 'alice',
  });
  const full = { ...d, Responsable: 2, priorite: '2', description: 'Texte', dateDebut: null, dateEcheance: null };
  const f = newTaskFields(full, { canAddField: (c) => c !== 'priorite' });
  assert.equal(f.Responsable, 2);
  assert.equal(f.description, 'Texte');
  assert.ok(!('priorite' in f) && !('dateDebut' in f) && !('Cree_par' in f));
});

test('nouveau chantier : projet du contexte (ISD), « À cadrer », responsable « Je suis… » ; validation ; valeurs', () => {
  const d = newChantierDraft(model, { projectId: 20, me: 1 });
  assert.deepEqual(d.Projets, [20]);
  assert.equal(d.Statut, 'À cadrer');
  assert.equal(d.Responsable, 1);
  assert.deepEqual(newChantierDraft(model, { projectId: 40 }).Projets, []);
  assert.equal(newChantierDraft({ ...model, statuses: { chantiers: ['Planifié'] } }).Statut, 'Planifié');
  assert.equal(newChantierDraft({ ...model, statuses: { chantiers: [] } }).Statut, 'À cadrer');
  assert.equal(validateNewChantier(d, { model }).errors.Nom_du_chantier.key, 'form.error.nameEmpty');
  const named = { ...d, Nom_du_chantier: ' Nouveau ', Description: 'D', Contributeurs: [2] };
  assert.deepEqual(validateNewChantier(named, { model }).errors, {});
  assert.deepEqual(newChantierFields(named), {
    Nom_du_chantier: 'Nouveau',
    Projets: [20],
    Statut: 'À cadrer',
    Responsable: 1,
    Contributeurs: [2],
    Description: 'D',
  });
  const dated = newChantierFields(
    { ...named, Debut: 3, Fin: 4, Statut: '' },
    { canAddField: (c) => c !== 'Description' },
  );
  assert.equal(dated.Debut, 3);
  assert.equal(dated.Fin, 4);
  assert.ok(!('Statut' in dated) && !('Description' in dated));
});

test('changement de chantier : la tâche et toutes ses sous-tâches ; refus d’une sous-tâche seule', () => {
  const p = movePlan(model, 1000, 200, 20);
  assert.deepEqual(p.changes, { Chantier: 200, projet: 20 });
  assert.deepEqual(p.before, { Chantier: 100, projet: 10 });
  assert.deepEqual(
    p.also.map((x) => x.id),
    [1001, 1002],
  );
  assert.deepEqual(p.also[0].before, { Chantier: 100, projet: 10 });
  assert.equal(p.count, 2);
  assert.equal(movePlan(model, 4242, 200, 20).error, 'missing');
  assert.equal(movePlan(model, 1001, 200, 20).error, 'subtask');
  assert.equal(movePlan(model, 1000, 999, 20).error, 'chantier');
  assert.equal(movePlan(model, 1000, 200, 10).error, 'projet');
  assert.equal(movePlan(model, 1000, 400, 40).error, 'scope');
  assert.equal(movePlan(model, 1000, 100, 10).error, 'same');
  assert.equal(movePlan(model, 2010, 201, 30).count, 0);
});
