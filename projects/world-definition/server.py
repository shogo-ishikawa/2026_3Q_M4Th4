#!/usr/bin/env python3
"""任意のローカルAIが、選択済みルールの名前と説明を補助します。"""

import argparse
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
from urllib.error import URLError
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen
import webbrowser

ROOT = Path(__file__).resolve().parent
PORT = 8765
TARGETS = {"water", "stone", "tree", "fire"}
EFFECTS = {"float", "move", "grow", "glow", "freeze", "solidify", "pulse", "heat"}
MAX_REQUEST_BYTES = 4096
MAX_AI_BYTES = 65536
STATIC_FILES = {
    "/index.html", "/style.css", "/app.js", "/engine.js", "/guide.html", "/favicon.svg"
}
ASSET_EXTENSIONS = {".png", ".svg", ".jpg", ".jpeg", ".webp", ".ico", ".woff2"}


class InvalidAIResponse(ValueError):
    """AIから受け取ったデータをゲームへ渡せない場合。"""


def validate_selection(data):
    """ゲームが決めた対象・動作だけを受け付けます。"""
    if not isinstance(data, dict) or set(data) != {"target", "effects"}:
        return False
    target, effects = data["target"], data["effects"]
    return (
        isinstance(target, str)
        and target in TARGETS
        and isinstance(effects, list)
        and 1 <= len(effects) <= 3
        and all(isinstance(effect, str) and effect in EFFECTS for effect in effects)
        and len(set(effects)) == len(effects)
    )


def validate_ai_result(result, selection):
    """AIは動作を変えず、短い表示用テキストだけを返します。"""
    if not isinstance(result, dict):
        raise InvalidAIResponse()
    effects = result.get("effects")
    if (
        result.get("target") != selection["target"]
        or not isinstance(effects, list)
        or not all(isinstance(effect, str) for effect in effects)
        or sorted(effects) != sorted(selection["effects"])
    ):
        raise InvalidAIResponse()
    name, description = result.get("name"), result.get("description")
    if (
        not isinstance(name, str)
        or not 1 <= len(name.strip()) <= 60
        or not isinstance(description, str)
        or not 1 <= len(description.strip()) <= 180
    ):
        raise InvalidAIResponse()
    return {
        "target": selection["target"],
        "effects": selection["effects"],
        "name": name.strip(),
        "description": description.strip(),
    }


def generate_description(selection):
    """同じPC上のOllamaだけに問い合わせます。コードは実行しません。"""
    payload = {
        "model": os.environ.get("WORLD_DEFINITION_MODEL", "qwen3.5:4b"),
        "stream": False,
        "think": False,
        "format": "json",
        "options": {"temperature": 0.3, "num_predict": 200},
        "system": (
            "You help name a puzzle game's already selected rule. Return only JSON "
            "with target, effects, name, description. Copy target and effects exactly. "
            "Do not create new actions or code. Write a Japanese name of 1-60 characters "
            "and a Japanese description of 1-180 characters."
        ),
        "prompt": json.dumps(selection, ensure_ascii=False),
    }
    request = Request(
        "http://127.0.0.1:11434/api/generate",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=25) as response:
        content = response.read(MAX_AI_BYTES + 1)
    if len(content) > MAX_AI_BYTES:
        raise InvalidAIResponse()
    try:
        outer = json.loads(content)
        if not isinstance(outer, dict) or not isinstance(outer.get("response"), str):
            raise InvalidAIResponse()
        return json.loads(outer["response"])
    except (ValueError, UnicodeError) as error:
        raise InvalidAIResponse() from error


class Handler(SimpleHTTPRequestHandler):
    server_version = "WorldDefinition"
    sys_version = ""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_args):
        # 選択内容やAIの返答をアクセスログへ保存しません。
        pass

    def valid_site_request(self):
        """別サイトからローカルAIを呼び出す要求を拒否します。"""
        hosts = self.headers.get_all("Host", [])
        port = self.server.server_port
        if len(hosts) != 1 or hosts[0] not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
            self.send_json(403, {"error": "このPCのローカルURLから開いてください。"})
            return False
        origins = self.headers.get_all("Origin", [])
        if origins and (len(origins) != 1 or origins[0] != f"http://{hosts[0]}"):
            self.send_json(403, {"error": "別のサイトからの呼び出しは受け付けません。"})
            return False
        return True

    def valid_static_path(self):
        path = unquote(urlsplit(self.path).path)
        if path == "/":
            path = "/index.html"
        allowed = path in STATIC_FILES or (
            path.startswith("/assets/") and Path(path).suffix.lower() in ASSET_EXTENSIONS
        )
        file_path = (ROOT / path.lstrip("/")).resolve()
        if not allowed or not file_path.is_relative_to(ROOT.resolve()) or not file_path.is_file():
            self.send_json(404, {"error": "ファイルが見つかりません。"})
            return False
        self.path = path
        return True

    def do_GET(self):
        if self.valid_site_request() and self.valid_static_path():
            super().do_GET()

    def do_HEAD(self):
        if self.valid_site_request() and self.valid_static_path():
            super().do_HEAD()

    def do_POST(self):
        if not self.valid_site_request():
            return
        if self.path != "/api/ai":
            return self.send_json(404, {"error": "この操作は利用できません。"})
        if self.headers.get("Transfer-Encoding"):
            return self.send_json(400, {"error": "リクエスト形式が無効です。"})
        lengths = self.headers.get_all("Content-Length", [])
        if not lengths:
            return self.send_json(411, {"error": "データの長さが指定されていません。"})
        if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
            return self.send_json(400, {"error": "データの長さが無効です。"})
        if len(lengths[0]) > 6:
            return self.send_json(413, {"error": "送信データが大きすぎます。"})
        length = int(lengths[0])
        if length > MAX_REQUEST_BYTES:
            return self.send_json(413, {"error": "送信データが大きすぎます。"})
        if self.headers.get_content_type() != "application/json":
            return self.send_json(415, {"error": "JSON形式で送信してください。"})
        try:
            body = self.rfile.read(length)
            if len(body) != length:
                return self.send_json(400, {"error": "送信データが途中で途切れました。"})
            data = json.loads(body)
        except (ValueError, UnicodeError, TimeoutError, RecursionError):
            return self.send_json(400, {"error": "送信データを読み取れません。"})
        if not validate_selection(data):
            return self.send_json(400, {"error": "対象と動作の選択が無効です。"})
        try:
            result = validate_ai_result(generate_description(data), data)
        except (URLError, TimeoutError, ConnectionError):
            return self.send_json(503, {
                "error": "Ollamaに接続できません。起動とモデルを確認するか、標準モードで遊んでください。"
            })
        except InvalidAIResponse:
            return self.send_json(422, {"error": "AIの返答を確認できません。もう一度試してください。"})
        except Exception:
            return self.send_json(502, {"error": "AIとの通信に失敗しました。標準モードで遊べます。"})
        self.send_json(200, result)

    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        if self.command != "HEAD":
            self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()


def create_server(port=PORT):
    """port=0ならOSが空きポートを割り当てます。テストでも利用します。"""
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser(description="WORLD DEFINITION ローカル起動")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port は1〜65535で指定してください。")
    try:
        server = create_server(args.port)
    except OSError:
        parser.exit(1, "起動できません。このポートが使用中なら --port 8766 などを指定してください。\n")
    url = f"http://127.0.0.1:{server.server_port}"
    print(f"WORLD DEFINITION: {url}\n終了: Ctrl+C\n標準モードはAIなしで遊べます。")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n終了します。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
