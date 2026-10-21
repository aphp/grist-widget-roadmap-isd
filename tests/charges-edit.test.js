import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  etpDecimals,
  roundEtp,
  ChargesError,
  addPerson,
  chargeRows,
  chargesSummary,
  chargesWriteProblem,
  encodeCharges,
  entryHours,
  entryTeamId,
  etpOf,
  hoursDelta,
  hoursFromInput,
  inputValue,
  maxHours,
  mergeCharges,
  mergeDuplicates,
  periodDayCount,
  periodFte,
  periodState,
  readChargesCell,
  removePerson,
  roundHours,
  sameCharges,
  setPersonHours,
  withPeopleFrom,
} from '../widget/js/core/charges-edit.js';
import { parseCharges } from '../widget/js/core/charges.js';
import { fteHours } from '../widget/js/core/capacity.js';
import { mergeChargesChange, resolveConflicts } from '../widget/js/core/conflicts.js';
import { diffDraft, rebaseCharges, rebaseDraft } from '../widget/js/core/task-form.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
const reason = (fn) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ChargesError) return e.reason;
    throw e;
  }
  return null;
};

test('lecture : cellule vide, [], JSON illisible, objet au lieu d’un tableau', () => {
  for (const v of ['', null, undefined])
    assert.deepEqual(readChargesCell(v), { ok: true, empty: true, entries: [], texts: [] });
  assert.deepEqual(readChargesCell('[]'), { ok: true, empty: false, entries: [], texts: [] });
  assert.deepEqual(readChargesCell(' [ ] '), { ok: true, empty: false, entries: [], texts: [] });
  assert.deepEqual(readChargesCell('oops'), { ok: false, error: 'json', raw: 'oops' });
  assert.deepEqual(readChargesCell('{"teamId":1,"heures":7}'), {
    ok: false,
    error: 'format',
    raw: '{"teamId":1,"heures":7}',
  });
  // Illisible : toute modification est refusée (l'édition des charges est bloquée)
  for (const raw of ['oops', '{"teamId":1}']) {
    assert.equal(
      reason(() => setPersonHours(raw, 1, 7)),
      'illisible',
    );
    assert.equal(
      reason(() => removePerson(raw, 1)),
      'illisible',
    );
  }
});

test('entrées : teamId et heures lus comme charges.js', () => {
  assert.equal(entryTeamId({ teamId: 4 }), 4);
  assert.equal(entryTeamId({ teamId: '12' }), 12);
  for (const v of [0, -1, 1.5, '0', 'a', null]) assert.equal(entryTeamId({ teamId: v }), null);
  assert.equal(entryTeamId(null), null);
  assert.equal(entryHours({ heures: '7' }), 7);
  for (const v of [-1, Infinity, '', 'x', null]) assert.equal(entryHours({ heures: v }), null);
});

test('ordre, clés inconnues et entrées invalides conservés à la mise à jour', () => {
  const raw = '[{"teamId":40,"heures":10,"note":"x"},"bizarre",{"teamId":"oops"},{"teamId":42,"heures":5}]';
  const out = setPersonHours(raw, 42, 7);
  assert.equal(out, '[{"teamId":40,"heures":10,"note":"x"},"bizarre",{"teamId":"oops"},{"teamId":42,"heures":7}]');
  // Mise à jour à sa place, autres clés gardées, dans le même ordre
  assert.equal(
    setPersonHours(raw, 40, 12),
    '[{"teamId":40,"heures":12,"note":"x"},"bizarre",{"teamId":"oops"},{"teamId":42,"heures":5}]',
  );
  // teamId et heures lus en chaîne repassent en nombres à la modification
  assert.equal(setPersonHours('[{"teamId":"5","heures":"3"}]', 5, 4), '[{"teamId":5,"heures":4}]');
  const { rows, invalid } = chargeRows(JSON.parse(raw));
  assert.deepEqual(
    rows.map((r) => r.teamId),
    [40, 42],
  );
  assert.deepEqual(
    invalid.map((i) => i.index),
    [1, 2],
  );
});

