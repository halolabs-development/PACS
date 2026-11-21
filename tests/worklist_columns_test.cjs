const {test}=require('node:test');
const assert=require('node:assert/strict');
const model=require('../worklist-v0/hpacs-lite/worklist-columns.js');
const columns={Radiology:[{k:'id'},{k:'name'},{k:'date'},{k:'desc'}],Technician:[{k:'id'},{k:'name'},{k:'ward'}]};
test('server refuses deferred physician columns; a legacy document gains Hospital at the end and the request columns at their anchors',()=>{
  require('./service_test_loader.cjs');
  const { normalizeWorklistColumns } = require('/app/dist/worklist-columns');
  const vectors = require('./worklist_columns_vectors.json');
  const legacy = vectors.accepted.find(v=>v.id==='V02');
  for (const key of ['referringPhysician','requestingPhysician']) {
    const value = structuredClone(legacy.document);
    value.modes.Radiology.order.push(key);
    assert.equal(normalizeWorklistColumns(value), null, key+' is not in the shipped catalogue');
  }
  const saved = normalizeWorklistColumns(structuredClone(legacy.document));
  assert.deepEqual(saved, legacy.expect);
  assert.deepEqual(saved.modes.Radiology.order, [...legacy.document.modes.Radiology.order.flatMap(k => k === 'name'
    ? ['name', 'reqDate', 'reqDept', 'reqDoc', 'ptClass'] : k === 'rs' ? ['rs', 'confirm', 'readReq'] : k === 'date' ? ['date', 'referredAt'] : [k]),
    'institutionName', 'time']);
});
test('defaults and mode-specific ordering do not mutate the column schema',()=>{
  const state=model.defaults(columns); state.modes.Radiology.order.reverse();state.modes.Radiology.hidden=['desc'];
  const clean=model.normalize(state,columns);
  assert.deepEqual(model.visible(columns,clean,'Radiology').map(c=>c.k),['name','id','date']);
  assert.deepEqual(model.visible(columns,clean,'Technician').map(c=>c.k),['id','name','ward']);
  assert.deepEqual(columns.Radiology.map(c=>c.k),['id','name','date','desc']);
});
test('invalid, duplicate, unknown and required hidden fields reject as a whole',()=>{
  for(const invalid of [null,[],{}, {version:99,modes:{}}]) assert.equal(model.normalize(invalid,columns),null);
  for(const [key,list] of [['order',['id','id']],['hidden',['name']],['hidden',['id']],['hidden',['constructor']],['order',[1]],['hidden',Array(65).fill('desc')]]){
    const state=model.defaults(columns);state.modes.Radiology[key]=list;assert.equal(model.normalize(state,columns),null);
  }
  const extra=model.defaults(columns);extra.modes.Radiology.patientId='secret';assert.equal(model.normalize(extra,columns),null);
});
test('new columns append visible without disturbing earlier order',()=>{
  const state=model.defaults(columns);state.modes.Radiology.order=['name','id'];state.modes.Radiology.hidden=['desc'];
  assert.deepEqual(model.normalize(state,columns).modes.Radiology,{order:['name','id','date','desc'],hidden:['desc']});
});
test('the page places a missing request column after Name and Confirm after RS, and keeps a placed one where the user put it',()=>{
  const catalog={Radiology:['no','rs','id','name','confirm','reqDate','reqDept','reqDoc','ptClass','age','desc'].map(k=>({k})),Technician:[{k:'id'},{k:'name'}]};
  const state=model.defaults(catalog);
  // New accounts open with the five shown, in the default order.
  assert.deepEqual(model.visible(catalog,state,'Radiology').map(c=>c.k),['no','rs','confirm','id','name','reqDate','reqDept','reqDoc','ptClass','age','desc']);
  state.modes.Radiology.order=['name','rs','age'];state.modes.Radiology.hidden=['age'];
  assert.deepEqual(model.normalize(state,catalog).modes.Radiology,
    {order:['name','reqDate','reqDept','reqDoc','ptClass','rs','confirm','age','no','id','desc'],hidden:['age']});
  state.modes.Radiology.order=['ptClass','name','rs'];state.modes.Radiology.hidden=['ptClass'];
  assert.deepEqual(model.normalize(state,catalog).modes.Radiology,
    {order:['ptClass','name','reqDate','reqDept','reqDoc','rs','confirm','no','id','age','desc'],hidden:['ptClass']});
});
test('the page places a missing Referred right after StudyDate, opens new accounts with it, and keeps a placed one',()=>{
  const catalog={Radiology:['no','rs','date','id','name','referredAt','age','desc'].map(k=>({k})),Technician:[{k:'id'},{k:'name'}]};
  const state=model.defaults(catalog);
  assert.deepEqual(model.visible(catalog,state,'Radiology').map(c=>c.k),['no','rs','date','referredAt','id','name','age','desc']);
  // A layout stored before the column: it joins after StudyDate wherever the user put StudyDate; the rest keeps its order.
  state.modes.Radiology.order=['name','date','rs'];state.modes.Radiology.hidden=['rs'];
  assert.deepEqual(model.normalize(state,catalog).modes.Radiology,{order:['name','date','referredAt','rs','no','id','age','desc'],hidden:['rs']});
  // Already placed and hidden by the user: it stays there, hidden.
  state.modes.Radiology.order=['referredAt','name','date'];state.modes.Radiology.hidden=['referredAt'];
  assert.deepEqual(model.normalize(state,catalog).modes.Radiology,{order:['referredAt','name','date','no','rs','id','age','desc'],hidden:['referredAt']});
});
test('the page places a missing Read Req right after Confirm, opens new accounts with it, and keeps a placed one (server alike)',()=>{
  const catalog={Radiology:['no','rs','confirm','readReq','date','id','name','age'].map(k=>({k})),Technician:[{k:'id'},{k:'name'}]};
  const state=model.defaults(catalog);
  assert.deepEqual(model.visible(catalog,state,'Radiology').map(c=>c.k),['no','rs','confirm','readReq','date','id','name','age']);
  // A layout stored before the column: it joins after Confirm (Confirm itself after RS); the rest keeps its order.
  state.modes.Radiology.order=['name','rs','date'];state.modes.Radiology.hidden=['date'];
  assert.deepEqual(model.normalize(state,catalog).modes.Radiology,{order:['name','rs','confirm','readReq','date','no','id','age'],hidden:['date']});
  // Already placed and hidden by the user: it stays there, hidden.
  state.modes.Radiology.order=['readReq','name','rs','confirm'];state.modes.Radiology.hidden=['readReq'];
  assert.deepEqual(model.normalize(state,catalog).modes.Radiology,{order:['readReq','name','rs','confirm','no','date','id','age'],hidden:['readReq']});
  // The server's normalizer places it the same way in a stored document that lacks it.
  require('./service_test_loader.cjs');
  const { normalizeWorklistColumns } = require('/app/dist/worklist-columns');
  const vectors = require('./worklist_columns_vectors.json');
  const legacy = structuredClone(vectors.accepted.find(v=>v.id==='V02').document);
  const order = normalizeWorklistColumns(legacy).modes.Radiology.order;
  assert.equal(order[order.indexOf('confirm') + 1], 'readReq');
  assert.equal(order[order.indexOf('rs') + 1], 'confirm');
});test('immutable subject and institution partition browser storage; no demo or anonymous key',()=>{
  const session={state:'approved',institution:'A',sub:'subject',user:'old-name'};
  assert.equal(model.key(session),model.key({...session,user:'new-name'}));
  assert.notEqual(model.key(session),model.key({...session,institution:'B'}));
  assert.notEqual(model.key(session),model.key({...session,sub:'other'}));
  for(const invalid of [null,{}, {...session,demo:true},{...session,state:'pending'},{...session,sub:''}])assert.equal(model.key(invalid),null);
});
test('appearance validates bounded display values without losing legacy modes',()=>{
  const state=model.defaults(columns);
  state.modes.Radiology.appearance={widths:{name:240},size:18,font:'mono',color:'warm'};
  assert.deepEqual(model.normalize(state,columns),state);
  for(const patch of [{size:9},{size:21},{size:13.5},{color:'#000000'},{color:['warm']},{font:'url(https://invalid)'},{widths:{name:63}},{widths:{name:601}},{widths:{name:null}},{widths:{name:'240'}},{widths:{patientId:240}}]){
    const bad=JSON.parse(JSON.stringify(state));Object.assign(bad.modes.Radiology.appearance,patch);
    assert.equal(model.normalize(bad,columns),null);
  }
});
// The smallest page mount() runs on: no worklist rows are rendered, so these cases see the saved state and the
// header re-render (changed) only.
function page(raw){
  const store=new Map(raw===undefined?[]:[['k',raw]]);
  const element=()=>{const found=new Map();return {style:{},dataset:{},classList:{toggle(){},add(){},remove(){},contains:()=>false},
    setAttribute(){},addEventListener(){},append(){},focus(){},close(){},showModal(){},
    querySelector:sel=>found.get(sel)||found.set(sel,element()).get(sel)};};
  const settings=element(),session={state:'approved',institution:'A',sub:'subject'},owner=model.key(session);
  if(raw!==undefined){store.set(owner,raw);store.delete('k');}
  Object.assign(globalThis,{document:{createElement:element,body:element(),head:element(),querySelector:()=>settings,querySelectorAll:()=>[]},
    window:{addEventListener(){}},KinSessionTransport:{page:()=>({})},
    KinWorkContext:{state:()=>'active',capture:()=>({}),commit:(_,f)=>f(),onInvalidate(){}}});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,v)}});
  const renders=[],controller=model.mount({columns,session,mode:()=>'Radiology',changed:()=>renders.push(1)});
  return {controller,renders,saved:()=>JSON.parse(store.get(owner)).modes.Radiology,raw:()=>store.get(owner)};
}
const dragged=()=>{const state=model.defaults(columns);state.modes.Radiology.hidden=['desc'];state.modes.Radiology.order=['name','id','date','desc'];
  state.modes.Radiology.appearance={widths:{name:150,id:90,date:80},font:'default',size:11,color:'default'};return JSON.stringify(state);};
