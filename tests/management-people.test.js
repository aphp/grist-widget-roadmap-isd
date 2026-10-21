/**
 * Management de l'équipe ISD (Domaine ISD) dans la phase 2 : sélecteurs de personne (fiche, créations, chantier),
 * affichage du rôle (« Mgmt », jamais « hors ISD ») et écritures acceptées par le writer.
 * Fixture : Fanny (6) Management du Domaine ISD, Gus (7) Management BNDMR, Dora (4) hors ISD sans rôle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feuille } from './fixtures/feuille.js';
import { createFakeGrist, lookupOf } from './fixtures/fake-grist.js';
import { buildModel } from '../widget/js/core/model.js';
import { displayRole, isIsdTeamMember } from '../widget/js/core/team-directory.js';
import { diffDraft, draftFrom, personCandidates, taskInScope } from '../widget/js/core/task-form.js';
import { chantierInScope } from '../widget/js/core/chantier-form.js';
import { applyFilters, DEFAULT_FILTERS, DEFAULT_PREFS } from '../widget/js/core/filters.js';
import { tableRows } from '../widget/js/core/table-data.js';
import { EXPECTED_TYPES, WRITABLE, WriteRefused, createWriter } from '../widget/js/core/grist-writer.js';
import { etpToHours, fteHours } from '../widget/js/core/capacity.js';
import { roundHours } from '../widget/js/core/charges-edit.js';
import { personChip, personGroups } from '../widget/js/views/task-form.js';
import { contributeursControl, responsableControl } from '../widget/js/views/chantier-form.js';
import { person, roleBadge } from '../widget/js/views/detail.js';
import { roleSpan } from '../widget/js/ui/kit.js';

const model = () => buildModel(feuille());

/** Groupes d'un menu de personnes : [libellé, [noms]]. */
function groups(htmlText) {
  return [...htmlText.matchAll(/<optgroup label="([^"]+)">(.*?)<\/optgroup>/gs)].map((m) => [
    m[1],
    [...m[2].matchAll(/<option value="\d+"[^>]*>([^<]+)<\/option>/g)].map((o) => o[1]),
  ]);
}

test('rôle affiché : profil ISD, « Management » pour le Management du Domaine ISD, rien sinon', () => {
  const m = model();
  const p = (id) => m.people.get(id);
  assert.equal(displayRole(m, p(1)), 'DE');
  assert.equal(displayRole(m, p(3)), 'DS'); // inactif : le profil reste lisible
  assert.equal(displayRole(m, p(6)), 'Management');
  assert.equal(displayRole(m, p(7)), null); // Management BNDMR
  assert.equal(displayRole(m, p(4)), null);
  assert.equal(displayRole(m, null), null);
  assert.equal(isIsdTeamMember(m, p(6)), true);
  assert.equal(isIsdTeamMember(m, p(7)), false);
  assert.equal(isIsdTeamMember(m, p(4)), false);
  assert.equal(isIsdTeamMember(m, undefined), false);
  // Management inactif du Domaine ISD : toujours affiché comme Management (valeur déjà saisie)
  p(6).actif = false;
  assert.equal(displayRole(m, p(6)), 'Management');
});

test('candidats : le Management ISD est dans l’équipe ISD, une seule fois ; le Management BNDMR dans les autres', () => {
  const { isd, kept } = personCandidates(model());
  assert.ok(isd.includes(6));
  assert.deepEqual(kept, []);
  assert.ok(!isd.includes(7) && !isd.includes(4));
  // Valeur déjà choisie hors ISD : conservée, une seule fois
  assert.deepEqual(personCandidates(model(), [7, 4, 7, 6]).kept, [7, 4]);
});

test('sélecteurs de la fiche, des créations et du chantier : groupe « ISD — Management » via pickerGroups', () => {
  const m = model();
  const out = personGroups(m, []).toString();
  assert.deepEqual(groups(out), [
    ['ISD — PO', ['Bob PO']],
    ['ISD — DA', ['Eve DA']],
    ['ISD — DE', ['Alice DE']],
    ['ISD — Management', ['Fanny Manager']],
  ]);
  assert.doesNotMatch(out, /Autres personnes|Dora|Gus/);
  assert.equal(out.match(/Fanny Manager/g).length, 1);
  // Exclusion des personnes déjà choisies (assignés, contributeurs) : le groupe vide disparaît
  assert.ok(!personGroups(m, [], [6]).toString().includes('ISD — Management'));
  // Sélection du Responsable
  assert.match(personGroups(m, [6]).toString(), /<option value="6" selected>Fanny Manager<\/option>/);
  // Chantier (fiche et « Nouveau chantier ») : Responsable et Contributeurs
  const st = {
    prefix: 'cf',
    draft: { Responsable: 6, Contributeurs: [6] },
    can: () => ({ ok: true }),
    busy: false,
    validation: { errors: {}, warnings: [] },
  };
  const resp = responsableControl(st, m).toString();
  assert.match(resp, /<optgroup label="ISD — Management"><option value="6" selected>Fanny Manager/);
  const contrib = contributeursControl(st, m).toString();
  assert.match(contrib, /class="tf-chip__text">Fanny Manager<span class="dt-person__role" title="Management">/);
  assert.ok(!groups(contrib).some(([g]) => g === 'ISD — Management')); // déjà contributrice
});

