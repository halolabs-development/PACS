// The separate viewer window's Report Editor tab (viewer-report-panel.js): a read-only mirror of the
// current patient tab's report beside the images, in the tool dock. It is mounted once per document,
// like the patient tabs it follows, and survives a mode re-entry. Not in the reading screen's frame
// (its Report Editor is already beside the images) and not in a read-only session.
function kinCreateViewerReportPanel() {
  // Also run on its own (a page test takes this function out of config/ohif.js): the words then stay as written.
  const kinText = globalThis.kinText || ((t, ...p) => t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i]))), kinHtml = globalThis.kinHtml || kinText, kinError = globalThis.kinError || ((t, ...p) => Object.assign(new Error(kinText(t, ...p)), { kinWords: true }));
  let ready, panel = null, frame, generation = 0;
  const assets = [['exam-scope.js', () => !!window.KinExamScope], ['viewer-editor-link.js', () => typeof window.kinViewerEditorLink === 'function'],
    ['report-preview.js', () => typeof window.KinReportPaper?.approvalText === 'function'],
    ['viewer-report-panel.js', () => !!window.KinViewerReportPanel]];
  function load() {
    return ready ||= assets.reduce((previous, [name, loaded]) => previous.then(() => loaded() ? undefined : new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/' + name;
      script.onload = () => { script.remove(); resolve(); };
      script.onerror = () => { script.remove(); reject(kinError("Report Editor 패널을 불러오지 못했습니다.")); };
      document.head.append(script);
    })), Promise.resolve()).catch(error => { ready = null; throw error; });
  }
  return {
    id: 'kin.viewer-report-panel',
    onModeEnter() {
      if (window.top !== window) return;
      if (panel) { panel.attach(); return; }
      const ticket = ++generation;
      Promise.all([load(), kinViewerSession.decide()]).then(([, state]) => {
        const attach = () => {
          if (ticket !== generation || panel || state !== 'writer' || kinViewerSession.ended() || kinViewerSession.readOnly()) return;
          if (!window.KinViewerPatientTabs || !window.KinWorkContext) { frame = requestAnimationFrame(attach); return; }
          panel = window.KinViewerReportPanel.mount({ window, tabs: window.KinViewerPatientTabs, session: kinViewerSession,
            work: window.KinWorkContext, onEnd: kinViewerOnEnd });
        };
        attach();
      }).catch(() => {});
    },
    onModeExit() { generation++; cancelAnimationFrame(frame); },
  };
}