test('ajout en fin de liste, retrait, ajout sans effet si la personne est déjà là', () => {
  assert.equal(addPerson('', 7), '[{"teamId":7,"heures":0}]');
  assert.equal(addPerson('[]', 7, 14), '[{"teamId":7,"heures":14}]');
  const raw = '[{"teamId":40,"heures":10},{"bad":1}]';
  assert.equal(addPerson(raw, 9, 3), '[{"teamId":40,"heures":10},{"bad":1},{"teamId":9,"heures":3}]');
  assert.equal(addPerson(raw, 40, 3), raw);
  assert.equal(removePerson(raw, 40), '[{"bad":1}]');
  assert.equal(removePerson(raw, 99), raw);
  assert.equal(
    reason(() => setPersonHours(raw, 0, 3)),
    'personne',
  );
  assert.equal(
    reason(() => setPersonHours(raw, 9, -1)),
    'heures',
  );
  assert.equal(
    reason(() => setPersonHours(raw, 9, NaN)),
    'heures',
  );
});

test('doublons : signalés, modification refusée, fusion seulement sur demande', () => {
  const raw = '[{"teamId":5,"heures":3,"src":"a"},{"teamId":8,"heures":1},{"teamId":5,"heures":4.5}]';
  const { rows } = chargeRows(JSON.parse(raw));
  assert.deepEqual(rows[0], { teamId: 5, heures: 7.5, count: 2 });
  assert.equal(
    reason(() => setPersonHours(raw, 5, 2)),
    'doublon',
  );
  assert.equal(mergeDuplicates(raw, 5), '[{"teamId":5,"heures":7.5,"src":"a"},{"teamId":8,"heures":1}]');
  assert.equal(mergeDuplicates(raw, 8), raw);
  // Retirer une personne en double retire toutes ses entrées
  assert.equal(removePerson(raw, 5), '[{"teamId":8,"heures":1}]');
});

test('entrée à 0 h conservée', () => {
  const raw = '[{"teamId":40,"heures":0},{"teamId":123,"heures":0}]';
  assert.equal(setPersonHours(raw, 123, 5), '[{"teamId":40,"heures":0},{"teamId":123,"heures":5}]');
  assert.equal(setPersonHours(raw, 40, 0), raw);
  assert.equal(chargeRows(JSON.parse(raw)).rows.length, 2);
});

test('conversions (fte : heures de 1 ETP sur la période) : 70 h pour 1 ETP de 70 h = 1 ETP ; arrondi à 0,5 h', () => {
  near(etpOf(70, 70), 1);
  assert.deepEqual(hoursFromInput('0,3', 'etp', 50), { heures: 15 });
  assert.deepEqual(hoursFromInput('1', 'etp', 70), { heures: 70 });
  assert.deepEqual(hoursFromInput('70', 'heures', null), { heures: 70 });
  // 0,3 ETP de 45 h = 13,5 h ; 0,1 ETP de 15 h = 1,5 h ; 7,2 h → 7 h
  assert.deepEqual(hoursFromInput('0,3', 'etp', 45), { heures: 13.5 });
  assert.deepEqual(hoursFromInput('0,1', 'etp', 15), { heures: 1.5 });
  assert.deepEqual(hoursFromInput('7,2', 'heures', 25), { heures: 7 });
  assert.equal(roundHours(0.24), 0);
  assert.equal(roundHours(0.25), 0.5);
  assert.deepEqual(hoursFromInput('', 'heures', 25), { error: 'vide' });
  assert.deepEqual(hoursFromInput('abc', 'etp', 25), { error: 'nombre' });
  assert.deepEqual(hoursFromInput('-1', 'heures', 25), { error: 'negatif' });
});

