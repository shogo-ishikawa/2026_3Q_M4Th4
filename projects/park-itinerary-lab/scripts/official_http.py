"""Bounded, identifiable requests to the public official website."""
from __future__ import annotations

import time
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
