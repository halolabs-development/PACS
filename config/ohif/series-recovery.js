
/* S3-U5 CI1. OHIF 3.9.1 로더는 시리즈 메타데이터 GET 하나가 거절되면 다시 묻지 않고 검사 캐시에 거절된 약속을
   남긴다(retrieveMetadataLoaderAsync.js:65-83, retrieveStudyMetadata.js:30-32). 그래서 서버의 500 한 번에 현재 검사
   칸이 빈 채로 끝났다. 설정에서 닿는 재시도 지점이 없으므로 이번 모드 수명주기의 WADO 클라이언트 인스턴스 하나에만
   공개 메서드 retrieveSeriesMetadata(시리즈별)와 searchForSeries(검사의 시리즈 목록)를 자기 속성으로 씌우고, 나갈 때
   그 속성이 아직 이 확장의 것일 때만 지운다. prototype·전역 fetch/XHR은 건드리지 않는다.
   - 다시 묻는 것은 HTTP 500~599 또는 AUTH_* 일시 실패로 거절된 GET이다. 종료 신호·코드 없는 4xx·0·동기 예외는 원래
     결과를 그대로 돌려준다. (수명주기, 검사, 시리즈|목록)마다 한 번, 고정 1000ms 뒤, 같은 this·options로 보낸다.
   - 로더가 쥐는 약속은 여기서 돌려준 하나뿐이다. 다시 받은 응답으로 그 약속을 한 번 채우므로 storeInstances·표시 세트·
     HP 적용도 한 번만 일어난다. 끝난 실패는 마지막 오류로 거절하고 영상이 준비된 척하지 않는다.
   - 이전 검사(현재 검사가 아닌 것)는 이 경로의 첫 배치를 5초 넘게 붙잡지 않는다: 이전 검사마다 기한 하나 — 현재 검사의
     목록이 끝난 때(이 문서가 현재 목록을 이미 가져 요청하지 않으면 그 이전 검사의 첫 요청 때)부터 5초 — 를 그 검사의
     목록·시리즈 요청이 함께 쓰고, 기한에 아직 오지 않은 요청은 '늦음'으로 거절하며 늦게 온 답은 버린다. 첫 배치 뒤의 요청
   - URL의 검사 목록과 수명주기에 묶는다. 나가거나 URL이 바뀌면 기다리던 재요청은 보내지 않고 원래 오류로 끝내며
     알림도 남기지 않는다.
   - 실패는 URL 순서의 검사 번호와 HTTP 상태로만 알린다. UID·환자 정보는 쓰지 않는다. 사유는 상태 패널의 줄과 영상 위의
     보이는 줄(#kin-viewer-open-status)에 같이 쓴다.
   - 실패한 검사는 이 문서가 사는 동안 기억한다(kinViewerFailedStudies): OHIF가 그 거절을 문서 수명 동안 다시 쓰므로,
     그 검사를 다시 보이려면 새 문서여야 한다(목록의 창 열기와 환자 탭이 이것을 읽는다).
   - 배치: 목록을 못 받은 검사는 OHIF의 검사 목록에 빈 값으로 남아 배치가 예외로 멈춘다(Route Error Boundary). 문서 수명
     동안 한 번 hangingProtocolService.run을 감싸 빈 값을 빼고, 지금 주소의 현재 검사 가운데 하나라도 없으면 배치하지 않는다
     (일부만, 이전 검사를 현재처럼, 떠난 경로의 늦은 배치를 지금 화면에 놓지 않는다). 다른 확장의 경로별 감싸개보다 먼저(preRegistration) 씌워 그 아래에 둔다.
   - 현재 검사의 목록이 접근 거절이면 환자 탭의 권한 없음 화면으로 넘긴다(KinViewerPatientTabs.imagesRefused).
   - 모양이 예상과 다르면 씌우지 않고 기본 동작을 둔 채 그 사실만 표시한다. */