test('sans dates ou sans jour ouvré : ETP indisponible, saisie en heures possible', () => {
  assert.equal(periodFte(null, 10), null);
  assert.equal(periodFte(10, null), null);
  assert.equal(periodFte(10, 9), null);
  // Jours 9 et 10 = samedi 10 et dimanche 11 janvier 1970 : aucun jour ouvré
  assert.equal(periodFte(9, 10), null);
  assert.equal(periodFte(9, 11) > 0, true);
  assert.equal(periodFte(10, 23), fteHours(10, 23));
  assert.deepEqual(
    [periodState(null, 10), periodState(10, 9), periodState(9, 10), periodState(9, 11)],
    ['none', 'order', 'noWorkday', 'ok'],
  );
  assert.deepEqual([periodDayCount(9, 10), periodDayCount(10, 9), periodDayCount(null, 3)], [2, null, null]);
  assert.deepEqual(hoursFromInput('1', 'etp', null), { error: 'dates' });
  assert.deepEqual(hoursFromInput('12', 'heures', null), { heures: 12 });
  assert.equal(etpOf(10, null), null);
  const model = { people: new Map() };
  assert.deepEqual(chargesSummary(model, [{ teamId: 1, heures: 12 }], null, null), {
    hours: 12,
    fte: null,
    days: null,
    byRole: null,
  });
  // Un week-end : jours affichés, mais ni heures de 1 ETP ni ETP
  assert.deepEqual(chargesSummary(model, [{ teamId: 1, heures: 12 }], 9, 10), {
    hours: 12,
    fte: null,
    days: 2,
    byRole: null,
  });
});

test('pied : total, ETP par profil (calcul de taskEtpByRole), période', () => {
  const model = {
    people: new Map([
      [1, { id: 1, isd: true, role: 'DE' }],
      [2, { id: 2, isd: true, role: 'DS' }],
      [3, { id: 3, isd: false, role: '' }],
    ]),
  };
  const s = chargesSummary(
    model,
    [
      { teamId: 1, heures: 70 },
      { teamId: 2, heures: 35 },
      { teamId: 3, heures: 7 },
    ],
    100,
    113,
  );
  // 1 ETP = capacité standard du 11 au 24 avril 1970 (fteHours)
  const f = fteHours(100, 113);
  assert.equal(s.hours, 112);
  assert.equal(s.days, 14);
  assert.equal(s.fte, f);
  near(s.byRole.DE, 70 / f);
  near(s.byRole.DS, 35 / f);
  near(s.byRole.Autre, 7 / f);
  near(s.byRole.total, 112 / f);
});

test('hoursDelta : heures de la référence → heures du brouillon (ETP conservé)', () => {
  assert.deepEqual(hoursDelta({ etp: 1, heures: 70, fte: 70 }, 140), { from: 70, to: 140 });
  assert.equal(hoursDelta({ etp: 1, heures: 70, fte: 70 }, 70), null);
});

test('pas d’écriture si inchangé : comparaison sur les valeurs, cellule vide ≠ réécrite en []', () => {
  assert.ok(sameCharges('', '[]'));
  assert.ok(sameCharges(null, '[]'));
  assert.ok(sameCharges('[{"teamId": 40, "heures": 10}]', '[{"heures":10,"teamId":40}]'));
  assert.ok(!sameCharges('[{"teamId":40,"heures":10}]', '[{"teamId":40,"heures":10.5}]'));
  assert.ok(sameCharges('oops', 'oops'));
  assert.ok(!sameCharges('oops', '[]'));
  const base = { charges: '' };
  assert.deepEqual(diffDraft(base, { charges: removePerson(addPerson('', 4), 4) }), {});
  const spaced = { charges: '[{"teamId": 40, "heures": 10}]' };
  // Ajout puis retrait : la cellule n'est pas réécrite dans un autre format
  assert.deepEqual(diffDraft(spaced, { charges: removePerson(addPerson(spaced.charges, 9), 9) }), {});
  assert.deepEqual(diffDraft(spaced, { charges: setPersonHours(spaced.charges, 40, 12) }), {
    charges: '[{"teamId":40,"heures":12}]',
  });
});

