"""Copie LECTURE SEULE du document de test → dev/data/snapshot.json, au format de fetchTable.

    uv run python grist-widget-isd/tools/export_test_snapshot.py     (depuis la racine pmo-writer)

Contient des données nominatives : dev/data/ est exclu de git.
Repli : si l'API /records refuse les tables _grist_* (4xx), elles sont lues via l'endpoint sql (SELECT *).
"""
import json
from pathlib import Path

import requests

from grist_api import WRITABLE, columns, get

OUT = Path(__file__).resolve().parents[1] / "dev/data/snapshot.json"
TABLES = ["Team", "Projects", "Chantiers", "Tasks", "Disponibilites", "_grist_Tables", "_grist_Tables_column"]


def columnar(doc, table):
    try:
        recs = get(doc, f"tables/{table}/records", hidden="true")["records"]
        # Une table vide n'a aucun champ dans /records : les colonnes réelles viennent de /columns.
        cols = sorted({k for r in recs for k in r["fields"]} | {c["id"] for c in columns(doc, table)})
        return {"id": [r["id"] for r in recs], **{c: [r["fields"].get(c) for r in recs] for c in cols}}
    except (requests.HTTPError, RuntimeError, KeyError):
        if not table.startswith("_grist"):
            raise
        # Repli SQL pour les métadonnées (lecture seule, SELECT uniquement).
        rows = get(doc, "sql", q=f"select * from {table}")["records"]
        rows = [r.get("fields", r) for r in rows]
        cols = sorted({k for r in rows for k in r if k != "id"})
        return {"id": [r["id"] for r in rows], **{c: [r.get(c) for r in rows] for c in cols}}


OUT.parent.mkdir(parents=True, exist_ok=True)
data = {t: columnar(WRITABLE, t) for t in TABLES}
OUT.write_text(json.dumps(data, ensure_ascii=False))
print({t: len(v["id"]) for t, v in data.items()}, "→", OUT)
