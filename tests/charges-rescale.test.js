import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chargeRefs,
  followBaseRefs,
  refFromInput,
  rescaleCharges,
  rescaledHours,
} from '../widget/js/core/charges-rescale.js';

const base = '[{"teamId":40,"heures":70}, {"teamId":41,"heures":35,"note":"x"}]'; // 14 jours : 1 ETP et 0,5 ETP

test('dates allongées : ETP gardé, heures recalculées', () => {
  const r = rescaleCharges(base, chargeRefs(base, 14), 28, { baseRaw: base });
  assert.equal(r.raw, '[{"teamId":40,"heures":140},{"teamId":41,"heures":70,"note":"x"}]');
  assert.deepEqual(r.changed, [40, 41]);
});
test('retour à la période d’origine : texte d’origine recopié octet par octet', () => {
  const refs = chargeRefs(base, 14);
  const longer = rescaleCharges(base, refs, 28, { baseRaw: base }).raw;
  assert.equal(
    rescaleCharges(longer, refs, 14, { baseRaw: base }).raw.includes('{"teamId":41,"heures":35,"note":"x"}'),
    true,
  );
  assert.equal(rescaleCharges(base, refs, 14, { baseRaw: base }).raw, base); // même période : rien ne bouge
});
test('arrondi à 0,5 h et minimum 0,5 h', () => {
  assert.equal(rescaledHours({ etp: 0.25, heures: 35, days: 28 }, 3), 4); // 3,75 → 4
  assert.equal(rescaledHours({ etp: 0.01, heures: 1, days: 28 }, 1), 0.5);
  assert.equal(rescaledHours({ etp: 0, heures: 0, days: 28 }, 1), 0);
});
test('sans période d’origine ou d’arrivée : heures gardées', () => {
  assert.equal(rescaledHours({ etp: null, heures: 70, days: null }, 14), 70);
  assert.equal(rescaledHours({ etp: 1, heures: 70, days: 14 }, null), 70);
});
test('au-dessus de la borne après recalcul : entrée inchangée, signalée', () => {
  const old = '[{"teamId":40,"heures":140}]'; // 2 ETP sur 14 j (saisie ancienne)
  const r = rescaleCharges(old, chargeRefs(old, 14), 7, { maxOf: () => 35 });
  assert.equal(r.raw, old);
  assert.deepEqual(r.over, [40]);
});
test('personne estimation : borne de 50 ETP', () => {
  const est = '[{"teamId":9,"heures":700}]'; // 10 ETP sur 14 j
  const r = rescaleCharges(est, chargeRefs(est, 14), 7, { maxOf: (id) => (id === 9 ? 1750 : 35) });
  assert.equal(r.raw, '[{"teamId":9,"heures":350}]');
});
test('doublons, entrées invalides, cellule illisible : jamais touchés', () => {
  const dup = '[{"teamId":40,"heures":10},{"teamId":40,"heures":5},{"teamId":"x"}]';
  assert.equal(chargeRefs(dup, 14).size, 0);
  assert.equal(rescaleCharges(dup, chargeRefs(dup, 14), 28).raw, dup);
  assert.equal(rescaleCharges('pas du json', new Map([[40, { etp: 1, heures: 70, days: 14 }]]), 28).raw, 'pas du json');
});
test('saisie en ETP : l’ETP saisi fait foi, pas les heures arrondies', () => {
  const ref = refFromInput({ etp: 0.25, heures: 4, days: 3 }); // 3,75 h arrondi à 4 h
  assert.equal(rescaledHours(ref, 28), 35);
});
test('saisie en heures : ETP déduit, null sans période', () => {
  assert.deepEqual(refFromInput({ heures: 70, days: 14 }), { etp: 1, heures: 70, days: 14 });
  assert.deepEqual(refFromInput({ heures: 70, days: null }), { etp: null, heures: 70, days: null });
});
test('cellule vide ou illisible : aucune référence', () => {
  assert.equal(chargeRefs(null, 14).size, 0);
  assert.equal(chargeRefs('[', 14).size, 0);
  assert.equal(chargeRefs(base, null).get(40).etp, null);
});
test('refs vide, personne disparue ou devenue en double : cellule rendue telle quelle', () => {
  assert.equal(rescaleCharges(base, new Map(), 28).raw, base);
  const refs = new Map([[99, { etp: 1, heures: 70, days: 14 }]]);
  assert.equal(rescaleCharges(base, refs, 28).raw, base);
  const dup = '[{"teamId":40,"heures":10},{"teamId":40,"heures":5}]';
  assert.equal(rescaleCharges(dup, new Map([[40, { etp: 1, heures: 70, days: 14 }]]), 28).raw, dup);
});
test('cible égale aux heures déjà là : rien n’est réécrit', () => {
  const r = rescaleCharges(base, chargeRefs(base, 14), 14);
  assert.equal(r.raw, base);
  assert.deepEqual(r.changed, []);
});
test('base illisible ou autre valeur : encodage compact', () => {
  const refs = chargeRefs(base, 14);
  const r = rescaleCharges(base, refs, 28, { baseRaw: 'x' });
  assert.equal(r.raw, '[{"teamId":40,"heures":140},{"teamId":41,"heures":70,"note":"x"}]');
});

test('nouvelle base : les références non saisies suivent la base, les saisies sont gardées', () => {
  const refs = chargeRefs(base, 14);
  refs.set(41, refFromInput({ heures: 14, etp: 0.1, days: 14 })); // 41 saisie dans le formulaire
  const fresh = '[{"teamId":40,"heures":50},{"teamId":41,"heures":35},{"teamId":42,"heures":7}]';
  const next = followBaseRefs(refs, new Set([41]), fresh, 14);
  assert.deepEqual(next.get(40), { etp: 50 / 70, heures: 50, days: 14 });
  assert.deepEqual(next.get(41), { etp: 0.1, heures: 14, days: 14 });
  assert.deepEqual(next.get(42), { etp: 0.1, heures: 7, days: 14 });
  // Absente de la nouvelle base et non saisie : retirée
  assert.equal(followBaseRefs(refs, new Set(), '[]', 14).size, 0);
  // Dates allongées ensuite : la personne non saisie repart des NOUVELLES heures (50 h → 100 h)
  assert.equal(rescaleCharges('[{"teamId":40,"heures":50}]', next, 28).raw, '[{"teamId":40,"heures":100}]');
});