test('aller-retour : parseCharges(encode(x)) redonne les charges', () => {
  const raw = setPersonHours(setPersonHours('[{"teamId":"3","heures":2},{"x":1}]', 7, 14.5), 3, 2);
  assert.equal(encodeCharges(JSON.parse(raw)), raw);
  assert.deepEqual(parseCharges(raw).charges, [
    { personId: 3, heures: 2 },
    { personId: 7, heures: 14.5 },
  ]);
});

test('fusion à trois voies : modifications des autres sur d’autres entrées conservées', () => {
  const base = '[{"teamId":1,"heures":10},{"teamId":2,"heures":5},{"bad":true}]';
  // Moi : Alice à 20 h, ajout de 3 ; eux : Bob à 8 h, ajout de 4
  const mine = setPersonHours(setPersonHours(base, 1, 20), 3, 7);
  const theirs = '[{"teamId":1,"heures":10},{"teamId":2,"heures":8},{"bad":true},{"teamId":4,"heures":1}]';
  const m = mergeCharges(base, mine, theirs);
  assert.deepEqual(m.conflicts, []);
  assert.equal(
    m.raw,
    '[{"teamId":1,"heures":20},{"teamId":2,"heures":8},{"bad":true},{"teamId":4,"heures":1},{"teamId":3,"heures":7}]',
  );
  // Retrait chez moi, modification ailleurs d'une autre personne
  assert.equal(
    mergeCharges(base, removePerson(base, 2), theirs.replace('"heures":10', '"heures":12')).raw,
    '[{"teamId":1,"heures":12},{"bad":true},{"teamId":4,"heures":1}]',
  );
  // Rien changé d'un côté : l'autre version
  assert.equal(mergeCharges(base, base, theirs).raw, theirs);
  assert.equal(mergeCharges(base, mine, base).raw, mine);
  // Même personne modifiée des deux côtés, différemment : conflit ; la version fusionnée garde la mienne
  const c = mergeCharges(base, setPersonHours(base, 2, 6), theirs);
  assert.deepEqual(c.conflicts, [2]);
  assert.match(c.raw, /"teamId":2,"heures":6/);
  assert.match(c.raw, /"teamId":4/);
  // Même changement des deux côtés : pas de conflit
  assert.deepEqual(mergeCharges(base, setPersonHours(base, 2, 8), theirs).conflicts, []);
  // Une version illisible : pas de fusion possible
  assert.deepEqual(mergeCharges(base, mine, 'oops'), { ok: false });
});

test('mergeChargesChange et resolveConflicts : lot fusionné, conflit, « Garder la mienne »', () => {
  const base = { charges: '[{"teamId":1,"heures":10},{"teamId":2,"heures":5}]', titre: 'a' };
  const mine = { charges: setPersonHours(base.charges, 1, 20), titre: 'b' };
  // Feuille inchangée : rien à fusionner
  assert.deepEqual(mergeChargesChange(base, base, mine), { changes: mine, conflict: false, mine: null });
  // Autre entrée modifiée ailleurs : fusionnée
  const fresh = { ...base, charges: '[{"teamId":1,"heures":10},{"teamId":2,"heures":9}]' };
  const r = mergeChargesChange(base, fresh, mine);
  assert.equal(r.conflict, false);
  assert.equal(r.changes.charges, '[{"teamId":1,"heures":20},{"teamId":2,"heures":9}]');
  // Même changement déjà fait ailleurs : la colonne n'est plus envoyée
  const same = { ...base, charges: mine.charges };
  assert.deepEqual(mergeChargesChange(base, same, mine).changes, { titre: 'b' });
  // Même personne : conflit, valeur « mienne » fusionnée
  const clash = { ...base, charges: '[{"teamId":1,"heures":30},{"teamId":2,"heures":9}]' };
  const k = mergeChargesChange(base, clash, mine);
  assert.equal(k.conflict, true);
  assert.equal(k.mine, '[{"teamId":1,"heures":20},{"teamId":2,"heures":9}]');
  const res = resolveConflicts(mine, clash, { charges: 'mine' }, { charges: k.mine });
  assert.equal(res.changes.charges, k.mine);
  assert.equal(res.before.charges, clash.charges);
  // Cellule devenue illisible ailleurs : conflit sur la cellule entière
  assert.deepEqual(mergeChargesChange(base, { ...base, charges: 'oops' }, mine), {
    changes: mine,
    conflict: true,
    mine: mine.charges,
  });
});

