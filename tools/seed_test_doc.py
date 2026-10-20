"""Copie la Feuille de route EDS (lecture) dans le document de test (écriture), à l'identique :
mêmes tables, mêmes colonnes (types, choix), mêmes ids de lignes → les Ref / RefList restent valides.

    uv run python grist-widget-isd/tools/seed_test_doc.py            # crée les tables absentes et les remplit
    uv run python grist-widget-isd/tools/seed_test_doc.py --reset    # vide d'abord les tables copiées du document de test

Seules les tables de la Feuille sont touchées dans le document de test (Table1 et les pages restent). Les pièces jointes
(colonnes Attachments) ne sont pas copiées.
"""
import argparse
import json

from grist_api import CFG, WRITABLE, apply, columns, records, sql, tables

SRC = CFG["doc_id"]
COPY = ["Team", "Projects", "Chantiers", "Tasks", "Disponibilites"]

ap = argparse.ArgumentParser()
ap.add_argument("--reset", action="store_true", help="supprime toutes les lignes des tables copiées avant de recopier")
args = ap.parse_args()

src_cols = {t: [c for c in columns(SRC, t) if c["id"] != "manualSort" and not c["id"].startswith("gristHelper")] for t in COPY}
have = set(tables(WRITABLE))

# 1) Tables vides d'abord (les Ref croisées Chantiers ↔ Tasks exigent que toutes les cibles existent), puis colonnes.
actions = [["AddTable", t, []] for t in COPY if t not in have]
if actions:
    apply(WRITABLE, actions)
for t in COPY:
    dst = {c["id"] for c in columns(WRITABLE, t)}
    add = []
    for c in src_cols[t]:
        f = c["fields"]
        if c["id"] in dst or f["type"] == "Attachments":
            continue
        info = {"type": f["type"], "label": f.get("label") or c["id"], "widgetOptions": f.get("widgetOptions") or "",
                "isFormula": bool(f.get("isFormula")), "formula": f.get("formula") or ""}
        add.append(["AddColumn", t, c["id"], info])
    if add:
        apply(WRITABLE, add)
    # colonne de visualisation des Ref (visibleCol) : on la recopie par id de colonne cible
    print(f"{t} : {len(add)} colonnes ajoutées")

# 2) Données, avec les ids d'origine
for t in COPY:
    if args.reset:
        ids = list(records(WRITABLE, t))
        if ids:
            apply(WRITABLE, [["BulkRemoveRecord", t, ids]])
    rows = records(SRC, t)
    existing = set(records(WRITABLE, t))
    todo = {i: r for i, r in rows.items() if i not in existing}
    keep = [c["id"] for c in src_cols[t] if c["fields"]["type"] != "Attachments" and not c["fields"].get("isFormula")]
    ids = sorted(todo)
    for k in range(0, len(ids), 200):
        part = ids[k:k + 200]
        apply(WRITABLE, [["BulkAddRecord", t, part, {c: [todo[i].get(c) for i in part] for c in keep}]])
    print(f"{t} : {len(ids)} lignes copiées ({len(rows)} dans la Feuille)")

# 3) Libellés des Ref : même colonne affichée que dans la Feuille (ex. Team.nom), sinon les cellules montrent l'id
Q = ("select t.tableId, c.colId, c.id as ref, c.visibleCol, v.colId as visId from _grist_Tables_column c "
     "join _grist_Tables t on t.id = c.parentId left join _grist_Tables_column v on v.id = c.visibleCol")
vis_src = {(r["tableId"], r["colId"]): r["visId"] for r in sql(SRC, Q) if r["visId"]}
dst_meta = {(r["tableId"], r["colId"]): r for r in sql(WRITABLE, Q)}
fix = []
for (t, col), vis in vis_src.items():
    d = dst_meta.get((t, col))
    if t not in COPY or not d or d["visId"] == vis:
        continue
    target = next((c["fields"]["type"].split(":", 1)[1] for c in src_cols[t] if c["id"] == col), None)
    vref = dst_meta.get((target, vis))
    if vref:
        fix += [["ModifyColumn", t, col, {"visibleCol": vref["ref"]}], ["SetDisplayFormula", t, None, d["ref"], f"${col}.{vis}"]]
if fix:
    apply(WRITABLE, fix)
print(f"Libellés de {len(fix) // 2} colonnes Ref alignés sur la Feuille")
print("Terminé :", json.dumps({t: len(records(WRITABLE, t)) for t in COPY}))
