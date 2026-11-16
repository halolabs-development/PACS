const test=require('node:test');
const assert=require('node:assert/strict');
const removal=require('../worklist-v0/hpacs-lite/volume-rendering-removal.js');

// Synthetic CT (no patient data): fat-density body, an air pocket (lung), a vertebra with a dense cortex, a contrast
// aorta with a small calcification and a thin table plate below the body. Rows grow towards the patient's back.
const DIMS=[96,96,40],SPACING=[1,1,2];
function phantom({bridge=false,block=false,touch=false}={}){
  const [nx,ny,nz]=DIMS,hu=new Float32Array(nx*ny*nz).fill(-1000),label=new Uint8Array(hu.length);
  const aorta=bridge?[62,54]:[62,42];
  for(let z=0;z<nz;z++)for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){
    const i=x+nx*(y+ny*z);let v=-1000,l=0;
    if(((x-48)/34)**2+((y-40)/24)**2<=1){v=-100;l=1;}
    if(((x-30)/8)**2+((y-36)/10)**2<=1){v=-850;l=2;}
    const spine=Math.hypot(x-48,y-54);if(spine<=7){v=spine>5?1000:300;l=3;}
    if(Math.hypot(x-aorta[0],y-aorta[1])<=4){v=350;l=4;}
    if(bridge&&y===54&&x>=55&&x<=58&&l!==3&&l!==4){v=300;l=6;}
    if(!bridge&&z===20&&x>=64&&x<=65&&y>=40&&y<=41){v=900;l=4;}
    const top=touch?64:70;if(y>=top&&y<=top+1&&x>=6&&x<=89&&l===0){v=300;l=5;}
    if(block&&x>=2&&x<=21&&y>=76&&y<=95){v=40;l=7;}
    if(block&&x>=80&&x<=87&&y>=80&&y<=87&&z>=10&&z<=13){v=40;l=8;}
    if(block&&y===8&&x>=20&&x<=76&&l===0){v=-200;l=9;}
    hu[i]=v;label[i]=l;
  }
  return {hu,label};
}
function apply(src,{bone=null,table=false,maxCells}={}){
  const p=removal.plan(DIMS,SPACING,maxCells),pooled=removal.run(removal.pool(src,p));
  const parts={bone:bone===null?null:removal.run(removal.boneCells(pooled,p,bone)),table:table?removal.run(removal.tableCells(pooled,p)):null};
  const out=new Float32Array(src.length),floor=removal.floorFor(pooled.min),removed=removal.run(removal.paint(src,out,p,parts,floor));
  return {p,parts,out,floor,removed};
}
function share(out,label,l,floor){let total=0,gone=0;for(let i=0;i<out.length;i++)if(label[i]===l){total++;if(out[i]===floor)gone++;}return gone/total;}

test('grid is the smallest whole reduction under the cell limit',()=>{
  assert.deepEqual(removal.plan(DIMS,SPACING).cells,DIMS);
  const p=removal.plan([512,512,300],[.7,.7,1]);
  assert.equal(p.factor,2);assert.deepEqual(p.cells,[256,256,150]);assert.ok(Math.abs(p.cellMl-.7*.7*8/1000)<1e-12);
  assert.equal(removal.plan([5,5,5],[1,1,1],8).factor,3);
  for(const bad of [[[0,1,1],[1,1,1]],[[1,1],[1,1,1]],[[1,1,1],[1,0,1]],[[1.5,1,1],[1,1,1]]])assert.throws(()=>removal.plan(...bad));
});

test('bone threshold accepts 100 to 3000 HU',()=>{
  assert.equal(removal.validateThreshold('250'),250);assert.equal(removal.validateThreshold(3000),3000);
  for(const bad of ['', ' ', '99', '3001', 'x', NaN, null])assert.throws(()=>removal.validateThreshold(bad),/Bone Threshold/);
});

test('remove bone takes the vertebra and keeps contrast vessel, calcification, table and soft tissue',()=>{
  const {hu,label}=phantom(),copy=hu.slice(),{out,floor,removed}=apply(hu,{bone:250});
  assert.deepEqual(hu,copy,'source unchanged');
  assert.equal(share(out,label,3,floor),1,'vertebra');
  assert.equal(share(out,label,4,floor),0,'aorta and calcification');
  assert.equal(share(out,label,5,floor),0,'table');
  assert.equal(share(out,label,1,floor),0,'body');
  assert.equal(share(out,label,2,floor),0,'air pocket');
  assert.ok(removed>0);
  for(let i=0;i<hu.length;i++)if(out[i]!==floor)assert.equal(out[i],hu[i]);
  assert.equal(floor,-1002);
});

test('a thin contact between vessel and bone does not take the vessel',()=>{
  const {hu,label}=phantom({bridge:true}),{out,floor}=apply(hu,{bone:250});
  assert.equal(share(out,label,3,floor),1);
  assert.ok(share(out,label,4,floor)<.1,'aorta mostly kept: '+share(out,label,4,floor));
});

