# Roadmap ISD — CLAUDE.md

Widget Grist (custom widget, iframe) de pilotage de l'équipe ISD, branché sur les tables de la « Feuille de route
EDS ». Interface en français uniquement. Aucune étape de construction : modules ES servis tels quels depuis `widget/`.

## Règles absolues
- **La Feuille de route EDS est la production.** Le widget n'y crée ni table ni colonne, ne modifie aucune option de
  colonne (`ModifyColumn`, choix, `setOption`) et n'écrit que dans la liste blanche. Les outils Python n'écrivent que
  dans le **document de test** (copie de la Feuille, mêmes ids) : `tools/grist_api.py` refuse tout autre document.
- **Écritures : un seul module**, `widget/js/core/grist-writer.js` (seul fichier avec `applyUserActions` et les
  actions). `grist.` n'apparaît que dans `main.js`, `core/grist-gateway.js` et `core/grist-writer.js` ; `fetch` en GET
  seulement (main.js, passerelle) ; `getAccessToken` avec `{ readOnly: true }` ; ni `getTable` ni `selectedTable`.
  `tests/write-guard.test.js` le vérifie.
- **Liste blanche figée** (`WRITABLE`, comparée à une copie dans write-guard) : Tasks (champs de la fiche, `charges`,
  `assignees`, `Chantier`, `projet`, `tags`), Chantiers (fiche chantier et `tags`, jamais `Priorite`), Team et
  Disponibilites (lot équipe). `tags` en mise à jour seulement, jamais à la création. Projects et catégories : jamais. `RemoveRecord` seulement pour annuler une création de la session
  (ligne relue identique, aucune référence), jamais sur Team (une personne se désactive).
- **Contrôle strict dans le writer** avant tout envoi : obligatoires, références existantes, hiérarchie cohérente
  (sous-tâches qui suivent, pas de cycle), dates ordonnées, périmètre ISD, relecture des lignes avant l'envoi,
  fusion par champ, pour `charges` par personne et, pour `tags`, en multi-ensemble (ajouts et retraits de chacun). Colonnes formules (dont formule vide, ex. `Team.capaciteHebdo`)
  jamais écrites.
- **Édition coupée par défaut** : seule l'adresse l'ouvre (`?edition=essai` = rien n'est envoyé ;
  `?edition=1&doc=<id>` = envoi seulement si `doc` est le document ouvert) et `flags.json` (`{ "edition": true }`,
  adresse fixe, relu avant chaque envoi) peut tout couper. Délai maximal de 10 s sur chaque requête.
- **Charges** : `Tasks.charges` = JSON `[{"teamId": n, "heures": h}]`, total d'heures sur la tâche. 1 ETP = 35 h par
  semaine de la tâche (jours calendaires), au plus 1 ETP par personne, ETP à une décimale, heures à 0,5 h près ;
  entrées non touchées recopiées octet par octet (`core/charges-edit.js`).
- Aucune donnée, clé, capture ni identifiant de document dans le dépôt (un test cherche les identifiants).
  `config.yaml` (clé API, ids des documents) reste hors du dépôt.
- Textes injectés : `html```, `sanitize()` ou `textContent`. CSP : même origine + `https://grist.numerique.gouv.fr`.
- Commits : conventional commits sur **une seule ligne**, sans corps ni trailer.

## Architecture
- `widget/js/core/` : logique pure, testée (≥ 90 % de couverture). Modèle (`model.js` : Catégorie → Projet →
  Chantier → Tâche → Sous-tâche), filtres, données de chaque vue (`*-data.js`), équipe ISD (`team-directory.js`),
  écriture (`grist-writer.js`, `task-session.js`, `*-form.js`, `charges-edit.js`, `task-people.js`, `conflicts.js`,
  `write-rights.js` : droits relus au moment d’agir).
