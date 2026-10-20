"""Lance le banc d'essai des écritures du widget contre le VRAI Grist, dans le DOCUMENT DE TEST seulement.

    GRIST_WIDGET_CONFIG=/chemin/config.yaml uv run --no-project --with pyyaml python tools/real-grist/run.py [--out f.json]

Lit config.yaml (GRIST_WIDGET_CONFIG, sinon config.yaml dans le dossier parent du dépôt), pose dans l'environnement
l'URL, la clé, le document de test et la liste des documents protégés (doc_id, mkt_doc_id, read_only_doc_ids), puis
lance harness.js avec Node. Rien n'est affiché de la clé ni des identifiants. Refuse de lancer si le document de
test est absent, protégé, ou si doc_id ou mkt_doc_id manquent (sans eux, le contrôle du banc serait incomplet).
Le résultat détaillé (données nominatives) va dans --out, par défaut hors du dépôt (dossier temporaire).
"""
import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CONFIG = Path(os.environ["GRIST_WIDGET_CONFIG"]) if os.environ.get("GRIST_WIDGET_CONFIG") else REPO.parent / "config.yaml"

ap = argparse.ArgumentParser()
ap.add_argument("--out", default=str(Path(tempfile.gettempdir()) / "real-grist-results.json"))
ap.add_argument("--only", default="", help="scénarios à lancer (préfixes séparés par des virgules)")
args = ap.parse_args()

cfg = yaml.safe_load(CONFIG.read_text(encoding="utf-8"))["grist"]
test_doc = cfg.get("test_doc_id")
protected = [d for d in [cfg.get("doc_id"), cfg.get("mkt_doc_id"), *cfg.get("read_only_doc_ids", [])] if d]
if not test_doc:
    sys.exit("test_doc_id absent de config.yaml")
if not cfg.get("doc_id") or not cfg.get("mkt_doc_id"):
    sys.exit("doc_id et mkt_doc_id requis dans config.yaml (documents protégés)")
if test_doc in protected:
    sys.exit("le document de test est un document protégé : refus")
if Path(args.out).resolve().is_relative_to(REPO):
    sys.exit("--out doit être hors du dépôt (données nominatives)")

env = {
    **os.environ,
    "GRIST_URL": cfg["url"],
    "GRIST_API_KEY": cfg["api_key"],
    "GRIST_DOC": test_doc,
    "GRIST_TEST_DOC_ID": test_doc,
    "GRIST_PROTECTED_DOC_IDS": ",".join(sorted(set(protected))),
    "REAL_GRIST_OUT": args.out,
    "REAL_GRIST_ONLY": args.only,
}
sys.exit(subprocess.call(["node", str(HERE / "harness.js")], env=env, cwd=REPO))
