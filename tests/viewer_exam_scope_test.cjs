// Ordinary Job snapshots must retain their existing JSON bytes and keys for restore and output compatibility.
// Server-admitted exam scopes bound original images without changing their DICOM identifiers.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const model=require('../worklist-v0/hpacs-lite/exam-scope.js');
const A='2.25.1',B='2.25.2',C='2.25.3',P='2.25.4',S='2.25.10',T='2.25.11';
const group='00000000-0000-4000-8000-000000000001';
const scope=(reportUid,sources,part=null)=>({reportUid,groupId:group,kind:part===null?'merge':'split',part,active:true,generation:'a'.repeat(64),sources});
const source=(studyUid,mode='all',uids=[])=>({studyUid,series:{mode,uids}});
const row=(study,series)=>({'0020000D':{Value:[study]},'0020000E':{Value:[series]}});
function viewer(input,lookup){
 const calls=[],events=[],classes=new Set();const location=new URL(model.viewerUrl(input),'https://pacs.test');
 const root={location,URL,URLSearchParams,Request,Response,Headers,Event,AbortController,console,KinExamScope:model,
  fetch:async url=>{calls.push(String(url));const q=new URL(url,location);const ref=JSON.parse(q.searchParams.get('reference'));const value=await lookup(ref,q);return value instanceof Response?value:new Response(JSON.stringify(value));},
  dispatchEvent:e=>events.push(e.type),setInterval:()=>1,clearInterval(){},addEventListener(){},
  document:{documentElement:{classList:{add:v=>classes.add(v),remove:v=>classes.delete(v)}},head:{append(){}},body:{prepend(){}},createElement:()=>({setAttribute(){},remove(){}})}};
 // The viewer's app config defines the Studies panel order (kinSeriesOrder) before the scope module runs.
 vm.createContext(root);vm.runInContext(fs.readFileSync('config/ohif/series-order.js','utf8'),root);
 vm.runInContext(fs.readFileSync('worklist-v0/hpacs-lite/viewer-exam-scope.js','utf8'),root);
 return {api:root.KinViewerExamScope,root,calls,events,classes};
}
test('ordinary opening retains the URL, one study and compare protocol without scope data',()=>{
 assert.equal(model.viewerUrl(model.viewerInput({uid:A})),`/ohif/viewer?StudyInstanceUIDs=${A}`);
 assert.equal(model.viewerUrl(model.viewerInput({uid:A},{uid:B}),S),`/ohif/viewer?StudyInstanceUIDs=${A},${B}&hangingProtocolId=@ohif/hpCompare&initialSeriesInstanceUID=${S}`);
});

test('ordinary screen observations keep selection and labels across draft epochs and temporary absence',()=>{
 const first={uid:A,state:{draftEpoch:'before'}},later={uid:A,state:{draftEpoch:'after'}};
 assert.equal(model.screenStamp(first),model.screenStamp(later));
 assert.equal(model.screenStamp(first),model.screenStamp({uid:A,origin:'logical'}));
 const selection=require('../worklist-v0/hpacs-lite/worklist-selection.js').create();
 selection.reconcile([first]);selection.toggle(A,[first]);const before=selection.generation();
 selection.reconcile([later]);assert.equal(selection.generation(),before);
 const single={...model.read(first),generation:'server-generation',kind:null};
 assert.equal(model.viewerInput(single).scoped,false);
 assert.equal(model.viewerInput({examScope:single}).scoped,false);
 assert.equal(model.originalLabel(single,'Study '+A,'Series '+S,true),'Series '+S);
 assert.equal(model.seriesValue(single,A,S),S);
 assert.deepEqual(model.sourceRequest(single,A,{seriesUid:S}),{seriesUid:S});
 assert.deepEqual(model.seriesRequest(single,S),{seriesUid:S});
 assert.deepEqual(model.attachmentHeaders(single,A,single.generation),{});
 assert.equal(model.attachmentTarget(first).canAttach,true);
 assert.equal(model.attachmentTarget(first).sourceUid,A);
 const grouped={uid:A,examScope:scope(A,[source(A),source(B)])};
 assert.equal(model.attachmentTarget(grouped).canAttach,false);
 assert.deepEqual(model.attachmentHeaders(grouped,B,'verified'),{'X-KIN-Source-Uid':B,'X-KIN-Exam-Generation':'verified'});
 selection.reconcile([grouped]);assert.equal(selection.generation(),before+1);
 assert.notEqual(model.screenStamp(grouped),model.screenStamp(first));
});