test('a press on a column edge that never moved neither pins widths nor re-renders the header under the pointer',()=>{
  // Re-rendering the header on that release removed the edge before the click, so a double click never arrived.
  const x=page(dragged()),before=x.raw();
  x.controller.setWidths('Radiology',{name:150,id:90,date:80},true);
  x.controller.setWidths('Radiology',{name:150,id:90,date:80,desc:70},true);
  assert.deepEqual(x.renders,[]);
  assert.equal(x.raw(),before);
  assert.deepEqual(x.controller.widths('Radiology'),{name:150,id:90,date:80});
});
test('a drag saves the widths it showed, and a cancelled drag saves the widths it started from',()=>{
  const x=page(dragged());
  x.controller.setWidths('Radiology',{name:190,id:90,date:80},false);
  assert.deepEqual(x.renders,[]);
  x.controller.setWidths('Radiology',{name:190,id:90,date:80},true);
  assert.deepEqual(x.saved().appearance.widths,{name:190,id:90,date:80});
  assert.equal(x.renders.length,1);
  x.controller.setWidths('Radiology',{name:230,id:90,date:80},false);
  x.controller.setWidths('Radiology',{name:190,id:90,date:80},true);
  assert.deepEqual(x.saved().appearance.widths,{name:190,id:90,date:80});
  assert.equal(x.renders.length,2);
});
test('a double click on a column edge forgets only that column\'s width, and a reload keeps it automatic',()=>{
  const x=page(dragged()),before=x.saved();
  x.controller.setWidth('Radiology','name',null);
  const after=x.saved();
  assert.deepEqual(after.appearance.widths,{id:90,date:80});
  assert.deepEqual([after.order,after.hidden,after.appearance.size],[before.order,before.hidden,before.appearance.size]);
  assert.equal(x.renders.length,1);
  const reloaded=page(x.raw());
  assert.deepEqual(reloaded.controller.widths('Radiology'),{id:90,date:80});
  assert.deepEqual(reloaded.controller.columns('Radiology').map(c=>c.k),['name','id','date']);
});

