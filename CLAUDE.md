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
  Disponibilites (lot équipe). `tags` en mise à jour seulement, jamais à la création. `charges` permis à la création
  d'une tâche (bloc « Personnes » des fenêtres de création) avec les contrôles de la mise à jour (`newChargesProblem` :
  JSON, personnes existantes, pas de 0,5 h, 1 ETP sur la période des dates du même AddRecord, exemption estimation)
  et cohérent avec `assignees` (chaque personne chargée assignée, une entrée par personne, `charges` jamais sans assignés,
  entrées exactement `{teamId, heures}`). Si le writer n'autorise plus assignés ou charges à l'envoi, la fenêtre bloque
  et copie la saisie au lieu de la perdre en silence. Dates ajoutées ou changées ensuite (fiche, fenêtre de
  création) : ETP gardé, heures recalculées (`core/charges-rescale.js`) ; entrées au-dessus de la borne laissées telles
  quelles et signalées (dates remises à l'identique : texte d'origine recopié). Projects et catégories :
  jamais. `RemoveRecord` : pour annuler une création de la session (ligne relue identique, aucune référence), ou
  pour supprimer depuis la fiche, après confirmation, une tâche avec toutes ses sous-tâches ou un chantier vide
  (aucune tâche rattachée) ; refusé si une ligne hors du lot en dépend (dependDe d'une tâche ou d'un chantier) ;
  suppression depuis la fiche jamais sur Team, Projects ni Disponibilites (`REMOVABLE`), et jamais aucune ligne de
  Team (une personne se désactive). Lignes relues juste avant (toutes les colonnes de données), restaurables par
  « Annuler » (AddRecord au même identifiant, valeurs relues, parents avant enfants), seule création qui porte des
  colonnes hors de la liste de création. Refus aussi : colonne de données absente de la ligne relue (instantané
  incomplet), autre table qui référence Tasks ou Chantiers par une colonne de données ; « Annuler » refusé si une
  ligne recréée viserait une ligne disparue (parent, chantier, projet, dépendances, projets du chantier).
- **Contrôle strict dans le writer** avant tout envoi : obligatoires, références existantes, hiérarchie cohérente
  (sous-tâches qui suivent, pas de cycle), dates ordonnées, dates de planification ≤ 31/12 de l'année suivante
  (`date-max`, colonnes écrites seulement, « Annuler » exempt), périmètre ISD, relecture des lignes avant l'envoi,
  fusion par champ, pour `charges` par personne et, pour `tags`, en multi-ensemble (ajouts et retraits de chacun).
  Colonnes formules (dont formule vide, ex. `Team.capaciteHebdo`, `Team.aph`) jamais écrites. Team : `nom`,
  `email`, `aph` (1 à 10 chiffres ou vide, `validAph` ; colonne Text ou Int, `ALSO_ACCEPTED_TYPES` : lue en texte par
  `aphText`, 0 = vide, écrite selon son type relu, nombre pour Int sans zéro de tête ; Numeric refusée), `role`, `capaciteHebdo`, `actif`, `n_1` ; `Domaine`
  seulement à la création.
- **Édition coupée par défaut** : seule l'adresse l'ouvre (`?edition=essai` = rien n'est envoyé ;
  `?edition=1&doc=<id>` = envoi seulement si `doc` est le document ouvert) et `flags.json` (`{ "edition": true }`,
  adresse fixe, relu avant chaque envoi) peut tout couper. Délai maximal de 10 s sur chaque requête.
- **Charges** : `Tasks.charges` = JSON `[{"teamId": n, "heures": h}]`, total d'heures sur la tâche. 1 ETP = 35 h par
  semaine de la tâche (jours calendaires), au plus 1 ETP par personne, ETP saisi à deux décimales sous 1 (une
  au-delà), heures à 0,5 h près ; l'ETP fait foi quand la période change (h = ETP × 35 × jours / 7) ; entrées non
  touchées recopiées octet par octet (`core/charges-edit.js`). Seule exception : les personnes estimation
  (`Team.aph` = `ESTIMATION_APH` = `'9999999'`, ex. « Data Engineer », « Data Scientist »… une par profil pour
  estimer dans la roadmap), bornées à `ESTIMATION_MAX_ETP` = 50 ETP sur la période (2 000 h sans dates), dans la
  saisie et dans le writer ; badge « Estimation » à côté de chacune. TOUTE ligne ACTIVE qui porte cet APH est
  exemptée, quel que soit leur nombre (`model.estimation.ids`, `estimationIdsOfTable` ; comparaison stricte après
  `aphText` : '9999999' ou le nombre 9999999, `core/estimation.js`) ; une ligne inactive ne l'est pas. Le widget ne
  pose ni ne retire jamais cet APH (refus `aph-estimation` du writer, erreur du formulaire) : les personnes
  estimation se désignent dans la Feuille.
