"""Client Grist minimal pour les outils du widget Roadmap ISD.

Lecture : n'importe quel document accessible avec la clé (Feuille de route EDS, document de test…).
Écriture : UNIQUEMENT le document de test (config.yaml : grist.test_doc_id). Toute autre cible lève une erreur.

Configuration : fichier YAML lu depuis la variable d'environnement GRIST_WIDGET_CONFIG si elle est définie,
sinon config.yaml dans le dossier parent de ce dépôt (parents[2] du fichier, soit pmo-writer/config.yaml pour ce
dossier). Le fichier n'est pas versionné ; aucun identifiant de document n'est écrit dans le dépôt.
    grist:
      url: https://grist.numerique.gouv.fr
      api_key: <clé personnelle>
      doc_id: <id du document Feuille de route>        # lecture seule
      read_only_doc_ids: []                             # autres documents à protéger en écriture (optionnel)
      test_doc_id: <id du document de test>            # écriture autorisée
"""
import json
import os
from pathlib import Path

import requests
import yaml

ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = Path(os.environ["GRIST_WIDGET_CONFIG"]) if os.environ.get("GRIST_WIDGET_CONFIG") else ROOT / "config.yaml"
with open(CONFIG_PATH, encoding="utf-8") as _f:
    CFG = yaml.safe_load(_f)["grist"]
READ_ONLY = {CFG["doc_id"], *CFG.get("read_only_doc_ids", [])}
WRITABLE = CFG["test_doc_id"]
assert WRITABLE not in READ_ONLY, "le document de test ne peut pas être un document protégé"

_session = requests.Session()
_session.headers["Authorization"] = f"Bearer {CFG['api_key']}"


def _url(doc, path):
    return f"{CFG['url'].rstrip('/')}/api/docs/{doc}/{path}"


def get(doc, path, **params):
    r = _session.get(_url(doc, path), params=params, timeout=120)
    r.raise_for_status()
    return r.json()


def tables(doc):
    return [t["id"] for t in get(doc, "tables")["tables"]]


def columns(doc, table):
    return get(doc, f"tables/{table}/columns", hidden="true")["columns"]


def records(doc, table):
    """{row_id: fields} — valeurs brutes Grist (Date en secondes, RefList en ['L', …])."""
    return {r["id"]: r["fields"] for r in get(doc, f"tables/{table}/records")["records"]}


def sql(doc, q):
    return [r["fields"] for r in get(doc, "sql", q=q)["records"]]


def apply(doc, actions):
    """Applique des user actions Grist. Refuse tout document autre que le document de test."""
    if doc != WRITABLE:
        raise PermissionError(f"écriture refusée sur {doc} : seul le document de test {WRITABLE} est modifiable")
    r = _session.post(_url(doc, "apply"), data=json.dumps(actions), headers={"Content-Type": "application/json"}, timeout=300)
    if not r.ok:
        raise RuntimeError(f"Grist {r.status_code} : {r.text[:500]}")
    return r.json()
