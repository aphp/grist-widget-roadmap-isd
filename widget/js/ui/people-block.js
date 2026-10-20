/**
 * Contrôleur du bloc « Personnes » (assignés et charges réunis), partagé par la fiche tâche (ui/task-editor.js,
 * identifiants « tf- ») et les fenêtres « Nouvelle tâche » / « Sous-tâche » (ui/create-dialog.js, « cf- »).
 * Les règles sont celles de core/task-people.js et core/charges-edit.js ; le rendu, views/task-form.js. Aucune
 * écriture ici : le brouillon change seulement par applyDraft, qui relit les droits du formulaire hôte.
 */
import {
  chargeRows,
  isEstimationPerson,
  maxHours,
  mergeDuplicates,
  periodDays,
  readChargesCell,
} from '../core/charges-edit.js';
import { chargeRefs, followBaseRefs, refFromInput, rescaleCharges } from '../core/charges-rescale.js';
import { addPersonLine, assignPerson, lineInput, removePersonLine } from '../core/task-people.js';
import { chargeEqText, chargeRowMsgs, peopleBlockHtml, peopleCtx } from '../views/task-form.js';

/** Régions « aria-live » du bloc (suffixes d'identifiants), conservées d'un rendu à l'autre. */
const LIVE = ['charges-foot', 'assignees-msgs', 'charges-msgs'];

/** Unité de saisie mémorisée dans le navigateur (même choix dans la fiche et les fenêtres de création). */
export const UNIT_KEY = 'roadmap-isd.chargesUnit';

/** Unité de saisie des charges, mémorisée (ETP par défaut). */
export function storedUnit(storage) {
  try {
    return storage?.getItem(UNIT_KEY) === 'heures' ? 'heures' : 'etp';
  } catch {
    return 'etp';
  }
}

/**
 * État propre au bloc, à fusionner dans celui du formulaire hôte. chargeRefs : ETP de référence de chaque personne
 * (l'ETP fait foi quand les dates changent), pris sur la ligne à l'ouverture de la fiche (base), puis à chaque
 * saisie ; chargesTyped : personnes dont la charge a été saisie (ou retirée) ici, leur référence ne suit plus la
 * base ; chargesDays : période du dernier recalcul ; chargesKeptOver : personnes laissées au-dessus de la borne au
 * dernier changement de période.
 * @param {Storage} [storage]
 * @param {{charges?:string|null, dateDebut:number|null, dateEcheance:number|null}|null} [base] ligne de la tâche
 */
export const peopleState = (storage, base = null) => ({
  chargeErrors: new Map(),
  chargeInputs: new Map(),
  chargeRefs: base ? chargeRefs(base.charges ?? null, periodDays(base.dateDebut, base.dateEcheance)) : new Map(),
  chargesTyped: new Set(),
  chargesDays: base ? periodDays(base.dateDebut, base.dateEcheance) : null,
  chargesKeptOver: new Set(),
  chargesUnit: storedUnit(storage),
  confirmReplace: false,
});

/**
 * Nouvelle base de la fiche (ligne relue, conflit résolu, rebaseDraft) : les références des personnes non saisies ici
 * suivent ses charges, et leurs heures du brouillon sont recalculées depuis elles sur la période du brouillon (sinon
 * des heures recalculées avant la relecture écraseraient en silence celles de la Feuille ; période égale à la base :
 * texte de la base remis). Les personnes saisies gardent leur valeur (fusion et conflits inchangés).
 * @param {object} s état du formulaire (draft, base, chargeRefs, chargesTyped)
 * @param {object} model modèle (bornes de la personne estimation)
 * @param {{rescale?:boolean}} [opts] rescale : faux quand les charges viennent d'être reprises telles quelles de la
 *   base (« Rétablir », conflit tranché pour la Feuille)
 */
export function followBase(s, model, { rescale = true } = {}) {
  if (!s?.chargeRefs || !s.base || !('charges' in s.draft)) return;
  const baseRaw = s.base.charges ?? null;
  s.chargeRefs = followBaseRefs(
    s.chargeRefs,
    s.chargesTyped,
    baseRaw,
    periodDays(s.base.dateDebut, s.base.dateEcheance),
  );
  const days = periodDays(s.draft.dateDebut, s.draft.dateEcheance);
  const untyped = new Map([...s.chargeRefs].filter(([teamId]) => !s.chargesTyped.has(teamId)));
  const maxOf = (teamId) => maxHours(days, isEstimationPerson(model, teamId));
  const r = rescale
    ? rescaleCharges(s.draft.charges, untyped, days, { baseRaw, maxOf })
    : { raw: s.draft.charges, over: [] };
  s.draft = r.raw === s.draft.charges ? s.draft : { ...s.draft, charges: r.raw };
  s.chargesDays = days;
  s.chargesKeptOver = keptOverOf(s.draft.charges, r.over, maxOf);
}

/**
 * Personnes laissées au-dessus de la borne : refusées par le recalcul (over), ou jamais recalculées (heures saisies
 * sans dates, doublons).
 */
