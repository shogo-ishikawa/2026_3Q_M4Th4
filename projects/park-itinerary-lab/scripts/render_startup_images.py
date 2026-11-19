"""Render the installed app's launch screen for the iPhone sizes declared in index.html."""
import json
from pathlib import Path
import re
import shutil

from playwright.sync_api import sync_playwright

PROJECT = Path(__file__).resolve().parents[1]
WEB = PROJECT / 'web'


def main():
    version = json.loads((PROJECT / 'version.json').read_text())['version']
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=shutil.which('chromium'), headless=True)
        # Render the shipped HTML and CSS without signing in or contacting any service.
        page = browser.new_page(java_script_enabled=False)
        page.goto((WEB / 'index.html').as_uri())
        links = page.locator('link[rel="apple-touch-startup-image"]').evaluate_all(
            "(links) => links.map(link => [link.getAttribute('href'), link.media])"
        )
        if not links:
            raise ValueError('No iPhone startup images are declared')
        for href, media in links:
            path, query = href.split('?')
            width = int(re.search(r'device-width: (\d+)px', media)[1])
            height = int(re.search(r'device-height: (\d+)px', media)[1])
            ratio = int(re.search(r'device-pixel-ratio: (\d+)', media)[1])
            if query != 'v=' + version or path != f'assets/pwa/startup-{width * ratio}x{height * ratio}.jpg':
                raise ValueError(f'Check the version and dimensions of {href}')
            screen = browser.new_page(viewport={'width': width, 'height': height},
                                      device_scale_factor=ratio, java_script_enabled=False)
            screen.goto((WEB / 'index.html').as_uri())
            splash = screen.locator('#launchSplash')
            splash.evaluate('element => { element.hidden = false; }')
            if splash.locator('.launch-version').inner_text() != 'v' + version:
                raise ValueError('Update the splash version in index.html before rendering')
            screen.evaluate("async () => { const hero = new Image(); hero.src = 'assets/land-hero.webp'; await hero.decode(); }")
            jpeg = splash.screenshot(type='jpeg', quality=85)
            # A JPEG comment records the visible release for the dependency-free packaging check.
            comment = f'TDRoute v{version}\n'.encode('ascii')
            marker = b'\xff\xfe' + (len(comment) + 2).to_bytes(2, 'big') + comment
            # Leave the JFIF application marker directly after the start of image.
            if jpeg[2:4] != b'\xff\xe0':
                raise ValueError('Expected a JPEG with a JFIF header')
            header_end = 4 + int.from_bytes(jpeg[4:6], 'big')
            (WEB / path).write_bytes(jpeg[:header_end] + marker + jpeg[header_end:])
            screen.close()
        browser.close()


if __name__ == '__main__':
    main()
