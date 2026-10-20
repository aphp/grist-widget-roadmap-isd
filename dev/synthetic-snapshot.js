/**
 * Jeu de données SYNTHÉTIQUE du faux Grist (format de dev/data/snapshot.json : tables colonnaires de fetchTable,
 * plus _grist_Tables et _grist_Tables_column lues par la passerelle). Noms, adresses et projets inventés : aucune
 * donnée réelle. Déterministe pour un jour donné ; les dates sont placées autour de `today`.
 * Utilisé par les tests de bout en bout (?donnees=synthetiques) et à défaut de dev/data/snapshot.json.
 */

const DAY = 86400;
const ISD = 'Ingénierie et sciences des données - ISD';
const OTHER = 'Domaine extérieur - EXT';

/** Générateur pseudo-aléatoire à graine fixe (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function columnar(rows, cols) {
  return Object.fromEntries(['id', ...cols].map((c) => [c, rows.map((r) => (c in r ? r[c] : null))]));
}

/**
 * Colonnes de chaque table : [colId, type, isFormula, choices?]. Formule vide pour Team.capaciteHebdo et Team.aph
 * (comme dans la Feuille) ; la variante { aph: true } fait de Team.aph une colonne de données.
 */
const SCHEMA = {
  Team: [
    ['nom', 'Text'],
    ['email', 'Text'],
    ['aph', 'Text', 1],
    ['role', 'Choice', 0, ['Management', 'DS', 'DE', 'DA', 'PO Data']],
    ['actif', 'Bool'],
    ['Domaine', 'Choice', 0, [ISD, OTHER, 'Domaine voisin - VOI']],
    ['capaciteHebdo', 'Numeric', 1],
    ['n_1', 'Ref:Team'],
  ],
  Projects: [
    ['nom', 'Text'],
    ['Categorie', 'Choice', 0, ['Produit de données', 'Projet', 'Produit', 'Offre de service', 'Hors Niveau 1']],
    ['Statut', 'Choice', 0, ['Emergence', 'En construction', 'Opérationnelle']],
    ['dateDebut', 'Date'],
    ['dateFin', 'Date'],
    ['responsable', 'Ref:Team'],
    ['Sponsor', 'RefList:Team'],
    ['Contributeurs_cles', 'RefList:Team'],
    ['Priorite_de_la_direction', 'Choice', 0, ['Priorité 1', 'Priorité 2', 'Priorité 3']],
    ['Commanditaires', 'Text'],
    ['Description', 'Text'],
    ['actif', 'Bool'],
  ],
  Chantiers: [
    ['Nom_du_chantier', 'Text'],
    ['Projets', 'RefList:Projects'],
    [
      'Statut',
      'Choice',
      0,
      ['À cadrer', 'En cadrage', 'À planifier', 'Planifié', 'En réalisation', 'Terminé', 'Bloqué', 'En pause'],
    ],
    ['Debut', 'Date'],
    ['Fin', 'Date'],
    ['Responsable', 'Ref:Team'],
    ['Contributeurs', 'RefList:Team'],
    ['Priorite', 'Choice', 0, ['P3', 'Basse']],
    ['Criteres_de_succes', 'Text'],
    ['Description', 'Text'],
    ['tags', 'ChoiceList', 0, ['Intégration de données']],
  ],
  Tasks: [
    ['titre', 'Text'],
    ['description', 'Text'],
    ['statut', 'Choice', 0, ['todo', 'inprogress', 'review', 'done', 'En attente externe', 'Bloqué']],
    ['dateDebut', 'Date'],
    ['dateEcheance', 'Date'],
    ['dateCloture', 'Date'],
    ['projet', 'Ref:Projects'],
    ['Chantier', 'Ref:Chantiers'],
    ['parentTask', 'Ref:Tasks'],
    ['priorite', 'Choice', 0, ['3']],
    ['assignees', 'RefList:Team'],
    ['Responsable', 'Ref:Team'],
    ['charges', 'Text'],
    ['dependDe', 'RefList:Tasks'],
    ['estimationH', 'Numeric'],
    ['tempsPasse', 'Numeric'],
    ['Commentaire', 'Text'],
    ['Lien_utile', 'Text'],
    ['type', 'Choice'],
    ['progression', 'Numeric'],
    ['tags', 'ChoiceList'],
    ['Cree_par', 'Text'],
    ['Chantier_Criteres_de_succes', 'Text'],
  ],
  Disponibilites: [
    ['membre', 'Ref:Team'],
    ['dateDebut', 'Date'],
    ['dateFin', 'Date'],
    ['dispo', 'Numeric'],
    ['type', 'Text'],
    ['commentaire', 'Text'],
  ],
};

