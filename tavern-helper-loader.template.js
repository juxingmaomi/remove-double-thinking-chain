(async () => {
  const REPO = 'juxingmaomi/remove-double-thinking-chain';
  const VERSION = 'v0.0.15';
  const URL = `https://gcore.jsdelivr.net/gh/${REPO}@${VERSION}/index.js`;

  const loaderState = {
    repo: REPO,
    loadedTag: VERSION,
    source: 'manual',
    url: URL,
    requestedAt: new Date().toISOString(),
  };
  window.__TH_REMOVE_DOUBLE_THINKING_CHAIN_LOADER__ = loaderState;

  function popup(type, message) {
    try {
      let toastr = window.toastr;
      try {
        if (!toastr && window.parent && window.parent !== window) {
          toastr = window.parent.toastr;
        }
      } catch (_) {}
      if (toastr && typeof toastr[type] === 'function') {
        toastr[type](message);
        return;
      }
      if (type === 'error') {
        alert(message);
        return;
      }
      console.log(`[remove-double-thinking-chain] ${message}`);
    } catch (error) {
      console.warn('[remove-double-thinking-chain] Popup failed.', error);
    }
  }

  try {
    await import(URL);
    loaderState.loadedAt = new Date().toISOString();
    popup('success', `去除双思维链已加载 ${VERSION}`);
  } catch (error) {
    loaderState.error = String(error && error.message || error);
    console.error('[remove-double-thinking-chain] Load failed.', error);
    popup('error', `去除双思维链 ${VERSION} 加载失败。请确认 GitHub 已发布这个版本。`);
  }
})();