test('valeur hors ISD ou inactive déjà posée : gardée dans les selects, jamais proposée à l\u2019ajout', () => {
  const m = model();
  const kept = personGroups(m, [4]).toString();
  assert.match(kept, /<option value="4" selected>Dora \(hors ISD\) \(hors ISD\)<\/option>/);
  assert.match(personGroups(m, [3]).toString(), /<option value="3" selected>Carl DS \(inactif\)<\/option>/); // ISD inactif
  assert.match(personGroups(m, [7]).toString(), /Gus BNDMR \(hors ISD\)/);
  // Ajout (aucune valeur courante) : pas de personne hors ISD ni inactive
  assert.doesNotMatch(personGroups(m, []).toString(), /Dora|Gus|Carl|hors ISD|inactif/);
  // Déjà assignée : exclue de la liste d'ajout, donc pas d'option du tout
  assert.doesNotMatch(personGroups(m, [], [4, 7]).toString(), /Dora|Gus/);
  // Responsable de la fiche chantier
  const st = {
    prefix: 'cf',
    draft: { Responsable: 7, Contributeurs: [7, 4] },
    can: () => ({ ok: true }),
    busy: false,
    validation: { errors: {}, warnings: [] },
  };
  assert.match(responsableControl(st, m).toString(), /<option value="7" selected>Gus BNDMR \(hors ISD\)<\/option>/);
  const contrib = contributeursControl(st, m).toString();
  assert.match(contrib, /Gus BNDMR/);
  assert.match(contrib, /Dora/); // pastilles conservées
  assert.doesNotMatch(contrib, /<option value="(4|7)"/);
});

test('enregistrer un autre champ ne touche ni les assignés ni le Responsable hors ISD', () => {
  const m = model();
  const t = m.tasks.get(1002);
  const base = { titre: t.title, assignees: [4, 7, 1], Responsable: 4, charges: '[{"teamId":4,"heures":7}]' };
  const draft = draftFrom(base);
  draft.titre = 'Nouveau titre';
  assert.deepEqual(diffDraft(base, draft), { titre: 'Nouveau titre' });
  // Le select du Responsable rend sa valeur courante : la relire dans le brouillon ne change rien
  assert.match(personGroups(m, [draft.Responsable]).toString(), /value="4" selected/);
});

test('affichage : badge « Mgmt » (libellé complet « Management »), jamais « hors ISD » pour le Management ISD', () => {
  const m = model();
  const badge = roleBadge(m, m.people.get(6), true).toString();
  assert.equal(
    badge,
    '<span class="dt-person__role" title="Management"><span aria-hidden="true">Mgmt</span><span class="fr-sr-only">Management</span></span>',
  );
  assert.doesNotMatch(badge, /hors ISD/);
  assert.match(roleBadge(m, m.people.get(7), true).toString(), /\(hors ISD\)/);
  assert.match(roleBadge(m, m.people.get(4), true).toString(), /\(hors ISD\)/);
  assert.equal(roleBadge(m, m.people.get(7)).toString(), ''); // sans outside : ni badge ni mention
  assert.equal(roleBadge(m, m.people.get(1), true).toString(), '<span class="dt-person__role">DE</span>');
  assert.equal(roleSpan('x', 'PO').toString(), '<span class="x">PO</span>');
  // Fiche (lecture) et pastilles des formulaires
  assert.match(person(m, 6).toString(), /Fanny Manager<span class="dt-person__role" title="Management">/);
  assert.match(personChip(m, 6, false, 'data-x').toString(), /Mgmt/);
  assert.doesNotMatch(personChip(m, 7, false, 'data-x').toString(), /dt-person__role|hors ISD/);
});

test('Tableau : le Management ISD porte le rôle « Management » dans les personnes de la ligne', () => {
  const m = model();
  m.tasks.get(1002).assignees.push(6, 7);
  const rows = tableRows(m, applyFilters(m, { ...DEFAULT_FILTERS }, { ...DEFAULT_PREFS }));
  const persons = rows.find((r) => r.taskId === 1002).persons;
  assert.equal(persons.find((p) => p.nom === 'Fanny Manager').role, 'Management');
  assert.equal(persons.find((p) => p.nom === 'Gus BNDMR').role, null);
});

