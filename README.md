# Roadmap ISD — widget Grist

Vue de pilotage de l'équipe ISD (avancement et charge) sur les tables de la Feuille de route EDS.
Par défaut, **lecture seule** : le widget ne modifie jamais le document. La phase 2 (lots 2a à 2d) permet de modifier
une tâche depuis sa fiche, dont le bloc « Personnes » (assignés et charges réunis ; charge facultative en ETP ou en
heures, 1 ETP = 35 h par semaine sur les jours calendaires de la tâche, heures stockées à 0,5 h près), de modifier un
chantier, de créer tâches, sous-tâches et chantiers (« Nouvelle tâche » et « Nouveau chantier » au bout de la ligne des
onglets, « Ajouter une sous-tâche », « + Tâche ») et de changer une tâche
de chantier (ses sous-tâches suivent). Onglet Équipe (lot 2d) : ajouter une personne à l'équipe ISD, modifier sa
fiche (nom, e-mail, rôle parmi les rôles existants, capacité, N+1), la désactiver ou la réactiver, gérer ses
indisponibilités ; seules les personnes de l'équipe ISD sont modifiables, aucun rôle n'est créé. Projets et
catégories restent en lecture. Rien n'est supprimé, sauf l'annulation d'une création de la session (jamais une
personne : elle se désactive). Tout cela seulement si l'adresse de la page l'ouvre :

- `?edition=essai` : mode essai, toutes les actions sont notées et affichées, rien n'est envoyé ;
- `?edition=1&doc=<identifiant du document>` : envoi réel, seulement si `doc=` désigne le document ouvert ;
- arrêt d'urgence : `flags.json` (`{ "edition": true }`), lu à une adresse **fixe** commune à toutes les versions :
  à la racine du site quand la page est servie depuis un dossier de version (`…/v0.2.0/index.html` → `…/flags.json`),
  sinon à côté de la page. Pour couper l'édition partout, publier ce seul fichier avec `{ "edition": false }` :
  il est relu à chaque relecture des données et juste avant chaque enregistrement, les pages ouvertes passent en
  lecture seule sans rechargement. Absent ou illisible : édition coupée.

La CSP n'autorise que la même origine et l'instance Grist `https://grist.numerique.gouv.fr`
(`widget/js/config.js`), pour lire le niveau d'accès du compte.

## Règles d'affichage

