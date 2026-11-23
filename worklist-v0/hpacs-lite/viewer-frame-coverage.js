/* Display evidence stays in this viewer document; it is never a reading status. */
// The viewer write path (viewer-language.js): product words in the reader's screen language, or as written.
function kinText(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.text ? l.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinHtml(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.html ? l.html(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinError(t, ...p) { return Object.assign(new Error(kinText(t, ...p)), { kinWords: true }); }
(function(root){
  'use strict';
  const uid=v=>typeof v==='string'&&v.length<=64&&/^\d+(?:\.\d+)+$/.test(v);
  const value=(row,tag)=>row?.[tag]?.Value?.[0];
  const nonImage=new Set(['1.2.840.10008.5.1.4.1.1.104.1','1.2.840.10008.5.1.4.1.1.88.11','1.2.840.10008.5.1.4.1.1.88.22','1.2.840.10008.5.1.4.1.1.88.33']);
  function catalog(studies,responses){
    if(!Array.isArray(studies)||studies.length<1||studies.length>20||!studies.every(uid)||new Set(studies).size!==studies.length||!Array.isArray(responses)||responses.length!==studies.length)throw kinError("검사 범위를 확인하지 못했습니다.");
    const records=new Map();let total=0,documents=0,instances=0;
    responses.forEach((rows,index)=>{
      if(!Array.isArray(rows)||!rows.length)throw kinError("원본 목록이 비어 있습니다.");
      for(const row of rows){
        if(++instances>20000)throw kinError("원본 목록 확인 한도를 넘었습니다.");
        const study=value(row,'0020000D'),series=value(row,'0020000E'),sop=value(row,'00080018'),klass=value(row,'00080016');
        if(study!==studies[index]||![series,sop,klass].every(uid))throw kinError("원본 식별이 일치하지 않습니다.");
        const key=JSON.stringify([study,series,sop]);
        if(records.has(key))throw kinError("중복 원본이 있어 목록을 확인하지 못했습니다.");
        if(nonImage.has(klass)){documents++;records.set(key,0);continue;}
        const rowsCount=Number(value(row,'00280010')),colsCount=Number(value(row,'00280011'));
        const rawFrames=value(row,'00280008'),frames=rawFrames===undefined?1:Number(rawFrames);
        if(!Number.isSafeInteger(rowsCount)||rowsCount<1||!Number.isSafeInteger(colsCount)||colsCount<1||!Number.isSafeInteger(frames)||frames<1)throw kinError("프레임 수를 확인할 수 없는 객체가 있습니다.");
        total+=frames;if(total>100000)throw kinError("프레임 확인 한도를 넘었습니다.");
        records.set(key,frames);
      }
    });
    return {records,total,documents};
  }
  function tracker(data){
    const seen=new Set();
    return {mark(ref){
      if(!ref||!Number.isSafeInteger(ref.frame)||ref.frame<1)return false;
      const key=JSON.stringify([ref.study,ref.series,ref.sop]),count=data.records.get(key);
      if(!count||ref.frame>count)return false;
      const id=key+':'+ref.frame,before=seen.size;seen.add(id);return seen.size!==before;
    },snapshot(){return {total:data.total,shown:seen.size,remaining:data.total-seen.size,documents:data.documents};}};
  }
  function reference(image,metadata){
    if(typeof image!=='string'||!metadata)return null;
    const match=image.match(/\/studies\/([\d.]+)\/series\/([\d.]+)\/instances\/([\d.]+)\/frames\/([1-9]\d*)(?:$|[?#])/);
    if(!match||match[1]!==metadata.StudyInstanceUID||match[2]!==metadata.SeriesInstanceUID||match[3]!==metadata.SOPInstanceUID)return null;
    return {study:match[1],series:match[2],sop:match[3],frame:Number(match[4])};
  }
  function mount(services){
    const search=root.location.search,raw=new URLSearchParams(search).getAll('StudyInstanceUIDs');
    const studies=raw.length===1?raw[0].split(','):[];
    let ended=false,owner=null,enabled=false,preferenceKnown=false,tracking=null,phase='loading',message='',preferenceMessage='',epoch=0,channel,host,timer,permit=null;
    const requests=new Set(),core=root.cornerstone;
    const panel=document.createElement('section');panel.id='kin-frame-coverage';
    panel.innerHTML=kinHtml("<h3>Frame Coverage</h3><label><input id=\"kin-frame-warning\" type=\"checkbox\" disabled> Warn Before Leaving</label><p>이 계정의 현재 브라우저 설정입니다. 원본 stack 프레임의 화면 표시 기록이며, 임상적 열람·판독 완료를 뜻하지 않습니다. MPR/VR·썸네일은 세지 않습니다.</p><p id=\"kin-frame-status\" role=\"status\"></p><button type=\"button\" id=\"kin-frame-reload\" disabled>Recheck Original List</button><p>목록은 확인 시점의 스냅샷입니다. 다시 확인하면 표시 기록을 초기화합니다. 표시 기록은 창을 닫으면 사라집니다.</p>");
    const toggle=panel.querySelector('input'),status=panel.querySelector('[role=status]'),reload=panel.querySelector('button');
    const feedback=document.createElement('p');feedback.id='kin-frame-preference-status';panel.append(feedback);
    const live=()=>!ended&&root.location.search===search;
    const ownerKey=()=>owner&&'kin-frame-warning:v1:'+JSON.stringify(owner);
    const snapshot=()=>({enabled:enabled&&live(),phase:live()?phase:'ended',warn:live()&&(!preferenceKnown||enabled&&(phase!=='ready'||tracking.snapshot().remaining>0)),...(tracking?.snapshot()||{})});
    function render(){
      toggle.disabled=!owner||!live();toggle.checked=enabled;reload.disabled=!live()||phase==='loading'||preferenceKnown&&!enabled;
      const s=snapshot();status.textContent=!live()?kinText("세션이 종료되었습니다."):preferenceKnown&&!enabled?'Off':phase==='ready'?'Displayed '+s.shown+' / '+s.total+' · Not Displayed '+s.remaining+' · Documents '+s.documents:phase==='loading'?'Checking Original List': 'Unverified · '+message;
      feedback.textContent=preferenceMessage;
    }
    // The viewer grid turns pointer events off on every pane but the active one, so a hit test at such a cell answers the
    // pane's own parent. Only that exact parent means nothing is on top; a tile or tool layer keeps its own pointer events.
    const restingPane=(e,hit,w)=>{const pane=e.closest('[data-cy="viewport-pane"]');return !!pane&&w.getComputedStyle(pane).pointerEvents==='none'&&hit===pane.parentElement;};
    function visible(element){
      try{
        if(document.hidden||!element?.isConnected)return false;
        // One point decides: the centre of the image cell, followed up through any embedding frame.
        const cell=element.getBoundingClientRect();if(cell.width<=0||cell.height<=0)return false;
        let w=root,e=element,x=cell.left+cell.width/2,y=cell.top+cell.height/2;
        while(e){
          if(e.closest('[hidden],[inert]')||!e.getClientRects().length)return false;
          const modal=[...w.document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"],.modal.show')].some(m=>{
            const r=m.getBoundingClientRect(),s=w.getComputedStyle(m);
            return !m.closest('[hidden]')&&m.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})!==false&&s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<w.innerWidth&&r.top<w.innerHeight;
          });
          if(modal)return false;
          for(let a=e;a;a=a.parentElement){const s=w.getComputedStyle(a);if(s.visibility==='hidden'||s.visibility==='collapse'||s.display==='none'||Number(s.opacity)===0)return false;}
          const hit=w.document.elementFromPoint(x,y);
          if(!hit||!e.contains(hit)&&!(e===element&&restingPane(e,hit,w)))return false;
          if(w===w.top)break;
          const frame=w.frameElement,box=frame.getBoundingClientRect();x+=box.left+frame.clientLeft;y+=box.top+frame.clientTop;
          e=frame;w=w.parent;if(w.document.hidden)return false;
        }
        return true;
      }catch(_){return false;}
    }
    function onImage(event){
      if(!live()||!enabled||phase!=='ready')return;
      try{
        const element=event.detail?.element,v=core.getEnabledElement(element)?.viewport;
        if(!v||v.type!=='stack'||v.id!==event.detail.viewportId||!visible(element)||v.viewportStatus!=='rendered')return;
        const image=v.getCurrentImageId();
        // The pinned renderer advances its current index before loading pixels.
        // A redraw of the previous actor must not credit the requested image.
        if(v.csImage?.imageId!==image||v.stackInvalidated)return;
        const ref=reference(image,core.metaData.get('instance',image));
        const engine=v.getRenderingEngine?.();
        if(engine?.offscreenMultiRenderWindow?.getOpenGLRenderWindow?.()?.getContext?.()?.isContextLost()||
          root.kinViewerContextLoss?.usable(engine)===false)return;
        if(tracking.mark(ref))render();
      }catch(_){}
    }
    async function json(path,ticket,budget){
      const controller=new AbortController();requests.add(controller);const timeout=setTimeout(()=>controller.abort(),20000);
      try{
        const r=await fetch(path,{credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{Accept:'application/dicom+json, application/json',...(owner?{'X-KIN-Subject':owner[1],'X-KIN-Institution':owner[0]}:{})}});
        if(window.KinSessionTransport.refusal(r))throw window.KinSessionTransport.responseError(r);
        if(!r.ok||!r.body)throw kinError("원본 목록을 불러오지 못했습니다.");
        const reader=r.body.getReader(),chunks=[];let bytes=0;
        while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>budget){await reader.cancel();throw kinError("원본 목록 확인 한도를 넘었습니다.");}chunks.push(value);}
        if(!live()||ticket!==epoch)throw kinError("목록 확인이 취소되었습니다.");
        const joined=new Uint8Array(bytes);let offset=0;for(const c of chunks){joined.set(c,offset);offset+=c.length;}return JSON.parse(new TextDecoder().decode(joined));
      }finally{clearTimeout(timeout);requests.delete(controller);}
    }
    async function load(){
      for(const c of requests)c.abort();const ticket=++epoch;tracking=null;phase='loading';message='';render();
      try{
        const me=await json('/api/me',ticket,65536),next=[me.institution,me.sub];
        if(me.kind!=='member'||next.some(v=>typeof v!=='string'||!v)||owner&&JSON.stringify(next)!==JSON.stringify(owner)){end();return;}
        owner=next;
        if(!preferenceKnown){
          try{const saved=localStorage.getItem(ownerKey());enabled=saved==='true';if(saved!==null&&!['true','false'].includes(saved))preferenceMessage=kinText("저장 설정 오류 · 기본 Off");}
          catch(_){preferenceMessage=kinText("저장소 사용 불가 · 이 창에서만 설정합니다.");}
          preferenceKnown=true;
        }
        if(!enabled){phase='disabled';render();return;}
        if(!studies.length||studies.length>(root.KinViewerExamScope?.snapshot()?20:2)||!studies.every(uid)||new Set(studies).size!==studies.length)throw kinError("검사 범위를 확인하지 못했습니다.");
        const lists=[];for(const study of studies)lists.push(await json('/dicom-web/studies/'+encodeURIComponent(study)+'/metadata',ticket,8*1024*1024));
        if(!live()||ticket!==epoch)return;
        tracking=tracker(catalog(studies,lists));phase='ready';render();
        // Ask the real renderer to show current pixels again; cached/downloaded
        // images are never marked directly by this observer.
        for(const e of core.getEnabledElements())e.viewport.render();
      }catch(e){if(live()&&ticket===epoch){phase='unverified';message=e.name==='AbortError'?kinText("목록 확인 시간이 초과되었습니다. 다시 시도하세요."):e instanceof SyntaxError?kinText("원본 목록 형식을 확인하지 못했습니다."):e.message;render();}}
    }
    const confirmLeave=confirmFn=>{
      const before=snapshot();if(!before.warn)return true;
      const prompt=before.phase==='ready'?kinText("화면에 표시되지 않은 원본 프레임이 {n0}개 있습니다.", before.remaining):kinText("원본 프레임 전체의 표시 여부를 확인하지 못했습니다.");
      const ticket=epoch;
      const accepted=(confirmFn||root.confirm)(kinText("{0}\n검사 {1}\n임상적 판독 완료 여부는 별도로 확인하세요. 이 영상을 떠날까요?", prompt, studies.join(' / ')))===true&&live()&&ticket===epoch;
      if(accepted)permit={epoch,until:Date.now()+1000};return accepted;
    };
    const beforeUnload=e=>{
      const accepted=permit&&permit.epoch===epoch&&Date.now()<=permit.until;permit=null;
      if(snapshot().warn&&!accepted){e.preventDefault();e.returnValue='';}
    };
    function end(){if(ended)return;ended=true;epoch++;clearInterval(timer);for(const c of requests)c.abort();tracking=null;owner=null;permit=null;render();}
    toggle.onchange=()=>{enabled=toggle.checked;try{localStorage.setItem(ownerKey(),String(enabled));preferenceMessage=kinText("설정 저장됨 · 다음에 여는 영상 창에도 적용");}catch(_){preferenceMessage=kinText("설정을 저장하지 못해 이 창에서만 적용됩니다.");}if(enabled)load();else{epoch++;for(const c of requests)c.abort();tracking=null;phase='disabled';render();}};
    reload.onclick=()=>load();

    root.addEventListener('beforeunload',beforeUnload);
    document.addEventListener(core.Enums.Events.IMAGE_RENDERED,onImage,true);
    try{channel = window.kinViewerOnEnd(() => end());}catch(_){}
    root.kinViewerFrameCoverageState=snapshot;root.kinViewerFrameCoverageConfirm=confirmLeave;
    timer=setInterval(()=>{if(!live()){end();return;}if(!panel.isConnected){host=document.querySelector('#kin-viewer-layout');host?.append(panel);}},250);
    load();
    return {stop(){end();clearInterval(timer);channel?.close();root.removeEventListener('beforeunload',beforeUnload);document.removeEventListener(core.Enums.Events.IMAGE_RENDERED,onImage,true);panel.remove();}};
  }
  const api={catalog,tracker,reference,mount};if(typeof module==='object'&&module.exports)module.exports=api;else root.KinFrameCoverage=api;
})(globalThis);
