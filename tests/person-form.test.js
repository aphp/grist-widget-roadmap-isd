/**
 * Logique des personnes (lot 2d) : périmètre ISD, rôles proposés (choix existants seulement), brouillon,
 * différences, validation, création, N+1, indisponibilités.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { feuille } from './fixtures/feuille.js';
import {
  ADD_ROLES,
  diffPerson,
  diffUnav,
  isdDomainValue,
  n1Candidates,
  newPersonDraft,
  newPersonFields,
  newUnavFields,
  personDraftFrom,
  personInScope,
  personUnavailabilities,
  rebasePerson,
  rebaseUnav,
  roleOptions,
  shareFromPercent,
  teamValuesInScope,
  unavDraftFrom,
  validatePerson,
  validateUnav,
} from '../widget/js/core/person-form.js';
import { n1Control } from '../widget/js/views/person-form.js';

const ISD = 'Ingénierie et sciences des données - ISD';
const raw = feuille();
raw.choices['Team.Domaine'] = ['BNDMR', ISD];
const m = buildModel(raw);

test('Domaine ISD : lu des personnes, sinon du choix de Team.Domaine qui contient « ISD »', () => {
  assert.equal(isdDomainValue(m), ISD);
  const r = feuille();
  r.tables.Team.Domaine = r.tables.Team.Domaine.map((d) => (d === ISD ? 'Autre' : d));
  r.choices['Team.Domaine'] = ['BNDMR', ISD];
  assert.equal(isdDomainValue(buildModel(r)), ISD);
  r.choices['Team.Domaine'] = [];
  assert.notEqual(isdDomainValue(buildModel(r)), ISD);
});

test('périmètre : profil ISD ou Domaine ISD, inactifs compris ; valeurs d’arrivée ISD', () => {
  const p = (id) => personInScope(m, m.people.get(id));
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(p), [true, true, true, false, true, true, false]);
  assert.equal(personInScope(m, undefined), false);
  assert.ok(teamValuesInScope(m, { role: 'DE', Domaine: '' }));
  assert.ok(teamValuesInScope(m, { role: 'Management', Domaine: ISD }));
  assert.ok(!teamValuesInScope(m, { role: 'Management', Domaine: 'BNDMR' }));
  // Création : Domaine ISD ET rôle ISD ou Management
  assert.ok(teamValuesInScope(m, { role: 'Management', Domaine: ISD }, { add: true }));
  assert.ok(!teamValuesInScope(m, { role: 'DE', Domaine: 'BNDMR' }, { add: true }));
  assert.ok(!teamValuesInScope(m, { role: '', Domaine: ISD }, { add: true }));
});

test('rôles proposés : choix existants de Team.role seulement, ordre de l’onglet ; valeur actuelle gardée', () => {
  assert.deepEqual(roleOptions(m), ['DE', 'DA', 'DS', 'PO Data', 'Management']);
  assert.deepEqual(roleOptions(m, '', { add: true }), ['DE', 'DA', 'DS', 'PO Data', 'Management']);
  assert.deepEqual(ADD_ROLES, ['DE', 'DA', 'DS', 'PO Data', 'Management']);
  assert.deepEqual(roleOptions(m, 'Ancien'), ['DE', 'DA', 'DS', 'PO Data', 'Management', 'Ancien']);
  const r = feuille();
  r.choices['Team.role'] = ['DE', 'Stagiaire'];
  const m2 = buildModel(r);
  assert.deepEqual(roleOptions(m2), ['DE', 'Stagiaire']);
  assert.deepEqual(roleOptions(m2, '', { add: true }), ['DE']);
});

test('brouillon et différences : capacité 0 = vide, nom et e-mail nettoyés, seules les colonnes modifiées', () => {
  const base = { nom: 'Alice DE', email: 'alice@exemple.fr', role: 'DE', capaciteHebdo: 0, n_1: 2, actif: true };
  const d = personDraftFrom(base);
  assert.deepEqual(d, { nom: 'Alice DE', email: 'alice@exemple.fr', role: 'DE', capaciteHebdo: null, n_1: 2 });
  assert.deepEqual(diffPerson(base, d), {});
  assert.deepEqual(diffPerson(base, { ...d, nom: ' Alice DE ' }), {});
  assert.deepEqual(diffPerson(base, { ...d, nom: 'Alice', capaciteHebdo: 28, n_1: null, email: ' a@b.fr ' }), {
    nom: 'Alice',
    capaciteHebdo: 28,
    n_1: null,
    email: 'a@b.fr',
  });
  assert.deepEqual(diffPerson({ ...base, capaciteHebdo: 28 }, { ...d, capaciteHebdo: 28 }), {});
  // Nom de la Feuille avec une espace de bord, non touché : jamais réécrit
  const spaced = { ...base, nom: 'Alice DE ' };
  assert.deepEqual(diffPerson(spaced, { ...personDraftFrom(spaced), capaciteHebdo: 30 }), { capaciteHebdo: 30 });
  assert.deepEqual(diffPerson(spaced, { ...personDraftFrom(spaced), nom: 'Alice DE' }), { nom: 'Alice DE' });
  // Rebase : les champs non touchés suivent la ligne relue, la saisie reste
  const draft = { ...d, capaciteHebdo: 30 };
  const next = rebasePerson(base, draft, { ...base, email: 'autre@exemple.fr', capaciteHebdo: 20 });
  assert.equal(next.email, 'autre@exemple.fr');
  assert.equal(next.capaciteHebdo, 30);
});

test('validation : nom obligatoire, e-mail, rôle parmi les choix, périmètre, capacité, N+1', () => {
  const ok = { nom: 'Alice', email: '', role: 'DE', capaciteHebdo: null, n_1: null };
  const v = (draft, ctx = {}) => validatePerson({ ...ok, ...draft }, { model: m, personId: 1, domaine: ISD, ...ctx });
  assert.deepEqual(v({}).errors, {});
  assert.equal(v({ nom: ' ' }).errors.nom.key, 'person.error.nameEmpty');
  assert.equal(v({ nom: 'x'.repeat(301) }).errors.nom.key, 'form.error.titleLong');
  assert.equal(v({ email: 'pas-une-adresse' }).errors.email.key, 'person.error.email');
  assert.equal(v({ role: 'Inventé' }).errors.role.key, 'person.error.role');
  // Eve DA sans Domaine : Management la ferait sortir de l'équipe ISD
  assert.equal(v({ role: 'Management' }, { personId: 5, domaine: '' }).errors.role.key, 'person.error.scope');
  assert.equal(v({ capaciteHebdo: 0 }).errors.capaciteHebdo.key, 'person.error.capacity');
  assert.equal(v({ capaciteHebdo: 60.5 }).errors.capaciteHebdo.key, 'person.error.capacity');
  assert.equal(v({ capaciteHebdo: 17.3 }).errors.capaciteHebdo.key, 'person.error.capacity');
  assert.equal(v({ capaciteHebdo: 60 }).errors.capaciteHebdo, undefined);
  assert.equal(v({ n_1: 1 }).errors.n_1.key, 'person.error.n1Self');
  assert.equal(v({ n_1: 999 }).errors.n_1.key, 'form.error.missingRef');
  // Avertissements : e-mail déjà porté par une autre personne
  assert.equal(v({ email: 'ALICE@exemple.fr' }, { personId: 6 }).warnings[0].key, 'person.warn.emailDuplicate');
  assert.deepEqual(v({ email: 'alice@exemple.fr' }).warnings, []);
});

test('création : rôle obligatoire (ISD ou Management), nom en double signalé, valeurs envoyées', () => {
  const d = newPersonDraft();
  const v = (draft) => validatePerson({ ...d, ...draft }, { model: m });
  assert.equal(v({ nom: 'Nina' }).errors.role.key, 'person.error.roleRequired');
  assert.deepEqual(v({ nom: 'Nina', role: 'Management' }).errors, {});
  assert.equal(v({ nom: 'alice de', role: 'DE' }).warnings[0].key, 'person.warn.nameDuplicate');
  const r = feuille();
  r.choices['Team.role'] = ['DE', 'Stagiaire'];
  assert.equal(
    validatePerson({ ...d, nom: 'N', role: 'Stagiaire' }, { model: buildModel(r) }).errors.role.key,
    'person.error.role',
  );
  assert.deepEqual(newPersonFields({ ...d, nom: ' Nina ', role: 'DS' }, { model: m }), {
    nom: 'Nina',
    role: 'DS',
    Domaine: ISD,
    actif: true,
  });
  assert.deepEqual(
    newPersonFields({ nom: 'Nina', role: 'DS', email: ' n@exemple.fr ', capaciteHebdo: 28, n_1: 6 }, { model: m }),
    { nom: 'Nina', role: 'DS', Domaine: ISD, actif: true, email: 'n@exemple.fr', capaciteHebdo: 28, n_1: 6 },
  );
  // Colonne non remplissable (capacité en formule dans la Feuille) : non envoyée
  assert.ok(
    !(
      'capaciteHebdo' in
      newPersonFields(
        { nom: 'N', role: 'DS', capaciteHebdo: 28 },
        { model: m, canAddField: (c) => c !== 'capaciteHebdo' },
      )
    ),
  );
});

test('candidats N+1 : Management de tous les Domaines d’abord, puis équipe ISD par profil, personne exclue', () => {
  const c = n1Candidates(m, 1, null);
  // Management actif de l'ISD (6) et d'un autre Domaine (7), par nom
  assert.deepEqual(
    c.management.map((p) => p.id),
    [6, 7],
  );
  // Équipe ISD (pickerGroups) sans son Management, déjà en tête ; Alice (1) exclue, Carl (3) inactif absent
  assert.deepEqual(
    c.isd.map((g) => [g.role, g.people.map((p) => p.id)]),
    [
      ['PO', [2]],
      ['DA', [5]],
    ],
  );
  assert.equal(c.kept, null);
  // Personne hors ISD sans rôle Management : jamais proposée
  assert.ok(![...c.management, ...c.isd.flatMap((g) => g.people)].some((p) => p.id === 4));
  // Un manager n'est pas proposé comme son propre N+1
  assert.deepEqual(
    n1Candidates(m, 6).management.map((p) => p.id),
    [7],
  );
});

test('candidats N+1 : la valeur actuelle hors des groupes reste affichée', () => {
  assert.deepEqual(n1Candidates(m, 1, 3).kept, { id: 3, person: m.people.get(3), inactive: true });
  assert.deepEqual(n1Candidates(m, 1, 4).kept, { id: 4, person: m.people.get(4), inactive: false });
  assert.deepEqual(n1Candidates(m, 1, 999).kept, { id: 999, person: null, inactive: false });
  // Valeur déjà proposée, ou la personne elle-même : rien de plus
  assert.equal(n1Candidates(m, 1, 7).kept, null);
  assert.equal(n1Candidates(m, 1, 5).kept, null);
  assert.equal(n1Candidates(m, 1, 1).kept, null);
});

test('N+1 Management d’un autre Domaine : accepté par la validation du formulaire', () => {
  const draft = { ...personDraftFrom({ nom: 'Alice DE', role: 'DE' }), n_1: 7 };
  assert.deepEqual(validatePerson(draft, { model: m, personId: 1, domaine: ISD }).errors, {});
  assert.deepEqual(diffPerson({ nom: 'Alice DE', role: 'DE', n_1: 2 }, draft), { n_1: 7 });
});

test('indisponibilités : brouillon (pourcentage ancien ramené à 0-1), différences, validation, création', () => {
  const t = raw.tables.Disponibilites;
  assert.deepEqual(personUnavailabilities(t, 1), [1]);
  assert.deepEqual(personUnavailabilities(undefined, 1), []);
  const base = { dateDebut: 10, dateFin: 12, type: 'Formation', dispo: 50, commentaire: '' };
  const d = unavDraftFrom(base);
  assert.equal(d.dispo, 0.5);
  assert.deepEqual(diffUnav(base, d), {});
  assert.deepEqual(diffUnav(base, { ...d, type: ' Congés ', dispo: 0 }), { type: 'Congés', dispo: 0 });
  assert.deepEqual(unavDraftFrom(null), { dateDebut: null, dateFin: null, type: '', dispo: 0, commentaire: '' });
  const next = rebaseUnav(base, { ...d, dispo: 0.2 }, { ...base, commentaire: 'relu' });
  assert.equal(next.commentaire, 'relu');
  assert.equal(next.dispo, 0.2);
  assert.equal(shareFromPercent(50), 0.5);
  assert.equal(shareFromPercent(12.5), 0.125);
  assert.equal(shareFromPercent(120), null);
  assert.equal(shareFromPercent(null), null);
  const v = (x) => validateUnav({ ...d, ...x }).errors;
  assert.deepEqual(v({}), {});
  assert.equal(v({ dateDebut: null }).dateDebut.key, 'unav.error.required');
  assert.equal(v({ dateFin: null }).dateFin.key, 'unav.error.required');
  assert.equal(v({ dateFin: 9 }).dateFin.key, 'form.error.finBeforeDebut');
  assert.equal(v({ dispo: null }).dispo.key, 'unav.error.dispo');
  assert.equal(v({ type: 'x'.repeat(301) }).type.key, 'form.error.titleLong');
  assert.deepEqual(newUnavFields({ ...d, type: ' ', commentaire: ' ok ' }, 1), {
    membre: 1,
    dateDebut: 10,
    dateFin: 12,
    dispo: 0.5,
    commentaire: 'ok',
  });
});

test('menu N+1 : Management en tête, puis équipe ISD par profil ; valeur actuelle hors liste gardée', () => {
  const out = (n_1) =>
    n1Control({ prefix: 'tf', draft: { n_1 }, can: () => ({ ok: true }), validation: { errors: {} } }, m, 1).toString();
  const groups = (s) => [...s.matchAll(/<optgroup label="([^"]+)"/g)].map((x) => x[1]);
  const s = out(7);
  assert.deepEqual(groups(s), ['Management (tous Domaines)', 'ISD — PO', 'ISD — DA']);
  assert.match(s, /<option value="7" selected>Gus BNDMR<\/option>/);
  assert.ok(s.indexOf('Fanny Manager') < s.indexOf('Bob PO'));
  assert.doesNotMatch(s, /Dora/);
  assert.match(out(4), /<option value="4" selected>Dora \(hors ISD\) \(hors liste\)<\/option>/);
  assert.match(out(3), /<option value="3" selected>Carl DS \(inactif\)<\/option>/);
  assert.match(out(999), /<option value="999" selected>n° 999 \(hors liste\)<\/option>/);
  assert.match(out(null), /<option value="" selected>Aucun<\/option>/);
});