test('QC Flag is a Technician column: it joins a stored Technician layout after Tech Note, a moved or hidden QC Flag stays, and Radiology is untouched (page and server alike)', () => {
  require('./service_test_loader.cjs');
  const { normalizeWorklistColumns, COLUMN_KEYS } = require('/app/dist/worklist-columns');
  assert.ok(COLUMN_KEYS.Technician.includes('qc') && !COLUMN_KEYS.Radiology.includes('qc'));
  const catalog = Object.fromEntries(Object.entries(COLUMN_KEYS).map(([mode, keys]) => [mode, keys.map(k => ({ k }))]));
  const radiology = { order: [...COLUMN_KEYS.Radiology].reverse(), hidden: ['age', 'birth'] };
  // A Technician layout saved before QC Flag existed: QC Flag goes right after Tech Note; the Radiology layout is kept exactly.
  const before = { version: 1, modes: { Radiology: structuredClone(radiology),
    Technician: { order: ['name', 'id', 'techNote', 'ss', 'ward'], hidden: ['ward'] } } };
  for (const normalized of [model.normalize(structuredClone(before), catalog), normalizeWorklistColumns(structuredClone(before))]) {
    assert.deepEqual(normalized.modes.Radiology, radiology);
    assert.deepEqual(normalized.modes.Technician.order.slice(0, 6), ['name', 'id', 'techNote', 'qc', 'ss', 'ward']);
    assert.deepEqual(normalized.modes.Technician.hidden, ['ward']);
  }
  // The person moved QC Flag first and hid it: kept as stored, in both normalizers; Radiology still as it was.
  const moved = { version: 1, modes: { Radiology: structuredClone(radiology),
    Technician: { order: ['qc', ...COLUMN_KEYS.Technician.filter(k => k !== 'qc')], hidden: ['qc'] } } };
  for (const normalized of [model.normalize(structuredClone(moved), catalog), normalizeWorklistColumns(structuredClone(moved))]) {
    assert.deepEqual(normalized.modes.Technician, moved.modes.Technician);
    assert.deepEqual(normalized.modes.Radiology, radiology);
  }
  // QC Flag is not a Radiology column: a Radiology layout naming it is refused whole.
  const wrong = structuredClone(before); wrong.modes.Radiology.order.push('qc');
  assert.equal(model.normalize(wrong, catalog), null);
  assert.equal(normalizeWorklistColumns(wrong), null);
});