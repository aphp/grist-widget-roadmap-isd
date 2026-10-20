/** Rendu de « Mes tâches », du périmètre et de « Vue d'accueil » : titres, listes, boutons, texte échappé. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../widget/js/core/model.js';
import { dayOfIso } from '../widget/js/core/dates.js';
import { myTasksHtml } from '../widget/js/views/my-tasks.js';
import { scopeHtml } from '../widget/js/ui/filters.js';
import { homeViewFieldHtml } from '../widget/js/ui/header.js';
import { DEFAULT_FILTERS } from '../widget/js/core/filters.js';
import { feuille } from './fixtures/feuille.js';

const today = dayOfIso('2026-10-20');

test('Mes tâches sans « Je suis… » : titre, état vide et bouton « Choisir qui je suis »', () => {
  const out = myTasksHtml(buildModel(feuille()), { me: null, today }).toString();
  assert.match(out, /<h2 class="view-heading__title">Mes tâches<\/h2>/);
  assert.match(out, /role="status"/);
  assert.match(out, /Choisissez qui vous êtes pour voir vos tâches\./);
  assert.match(out, /<button type="button" class="fr-btn fr-btn--sm" data-choose-me>\s*Choisir qui je suis/);
  // Personne inconnue (ligne supprimée) : même invitation
  assert.match(myTasksHtml(buildModel(feuille()), { me: 999, today }).toString(), /data-choose-me/);
});

test('Mes tâches d’une personne sans tâche en cours : état vide nommé', () => {
  const out = myTasksHtml(buildModel(feuille()), { me: 2, today }).toString();
  assert.match(out, /Aucune tâche en cours ou à venir pour Bob PO\./);
  assert.doesNotMatch(out, /data-choose-me/);
});

test('Mes tâches : un groupe par échéance non vide (h3), listes, lignes-boutons qui ouvrent la fiche', () => {
  const out = myTasksHtml(buildModel(feuille()), { me: 5, today }).toString();
  assert.match(out, /<section class="mt" aria-labelledby="mt-title">/);
  assert.match(out, /<h2 class="view-heading__title" id="mt-title">Mes tâches<\/h2>/);
  assert.match(out, /<p class="mt__total" role="status">2 tâches en cours ou à venir<\/p>/);
  // Puces de saut : les cinq groupes, boutons seulement pour les groupes non vides
  assert.match(out, /<nav class="mt__jump" aria-label="Aller à un groupe">/);
  assert.deepEqual(
    [...out.matchAll(/data-jump="(\w+)"/g)].map((x) => x[1]),
    ['later', 'noDate'],
  );
  // Groupes : titre h3 focalisable, période en clair
  const titles = [...out.matchAll(/<h3 class="mt__group-title" id="mt-g-(\w+)" tabindex="-1">/g)].map((x) => x[1]);
  assert.deepEqual(titles, ['later', 'noDate']);
  assert.match(out, /après le 1 nov\./);
  assert.match(out, /<ul class="list mt__list" role="list">/);
  // Lignes : statut, chantier · projet, dates, ETP et rôles
  assert.match(out, /<button type="button" class="mt__row" data-task="2010">/);
  assert.match(out, /Chantier partagé · ChatDPI/);
  assert.match(out, /2 nov\. → 6 nov\./);
  assert.match(out, /0,6 ETP/);
  assert.match(out, /Assigné, Chargé/);
  assert.match(out, /Sans chantier · ChatDPI/);
  assert.match(out, /7 h, sans dates/);
  // Charge de la semaine
  assert.match(out, /Ma charge cette semaine/);
});

test('Mes tâches : en retard (libellé écrit), sous-tâche, « Afficher plus » au-delà de 20 lignes', () => {
  const raw = feuille();
  const t = raw.tables.Tasks;
  const n = t.id.length;
  t.Responsable ??= Array(n).fill(null);
  for (let i = 0; i < 25; i++)
    Object.keys(t).forEach((k) => {
      const row = {
        id: 5000 + i,
        titre: `Tâche <b>${i}</b>`,
        Chantier: 100,
        projet: 10,
        parentTask: 1000,
        statut: 'todo',
        Responsable: 1,
        dateEcheance: Date.parse('2026-10-01T00:00:00Z') / 1000,
      };
      t[k].push(k in row ? row[k] : null);
    });
  const out = myTasksHtml(buildModel(raw), { me: 1, today }).toString();
  assert.match(out, /mt__group--late/);
  assert.match(out, /en retard de 19 j/);
  assert.match(out, /Sous-tâche de « Ajout table FHIR Adresse »/);
  assert.equal((out.match(/class="mt__row"/g) ?? []).length, 20 + 1); // 20 en retard + « réalisation »
  assert.match(out, /data-more="late">\s*Afficher 5 de plus/);
  assert.match(out, /20 sur 25/);
  // Titre échappé
  assert.match(out, /Tâche &lt;b&gt;0&lt;\/b&gt;/);
  assert.doesNotMatch(out, /<b>0<\/b>/);
  // Après un appui : tout est affiché, plus de bouton
  const more = myTasksHtml(buildModel(raw), { me: 1, today, clicks: { late: 1 } }).toString();
  assert.equal((more.match(/class="mt__row"/g) ?? []).length, 26);
  assert.doesNotMatch(more, /data-more=/);
});

test('Mes tâches : titre de tâche, de parent et de chantier contenant du HTML échappés (aucune balise injectée)', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const r = feuille();
  const t = r.tables.Tasks;
  t.titre[t.id.indexOf(2010)] = evil;
  const c = r.tables.Chantiers;
  c.Nom_du_chantier[c.id.indexOf(201)] = `<script>alert(2)</script>`;
  const out = myTasksHtml(buildModel(r), { me: 5, today }).toString();
  assert.match(out, /<span class="mt__title">&lt;img src=x onerror=alert\(1\)&gt;<\/span>/);
  assert.match(out, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /<script/);
  assert.doesNotMatch(out, /onerror=alert\(1\)>/);
});

test('périmètre : contrôle segmenté Tout / Mes tâches / Mes chantiers, indisponible sans « Je suis… »', () => {
  const on = scopeHtml({ ...DEFAULT_FILTERS, scope: 'chantiers' }, false).toString();
  assert.match(on, /<fieldset/);
  assert.match(on, /<legend class="fr-segmented__legend filters__scope-legend">Périmètre<\/legend>/);
  assert.deepEqual(
    [...on.matchAll(/<label class="fr-label" for="f-perimetre-(\w+)"/g)].map((x) => x[1]),
    ['all', 'tasks', 'chantiers'],
  );
  assert.match(on, /id="f-perimetre-chantiers"\s+value="chantiers"\s+data-scope="chantiers"\s+checked/);
  assert.doesNotMatch(on, /aria-disabled|role="tooltip"/);
  const off = scopeHtml({ ...DEFAULT_FILTERS, scope: 'tasks' }, true).toString();
  assert.match(off, /id="f-perimetre-all"\s+value="all"\s+data-scope="all"\s+checked/);
  assert.equal((off.match(/aria-disabled="true"/g) ?? []).length, 2);
  assert.match(off, /aria-describedby="tip-scope"/);
  assert.match(off, /role="tooltip" id="tip-scope">Choisissez d’abord qui vous êtes/);
});

test('Préférences : « Vue d’accueil » étiquetée, dernière vue puis chaque onglet', () => {
  const out = homeViewFieldHtml('gantt').toString();
  assert.match(out, /<label class="fr-label popover__title" for="pref-home">Vue d’accueil<\/label>/);
  assert.match(out, /aria-describedby="pref-home-help"/);
  const options = [...out.matchAll(/<option value="(\w+)"/g)].map((x) => x[1]);
  assert.deepEqual(options, ['last', 'mytasks', 'gantt', 'kanban', 'table', 'portfolio', 'stats', 'synthesis', 'team']);
  assert.match(out, /<option value="gantt" selected>Gantt<\/option>/);
  assert.match(homeViewFieldHtml(null).toString(), /<option value="last" selected>Dernière vue consultée<\/option>/);
});
