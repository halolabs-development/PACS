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
 const root={location,URL,URLSearchParams,Response,Headers,Event,AbortController,console,KinExamScope:model,
  fetch:async url=>{calls.push(String(url));const q=new URL(url,location);const ref=JSON.parse(q.searchParams.get('reference'));const value=await lookup(ref,q);return value instanceof Response?value:new Response(JSON.stringify(value));},
  dispatchEvent:e=>events.push(e.type),setInterval:()=>1,clearInterval(){},addEventListener(){},
  document:{documentElement:{classList:{add:v=>classes.add(v),remove:v=>classes.delete(v)}},head:{append(){}},body:{prepend(){}},createElement:()=>({setAttribute(){},remove(){}})}};
 vm.runInNewContext(fs.readFileSync('worklist-v0/hpacs-lite/viewer-exam-scope.js','utf8'),root);
 return {api:root.KinViewerExamScope,root,calls,events,classes};
}
test('ordinary opening retains the URL, one study and compare protocol without scope data',()=>{
 assert.equal(model.viewerUrl(model.viewerInput({uid:A})),`/ohif/viewer?StudyInstanceUIDs=${A}`);
 assert.equal(model.viewerUrl(model.viewerInput({uid:A},{uid:B}),S),`/ohif/viewer?StudyInstanceUIDs=${A},${B}&hangingProtocolId=@ohif/hpCompare&initialSeriesInstanceUID=${S}`);
});

test('clinician ordinary openings keep the native URL and request count while stored split openings recheck their scope',async()=>{
 const ts=require('../api/node_modules/typescript');
 const tree=ts.createSourceFile('clinician.js',fs.readFileSync('worklist-v0/hpacs-lite/clinician.js','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 let open;function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='openViewer')open=node.getText(tree);ts.forEachChild(node,visit);}visit(tree);
 const plain={...scope(A,[source(A)]),groupId:null,kind:'single',part:null},calls=[],opened=[],note={};
 const popup={location:{replace:url=>opened.push(url)},focus(){}};
 const context={root:{KinExamScope:model,open:()=>popup},KinAuth:{sessionId:()=> 'session'},
  byUid:new Map([[A,{uid:A}],[P,{uid:P}]]),selected:A,leaving:false,reportSeq:1,viewerSequence:0,
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
 const made=[],services={displaySetService:{createDisplaySets:instances=>{made.push(instances);return instances;}}};v.api.install(services);
 services.displaySetService.createDisplaySets([{StudyInstanceUID:A,SeriesInstanceUID:S},{StudyInstanceUID:A,SeriesInstanceUID:T}]);assert.equal(made[0].length,1);assert.equal(made[0][0].SeriesInstanceUID,S);
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
test('preload expands merged originals and retains split series references without changing ordinary requests',()=>{
 assert.deepEqual(model.preload([{uid:A}]),[{uid:A,label:null,urgent:false}]);
 const examScope=scope(B,[source(A,'include',[S])],1);const rows=model.preload([{uid:B,examScope}]);assert.equal(rows[0].uid,A);assert.deepEqual(rows[0].examRefs,[model.reference(examScope)]);
});

test('native comparison selects current and prior by logical scope even when both parts use one original',async()=>{
 const current=scope(A,[source(A,'exclude',[S])],0),prior=scope(B,[source(A,'include',[S])],1);
 const v=viewer(model.viewerInput(current,prior),ref=>ref.part===0?current:prior);await v.api.ensure();
 const sets=[{StudyInstanceUID:A,SeriesInstanceUID:S,displaySetInstanceUID:'second'},{StudyInstanceUID:A,SeriesInstanceUID:T,displaySetInstanceUID:'first'}];
 let protocol,called;const services={displaySetService:{createDisplaySets:values=>values},hangingProtocolService:{addProtocol:(_id,value)=>protocol=value,run:(_data,id)=>called=id}};
 v.api.install(services);services.hangingProtocolService.run({displaySets:sets},'@ohif/hpCompare');assert.equal(called,'kin.exam-compare');
 assert.equal(protocol.displaySetSelectors['exam-0'].seriesMatchingRules[0].constraint.equals.value,'first');
 assert.equal(protocol.displaySetSelectors['exam-1'].seriesMatchingRules[0].constraint.equals.value,'second');
 services.hangingProtocolService.run({displaySets:sets},'personal');assert.equal(called,'personal');
});
