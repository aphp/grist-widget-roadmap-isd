"""Contrôle des écritures du widget dans le DOCUMENT DE TEST, en lecture seule (GET uniquement).

    uv run python grist-widget-isd/tools/check_writes.py save [fichier]
    uv run python grist-widget-isd/tools/check_writes.py check [fichier]
    uv run python grist-widget-isd/tools/check_writes.py diff [fichier] --allow Tasks.statut,Tasks.dateCloture

- save  : photographie les tables du widget et leur structure (colonnes, types, options) dans un fichier JSON
          (par défaut .check_writes.json à côté de ce script, à ne pas versionner : données nominatives) ;
- check : échoue si une cellule ou la structure a changé depuis la photographie ;
- diff  : liste les cellules modifiées, ajoutées ou supprimées ; échoue sur toute modification hors de --allow
          (Table.colonne, séparées par des virgules) et sur toute modification de structure.

Ne lit que le document de test (grist_api.WRITABLE) : la Feuille de route EDS est modifiée en permanence par
d'autres, une comparaison n'y aurait pas de sens. Le script n'écrit jamais dans Grist.
"""
import json
import sys
from pathlib import Path

from grist_api import WRITABLE, columns, records

TABLES = ["Team", "Projects", "Chantiers", "Tasks", "Disponibilites"]
DEFAULT = Path(__file__).resolve().parent / ".check_writes.json"


def photograph(doc=WRITABLE):
    """Cellules et structure des tables du widget, en lecture seule."""
    out = {"cells": {}, "structure": {}}
    for t in TABLES:
        out["cells"][t] = {str(k): v for k, v in records(doc, t).items()}
        out["structure"][t] = {
            c["id"]: {k: c["fields"].get(k) for k in ("type", "isFormula", "formula", "widgetOptions")}
            for c in columns(doc, t)
        }
    return out


def compare(before, after):
    """(modifications de cellules, modifications de structure) : listes de tuples lisibles."""
    cells, structure = [], []
    for t in TABLES:
        b, a = before["cells"].get(t, {}), after["cells"].get(t, {})
        for rid in sorted(set(b) | set(a), key=int):
            if rid not in a:
                cells.append((t, rid, "*", "ligne supprimée"))
            elif rid not in b:
                cells.append((t, rid, "*", "ligne ajoutée"))
            else:
                for col in sorted(set(b[rid]) | set(a[rid])):
                    if b[rid].get(col) != a[rid].get(col):
                        cells.append((t, rid, col, f"{b[rid].get(col)!r} → {a[rid].get(col)!r}"))
        if before["structure"].get(t) != after["structure"].get(t):
            structure.append(t)
    return cells, structure


def main(argv):
    if not argv or argv[0] not in ("save", "check", "diff"):
        print(__doc__)
        return 2
    cmd, rest = argv[0], argv[1:]
    allow = set()
    if "--allow" in rest:
        i = rest.index("--allow")
        allow = {x.strip() for x in rest[i + 1].split(",") if x.strip()}
        rest = rest[:i] + rest[i + 2 :]
    path = Path(rest[0]) if rest else DEFAULT
    if cmd == "save":
        path.write_text(json.dumps(photograph(), ensure_ascii=False))
        print(f"photographie du document de test → {path}")
        return 0
    before = json.loads(path.read_text())
    cells, structure = compare(before, photograph())
    for t in structure:
        print(f"STRUCTURE MODIFIÉE : {t}")
    bad = []
    for t, rid, col, what in cells:
        ok = cmd == "diff" and col != "*" and f"{t}.{col}" in allow
        print(f"{'  ' if ok else '✗ '}{t} n° {rid} · {col} : {what}")
        if not ok:
            bad.append((t, rid, col))
    if structure or bad:
        print(f"ÉCHEC : {len(bad)} modification(s) non autorisée(s), {len(structure)} table(s) à la structure modifiée")
        return 1
    print("OK : aucune modification" if not cells else f"OK : {len(cells)} modification(s), toutes autorisées")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
