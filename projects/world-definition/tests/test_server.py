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
        for filename in ["engine.js", "app.js", "progress.js", "renderer.js", "session.js", "style.css", "guide.html"]:
            (cls.root / filename).write_text("fixture " + filename)
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
        self.assertEqual(result, {**server_module.describe_selection(VALID_SELECTION), "name": VALID_RESULT["name"]})
        model.assert_called_once_with(VALID_SELECTION)

    def test_static_game_and_assets_are_available(self):
        for path in ["/", "/index.html", "/index.html?version=1", "/engine.js?v=1.1.0", "/app.js?v=1.1.0", "/progress.js?v=1.1.0", "/renderer.js?v=1.1.0", "/session.js?v=1.2.0", "/style.css?v=1.1.0", "/guide.html", "/assets/test.svg"]:
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
        outer = json.dumps({"done": True, "response": json.dumps(VALID_RESULT)}).encode()
        with patch.object(server_module, "require_local_model"), patch.object(server_module, "installed_models", return_value=["example-model"]), patch.object(server_module, "urlopen", return_value=io.BytesIO(outer)) as request, patch.dict(server_module.os.environ, {"WORLD_DEFINITION_MODEL": "example-model"}):
            result = server_module.generate_description(VALID_SELECTION)
        self.assertEqual(result, VALID_RESULT)
        args, kwargs = request.call_args
        self.assertEqual(args[0].full_url, "http://127.0.0.1:11434/api/generate")
        self.assertEqual(json.loads(args[0].data)["model"], "example-model")
        self.assertEqual(kwargs["timeout"], server_module.GENERATION_TIMEOUT)
        self.assertIsInstance(json.loads(args[0].data)["format"], dict)
        self.assertIn("implemented_effects", json.loads(json.loads(args[0].data)["prompt"]))

    def test_malformed_or_oversize_ollama_responses_are_rejected(self):
        for response in [b"broken", b"[]", b'{}', b'{"response":3}', b'{"response":"broken"}', b"x" * (server_module.MAX_AI_BYTES + 1)]:
            with self.subTest(response=response[:30]), patch.object(server_module, "require_local_model"), patch.object(server_module, "installed_models", return_value=["test"]), patch.object(server_module, "urlopen", return_value=io.BytesIO(response)):
                with self.assertRaises(server_module.InvalidAIResponse):
                    server_module.generate_description(VALID_SELECTION)

    def test_validates_supported_and_contradictory_effects_before_ai(self):
        invalid = [
            {"target": "stone", "effects": ["heat"]},
            {"target": "water", "effects": ["rotate"]},
            {"target": "fire", "effects": ["shrink"]},
            {"target": "stone", "effects": ["grow", "shrink"]},
            {"target": "water", "effects": ["freeze", "solidify"]},
            {"target": "fire", "effects": ["freeze", "heat"]},
            {**VALID_SELECTION, "model": []},
            {**VALID_SELECTION, "model": "http://evil.example/model"},
        ]
        with patch.object(server_module, "generate_description") as model:
            for selection in invalid:
                with self.subTest(selection=selection):
                    self.assert_json_status(400, body=selection)
            model.assert_not_called()
        for target in ["stone", "tree"]:
            self.assertTrue(server_module.validate_selection({"target": target, "effects": ["float", "shrink", "rotate"]}))

    def test_ai_description_cannot_invent_effects(self):
        model_result = {**VALID_RESULT, "description": "石を爆破し、時間を止めます。"}
        with patch.object(server_module, "generate_description", return_value=model_result):
            result = self.assert_json_status(200)
        self.assertNotIn("爆破", result["description"])
        self.assertEqual(result["name"], model_result["name"])
        self.assertEqual(result["description"], server_module.describe_selection(VALID_SELECTION)["description"])

    def test_status_reports_installed_models_and_default_fallback(self):
        with patch.object(server_module, "installed_models", return_value=["small:latest", "another:4b"]), patch.dict(server_module.os.environ, {"WORLD_DEFINITION_MODEL": "not-installed"}):
            result = self.assert_json_status(200, method="GET", path="/api/status", body=b"")
        self.assertTrue(result["available"])
        self.assertEqual(result["models"], ["small:latest", "another:4b"])
        self.assertEqual(result["model"], "small:latest")
        with patch.object(server_module, "installed_models", return_value=["small:latest", "another:4b"]), patch.dict(server_module.os.environ, {"WORLD_DEFINITION_MODEL": "another:4b"}):
            self.assertEqual(server_module.ai_status()["model"], "another:4b")

    def test_status_handles_no_models_and_connection_errors(self):
        for result in [[], URLError("PRIVATE_ERROR"), TimeoutError("PRIVATE_ERROR"), server_module.InvalidAIResponse()]:
            kwargs = {"return_value": result} if isinstance(result, list) else {"side_effect": result}
            with self.subTest(result=type(result).__name__), patch.object(server_module, "installed_models", **kwargs):
                status = self.assert_json_status(200, method="GET", path="/api/status", body=b"")
            self.assertEqual(set(status), {"available", "models", "model", "message"})
            self.assertFalse(status["available"])
            self.assertNotIn("PRIVATE_ERROR", status["message"])

    def test_status_host_and_origin_guard_runs_before_ollama(self):
        for headers in [{"Host": "evil.example"}, {"Origin": "https://evil.example"}]:
            with patch.object(server_module, "installed_models") as models:
                self.assert_json_status(403, method="GET", path="/api/status", body=b"", headers=headers)
                models.assert_not_called()

    def test_tags_uses_fixed_loopback_get_and_bounded_response(self):
        tags = json.dumps({"models": [{"name": "small:latest"}, {"name": "small:latest"}, {"name": "other:4b"}]}).encode()
        with patch.object(server_module, "urlopen", return_value=io.BytesIO(tags)) as request:
            self.assertEqual(server_module.installed_models(), ["small:latest", "other:4b"])
        args, kwargs = request.call_args
        self.assertEqual(args[0].full_url, "http://127.0.0.1:11434/api/tags")
        self.assertEqual(args[0].method, "GET")
        self.assertEqual(kwargs["timeout"], server_module.STATUS_TIMEOUT)
        for bad in [b"[]", b"{}", b'{"models":{}}', b'{"models":[{}]}', b'{"models":[{"name":"https://evil.example"}]}', b"x" * (server_module.MAX_AI_BYTES + 1)]:
            with self.subTest(response=bad[:50]), patch.object(server_module, "urlopen", return_value=io.BytesIO(bad)):
                with self.assertRaises(server_module.InvalidAIResponse):
                    server_module.installed_models()

    def test_only_installed_model_is_sent_to_generation(self):
        with patch.object(server_module, "installed_models", return_value=["small:latest"]), patch.object(server_module, "generate_json", return_value=VALID_RESULT) as generate:
            server_module.generate_description({**VALID_SELECTION, "model": "small:latest"})
            self.assertEqual(generate.call_args.args[0], "small:latest")
            generate.reset_mock()
            with self.assertRaises(server_module.ModelUnavailable):
                server_module.generate_description({**VALID_SELECTION, "model": "absent:4b"})
            generate.assert_not_called()
        with patch.object(server_module, "generate_description", side_effect=server_module.ModelUnavailable("未導入のモデルです。")):
            self.assert_json_status(422, body={**VALID_SELECTION, "model": "absent:4b"})

    def test_interpretation_returns_candidate_without_executing_it(self):
        answer = {"status": "ok", "target": "stone", "effects": ["grow", "float"], "reason": ""}
        with patch.object(server_module, "installed_models", return_value=["small:latest"]), patch.object(server_module, "generate_json", return_value=answer) as generate:
            result = self.assert_json_status(200, path="/api/interpret", body={"text": "石を大きくして空中に浮かせたい", "model": "small:latest"})
        self.assertEqual(result["target"], "stone")
        self.assertEqual(result["effects"], ["grow", "float"])
        self.assertEqual(result, server_module.describe_selection(answer))
        self.assertIn("status", generate.call_args.args[1]["properties"])
        self.assertIn("Never generate code", generate.call_args.args[2])

    def test_interpretation_rejects_empty_long_or_unknown_fields(self):
        invalid = [{}, {"text": ""}, {"text": " "}, {"text": "a" * 501}, {"text": []}, {"text": "石を浮かす", "url": "http://evil.example"}, {"text": "石を浮かす", "model": 1}]
        with patch.object(server_module, "interpret_rule") as model:
            for data in invalid:
                with self.subTest(data=str(data)[:50]):
                    self.assert_json_status(400, path="/api/interpret", body=data)
            model.assert_not_called()

    def test_unsupported_or_ambiguous_text_does_not_request_a_substitute(self):
        for text in ["石を爆破したい", "木を透明にして", "炎で時間を止めて", "teleport the stone", "石と木を浮かせて", "大きくして浮かせて"]:
            with self.subTest(text=text), patch.object(server_module, "generate_json") as generate:
                self.assert_json_status(422, path="/api/interpret", body={"text": text})
                generate.assert_not_called()

    def test_interpretation_rejects_model_uncertainty_or_invalid_actions(self):
        bad_answers = [
            {"status": "unsupported"}, {"status": "ambiguous"}, {"status": []}, [], {},
            {"status": "ok", "target": "stone", "effects": ["explode"]},
            {"status": "ok", "target": "stone", "effects": ["grow", "shrink"]},
            {"status": "ok", "target": "water", "effects": ["freeze"]},
            {"status": "ok", "target": "stone", "effects": ["float", "grow", "rotate", "glow"]},
        ]
        for result in bad_answers:
            with self.subTest(result=result), patch.object(server_module, "installed_models", return_value=["small:latest"]), patch.object(server_module, "generate_json", return_value=result):
                self.assert_json_status(422, path="/api/interpret", body={"text": "石を浮かせたい"})

    def test_interpretation_connection_failure_keeps_static_game_available(self):
        with patch.object(server_module, "installed_models", side_effect=URLError("PRIVATE_ERROR")):
            result = self.assert_json_status(503, path="/api/interpret", body={"text": "石を浮かせたい"})
        self.assertNotIn("PRIVATE_ERROR", result["error"])
        status, _, _ = self.request(method="GET", path="/", body=b"")
        self.assertEqual(status, 200)

    def test_tags_exclude_cloud_names_and_remote_alias_metadata(self):
        tags = {"models": [{"name": "qwen:cloud"}, {"name": "qwen:4b-cloud"},
                {"name": "my-alias", "remote_host": "https://ollama.com", "remote_model": "qwen"},
                {"name": "nested-alias", "details": {"remote_model": "qwen"}},
                {"name": "small:latest", "details": {"format": "gguf"}}]}
        with patch.object(server_module, "ollama_json", return_value=tags):
            self.assertEqual(server_module.installed_models(), ["small:latest"])

    def test_generation_checks_show_before_sending_any_prompt(self):
        local = {"details": {"format": "gguf"}, "model_info": {"general.architecture": "qwen"}}
        outer = {"done": True, "response": json.dumps(VALID_RESULT)}
        with patch.object(server_module, "installed_models", return_value=["small:latest"]), patch.object(server_module, "ollama_json", side_effect=[local, outer]) as ollama:
            result = self.assert_json_status(200, body={**VALID_SELECTION, "model": "small:latest"})
        self.assertEqual(result["name"], VALID_RESULT["name"])
        calls = ollama.call_args_list
        self.assertEqual(calls[0].args[0], "/api/show")
        self.assertEqual(calls[0].args[1], {"model": "small:latest", "verbose": False})
        self.assertEqual(calls[0].kwargs["timeout"], server_module.STATUS_TIMEOUT)
        self.assertEqual(calls[1].args[0], "/api/generate")
        self.assertIn("prompt", calls[1].args[1])

    def test_remote_alias_and_unknown_show_info_never_reach_generation(self):
        answers = [
            {"remote_host": "https://ollama.com", "remote_model": "qwen"},
            {"remote_model": "qwen", "details": {"format": "gguf"}, "model_info": {"x": 1}},
            {"details": {"format": "gguf", "remote_host": "http://remote.example"}, "model_info": {"x": 1}},
            {}, {"details": {"format": "gguf"}}, {"details": {"format": "gguf"}, "model_info": {}},
        ]
        for show in answers:
            with self.subTest(show=show), patch.object(server_module, "installed_models", return_value=["innocent-alias"]), patch.object(server_module, "ollama_json", return_value=show) as ollama:
                self.assert_json_status(422, body={**VALID_SELECTION, "model": "innocent-alias"})
                self.assertEqual([call.args[0] for call in ollama.call_args_list], ["/api/show"])
        with patch.object(server_module, "installed_models", return_value=["qwen:cloud"]), patch.object(server_module, "ollama_json") as ollama:
            self.assert_json_status(422, path="/api/interpret", body={"text": "石を浮かせたい", "model": "qwen:cloud"})
            ollama.assert_not_called()

    def test_interpretation_also_checks_remote_alias_before_prompt(self):
        with patch.object(server_module, "installed_models", return_value=["my-local-alias"]), patch.object(server_module, "ollama_json", return_value={"remote_host": "https://ollama.com"}) as ollama:
            self.assert_json_status(422, path="/api/interpret", body={"text": "石を浮かせたい", "model": "my-local-alias"})
        self.assertEqual([call.args[0] for call in ollama.call_args_list], ["/api/show"])

    def test_model_show_uses_fixed_loopback_metadata_only_request(self):
        local = json.dumps({"details": {"format": "gguf"}, "model_info": {"general.architecture": "qwen"}}).encode()
        with patch.object(server_module, "urlopen", return_value=io.BytesIO(local)) as request:
            server_module.require_local_model("small:latest")
        args, kwargs = request.call_args
        self.assertEqual(args[0].full_url, "http://127.0.0.1:11434/api/show")
        self.assertEqual(json.loads(args[0].data), {"model": "small:latest", "verbose": False})
        self.assertEqual(kwargs["timeout"], server_module.STATUS_TIMEOUT)

    def test_concurrent_generation_is_rejected_without_blocking_status(self):
        entered, release = threading.Event(), threading.Event()
        result, errors = [], []
        def slow_generation(_selection):
            entered.set()
            if not release.wait(2):
                raise TimeoutError()
            return VALID_RESULT
        def first_request():
            try:
                result.append(self.request())
            except Exception as error:
                errors.append(error)
        status = {"available": True, "models": ["small:latest"], "model": "small:latest", "message": "ready"}
        with patch.object(server_module, "generate_description", side_effect=slow_generation) as model, patch.object(server_module, "ai_status", return_value=status):
            worker = threading.Thread(target=first_request)
            worker.start()
            try:
                self.assertTrue(entered.wait(1))
                busy = self.assert_json_status(429, path="/api/interpret", body={"text": "石を浮かせたい"})
                self.assertIn("処理中", busy["error"])
                self.assertEqual(self.assert_json_status(200, method="GET", path="/api/status", body=b""), status)
                self.assertEqual(model.call_count, 1)
            finally:
                release.set()
                worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(result[0][0], 200)
        with patch.object(server_module, "generate_description", return_value=VALID_RESULT):
            self.assert_json_status(200)

    def test_failed_generation_always_releases_capacity(self):
        with patch.object(server_module, "generate_description", side_effect=[URLError("failed"), VALID_RESULT]):
            self.assert_json_status(503)
            self.assert_json_status(200)


if __name__ == "__main__":
    unittest.main()
