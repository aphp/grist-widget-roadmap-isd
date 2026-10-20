"""Ajoute (ou met à jour) dans le document de test une page « Roadmap ISD » contenant le widget personnalisé.

    uv run python grist-widget-isd/tools/install_test_page.py [url]     # défaut : http://localhost:8770/

Écrit UNIQUEMENT dans le document de test (grist_api.apply refuse tout autre document). L'URL est chargée par le
navigateur de la personne qui ouvre la page : localhost ne fonctionne donc que sur le poste qui fait tourner dev/serve.py.
"""
import json
import sys

from grist_api import WRITABLE, apply, sql

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8770/"
PAGE = "Roadmap ISD"


def custom_options(url):
    view = {"mode": "url", "url": url, "widgetDef": None, "access": "full", "pluginId": "", "sectionId": ""}
    return json.dumps({"customView": json.dumps(view)})


existing = sql(
    WRITABLE,
    "select s.id from _grist_Views_section s join _grist_Views v on s.parentId = v.id "
    f"where v.name = '{PAGE}' and s.parentKey = 'custom'",
)
if existing:
    sec = existing[0]["id"]
else:
    tasks = sql(WRITABLE, "select id from _grist_Tables where tableId = 'Tasks'")[0]["id"]
    res = apply(WRITABLE, [["CreateViewSection", tasks, 0, "custom", None, None]])
    out = res["retValues"][0]
    sec = out["sectionRef"]
    apply(WRITABLE, [["UpdateRecord", "_grist_Views", out["viewRef"], {"name": PAGE}]])
apply(WRITABLE, [["UpdateRecord", "_grist_Views_section", sec, {"options": custom_options(URL), "title": PAGE}]])
print(f"Page « {PAGE} » : section {sec}, widget {URL}")
