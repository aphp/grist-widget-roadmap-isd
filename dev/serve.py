"""Serveur de développement du widget : http://localhost:8770/ (vraie API Grist) et /dev/host.html (faux Grist).

    python3 grist-widget-isd/dev/serve.py [port]

En mode faux Grist (/index.html?mock=1, utilisé par host.html), la balise de grist-plugin-api.js est remplacée à la volée
par /dev/mock-grist.js : le code du widget ne contient aucun mock.
"""
import posixpath
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
API = '<script src="vendor/grist-plugin-api.js"></script>'


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Sert uniquement widget/ et dev/ : chemin décodé, normalisé, puis confiné à sa racine.
        p = posixpath.normpath("/" + unquote(path.split("?", 1)[0].split("#", 1)[0]).lstrip("/"))
        if p.startswith("/dev/"):
            base, rel = (ROOT / "dev").resolve(), p[len("/dev/"):]
        else:
            base, rel = (ROOT / "widget").resolve(), p.lstrip("/")
        target = (base / rel).resolve()
        if not target.is_relative_to(base):
            return str(ROOT / ".inexistant")  # → 404
        return str(target)

    def do_GET(self):
        if self.path.startswith("/index.html?mock=1") or self.path.startswith("/?mock=1"):
            index = ROOT / "widget/index.html"
            if not index.is_file():
                self.send_error(404)
                return
            body = index.read_text(encoding="utf-8").replace(API, '<script src="/dev/mock-grist.js"></script>')
            raw = body.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
