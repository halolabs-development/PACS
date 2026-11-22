
function kinCreateImageText() {
  // Also run on its own (a page test takes this function out of config/ohif.js): the words then stay as written.
  const kinText = globalThis.kinText || ((t, ...p) => t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i]))), kinHtml = globalThis.kinHtml || kinText, kinError = globalThis.kinError || ((t, ...p) => Object.assign(new Error(kinText(t, ...p)), { kinWords: true }));
  let ready, current, epoch = 0, ended = false, listening = false, channel;
  function endSession() {
    if (ended) return; ended = true; epoch++; current?.stop(); current = null;
     window.removeEventListener('pagehide', endSession);
    channel?.close(); channel = null;
  }

  function watchSession() {
    if (listening) return; listening = true;
     window.addEventListener('pagehide', endSession);
    try { channel = kinViewerOnEnd(() => endSession()); } catch (_) { }
  }
  function prepare() {
    if (window.KinViewerImageText) return Promise.resolve(window.KinViewerImageText);
    if (!ready) ready = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/viewer-image-text.js';
      const timer = setTimeout(() => finish(kinError("Image Text 도구를 불러오지 못했습니다. 뷰어를 다시 여세요.")), 10000);
      function finish(error) { clearTimeout(timer); script.onload = script.onerror = null; if (error) { script.remove(); reject(error); } else resolve(window.KinViewerImageText); }
      script.onload = () => finish(window.KinViewerImageText ? null : kinError("Image Text 모듈을 확인할 수 없습니다."));
      script.onerror = () => finish(kinError("Image Text 도구를 불러오지 못했습니다. 뷰어를 다시 여세요."));
      document.head.append(script);
    }).catch(error => { ready = null; throw error; });
    return ready;
  }
  return { id: 'kin.image-text', onModeEnter({ servicesManager }) {
    if (ended) return; watchSession();
    const ticket = ++epoch; current?.stop(); current = null;
    prepare().then(module => {
      if (ticket !== epoch) return;
      const connected = module.create(servicesManager.services);
      if (!connected.mount()) { connected.stop(); throw kinError("Image Text 패널을 연결하지 못했습니다."); }
      current = connected;
    }).catch(error => { if (ticket === epoch) { const status = document.querySelector('#kin-viewer-layout-status'); if (status) status.textContent = error.message; } });
  }, onModeExit() { epoch++; current?.stop(); current = null; } };
}