/** Personnes inventées : tous les profils ISD, Management ISD, une personne inactive, des personnes hors ISD. */
const PEOPLE = [
  ['Zoé DE', 'DE', ISD],
  ['Arthur DE', 'DE', ISD],
  ['Agathe DE', 'DE', ISD],
  ['Achille DE', 'DE', ISD],
  ['Odile DA', 'DA', ISD],
  ['Octave DA', 'DA', ISD],
  ['Basile DS', 'DS', ISD],
  ['Simone DS', 'DS', ISD],
  ['Prosper DS', 'DS', ISD],
  ['Bob PO', 'PO Data', ISD],
  ['Paula PO', 'PO Data', ISD],
  ['Fanny Manager', 'Management', ISD],
  ['Marius Manager', 'Management', ISD],
  ['Irène Inactive', 'DS', ISD, false],
  ['Gus Manager Externe', 'Management', OTHER],
  ['Ernest Hors ISD', '', OTHER],
  ['Hélène Hors ISD', '', OTHER],
  ['Yvon Voisin', '', 'Domaine voisin - VOI'],
];

/** APH inventé de la personne estimation (même valeur que ESTIMATION_APH de widget/js/core/charges-edit.js). */
const ESTIMATION_APH = '9999999';

/**
 * @param {Date} [today] jour de référence (les dates sont placées autour de lui)
 * @param {{aph?:boolean}} [opts] aph : Team.aph colonne de données (au lieu de la formule vide de la Feuille), avec
 *   des APH inventés et une personne estimation « Estimation DE » (APH 9999999), ajoutée en dernier : les tâches
 *   du jeu restent les mêmes
 * @returns {Record<string, object>} tables colonnaires, dont _grist_Tables et _grist_Tables_column
 */