- Aucune donnée, clé, capture ni identifiant de document dans le dépôt (un test cherche les identifiants).
  `config.yaml` (clé API, ids des documents) reste hors du dépôt.
- Textes injectés : `html```, `sanitize()` ou `textContent`. CSP : même origine + `https://grist.numerique.gouv.fr`.
- Commits : conventional commits sur **une seule ligne**, sans corps ni trailer.

## Architecture
- `widget/js/core/` : logique pure, testée (≥ 90 % de couverture). Modèle (`model.js` : Catégorie → Projet →
  Chantier → Tâche → Sous-tâche), filtres, données de chaque vue (`*-data.js`), équipe ISD (`team-directory.js`),
  écriture (`grist-writer.js`, `task-session.js`, `*-form.js`, `charges-edit.js`, `task-people.js`, `conflicts.js`,
  `write-rights.js` : droits relus au moment d’agir ; `write-scope.js` : périmètre des écritures passé au writer).
- `widget/js/views/` : rendu d'un onglet ou d'un formulaire, `render(el, ctx)`.
- `widget/js/ui/` : coquille (en-tête, onglets, filtres, fiche, dialogues, kit `h```).
- `widget/vendor/` : `grist-plugin-api.js` (copie de l'instance) et DSFR 1.15.3 (voir README).
- Équipe ISD : rôle DE, DA, DS, PO, ou Domaine ISD ; Management ISD inclus dans les sélecteurs (`pickerGroups`).
  Domaine ISD = nom contenant « ISD » (personnes, sinon choix de Team.Domaine), calculé une fois (`model.isdDomain`),
  jamais de repli sur un autre Domaine (il fixe les écritures). Périmètre : responsable du projet, rôles de chantier
  et de tâche pour toute l'équipe ; sponsor et contributeur clé pour les profils ISD seulement.
  La règle (`taskInvolvesIsd`, `chantierInvolvesIsd`, `projectInvolvesIsd` de model.js) sert aussi au filtre « ISD seulement »
  (`isdOnly`), qui masque chantiers et tâches sans personne ISD dans les projets affichés.
  Les sélecteurs d'ajout ne proposent que l'équipe ISD ; les personnes hors ISD déjà saisies dans la Feuille restent
  affichées et conservées. Personne : `isdTeam` = membre actif de l'équipe ISD (périmètre ISD, `inScope`, écritures) ;
  `isd` = profil ISD actif seul (DE, DA, DS, PO). Profils affichés (filtre Profil, charge et capacité du Portfolio,
  plan de charge) : `PROFILE_KEYS` / `profileKey` de kanban-data.js, PO, DA, DS, DE puis Mgmt (Management ISD actif,
  teinte `--viz-mgmt`). Règles d'affichage : README.
- Vues : Gantt et Portfolio (Projets, Chantiers) montrent aussi projets et chantiers sans tâche (état vide sur
  l'arbre, `TREE_VIEWS` de main.js) ; Kanban, Tableau, Statistiques, Synthèse et Mes tâches restent centrés tâches.

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
- Fait : vues en lecture, édition des tâches, charges, chantiers, créations, bloc « Personnes » (fiche et fenêtres
  « Nouvelle tâche » / « Sous-tâche », un seul contrôleur `ui/people-block.js`, identifiants préfixés `tf-` / `cf-`),
  équipe ISD, statut depuis la carte et la ligne (`core/quick-status.js`, `ui/status-popover.js` ; écriture par le statut rapide de
  `ui/task-editor.js` ; Kanban : bouton ⋯ hors du focus itinérant, « S » ou Maj+F10 sur la carte), tags affectés et
  retirés (lot 2e, `core/tags-edit.js`), suppression depuis la fiche (tâche avec ses sous-tâches, chantier vide ;
  `core/delete-plan.js` pour la fenêtre, `remove` du writer sur les tables relues, « Annuler » au même identifiant).
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
  relecture des valeurs écrites, coût des relectures, `check_writes.py`, suppression et restauration au même
  identifiant (AddRecord à identifiant fixe, colonnes de données recopiées, manualSort, refus d'un identifiant pris).
- Lots suivants : glisser-déposer du Kanban, dates à la souris dans le Gantt, gestion des tags (lot 2g, reportée).
- Décisions en attente (touchent la structure de la Feuille) : détection automatique de l'utilisateur (table
  d'aide), gestion des tags (créer, renommer, recolorer, supprimer : options de colonne), échelle de priorité,
  demandeur par chantier. Pas de création de rôle. `Team.capaciteHebdo` et `Team.aph` restent en lecture tant que
  ce sont des colonnes formules vides de la Feuille (`?ecritures=capacite-donnee` / `aph-donnee` simulent leur
  conversion en dev ; `aph-entier` : Team.aph convertie en Int, comme Grist après une saisie de chiffres).
- Production : page du widget dans la Feuille, servie depuis une adresse https, seulement après les tests.
