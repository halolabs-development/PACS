/* A viewer scope is admitted by the server before any source metadata reaches OHIF.
 * Original UIDs stay on images; the compact reference identifies the reporting exam. */
(function(root) {
  'use strict';
  const model = root.KinExamScope;
  const route = href => {
    const url = new URL(href, root.location.origin);
    if (url.origin !== root.location.origin || url.pathname !== '/ohif/viewer') throw Error('영상 주소를 확인하세요.');
    const value = url.searchParams.get('kinExamScopes');
    if (!value) return null;
    let ref; try { ref = JSON.parse(value); } catch (_) { throw Error('검사 범위 참조를 확인하세요.'); }
    if (!ref?.current || !Object.hasOwn(ref, 'prior')) throw Error('검사 범위 참조를 확인하세요.');
    return {url, ref, key:url.pathname+url.search};
  };
  let admitted = null, pending = null, epoch = 0, stopped = false, timer, channel, notice;
  const copy = value => value ? JSON.parse(JSON.stringify(value)) : null;
  const active = () => {
    try { return route(root.location.href); }
    catch (error) { return {key:root.location.pathname+root.location.search,error}; }
  };
  function snapshot() { return admitted?.key === active()?.key ? copy(admitted.input) : null; }
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
      if (!response.ok) throw Error('검사 범위나 원본 접근이 바뀌었습니다. 목록에서 검사를 다시 여세요.');
      return model.read(await response.json());
    };
    const current = await read(entry.ref.current,entry.ref.version), prior = await read(entry.ref.prior,entry.ref.priorVersion);
    const input = model.viewerInput(current,prior,entry.ref.version,entry.ref.priorVersion);
    input.scoped = true;
    if (entry.ref.purpose) input.purpose = entry.ref.purpose;
    // A copied or edited address cannot add an original or start at an excluded series.
    const requested = (entry.url.searchParams.get('StudyInstanceUIDs') || '').split(',');
    if (JSON.stringify(requested) !== JSON.stringify(input.studyUids)) throw Error('영상 주소의 원본 목록이 검사 범위와 다릅니다. 목록에서 다시 여세요.');
    const series = entry.url.searchParams.get('initialSeriesInstanceUID');
    if (series && !input.studyUids.some(uid=>allows(input,uid,series))) throw Error('이 검사에 속하지 않는 시리즈입니다.');
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
    if (stopped) throw Error('영상 작업이 종료되었습니다.');
    if (!force && admitted?.key === entry.key) return admitted.input;
    if (pending?.key === entry.key) return pending.promise;
    const ticket = epoch, key = entry.key;
    const promise = resolve(root.location.href).then(input => {
      if (stopped || ticket !== epoch || key !== active()?.key) throw Error('영상 범위 확인 중 화면이 바뀌었습니다.');
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
    block(Error('검사 묶음이 바뀌었습니다. 쓰던 내용은 유지됩니다. 목록에서 영상을 다시 여세요.'));
  }
  async function send(native,url,init={}) {
    const target=new URL(typeof url==='string'||url instanceof URL?url:url.url,root.location.href);
    const match=target.origin===root.location.origin && /^(?:\/api(?:\/(?:image-relay|images))?)?\/dicom-web\/studies\/([^/]+)(?:\/series\/([^/]+))?/.exec(target.pathname);
    if (!match || !active()) return native(url,init);
    const key=active().key,ticket=epoch,input=await ensure();
    if(!allows(input,decodeURIComponent(match[1]),match[2]&&decodeURIComponent(match[2])))
      throw Error('이 검사 범위에 없는 영상입니다.');
    const response=await native(url,init);
    if(ticket!==epoch||key!==active()?.key) { response.body?.cancel().catch(()=>{}); throw Error('영상 범위가 바뀌었습니다.'); }
    if(!response.ok||!/(?:\/metadata|\/series|\/instances)$/.test(target.pathname))return response;
    const rows=await response.json();
    if(ticket!==epoch||key!==active()?.key)throw Error('영상 범위가 바뀌었습니다.');
    if(!Array.isArray(rows))throw Error('원본 영상 목록을 확인할 수 없습니다.');
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
    const selectors={},roles=[input.current,input.prior];
    roles.forEach((scope,i)=>{
      const selected=displaySets.find(set=>!['SR','SEG','PR','KO','DOC','RTSTRUCT'].includes(set.Modality)&&
        scope.sources.some(source=>source.studyUid===set.StudyInstanceUID&&model.allows(source,set.SeriesInstanceUID)));
      selectors['exam-'+i]={seriesMatchingRules:[{attribute:'displaySetInstanceUID',required:true,
        constraint:{equals:{value:selected?.displaySetInstanceUID||''}}}]};
    });
    return {id:'kin.exam-compare',name:'Current vs Prior',locked:true,numberOfPriorsReferenced:1,protocolMatchingRules:[],
      displaySetSelectors:selectors,stages:[{id:'comparison',name:'Current vs Prior',stageActivation:{enabled:{minViewportsMatched:0}},
        viewportStructure:{layoutType:'grid',properties:{rows:1,columns:2}},viewports:roles.map((_,i)=>({
          viewportOptions:{toolGroupId:'default',viewportType:'stack',allowUnmatchedView:true},displaySets:[{id:'exam-'+i}]}))}]};
  }
  function install(services) {
    const sets=services?.displaySetService;
    if(!sets||installed.has(sets))return;
    const create=sets.createDisplaySets;
    if(typeof create!=='function')throw Error('영상 범위 공급을 연결하지 못했습니다.');
    sets.createDisplaySets=function(instances,...args) {
      if(!active())return create.call(this,instances,...args);
      const input=snapshot();
      if(!input)throw Error('검사 범위를 확인한 뒤 영상을 표시할 수 있습니다.');
      const selected=instances.filter(instance=>allows(input,instance.StudyInstanceUID,instance.SeriesInstanceUID));
      return selected.length?create.call(this,selected,...args):[];
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
  root.KinViewerExamScope={resolve,ensure,activate,snapshot,allows,send,watch,invalidate,install,comparisonProtocol};
})(globalThis);
