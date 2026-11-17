"""Open Illusion Lab using Python's standard library."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import runpy
import threading
import webbrowser


def main():
    parser = argparse.ArgumentParser(description='Illusion Lab')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    runpy.run_path(str(root / 'scripts/package-download.py'))['build_archive']()
    server = ThreadingHTTPServer(('127.0.0.1', args.port),
                                 partial(SimpleHTTPRequestHandler, directory=str(root / 'web')))
    url = f'http://127.0.0.1:{server.server_port}/'
    print(f'Illusion Lab: {url} (Ctrl+C to stop)', flush=True)
    if not args.no_browser:
        timer = threading.Timer(0.5, lambda: webbrowser.open(url))
        timer.daemon = True
        timer.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
