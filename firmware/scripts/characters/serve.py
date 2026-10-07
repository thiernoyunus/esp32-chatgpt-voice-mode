"""Serve the one-character test; runtime/ is copied from the installed Codex app."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    def do_PUT(self):
        # Saves captured flipbook frames: PUT /frames/<name>.png
        name = Path(self.path).name
        if not self.path.startswith('/frames/') or not name.endswith('.png'):
            self.send_error(400)
            return
        out = HERE / 'frames' / name
        out.parent.mkdir(exist_ok=True)
        out.write_bytes(self.rfile.read(int(self.headers['Content-Length'])))
        self.send_response(204)
        self.end_headers()

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8768), Handler).serve_forever()
