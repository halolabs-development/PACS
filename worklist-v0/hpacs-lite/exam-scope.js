/* Consume the server scope without deriving membership from worklist rows. */
(function(root) {
  'use strict';
  const sourceFields = new Set(['id','name','acc','sourceAcc','date','time','desc','modality','birth','sex','age',
    'institutionName','reqHosp','reqDate','reqDept','reqDoc','ptClass']);
  const copy = value => JSON.parse(JSON.stringify(value));
  function read(value, purpose = 'current') {
    const scope = value?.sources ? value : purpose === 'stored' ? value?.reportScope : value?.examScope;
    if (scope) {
      if (typeof scope.reportUid !== 'string' || !Array.isArray(scope.sources) || !scope.sources.length ||
          scope.sources.some(s => typeof s.studyUid !== 'string' || !['all','include','exclude'].includes(s.series?.mode) || !Array.isArray(s.series.uids)))
        throw new Error('검사 범위를 확인할 수 없습니다. 목록을 새로고침하세요.');
      return copy(scope);
    }
    // Ungrouped list rows omit examScope. They describe only their own source, never an inferred group.
    if (purpose === 'stored' || !value?.uid || value.group || value.origin === 'logical') return null;
    return {reportUid:value.uid,groupId:null,kind:'single',part:null,active:true,
      sources:[{studyUid:value.uid,series:{mode:'all',uids:[]}}],
      generation:JSON.stringify(['single',value.state?.draftEpoch ?? value.draftEpoch ?? null])};
  }
  const key = value => { const s=read(value);return s ? JSON.stringify([s.reportUid,s.groupId??null,s.part??null]) : null; };
  const stamp = value => { const s=read(value);return s ? JSON.stringify([key(s),s.generation??null]) : null; };
  // A draft epoch is not a change of the images in an ordinary study.
  function screenScope(value) {
    const scope=read(value);
    return scope && (scope.groupId || scope.hasMembership || scope.kind==='merge' || scope.kind==='split') ? scope : null;
  }
  const screenStamp = value => { const scope=screenScope(value);return scope ? stamp(scope) : null; };
  function originalLabel(value, original, label, before=false) {
    return screenScope(value) && original ? (before ? original+' · '+label : label+' · '+original) : label;
  }
  function sourceRequest(value, sourceUid, body) {
    return screenScope(value) ? {...body,sourceUid} : body;
  }
  const seriesValue = (value, sourceUid, seriesUid) => screenScope(value) ? JSON.stringify({sourceUid,seriesUid}) : seriesUid;
  const seriesRequest = (value, selected) => screenScope(value) ? JSON.parse(selected) : {seriesUid:selected};
  function attachmentTarget(value) {
    const scope=read(value),plain=!!scope&&!screenScope(scope);
    return {scope,sourceUid:plain?scope.reportUid:null,canAttach:plain};
  }
  function attachmentHeaders(value, sourceUid, generation) {
    return screenScope(value) ? {'X-KIN-Source-Uid':sourceUid,'X-KIN-Exam-Generation':generation} : {};
  }
  function storedReport(value,reportUid) {
    const group=value?.group;
    if(!group?.readable)return null;
    const sources=group.sources || (group.part==null&&group.studies?.map(studyUid=>({studyUid,series:{mode:'all',uids:[]}})));
    return sources?read({reportUid,groupId:group.id,kind:group.part==null?'merge':'split',part:group.part??null,
      generation:group.generation,active:group.active,sources}):null;
  }
  const allows = (source, seriesUid) => source.series.mode === 'all' ||
    (source.series.mode === 'include' ? source.series.uids.includes(seriesUid) : !source.series.uids.includes(seriesUid));
  // The listed exam (a related-study row) an image belongs to: the row whose scope holds that original study (and
  // series). A merged or split exam comes before a plain row of the same original, as the exam a reader opened; a row
  // whose scope cannot be read or opened is matched only by its own UID.
  function listedExam(rows, studyUid, seriesUid) {
    let plain=null;
    for(const row of Array.isArray(rows)?rows:[]) {
      let scope=null;
      if(row&&!row.examUnavailable)try{scope=read(row);}catch(_){scope=null;}
      const holds=scope?scope.sources.some(source=>source.studyUid===studyUid&&(!seriesUid||allows(source,seriesUid))):row?.uid===studyUid;
      if(!holds)continue;
      if(scope?.groupId)return row;
      plain=plain||row;
    }
    return plain;
  }
  function metadata(row) {
    const scope=read(row);
    if (!scope) return [];
    const sent=Array.isArray(row?.sourceMetadata)?row.sourceMetadata:[];
    return scope.sources.map(source=>sent.find(s=>(s.uid??s.studyUid)===source.studyUid) ||
      (source.studyUid===row?.uid&&!scope.groupId?row:{uid:source.studyUid}));
  }
  function projections(row) {
    const rows=metadata(row);
    return (rows.length?rows:[row||{}]).map(source=>({...row,...Object.fromEntries([...sourceFields].filter(k=>Object.hasOwn(source,k)).map(k=>[k,source[k]]))}));
  }
  function values(row, field) {
    return (sourceFields.has(field) ? projections(row) : [row]).map(s=>Object.hasOwn(s||{},field)?s[field]:undefined);
  }
  function originals(rows) {
    if(!Array.isArray(rows))return rows;
    const out=[],grouped=new Set();
    for(const row of rows){
      if(!row?.examScope?.groupId){out.push(row);continue;}
      for(const source of metadata(row))if(!grouped.has(source.uid)){grouped.add(source.uid);out.push(source);}
    }
    return out;
  }
  function viewingSelection(selection, rows) {
    if(!selection || !Array.isArray(selection.studyUids))return null;
    const studyUids=[];
    for(const uid of selection.studyUids) {
      const row=rows.find(row=>row.uid===uid),scope=read(row);
      if(!scope || row.examUnavailable)return null;
      for(const source of scope.sources)if(!studyUids.includes(source.studyUid))studyUids.push(source.studyUid);
    }
    return {...selection,studyUids};
  }
  function originalInput(studyUids) {
    const input=viewerInput({uid:studyUids[0]},studyUids[1]?{uid:studyUids[1]}:null);
    return {...input,purpose:'stored'};
  }
  function readingScope(value, uid) { return screenScope(value || {uid}); }
  const readingStamp = (value, uid) => { const scope=readingScope(value,uid); return scope ? key(scope) : undefined; };
  async function fetchScope(api, uid, {purpose='current',version,reference,signal,at}={}) {
    const query=new URLSearchParams({purpose});if(version!=null)query.set('version',String(version));
    if(reference)query.set('reference',JSON.stringify(reference));
    const answer=await api('GET','/studies/'+encodeURIComponent(uid)+'/exam-scope?'+query,undefined,signal,at);
    const scope=read(answer?.scope||answer);
    if(!scope)throw new Error('검사 범위를 확인할 수 없습니다.');
    return scope;
  }
  async function dicom(scope, resource, request) {
    const out=[];
    for(const source of read(scope).sources) {
      const rows=await request('/dicom-web/studies/'+encodeURIComponent(source.studyUid)+'/'+resource,source);
      if(!Array.isArray(rows))throw new Error('원본 영상 목록을 확인할 수 없습니다.');
      for(const row of rows) if(allows(source,row?.['0020000E']?.Value?.[0])) out.push({sourceUid:source.studyUid,row});
    }
    return out;
  }
  function viewerInput(current, prior = null, version = null, priorVersion = null) {
    if(current?.examUnavailable||prior?.examUnavailable)throw Error('검사 묶음의 모든 원본에 접근할 수 없습니다. 목록을 새로고침하세요.');
    const scope=read(current),comparison=prior?read(prior):null;
    if(!scope || prior&&!comparison)throw new Error('검사 범위를 확인할 수 없습니다.');
    if([...scope.sources,...(comparison?.sources||[])].some(s=>s.studyUid.length>64||!/^\d+(?:\.\d+)+$/.test(s.studyUid)))throw new Error('원본 검사 UID를 확인할 수 없습니다.');
    return {reportUid:scope.reportUid,key:key(scope),generation:scope.generation,current:scope,prior:comparison,version,priorVersion,
      scoped:!!(screenScope(scope)||screenScope(comparison)),
      studyUids:[...new Set([...scope.sources,...(comparison?.sources||[])].map(s=>s.studyUid))]};
  }
  const reference = s => s ? {reportUid:s.reportUid,groupId:s.groupId??null,part:s.part??null} : null;
  function viewerReference(input) {
    return {current:reference(input.current),prior:reference(input.prior),version:input.version??null,priorVersion:input.priorVersion??null,
      ...(input.purpose ? {purpose:input.purpose} : {})};
  }
  function viewerUrl(input, initialSeries = null) {
    // The viewer re-reads these exact scope references. A long Split series list must not overflow the URL.
    return '/ohif/viewer?StudyInstanceUIDs='+input.studyUids.map(encodeURIComponent).join(',')+
      (input.prior?'&hangingProtocolId=@ohif/hpCompare':'')+
      (input.scoped?'&kinReportUid='+encodeURIComponent(input.reportUid)+'&kinExamScopes='+encodeURIComponent(JSON.stringify(viewerReference(input)))+
        (input.current.kind==='merge'?'&kinExam=merged':''):'')+
      (initialSeries?'&initialSeriesInstanceUID='+encodeURIComponent(initialSeries):'');
  }
  function roleRows(input, rows, sets = []) {
    return [input.current,input.prior].filter(Boolean).map(scope=>{
      const row=rows.find(row=>row.uid===scope.reportUid)||rows.find(row=>scope.sources.some(source=>source.studyUid===row.uid || row.examScope?.sources?.some(s=>s.studyUid===source.studyUid)));
      if(!row)throw Error('현재 검사 정보를 확인할 수 없습니다.');
      return {...row,uid:scope.reportUid,examScope:scope,displaySetIds:sets.filter(set=>scope.sources.some(source=>source.studyUid===set.StudyInstanceUID&&allows(source,set.SeriesInstanceUID))).map(set=>set.displaySetInstanceUID)};
    });
  }
  function snapshotReference(input) {
    return {version:1,purpose:input.purpose==='stored'||input.version!=null?'stored':'current',current:reference(input.current),prior:reference(input.prior)};
  }
  function jobSnapshot(value,input,studyUids,originals=false) {
    if (!input?.scoped) return value;
    return {...value,exam:snapshotReference({...input,purpose:originals?'stored':input.purpose||'current'})};
  }
  function snapshotUrl(snapshot) {
    const exam=snapshot.exam;
    if(!exam)return '/ohif/viewer?StudyInstanceUIDs='+snapshot.studies.map(encodeURIComponent).join(',');
    return '/ohif/viewer?StudyInstanceUIDs='+snapshot.studies.map(encodeURIComponent).join(',')+
      '&kinReportUid='+encodeURIComponent(exam.current.reportUid)+'&kinExamScopes='+encodeURIComponent(JSON.stringify({
        current:exam.current,prior:exam.prior,version:null,priorVersion:null,purpose:'stored'}))+(exam.prior?'&hangingProtocolId=@ohif/hpCompare':'');
  }
  function preload(rows) {
    const sources=new Map();
    for(const row of rows) {
      const scope=read(row);
      if(!scope)throw Error('미리 받을 검사 범위를 확인할 수 없습니다.');
      for(const source of scope.sources) {
        const entry=sources.get(source.studyUid)||{uid:source.studyUid,label:row.label??null,urgent:row.urgent===true};
        if(row.examScope)entry.examRefs=[...entry.examRefs||[],reference(scope)].filter((ref,index,list)=>list.findIndex(r=>JSON.stringify(r)===JSON.stringify(ref))===index);
        else entry.whole=true;
        sources.set(source.studyUid,entry);
      }
    }
    return [...sources.values()].map(({whole,...entry})=>{if(whole)delete entry.examRefs;return entry;});
  }
  function changes(owner, receive) {
    if(typeof root.BroadcastChannel!=='function')return {send(){},close(){}};
    const channel=new root.BroadcastChannel('kin-exam-changes');
    channel.onmessage=event=>{
      const message=event.data;
      if(message?.owner && message.owner===owner() && Array.isArray(message.uids) && message.uids.every(u=>typeof u==='string'))receive(message.uids);
    };
    return {send(uids){const identity=owner();if(identity)channel.postMessage({owner:identity,uids:[...new Set(uids)]});},close(){channel.close();}};
  }
  function chooseOriginals(row,scope,{title='Download Originals',multiple=true,live=()=>true}={}) {
    return new Promise(resolve=>{
      const dialog=document.createElement('dialog'),heading=document.createElement('h3'),note=document.createElement('p');
      dialog.className='order-dialog';heading.textContent=title;
      note.textContent=scope.kind==='split'?'나눈 시리즈만이 아니라 원본 검사 전체를 내보냅니다. 원본 UID와 영상은 바뀌지 않습니다.':'내보낼 원본 검사를 고르세요. 원본 UID와 영상은 바뀌지 않습니다.';
      dialog.append(heading,note);const choices=[];
      for(const source of scope.sources){
        const original=metadata(row).find(s=>s.uid===source.studyUid),label=document.createElement('label'),input=document.createElement('input');
        input.type=multiple?'checkbox':'radio';input.name='exam-source';input.value=source.studyUid;input.checked=scope.sources.length===1;
        // Accession No, description and UID of the original are data.
        const words=document.createElement('span');words.translate=false;words.textContent=[original?.acc,original?.desc,source.studyUid].filter(Boolean).join(' · ');
        label.append(input,' ',words);dialog.append(label,document.createElement('br'));choices.push(input);
      }
      const go=document.createElement('button'),close=document.createElement('button');go.type=close.type='button';go.textContent='Continue';close.textContent='Cancel';
      const update=()=>{go.disabled=!choices.some(c=>c.checked);};dialog.onchange=update;update();
      let result=[];go.onclick=()=>{if(live())result=choices.filter(c=>c.checked).map(c=>c.value);dialog.close();};close.onclick=()=>dialog.close();
      dialog.addEventListener('close',()=>{dialog.remove();resolve(result);},{once:true});dialog.append(go,close);document.body.append(dialog);dialog.showModal();
    });
  }
  /**
   * Bring a viewer window this page already holds to the front. Every page that opens a viewer loads this module, so
   * the list and the clinician page share this one rule. Chrome honours popup.focus() only when it comes from the
   * window's opener, and a viewer window is detached from its opener (opener = null) on purpose, so focus() alone leaves
   * the viewer behind the list. Looking the window up again by its own current name raises it without loading anything
   * (an empty address is not a navigation, and a navigation already under way continues) - but only while the click or
   * key press that asked for it is still active; outside one the browser raises nothing and focus() stays the only try.
   * The lookup carries noopener: a plain lookup gives the window this page as its opener again in the browser, and the
   * window's next document would start with it (setting opener = null afterwards does not undo that). With noopener the
   * browser answers null, so the window is looked up by a name only it carries for that one call - another window of
   * the same name (slot names repeat per list) is never raised - and its own name, which may be the session hand-over
   * name of a document still loading, is put back before anything else runs. Answers whether the browser was asked.
   */
  function raiseWindow(popup,from=root){
    try{popup.focus();}catch(_){}
    let name;
    try{if(popup.closed)return false;name=popup.name;}catch(_){return false;}
    if(typeof name!=='string')return false;
    if(from.navigator?.userActivation?.isActive!==true)return false;
    const probe='kin-raise:'+(from.crypto?.randomUUID?.()||String(Math.random()).slice(2));
    try{popup.name=probe;}catch(_){return false;}
    try{from.open('',probe,'noopener');}catch(_){return false;}
    finally{try{popup.name=name;}catch(_){}}
    return true;
  }
  const api={raiseWindow,read,key,stamp,screenScope,screenStamp,originalLabel,sourceRequest,seriesValue,seriesRequest,attachmentTarget,attachmentHeaders,storedReport,allows,listedExam,metadata,projections,values,originals,viewingSelection,originalInput,readingScope,readingStamp,fetch:fetchScope,dicom,viewerInput,viewerUrl,viewerReference,reference,roleRows,snapshotReference,jobSnapshot,snapshotUrl,preload,chooseOriginals,changes};
  root.KinExamScope=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