test('a higher threshold keeps what lies under it',()=>{
  const {hu,label}=phantom(),{out,floor,parts}=apply(hu,{bone:1500});
  assert.equal(parts.bone.found,0);assert.equal(share(out,label,3,floor),0);
});

test('remove table takes separate thin pieces and keeps the body, its air pocket and separate thick parts',()=>{
  const {hu,label}=phantom({block:true}),{out,floor}=apply(hu,{table:true});
  assert.equal(share(out,label,5,floor),1,'table');assert.equal(share(out,label,9,floor),1,'sheet');
  for(const l of [1,2,3,4,7,8])assert.equal(share(out,label,l,floor),0,'label '+l);
  for(let i=0;i<hu.length;i++)if(label[i]===0&&out[i]===floor)assert.ok(hu[i]===-1000,'only air beside a removed piece');
});

test('a table touching the body is not removed (conservative)',()=>{
  const {hu,label}=phantom({touch:true}),{out,floor,parts}=apply(hu,{table:true});
  assert.equal(parts.table.cells,null);assert.equal(share(out,label,5,floor),0);
});

test('thick slices: a piece thicker than 3 mm along the slice axis stays, a plate thin in the slice plane goes',()=>{
  const dims=[48,48,8],spacing=[1,1,10],hu=new Float32Array(dims[0]*dims[1]*dims[2]).fill(-1000),label=new Uint8Array(hu.length);
  for(let z=0;z<dims[2];z++)for(let y=0;y<dims[1];y++)for(let x=0;x<dims[0];x++){
    const i=x+dims[0]*(y+dims[1]*z);
    if(z===3&&x>=4&&x<=23&&y>=4&&y<=23){hu[i]=40;label[i]=1;}
    if(y>=40&&y<=41&&x>=4&&x<=43){hu[i]=300;label[i]=2;}
  }
  for(const maxCells of [undefined,4000,300]){
    const p=removal.plan(dims,spacing,maxCells),pooled=removal.run(removal.pool(hu,p)),table=removal.run(removal.tableCells(pooled,p));
    const out=new Float32Array(hu.length),floor=removal.floorFor(pooled.min);removal.run(removal.paint(hu,out,p,{table},floor));
    assert.equal(share(out,label,1,floor),0,'10 mm piece, factor '+p.factor);
    if(p.factor<4)assert.equal(share(out,label,2,floor),1,'2 mm plate, factor '+p.factor);
    else assert.equal(table.cells,null,'cells thicker than 3 mm on every axis remove nothing');
  }
});

test('bone and table together',()=>{
  const {hu,label}=phantom(),{out,floor}=apply(hu,{bone:250,table:true});
  assert.equal(share(out,label,3,floor),1);assert.equal(share(out,label,5,floor),1);
  for(const l of [1,2,4])assert.equal(share(out,label,l,floor),0,'label '+l);
});

test('the reduced grid gives the same result on a large volume',()=>{
  const {hu,label}=phantom(),{p,out,floor}=apply(hu,{bone:250,table:true,maxCells:50000});
  assert.equal(p.factor,2);
  assert.ok(share(out,label,3,floor)>.95,'vertebra '+share(out,label,3,floor));
  assert.equal(share(out,label,5,floor),1);
  assert.ok(share(out,label,4,floor)<.1,'aorta '+share(out,label,4,floor));
  assert.equal(share(out,label,1,floor),0);assert.equal(share(out,label,2,floor),0);
});

test('no body and no bone are reported, not removed',()=>{
  const air=new Float32Array(DIMS[0]*DIMS[1]*DIMS[2]).fill(-1000),p=removal.plan(DIMS,SPACING),pooled=removal.run(removal.pool(air,p));
  assert.equal(removal.run(removal.tableCells(pooled,p)).cells,null);
  assert.equal(removal.run(removal.boneCells(pooled,p,250)).cells,null);
});

test('work yields between steps and checks its arrays',()=>{
  const {hu}=phantom(),p=removal.plan(DIMS,SPACING);let steps=0;const generator=removal.pool(hu,p);
  for(let next=generator.next();!next.done;next=generator.next())steps++;
  assert.ok(steps>=DIMS[2]);
  assert.throws(()=>removal.run(removal.pool(new Float32Array(10),p)),/화소 수/);
  assert.throws(()=>removal.run(removal.paint(hu,new Float32Array(10),p,{},-1025)),/결과 배열/);
  assert.equal(removal.floorFor(-3024),-3026);assert.equal(removal.floorFor(500),498);assert.equal(removal.floorFor(-1000.5),-1003);assert.throws(()=>removal.floorFor(NaN));
  assert.ok(Object.isFrozen(removal)&&Object.isFrozen(removal.LIMITS));
});
