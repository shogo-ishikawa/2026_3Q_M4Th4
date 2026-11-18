"""Bounded, identifiable requests to the public official website."""
from __future__ import annotations

import time
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

HOST = 'www.tokyodisneyresort.jp'
USER_AGENT = 'ParkItineraryLab/1.6 (+https://github.com/shogo-ishikawa/2026_3Q_M4Th4; educational catalogue updater)'


def official_url(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname != HOST or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('A public official HTTPS URL is required')
    return url


class OfficialRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, target):
        official_url(target)
        return super().redirect_request(request, response, code, message, headers, target)


def fetch_html(url, *, timeout=25, retries=1, max_bytes=8_000_000, opener=None, pause=time.sleep):
    """Retry transient failures once; never retry access denial or verification pages.

    The read size and socket timeout are bounded. Each failed request stays a
    failure until valid HTML is actually received and parsed by the caller.
    """
    official_url(url)
    if not 0 < timeout <= 60 or retries not in (0, 1):
        raise ValueError('Unsupported official request timeout or retry count')
    open_url = opener or build_opener(OfficialRedirects()).open
    for attempt in range(retries + 1):
        try:
            if opener is None and os.environ.get('PARK_OFFICIAL_HTTP') == 'curl':
                raw = curl_bytes(url, timeout, max_bytes)
            else:
                request = Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml'})
                with open_url(request, timeout=timeout) as response:
                    official_url(response.url)
                    raw = response.read(max_bytes + 1)
            if len(raw) > max_bytes:
                raise ValueError('Official page is larger than the supported limit')
            html = raw.decode('utf-8')
            if '<html' not in html.lower() or '</html>' not in html.lower():
                raise ValueError('Incomplete official HTML response')
            return html
        except HTTPError as error:
            # A denial is not a transient connection problem. Honour a short
            # Retry-After; a longer server delay waits for the next update run.
            retry_after = error.headers.get('Retry-After', '') if error.headers else ''
            delay = int(retry_after) if retry_after.isdigit() else 2
            if error.code not in {429, 500, 502, 503, 504} or delay > 10 or attempt == retries:
                raise
        except (TimeoutError, ConnectionError, URLError):
            delay = 2
            if attempt == retries:
                raise
        pause(delay)


def curl_bytes(url, timeout, max_bytes):
    """Use the hosted runner's standard curl/TLS stack; no browser impersonation.

    Redirects are followed one at a time so their origin can be checked before
    another request. Certificate verification remains enabled.
    """
    from urllib.parse import urljoin
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='park-official-') as folder:
        body, headers = Path(folder)/'body', Path(folder)/'headers'
        for _ in range(4):
            official_url(url)
            remaining = max(1, timeout - (time.monotonic()-started))
            try:
                result = subprocess.run(['curl','--silent','--show-error','--compressed','--proto','=https',
                                     '--connect-timeout',str(min(10,remaining)),'--max-time',str(remaining),
                                     '--max-filesize',str(max_bytes),'--user-agent',USER_AGENT,
                                     '--header','Accept: text/html,application/xhtml+xml',
                                     '--dump-header',str(headers),'--output',str(body),'--write-out','%{http_code}',url],
                                        capture_output=True, text=True, timeout=remaining+3)
            except subprocess.TimeoutExpired as error:
                raise TimeoutError('Official curl process exceeded its deadline') from error
            if result.returncode == 28:
                raise TimeoutError('Official curl request timed out')
            if result.returncode:
                raise URLError('Official curl request failed: '+result.stderr.strip()[:200])
            status = int(result.stdout)
            fields = dict(line.split(':',1) for line in headers.read_text().splitlines() if ':' in line)
            fields = {key.lower():value.strip() for key,value in fields.items()}
            if status in {301,302,303,307,308}:
                url = official_url(urljoin(url, fields.get('location','')))
                continue
            if status >= 400:
                raise HTTPError(url,status,'Official HTTP error',{'Retry-After':fields.get('retry-after','')},None)
            if status != 200:
                raise ValueError('Unexpected official HTTP status')
            return body.read_bytes()
        raise ValueError('Too many official redirects')