function kinCreateSeriesMetadataRecovery() {
  const retryDelay = 1000, priorGrace = 5000, own = (target, key) => Object.prototype.hasOwnProperty.call(target, key);
  let services = null, extensions = null, ticket = null, phase = 'stopped';
  // Document lifetime: studies whose image read failed here (OHIF reuses that failure), and studies whose image list this
  // document has (OHIF answers a later route from its cache without a request).
  const failedStudies = new Set(), listedStudies = new Set();
  const retryable = error => !!error && typeof error === 'object' && !!error.request &&
    (window.KinSessionTransport.refusal(error) === 'temporary' ||
      Number.isInteger(error.status) && error.status >= 500 && error.status <= 599);
  function studiesOf(search) {
    const list = [];
    for (const value of new URLSearchParams(search).getAll('StudyInstanceUIDs'))
      for (const uid of value.split(',')) if (uid && !list.includes(uid)) list.push(uid);
    return list;
  }
  // The current exam's studies in this URL: the admitted exam scope's current originals, otherwise the first study (a merged
  // exam's URL also lists its prior's originals, so the URL alone never makes a second study current). The rest are priors.
  function currentOf(search, studies) {
    try {
      const scope = window.KinViewerExamScope;
      if (scope?.snapshot?.()) { const list = studies.filter(uid => scope.role(uid) === 'current'); if (list.length) return list; }
    } catch (_) {}
    return studies.slice(0, 1);
  }
  // 다른 확장이 함께 쓰는 #kin-viewer-layout-status 문구를 덮지 않도록 같은 상태 패널 안의 자기 줄만 쓴다.
  function say(text) {
    let node = document.querySelector('#kin-series-metadata-status');
    if (!text) { node?.remove(); return; }
    if (!node) {
      const panel = document.querySelector('#kin-viewer-layout'); if (!panel) return;
      node = document.createElement('p'); node.id = 'kin-series-metadata-status'; node.setAttribute('role', 'alert');
      node.style.cssText = 'margin:6px 0;color:#ffb4a8'; panel.append(node);
    }
    node.textContent = text;
  }
  // The same reason where the reader looks: one line over the images (the panel above may be collapsed).
  function show(text) {
    let node = document.querySelector('#kin-viewer-open-status');
    if (!text) { node?.remove(); return; }
    if (!node) {
      node = document.createElement('p'); node.id = 'kin-viewer-open-status'; node.setAttribute('role', 'status');
      node.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:1000;max-width:min(60em,calc(100vw - 16px));' +
        'box-sizing:border-box;margin:0;padding:4px 8px;background:#2D2D2D;color:#ffb4a8;border:1px solid currentColor;' +
        'font:12px/1.4 sans-serif;white-space:normal';
      document.body.append(node);
    }
    node.textContent = text;
  }
  function describe(failure) {
    const code = Number.isInteger(failure.status) && failure.status > 0 ? 'HTTP ' + failure.status : '요청 오류';
    if (failure.late) return failure.position + (failure.list ? '번째 검사의 영상 정보가 늦어 그 검사 없이 표시했습니다. 뷰어를 다시 열면 다시 요청합니다.'
      : '번째 검사의 일부 시리즈 영상 정보가 늦어 그 시리즈 없이 표시했습니다. 뷰어를 다시 열면 다시 요청합니다.');
    if (window.KinSessionTransport.refusal(failure.error) === 'temporary') return failure.position + '번째 검사의 연결을 확인하지 못했습니다. 뷰어를 다시 열어 재시도하세요.';
    if (window.KinSessionTransport.openFailure(failure.error) === 'denied') return failure.position + '번째 검사의 영상 정보에 접근할 수 없습니다(' + code + '). 이 검사 영상은 표시하지 않았습니다.';
    return failure.position + '번째 검사의 영상 정보를 ' + (failure.retried ? '한 번 다시 요청했지만 ' : '') +
      '불러오지 못했습니다(' + code + '). 이 검사 영상은 표시하지 않았습니다. 뷰어를 다시 여세요.';
  }
  function render(current) {
    const failures = [...current.failures.values()].sort((a, b) => a.position - b.position);
    say([...new Set(failures.map(describe))].join(' '));
    // A refused current study shown on the patient tabs' one-line screen (KinViewerPatientTabs.imagesRefused) gets nothing more over it.
    show([...new Set(failures.filter(failure => !failure.screen).map(describe))].join(' '));
  }
  function release() {
    const current = ticket; ticket = null; phase = 'stopped'; say(''); show('');
    if (!current) return;
    for (const wait of current.waits) { clearTimeout(wait.timer); wait.cancel(); }
    for (const deadline of current.priors) clearTimeout(deadline.timer);
    current.waits.clear(); current.priors.clear(); current.failures.clear();
    for (const [key, wrapper] of Object.entries(current.wrappers))
      if (own(current.client, key) && current.client[key] === wrapper) delete current.client[key];
  }
  function install() {
    const search = location.search, studies = studiesOf(search);
    const refuse = () => { phase = 'refused'; say('영상 정보 재요청 기능을 연결하지 못했습니다. 기본 동작으로 계속 표시하며, 영상 칸이 비어 있으면 뷰어를 다시 여세요.'); };
    let client = null, config = null;
    try {
      const source = extensions?.getActiveDataSource?.()?.[0];
      client = typeof source?.retrieve?.getWadoDicomWebClient === 'function' ? source.retrieve.getWadoDicomWebClient() : null;
      config = typeof source?.getConfig === 'function' ? source.getConfig() : null;
    } catch (_) { client = null; }
    // 지연 로드가 꺼져 있으면 로더가 이 메서드들을 부르지 않으므로 복구가 성립하지 않는다.
    if (!client || typeof client !== 'object' || typeof client.retrieveSeriesMetadata !== 'function' ||
        typeof client.searchForSeries !== 'function' || own(client, 'retrieveSeriesMetadata') || own(client, 'searchForSeries') ||
        config?.enableStudyLazyLoad !== true || !studies.length) return refuse();
    const current = { client, search, wrappers: {}, used: new Set(), waits: new Set(), priors: new Set(), failures: new Map(), retries: 0,
      currentLists: 0, answered: new Set(), due: new Map(), laidOut: false };
    // This route's first layout is done (guardLayout): no prior holds it any more, so no deadline remains.
    current.layout = () => { current.laidOut = true; for (const deadline of current.priors) clearTimeout(deadline.timer); current.priors.clear(); };
    const live = () => ticket === current && location.search === search;
    const succeed = key => { if (live() && current.failures.delete(key)) render(current); };
    const fail = (key, position, study, error, retried, late, list) => {
      // The document keeps this rejection whether or not the route is still here (see failedInViewer, viewer-launch.js).
      failedStudies.add(study);
      if (!live()) return;
      const fresh = !current.failures.has(key);
      // The current exam's image list refused: the study cannot be shown to this account (KinSessionTransport.openFailure).
      let screen = false;
      if (list && currentOf(search, studies).includes(study) && window.KinSessionTransport.openFailure(error) === 'denied')
        try { screen = window.KinViewerPatientTabs?.imagesRefused?.() === true; } catch (_) {}
      current.failures.set(key, { position, status: error?.status, error, late: !!late, list, screen,
        retried: retried || !!current.failures.get(key)?.retried });
      render(current);
      // The route boundary also listens to unhandled rejections. Its generic toast must not replace the reason
      // this request already has (including the exhausted single retry), even if an upstream caller drops its catch.
      window.dispatchEvent(new CustomEvent('kin-series-metadata-failed', { detail: { error, message: describe(current.failures.get(key)) } }));
      if (!fresh) return;
      try { services?.uiNotificationService?.show?.({ title: 'Image Loading', message: describe(current.failures.get(key)), type: 'error' }); } catch (_) {}
    };
    // Every current study's image list is answered (in this route, or by this document's cache - no request comes then) and none
    // is in flight: every waiting prior's deadline runs.
    const armPriors = () => {
      if (current.laidOut || current.currentLists || !live()) return;
      if (!currentOf(search, studies).every(uid => current.answered.has(uid) || listedStudies.has(uid))) return;
      for (const deadline of current.priors) deadline.arm();
    };
    // One request of the URL's studies, list (series === null) or one series: the single retry, the prior deadline, the
    // failure record. Anything else (another study, a synchronous throw, a non-promise) is the original's own result.
    function guarded(original, self, options, study, series) {
      const first = original.call(self, options);
      const position = studies.indexOf(study) + 1, list = series === null;
      if (!live() || !position || (!list && (typeof series !== 'string' || !series)) || typeof first?.then !== 'function') {
        // Not this route's to retry or explain (another study read directly, a route already left), but OHIF keeps its
        // rejection all the same: the document's record must know.
        if (typeof study === 'string' && study && typeof first?.then === 'function') first.then(undefined, () => { failedStudies.add(study); });
        return first;
      }
      const key = JSON.stringify([study, series]), prior = !currentOf(search, studies).includes(study);
      return new Promise((resolve, reject) => {
        let done = false;
        // One deadline per prior study for this route, shared by its list and series requests.
        const deadline = { timer: null, arm() {
          if (done || deadline.timer || current.laidOut) return;
          if (!current.due.has(study)) current.due.set(study, Date.now() + priorGrace);
          deadline.timer = setTimeout(() => {
            if (!live() || current.laidOut) return;
            finish(false, Object.assign(new Error('Prior study image metadata did not arrive in time.'), { kinLate: true }), false, true);
          }, Math.max(0, current.due.get(study) - Date.now()));
        } };
        function finish(ok, value, retried, late) {
          if (done) return;
          done = true; clearTimeout(deadline.timer); current.priors.delete(deadline);
          if (ok) { resolve(value); succeed(key); } else { reject(value); fail(key, position, study, value, retried, late, list); }
          if (list && ok) listedStudies.add(study);
          if (list && !prior) { current.currentLists--; current.answered.add(study); armPriors(); }
        }
        if (list && !prior) current.currentLists++;
        if (prior && !current.laidOut) { current.priors.add(deadline); armPriors(); }
        first.then(value => finish(true, value), error => {
          if (done) return;
          // 예산은 첫 거절 때 잡는다. 같은 키의 반복·동시 요청은 예산을 새로 만들지 못한다.
          if (!live() || !retryable(error) || current.used.has(key)) { finish(false, error, false); return; }
          current.used.add(key);
          const wait = { cancel: () => { if (!done) { done = true; failedStudies.add(study); reject(error); } } };
          wait.timer = setTimeout(() => {
            current.waits.delete(wait);
            if (done) return;
            if (!live()) { wait.cancel(); return; }
            current.retries++;
            let again;
            try { again = original.call(self, options); } catch (thrown) { finish(false, thrown, true); return; }
            Promise.resolve(again).then(value => finish(true, value), final => finish(false, final, true));
          }, retryDelay);
          current.waits.add(wait);
        });
      });
    }
    const listOriginal = client.searchForSeries, seriesOriginal = client.retrieveSeriesMetadata;
    current.wrappers.searchForSeries = function searchForSeries(options) {
      return guarded(listOriginal, this, options, options?.studyInstanceUID, null);
    };
    current.wrappers.retrieveSeriesMetadata = function retrieveSeriesMetadata(options) {
      return guarded(seriesOriginal, this, options, options?.studyInstanceUID, options?.seriesInstanceUID);
    };
    for (const [key, value] of Object.entries(current.wrappers))
      try { Object.defineProperty(client, key, { configurable: true, writable: true, enumerable: false, value }); } catch (_) {}
    if (Object.entries(current.wrappers).some(([key, value]) => !own(client, key) || client[key] !== value)) {
      for (const [key, value] of Object.entries(current.wrappers)) if (own(client, key) && client[key] === value) delete client[key];
      return refuse();
    }
    ticket = current; phase = 'installed';
  }
  // Document lifetime, under every per-route run wrapper: a study missing from OHIF's study list (its image list failed)
  // is left out of the layout; without every current study of the present URL nothing is laid out (also a left route's late
  // layout, which names another patient's studies).
  function guardLayout(hp) {
    if (!hp || typeof hp.run !== 'function' || hp.run.kinStudiesGuard) return;
    const run = hp.run;
    const guardedRun = function (data, ...rest) {
      const studies = data?.studies, currents = currentOf(location.search, studiesOf(location.search));
      if (!Array.isArray(studies) || !currents.length) return run.call(this, data, ...rest);
      const present = studies.filter(Boolean);
      // Every current study must be there: a current exam is never laid out in part, nor a prior in its place.
      if (!currents.every(uid => present.some(study => study?.StudyInstanceUID === uid))) return undefined;
      if (ticket && ticket.search === location.search) ticket.layout();
      if (present.length === studies.length) return run.call(this, data, ...rest);
      const active = present.includes(data.activeStudy) ? data.activeStudy : present.find(study => currents.includes(study.StudyInstanceUID));
      return run.call(this, { ...data, studies: present, activeStudy: active }, ...rest);
    };
    guardedRun.kinStudiesGuard = true;
    hp.run = guardedRun;
  }
  const state = () => ({ phase, pending: ticket ? ticket.waits.size : 0, retries: ticket ? ticket.retries : 0, errors: ticket ? ticket.failures.size : 0 });
  return {
    id: 'kin.series-metadata-recovery',
    preRegistration({ servicesManager, extensionManager }) {
      services = servicesManager?.services || null; extensions = extensionManager || null;
      window.kinSeriesMetadataRecoveryState = state;
      window.kinViewerFailedStudies = () => [...failedStudies];
      try { guardLayout(services?.hangingProtocolService); } catch (_) {}
    },
    onModeEnter() { release(); install(); },
    onModeExit() { release(); },
  };
}