test('rebaseDraft : charges saisies fusionnées avec la ligne relue, conflit : la saisie gardée sur la cellule relue', () => {
  const oldBase = { charges: '[{"teamId":1,"heures":10},{"teamId":2,"heures":5}]' };
  const draft = { charges: setPersonHours(oldBase.charges, 1, 20) };
  const fresh = { charges: '[{"teamId":1,"heures":10},{"teamId":2,"heures":9}]' };
  assert.equal(rebaseDraft(oldBase, draft, fresh).charges, '[{"teamId":1,"heures":20},{"teamId":2,"heures":9}]');
  // Même personne changée ailleurs et ici : la saisie reste, la personne 2 retirée ailleurs reste retirée
  const clash = { charges: '[{"teamId":1,"heures":30}]' };
  assert.equal(rebaseDraft(oldBase, draft, clash).charges, '[{"teamId":1,"heures":20}]');
  // Charges non touchées : elles suivent la Feuille
  assert.equal(rebaseDraft(oldBase, { charges: oldBase.charges }, clash).charges, clash.charges);
});

test('rebaseCharges : seules les personnes saisies comptent comme « miennes »', () => {
  const old = '[{"teamId":1,"heures":70},{"teamId":2,"heures":35}]';
  // Brouillon : 1 recalculé (non saisi) à 140 h, 2 saisie à 20 h
  const draft = '[{"teamId":1,"heures":140},{"teamId":2,"heures":20}]';
  // (a) ailleurs : une personne 3 ajoutée → gardée ; 1 recalculée repart de la cellule relue
  const added = '[{"teamId":1,"heures":70},{"teamId":2,"heures":35},{"teamId":3,"heures":7}]';
  assert.deepEqual(rebaseCharges(old, draft, added, new Set([2])), {
    raw: '[{"teamId":1,"heures":70},{"teamId":2,"heures":20},{"teamId":3,"heures":7}]',
    conflicts: [],
  });
  // (b) ailleurs : 1 retirée → ne revient pas
  assert.deepEqual(rebaseCharges(old, draft, '[{"teamId":2,"heures":35}]', new Set([2])), {
    raw: '[{"teamId":2,"heures":20}]',
    conflicts: [],
  });
  // (c) ailleurs : 2 changée aussi → conflit nommé, saisie gardée
  const r = rebaseCharges(old, draft, '[{"teamId":1,"heures":70},{"teamId":2,"heures":10}]', new Set([2]));
  assert.deepEqual(r.conflicts, [2]);
  assert.equal(r.raw, '[{"teamId":1,"heures":70},{"teamId":2,"heures":20}]');
  // Rien de saisi : la cellule relue telle quelle ; cellule illisible : null
  assert.deepEqual(rebaseCharges(old, draft, added, new Set()), { raw: added, conflicts: [] });
  assert.equal(rebaseCharges('oops', draft, added, new Set([2])), null);
  // rebaseDraft transmet typed
  assert.equal(
    rebaseDraft({ charges: old }, { charges: draft }, { charges: added }, { typed: new Set() }).charges,
    added,
  );
});