function keptOverOf(raw, over, maxOf) {
  const cell = readChargesCell(raw);
  const rows = cell.ok ? chargeRows(cell.entries).rows : [];
  return new Set([...over, ...rows.filter((x) => x.heures > maxOf(x.teamId)).map((x) => x.teamId)]);
}

/**
 * @param {{state():object|null, getModel():object, storage?:Storage, applyDraft(next:object, focusId?:string):boolean,
 *   validate():void, refresh():void, blockOpts?():object}} deps
 *   state : état du formulaire hôte (draft, prefix, can, busy…) ; applyDraft : remplace le brouillon si les droits
 *   le permettent (sinon redessine et rend faux) ; refresh : mise à jour légère (messages, pied) ; blockOpts :
 *   options de rendu du bloc (aide courte)
 */
export function createPeopleBlock(deps) {
  const st = () => deps.state();
  const model = () => deps.getModel();
  const id = (suffix) => `${st().prefix ?? 'tf'}-${suffix}`;
  const el = (suffix) => document.getElementById(id(suffix));

  /**
   * Redessine le bloc dans son conteneur en gardant en place les régions « aria-live » (pied, messages des
   * assignés et des charges) : leur contenu change, elles ne sont pas recréées, donc l'erreur bloquante apparue
   * après un changement de dates est annoncée.
   */
  function patch(box, html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const fresh = tpl.content.firstElementChild;
    const live = new Set(LIVE.map(id));
    const kept = new Map([...box.children].filter((c) => live.has(c.id)).map((c) => [c.id, c]));
    box.className = fresh.className;
    for (const c of [...box.children]) if (!kept.has(c.id)) c.remove();
    let cursor = null;
    for (const f of [...fresh.children]) {
      const old = kept.get(f.id);
      if (old) old.innerHTML = f.innerHTML;
      const node = old ?? f;
      if (!old) cursor ? cursor.after(node) : box.prepend(node);
      cursor = node;
    }
    for (const [k, c] of kept) if (!fresh.querySelector(`:scope > #${k}`)) c.remove();
  }

  /** Redessine le seul bloc (dates, unité ou lignes changées), sans toucher au reste du formulaire. */
  function render(focusId) {
    deps.validate();
    const box = el('people');
    if (box) patch(box, peopleBlockHtml(st(), model(), deps.blockOpts?.() ?? {}).toString());
    deps.refresh();
    if (focusId) document.getElementById(focusId)?.focus();
  }

  /** Champ de charge d'une ligne s'il est modifiable, sinon son bouton de retrait, sinon l'ajout. */
  function lineFocus(teamId) {
    const input = el(`ch-${teamId}`);
    if (input && !input.disabled) return input.id;
    return el(`person-${teamId}-remove`) ? id(`person-${teamId}-remove`) : id('assignees');
  }

  /** Ligne réaffichée seule (équivalent, messages), sans redessiner les champs. */
  function lineRefresh(teamId, days) {
    const s = st();
    const cell = readChargesCell(s.draft.charges);
    const row = cell.ok ? chargeRows(cell.entries).rows.find((x) => x.teamId === teamId) : null;
    const line = {
      teamId,
      assigned: s.draft.assignees.includes(teamId),
      charged: Boolean(row),
      heures: row ? row.heures : null,
      count: row ? row.count : 0,
      known: model().people.has(teamId),
    };
    const eq = el(`ch-${teamId}-eq`);
    if (eq) eq.textContent = row && !s.chargeErrors.has(teamId) ? chargeEqText(s, row.heures, days) : '';
    const msg = el(`ch-${teamId}-msg`);
    if (msg) msg.innerHTML = chargeRowMsgs(s, model(), line, peopleCtx(s)).toString();
  }

  /** Charge saisie sur une ligne : brouillon mis à jour si la valeur est valide, sinon erreur sous la ligne. */
  function chargeInput(t) {
    const s = st();
    const teamId = Number(t.dataset.chargeInput);
    const days = periodDays(s.draft.dateDebut, s.draft.dateEcheance);
    // Personne estimation (Team.aph) : pas de borne de 1 ETP, seulement la borne de bon sens
    const estimation = isEstimationPerson(model(), teamId);
    const r = lineInput(s.draft, teamId, t.value, s.chargesUnit, days, { estimation });
    if (r.error) {
      s.chargeErrors.set(teamId, r.error);
      s.chargeInputs.set(teamId, t.value);
      t.setAttribute('aria-invalid', 'true');
    } else {
      if (!deps.applyDraft({ ...s.draft, charges: r.charges })) return;
      s.chargeErrors.delete(teamId);
      s.chargeInputs.delete(teamId);
      // La saisie devient la référence de la ligne (seulement elle : les autres lignes ne sont pas recalculées)
      if (r.heures === null) s.chargeRefs.delete(teamId);
      else s.chargeRefs.set(teamId, refFromInput({ heures: r.heures, etp: r.etp, days }));
      s.chargesTyped.add(teamId);
      s.chargesKeptOver.delete(teamId);
      t.removeAttribute('aria-invalid');
    }
    lineRefresh(teamId, days);
    deps.refresh();
  }

  /** Événement « input » : saisie d'une charge. @returns {boolean} vrai si l'événement concernait le bloc */
  function onInput(t) {
    if (!t.dataset.chargeInput) return false;
    chargeInput(t);
    return true;
  }

  /** Événement « change » : ajout d'une personne, unité de saisie. @returns {boolean} */
  function onChange(t) {
    const s = st();
    if (t.dataset.personAdd !== undefined) {
      if (!t.value) return true;
      // « Ajouter une personne… » : elle est assignée, sa charge (facultative) est à saisir sur sa ligne
      const teamId = Number(t.value);
      if (!deps.applyDraft(addPersonLine(s.draft, teamId), id('people-title'))) return true;
      render();
      document.getElementById(lineFocus(teamId))?.focus();
      return true;
    }
    if (t.dataset.chargesUnit !== undefined) {
      s.chargesUnit = t.value === 'heures' ? 'heures' : 'etp';
      s.chargeErrors.clear();
      s.chargeInputs.clear();
      try {
        deps.storage?.setItem(UNIT_KEY, s.chargesUnit);
      } catch {
        // stockage indisponible : le choix vaut pour la session
      }
      render(t.id);
      return true;
    }
    return false;
  }

  /** Clic sur un bouton du bloc : retrait, assignation, fusion, remplacement d'une cellule illisible. */
  function onClick(t) {
    const s = st();
    const title = id('people-title');
    if (t.dataset.personRemove) {
      // Retirer une ligne : assignation et charge de la personne, dans le même brouillon (un seul lot)
      const teamId = Number(t.dataset.personRemove);
      if (!deps.applyDraft(removePersonLine(s.draft, teamId), title)) return true;
      s.chargeErrors.delete(teamId);
      s.chargeInputs.delete(teamId);
      s.chargeRefs.delete(teamId);
      s.chargesTyped.add(teamId);
      s.chargesKeptOver.delete(teamId);
      render(el('assignees') ? id('assignees') : title);
      return true;
    }
    if (t.dataset.personAssign) {
      // Charge sans assignation : assignée seulement sur demande (jamais d'office)
      const teamId = Number(t.dataset.personAssign);
      if (!deps.applyDraft(assignPerson(s.draft, teamId), title)) return true;
      render();
      document.getElementById(lineFocus(teamId))?.focus();
      return true;
    }
    if (t.dataset.chargeMerge) {
      const teamId = Number(t.dataset.chargeMerge);
      if (!deps.applyDraft({ ...s.draft, charges: mergeDuplicates(s.draft.charges, teamId) }, title)) return true;
      // Entrée fusionnée : référence prise sur la période du brouillon
      const ref = chargeRefs(s.draft.charges, periodDays(s.draft.dateDebut, s.draft.dateEcheance)).get(teamId);
      if (ref) s.chargeRefs.set(teamId, ref);
      else s.chargeRefs.delete(teamId);
      s.chargesTyped.add(teamId);
      render(id(`ch-${teamId}`));
      return true;
    }
    if (t.dataset.charges) {
      // Cellule illisible : remplacement par une saisie vide, seulement après confirmation
      const a = t.dataset.charges;
      if (a === 'replace-confirm' && !deps.applyDraft({ ...s.draft, charges: '[]' }, title)) return true;
      s.confirmReplace = a === 'replace-ask';
      render(
        id(a === 'replace-ask' ? 'charges-replace-confirm' : a === 'replace-confirm' ? 'assignees' : 'charges-replace'),
      );
      return true;
    }
    return false;
  }

  /**
   * Dates du brouillon changées (champ de date, case « Jalon ») : si la période diffère de celle du dernier recalcul
   * (chargesDays ; une date de clôture n'y touche pas), l'ETP de référence de chaque ligne est gardé et ses heures
   * recalculées (rescaleCharges). Une ligne qui dépasserait la borne est laissée telle quelle et signalée
   * (chargesKeptOver), comme une ligne non recalculée au-dessus de la borne. Retour aux dates d'origine : texte
   * d'origine des entrées remis. Refus des droits : charges inchangées.
   * @param {{render?:boolean}} [opts] render : faux si l'hôte redessine tout le formulaire ensuite
   */
  function onDatesChanged({ render: redraw = true } = {}) {
    const s = st();
    const days = periodDays(s.draft.dateDebut, s.draft.dateEcheance);
    if (days === s.chargesDays) {
      if (redraw) render();
      return;
    }
    const maxOf = (teamId) => maxHours(days, isEstimationPerson(model(), teamId));
    const r = rescaleCharges(s.draft.charges, s.chargeRefs, days, { baseRaw: s.base?.charges ?? null, maxOf });
    if (r.raw !== s.draft.charges && !deps.applyDraft({ ...s.draft, charges: r.raw })) return;
    s.chargesDays = days;
    s.chargesKeptOver = keptOverOf(s.draft.charges, r.over, maxOf);
    if (redraw) render();
  }

  return { render, lineFocus, onInput, onChange, onClick, onDatesChanged };
}
