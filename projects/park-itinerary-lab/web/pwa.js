/* Installation and launch depend on the browser's own home-screen support. */
export function mobilePlatform(navigator) {
  if (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(navigator.userAgent) || navigator.userAgentData?.mobile) return 'android';
  return 'desktop';
}

export function isFreshLaunch(navigationType, referrer, appUrl) {
  if (navigationType === 'reload' || navigationType === 'back_forward') return false;
  // Opening the guide and returning to the planner should not replay the splash.
  return !referrer.startsWith(appUrl);
}

function prepareOffline(appUrl, setStatus) {
  const unavailable = 'オフラインの準備ができませんでした。通信できる場所でもう一度開いてください。';
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  setStatus('オフラインでしおりを開く準備中です。');
  navigator.serviceWorker.register('./sw.js', {scope: './', updateViaCache: 'none'}).then(registration => {
    const worker = registration.installing;
    function checkFailure() {
      if (worker?.state === 'redundant' && !registration.active) setStatus(unavailable);
    }
    worker?.addEventListener('statechange', checkFailure);
    checkFailure();
    return navigator.serviceWorker.ready;
  }).then(registration => {
    if (registration.scope === appUrl) setStatus('オフラインでしおりを開く準備ができました。');
  }).catch(() => setStatus(unavailable));
}

// Keep website-only links inert until the page knows which surface opened it.
const appDisplayModes = ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay', 'tabbed'];

export function initialisePwa() {
  const byId = id => document.getElementById(id);
  const install = byId('installApp');
  const dialog = byId('installHelp');
  const splash = byId('launchSplash');
  const platform = mobilePlatform(navigator);
  const appUrl = new URL('./', location.href).href;
  const standalone = window.matchMedia(appDisplayModes.map(mode => '(display-mode: ' + mode + ')').join(', '));
  const websiteContent = Array.from(document.querySelectorAll('template[data-website]'), template => ({
    template, nodes: Array.from(template.content.childNodes)
  }));
  let promptEvent;
  let installed = false;

  function updateMode() {
    const launched = standalone.matches || navigator.standalone === true;
    document.documentElement.classList.toggle('tdroute-standalone', launched);
    for (const {template, nodes} of websiteContent) {
      if (template.content.hasChildNodes() === launched) continue;
      if (launched) template.content.append(...nodes);
      else template.after(...nodes);
    }
    if (install) {
      install.hidden = installed || launched;
      if (install.hidden && dialog.open) dialog.close();
    }
    return launched;
  }

  const launched = updateMode();
  if (standalone.addEventListener) standalone.addEventListener('change', updateMode);
  else standalone.addListener?.(updateMode);
  if (!install) return; // The guide only needs its presentation mode.

  function dismissSplash() { splash.hidden = true; }
  if (launched && !document.hidden && isFreshLaunch(performance.getEntriesByType('navigation')[0]?.type, document.referrer, appUrl)) {
    splash.hidden = false;
    window.addEventListener('tdroute:ready', dismissSplash, {once: true});
    window.addEventListener('pagehide', dismissSplash, {once: true});
    document.addEventListener('visibilitychange', dismissSplash, {once: true});
    // Let users access the interface even if a module fails or the network stalls.
    window.setTimeout(dismissSplash, 2400);
  }
  window.addEventListener('appinstalled', () => {
    installed = true;
    promptEvent = undefined;
    updateMode();
  });
  window.addEventListener('beforeinstallprompt', event => {
    if (platform === 'desktop') return;
    event.preventDefault();
    promptEvent = event;
    installed = false;
    updateMode();
  });

  function showHelp() {
    byId('installIos').hidden = platform !== 'ios';
    byId('installAndroid').hidden = platform !== 'android';
    byId('installDesktop').hidden = platform !== 'desktop';
    const publicUrl = byId('installPublicLink').href;
    const localServer = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    byId('installUrl').value = localServer || !window.isSecureContext ? publicUrl : appUrl;
    byId('installPublicHelp').hidden = window.isSecureContext;
    byId('installFirstLaunch').hidden = platform === 'desktop';
    byId('installCopyStatus').textContent = '';
    if (typeof dialog.showModal !== 'function') {
      window.alert(byId({ios: 'installIos', android: 'installAndroid', desktop: 'installDesktop'}[platform]).innerText + '\n' + byId('installUrl').value);
      return;
    }
    dialog.showModal();
    byId('installTitle').focus();
  }

  install.addEventListener('click', async () => {
    if (!promptEvent) { showHelp(); return; }
    // Browser prompts are single use and must be invoked within this click.
    const request = promptEvent;
    promptEvent = undefined;
    install.disabled = true;
    try {
      await request.prompt();
      const choice = await request.userChoice;
      if (choice.outcome === 'accepted') { installed = true; updateMode(); }
    } catch {
      if (!install.hidden) showHelp();
    } finally {
      install.disabled = false;
    }
  });
  dialog.addEventListener('close', () => {
    if (!install.hidden) install.focus({preventScroll: true});
  });
  byId('copyInstallUrl').addEventListener('click', async () => {
    const url = byId('installUrl');
    try {
      await navigator.clipboard.writeText(url.value);
      byId('installCopyStatus').textContent = 'URLをコピーしました。';
    } catch {
      url.focus();
      url.select();
      byId('installCopyStatus').textContent = '選択したURLをコピーしてください。';
    }
  });
  prepareOffline(appUrl, message => { byId('appOfflineState').textContent = message; });
}

if (typeof document !== 'undefined') initialisePwa();