test('withPeopleFrom : entrées des seules personnes données reprises', () => {
  const base = '[{"teamId":1,"heures":70}, {"teamId":2,"heures":35}]';
  assert.equal(withPeopleFrom(base, '[]', []), base);
  assert.equal(
    withPeopleFrom(base, '[{"teamId":2,"heures":20},{"teamId":3,"heures":1}]', [2, 3]),
    '[{"teamId":1,"heures":70},{"teamId":2,"heures":20},{"teamId":3,"heures":1}]',
  );
  assert.equal(withPeopleFrom(base, '[{"teamId":1,"heures":70}]', [2]), '[{"teamId":1,"heures":70}]');
  assert.equal(withPeopleFrom('oops', base, [1]), null);
});

test('contrôle strict avant écriture : tableau compact, teamId existant, heures finies ≥ 0 au pas de 0,5', () => {
  const team = (id) => [1, 2, 40].includes(id);
  assert.equal(chargesWriteProblem('[{"teamId":1,"heures":7.5}]', '', team), null);
  assert.equal(chargesWriteProblem('[]', '', team), null);
  assert.equal(chargesWriteProblem(null, '', team), 'texte JSON attendu');
  assert.equal(chargesWriteProblem('oops', '', team), 'JSON illisible');
  assert.equal(chargesWriteProblem('{"teamId":1}', '', team), 'tableau JSON attendu');
  assert.equal(chargesWriteProblem('[{"teamId": 1, "heures": 7}]', '', team), 'encodage non compact');
  assert.equal(chargesWriteProblem('[3]', '', team), 'entrée qui n’est pas un objet');
  assert.equal(chargesWriteProblem('[{"teamId":"1","heures":7}]', '', team), 'teamId entier attendu');
  assert.equal(chargesWriteProblem('[{"teamId":1.5,"heures":7}]', '', team), 'teamId entier attendu');
  assert.equal(chargesWriteProblem('[{"teamId":9,"heures":7}]', '', team), 'personne inconnue : 9');
  assert.equal(chargesWriteProblem('[{"teamId":1,"heures":7}]', '', undefined), 'personne inconnue : 1');
  assert.match(chargesWriteProblem('[{"teamId":1,"heures":-1}]', '', team), /nombre fini/);
  assert.match(chargesWriteProblem('[{"teamId":1,"heures":"7"}]', '', team), /nombre fini/);
  assert.match(chargesWriteProblem('[{"teamId":1,"heures":7.2}]', '', team), /0,5 h/);
  // Entrées conservées telles quelles (même invalides, même personne inconnue) : admises, une fois chacune
  const before = '[{"teamId":"oops"},{"teamId":99,"heures":3},{"teamId":1,"heures":7.25}]';
  assert.equal(
    chargesWriteProblem('[{"teamId":"oops"},{"teamId":99,"heures":3},{"teamId":1,"heures":7.25}]', before, team),
    null,
  );
  assert.equal(
    chargesWriteProblem('[{"teamId":99,"heures":3},{"teamId":99,"heures":3}]', before, team),
    'personne inconnue : 99',
  );
  assert.equal(chargesWriteProblem('[{"teamId":1,"heures":7}]', 'oops', team), null);
});

test('M1 : texte d’origine des entrées non touchées recopié octet par octet', () => {
  const raw = '[ {"teamId": 68, "heures": 213.4, "note": "\\u00e9t\\u00e9"} , {"teamId":66,"heures":10.0} ]';
  const out = setPersonHours(raw, 66, 12);
  assert.equal(out, '[{"teamId": 68, "heures": 213.4, "note": "\\u00e9t\\u00e9"},{"teamId":66,"heures":12}]');
  assert.equal(
    addPerson(raw, 7, 1),
    '[{"teamId": 68, "heures": 213.4, "note": "\\u00e9t\\u00e9"},{"teamId":66,"heures":10.0},{"teamId":7,"heures":1}]',
  );
  assert.equal(removePerson(raw, 68), '[{"teamId":66,"heures":10.0}]');
  // Le writer admet les textes recopiés tels quels, et exige un encodage compact pour les autres
  const team = () => true;
  assert.equal(chargesWriteProblem(out, raw, team), null);
  assert.equal(chargesWriteProblem('[{"teamId":66,"heures":10.0}]', raw, team), null);
  assert.equal(chargesWriteProblem('[{"teamId":66, "heures":12}]', raw, team), 'encodage non compact');
});

