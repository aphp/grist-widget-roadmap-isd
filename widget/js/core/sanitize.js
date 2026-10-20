/** Échappement HTML et gabarit html`` qui échappe toute valeur interpolée. */
export function sanitize(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Fragment déjà sûr : seule instance acceptée sans échappement (marqueur privé, non forgeable par une donnée). */
class SafeHtml {
  #html;

  constructor(html) {
    this.#html = html;
  }

  toString() {
    return this.#html;
  }
}

/** Marque un fragment comme déjà sûr (produit par html`` ou constant). */
export function raw(s) {
  return new SafeHtml(String(s));
}

function piece(v) {
  if (Array.isArray(v)) return v.map(piece).join('');
  if (v instanceof SafeHtml) return v.toString();
  return sanitize(v);
}

export function html(strings, ...values) {
  return strings.reduce((out, s, i) => out + s + (i < values.length ? piece(values[i]) : ''), '');
}
