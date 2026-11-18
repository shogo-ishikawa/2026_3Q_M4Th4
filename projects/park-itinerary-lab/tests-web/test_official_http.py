import io
from pathlib import Path
import sys
import unittest
from urllib.error import HTTPError
from urllib.request import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from official_http import fetch_html, OfficialRedirects

URL = 'https://www.tokyodisneyresort.jp/tdl/attraction/'


class Response(io.BytesIO):
    url = URL


class OfficialHttpTests(unittest.TestCase):
    def test_transient_timeout_retries_once_and_returns_only_received_html(self):
        calls, pauses = [], []
        def open_url(request, timeout):
            calls.append((request.full_url, timeout))
            if len(calls) == 1:
                raise TimeoutError('read timed out')
            return Response(b'<html>verified</html>')
        self.assertEqual(fetch_html(URL, opener=open_url, pause=pauses.append), '<html>verified</html>')
        self.assertEqual(len(calls), 2)
        self.assertEqual(pauses, [2])

    def test_timeout_remains_a_failure_after_the_retry(self):
        calls = []
        def fail(request, timeout):
            calls.append(request.full_url)
            raise TimeoutError('still unavailable')
        with self.assertRaises(TimeoutError):
            fetch_html(URL, opener=fail, pause=lambda _: None)
        self.assertEqual(len(calls), 2)

    def test_access_denial_and_long_retry_after_are_not_retried(self):
        for code, headers in [(403, {}), (429, {'Retry-After': '60'})]:
            calls = []
            def denied(request, timeout):
                calls.append(1)
                raise HTTPError(URL, code, 'unavailable', headers, None)
            with self.assertRaises(HTTPError):
                fetch_html(URL, opener=denied, pause=lambda _: self.fail('must not retry'))
            self.assertEqual(len(calls), 1)

    def test_oversized_and_incomplete_responses_do_not_become_success(self):
        for data, limit in [(b'<html>truncated', 100), (b'<html>too big</html>', 8)]:
            with self.assertRaises(ValueError):
                fetch_html(URL, opener=lambda *a, **k: Response(data), max_bytes=limit)

    def test_redirects_are_checked_before_the_target_is_requested(self):
        handler = OfficialRedirects()
        for target in ['http://www.tokyodisneyresort.jp/', 'https://example.com/', 'https://user:secret@www.tokyodisneyresort.jp/']:
            with self.assertRaises(ValueError):
                handler.redirect_request(Request(URL), None, 302, 'redirect', {}, target)


if __name__ == '__main__':
    unittest.main()