export function syntheticSnapshot(today = new Date(), { aph = false } = {}) {
  const random = rng(20261020);
  const pick = (arr) => arr[Math.floor(random() * arr.length)];
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) / 1000;
  const day = (offset) => t0 + offset * DAY;
  const slug = (s) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z]+/g, '.');

  const team = PEOPLE.map(([nom, role, Domaine, actif = true], i) => ({
    id: i + 1,
    nom,
    role,
    actif,
    Domaine,
    email: `${slug(nom)}@exemple.fr`,
    aph: aph ? String(1000001 + i) : '',
    capaciteHebdo: 0,
    n_1: Domaine === ISD && role !== 'Management' ? 12 : 0,
  }));
  const byRole = (r) => team.filter((p) => p.role === r && p.actif && p.Domaine === ISD).map((p) => p.id);
  const isdIds = ['DE', 'DA', 'DS', 'PO Data'].flatMap(byRole);
  const managers = byRole('Management');
  const outsiders = team.filter((p) => p.Domaine !== ISD).map((p) => p.id);

  const PROJECTS = [
    ['Données Imaginaires', 'Produit de données'],
    ['Entrepôt Exemple', 'Produit de données'],
    ['Assistant Imaginaire', 'Projet'],
    ['Projet Alpha', 'Projet'],
    ['Projet Bêta', 'Projet'],
    ['Tableau de bord Gamma', 'Produit'],
    ['Offre Delta', 'Offre de service'],
    ['Projet Externe Omega', 'Produit'],
  ];
  const projects = PROJECTS.map(([nom, Categorie], i) => {
    const outside = i === PROJECTS.length - 1;
    return {
      id: i + 1,
      nom,
      Categorie,
      Statut: pick(SCHEMA.Projects[2][3]),
      dateDebut: day(-180 + i * 15),
      dateFin: day(200 + i * 20),
      responsable: outside ? outsiders[1] : byRole('PO Data')[i % 2],
      Sponsor: ['L', outside ? outsiders[0] : managers[i % 2]],
      Contributeurs_cles: outside ? null : ['L', isdIds[i % isdIds.length]],
      Priorite_de_la_direction: i < 3 ? `Priorité ${i + 1}` : '',
      Commanditaires: i % 2 ? 'Direction A & Direction B' : 'Direction C',
      Description: `Description fictive du projet ${nom}.`,
      actif: true,
    };
  });

  const chantiers = [];
  const tasks = [];
  let chId = 1;
  let taskId = 1;
  const STATUTS = ['todo', 'todo', 'inprogress', 'inprogress', 'review', 'done', 'En attente externe'];
  for (const p of projects) {
    const outside = p.id === projects.length;
    for (let k = 0; k < (outside ? 2 : 4); k++) {
      const start = -90 + ((p.id * 3 + k * 25) % 120);
      const ch = {
        id: chId++,
        Nom_du_chantier: `Chantier ${k + 1} de ${p.nom}`,
        Projets: ['L', p.id],
        Statut: pick(['À cadrer', 'Planifié', 'En réalisation', 'En réalisation', 'Terminé']),
        Debut: day(start),
        Fin: day(start + 120 + k * 30),
        Responsable: outside ? outsiders[0] : isdIds[(p.id + k) % isdIds.length],
        Contributeurs: outside ? ['L', outsiders[1]] : ['L', isdIds[(p.id + k + 3) % isdIds.length]],
        Priorite: k === 0 ? 'P3' : '',
        Criteres_de_succes: 'Critère de succès fictif',
        Description: `Description du chantier ${k + 1}`,
        // Tags : un choix déclaré de la colonne et un tag utilisé mais non déclaré (lot 2e)
        tags: k === 0 ? ['L', 'Intégration de données'] : k === 1 && p.id % 2 ? ['L', 'Projet pilote'] : null,
      };
      chantiers.push(ch);
      // Première carte du Kanban (à faire, échéance la plus proche) : sans personne ni charge, que les tests
      // de bout en bout complètent eux-mêmes
      if (taskId === 1)
        tasks.push({
          id: taskId++,
          titre: 'Tâche 001 · À répartir',
          statut: 'todo',
          dateDebut: day(-370),
          dateEcheance: day(-360),
          projet: p.id,
          Chantier: ch.id,
          parentTask: 0,
          assignees: null,
          charges: '',
          type: 'tache',
          progression: 0,
          Cree_par: 'createur.fictif',
        });
      // Tâches du chantier, autour du jour de référence ; une sur trois a deux sous-tâches
      for (let n = 0; n < 9; n++) {
        const people = outside ? outsiders : [...isdIds, ...managers];
        const who = [people[(taskId * 7) % people.length]];
        if (n % 3 === 1) who.push(people[(taskId * 5 + 1) % people.length]);
        const s = start + n * 14 - 20;
        const len = 7 + (n % 4) * 7;
        const statut = STATUTS[(taskId + k) % STATUTS.length];
        const jalon = n === 8;
        const charges = who.map((id, j) => ({ teamId: id, heures: (len / 7) * (j ? 10.5 : 17.5) }));
        const parent = {
          id: taskId++,
          titre: `Tâche ${String(taskId - 1).padStart(3, '0')} · ${pick(['Analyse', 'Intégration', 'Recette', 'Livraison', 'Documentation', 'Modélisation'])}`,
          description: n % 2 ? 'Description fictive.' : '',
          statut,
          dateDebut: jalon ? null : day(s),
          dateEcheance: day(s + len),
          dateCloture: statut === 'done' ? day(s + len) : null,
          projet: p.id,
          Chantier: ch.id,
          parentTask: 0,
          priorite: n % 4 === 0 ? '3' : '',
          assignees: ['L', ...who],
          Responsable: who[0],
          charges: n % 5 === 4 ? '[]' : JSON.stringify(charges),
          estimationH: 0,
          tempsPasse: 0,
          type: jalon ? 'jalon' : 'tache',
          progression: statut === 'done' ? 100 : (n % 4) * 25,
          // Tags des tâches (colonne sans choix déclarés) : quelques valeurs utilisées
          tags: n === 2 ? ['L', 'atelier'] : n === 5 ? ['L', 'qualité', 'atelier'] : null,
          Cree_par: 'createur.fictif',
        };
        tasks.push(parent);
        if (n % 3 === 0)
          for (const label of ['préparation', 'réalisation']) {
            const sub = who[0];
            tasks.push({
              id: taskId++,
              titre: `${label} (sous-tâche ${String(taskId - 1).padStart(3, '0')})`,
              statut: label === 'préparation' ? 'done' : 'todo',
              dateDebut: day(s),
              dateEcheance: day(s + Math.max(3, len / 2)),
              projet: p.id,
              Chantier: ch.id,
              parentTask: parent.id,
              assignees: ['L', sub],
              Responsable: sub,
              charges: JSON.stringify([{ teamId: sub, heures: 7 }]),
              type: 'tache',
              progression: 0,
              Cree_par: 'createur.fictif',
            });
          }
      }
    }
  }

  // Projet porté par le seul Management ISD (sponsor hors ISD), avec un chantier sans tâche : dans le
  // périmètre ISD, visible dans le Gantt (« Aucune tâche ») et dans « Mes chantiers » du Management
  const pilotage = projects.length + 1;
  projects.push({
    id: pilotage,
    nom: 'Pilotage Management',
    Categorie: 'Projet',
    Statut: SCHEMA.Projects[2][3][0],
    dateDebut: day(-30),
    dateFin: day(150),
    responsable: managers[0],
    Sponsor: ['L', outsiders[0]],
    Contributeurs_cles: null,
    Priorite_de_la_direction: '',
    Commanditaires: 'Direction C',
    Description: 'Projet fictif porté par le Management.',
    actif: true,
  });
  chantiers.push({
    id: chId++,
    Nom_du_chantier: 'Chantier sans tâche du pilotage',
    Projets: ['L', pilotage],
    Statut: 'À cadrer',
    Debut: day(0),
    Fin: day(90),
    Responsable: managers[0],
    Contributeurs: ['L', managers[0]],
    Priorite: '',
    Criteres_de_succes: '',
    Description: 'Chantier fictif sans tâche.',
    tags: null,
  });
  // Variante APH : la personne estimation (DE de l'ISD), sans tâche ; les tests lui ajoutent une charge
  if (aph)
    team.push({
      id: team.length + 1,
      nom: 'Estimation DE',
      role: 'DE',
      actif: true,
      Domaine: ISD,
      email: '',
      aph: ESTIMATION_APH,
      capaciteHebdo: 0,
      n_1: 12,
    });

  const dispos = [
    { id: 1, membre: 1, dateDebut: day(7), dateFin: day(11), dispo: 0, type: 'Congés' },
    { id: 2, membre: 5, dateDebut: day(21), dateFin: day(25), dispo: 0.5, type: 'Formation' },
    { id: 3, membre: 7, dateDebut: day(-30), dateFin: day(-26), dispo: 0, type: 'Congés' },
  ];

  const out = {
    Team: columnar(
      team,
      SCHEMA.Team.map(([c]) => c),
    ),
    Projects: columnar(
      projects,
      SCHEMA.Projects.map(([c]) => c),
    ),
    Chantiers: columnar(
      chantiers,
      SCHEMA.Chantiers.map(([c]) => c),
    ),
    Tasks: columnar(
      tasks,
      SCHEMA.Tasks.map(([c]) => c),
    ),
    Disponibilites: columnar(
      dispos,
      SCHEMA.Disponibilites.map(([c]) => c),
    ),
  };
  const tableIds = Object.keys(SCHEMA);
  const cols = tableIds.flatMap((t, ti) =>
    SCHEMA[t].map(([colId, type, isFormula = 0, choices]) => ({
      parentId: ti + 1,
      colId,
      type,
      isFormula: aph && t === 'Team' && colId === 'aph' ? 0 : isFormula,
      formula: '',
      widgetOptions: choices ? JSON.stringify({ choices }) : '',
    })),
  );
  out._grist_Tables = { id: tableIds.map((_, i) => i + 1), tableId: tableIds };
  out._grist_Tables_column = columnar(
    cols.map((c, i) => ({ id: i + 1, ...c })),
    ['parentId', 'colId', 'type', 'isFormula', 'formula', 'widgetOptions'],
  );
  return out;
}
