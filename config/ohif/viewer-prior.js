// U3 consumes the U2 document/viewport context. The native data source still
// owns DICOM loading and display-set creation; reports are API reads only.
function kinCreateViewerPrior() {
  // Also run on its own (a page test takes this function out of config/ohif.js): the words then stay as written.
  const kinText = globalThis.kinText || ((t, ...p) => t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i]))), kinHtml = globalThis.kinHtml || kinText, kinError = globalThis.kinError || ((t, ...p) => Object.assign(new Error(kinText(t, ...p)), { kinWords: true }));
  let services, extensions, generation = 0, ready, dispose, frame;
  const assets = ['viewer-prior-controller.js', 'viewer-prior-panel.js'];
  const asset = name => new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/' + name;
    script.onload = () => { script.remove(); resolve(); };
    script.onerror = () => { script.remove(); reject(kinError("이전 검사 모듈을 불러오지 못했습니다.")); };
    document.head.append(script);
  });
  // report-preview.js: the report screens' one rule for a version's time (KinReportPaper), which the panel shows with. It
  // loads beside the controller and the panel (they keep their order), so the extension starts when it did before.
  function load() {
    return ready ||= Promise.all([window.KinReportPaper?.versionStamp ? null : asset('report-preview.js'),
      assets.reduce((previous, name) => previous.then(() => asset(name)), Promise.resolve())])
      .catch(error => { ready = null; throw error; });
  }
  function stop() { generation++; cancelAnimationFrame(frame); dispose?.(); dispose = null; }
  function mount(viewer) {
    const host = document.createElement('section'); host.hidden = true; host.dataset.kinUxOwned = '';
    host.className = 'kin-viewer-prior-list';
    const style = document.createElement('style');
    style.textContent = `.kin-viewer-prior-list{position:absolute;right:0;top:0;z-index:35;max-width:100%;max-height:100%;overflow:auto;background:#2D2D2D;color:#E3E3E3;border:1px solid #8AB4C8;padding:8px;font-size:12px}
      .kin-viewer-prior-list[hidden]{display:none}.kin-viewer-prior-list table{border-collapse:collapse;width:100%}.kin-viewer-prior-list th,.kin-viewer-prior-list td{padding:4px;text-align:left;border-bottom:1px solid #555}
      .kin-viewer-prior-list button,.kin-viewer-prior-report button{background:#212121;color:#E3E3E3;border:1px solid #8AB4C8;padding:4px;cursor:pointer}.kin-viewer-prior-list tr:focus-within,.kin-viewer-prior-list tbody tr:hover{background:#3b4c54}
      .kin-viewer-prior-report{z-index:36;overflow:auto}.kin-viewer-prior-report p{overflow-wrap:anywhere}`;
    document.head.append(style);
    let anchor = null, reportOpener = null, reportUid = null, listOpen = false;
    const closeList = () => { controller.close(); if (anchor?.isConnected) anchor.focus(); };
    const report = (uid, opener) => { reportUid = uid; reportOpener = opener; controller.openReport(uid); };
    const controller = window.KinViewerPriorController.create({ viewer,
      async loadStudy(uid, origin, row, options = {}) {
        // A related exam whose originals cannot all be read now is not opened beside this one, in part or whole.
        const lost=window.KinExamScope?.unavailable?.(row);
        if(lost)throw Error(lost.message);
        const input=window.KinViewerExamScope?.snapshot();
        let scope=null;
        if(input||row?.examScope){
          if(input)await window.KinViewerExamScope.ensure(true);
          if(options.valid && !options.valid())return [];
          scope=input&&[input.current,input.prior].find(value=>value?.reportUid===uid);
          if(!scope){
            const before=viewer.snapshot(),model=window.KinExamScope;
            const current=input?.current||model.read({uid:before.studyUIDs[0]});
            const prior=model.read(row);
            const next=model.viewerInput(current,prior,input?.version??null);
            if(input?.purpose)next.purpose=input.purpose;
            // Reopening admits both roles through the existing window and unsaved-work gate.
            next.scoped=true;
            const url=new URL(model.viewerUrl(next,options.seriesUid),location.origin);
            url.hash=location.hash;
            const opened=await window.kinViewerOpenPatient?.(url.href,{signal:options.signal});
            if(!opened)throw kinError("저장·편집 또는 배치를 확인한 뒤 다시 시도하세요. 현재 영상은 유지합니다.");
            return {reopened:true};
          }
        }
        const source = extensions.getActiveDataSource()[0];
        const originals=scope?scope.sources.map(value=>value.studyUid):[uid];
        try { for(const original of originals)await source.retrieve.series.metadata({ StudyInstanceUID: original, madeInClient: true }); }
        catch (error) {
          // The pinned loader caches failed metadata promises. A user's Retry
          // must reach the data source again rather than replay that failure.
          for(const original of originals)source.deleteStudyMetadataPromise(original); throw error;
        }
        const sets = services.displaySetService.getActiveDisplaySets().filter(set => (scope?scope.sources.some(original=>original.studyUid===set.StudyInstanceUID&&window.KinExamScope.allows(original,set.SeriesInstanceUID)):set.StudyInstanceUID === uid) && set.images?.length)
          .sort(kinSeriesOrder);
        // Priors are ranked against the display set in the cell that asked, which for a split series is one of its parts.
        const own = origin.displaySetUid && services.displaySetService.getDisplaySetByUID(origin.displaySetUid);
        const sourceSet = own?.StudyInstanceUID === origin.studyUid && own.SeriesInstanceUID === origin.seriesUid ? own
          : services.displaySetService.getActiveDisplaySets().find(set => set.StudyInstanceUID === origin.studyUid && set.SeriesInstanceUID === origin.seriesUid);
        return window.KinViewerHangingSettings.rank(sets, sourceSet, window.kinViewerHangingPreference?.(sourceSet?.Modality).seriesMatch);
      },
      onList(value) {
        listOpen = value.state !== 'closed';
        window.KinViewerPriorPanel.list(host, value, { openImages: uid => controller.openImages(uid),
          openReport: report, retry: () => controller.retryList(), close: closeList });
      },
      onReport(value) {
        if (value.state === 'closed') { viewer.reportHost.close({ notify: false }); host.hidden = !listOpen; return; }
        // Collapse the dropdown while its report covers the image. Keep its
        // rows so Close can restore the exact keyboard opener.
        host.hidden = true;
        viewer.reportHost.render(value.origin, (container, controls) => window.KinViewerPriorPanel.report(container, value, controls),
          { opener: reportOpener, onClose: () => controller.closeReport(), onRetry: () => controller.openReport(reportUid) });
      },
    });
    host.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeList(); } };
    const unregister = viewer.registerStudyActions({
      listPriors(value) {
        anchor = value.anchor;
        const pane = anchor.closest('[data-cy="viewport-pane"]');
        if (!pane) return;
        pane.append(host);
        // The list starts immediately below the cell's Study information bar.
        host.style.top = anchor.closest('.kin-viewer-info-bar').offsetHeight + 'px';
        host.style.maxHeight = 'calc(100% - ' + host.style.top + ')';
        controller.open(value);
      },
      openImages: controller.openImages, openReport: report, refresh: controller.refresh,
      // The same list and opening for the Compare menu, read while the panel is closed too.
      related: controller.related,
    });
    const channel = kinViewerOnEnd(stop);
    return () => { channel?.close(); unregister(); controller.dispose(); host.remove(); style.remove(); };
  }
  return {
    id: 'kin.viewer-prior',
    preRegistration({ servicesManager, extensionManager }) { services = servicesManager.services; extensions = extensionManager; },
    onModeEnter() {
      stop(); if (window.top !== window) return;
      const ticket = generation;
      load().then(() => {
        const attach = () => {
          if (ticket !== generation || kinViewerSession.ended()) return;
          if (kinViewerSession.readOnly()) return;
          if (window.KinViewerUX) dispose = mount(window.KinViewerUX);
          else frame = requestAnimationFrame(attach);
        };
        attach();
      }).catch(error => { if (ticket === generation) services.uiNotificationService?.show({ title: 'Studies', message: error.message, type: 'error' }); });
    },
    onModeExit: stop,
  };
}

