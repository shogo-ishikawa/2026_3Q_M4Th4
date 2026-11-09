"""ローカルAIの境界を、実HTTPとモック応答で確認します。実モデルは不要です。"""

from contextlib import contextmanager
import http.client
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import URLError

SERVER_PATH = Path(__file__).resolve().parents[1] / "server.py"
SPEC = importlib.util.spec_from_file_location("world_definition_server", SERVER_PATH)
server_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server_module)
VALID_SELECTION = {"target": "stone", "effects": ["float", "grow"]}
VALID_RESULT = {
    **VALID_SELECTION,
    "name": "浮かぶ大きな石",
    "description": "石を浮かせて、大きな足場にします。",
}


class LocalServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        (cls.root / "index.html").write_text("<!doctype html><title>WORLD DEFINITION</title>")
        (cls.root / "server.py").write_text("DO NOT SERVE THIS SOURCE")
        (cls.root / "original.zip").write_bytes(b"DO NOT SERVE THIS ARCHIVE")
        (cls.root / "assets").mkdir()
        (cls.root / "assets" / "test.svg").write_text("<svg/>")
        cls.root_patch = patch.object(server_module, "ROOT", cls.root)
        cls.root_patch.start()
        cls.server = server_module.create_server(port=0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_port
        cls.host = f"127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.root_patch.stop()
        cls.temp.cleanup()

    def request(self, method="POST", path="/api/ai", body=None, headers=None):
        if body is None:
            body = json.dumps(VALID_SELECTION).encode()
        elif isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        defaults = {"Content-Type": "application/json", "Content-Length": str(len(body))}
        if headers:
            defaults.update(headers)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(method, path, body=body, headers=defaults)
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def assert_json_status(self, expected, **request):
        status, headers, body = self.request(**request)
        self.assertEqual(status, expected, body)
        self.assertIn("application/json", headers["Content-Type"])
        return json.loads(body)

    def test_binds_only_loopback(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")

    def test_success_requires_same_rule_and_returns_safe_display_fields(self):
        with patch.object(server_module, "generate_description", return_value={**VALID_RESULT, "code": "ignored"}) as model:
            result = self.assert_json_status(200, headers={"Origin": f"http://{self.host}"})
        self.assertEqual(result, VALID_RESULT)
        model.assert_called_once_with(VALID_SELECTION)

    def test_static_game_and_assets_are_available(self):
        for path in ["/", "/index.html", "/index.html?version=1", "/assets/test.svg"]:
            with self.subTest(path=path):
                status, _, body = self.request(method="GET", path=path, body=b"")
                self.assertEqual(status, 200, body)

    def test_head_has_no_body(self):
        status, _, body = self.request(method="HEAD", path="/", body=b"")
        self.assertEqual((status, body), (200, b""))

    def test_source_archive_and_directory_listing_are_not_served(self):
        for path in ["/server.py", "/original.zip", "/tests/", "/assets/", "/assets/../server.py", "/%2e%2e/server.py"]:
            with self.subTest(path=path):
                self.assert_json_status(404, method="GET", path=path, body=b"")

    def test_host_and_origin_guard_prevent_cross_site_calls(self):
        for headers in [
            {"Host": "evil.example"},
            {"Host": f"127.0.0.1.evil.example:{self.port}"},
            {"Origin": "https://evil.example"},
            {"Origin": "null"},
            {"Origin": f"http://localhost:{self.port}"},
            {"Origin": f"https://{self.host}"},
        ]:
            with self.subTest(headers=headers), patch.object(server_module, "generate_description") as model:
                self.assert_json_status(403, headers=headers)
                model.assert_not_called()

    def test_localhost_alias_is_supported(self):
        with patch.object(server_module, "generate_description", return_value=VALID_RESULT):
            self.assert_json_status(200, headers={
                "Host": f"localhost:{self.port}", "Origin": f"http://localhost:{self.port}"
            })

    def test_static_host_guard_applies_before_reading(self):
        self.assert_json_status(403, method="GET", path="/", body=b"", headers={"Host": "evil.example"})

    def test_unknown_api(self):
        self.assert_json_status(404, path="/api/unknown")

    def test_content_length_is_validated_without_reading_oversize_body(self):
        for length, expected in [("-1", 400), ("invalid", 400), ("0x20", 400), ("9999", 413), ("9" * 5000, 413)]:
            with self.subTest(length=length):
                self.assert_json_status(expected, headers={"Content-Length": length})

    def test_missing_or_duplicate_lengths_are_rejected(self):
        for values, expected in [([], 411), (["1", "1"], 400)]:
            with self.subTest(values=values):
                connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
                connection.putrequest("POST", "/api/ai")
                connection.putheader("Content-Type", "application/json")
                for value in values:
                    connection.putheader("Content-Length", value)
                connection.endheaders()
                response = connection.getresponse()
                self.assertEqual(response.status, expected, response.read())
                connection.close()

    def test_duplicate_host_is_rejected(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.putrequest("GET", "/")
        connection.putheader("Host", self.host)
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 403, response.read())
        connection.close()

    def test_transfer_encoding_is_rejected(self):
        self.assert_json_status(400, headers={"Transfer-Encoding": "chunked"})

    def test_json_content_type_required(self):
        self.assert_json_status(415, headers={"Content-Type": "text/plain"})

    def test_invalid_json_is_client_error(self):
        for body in [b"not-json", b"\xff", b"", b"[" * 1500 + b"]" * 1500]:
            with self.subTest(body=body[:30]):
                self.assert_json_status(400, body=body)

    def test_invalid_selection_is_client_error_and_does_not_call_ai(self):
        bad_selections = [
            [], None, "stone", {}, {"target": "stone"},
            {"target": [], "effects": ["float"]},
            {"target": "unknown", "effects": ["float"]},
            {"target": "stone", "effects": "float"},
            {"target": "stone", "effects": []},
            {"target": "stone", "effects": ["float", "float"]},
            {"target": "stone", "effects": ["unknown"]},
            {"target": "stone", "effects": [["float"]]},
            {"target": "stone", "effects": ["float", "grow", "glow", "pulse"]},
            {"target": "stone", "effects": ["float"], "url": "https://evil.example"},
        ]
        with patch.object(server_module, "generate_description") as model:
            for selection in bad_selections:
                with self.subTest(selection=selection):
                    self.assert_json_status(400, body=json.dumps(selection).encode())
            model.assert_not_called()

    def test_unavailable_or_timeout_ai_returns_503_without_internal_details(self):
        for error in [URLError("PRIVATE_ERROR"), TimeoutError("PRIVATE_ERROR"), ConnectionError("PRIVATE_ERROR")]:
            with self.subTest(error=type(error).__name__), patch.object(server_module, "generate_description", side_effect=error):
                result = self.assert_json_status(503)
                self.assertNotIn("PRIVATE_ERROR", result["error"])

    def test_unexpected_ai_failure_does_not_expose_exception(self):
        with patch.object(server_module, "generate_description", side_effect=RuntimeError("PRIVATE_ERROR")):
            result = self.assert_json_status(502)
        self.assertNotIn("PRIVATE_ERROR", result["error"])

    def test_invalid_ai_result_never_reaches_game(self):
        invalid = [
            [], {**VALID_RESULT, "target": "tree"},
            {**VALID_RESULT, "effects": ["float"]},
            {**VALID_RESULT, "effects": ["float", "grow", "grow"]},
            {**VALID_RESULT, "effects": [["float"], "grow"]},
            {**VALID_RESULT, "name": 3}, {**VALID_RESULT, "name": " "},
            {**VALID_RESULT, "name": "a" * 61},
            {**VALID_RESULT, "description": {}},
            {**VALID_RESULT, "description": ""},
            {**VALID_RESULT, "description": "a" * 181},
        ]
        for result in invalid:
            with self.subTest(result=result), patch.object(server_module, "generate_description", return_value=result):
                self.assert_json_status(422)

    def test_generate_description_uses_only_fixed_loopback_endpoint_and_model_override(self):
        outer = json.dumps({"response": json.dumps(VALID_RESULT)}).encode()
        with patch.object(server_module, "urlopen", return_value=io.BytesIO(outer)) as request, patch.dict(server_module.os.environ, {"WORLD_DEFINITION_MODEL": "example-model"}):
            result = server_module.generate_description(VALID_SELECTION)
        self.assertEqual(result, VALID_RESULT)
        args, kwargs = request.call_args
        self.assertEqual(args[0].full_url, "http://127.0.0.1:11434/api/generate")
        self.assertEqual(json.loads(args[0].data)["model"], "example-model")
        self.assertEqual(kwargs["timeout"], 25)

    def test_malformed_or_oversize_ollama_responses_are_rejected(self):
        for response in [b"broken", b"[]", b'{}', b'{"response":3}', b'{"response":"broken"}', b"x" * (server_module.MAX_AI_BYTES + 1)]:
            with self.subTest(response=response[:30]), patch.object(server_module, "urlopen", return_value=io.BytesIO(response)):
                with self.assertRaises(server_module.InvalidAIResponse):
                    server_module.generate_description(VALID_SELECTION)


if __name__ == "__main__":
    unittest.main()