test('M1 : cellule qu’on ne relirait pas sans perte → édition bloquée', () => {
  for (const raw of [
    '[{"teamId":1,"heures":1e400}]',
    '[{"teamId":1,"heures":2,"x":12345678901234567890}]',
    '[{"teamId":8,"teamId":9,"heures":2}]',
    '[{"a":{"b":1,"b":2}},{"teamId":1,"heures":2}]',
  ]) {
    assert.equal(readChargesCell(raw).error, 'perte', raw);
    assert.equal(
      reason(() => setPersonHours(raw, 1, 3)),
      'illisible',
    );
  }
  // R3 : un double fini se relit sans perte, même à 16 ou 17 chiffres significatifs
  for (const raw of ['[{"teamId":1,"heures":0.30000000000000004}]', '[{"teamId":1,"heures":2,"x":10.333333333333334}]'])
    assert.ok(readChargesCell(raw).ok, raw);
  assert.equal(
    setPersonHours('[{"teamId":1,"heures":2,"x":10.333333333333334}]', 1, 3),
    '[{"teamId":1,"heures":3,"x":10.333333333333334}]',
  );
  // Valeurs ordinaires : modifiables (décimales, exposant raisonnable, objets et listes imbriqués, littéraux)
  const ok = '[{"teamId":1,"heures":2.50,"e":1.5e2,"l":[true,false,null,"a\\"b"],"o":{}},[]]';
  assert.ok(readChargesCell(ok).ok);
  assert.equal(readChargesCell(ok).texts.length, 2);
});

test('M3 : au plus 1 ETP par personne sur la période (2 000 h sans dates)', () => {
  assert.equal(maxHours(70), 70);
  assert.equal(maxHours(null), 2000);
  assert.deepEqual(hoursFromInput('1,1', 'etp', 70), { error: 'max', max: 70 });
  assert.deepEqual(hoursFromInput('71', 'heures', 70), { error: 'max', max: 70 });
  assert.deepEqual(hoursFromInput('70', 'heures', 70), { heures: 70 });
  assert.deepEqual(hoursFromInput('2001', 'heures', null), { error: 'max', max: 2000 });
  // Valeur existante au-dessus de la borne, ressaisie telle qu'affichée : conservée
  assert.deepEqual(hoursFromInput('100', 'heures', 70, 100), { heures: 100 });
  assert.equal(
    chargesWriteProblem('[{"teamId":1,"heures":70.5}]', '', () => true, 70),
    'heures : au plus 70 h (1 ETP sur la période)',
  );
  assert.equal(
    chargesWriteProblem('[{"teamId":1,"heures":100}]', '[{"teamId":1,"heures":100}]', () => true, 70),
    null,
  );
  assert.match(
    chargesWriteProblem('[{"teamId":1,"heures":2000.5}]', '', () => true),
    /2000 h/,
  );
});

test('M4 : ETP à deux décimales sous 1 ; ressaisir la valeur affichée ne change rien', () => {
  // 10 h pour 1 ETP de 70 h = 0,142… ETP, affiché 0,14 ; ressaisir 0,14 garde 10 h (et non 9,8 h)
  assert.equal(inputValue(10, 'etp', 70), 0.14);
  assert.deepEqual(hoursFromInput('0,14', 'etp', 70, 10), { heures: 10 });
  assert.deepEqual(hoursFromInput('0,2', 'etp', 70, 10), { heures: 14 });
  assert.deepEqual(hoursFromInput('0,155', 'etp', 70, 10), { error: 'decimale' });
  assert.equal(inputValue(213.4, 'heures', 460), 213.4);
  assert.deepEqual(hoursFromInput('213,4', 'heures', 460, 213.4), { heures: 213.4 });
  assert.equal(inputValue(10, 'etp', null), null);
});