- **Équipe ISD** : personnes actives de rôle DE, DA, DS ou PO Data, ou du Domaine ISD (le Management ISD en fait
  partie ; le Management d'un autre Domaine, non).
- **Périmètre ISD** : un projet en fait partie si une personne de l'équipe ISD en est responsable, sponsor ou
  contributrice clé, est responsable ou contributrice d'un de ses chantiers, ou est assignée, responsable ou chargée
  sur une de ses tâches. Les autres projets sont masqués par défaut, ainsi que leurs chantiers et tâches.
- **« Hors périmètre ISD aussi »** : affiche aussi les projets hors périmètre. Sans la case, un projet hors périmètre
  reste visible quand la personne ciblée (« Je suis… » avec « Mes tâches » ou « Mes chantiers », ou le filtre
  Personne) y est impliquée.
- **Périmètre « Tout / Mes tâches / Mes chantiers »** (actif seulement après « Je suis… ») : « Tout » ne restreint
  rien ; « Mes tâches » garde les tâches où je suis assigné, responsable ou chargé ; « Mes chantiers » garde les
  chantiers dont je suis responsable ou contributeur et tous les chantiers des projets dont je suis responsable,
  sponsor ou contributeur clé, avec toutes leurs tâches.
- **Catégorie, Projet, Chantier** : limitent l'arbre à cet élément (listes en cascade, projets du périmètre). Ils
  s'appliquent aussi aux projets et chantiers sans tâche.
- **Personne, Profil, Statut** (et Responsable sous « + Filtres ») : filtres de tâche. Personne : la personne est
  assignée, responsable ou chargée ; Profil : une personne de ce profil l'est ; Statut : statut de la tâche. Dès
  qu'un de ces filtres, ou « Mes tâches », est actif, seuls restent les projets et chantiers qui ont une tâche
  retenue.
- **Éléments sans tâche** : un projet ou un chantier sans tâche apparaît dans le Gantt, avec la mention « Aucune
  tâche » (vue Liste des petits écrans exceptée : elle ne liste que des tâches), et dans le Portfolio (onglets Projets
  et Chantiers), avec « Tout » ou « Mes chantiers » et sans filtre de tâche. Kanban, Tableau, Statistiques (dont le
  plan de charge), Synthèse et l'onglet Mes tâches ne montrent que des tâches. L'onglet Équipe n'est pas filtré.

## Développement
npm install · npm test · npm run lint · python3 dev/serve.py (http://localhost:8770/dev/host.html)

Licence Apache-2.0 — voir LICENSE.

## API Grist embarquée

`widget/vendor/grist-plugin-api.js` est une copie de l'API des widgets Grist, prise sur l'instance utilisée
(`https://grist.numerique.gouv.fr/grist-plugin-api.js`). Le serveur de `docs.getgrist.com` est trop lent depuis le
réseau AP-HP : chargé en synchrone, il laissait le widget blanc plusieurs dizaines de secondes. Pour mettre à jour :

    curl -sS -o widget/vendor/grist-plugin-api.js https://grist.numerique.gouv.fr/grist-plugin-api.js

## DSFR embarqué

Le Système de design de l'État (version **1.15.3**) est servi depuis `widget/vendor/dsfr/` : plus aucune requête vers
un CDN au démarrage (la version CDN coûtait 18 requêtes et 130 Ko au premier chargement).

- `dsfr.min.css` : copie telle quelle de `dist/dsfr.min.css`. Les `@font-face` Marianne y restent mais ne
  déclenchent aucun téléchargement : le thème utilise la police système (`css/tokens.css`).
- `icons/` : les SVG référencés en relatif (`url(icons/…)`) par `dsfr.min.css` pour ses composants (champs, badges,
  boutons de fermeture…), copiés de `dist/icons/` ; ils ne sont requis qu'à l'usage.
- `icons.css` : **extrait** de `dist/utility/icons/icons.min.css`, limité aux icônes utilisées par le widget, avec
  les SVG en `data:` URI (masques CSS identiques à l'original).
- `LICENSE.md` : licence du DSFR (Etalab 2.0, avec conditions d'utilisation réservées aux entités de l'administration).

Pour mettre à jour (remplacer `VERSION`) :

    V=VERSION; B=https://cdn.jsdelivr.net/npm/@gouvfr/dsfr@$V
    curl -sS -o widget/vendor/dsfr/dsfr.min.css $B/dist/dsfr.min.css
    curl -sS -o widget/vendor/dsfr/LICENSE.md $B/LICENSE.md
    curl -sS -o /tmp/icons.min.css $B/dist/utility/icons/icons.min.css
    # SVG référencés par dsfr.min.css : grep -o 'url(icons/[^)]*)' widget/vendor/dsfr/dsfr.min.css, puis $B/dist/<chemin>

Régénérer ensuite `icons.css` : pour chaque classe `fr-icon-*` utilisée (chercher `icon('…')`, `TAB_ICONS` dans
`widget/js/ui/kit.js` et les classes `fr-icon-…` construites dynamiquement dans `widget/js/views`), reprendre la
règle `.fr-icon-NOM:after,.fr-icon-NOM:before{-webkit-mask-image:url(…);mask-image:url(…)}`, télécharger le SVG
référencé (`$B/dist/utility/icons/../../icons/<dossier>/NOM.svg`) et l'inliner en `data:image/svg+xml,…`. Vérifier
l'intégrité en comparant à la somme sha384 publiée par jsDelivr, puis recontrôler visuellement toutes les vues.
Ajouter une icône au widget impose d'ajouter sa règle à `icons.css`.
