# Roadmap ISD — widget Grist

Vue de pilotage de l'équipe ISD (avancement et charge) sur les tables de la Feuille de route EDS.

**1 ETP** sur une période = la capacité d'une personne standard à temps plein sur cette période, partout dans le
widget (charges des tâches, Kanban, Tableau, Statistiques, Portfolio, Mes tâches, plan de charge) :
7 h par jour ouvré (hors week-ends et jours fériés), moins 44 jours de congés par an (au prorata des jours ouvrés de
l'année), à 80 % en mai et en décembre, 60 % en juillet, 50 % en août (`core/capacity.js` : `fteHours`, `SLOWDOWN`).
Les heures d'une charge se répartissent sur les jours ouvrés de la tâche au prorata de cette capacité (`hoursSharer`) :
une tâche à 1 ETP compte 1 ETP chaque semaine et chaque mois (Statistiques, plan de charge, Portfolio, Mes tâches).
C'est la formule du plan de charge pour une personne à 35 h sans indisponibilité ; la quotité et les indisponibilités
individuelles ne comptent que dans le plan de charge. Une période sans jour ouvré (un week-end) se traite comme une
tâche sans dates (pas d'ETP, borne de 2 000 h), ses heures restant réparties sur ses jours calendaires. Les heures déjà stockées ne changent pas : leur ETP
affiché suit la formule (une charge qui dépasse désormais 1 ETP est signalée, conservée telle quelle). Une pastille
« i » rappelle la règle dans le bloc des charges, la charge par profil des Statistiques et le plan de charge.
Par défaut, **lecture seule** : le widget ne modifie jamais le document. La phase 2 (lots 2a à 2d) permet de modifier
une tâche depuis sa fiche, dont le bloc « Personnes » (assignés et charges réunis ; charge facultative en ETP ou en
heures par semaine, « h/semaine », la quotité : 35 h/semaine = 1 ETP ; heures totales = ETP × capacité standard de
la période, congés, fériés et ralentissements déduits, affichées « = … h au total » et stockées à 0,5 h près ; sans
période exploitable, aucune saisie, les heures déjà stockées restent montrées et conservées ; si la capacité de la période change, l'ETP de chaque personne est conservé
et ses heures recalculées, avec l'écart « 52 h → 110 h (ETP conservé) » sous la ligne ; une date vidée ramène chaque ligne aux heures de sa référence ; une charge qui
dépasserait la borne sur la nouvelle période garde ses heures et est signalée), de modifier un chantier, de créer
tâches, sous-tâches et chantiers (« Nouvelle tâche » et « Nouveau chantier » au bout de la ligne des onglets,
« Ajouter une sous-tâche », « + Tâche ») et de changer une tâche de chantier (ses sous-tâches suivent). Aucune date
de planification après le 31 décembre de l'année suivante. Onglet Équipe (lot 2d) : ajouter une personne à l'équipe ISD, modifier sa
fiche (nom, e-mail, rôle parmi les rôles existants, capacité, N+1), la désactiver ou la réactiver, gérer ses
indisponibilités ; seules les personnes de l'équipe ISD sont modifiables, aucun rôle n'est créé. Projets et
catégories restent en lecture. Suppression : « Supprimer » (pied de la fiche tâche ou chantier en édition) supprime une
tâche avec toutes ses sous-tâches, ou un chantier vide (sinon : « déplacez ou supprimez d'abord ses n tâches »), après
une fenêtre de confirmation qui nomme l'élément et liste ses sous-tâches ; refusée si une autre tâche ou un chantier
en dépend (dependDe). « Annuler » (message qui suit, ou panneau d'édition) recrée les lignes au même numéro avec les
valeurs relues juste avant la suppression. Rien d'autre n'est supprimé, sauf l'annulation d'une création de la
session (jamais une personne : elle se désactive). Tout cela seulement si l'adresse de la page l'ouvre :

- `?edition=essai` : mode essai, toutes les actions sont notées et affichées, rien n'est envoyé ;
- `?edition=1&doc=<identifiant du document>` : envoi réel, seulement si `doc=` désigne le document ouvert ;
- arrêt d'urgence : `flags.json` (`{ "edition": true }`), lu à une adresse **fixe** commune à toutes les versions :
  à la racine du site quand la page est servie depuis un dossier de version (`…/v0.2.0/index.html` → `…/flags.json`),
  sinon à côté de la page. Pour couper l'édition partout, publier ce seul fichier avec `{ "edition": false }` :
  il est relu à chaque relecture des données et juste avant chaque enregistrement, les pages ouvertes passent en
  lecture seule sans rechargement. Absent ou illisible : édition coupée.

Le widget s'ouvre toujours sur l'onglet Gantt : la dernière vue consultée n'est pas restaurée et aucune vue d'accueil
n'est posée au « Je suis… » (les vues d'accueil enregistrées avant cette règle ont été remises à zéro une fois).
Seule une vue d'accueil choisie ensuite dans les Préférences l'emporte (« Gantt (par défaut) » = aucune).
`?vue=<onglet>` (`mytasks`, `gantt`, `kanban`, `table`, `portfolio`, `stats`, `synthesis`, `team`) l'emporte sur
tout et ouvre cet onglet ; une valeur inconnue est ignorée.

La CSP n'autorise que la même origine et l'instance Grist `https://grist.numerique.gouv.fr`
(`widget/js/config.js`), pour lire le niveau d'accès du compte.

## Règles d'affichage

- **Domaine ISD** : le Domaine (table Team) dont le nom contient le sigle « ISD », porté par une personne ou parmi
  les choix de la colonne. Aucun autre Domaine ne le remplace : sans lui, l'équipe ISD se réduit aux profils DE,
  DA, DS et PO, sans le Management.
- **Équipe ISD** : personnes actives de rôle DE, DA, DS ou PO Data, ou du Domaine ISD (le Management ISD en fait
  partie ; le Management d'un autre Domaine, non). Une personne du Domaine ISD d'un autre rôle (ni profil ISD ni
  Management) fait partie de l'équipe et du périmètre, mais n'a pas de profil : elle n'apparaît ni dans le filtre
  Profil, ni dans les indicateurs et la charge par profil du Portfolio, ni dans le plan de charge.
- **Périmètre ISD** : un projet en fait partie si une personne de l'équipe ISD en est responsable, est responsable
  ou contributrice d'un de ses chantiers, ou est assignée, responsable ou chargée sur une de ses tâches. Sponsor ou
  contributeur clé du projet : seulement les profils DE, DA, DS et PO (le Management ISD seulement sponsor du projet
  d'une autre équipe ne le fait pas entrer). Les autres projets sont masqués par défaut, avec leurs chantiers et
  tâches, et ne sont jamais modifiables dans le widget.
- **« Hors périmètre ISD aussi »** : affiche aussi les projets hors périmètre. Sans la case, un projet hors périmètre
  reste visible quand la personne ciblée y est impliquée : « Je suis… » avec « Mes chantiers » (voir ci-dessous),
  ou le filtre Personne ; ce dernier est un filtre de tâche, il ne garde donc que les projets où cette personne a
  une tâche retenue (pas ceux dont elle n'est que sponsor ou responsable sans tâche).
- **« ISD seulement »** : à l'intérieur des projets affichés, masque les chantiers et les tâches où personne de
  l'équipe ISD (Management ISD compris, personnes actives) n'intervient. Une tâche reste si un assigné, son
  responsable ou une personne chargée en fait partie, ou si une de ses sous-tâches (à toute profondeur) en est ; le
  parent reste alors pour garder l'arbre, sans les sous-tâches sans ISD. Un chantier reste s'il garde une tâche ou si
  son responsable ou un contributeur est de l'équipe ISD (il apparaît vide dans le Gantt et le Portfolio). Un projet
  sans rien de gardé disparaît des vues centrées tâches et ne reste dans le Gantt et le Portfolio que s'il est porté
  par l'ISD (responsable, sponsor ou contributeur clé). Se combine avec les autres filtres, « Mes chantiers » et
  « Hors périmètre ISD aussi » ; sans effet sur « Mes tâches » et « Équipe » (vues non filtrées).
- **Périmètre « Tout / Mes chantiers »** (actif seulement après « Je suis… ») : « Tout » ne restreint rien ;
  « Mes chantiers » garde les chantiers dont je suis responsable ou contributeur, ou qui portent une tâche non
  terminée où je suis assigné, responsable ou chargé, et tous les chantiers des projets dont je suis responsable,
  sponsor ou contributeur clé (même hors périmètre ISD, alors en lecture seule), avec toutes leurs tâches ; sous
  « (sans chantier) », seulement mes tâches (toutes si le projet est à moi). Mes tâches personnelles sont dans
  l'onglet « Mes tâches ».
- **Catégorie, Projet, Chantier** : limitent l'arbre à cet élément (listes en cascade, projets du périmètre). Ils
  s'appliquent aussi aux projets et chantiers sans tâche.
- **Recherche** : garde un élément si son titre ou celui d'un de ses ancêtres contient le texte ; un projet ou un
  chantier sans tâche n'est donc gardé que si son titre (ou celui de sa catégorie ou de son projet) correspond.
- **Personne, Profil, Statut** (et Responsable sous « + Filtres ») : filtres de tâche. Personne : la personne est
  assignée, responsable ou chargée ; Profil (PO, DA, DS, DE ou Mgmt, le Management actif de l'équipe ISD) : une
  personne active de ce profil l'est ; Statut : statut de la tâche. Dès qu'un de ces filtres est actif, seuls
  restent les projets et chantiers qui ont une tâche retenue.
- **Éléments sans tâche** : un projet ou un chantier sans tâche apparaît dans le Gantt, avec la mention « Aucune
  tâche » (vue Liste des petits écrans exceptée : elle ne liste que des tâches), et dans le Portfolio (onglets Projets
  et Chantiers), avec « Tout » ou « Mes chantiers » et sans filtre de tâche. Kanban, Tableau, Statistiques (dont le
  plan de charge), Synthèse et l'onglet Mes tâches ne montrent que des tâches. L'onglet Équipe n'est pas filtré.
- **Couleur du Gantt** (« Couleur par » : Étape, Statut ou **Chantier**, par défaut ; un choix enregistré est
  gardé) : en mode Chantier, chaque chantier prend une des 7 teintes `--viz-ch-1` à `--viz-ch-7`, attribuées par
  projet sur tous ses chantiers triés par titre (au-delà de 7, les teintes se recyclent ; un filtre ne change jamais
  une couleur ; un chantier de deux projets peut avoir une teinte par projet). Pastille devant le nom du chantier,
  trait de sa teinte devant le nom de ses tâches et sous-tâches, bande très légère sur ses lignes, barres de sa
  teinte (liseré foncé), barre du chantier en teinte foncée, tâche terminée délavée ; projet, catégorie et
  « (sans chantier) » restent neutres. Pas de texte d'étape dans les barres : l'infobulle et le nom accessible
  donnent l'étape et « Chantier : … ». Le retard garde son contour rouge (absent de la palette des chantiers).
- **Charge du Portfolio** : une carte et une colonne par profil, Mgmt compris ; la barre, le repère de capacité et
  le total portent sur les profils DE, DA, DS et PO seulement.

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
