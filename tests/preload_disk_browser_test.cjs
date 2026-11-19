/* REQ-MG-PRELOAD-CACHE -> R1/R2/R3/R4/R5/R9/R15/R16/R17.
 * Real SharedWorker, WebCrypto and IndexedDB in Chromium, synthetic loopback HTTP only.
 * This is not an OHIF/ledger/clinical served-stack test. No LiveStack, Docker or source data. */
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const {randomBytes} = require('node:crypto'), {gzipSync} = require('node:zlib');
const {chromium} = require('playwright');
const root = path.resolve(__dirname,'..'), uid='1.2.840.99.1';
const framePath = `/dicom-web/studies/${uid}/series/2/instances/3/frames/1`;
const dump = async page => page.evaluate(async()=>{
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('kin-preload',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const out={stores:[...db.objectStoreNames],frames:[],studies:[]};
  for(const name of out.stores) out[name]=await new Promise((resolve,reject)=>{
    const r=db.transaction(name).objectStore(name).getAll();r.onsuccess=()=>resolve(r.result.map(v=>({...v,ct:[...new Uint8Array(v.ct)],iv:[...v.iv]})));r.onerror=()=>reject(r.error);
  });db.close();return out;
});
test('R1 R2 R3 R4 R5 R9 R15 R16 real encrypted storage, persistent profile, corruption deletion and expiry', {timeout:120000}, async t=>{
  const key=randomBytes(32), otherKey=randomBytes(32), requests=[];
  let clock=Date.now(), owner='A';
  const frames = [
    ['application/octet-stream', '1.2.840.10008.1.2.1'],
    ['image/jpeg', '1.2.840.10008.1.2.4.50'],
    ['image/jls', '1.2.840.10008.1.2.4.80'],
    ['image/jp2', '1.2.840.10008.1.2.4.90'],
    ['image/dicom-rle', '1.2.840.10008.1.2.5'],
  ].flatMap(([media, syntax]) => [true, false].map(gzip => {
    const type = `${media}; transfer-syntax=${syntax}`;
    const plain = Buffer.concat([Buffer.from(`--body\r\nContent-Type: ${type}\r\n\r\n`), randomBytes(128*1024), Buffer.from('\r\n--body--\r\n')]);
    return { plain, body: gzip ? gzipSync(plain) : plain, gzip, partType: `multipart/related; type="${type}"; boundary=body` };
  }));
  const server=http.createServer((req,res)=>{
    requests.push({url:req.url,store:req.headers['x-kin-preload'],session:req.headers['x-kin-session']});
    res.setHeader('Date',new Date(clock).toUTCString());res.setHeader('Cache-Control','no-store');
    if(req.url==='/api/preload/cache-key') {res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({keyId:owner,key:(owner==='A'?key:otherKey).toString('base64'),serverTime:new Date(clock).toISOString()}));}
    if(req.url==='/api/me')return res.end(JSON.stringify({preloadDiskGb:0.1}));
    if(req.url.endsWith('/metadata'))return res.end(JSON.stringify([{'0020000E':{Value:['2']},'00080018':{Value:['3']},'00280008':{Value:[frames.length]},'7FE00010':{BulkDataURI:'not-stored'}}]));
    if(req.url.startsWith('/dicom-web/')) {
      const frame = frames[Number(req.url.split('/').at(-1)) - 1];
      res.setHeader('Content-Type', frame.gzip ? 'application/gzip' : frame.partType);
      if(frame.gzip)res.setHeader('X-KIN-Part-Type',frame.partType);
      res.setHeader('X-KIN-Study-Revision','rev');res.setHeader('Content-Length',frame.body.length);return res.end(frame.body);
    }
    const name=path.posix.basename(req.url);
    if(['preload-worker.js','preload-store.js','preload-disk.js','preload-queue.js','session-transport.js'].includes(name)){res.setHeader('Content-Type','application/javascript; charset=utf-8');return res.end(fs.readFileSync(path.join(root,'worklist-v0/hpacs-lite',name)));}
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><title>Synthetic retention test</title><div id="panel"></div>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`,profile=fs.mkdtempSync(path.join(root,'tmp','retention-browser-'));
  let context; t.after(async()=>{await context?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  async function connect(session) {
    context=await chromium.launchPersistentContext(profile,{headless:true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})});
    const page=await context.newPage();page.setDefaultTimeout(20000);await page.goto(origin);
    await page.evaluate(session=>{
      window.messages=[];window.worker=new SharedWorker('/worklist/hpacs-lite/preload-worker.js',{name:'kin-preload'});
      worker.port.onmessage=e=>messages.push(e.data);worker.onerror=e=>messages.push({error:e.message});worker.port.start();
      window.ask=data=>new Promise(resolve=>{const id=Math.random();const fn=e=>{if(e.data.id===id){worker.port.removeEventListener('message',fn);resolve(e.data);}};worker.port.addEventListener('message',fn);worker.port.postMessage({...data,id});});
      worker.port.postMessage({type:'hello',role:'list'});worker.port.postMessage({type:'session',session});
    },session);return page;
  }
  let page=await connect('session-A');
  await page.evaluate(uid=>worker.port.postMessage({type:'add',session:'session-A',studies:[{uid,label:'SYN-123 · Synthetic^Patient'}]}),uid);
  await page.waitForFunction(()=>messages.at(-1)?.studies?.some(s=>s.status==='Ready')).catch(async error=>{console.log('worker messages',await page.evaluate(()=>messages));throw error;});
  const stored=await dump(page);assert.deepEqual(stored.stores,['frames','studies']);assert.equal(stored.frames.length,frames.length);
  async function checkFrames(page, session) {
    const held = (await page.evaluate(({uid,session})=>ask({type:'query',uid,session}),{uid,session})).held;
    assert.ok(held);
    for (const [index, frame] of frames.entries()) {
      const answer = await page.evaluate(async ({path, session, copy}) => {
        const result = await ask({type:'frame',path,session,copy});
        return {bytes:result.bytes ? [...new Uint8Array(result.bytes)] : null,partType:result.partType};
      }, {path:framePath.replace(/1$/,String(index+1)),session,copy:held.copy});
      assert.equal(answer.partType,frame.partType);
      assert.deepEqual(Buffer.from(answer.bytes),frame.plain);
    }
    return held;
  }
  await checkFrames(page,'session-A');
  // The shipped status panel shows the fixed server-Date expiry, without adding a reading prompt.
  await page.addScriptTag({url:origin+'/worklist/hpacs-lite/preload-queue.js'});
  await page.evaluate(()=>KinPreloadQueue.mount(document.getElementById('panel')));
  await page.waitForFunction(()=>document.querySelector('#preload-panel')?.textContent.includes('Ready'));
  const expiry=Date.parse(new Date(clock).toUTCString())+72*3600000;
  assert.ok(stored.frames.every(r=>r.expiresAt===expiry));
  const rendered=await page.evaluate(expiry=>({text:document.querySelector('#preload-panel').textContent,expected:new Date(expiry).toLocaleString()+'까지'}),expiry);
  assert.ok(rendered.text.includes(rendered.expected),JSON.stringify(rendered));
  for(const r of stored.frames)assert.deepEqual(Object.keys(r).sort(),['entryId','keyId','expiresAt','bytes','iv','ct'].sort());
  for(const r of stored.studies)assert.deepEqual(Object.keys(r).sort(),['manifestId','keyId','expiresAt','frameIds','iv','ct'].sort());
  // A study record lists its frames' random IDs in clear (B39: its frames live as long as it does), nothing of the study.
  for(const r of stored.studies)assert.deepEqual([...r.frameIds].sort(),stored.frames.map(f=>f.entryId).sort());
  for(const r of [...stored.frames,...stored.studies]){
    const clear=JSON.stringify({...r,ct:undefined,iv:undefined});for(const secret of [uid,'SYN-123','Synthetic^Patient','session-A',key.toString('base64')])assert.equal(clear.includes(secret),false);
    assert.equal(Buffer.from(r.ct).includes(key),false);
  }
  const storage=await page.evaluate(async()=>{
    const opfs=[];for await(const [name] of (await navigator.storage.getDirectory()).entries())opfs.push(name);
    return {local:{...localStorage},session:{...sessionStorage},name:window.name,caches:await caches.keys(),opfs};
  });assert.deepEqual(storage,{local:{},session:{},name:'',caches:[],opfs:[]});
  const cantGunzip=await page.evaluate(async ct=>{
    try{await new Response(new Blob([new Uint8Array(ct)]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();return false;}catch{return true;}
  },stored.frames[0].ct);assert.equal(cantGunzip,true);
  await context.close();context=null;
  owner='B';page=await connect('session-B');
  assert.equal((await page.evaluate(uid=>ask({type:'query',uid,session:'session-B'}),uid)).held,null);
  assert.equal((await dump(page)).frames.length,frames.length);
  await context.close();context=null;
  owner='A';const before=requests.filter(r=>r.store==='store').length;page=await connect('session-A2');
  const held=await checkFrames(page,'session-A2');
  assert.equal(requests.filter(r=>r.store==='store').length,before);
  const usageBefore=await page.evaluate(async()=> (await navigator.storage.estimate()).usage);
  const baseline=await page.evaluate(async()=> (await navigator.storage.estimate()).usage);
  await page.evaluate(async id=>{
    const db=await new Promise(resolve=>{const r=indexedDB.open('kin-preload');r.onsuccess=()=>resolve(r.result);});
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(['frames','studies'],'readwrite');
      // Matched control: rewrite the same number and size of records without deleting any.
      for(const name of ['frames','studies']) {
        const r=tx.objectStore(name).openCursor();r.onsuccess=()=>{const c=r.result;if(!c)return;
          const v=c.value;if(v.entryId===id)new Uint8Array(v.ct)[0]^=1;c.update(v);c.continue();};
      }
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
    });db.close();
  },stored.frames.find(r=>r.entryId===stored.frames[0].entryId).entryId);
  // Same-size rewrite, no deletion: measure the browser's accounting movement for the control operation.
  const noDelete=await page.evaluate(async()=> (await navigator.storage.estimate()).usage);
  // Read every frame: UUID index ordering need not be download order.
  for(let n=1;n<=frames.length;n++)await page.evaluate(({p,copy})=>ask({type:'frame',path:p,session:'session-A2',copy}),{p:framePath.replace(/1$/,String(n)),copy:held.copy});
  const cleared=await dump(page);assert.equal(cleared.frames.length+cleared.studies.length,0);
  const usageAfter=await page.evaluate(async()=> (await navigator.storage.estimate()).usage);
  const released=[...stored.frames,...stored.studies].reduce((n,r)=>n+r.ct.length,0),slack=Math.max(Math.abs(usageBefore-baseline),Math.abs(noDelete-baseline));
  console.log(JSON.stringify({measurement:'R16-headless-synthetic',usageBefore,baseline,noDelete,usageAfter,released,slack}));
  assert.ok(noDelete-usageAfter+slack>=released,JSON.stringify({baseline,noDelete,usageAfter,released,slack}));
  await page.evaluate(uid=>worker.port.postMessage({type:'retry',uid}),uid);
  await page.waitForFunction(()=>messages.at(-1)?.studies?.some(s=>s.status==='Ready'));
  await context.close();context=null;clock+=73*3600000;
  page=await connect('session-A3');assert.equal((await page.evaluate(uid=>ask({type:'query',uid,session:'session-A3'}),uid)).held,null);
  const expired=await dump(page);assert.equal(expired.frames.length+expired.studies.length,0);
});

// B39 on the real SharedWorker, IndexedDB and panel, through the shipped viewer code (viewer-preload.js): two studies
// received at server hour 0; at hour 24 a viewer window reads the first one (its live check confirms the held copy - the
// use) and is left. Started again at hour 73, the unopened one is gone and the opened one is Ready until hour 96 - its
// record says so, its frames (their own date passed) still decrypt, and the panel shows that date. At hour 96 nothing of
// it is served or kept. Synthetic loopback HTTP only.
test('B39 only the unused copy goes: the copy a viewer used counts from its use, on real storage and the shipped panel', {timeout:180000}, async t=>{
  const key=randomBytes(32), keyId='key-'+randomBytes(4).toString('hex'), H=3600000, ids=['1.2.840.99.11','1.2.840.99.12'];
  const PART='multipart/related; type="application/octet-stream"; boundary=body';
  let clock=Date.parse('2026-11-02T00:00:00Z');
  const start=clock, payload=p=>Buffer.concat([Buffer.from('--body\r\nContent-Type: application/octet-stream\r\n\r\n'),Buffer.from('frame '+p),Buffer.from('\r\n--body--\r\n')]);
  const checks=[];
  const server=http.createServer((req,res)=>{
    res.setHeader('Date',new Date(clock).toUTCString());res.setHeader('Cache-Control','no-store');
    if(req.url==='/api/preload/cache-key'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({keyId,key:key.toString('base64'),serverTime:new Date(clock).toISOString()}));}
    if(req.url==='/api/me')return res.end(JSON.stringify({preloadDiskGb:0.1}));
    if(req.url.endsWith('/metadata'))return res.end(JSON.stringify([{'0020000E':{Value:['2']},'00080018':{Value:['3']},'00280008':{Value:[2]},'7FE00010':{BulkDataURI:'x'}}]));
    if(req.url.startsWith('/dicom-web/')){
      if(req.headers['x-kin-preload']==='check')checks.push({url:req.url,session:req.headers['x-kin-session'],opening:req.headers['x-kin-view-opening']});
      const body=payload(req.url);res.setHeader('Content-Type',PART);
      res.setHeader('X-KIN-Study-Revision','rev');res.setHeader('Content-Length',body.length);return res.end(body);}
    const name=path.posix.basename(req.url);
    if(['preload-worker.js','preload-store.js','preload-disk.js','preload-queue.js','session-transport.js','viewer-preload.js'].includes(name)){res.setHeader('Content-Type','application/javascript; charset=utf-8');return res.end(fs.readFileSync(path.join(root,'worklist-v0/hpacs-lite',name)));}
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><title>Synthetic retention test</title><div id="panel"></div>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`,profile=fs.mkdtempSync(path.join(root,'tmp','retention-b39-'));
  let context; t.after(async()=>{await context?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  async function connect(){
    context=await chromium.launchPersistentContext(profile,{headless:true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})});
    const page=await context.newPage();page.setDefaultTimeout(20000);await page.goto(origin);
    await page.evaluate(()=>{
      window.messages=[];const w=new SharedWorker('/worklist/hpacs-lite/preload-worker.js',{name:'kin-preload'});w.port.start();
      window.list=w.port;list.onmessage=e=>messages.push(e.data);list.postMessage({type:'hello',role:'list'});list.postMessage({type:'session',session:'sess-1'});
      window.ask=data=>new Promise(resolve=>{const id=Math.random();const fn=e=>{if(e.data.id===id){list.removeEventListener('message',fn);resolve(e.data);}};list.addEventListener('message',fn);list.postMessage({...data,id});});
    });
    return page;
  }
  const row=async(page,uid)=>(await page.evaluate(()=>messages.at(-1)?.studies||[])).find(s=>s.uid===uid);
  const framePath=(uid,n)=>`/dicom-web/studies/${uid}/series/2/instances/3/frames/${n}`;
  let page=await connect();
  await page.evaluate(ids=>list.postMessage({type:'add',session:'sess-1',studies:ids.map(uid=>({uid,label:'SYN-B39 · Synthetic^Patient'}))}),ids);
  await page.waitForFunction(ids=>ids.every(uid=>messages.at(-1)?.studies?.some(s=>s.uid===uid&&s.status==='Ready')),ids);
  await context.close();context=null;
  // Hour 24: a viewer window (the shipped viewer-preload.js under a bound fetch) reads the first study, then is left.
  clock=start+24*H;page=await connect();
  await page.waitForFunction(ids=>ids.every(uid=>messages.at(-1)?.studies?.some(s=>s.uid===uid&&s.status==='Ready')),ids);
  const viewer=await context.newPage();viewer.setDefaultTimeout(20000);await viewer.goto(origin+'/viewer');
  await viewer.addScriptTag({url:origin+'/worklist/hpacs-lite/session-transport.js'});
  await viewer.addScriptTag({url:origin+'/worklist/hpacs-lite/viewer-preload.js'});
  const texts=await viewer.evaluate(async({paths,PART})=>{
    const read=KinViewerPreload.attach(window,(url,init)=>fetch(url,init));
    const out=[];for(const p of paths){const r=await read(p,{headers:{'X-KIN-Session':'sess-1',Accept:PART}});out.push(await r.text());}return out;
  },{paths:[framePath(ids[0],1),framePath(ids[0],2)],PART});
  assert.equal(checks.length,1,'one live check of the held copy');assert.ok(checks[0].opening&&checks[0].session==='sess-1');
  assert.ok(texts[1].includes('frame '+framePath(ids[0],2)),'the second frame from the held copy');
  await page.waitForFunction(({uid,at})=>messages.at(-1)?.studies?.some(s=>s.uid===uid&&s.expiresAt===at&&s.open),{uid:ids[0],at:start+96*H});
  await viewer.goto(origin+'/away');                                // the window is left: pagehide says bye
  await page.waitForFunction(uid=>messages.at(-1)?.studies?.some(s=>s.uid===uid&&!s.open),ids[0]);
  assert.equal((await row(page,ids[0])).expiresAt,start+96*H);
  assert.equal((await row(page,ids[1])).expiresAt,start+72*H);
  await context.close();context=null;
  // Hour 73: only the unopened copy went.
  clock=start+73*H;page=await connect();
  await page.waitForFunction(ids=>{const s=messages.at(-1)?.studies||[];return s.some(r=>r.uid===ids[1]&&r.status==='Evicted')&&s.some(r=>r.uid===ids[0]&&r.status==='Ready');},ids);
  assert.match((await row(page,ids[1])).reason,/마지막으로 본 뒤 72시간이 지나 자동으로 지웠습니다/);
  assert.equal((await row(page,ids[0])).expiresAt,start+96*H);
  const kept=await dump(page);
  assert.deepEqual(kept.studies.map(r=>r.expiresAt),[start+96*H],'one record left: the opened copy, until hour 96');
  assert.ok(kept.frames.length===2&&kept.frames.every(f=>f.expiresAt===start+72*H&&kept.studies[0].frameIds.includes(f.entryId)),'its frames, past their own date, kept by its record');
  const again=(await page.evaluate(uid=>ask({type:'query',uid,session:'sess-1'}),ids[0])).held;
  for(const n of [1,2]){
    const p=framePath(ids[0],n);
    const bytes=(await page.evaluate(async({p,copy})=>{const r=await ask({type:'frame',path:p,session:'sess-1',copy});return r.bytes?[...new Uint8Array(r.bytes)]:null;},{p,copy:again.copy}));
    assert.deepEqual(Buffer.from(bytes),payload(p));
  }
  await page.addScriptTag({url:origin+'/worklist/hpacs-lite/preload-queue.js'});
  await page.evaluate(()=>KinPreloadQueue.mount(document.getElementById('panel')));
  await page.waitForFunction(()=>document.querySelector('#preload-panel')?.textContent.includes('Ready'));
  const shown=await page.evaluate(at=>({text:document.querySelector('#preload-panel').textContent,expected:new Date(at).toLocaleString()+'까지'}),start+96*H);
  assert.ok(shown.text.includes(shown.expected),JSON.stringify(shown));
  await context.close();context=null;
  // Hour 96: the opened copy is no longer served, and nothing of it is kept.
  clock=start+96*H;page=await connect();
  assert.equal((await page.evaluate(uid=>ask({type:'query',uid,session:'sess-1'}),ids[0])).held,null);
  const gone=await dump(page);assert.equal(gone.frames.length+gone.studies.length,0);
});