// ---- Writer : Team ref (Responsable, assignees, Contributeurs, teamId des charges) ----

const META = Object.fromEntries(Object.entries(EXPECTED_TYPES).map(([k, type]) => [k, { type, isFormula: false }]));

function tables() {
  const t = feuille().tables;
  for (const [name, ops] of Object.entries(WRITABLE))
    for (const c of new Set([...ops.update, ...ops.add])) t[name][c] ??= t[name].id.map(() => null);
  return t;
}

/** Writer branché sur un faux Grist, avec la règle de périmètre de main.js (projets du périmètre ISD). */
function setup() {
  const g = createFakeGrist(tables());
  const m = buildModel(feuille());
  const inScope = (p) => m.projects.get(p)?.inScope === true;
  const writer = createWriter({
    docApi: g.docApi,
    mode: 'on',
    columns: META,
    lookup: lookupOf(g),
    readTable: async (t) => structuredClone(g.data[t]),
    canWriteRow: (table, id) =>
      table === 'Chantiers'
        ? Boolean(m.chantiers.has(id) && chantierInScope(m, m.chantiers.get(id)))
        : Boolean(m.tasks.has(id) && taskInScope(m, m.tasks.get(id))),
    canWriteValues: (table, v) =>
      table === 'Chantiers'
        ? (v.Projets ?? []).some(inScope)
        : inScope(v.projet) || (m.chantiers.get(v.Chantier)?.projectIds ?? []).some(inScope),
  });
  return { g, writer };
}

const reason = async (p) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof WriteRefused) return e.reason;
    throw e;
  }
  return null;
};

/** 0,5 ETP du vendredi 4 au mardi 8 octobre 2024 (3 jours ouvrés, capacité standard), à 0,5 h près. */
const HALF = roundHours(etpToHours(0.5, fteHours(20000, 20004)));

test('writer : Management ISD assigné, chargé, Responsable et contributeur, accepté', async () => {
  const { g, writer } = setup();
  await writer.update('Tasks', 1000, {
    assignees: [6],
    Responsable: 6,
    dateDebut: 20000,
    dateEcheance: 20004,
    charges: `[{"teamId":6,"heures":${HALF}}]`,
  });
  await writer.update('Chantiers', 100, { Responsable: 6, Contributeurs: [6] });
  await writer.add('Tasks', { titre: 'Nouvelle', Chantier: 100, projet: 10, assignees: [6], Responsable: 6 });
  await writer.add('Chantiers', { Nom_du_chantier: 'C', Projets: [10], Responsable: 6, Contributeurs: [6] });
  assert.equal(g.batches.length, 4);
  const [task] = g.batches[0];
  assert.deepEqual(task, [
    'UpdateRecord',
    'Tasks',
    1000,
    {
      assignees: ['L', 6],
      Responsable: 6,
      dateDebut: 20000 * 86400,
      dateEcheance: 20004 * 86400,
      charges: `[{"teamId":6,"heures":${HALF}}]`,
    },
  ]);
  assert.deepEqual(g.batches[1][0][3], { Responsable: 6, Contributeurs: ['L', 6] });
});

test('writer : règle existante, toute personne de Team est acceptée (Management BNDMR compris) ; inconnue refusée', async () => {
  // Le writer ne contrôle que l'existence de la personne dans Team (integrityProblem, charges) : le périmètre ISD
  // porte sur les tâches et chantiers (canWriteRow, canWriteValues), pas sur les personnes. Règle conservée.
  const { g, writer } = setup();
  await writer.update('Tasks', 1000, { assignees: [7], dateDebut: 20000, dateEcheance: 20004 });
  await writer.update('Tasks', 1000, { charges: `[{"teamId":7,"heures":${HALF}}]` });
  await writer.update('Chantiers', 100, { Responsable: 7, Contributeurs: [7] });
  assert.equal(g.batches.length, 3);
  assert.equal(await reason(writer.update('Tasks', 1000, { assignees: [99] })), 'reference');
  assert.equal(await reason(writer.update('Chantiers', 100, { Contributeurs: [99] })), 'reference');
  assert.equal(await reason(writer.update('Tasks', 1000, { charges: '[{"teamId":99,"heures":1}]' })), 'charges');
  // Périmètre inchangé : une tâche hors périmètre ISD reste refusée, même pour y assigner le Management ISD
  assert.equal(await reason(writer.update('Tasks', 4001, { assignees: [6] })), 'perimetre');
  assert.equal(g.batches.length, 3);
});
