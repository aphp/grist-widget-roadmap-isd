import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chargeRefs,
  followBaseRefs,
  refFromInput,
  rescaleCharges,
  rescaledHours,
} from '../widget/js/core/charges-rescale.js';
import { periodFte, roundHours } from '../widget/js/core/charges-edit.js';
import { dayOfIso } from '../widget/js/core/dates.js';

const base = '[{"teamId":40,"heures":70}, {"teamId":41,"heures":35,"note":"x"}]'; // 1 ETP de 70 h : 1 ETP et 0,5 ETP

test('dates allongées : ETP gardé, heures recalculées', () => {
  const r = rescaleCharges(base, chargeRefs(base, 70), 140, { baseRaw: base });
  assert.equal(r.raw, '[{"teamId":40,"heures":140},{"teamId":41,"heures":70,"note":"x"}]');
  assert.deepEqual(r.changed, [40, 41]);
});
test('retour à la période d’origine : texte d’origine recopié octet par octet', () => {
  const refs = chargeRefs(base, 70);
  const longer = rescaleCharges(base, refs, 140, { baseRaw: base }).raw;
  assert.equal(
    rescaleCharges(longer, refs, 70, { baseRaw: base }).raw.includes('{"teamId":41,"heures":35,"note":"x"}'),
    true,
  );
  assert.equal(rescaleCharges(base, refs, 70, { baseRaw: base }).raw, base); // même période : rien ne bouge
});
test('arrondi à 0,5 h et minimum 0,5 h', () => {
  assert.equal(rescaledHours({ etp: 0.25, heures: 35, fte: 140 }, 15), 4); // 3,75 → 4
  assert.equal(rescaledHours({ etp: 0.01, heures: 1, fte: 140 }, 5), 0.5);
  assert.equal(rescaledHours({ etp: 0, heures: 0, fte: 140 }, 5), 0);
});
test('sans période d’origine ou d’arrivée : heures gardées', () => {
  assert.equal(rescaledHours({ etp: null, heures: 70, fte: null }, 70), 70);
  assert.equal(rescaledHours({ etp: 1, heures: 70, fte: 70 }, null), 70);
});
test('au-dessus de la borne après recalcul : entrée inchangée, signalée', () => {
  const old = '[{"teamId":40,"heures":140}]'; // 2 ETP de 70 h (saisie ancienne)
  const r = rescaleCharges(old, chargeRefs(old, 70), 35, { maxOf: () => 35 });
  assert.equal(r.raw, old);
  assert.deepEqual(r.over, [40]);
});
test('personne estimation : borne de 50 ETP', () => {
  const est = '[{"teamId":9,"heures":700}]'; // 10 ETP de 70 h
  const r = rescaleCharges(est, chargeRefs(est, 70), 35, { maxOf: (id) => (id === 9 ? 1750 : 35) });
  assert.equal(r.raw, '[{"teamId":9,"heures":350}]');
});
test('doublons, entrées invalides, cellule illisible : jamais touchés', () => {
  const dup = '[{"teamId":40,"heures":10},{"teamId":40,"heures":5},{"teamId":"x"}]';
  assert.equal(chargeRefs(dup, 70).size, 0);
  assert.equal(rescaleCharges(dup, chargeRefs(dup, 70), 140).raw, dup);
  assert.equal(rescaleCharges('pas du json', new Map([[40, { etp: 1, heures: 70, fte: 70 }]]), 140).raw, 'pas du json');
});
test('saisie en ETP : l’ETP saisi fait foi, pas les heures arrondies', () => {
  const ref = refFromInput({ etp: 0.25, heures: 4, fte: 15 }); // 3,75 h arrondi à 4 h
  assert.equal(rescaledHours(ref, 140), 35);
});
test('saisie en heures : ETP déduit, null sans période', () => {
  assert.deepEqual(refFromInput({ heures: 70, fte: 70 }), { etp: 1, heures: 70, fte: 70 });
  assert.deepEqual(refFromInput({ heures: 70, fte: null }), { etp: null, heures: 70, fte: null });
});
test('cellule vide ou illisible : aucune référence', () => {
  assert.equal(chargeRefs(null, 70).size, 0);
  assert.equal(chargeRefs('[', 70).size, 0);
  assert.equal(chargeRefs(base, null).get(40).etp, null);
});
test('refs vide, personne disparue ou devenue en double : cellule rendue telle quelle', () => {
  assert.equal(rescaleCharges(base, new Map(), 140).raw, base);
  const refs = new Map([[99, { etp: 1, heures: 70, fte: 70 }]]);
  assert.equal(rescaleCharges(base, refs, 140).raw, base);
  const dup = '[{"teamId":40,"heures":10},{"teamId":40,"heures":5}]';
  assert.equal(rescaleCharges(dup, new Map([[40, { etp: 1, heures: 70, fte: 70 }]]), 140).raw, dup);
});
test('cible égale aux heures déjà là : rien n’est réécrit', () => {
  const r = rescaleCharges(base, chargeRefs(base, 70), 70);
  assert.equal(r.raw, base);
  assert.deepEqual(r.changed, []);
});
test('base illisible ou autre valeur : encodage compact', () => {
  const refs = chargeRefs(base, 70);
  const r = rescaleCharges(base, refs, 140, { baseRaw: 'x' });
  assert.equal(r.raw, '[{"teamId":40,"heures":140},{"teamId":41,"heures":70,"note":"x"}]');
});

