/**
 * Recalcul des heures de Tasks.charges à ETP constant quand la période d'une tâche change (glisser, étirer,
 * fiche, fenêtre de création). Fonctions pures, sans écriture : l'envoi est grist-writer.js.
 *
 * L'ETP fait foi : h = ETP × heures de 1 ETP sur la période (periodFte : capacité standard), arrondi à 0,5 h
 * (charges-edit.js). Période de même capacité : rien n'est recalculé. Une entrée n'est réécrite que si
 * ses heures changent ; quand la cible retombe sur les heures de la cellule d'origine (baseRaw), le TEXTE de
 * l'entrée d'origine est remis octet par octet. Doublons, entrées invalides et cellule illisible ne sont jamais
 * touchés.
 */
import { etpToHours, hoursToEtp } from './capacity.js';
import {
  HOURS_PER_WEEK_FTE,
  HOURS_STEP,
  chargeRows,
  entryHours,
  entryTeamId,
  inputValue,
  readChargesCell,
  roundEtp,
  roundHours,
  setPersonHours,
} from './charges-edit.js';

/**
 * @typedef {{etp:number|null, heures:number, fte:number|null}} ChargeRef
 *   fte : heures de 1 ETP sur la période de la référence ; etp null : période inconnue (les heures sont alors gardées)
 */

/**
 * Référence de chaque personne qui a exactement UNE entrée valide (doublons et entrées invalides exclus).
 * @param {string|null} raw cellule brute
 * @param {number|null} fte heures de 1 ETP sur la période de la cellule (periodFte)
 * @returns {Map<number, ChargeRef>} vide si la cellule est illisible
 */
export function chargeRefs(raw, fte) {
  const cell = readChargesCell(raw);
  const refs = new Map();
  if (!cell.ok) return refs;
  for (const r of chargeRows(cell.entries).rows)
    if (r.count === 1) refs.set(r.teamId, { etp: fte ? hoursToEtp(r.heures, fte) : null, heures: r.heures, fte });
  return refs;
}

/**
 * Référence d'une saisie : en ETP, l'ETP saisi fait foi (exact) ; en heures, l'ETP est déduit de la période.
 * @param {{heures:number, etp?:number|null, fte:number|null}} input
 * @returns {ChargeRef}
 */
export function refFromInput({ heures, etp, fte }) {
  if (etp !== undefined && etp !== null) return { etp, heures, fte };
  return { etp: fte ? hoursToEtp(heures, fte) : null, heures, fte };
}

/**
 * Références après une nouvelle base (ligne relue, conflit résolu) : celles des personnes saisies dans le formulaire
 * (typed) sont gardées, les autres suivent la cellule de la base (absentes de la base : retirées).
 * @param {Map<number, ChargeRef>} refs
 * @param {Set<number>} typed personnes dont la charge a été saisie dans le formulaire
 * @param {string|null} baseRaw cellule de la nouvelle base
 * @param {number|null} baseFte heures de 1 ETP sur sa période
 * @returns {Map<number, ChargeRef>}
 */
export function followBaseRefs(refs, typed, baseRaw, baseFte) {
  const out = new Map([...refs].filter(([teamId]) => typed.has(teamId)));
  for (const [teamId, ref] of chargeRefs(baseRaw, baseFte)) if (!typed.has(teamId)) out.set(teamId, ref);
  return out;
}

/**
 * Heures de la référence sur une autre période : gardées sans ETP, sans période d'arrivée ou à capacité égale ;
 * sinon ETP × heures de 1 ETP de la nouvelle période, arrondi à 0,5 h, au moins 0,5 h pour un ETP non nul.
 * @param {ChargeRef} ref
 * @param {number|null} toFte heures de 1 ETP sur la nouvelle période (periodFte)
 */
export function rescaledHours(ref, toFte) {
  if (ref.etp === null || !toFte || toFte === ref.fte) return ref.heures;
  const h = roundHours(etpToHours(ref.etp, toFte));
  return ref.etp > 0 ? Math.max(h, HOURS_STEP) : h;
}

/**
 * Valeur affichée dans la case de saisie d'une ligne : celle de sa référence (ETP saisi, ou ETP × 35 en h/semaine)
 * tant que les heures de la ligne sont celles que la référence donne sur la période (une saisie « 14 » reste
 * « 14 » après un nouveau rendu ou un changement de dates) ; sinon déduite des heures (inputValue).
 * @param {number} heures heures de la ligne
 * @param {'etp'|'hsem'} unit
 * @param {number|null} fte heures de 1 ETP sur la période (periodFte)
 * @param {ChargeRef|null|undefined} ref
 * @returns {number|null} null sans période
 */
export function displayValue(heures, unit, fte, ref) {
  if (!fte) return null;
  if (ref && ref.etp !== null && rescaledHours(ref, fte) === heures)
    return unit === 'hsem' ? Math.round(ref.etp * HOURS_PER_WEEK_FTE * 10) / 10 : roundEtp(ref.etp);
  return inputValue(heures, unit, fte);
}

/** Entrée valide unique d'une personne dans une cellule lisible : {index, heures, text}, sinon null. */
function onlyEntry(cell, teamId) {
  if (!cell.ok) return null;
  const found = [];
  cell.entries.forEach((e, index) => {
    if (e !== null && typeof e === 'object' && entryTeamId(e) === teamId && entryHours(e) !== null)
      found.push({ index, heures: entryHours(e), text: cell.texts[index] });
  });
  return found.length === 1 ? found[0] : null;
}

/**
 * Recalcule, pour chaque personne de refs qui a toujours une seule entrée valide dans raw, les heures sur la
 * nouvelle période. Cible au-dessus de maxOf(teamId) : entrée laissée telle quelle et signalée (over). Cible égale
 * aux heures de la personne dans baseRaw : texte d'origine remis ; sinon setPersonHours.
 * @param {string|null} raw cellule à recalculer
 * @param {Map<number, ChargeRef>} refs
 * @param {number|null} toFte heures de 1 ETP sur la nouvelle période (periodFte)
 * @param {{baseRaw?:string|null, maxOf?:(teamId:number) => number}} [opts]
 * @returns {{raw:string|null, changed:number[], over:number[]}} raw rendu tel quel (même référence) si rien ne change
 */
export function rescaleCharges(raw, refs, toFte, { baseRaw = null, maxOf = () => Infinity } = {}) {
  const changed = [];
  const over = [];
  if (!refs.size || !readChargesCell(raw).ok) return { raw, changed, over };
  const baseCell = readChargesCell(baseRaw);
  let out = raw;
  for (const [teamId, ref] of refs) {
    const cell = readChargesCell(out);
    const now = onlyEntry(cell, teamId);
    if (!now) continue;
    const target = rescaledHours(ref, toFte);
    if (target === now.heures) continue;
    if (target > maxOf(teamId) + 1e-9) {
      over.push(teamId);
      continue;
    }
    const original = onlyEntry(baseCell, teamId);
    let next;
    if (original && original.heures === target) {
      if (original.text === now.text) continue;
      const texts = [...cell.texts];
      texts[now.index] = original.text;
      next = `[${texts.join(',')}]`;
    } else next = setPersonHours(out, teamId, target);
    out = next;
    changed.push(teamId);
  }
  return { raw: out, changed, over };
}
