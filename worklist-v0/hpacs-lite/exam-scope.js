/* Consume the server scope without deriving membership from worklist rows. */
(function(root) {
  'use strict';
  // Its own words as a string in the screen language when they are made (English only; otherwise as written), and an
  // error with them marked as one of ours (code that keeps "our own message" tells them apart by the mark).
  const kinText = (t, ...p) => root.KinLanguage?.text ? root.KinLanguage.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i]));
  const kinError = (t, ...p) => Object.assign(new Error(kinText(t, ...p)), { kinWords: true });
  const sourceFields = new Set(['id','name','acc','sourceAcc','date','time','desc','modality','birth','sex','age',
    'institutionName','reqHosp','reqDate','reqDept','reqDoc','ptClass','referredAt']);
  const copy = value => JSON.parse(JSON.stringify(value));
  function read(value, purpose = 'current') {
    const scope = value?.sources ? value : purpose === 'stored' ? value?.reportScope : value?.examScope;
    if (scope) {
      if (typeof scope.reportUid !== 'string' || !Array.isArray(scope.sources) || !scope.sources.length ||
          scope.sources.some(s => typeof s.studyUid !== 'string' || !['all','include','exclude'].includes(s.series?.mode) || !Array.isArray(s.series.uids)))
        throw kinError('검사 범위를 확인할 수 없습니다. 목록을 새로고침하세요.');
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
  // The place of an image among the listed exams when a viewer cell is chosen for it: the report UID of the listed split
  // part whose series holds it, otherwise its original study. The two parts of one split original are two places (a
  // series of the other part goes beside a cell, one of its own part into it); each original of a merged exam stays its
  // own place, as before. Without a series, or rows that tell the parts apart, the original study (never guessed).
  function imagePlace(rows, studyUid, seriesUid) {
    const row=seriesUid?listedExam(rows,studyUid,seriesUid):null;
    let scope=null;
    if(row&&!row.examUnavailable)try{scope=read(row);}catch(_){scope=null;}
    return scope?.kind==='split'&&scope.groupId?row.uid:studyUid;
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
    if(!scope)throw kinError('검사 범위를 확인할 수 없습니다.');
    return scope;
  }
  async function dicom(scope, resource, request) {
    const out=[];
    for(const source of read(scope).sources) {
      const rows=await request('/dicom-web/studies/'+encodeURIComponent(source.studyUid)+'/'+resource,source);
      if(!Array.isArray(rows))throw kinError('원본 영상 목록을 확인할 수 없습니다.');
      for(const row of rows) if(allows(source,row?.['0020000E']?.Value?.[0])) out.push({sourceUid:source.studyUid,row});
    }
    return out;
  }
  // A listed row of a merged or split exam in force whose originals the reader cannot all read now (one gone from the
  // archive, or outside the reader's access): the server says so (examUnavailable, and the exam kind) and names none of
  // those originals. It is not an ordinary row: it opens no viewer, is not preloaded, and its PF says why. The list badge,
  // Preload, PF and every viewer opening ask this one answer. A temporary archive failure is not this: the list read fails
  // or the Preload entry fails with the server's reason and Retry.
  const UNAVAILABLE = {
    merge:'합친 검사의 원본 일부를 볼 수 없어 열거나 미리 받지 않습니다. 원본이 영상 저장소에 없거나 이 계정이 볼 수 없습니다. 목록을 새로고침하세요.',
    split:'나눈 검사의 원본을 볼 수 없어 열거나 미리 받지 않습니다. 원본이 영상 저장소에 없거나 이 계정이 볼 수 없습니다. 목록을 새로고침하세요.',
  };
  function unavailable(row) {
    if(row?.examUnavailable!==true)return null;
    const kind=Object.hasOwn(UNAVAILABLE,row.examUnavailableKind??'')?row.examUnavailableKind:null;
    // message: the words in the language of the screen last written (its readers write it as it is); words: as written,
    // for the list's badge, which writes them in the list's language.
    const words=kind?UNAVAILABLE[kind]:'검사 묶음의 모든 원본에 접근할 수 없습니다. 목록을 새로고침하세요.';
    return {kind,words,message:kinText(words)};
  }
  // The exam of this window (its current exam or its comparison) an image belongs to, by the scopes the server admitted:
  // every original of a merged exam is the current exam, never a prior; the two parts of one split original are told apart
  // by the series. null: the image is in neither, or in both and no series tells them apart (never guessed), or the
  // window has no scope. Later features (a cell's current / prior mark, Match information) read the window's roles here.
  function examRole(input, studyUid, seriesUid = null) {
    if(!input||typeof studyUid!=='string')return null;
    const holds=scope=>!!scope?.sources&&scope.sources.some(source=>source.studyUid===studyUid&&(!seriesUid||allows(source,seriesUid)));
    const current=holds(input.current),prior=holds(input.prior);
    return current&&prior?null:current?'current':prior?'prior':null;
  }
  // The originals (with their series rules) of the exam that image belongs to, base first: one list for one exam.
  function examSources(input, studyUid, seriesUid = null) {
    const role=examRole(input,studyUid,seriesUid);
    return role?copy(input[role].sources):null;
  }
  function viewerInput(current, prior = null, version = null, priorVersion = null) {
    const lost=unavailable(current)||unavailable(prior);
    if(lost)throw kinError(lost.words);
    const scope=read(current),comparison=prior?read(prior):null;
    if(!scope || prior&&!comparison)throw kinError('검사 범위를 확인할 수 없습니다.');
    if([...scope.sources,...(comparison?.sources||[])].some(s=>s.studyUid.length>64||!/^\d+(?:\.\d+)+$/.test(s.studyUid)))throw kinError('원본 검사 UID를 확인할 수 없습니다.');
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
      if(!row)throw kinError('현재 검사 정보를 확인할 수 없습니다.');
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
      if(unavailable(row))continue;
      const scope=read(row);
      if(!scope)throw kinError('미리 받을 검사 범위를 확인할 수 없습니다.');
      for(const source of scope.sources) {
        const entry=sources.get(source.studyUid)||{uid:source.studyUid,label:row.label??null,urgent:row.urgent===true};
        if(row.examScope)entry.examRefs=[...entry.examRefs||[],reference(scope)].filter((ref,index,list)=>list.findIndex(r=>JSON.stringify(r)===JSON.stringify(ref))===index);
        else entry.whole=true;
        sources.set(source.studyUid,entry);
      }
    }
    return [...sources.values()].map(({whole,...entry})=>{if(whole)delete entry.examRefs;return entry;});
  }
  // The Preload state of one listed exam, from the queue entry of every original its scope holds (`entryOf(studyUid)`).
  // An entry counts for this exam only when it was fetched for this exam or for the whole original (no exam reference):
  // the second part of a split exam is not ready because the first part's series are. One original failed or evicted
  // decides the exam; an original the queue does not hold for it leaves the exam without a state (null), never Ready;
  // otherwise the least advanced original decides and Downloading shows the mean progress of all originals.
  const preloadRank = ['Failed','Evicted',null,'Downloading','Queued','Ready'];
  const sameReference = (a, b) => a?.reportUid===b.reportUid && (a.groupId??null)===(b.groupId??null) && (a.part??null)===(b.part??null);
  function preloadState(row, entryOf) {
    // A row whose exam the reader cannot read whole (unavailable) is never fetched. A merged or split exam in force says
    // so at once — Failed with the reason, in every window and filter, never the state of the originals it can still
    // read — until the list says it is whole again; any other such row has no state, like viewerInput refuses it.
    const lost=unavailable(row);
    if(lost)return lost.kind?{uid:row.uid,status:'Failed',reason:lost.message,unavailable:true}:null;
    let scope=null;
    try{scope=read(row);}catch(_){return null;}
    if(!scope)return null;
    const own=row?.examScope?reference(scope):null;
    const entries=scope.sources.map(source=>{
      const entry=entryOf(source.studyUid);
      if(!entry||typeof entry.status!=='string'||!entry.status)return null;
      const refs=Array.isArray(entry.examRefs)&&entry.examRefs.length?entry.examRefs:null;
      return !refs||own&&refs.some(ref=>sameReference(ref,own))?entry:null;
    });
    const rank=entry=>{const at=preloadRank.indexOf(entry?entry.status:null);return at<0?0:at;};
    const decides=entries.reduce((worst,entry)=>rank(entry)<rank(worst)?entry:worst,entries[0]);
    if(!decides)return null;
    if(entries.length===1||decides.status!=='Downloading')return decides;
    const part=entry=>entry.status==='Ready'?1:entry.status==='Downloading'&&entry.total>0?Math.min(1,entry.done/entry.total):0;
    return {...decides,done:entries.reduce((sum,entry)=>sum+part(entry),0),total:entries.length};
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
  // One lifetime for a dialog that names an exam's originals (the choice of originals below, and a caller's own choice
  // of an original's series and images): it is shown only while live() holds - asked before it opens and again and again
  // while it is open; its caller asks once more when the person continues. When live() no longer holds, the dialog closes
  // by itself and leaves the page with everything it showed. False: it did not hold at the start and nothing was shown.
  const LIVE_CHECK_MS=250;
  function showWhileLive(dialog,live) {
    const holds=()=>{try{return live()===true;}catch(_){return false;}};
    if(!holds())return false;
    const watch=setInterval(()=>{if(!holds())dialog.close();},LIVE_CHECK_MS);
    dialog.addEventListener('close',()=>{clearInterval(watch);dialog.remove();},{once:true});
    document.body.append(dialog);dialog.showModal();
    return true;
  }
  // `note`: the caller's own sentence when what follows the choice is not the whole original (a chosen download).
  // `live`: the caller's lifetime of the choice (showWhileLive); a choice that is no longer live chooses nothing.
  function chooseOriginals(row,scope,{title,note:said,multiple=true,live=()=>true}={}) {
    return new Promise(resolve=>{
      const dialog=document.createElement('dialog'),heading=document.createElement('h3'),note=document.createElement('p');
      const language = root.KinLanguage;
      const write = (node, words) => language ? language.write(node, words) : (node.textContent = words);
      const phrase = words => language ? language.say(words) : words;
      dialog.className='order-dialog';write(heading,title ?? phrase('Download Originals'));
      if(said!=null)write(note,said);
      else write(note,kinText(scope.kind==='split'?'나눈 시리즈만이 아니라 원본 검사 전체를 내보냅니다. 원본 UID와 영상은 바뀌지 않습니다.':'내보낼 원본 검사를 고르세요. 원본 UID와 영상은 바뀌지 않습니다.'));
      dialog.append(heading,note);const choices=[];
      for(const source of scope.sources){
        const original=metadata(row).find(s=>s.uid===source.studyUid),label=document.createElement('label'),input=document.createElement('input');
        input.type=multiple?'checkbox':'radio';input.name='exam-source';input.value=source.studyUid;input.checked=scope.sources.length===1;
        // Accession No, description and UID of the original are data.
        const words=document.createElement('span');words.translate=false;words.textContent=[original?.acc,original?.desc,source.studyUid].filter(Boolean).join(' · ');
        label.append(input,' ',words);dialog.append(label,document.createElement('br'));choices.push(input);
      }
      const go=document.createElement('button'),close=document.createElement('button');go.type=close.type='button';write(go,phrase('Continue'));write(close,phrase('Cancel'));
      const update=()=>{go.disabled=!choices.some(c=>c.checked);};dialog.onchange=update;update();
      let result=[];go.onclick=()=>{if(live()===true)result=choices.filter(c=>c.checked).map(c=>c.value);dialog.close();};close.onclick=()=>dialog.close();
      dialog.addEventListener('close',()=>resolve(result),{once:true});dialog.append(go,close);
      if(!showWhileLive(dialog,live))resolve(result);
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
  const api={raiseWindow,read,key,stamp,screenScope,screenStamp,originalLabel,sourceRequest,seriesValue,seriesRequest,attachmentTarget,attachmentHeaders,storedReport,allows,listedExam,imagePlace,metadata,projections,values,originals,viewingSelection,originalInput,readingScope,readingStamp,fetch:fetchScope,dicom,unavailable,examRole,examSources,viewerInput,viewerUrl,viewerReference,reference,roleRows,snapshotReference,jobSnapshot,snapshotUrl,preload,preloadState,showWhileLive,chooseOriginals,changes};
  root.KinExamScope=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