test('N1 : une entrée invalide de la personne est remplacée, sans doublon', () => {
  const raw = '[{"teamId":5,"heures":"x","src":"import"},{"teamId":8,"heures":1}]';
  const { invalid } = chargeRows(JSON.parse(raw));
  assert.deepEqual(invalid, [{ index: 0, text: '{"teamId":5,"heures":"x","src":"import"}', teamId: 5 }]);
  assert.equal(setPersonHours(raw, 5, 4), '[{"teamId":5,"heures":4,"src":"import"},{"teamId":8,"heures":1}]');
  assert.equal(addPerson(raw, 5), '[{"teamId":5,"heures":0,"src":"import"},{"teamId":8,"heures":1}]');
  assert.equal(chargeRows([3]).invalid[0].teamId, null);
});

test('N2 : moins de 0,25 h refusé, 0 explicite accepté', () => {
  assert.deepEqual(hoursFromInput('0,01', 'heures', 25), { error: 'petit' });
  assert.deepEqual(hoursFromInput('0,2', 'heures', null), { error: 'petit' });
  assert.deepEqual(hoursFromInput('0', 'heures', 25), { heures: 0 });
  assert.deepEqual(hoursFromInput('0', 'etp', 25), { heures: 0 });
  assert.deepEqual(hoursFromInput('0,25', 'heures', 25), { heures: 0.5 });
});

test('ETP : 2 décimales sous 1, une décimale à partir de 1', () => {
  assert.equal(etpDecimals(0.25), 2);
  assert.equal(etpDecimals(0.999), 1); // 1,00 → 1 décimale
  assert.equal(etpDecimals(1.25), 1);
  assert.equal(roundEtp(0.254), 0.25);
  assert.equal(roundEtp(1.26), 1.3);
  // 0,25 ETP de 140 h = 35 h ; 0,05 ETP de 70 h = 3,5 h
  assert.deepEqual(hoursFromInput('0,25', 'etp', 140), { heures: 35 });
  assert.deepEqual(hoursFromInput('0,05', 'etp', 70), { heures: 3.5 });
  assert.deepEqual(hoursFromInput('0,255', 'etp', 140), { error: 'decimale' });
  assert.deepEqual(hoursFromInput('1,25', 'etp', 140), { error: 'decimale' });
  assert.deepEqual(hoursFromInput('1,2', 'etp', 140, null, { estimation: true }), { heures: 168 });
  // valeur affichée ressaisie : heures gardées telles quelles (13 h pour 1 ETP de 140 h = 0,0928… → affiché 0,09)
  assert.equal(inputValue(13, 'etp', 140), 0.09);
  assert.deepEqual(hoursFromInput('0,09', 'etp', 140, 13), { heures: 13 });
});

test('ETP : bornes de 0,99 à 1, zéro, ressaisie de 0,5', () => {
  assert.deepEqual(hoursFromInput('0,999', 'etp', 140), { error: 'decimale' });
  assert.deepEqual(hoursFromInput('0,99', 'etp', 140), { heures: 138.5 });
  assert.deepEqual(hoursFromInput('1', 'etp', 140), { heures: 140 });
  assert.equal(etpDecimals(0), 1);
  // 0,5 ETP de 70 h = 35 h : la valeur affichée ressaisie garde les heures
  assert.equal(inputValue(35, 'etp', 70), 0.5);
  assert.deepEqual(hoursFromInput('0,5', 'etp', 70, 35), { heures: 35 });
});