test('ordinary previews retain one original request while grouped labels name their sources',async()=>{
 const calls=[],plain=model.read({uid:A});
 const rows=await model.dicom(plain,'instances',async path=>{calls.push(path);return [row(A,S)];});
 assert.deepEqual(calls,[`/dicom-web/studies/${A}/instances`]);
 assert.deepEqual(rows,[{sourceUid:A,row:row(A,S)}]);
 const merged=scope(A,[source(A),source(B)]);
 assert.equal(model.originalLabel(merged,'Study '+B,'Series '+S,true),'Study '+B+' · Series '+S);
});

test('Viewing Set expands every merged original and deduplicates both split parts before its selection limit',()=>{
 const first={uid:A,examScope:scope(A,[source(A,'exclude',[S])],0)};
 const second={uid:B,examScope:scope(B,[source(A,'include',[S])],1)};
 const pick=(studyUids,rows)=>model.viewingSelection({owner:'reader',generation:2,studyUids},rows);
 assert.deepEqual(pick([A,B],[first,second]).studyUids,[A]);
 const w9=require('../worklist-v0/hpacs-lite/multi-study-view.js');
 assert.equal(w9.orderedSelection(pick([A,B],[first,second]).studyUids,A),null);
 const merged={uid:C,examScope:scope(C,[source(C),source(P)])};
 assert.deepEqual(pick([B,C,A],[first,second,merged]).studyUids,[A,C,P]);
 const input=model.originalInput([A,C]);
 assert.equal(model.viewerUrl(input),`/ohif/viewer?StudyInstanceUIDs=${A},${C}&hangingProtocolId=@ohif/hpCompare`);
 assert.equal(input.current.groupId,null);assert.equal(input.purpose,'stored');
});

test('ordinary Jobs omit references while grouped Reading keeps its distinct scope',()=>{
 const value={studies:[A,P],cells:[]},saved=model.jobSnapshot(value,null,value.studies);
 assert.deepEqual(saved,value);
 assert.deepEqual(model.jobSnapshot(value,null,value.studies,true),value);
 assert.equal(model.readingStamp(null,A),model.readingStamp({uid:A,state:{draftEpoch:'later'}}));
 assert.notEqual(model.readingStamp(null,A),model.readingStamp(scope(A,[source(A),source(B)])));
});

