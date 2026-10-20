"""Photographie du schéma de la Feuille de route EDS (LECTURE SEULE) → schema/feuille_schema.json + docs/schema-feuille.md.

    uv run python grist-widget-isd/tools/snapshot_schema.py

À relancer quand la Feuille change de structure : le widget s'appuie sur ces noms de colonnes et ces choix.
"""
import collections
import datetime as dt
import json
from pathlib import Path

from grist_api import CFG, columns, records, tables

HERE = Path(__file__).resolve().parents[1]
DOC = CFG["doc_id"]
KEEP = ["Team", "Projects", "Chantiers", "Tasks", "Disponibilites"]

schema = {"doc_id": DOC, "snapshot": dt.date.today().isoformat(), "tables": {}}
for t in tables(DOC):
    cols = []
    for c in columns(DOC, t):
        f = c["fields"]
        if c["id"].startswith("gristHelper") or c["id"] == "manualSort":
            continue
        wo = json.loads(f.get("widgetOptions") or "{}")
        cols.append({"id": c["id"], "label": f.get("label"), "type": f.get("type"),
                     "formula": f.get("formula") if f.get("isFormula") else None,
                     "choices": wo.get("choices"), "choiceOptions": wo.get("choiceOptions"),
                     "visibleCol": f.get("visibleCol") or None})
    schema["tables"][t] = {"columns": cols, "rows": len(records(DOC, t))}
(HERE / "schema").mkdir(exist_ok=True)
json.dump(schema, open(HERE / "schema/feuille_schema.json", "w"), ensure_ascii=False, indent=1)

# Valeurs réellement utilisées (aide à la conception)
T = records(DOC, "Team")
roles = collections.Counter((t["role"] or "—", bool(t["actif"])) for t in T.values())
cap = collections.Counter(t["capaciteHebdo"] for t in T.values() if t["role"] in ("DE", "DS", "DA", "PO Data", "Management"))
K = records(DOC, "Tasks")
st = collections.Counter(t["statut"] or "—" for t in K.values())
ty = collections.Counter(t["type"] or "—" for t in K.values())
ch = sum(1 for t in K.values() if (t["charges"] or "[]") != "[]")

md = [f"# Schéma de la Feuille de route EDS (`{DOC}`)", "",
      f"*Photographie du {schema['snapshot']}, générée par `tools/snapshot_schema.py`. Ne pas éditer à la main.*", ""]
for t in KEEP + [x for x in schema["tables"] if x not in KEEP]:
    if t not in schema["tables"]:
        continue
    md += [f"## {t} ({schema['tables'][t]['rows']} lignes)", "", "| Colonne | Libellé | Type | Choix / formule |", "|---|---|---|---|"]
    for c in schema["tables"][t]["columns"]:
        extra = ("= " + c["formula"]) if c["formula"] else (", ".join(c["choices"]) if c["choices"] else "")
        md.append(f"| `{c['id']}` | {c['label'] or ''} | {c['type']} | {extra.replace('|', '/')} |")
    md.append("")
md += ["## Valeurs observées", "",
       "- Rôles de `Team` (rôle, actif) : " + ", ".join(f"{r} {'actif' if a else 'inactif'} ×{n}" for (r, a), n in sorted(roles.items())),
       "- `Team.capaciteHebdo` (rôles ISD + Management) : " + ", ".join(f"{k!r} ×{n}" for k, n in cap.most_common()),
       "- `Tasks.statut` : " + ", ".join(f"{k} ×{n}" for k, n in st.most_common()),
       "- `Tasks.type` : " + ", ".join(f"{k} ×{n}" for k, n in ty.most_common()),
       f"- `Tasks.charges` renseigné : {ch} tâches sur {len(K)}", ""]
(HERE / "docs/schema-feuille.md").write_text("\n".join(md), encoding="utf-8")
print(f"Schéma : {len(schema['tables'])} tables → schema/feuille_schema.json, docs/schema-feuille.md")