- `widget/js/views/` : rendu d'un onglet ou d'un formulaire, `render(el, ctx)`.
- `widget/js/ui/` : coquille (en-tête, onglets, filtres, fiche, dialogues, kit `h```).
- `widget/vendor/` : `grist-plugin-api.js` (copie de l'instance) et DSFR 1.15.3 (voir README).
- Équipe ISD : rôle DE, DA, DS, PO, ou Domaine ISD ; Management ISD inclus dans les sélecteurs (`pickerGroups`).
  Les sélecteurs d'ajout ne proposent que l'équipe ISD ; les personnes hors ISD déjà saisies dans la Feuille restent
  affichées et conservées.

## Commandes
- `npm install` · `npm test` · `npm run test:coverage` · `npm run lint`
- `python3 dev/serve.py` → `http://localhost:8770/dev/host.html` : faux Grist sur `dev/data/snapshot.json`
  (non versionné, produit par `tools/export_test_snapshot.py`), sinon (ou `?donnees=synthetiques`) sur le jeu
  inventé de `dev/synthetic-snapshot.js`. Édition en dev : `?edition=essai` ou
  `?edition=1&doc=doc-dev-local&ecritures=memoire` ; écritures dans `window.__writes`.
- `tests/browser-fake-grist.test.js` : bout en bout dans Chrome sans tête (ignoré sans Chrome), toujours sur le
  jeu synthétique (aucune donnée réelle dans le dépôt ni en CI).
- Outils (`uv run python tools/…`, lisent `config.yaml` via `GRIST_WIDGET_CONFIG` ou le dossier parent) :
  `seed_test_doc.py --reset` (recopie la Feuille dans le document de test), `install_test_page.py [url]` (page du
  widget dans le document de test), `check_writes.py save|check|diff` (contrôle avant/après un scénario).

## État et suite
- Fait : vues en lecture, édition des tâches, charges, chantiers, créations, bloc « Personnes », équipe ISD, statut
  depuis la carte et la ligne (`core/quick-status.js`, `ui/status-popover.js` ; écriture par le statut rapide de
  `ui/task-editor.js` ; Kanban : bouton ⋯ hors du focus itinérant, « S » ou Maj+F10 sur la carte), tags affectés et
  retirés (lot 2e, `core/tags-edit.js`).
- **Tags** (Q3 B) : `Tasks.tags` et `Chantiers.tags` sont deux listes distinctes (ChoiceList, `['L', …]` ou `null`).
  Proposés : choix déclarés + valeurs utilisées. Un nom nouveau est écrit dans la cellule **sans être déclaré**
  (jamais d'option de colonne modifiée) et s'affiche « non déclaré » (pastille grise en pointillés). Writer : chaînes
  seulement, nouveaux tags sans espaces de bord ni caractère de contrôle, 80 caractères au plus, aucun doublon ajouté,
  30 tags au plus (fusion comprise) ; valeurs d'avant recopiées telles quelles (chaîne vide comprise). Fusion en
  multi-ensemble (retirer un exemplaire d'un doublon tient), refaite sur la ligne relue à l'envoi, y compris après la
  fenêtre de conflit (`tagsSeen`). Cellule illisible (texte, `['E', …]`, non-texte) : montrée, champ bloqué, remplacée
  seulement après confirmation de ce contenu (`replaceTags`). Le writer contrôle lui-même la ligne avant d'écrire
  des tags, « Annuler » compris (qui saute alors les tags et le signale) : ligne relue par l'appelant pour cet envoi
  (`fresh`, une seule lecture), sinon table relue (échec : refus `tags-relecture`), données chargées en mode essai.
  Les tags ne s'enregistrent jamais sans vérification : « Enregistrer sans vérifier » n'envoie que les autres champs
  et le dit. Annonces des tags dans `#drawer-live`, région persistante du panneau (hors du contenu redessiné).
- À tester dans le document de test avec le vrai Grist : messages d'erreur réels, droits (lecteur, règles d'accès),
  relecture des valeurs écrites, coût des relectures, `check_writes.py`.
- Lots suivants : glisser-déposer du Kanban, dates à la souris dans le Gantt, gestion des tags (lot 2g, reportée).
- Décisions en attente (touchent la structure de la Feuille) : détection automatique de l'utilisateur (table
  d'aide), gestion des tags (créer, renommer, recolorer, supprimer : options de colonne), échelle de priorité, demandeur par chantier. Pas de création de
  rôle. `Team.capaciteHebdo` reste en lecture (colonne jamais remplie dans la Feuille).
- Production : page du widget dans la Feuille, servie depuis une adresse https, seulement après les tests.