test('adding a logical comparison reopens current and prior through the existing unsaved-work gate',async()=>{
 const ts=require('../api/node_modules/typescript');
 const tree=ts.createSourceFile('viewer-prior.js',fs.readFileSync('config/ohif/viewer-prior.js','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 let method;function visit(node){if(ts.isMethodDeclaration(node)&&node.name?.getText(tree)==='loadStudy')method=node.getText(tree);ts.forEachChild(node,visit);}visit(tree);
 const current=scope(A,[source(A,'exclude',[S])],0),prior=scope(B,[source(A,'include',[S])],1);
 let opening=model.viewerInput(current),allowed=false;const gates=[],retrieved=[];
 const root={KinExamScope:model,KinViewerExamScope:{snapshot:()=>opening,ensure:async()=>opening},
  KinViewerHangingSettings:{rank:sets=>sets},
  kinViewerOpenPatient:async(href,options)=>{gates.push({href,options});return allowed;}};
 const kinSeriesOrder=vm.runInNewContext(fs.readFileSync('config/ohif/series-order.js','utf8')+';kinSeriesOrder');
 // The method alone has no kinError of its function (config/ohif/viewer-prior.js): the plain fill, as written.
 const kinError=(t,...p)=>Object.assign(new Error(t.replace(/\{[ten]?(\d+)\}/g,(m,i)=>String(p[i]))),{kinWords:true});
 const sandbox={window:root,URL,location:new URL('https://pacs.test/ohif/viewer#kin-window-group=keep'),kinSeriesOrder,kinError,
  viewer:{snapshot:()=>({studyUIDs:[A]})},
  extensions:{getActiveDataSource:()=>[{retrieve:{series:{metadata:async value=>retrieved.push(value)}},deleteStudyMetadataPromise(){}}]},
  services:{displaySetService:{getActiveDisplaySets:()=>[{StudyInstanceUID:P,SeriesInstanceUID:T,images:[{}]}]}}};
 const loader=vm.runInNewContext('({'+method+'}).loadStudy',sandbox),abort=new AbortController();
 await assert.rejects(loader(B,{}, {uid:B,examScope:prior},{signal:abort.signal}),/현재 영상은 유지/);
 assert.deepEqual(retrieved,[]);
 allowed=true;const answer=await loader(B,{}, {uid:B,examScope:prior},{signal:abort.signal,seriesUid:S,valid:()=>true});
 assert.equal(answer.reopened,true);
 const url=new URL(gates.at(-1).href),refs=JSON.parse(url.searchParams.get('kinExamScopes'));
 assert.deepEqual(refs.current,model.reference(current));assert.deepEqual(refs.prior,model.reference(prior));
 assert.equal(url.searchParams.get('StudyInstanceUIDs'),A);assert.equal(url.searchParams.get('initialSeriesInstanceUID'),S);
 assert.equal(url.hash,'#kin-window-group=keep');assert.equal(gates.at(-1).options.signal,abort.signal);
 const count=gates.length;await loader(B,{}, {uid:B,examScope:prior},{valid:()=>false});assert.equal(gates.length,count);
 opening={...opening,purpose:'stored'};await loader(B,{}, {uid:B,examScope:prior});
 assert.equal(JSON.parse(new URL(gates.at(-1).href).searchParams.get('kinExamScopes')).purpose,'stored');
 opening=null;await loader(P,{studyUid:A,seriesUid:T}, {uid:P});assert.equal(retrieved.length,1);assert.equal(retrieved[0].StudyInstanceUID,P);
 assert.equal(gates.length,count+1);
 // A related exam whose originals cannot all be read now is not opened beside this one, not even the original it still has.
 await assert.rejects(loader(B,{}, {uid:B,examUnavailable:true,examUnavailableKind:'merge'}),/합친 검사의 원본 일부/);assert.equal(retrieved.length,1);assert.equal(gates.length,count+1);
});

test('clinician ordinary openings keep the native URL and request count while stored split openings recheck their scope',async()=>{
 const ts=require('../api/node_modules/typescript');
 const tree=ts.createSourceFile('clinician.js',fs.readFileSync('worklist-v0/hpacs-lite/clinician.js','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 let open;function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='openViewer')open=node.getText(tree);ts.forEachChild(node,visit);}visit(tree);
 const plain={...scope(A,[source(A)]),groupId:null,kind:'single',part:null},calls=[],opened=[],note={};
 const popup={location:{replace:url=>opened.push(url)},focus(){}};
 const context={root:{KinExamScope:model,open:url=>{if(url)opened.push(url);return popup;}},KinAuth:{sessionId:()=> 'session'},
  byUid:new Map([[A,{uid:A}],[P,{uid:P}]]),selected:A,selectedReportTarget:null,leaving:false,reportSeq:1,viewerSequence:0,
  displayedExam:plain,displayedReport:{uid:A,version:4},STUDY_UID:/^\d+(?:\.\d+)+$/,VIEWER_WINDOW:'viewer',
  $:()=>note,TEXT:{},patientKey:()=> 'patient',describe:e=>e.message,
  request:async path=>{calls.push(path);return context.displayedExam;}};
 vm.createContext(context);vm.runInContext(open,context);
 context.openViewer(null);context.openViewer(P);await new Promise(setImmediate);
 assert.equal(calls.length,0);assert.deepEqual(opened,[model.viewerUrl(model.viewerInput({uid:A})),model.viewerUrl(model.viewerInput({uid:A},{uid:P}))]);
 context.displayedExam=scope(B,[source(A,'include',[S])],1);context.displayedReport={uid:B,version:4};
 context.openViewer(null);await new Promise(setImmediate);
 assert.equal(calls.length,1);assert.match(calls[0],new RegExp('/studies/'+B+'/exam-scope\\?purpose=stored&version=4$'));
 const query=new URL(opened.at(-1),'https://pacs.test').searchParams;
 assert.equal(query.get('kinReportUid'),B);assert.equal(query.get('StudyInstanceUIDs'),A);
 assert.equal(JSON.parse(query.get('kinExamScopes')).version,4);
});

test('a malformed reference after opening never becomes an unrestricted ordinary route',async()=>{
 const current=scope(A,[source(A)]),v=viewer(model.viewerInput(current),()=>current);await v.api.ensure();
 v.root.location.searchParams.set('kinExamScopes','{');let sent=0;
 await assert.rejects(v.api.send(async()=>{sent++;},`/dicom-web/studies/${A}/metadata`));
 assert.equal(sent,0);assert.equal(v.api.snapshot(),null);assert.ok(v.classes.has('kin-exam-unverified'));
});
test('compact references omit sources and series; merged current keeps three originals and one prior role',async()=>{
 const current=scope(A,[source(A),source(B),source(C)]),prior={...scope(P,[source(P)]),groupId:null,kind:null};
 const input=model.viewerInput(current,prior),v=viewer(input,ref=>ref.reportUid===A?current:prior);
 const ref=JSON.parse(v.root.location.searchParams.get('kinExamScopes'));
 assert.deepEqual(Object.keys(ref.current).sort(),['groupId','part','reportUid']);
 const admitted=await v.api.ensure();assert.deepEqual(Array.from(admitted.studyUids),[A,B,C,P]);assert.equal(v.calls.length,2);
 const sets=[A,B,C,P].map((StudyInstanceUID,i)=>({StudyInstanceUID,SeriesInstanceUID:S,displaySetInstanceUID:String(i)}));
 const roles=model.roleRows(admitted,[{uid:A},{uid:P}],sets);assert.equal(roles.length,2);assert.deepEqual(Array.from(roles[0].displaySetIds),['0','1','2']);assert.deepEqual(Array.from(roles[1].displaySetIds),['3']);
});
test('plain prior in a scoped opening asks the server to attest no membership',async()=>{
 const current=scope(A,[source(A),source(B)]),v=viewer(model.viewerInput(current,{uid:P}),ref=>ref.reportUid===A?current:{...scope(P,[source(P)]),groupId:null,kind:null});
 await v.api.ensure();assert.equal(JSON.parse(new URL(v.calls[1],'https://pacs.test').searchParams.get('reference')).groupId,null);
});
test('split second part filters metadata, refuses excluded frames and filters cached display sets',async()=>{
 const second=scope(B,[source(A,'include',[S])],1),v=viewer(model.viewerInput(second),()=>second);await v.api.ensure();
 let requests=0;const native=async()=>{requests++;return new Response(JSON.stringify([row(A,S),row(A,T)]));};
 const response=await v.api.send(native,`/dicom-web/studies/${A}/metadata`);assert.deepEqual(await response.json(),[row(A,S)]);
 await assert.rejects(v.api.send(native,`/dicom-web/studies/${A}/series/${T}/instances/2.25.90/frames/1`));assert.equal(requests,1);
 const made=[],services={displaySetService:{makeDisplaySets:instances=>{made.push(instances);return instances;}}};v.api.install(services);
 services.displaySetService.makeDisplaySets([{StudyInstanceUID:A,SeriesInstanceUID:S},{StudyInstanceUID:A,SeriesInstanceUID:T}]);assert.equal(made[0].length,1);assert.equal(made[0][0].SeriesInstanceUID,S);
});
test('an edited URL cannot add an original and partial permission never admits pixels',async()=>{
 const current=scope(A,[source(A),source(B)]),v=viewer(model.viewerInput(current),()=>current);
 v.root.location.searchParams.set('StudyInstanceUIDs',[A,B,C].join(','));await assert.rejects(v.api.ensure());assert.equal(v.api.snapshot(),null);
 const denied=viewer(model.viewerInput(current),()=>new Response('{}',{status:404}));let fetched=false;
 await assert.rejects(denied.api.send(async()=>{fetched=true;},`/dicom-web/studies/${A}/metadata`));assert.equal(fetched,false);assert(denied.classes.has('kin-exam-unverified'));
});
test('a membership change during an image response discards the response and the displayed scope',async()=>{
 const current=scope(A,[source(A),source(B)]),v=viewer(model.viewerInput(current),()=>current);await v.api.ensure();
 let complete,started;const waiting=new Promise(r=>started=r);
 const pending=v.api.send(()=>{started();return new Promise(r=>complete=r);},`/dicom-web/studies/${A}/metadata`);await waiting;v.api.invalidate();complete(new Response(JSON.stringify([row(A,S)])));
 await assert.rejects(pending);assert.equal(v.api.snapshot(),null);assert(v.classes.has('kin-exam-unverified'));
});
test('late series belongs to the first split part, and stored reopening keeps the compact saved reference',async()=>{
 const first=scope(A,[source(A,'exclude',[S])],0),input=model.viewerInput(first),v=viewer(input,()=>first);await v.api.ensure();
 const response=await v.api.send(async()=>new Response(JSON.stringify([row(A,S),row(A,T)])),`/dicom-web/studies/${A}/metadata`);assert.deepEqual(await response.json(),[row(A,T)]);
 const snapshot={studies:[A],exam:{...model.snapshotReference(input),purpose:'stored'}};
 const href=new URL(model.snapshotUrl(snapshot),'https://pacs.test');v.root.location=href;await v.api.ensure();assert.equal(new URL(v.calls.at(-1),'https://pacs.test').searchParams.get('purpose'),'stored');
});
test('a merged exam opens as one current exam: every original is current, a prior stays prior, split parts by series',async()=>{
 const merged=scope(A,[source(A),source(B),source(C)]),prior={...scope(P,[source(P)]),groupId:null,kind:null};
 const input=model.viewerInput(merged,prior);
 for(const uid of [A,B,C])assert.equal(model.examRole(input,uid,S),'current',uid);
 assert.equal(model.examRole(input,P,S),'prior');assert.equal(model.examRole(input,'2.25.99',S),null);assert.equal(model.examRole(null,A),null);
 assert.deepEqual(model.examSources(input,C).map(s=>s.studyUid),[A,B,C],'one list, base original first');
 assert.deepEqual(model.examSources(input,P).map(s=>s.studyUid),[P]);
 const first=scope(A,[source(A,'exclude',[S])],0),second=scope(B,[source(A,'include',[S])],1),parts=model.viewerInput(first,second);
 assert.equal(model.examRole(parts,A,T),'current');assert.equal(model.examRole(parts,A,S),'prior');
 assert.equal(model.examRole(parts,A),null,'both parts of one original, no series: not guessed');assert.equal(model.examSources(parts,A),null);
 // The viewer asks the admitted window scope; a window without one has no role (the opened order decides there).
 const v=viewer(input,ref=>ref.reportUid===A?merged:prior);assert.equal(v.api.role(B,S),null);await v.api.ensure();
 assert.equal(v.api.role(B,S),'current');assert.equal(v.api.role(P,S),'prior');assert.deepEqual(v.api.sources(B).map(s=>s.studyUid),[A,B,C]);
});
test('the viewer image sets are made through the archive scope on OHIF\'s own makeDisplaySets, once per service',async()=>{
 const merged=scope(A,[source(A),source(B)]),v=viewer(model.viewerInput(merged),()=>merged);await v.api.ensure();
 // The pinned OHIF service has makeDisplaySets and no other maker: installing must not fail on it.
 const made=[],native=function(instances,options){made.push([instances,options]);return instances.map(i=>({StudyInstanceUID:i.StudyInstanceUID}));};
 const services={displaySetService:{makeDisplaySets:native,getActiveDisplaySets:()=>[]}};
 v.api.install(services);const wrapped=services.displaySetService.makeDisplaySets;v.api.install(services);
 assert.equal(services.displaySetService.makeDisplaySets,wrapped,'installed once');
 const sets=services.displaySetService.makeDisplaySets([{StudyInstanceUID:A,SeriesInstanceUID:S},{StudyInstanceUID:B,SeriesInstanceUID:T},{StudyInstanceUID:P,SeriesInstanceUID:S}]);
 assert.deepEqual(sets.map(s=>s.StudyInstanceUID),[A,B],'both originals, nothing outside the exam');
 // A batch is one list per series: each keeps the scope's images, a list left empty is not passed on.
 made.length=0;services.displaySetService.makeDisplaySets([[{StudyInstanceUID:A,SeriesInstanceUID:S}],[{StudyInstanceUID:P,SeriesInstanceUID:S}],[{StudyInstanceUID:B,SeriesInstanceUID:T},{StudyInstanceUID:P,SeriesInstanceUID:T}]],{batch:true});
 assert.deepEqual(JSON.parse(JSON.stringify(made[0][0])).map(list=>list.map(i=>i.StudyInstanceUID)),[[A],[B]]);assert.deepEqual(made[0][1],{batch:true});
 assert.equal(services.displaySetService.makeDisplaySets([{StudyInstanceUID:P,SeriesInstanceUID:S}]).length,0);
 // What this window's reader just saved is held to the scope as on reopening: inside it is made, outside it is not.
 made.length=0;services.displaySetService.makeDisplaySets([{StudyInstanceUID:A,SeriesInstanceUID:'2.25.77'}],true);assert.equal(made.length,1);
 assert.equal(services.displaySetService.makeDisplaySets([{StudyInstanceUID:P,SeriesInstanceUID:'2.25.77'}],true).length,0);assert.equal(made.length,1);
 assert.throws(()=>v.api.install({displaySetService:{}}),/영상 범위 공급/);
});
test('an ordinary route after a scoped one has no scope and no role, without failing',async()=>{
 const merged=scope(A,[source(A),source(B)]),v=viewer(model.viewerInput(merged),()=>merged);await v.api.ensure();
 v.root.location=new URL(model.viewerUrl(model.viewerInput({uid:P})),'https://pacs.test');v.api.activate(v.root.location.href,null);
 assert.equal(v.api.snapshot(),null);assert.equal(v.api.role(P),null);assert.equal(v.api.sources(P),null);
});
test('Auto Preload neither counts nor fetches an exam that cannot be read whole, nor its priors',()=>{
 const queue=require('../worklist-v0/hpacs-lite/preload-queue.js');
 const rows=[{uid:A,date:'2026-11-02',modality:'CT',sourcePatientKey:'K',examUnavailable:true,examUnavailableKind:'merge'},
  {uid:B,date:'2026-11-01',modality:'CT',sourcePatientKey:'K'},{uid:C,date:'2026-11-03',modality:'CT',sourcePatientKey:'Q'}];
 // The saved search matched A (unavailable) and C; B is A's prior.
 assert.deepEqual(queue.pick([rows[0],rows[2]],rows,{priors:true}).map(s=>s.uid),[C]);
});
test('a row of a merged exam whose originals cannot all be read is not an ordinary row: no opening, no Preload, a PF reason',()=>{
 const lost={uid:A,examUnavailable:true,examUnavailableKind:'merge'},split={uid:B,examUnavailable:true,examUnavailableKind:'split'},old={uid:C,examUnavailable:true};
 assert.equal(model.unavailable({uid:A}),null);assert.equal(model.unavailable(lost).kind,'merge');assert.equal(model.unavailable(split).kind,'split');
 assert.equal(model.unavailable(old).kind,null);assert.equal(model.unavailable({...lost,examUnavailableKind:'other'}).kind,null);
 assert.throws(()=>model.viewerInput(lost),/합친 검사의 원본 일부/);assert.throws(()=>model.viewerInput({uid:P},split),/나눈 검사의 원본/);
 assert.throws(()=>model.viewerInput(old),/모든 원본에 접근할 수 없습니다/);
 assert.deepEqual(model.preload([lost,{uid:P}]).map(e=>e.uid),[P],'the readable original of a lost exam is not fetched');
 const ready=()=>({status:'Ready'});
 // At once, never the Ready of the originals it can still read; a row without an exam in force keeps no state.
 const failed=model.preloadState(lost,ready);assert.equal(failed.status,'Failed');assert.match(failed.reason,/합친 검사의 원본 일부/);
 assert.match(model.preloadState(split,ready).reason,/나눈 검사의 원본/);assert.equal(model.preloadState(old,ready),null);
 assert.equal(model.preloadState({uid:A},ready).status,'Ready','an ordinary row is unchanged');
});
test('preload expands merged originals and retains split series references without changing ordinary requests',()=>{
 assert.deepEqual(model.preload([{uid:A}]),[{uid:A,label:null,urgent:false}]);
 const examScope=scope(B,[source(A,'include',[S])],1);const rows=model.preload([{uid:B,examScope}]);assert.equal(rows[0].uid,A);assert.deepEqual(rows[0].examRefs,[model.reference(examScope)]);
});

test('native comparison selects current and prior by logical scope even when both parts use one original',async()=>{
 const current=scope(A,[source(A,'exclude',[S])],0),prior=scope(B,[source(A,'include',[S])],1);
 const v=viewer(model.viewerInput(current,prior),ref=>ref.part===0?current:prior);await v.api.ensure();
 const sets=[{StudyInstanceUID:A,SeriesInstanceUID:S,displaySetInstanceUID:'second'},{StudyInstanceUID:A,SeriesInstanceUID:T,displaySetInstanceUID:'first'}];
 let protocol,called;const services={displaySetService:{makeDisplaySets:values=>values},hangingProtocolService:{addProtocol:(_id,value)=>protocol=value,run:(_data,id)=>called=id}};
 v.api.install(services);services.hangingProtocolService.run({displaySets:sets},'@ohif/hpCompare');assert.equal(called,'kin.exam-compare');
 assert.equal(protocol.displaySetSelectors['exam-0'].seriesMatchingRules[0].constraint.equals.value,'first');
 assert.equal(protocol.displaySetSelectors['exam-1'].seriesMatchingRules[0].constraint.equals.value,'second');
 services.hangingProtocolService.run({displaySets:sets},'personal');assert.equal(called,'personal');
});

test('native comparison opens each side on its first image series in panel order, not on an attached document',async()=>{
 const current=scope(A,[source(A)]),prior=scope(B,[source(B)]);
 const v=viewer(model.viewerInput(current,prior),ref=>ref.reportUid===A?current:prior);await v.api.ensure();
 // An attached picture: a Secondary Capture series without a Series Number (the display set writes 0); arrival order reversed.
 const set=(study,series,id,number,extra={})=>({StudyInstanceUID:study,SeriesInstanceUID:series,displaySetInstanceUID:id,Modality:'CT',SeriesNumber:number??0,
  instances:[{SeriesNumber:number,SeriesDate:'20261101',SeriesTime:'120000'}],...extra});
 const sets=[set(B,'2.25.23','prior-ct',2),set(B,'2.25.22','prior-attached',undefined,{Modality:'OT'}),set(A,'2.25.21','current-ct',1),
  set(A,'2.25.20','current-attached',undefined,{Modality:'OT'}),set(A,'2.25.19','current-zero',0,{Modality:'CT'})];
 let protocol;const services={displaySetService:{makeDisplaySets:values=>values},hangingProtocolService:{addProtocol:(_id,value)=>protocol=value,run(){}}};
 v.api.install(services);
 const chosen=input=>{services.hangingProtocolService.run({displaySets:input},'@ohif/hpCompare');
  return ['exam-0','exam-1'].map(key=>protocol.displaySetSelectors[key].seriesMatchingRules[0].constraint.equals.value);};
 // A real Series Number 0 is a number and goes first; a missing one goes after every numbered series.
 assert.deepEqual(chosen(sets),['current-zero','prior-ct']);
 assert.deepEqual(chosen(sets.filter(s=>s.displaySetInstanceUID!=='current-zero')),['current-ct','prior-ct']);
 assert.deepEqual(chosen(sets.filter(s=>s.displaySetInstanceUID!=='current-zero').reverse()),['current-ct','prior-ct']);
 // A study with nothing but the attached picture opens on it.
 assert.deepEqual(chosen([sets[1],set(A,'2.25.20','current-attached',undefined,{Modality:'OT'})]),['current-attached','prior-attached']);
});

// Byte identity is the ordinary Job persistence contract, including every volume recipe version.
test('a related study series list outside the scope passes only as a named series list; metadata and images stay refused',async()=>{
 const current=scope(A,[source(A),source(B)]),v=viewer(model.viewerInput(current),()=>current);await v.api.ensure();
 const asked=[];const native=async(url,init)=>{asked.push([String(url),new Headers(init?.headers||{}).get('X-KIN-Series-List')]);return new Response(JSON.stringify([row(P,S),row(P,T)]));};
 const named={headers:{'X-KIN-Series-List':'related',Accept:'application/dicom+json'}};
 // Without the name, as before: a study outside the scope is refused before anything is sent.
 await assert.rejects(v.api.send(native,`/dicom-web/studies/${P}/series`));
 // Named: the series level of that study only, answered as the archive answered (the panel keeps the exam's own series).
 const listed=await v.api.send(native,`/dicom-web/studies/${P}/series?includefield=0020000E`,named);assert.deepEqual(await listed.json(),[row(P,S),row(P,T)]);
 await assert.rejects(v.api.send(native,`/dicom-web/studies/${P}/metadata`,named));
 await assert.rejects(v.api.send(native,`/dicom-web/studies/${P}/series/${S}/metadata`,named));
 await assert.rejects(v.api.send(native,`/dicom-web/studies/${P}/series/${S}/instances`,named));
 await assert.rejects(v.api.send(native,`/dicom-web/studies/${P}/series`,{headers:{'X-KIN-Series-List':'other'}}));
 // Exactly a GET of the series level: not a write, not a metadata path that ends in "series".
 await assert.rejects(v.api.send(native,`/dicom-web/studies/${P}/series`,{...named,method:'POST'}));
 await assert.rejects(v.api.send(native,`/dicom-web/studies/${P}/metadata/series`,named));
 await assert.rejects(v.api.send(native,new Request(`https://pacs.test/dicom-web/studies/${P}/series`,{method:'POST',headers:named.headers})));
 assert.deepEqual(asked,[[`/dicom-web/studies/${P}/series?includefield=0020000E`,'related']]);
 // A study inside the scope is answered as the archive lists it too: the window is the first part of a split original
 // (S) and the related exam asked for is its second part (T), so the panel keeps T with that exam's own scope.
 const split=scope(B,[source(A,'include',[S])],1),w=viewer(model.viewerInput(split),()=>split);await w.api.ensure();
 const inside=await w.api.send(async()=>new Response(JSON.stringify([row(A,S),row(A,T)])),`/dicom-web/studies/${A}/series`,named);
 const second=scope(C,[source(A,'exclude',[S])],2);
 assert.deepEqual(await model.dicom(second,'series',async()=>inside.json()),[{sourceUid:A,row:row(A,T)}]);
 // Unnamed, OHIF's own series read inside the scope is filtered as before.
 const own=await w.api.send(async()=>new Response(JSON.stringify([row(A,S),row(A,T)])),`/dicom-web/studies/${A}/series`);assert.deepEqual(await own.json(),[row(A,S)]);
 // A scope change while the list is read discards it.
 let complete,started;const waiting=new Promise(r=>started=r);
 const pending=v.api.send(()=>{started();return new Promise(r=>complete=r);},`/dicom-web/studies/${P}/series`,named);await waiting;v.api.invalidate();complete(new Response('[]'));
 await assert.rejects(pending);
});
test('a comparison opened for one series of a scoped prior shows that series in its role',async()=>{
 const current=scope(A,[source(A)]),prior=scope(B,[source(B),source(C)]);
 const v=viewer(model.viewerInput(current,prior),ref=>ref.reportUid===A?current:prior);await v.api.ensure();
 const sets=[{StudyInstanceUID:A,SeriesInstanceUID:S,displaySetInstanceUID:'cur',Modality:'CT'},{StudyInstanceUID:B,SeriesInstanceUID:'2.25.20',displaySetInstanceUID:'b-first',Modality:'CT'},
  {StudyInstanceUID:C,SeriesInstanceUID:'2.25.30',displaySetInstanceUID:'c-second',Modality:'CT'},{StudyInstanceUID:C,SeriesInstanceUID:'2.25.31',displaySetInstanceUID:'c-sr',Modality:'SR'}];
 let protocol;const services={displaySetService:{makeDisplaySets:values=>values},hangingProtocolService:{addProtocol:(_id,value)=>protocol=value,run(){}}};v.api.install(services);
 const chosen=()=>[0,1].map(i=>protocol.displaySetSelectors['exam-'+i].seriesMatchingRules[0].constraint.equals.value);
 services.hangingProtocolService.run({displaySets:sets},'@ohif/hpCompare');assert.deepEqual(chosen(),['cur','b-first']);
 v.root.location.searchParams.set('initialSeriesInstanceUID','2.25.30');await v.api.ensure();services.hangingProtocolService.run({displaySets:sets},'@ohif/hpCompare');assert.deepEqual(chosen(),['cur','c-second']);
 // A series the role does not hold as an image keeps the role's first image.
 v.root.location.searchParams.set('initialSeriesInstanceUID','2.25.31');await v.api.ensure();services.hangingProtocolService.run({displaySets:sets},'@ohif/hpCompare');assert.deepEqual(chosen(),['cur','b-first']);
});

test('ordinary Job capture and stored-original capture preserve the original JSON bytes and omit scope',()=>{
 for(const version of [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]) {
  const value={version,studies:[A,P],rows:1,cols:2,active:0,cells:[null,null]};
  for(const input of [null,model.viewerInput({uid:A},{uid:P}),model.originalInput([A,P])]) {
   assert.equal(JSON.stringify(model.jobSnapshot(value,input,value.studies)),JSON.stringify(value));
   assert.equal(JSON.stringify(model.jobSnapshot(value,input,value.studies,true)),JSON.stringify(value));
  }
 }
 const input=model.viewerInput(scope(A,[source(A),source(B)]));
 assert.deepEqual(model.jobSnapshot({studies:[A,B]},input,[A,B]).exam,model.snapshotReference(input));
 assert.equal(model.readingStamp({uid:A}),undefined);
 assert.equal(model.readingScope({uid:A}),null);
});
