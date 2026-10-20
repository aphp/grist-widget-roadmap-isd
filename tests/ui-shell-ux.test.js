/** Coquille (lot UX) : barre d'onglets qui défile, titre de vue commun, invite « Qui êtes-vous ? », « + Filtres ». */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { DEFAULT_FILTERS } from '../widget/js/core/filters.js';
import { edgeFade, revealScroll } from '../widget/js/ui/tabs.js';
import { viewHeading } from '../widget/js/ui/heading.js';
import { meInviteHtml } from '../widget/js/ui/header.js';
import { extraCount } from '../widget/js/ui/filters.js';
import { h, TAB_ICONS, TABS } from '../widget/js/ui/kit.js';
import { feuille } from './fixtures/feuille.js';

test('onglets : dégradé seulement sur les bords où des onglets sont masqués', () => {
  assert.deepEqual(edgeFade({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 }), { start: false, end: false });
  assert.deepEqual(edgeFade({ scrollLeft: 0, scrollWidth: 700, clientWidth: 330 }), { start: false, end: true });
  assert.deepEqual(edgeFade({ scrollLeft: 200, scrollWidth: 700, clientWidth: 330 }), { start: true, end: true });
  assert.deepEqual(edgeFade({ scrollLeft: 370, scrollWidth: 700, clientWidth: 330 }), { start: true, end: false });
});

test('onglets : l’onglet actif hors champ est ramené dans la barre, avec une marge', () => {
  const bar = { scrollLeft: 0, clientWidth: 330 };
  // Onglet « Équipe » à 552–626 px (cas relevé à 390 px) : la barre défile jusqu'à le montrer
  assert.equal(revealScroll(bar, 552, 74), 552 + 74 + 24 - 330);
  // Déjà visible : position inchangée
  assert.equal(revealScroll({ scrollLeft: 100, clientWidth: 330 }, 200, 80), 100);
  // À gauche du champ : retour vers le début, jamais négatif
  assert.equal(revealScroll({ scrollLeft: 300, clientWidth: 330 }, 10, 80), 0);
  assert.equal(revealScroll({ scrollLeft: 300, clientWidth: 330 }, 120, 80), 96);
});

test('onglets : une icône par onglet', () => {
  assert.deepEqual(Object.keys(TAB_ICONS).sort(), [...TABS].sort());
});

test('titre de vue : titre h2, sous-titre et contrôles à droite ; texte échappé', () => {
  const out = viewHeading('Tableau <b>', 'Sous-titre & co', h`<button type="button">CSV</button>`).toString();
  assert.match(out, /<header class="view-heading">/);
  assert.match(out, /<h2 class="view-heading__title">Tableau &lt;b&gt;<\/h2>/);
  assert.match(out, /<p class="view-heading__sub">Sous-titre &amp; co<\/p>/);
  assert.match(out, /<div class="view-heading__controls"><button type="button">CSV<\/button><\/div>/);
  // Sans sous-titre ni contrôles : rien de vide ; sous-titre fragment : gardé tel quel (role="status")
  const bare = viewHeading('Équipe').toString();
  assert.doesNotMatch(bare, /view-heading__sub|view-heading__controls/);
  const frag = viewHeading('T', h`<p role="status">3 tâches</p>`, '', { id: 'x' }).toString();
  assert.match(frag, /<h2 class="view-heading__title" id="x">/);
  assert.match(frag, /<div class="view-heading__sub"><p role="status">3 tâches<\/p><\/div>/);
});

test('invite « Qui êtes-vous ? » : dialogue non modal nommé, personnes ISD par profil, « Passer »', () => {
  const out = meInviteHtml(buildModel(feuille())).toString();
  assert.match(out, /role="dialog"/);
  assert.match(out, /aria-modal="false"/);
  assert.match(out, /aria-labelledby="me-invite-title"/);
  assert.match(out, /aria-describedby="me-invite-help"/);
  assert.match(out, /<h2 id="me-invite-title"[^>]*>Qui êtes-vous \?<\/h2>/);
  // Profils dans l'ordre PO, DA, DS, DE ; seules les personnes ISD actives (Carl DS inactif, Dora hors ISD absents)
  const roles = [...out.matchAll(/class="me-invite__role">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(roles, ['PO', 'DA', 'DE', 'Management']); // libellé affiché « PO » (P3-6)
  const picks = [...out.matchAll(/data-me-pick="(\d+)">([^<]+)</g)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(picks, [
    [2, 'Bob PO'],
    [5, 'Eve DA'],
    [1, 'Alice DE'],
    [6, 'Fanny Manager'], // Management du Domaine ISD (Gus, BNDMR, absent)
  ]);
  assert.match(out, /data-me-skip[^>]*>\s*Passer\s*</);
});

test('« + Filtres » : nombre de filtres actifs repliés', () => {
  assert.equal(extraCount({ ...DEFAULT_FILTERS }), 0);
  assert.equal(extraCount({ ...DEFAULT_FILTERS, responsable: 3 }), 1);
  assert.equal(extraCount({ ...DEFAULT_FILTERS, responsable: 3, demandeur: 'DSN', person: 4 }), 2);
});

test('nom accessible des boutons de fermeture : il commence par le texte visible (WCAG 2.5.3)', async () => {
  const { label } = await import('../widget/js/labels.js');
  for (const k of ['dialog.close', 'detail.close'])
    assert.ok(label(k).startsWith(label('detail.closeShort')), `${k} : « ${label(k)} »`);
});
