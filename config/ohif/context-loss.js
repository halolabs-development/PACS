
function kinCreateContextLoss() {
  // Also run on its own (a page test takes this function out of config/ohif.js): the words then stay as written.
  const kinText = globalThis.kinText || ((t, ...p) => t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i]))), kinHtml = globalThis.kinHtml || kinText, kinError = globalThis.kinError || ((t, ...p) => Object.assign(new Error(kinText(t, ...p)), { kinWords: true }));
  let ready, current, services, epoch = 0;
  function prepare() {
    if (!ready) ready = (window.KinViewerContextLoss ? Promise.resolve() : new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/viewer-context-loss.js';
      const finish = error => { clearTimeout(timer); script.onload = script.onerror = null; script.remove(); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(kinError("영상 복구 도구 연결 시간이 지났습니다.")), 20000);
      script.onload = () => finish(window.KinViewerContextLoss?.create ? null : kinError("영상 복구 도구를 확인할 수 없습니다."));
      script.onerror = () => finish(kinError("영상 복구 도구를 불러오지 못했습니다.")); document.head.append(script);
    })).catch(error => { ready = null; throw error; });
    return ready;
  }
  const extension = { id: 'kin.context-loss', preRegistration({ servicesManager }) { services = servicesManager.services; },
    onModeEnter() {
      const ticket = ++epoch; kinToolRetry('kin-context-retry'); current?.stop(); current = null;
      prepare().then(() => {
        if (ticket !== epoch) return;
        current = window.KinViewerContextLoss.create({ services, session: kinViewerSession });
        window.kinViewerContextLoss = current; current.start();
        window.dispatchEvent(new Event('kin-context-recovery-ready'));
      }).catch(error => { if (ticket === epoch) kinToolRetry('kin-context-retry', error.message, () => extension.onModeEnter()); });
    }, onModeExit() { epoch++; kinToolRetry('kin-context-retry'); current?.stop(); current = null; } };
  return extension;
}
