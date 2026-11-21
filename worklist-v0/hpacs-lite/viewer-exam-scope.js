/* A viewer scope is admitted by the server before any source metadata reaches OHIF.
 * Original UIDs stay on images; the compact reference identifies the reporting exam. */
// The viewer write path (viewer-language.js): product words in the reader's screen language, or as written.
function kinText(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.text ? l.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinHtml(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.html ? l.html(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinError(t, ...p) { return Object.assign(new Error(kinText(t, ...p)), { kinWords: true }); }
(function(root) {
  'use strict';
  const model = root.KinExamScope;
  const route = href => {
    const url = new URL(href, root.location.origin);
    if (url.origin !== root.location.origin || url.pathname !== '/ohif/viewer') throw kinError("영상 주소를 확인하세요.");
    const value = url.searchParams.get('kinExamScopes');
    if (!value) return null;
    let ref; try { ref = JSON.parse(value); } catch (_) { throw kinError("검사 범위 참조를 확인하세요."); }
    if (!ref?.current || !Object.hasOwn(ref, 'prior')) throw kinError("검사 범위 참조를 확인하세요.");
    return {url, ref, key:url.pathname+url.search};
  };
  let admitted = null, pending = null, epoch = 0, stopped = false, timer, channel, notice;
  const copy = value => value ? JSON.parse(JSON.stringify(value)) : null;
  const active = () => {
    try { return route(root.location.href); }
    catch (error) { return {key:root.location.pathname+root.location.search,error}; }
  };
  // The admitted scope of the route shown now; null on a route without scopes (an ordinary tab after a scoped one).
  function snapshot() { const entry=active(); return admitted&&entry&&admitted.key===entry.key ? copy(admitted.input) : null; }
  function allows(input, study, series) {
    return [input?.current,input?.prior].filter(Boolean).some(scope =>
      scope.sources.some(source => source.studyUid === study && (!series || model.allows(source,series))));
  }
  async function resolve(href, {signal} = {}) {
    const entry = route(href);
    if (!entry) return null;
    const read = async (reference, version) => {
      if (!reference) return null;
      const query = new URLSearchParams({purpose:version != null || entry.ref.purpose === 'stored' ? 'stored' : 'current',
        reference:JSON.stringify(reference)});
      if (version != null) query.set('version',String(version));
      const response = await root.fetch('/api/studies/'+encodeURIComponent(reference.reportUid)+'/exam-scope?'+query,
        {credentials:'same-origin',signal});
      if (!response.ok) throw kinError("검사 범위나 원본 접근이 바뀌었습니다. 목록에서 검사를 다시 여세요.");
      return model.read(await response.json());
    };
    const current = await read(entry.ref.current,entry.ref.version), prior = await read(entry.ref.prior,entry.ref.priorVersion);
    const input = model.viewerInput(current,prior,entry.ref.version,entry.ref.priorVersion);
    input.scoped = true;
    if (entry.ref.purpose) input.purpose = entry.ref.purpose;
    // A copied or edited address cannot add an original or start at an excluded series.
    const requested = (entry.url.searchParams.get('StudyInstanceUIDs') || '').split(',');
    if (JSON.stringify(requested) !== JSON.stringify(input.studyUids)) throw kinError("영상 주소의 원본 목록이 검사 범위와 다릅니다. 목록에서 다시 여세요.");
    const series = entry.url.searchParams.get('initialSeriesInstanceUID');
    if (series && !input.studyUids.some(uid=>allows(input,uid,series))) throw kinError("이 검사에 속하지 않는 시리즈입니다.");
    return input;
  }
  function block(error) {
    admitted = null;
    root.document?.documentElement?.classList.add('kin-exam-unverified');
    if (!root.document || notice) return;
    const style = root.document.createElement('style');
    style.textContent='.kin-exam-unverified canvas{visibility:hidden!important}';
    root.document.head.append(style);
    notice = root.document.createElement('p'); notice.setAttribute('role','alert');
    notice.textContent=error.message; root.document.body.prepend(notice);
    root.dispatchEvent(new root.Event('kin-exam-scope-invalidated'));
  }
  async function ensure(force = false) {
    const entry = active();
    if (!entry) return null;
    if (entry.error) { block(entry.error); throw entry.error; }
    if (stopped) throw kinError("영상 작업이 종료되었습니다.");
    if (!force && admitted?.key === entry.key) return admitted.input;
    if (pending?.key === entry.key) return pending.promise;
    const ticket = epoch, key = entry.key;
    const promise = resolve(root.location.href).then(input => {
      if (stopped || ticket !== epoch || key !== active()?.key) throw kinError("영상 범위 확인 중 화면이 바뀌었습니다.");
      admitted={key,input}; notice?.remove(); notice=null;
      root.document?.documentElement?.classList.remove('kin-exam-unverified');
      return input;
    }).catch(error=>{ if(ticket===epoch && key===active()?.key) block(error); throw error; })
      .finally(()=>{if(pending?.promise===promise)pending=null;});
    pending={key,promise}; return promise;
  }
  function activate(href,input) {
    epoch++; pending=null;
    const entry=route(href); admitted=entry&&input?{key:entry.key,input:copy(input)}:null;
    notice?.remove();notice=null;root.document?.documentElement?.classList.remove('kin-exam-unverified');
  }
  function invalidate() {
    if (!active()) return;
    epoch++;pending=null;admitted=null;
    block(kinError("검사 묶음이 바뀌었습니다. 쓰던 내용은 유지됩니다. 목록에서 영상을 다시 여세요."));
  }
  // Compare › Related Studies › Series lists the series of a related exam before it is opened. That one read names
  // itself with this header and is exactly a GET of one study's series list (QIDO-RS series level) — never metadata or
  // images — so nothing outside the scope reaches the image sets. It is answered as the archive lists it, in the scope
  // or not: the caller keeps the series of the exam it asked for (KinExamScope.dicom with that exam's scope), which may
  // differ from this window's scope on the same original (a split exam). The server still checks the reader's access.
  const SERIES_LIST = 'X-KIN-Series-List';
  const SERIES_LIST_PATH = /^(?:\/api(?:\/(?:image-relay|images))?)?\/dicom-web\/studies\/[^/]+\/series$/;
  function listOnly(url, init, target) {
    const request = typeof root.Request === 'function' && url instanceof root.Request ? url : null;
    const method = String(init?.method || request?.method || 'GET').toUpperCase();
    const headers = new root.Headers(init?.headers || request?.headers || {});
    return method === 'GET' && SERIES_LIST_PATH.test(target.pathname) && headers.get(SERIES_LIST) === 'related';
  }
  async function send(native,url,init={}) {
    const target=new URL(typeof url==='string'||url instanceof URL?url:url.url,root.location.href);
    const match=target.origin===root.location.origin && /^(?:\/api(?:\/(?:image-relay|images))?)?\/dicom-web\/studies\/([^/]+)(?:\/series\/([^/]+))?/.exec(target.pathname);
    if (!match || !active()) return native(url,init);
    const key=active().key,ticket=epoch,input=await ensure(),list=listOnly(url,init,target);
    if(!list&&!allows(input,decodeURIComponent(match[1]),match[2]&&decodeURIComponent(match[2])))
      throw kinError("이 검사 범위에 없는 영상입니다.");
    const response=await native(url,init);
    if(ticket!==epoch||key!==active()?.key) { response.body?.cancel().catch(()=>{}); throw kinError("영상 범위가 바뀌었습니다."); }
    if(list||!response.ok||!/(?:\/metadata|\/series|\/instances)$/.test(target.pathname))return response;
    const rows=await response.json();
    if(ticket!==epoch||key!==active()?.key)throw kinError("영상 범위가 바뀌었습니다.");
    if(!Array.isArray(rows))throw kinError("원본 영상 목록을 확인할 수 없습니다.");
    const filtered=rows.filter(row=>allows(input,row['0020000D']?.Value?.[0]||decodeURIComponent(match[1]),row['0020000E']?.Value?.[0]));
    const headers=new root.Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding');
    return new root.Response(JSON.stringify(filtered),{status:response.status,statusText:response.statusText,headers});
  }
  function watch() {
    if(timer)return;
    timer=root.setInterval(()=>{if(active())ensure(true).catch(()=>{});},5000);
    channel=model.changes(()=>root.kinViewerWindowOwner?.(),uids=>{
      const input=snapshot();if(input && uids.some(uid=>input.studyUids.includes(uid)||[input.reportUid,input.prior?.reportUid].includes(uid)))invalidate();
    });
    root.addEventListener('pagehide',()=>{stopped=true;epoch++;admitted=null;root.clearInterval(timer);channel?.close();},{once:true});
  }
  const installed=new WeakSet();
  function comparisonProtocol(input,displaySets) {
    // Each side opens on its first image series in the Studies panel order (root.kinSeriesOrder, the viewer's app config),
    // whatever order the display sets arrived in: a series without a number (an attached document) is not first. A series
    // asked for in the address (a Related Studies › Series row) is its role's image instead when that role holds it.
    const selectors={},roles=[input.current,input.prior],ordered=[...displaySets].sort((a,b)=>root.kinSeriesOrder(a,b));
    let wanted=null;try{wanted=new URL(root.location.href).searchParams.get('initialSeriesInstanceUID');}catch(_){}
    roles.forEach((scope,i)=>{
      const image=set=>!['SR','SEG','PR','KO','DOC','RTSTRUCT'].includes(set.Modality)&&
        scope.sources.some(source=>source.studyUid===set.StudyInstanceUID&&model.allows(source,set.SeriesInstanceUID));
      const selected=(wanted&&ordered.find(set=>set.SeriesInstanceUID===wanted&&image(set)))||ordered.find(image);
      selectors['exam-'+i]={seriesMatchingRules:[{attribute:'displaySetInstanceUID',required:true,
        constraint:{equals:{value:selected?.displaySetInstanceUID||''}}}]};
    });
    return {id:'kin.exam-compare',name:'Current vs Prior',locked:true,numberOfPriorsReferenced:1,protocolMatchingRules:[],
      displaySetSelectors:selectors,stages:[{id:'comparison',name:'Current vs Prior',stageActivation:{enabled:{minViewportsMatched:0}},
        viewportStructure:{layoutType:'grid',properties:{rows:1,columns:2}},viewports:roles.map((_,i)=>({
          viewportOptions:{toolGroupId:'default',viewportType:'stack',allowUnmatchedView:true},displaySets:[{id:'exam-'+i}]}))}]};
  }
  // The image sets the viewer makes (OHIF 3.9.1 DisplaySetService.makeDisplaySets, the one entry every series, late
  // arrival and stored SR passes) hold only the originals and series of this window's scopes; each image keeps its own
  // Study / Series / SOP UIDs.
  function install(services) {
    const sets=services?.displaySetService;
    if(!sets||installed.has(sets))return;
    const make=sets.makeDisplaySets;
    if(typeof make!=='function')throw kinError("영상 범위 공급을 연결하지 못했습니다.");
    sets.makeDisplaySets=function(instances,...args) {
      // What this window's reader just saved (madeInClient) is held to the scope too, as it is when the window opens again.
      if(!active()||!Array.isArray(instances))return make.apply(this,[instances,...args]);
      const input=snapshot();
      if(!input)throw kinError("검사 범위를 확인한 뒤 영상을 표시할 수 있습니다.");
      const keep=list=>list.filter(instance=>allows(input,instance?.StudyInstanceUID,instance?.SeriesInstanceUID));
      // {batch:true}: one list of instances per series; each list keeps only the scope's images, an emptied list goes.
      const selected=args[0]?.batch===true?instances.map(list=>Array.isArray(list)?keep(list):[]).filter(list=>list.length):keep(instances);
      return selected.length?make.apply(this,[selected,...args]):[];
    };
    const hp=services.hangingProtocolService,run=hp?.run;
    if(typeof run==='function')hp.run=function(data,requested,options){
      const input=snapshot();
      if(!input?.prior||requested&&requested!=='@ohif/hpCompare')return run.call(this,data,requested,options);
      const protocol=comparisonProtocol(input,data.displaySets||[]);
      hp.addProtocol(protocol.id,protocol);
      return run.call(this,data,protocol.id,options);
    };
    installed.add(sets);
  }
  // This window's exam an image belongs to ('current' / 'prior'), or null when the window has no admitted scope: every
  // original of a merged exam is the current exam (KinExamScope.examRole). `sources` lists that exam's originals.
  const role=(study,series=null)=>model.examRole(snapshot(),study,series);
  const sources=(study,series=null)=>model.examSources(snapshot(),study,series);
  root.KinViewerExamScope={resolve,ensure,activate,snapshot,allows,role,sources,send,watch,invalidate,install,comparisonProtocol};
})(globalThis);
