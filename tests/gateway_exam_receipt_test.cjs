// Original receipt controls share the existing Retry command and retain its stale-response boundary.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ts=require('../api/node_modules/typescript');
const model=require('../worklist-v0/hpacs-lite/exam-scope.js'),arrivals=require('../worklist-v0/hpacs-lite/study-arrivals.js');
const functions=(file,names)=>{
 const tree=ts.createSourceFile(file,fs.readFileSync('worklist-v0/hpacs-lite/'+file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const found=tree.statements.filter(node=>ts.isFunctionDeclaration(node) ? names.includes(node.name?.text)
  : ts.isVariableStatement(node) && node.declarationList.declarations.some(d=>names.includes(d.name.getText(tree)))).map(node=>node.getText(tree));
 assert.equal(found.length,names.length,file+' declares '+names.join(', '));
 return found;
};
// The panel writes its status through the writer of the page (page-core.js). No screen language is chosen here, so
// the writer puts the words into the element as they are.
const source=[...functions('page-core.js',['kinWrite','kinSay']),...functions('study-info-panel.js',['studyReceiptGap','renderObservation','requestGatewayRetry'])].join('\n');
class Element {
 constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.hidden=false;this.textContent='';this.events={};}
 append(...items){for(const item of items)if(typeof item==='object'){item.parent=this;this.children.push(item);}}
 replaceChildren(...items){this.children=[];this.append(...items);}
 setAttribute(name,value){this[name]=String(value);}
 addEventListener(type,handler){this.events[type]=handler;}
 querySelectorAll(selector){return this.children.flatMap(child=>[...(selector==='button'&&child.tag==='button'||selector==='.exam-original-receipts'&&child.className==='exam-original-receipts'?[child]:[]),...child.querySelectorAll(selector)]);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 get nextElementSibling(){return this.parent.children[this.parent.children.indexOf(this)+1];}
}
function harness(){
 const nodes=new Map(),receipt=(phase,seq)=>({phase,epoch:'00000000-0000-4000-8000-000000000001',agentSeq:seq,successCount:1,localCount:2,attempt:1,errorCode:phase==='retry'?'CONNECT_FAILED':null,serverReceivedAt:'2026-01-01T00:00:00Z'});
 let row={uid:'1.2',examScope:{reportUid:'1.2',groupId:'group',generation:'first',sources:[{studyUid:'1.2',series:{mode:'all',uids:[]}},{studyUid:'1.3',series:{mode:'all',uids:[]}}]},sourceMetadata:[{uid:'1.2',gatewayReceipt:receipt('complete',1)},{uid:'1.3',gatewayReceipt:receipt('retry',2)}]};
 let finish;const requests=[];
 const context={window:{},KinExamScope:model,KinStudyArrivals:arrivals,studyObservationModel:arrivals.observationStart(),viewed:()=>row,
  $:id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);},document:{createElement:tag=>new Element(tag)},
  serverMode:true,offline:false,demoMode:false,KinAuth:{has:()=>true},gatewayRetryRequestSeq:0,
  work:{capture:()=>1,commit:(_at,fn)=>fn()},api:(...args)=>{requests.push(args);return new Promise(resolve=>finish=resolve);}};
 vm.createContext(context);vm.runInContext(source,context);
 return {context,requests,render:()=>context.renderObservation(),line:uid=>nodes.get('#study-receipt').querySelector('.exam-original-receipts').children.find(n=>n.dataset.uid===uid),
  finish:answer=>finish(answer),setRow:value=>{row=value;},row,receipt};
}
test('each original displays its own retry action; repaint retains its pending request and response',async()=>{
 const h=harness();h.render();assert.equal(h.requests.length,0);assert(h.line('1.2').children[1].hidden);
 // A merged exam draws no missing-images line of its own (its originals are separate studies).
 assert.equal(h.context.$('#receipt-gap').hidden,true);assert.equal(h.context.$('#receipt-gap').textContent,'');
 const button=h.line('1.3').children[1];assert.equal(button.hidden,false);const pending=button.events.click({currentTarget:button});
 assert.equal(h.requests[0][1],'/studies/1.3/gateway-retry');h.render();assert.equal(h.line('1.3').children[1],button);assert(button.disabled);
 h.finish({result:'requested',studyUid:'1.3',requestedAt:'2026-01-01T00:00:00Z'});await pending;
 assert.equal(h.requests.length,1);assert(button.hidden);assert.match(button.nextElementSibling.textContent,/Retry Requested/);
});
test('changing the exam or receipt drops an old retry answer without touching the new original control',async()=>{
 const h=harness();h.render();const old=h.line('1.3').children[1],pending=old.events.click({currentTarget:old});
 h.setRow({...h.row,examScope:{...h.row.examScope,generation:'second'}});h.render();const current=h.line('1.3').children[1];assert.notEqual(current,old);assert.equal(old.dataset.request,'');
 h.finish({result:'requested',studyUid:'1.3',requestedAt:'2026-01-01T00:00:00Z'});await pending;assert.equal(current.nextElementSibling.textContent,'');assert.equal(current.hidden,false);
 h.row.sourceMetadata[1].gatewayReceipt=h.receipt('failed',3);h.render();assert.equal(current.hidden,true);
});
