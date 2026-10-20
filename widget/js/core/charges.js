/** Lecture défensive de Tasks.charges : JSON [{teamId, heures}], heures = total de la personne sur la tâche. */

/** teamId : entier > 0, ou chaîne de chiffres représentant un entier > 0. */
function parseTeamId(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/** heures : nombre fini ≥ 0, ou chaîne non vide qui se lit comme tel. */
function parseHeures(v) {
  let n = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
  return n !== null && Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseCharges(raw) {
  if (raw === null || raw === undefined || raw === '') return { charges: [], error: null };
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { charges: [], error: 'json' };
  }
  if (!Array.isArray(data)) return { charges: [], error: 'format' };
  const charges = [];
  let bad = false;
  for (const x of data) {
    const personId = parseTeamId(x?.teamId);
    const heures = parseHeures(x?.heures);
    if (personId === null || heures === null) {
      bad = true;
      continue;
    }
    charges.push({ personId, heures });
  }
  return { charges, error: bad ? 'entree' : null };
}