test('nouvelle base : les références non saisies suivent la base, les saisies sont gardées', () => {
  const refs = chargeRefs(base, 70);
  refs.set(41, refFromInput({ heures: 14, etp: 0.1, fte: 70 })); // 41 saisie dans le formulaire
  const fresh = '[{"teamId":40,"heures":50},{"teamId":41,"heures":35},{"teamId":42,"heures":7}]';
  const next = followBaseRefs(refs, new Set([41]), fresh, 70);
  assert.deepEqual(next.get(40), { etp: 50 / 70, heures: 50, fte: 70 });
  assert.deepEqual(next.get(41), { etp: 0.1, heures: 14, fte: 70 });
  assert.deepEqual(next.get(42), { etp: 0.1, heures: 7, fte: 70 });
  // Absente de la nouvelle base et non saisie : retirée
  assert.equal(followBaseRefs(refs, new Set(), '[]', 70).size, 0);
  // Dates allongées ensuite : la personne non saisie repart des NOUVELLES heures (50 h → 100 h)
  assert.equal(rescaleCharges('[{"teamId":40,"heures":50}]', next, 140).raw, '[{"teamId":40,"heures":100}]');
});

test('décalage à durée égale de juin à juillet : heures recalculées, ETP gardé', () => {
  // Quatre semaines, du lundi au dimanche : même durée, capacité plus faible en juillet (60 %)
  const june = periodFte(dayOfIso('2027-06-07'), dayOfIso('2027-07-04'));
  const july = periodFte(dayOfIso('2027-07-05'), dayOfIso('2027-08-01'));
  assert.ok(july < june);
  const raw = `[{"teamId":40,"heures":${roundHours(june / 2)}}]`; // 0,5 ETP sur la période de juin
  const refs = chargeRefs(raw, june);
  const r = rescaleCharges(raw, refs, july, { baseRaw: raw });
  const etp = refs.get(40).etp;
  assert.equal(r.raw, `[{"teamId":40,"heures":${roundHours(etp * july)}}]`);
  assert.deepEqual(r.changed, [40]);
  // Retour en juin : texte d'origine
  assert.equal(rescaleCharges(r.raw, refs, june, { baseRaw: raw }).raw, raw);
  // Décalage d'une semaine dans la même capacité (deux périodes d'automne sans jour férié) : rien ne bouge
  const a = periodFte(dayOfIso('2027-09-06'), dayOfIso('2027-09-12'));
  const b = periodFte(dayOfIso('2027-09-13'), dayOfIso('2027-09-19'));
  assert.equal(a, b);
  const sep = '[{"teamId":40, "heures":12}]';
  assert.equal(rescaleCharges(sep, chargeRefs(sep, a), b, { baseRaw: sep }).raw, sep);
});
