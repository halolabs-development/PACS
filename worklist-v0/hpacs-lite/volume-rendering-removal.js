/* Bone and table removal masks for the volume rendering display. Pure: reads HU values, never edits them.
 * Work runs on a reduced grid (each cell holds the highest HU of its f*f*f voxels, at most 2^24 cells) and is written
 * as generators so the viewer can yield to the page and stop between steps. The viewer paints the masks into a private
 * copy shown only in its 3D view; the source volume and the MPR planes keep the original values.
 * Bone: cells at or above the threshold, eroded one cell to cut thin contacts, connected regions of at least 1 mL whose
 * surroundings are at least 5% dense bone (700 HU), grown back two cells inside the threshold and one cell for the rim;
 * at full resolution only voxels at or above min(threshold, 150 HU) inside those cells are removed. Contrast vessels and
 * small calcifications therefore stay unless they touch bone over more than a thin contact.
 * Table: every separate piece of tissue (-500 HU or more) that is thin everywhere - no cell deeper than 3 mm from the
 * outside air, enclosed air such as lungs not counting as outside - is removed with one cell of air around it (table top,
 * sheets, cables). The body, arms, thick pads and anything touching the body stay; other air is not touched.
 * Removed voxels get a value just under the source minimum; the viewer makes that value transparent. */
// The viewer write path (viewer-language.js): product words in the reader's screen language, or as written.
function kinText(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.text ? l.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinHtml(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.html ? l.html(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinError(t, ...p) { return Object.assign(new Error(kinText(t, ...p)), { kinWords: true }); }
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.KinVolumeRemoval=api;
})(typeof globalThis==='object'?globalThis:this,()=>{
  'use strict';
  const LIMITS=Object.freeze({maxCells:1<<24,boneThreshold:250,boneMin:100,boneMax:3000,denseHu:700,denseFraction:.05,boneMinMl:1,rimHu:150,bodyHu:-500,tableErodeMm:3});
  const BFS_YIELD=1<<16;

  function finitePositive(n){return typeof n==='number'&&Number.isFinite(n)&&n>0;}
  function plan(dimensions,spacing,maxCells=LIMITS.maxCells){
    if(!Array.isArray(dimensions)&&!ArrayBuffer.isView(dimensions)||dimensions.length!==3||!Array.from(dimensions).every(n=>Number.isInteger(n)&&n>0))throw kinError("VR 원본 크기를 확인할 수 없습니다.");
    if(!Array.isArray(spacing)&&!ArrayBuffer.isView(spacing)||spacing.length!==3||!Array.from(spacing).every(finitePositive))throw kinError("VR 원본 복셀 간격을 확인할 수 없습니다.");
    if(!Number.isInteger(maxCells)||maxCells<1)throw kinError("VR 지우기 격자 한도를 확인할 수 없습니다.");
    const dims=Array.from(dimensions),space=Array.from(spacing);let factor=1,cells;
    for(;;){cells=dims.map(n=>Math.ceil(n/factor));if(cells[0]*cells[1]*cells[2]<=maxCells)break;factor++;}
    return Object.freeze({dims:Object.freeze(dims),spacing:Object.freeze(space),factor,cells:Object.freeze(cells),count:cells[0]*cells[1]*cells[2],voxels:dims[0]*dims[1]*dims[2],cellMl:space[0]*space[1]*space[2]*factor**3/1000});
  }
  function checkSource(src,p){
    if(!p||!ArrayBuffer.isView(src)||src.length!==p.voxels)throw kinError("VR 원본 화소 수가 볼륨 크기와 다릅니다.");
  }
  function validateThreshold(value){
    const n=typeof value==='string'&&value.trim()!==''?Number(value):value;
    if(typeof n!=='number'||!Number.isFinite(n)||n<LIMITS.boneMin||n>LIMITS.boneMax)throw kinError("Bone Threshold를 {0}~{1} HU 범위로 입력하세요.", LIMITS.boneMin, LIMITS.boneMax);
    return n;
  }
  // Highest HU of each cell, and the lowest value of the whole source (removed voxels go below it).
  function* pool(src,p){
    checkSource(src,p);
    const [nx,ny,nz]=p.dims,[cx,cy]=p.cells,f=p.factor,values=new Float32Array(p.count).fill(-Infinity),dense=new Uint16Array(p.count),d=LIMITS.denseHu;let min=Infinity,max=-Infinity;
    for(let z=0;z<nz;z++){
      const cz=(z/f)|0;
      for(let y=0;y<ny;y++){
        const row=(z*ny+y)*nx,cell=(cz*cy+((y/f)|0))*cx;
        for(let x=0;x<nx;x++){const v=src[row+x],c=cell+((x/f)|0);if(v>values[c])values[c]=v;if(v<min)min=v;if(v>max)max=v;if(v>=d)dense[c]++;}
      }
      yield z/nz;
    }
    if(!Number.isFinite(min)||!Number.isFinite(max))throw kinError("VR 원본 화소 값을 확인할 수 없습니다.");
    return {values,dense,min,max};
  }
  // Source voxels in a cell (cells on the far edges hold fewer).
  function cellVoxels(p){
    const extent=axis=>{const n=p.dims[axis],f=p.factor;return Array.from({length:p.cells[axis]},(_,c)=>Math.min(f,n-c*f));};
    const [ex,ey,ez]=[0,1,2].map(extent);
    return i=>{const x=i%p.cells[0],y=((i/p.cells[0])|0)%p.cells[1],z=(i/(p.cells[0]*p.cells[1]))|0;return ex[x]*ey[y]*ez[z];};
  }
  const step=p=>[1,p.cells[0],p.cells[0]*p.cells[1]];
  // Cell kept only if it and its six neighbours are set; outside the volume counts as set (a cut field of view is not an edge).
  function* erode6(mask,p){
    const [cx,cy,cz]=p.cells,s=step(p),out=new Uint8Array(p.count);
    for(let z=0;z<cz;z++){
      for(let y=0;y<cy;y++)for(let x=0;x<cx;x++){
        const i=x+s[1]*y+s[2]*z;if(!mask[i])continue;
        out[i]=(x===0||mask[i-1])&&(x===cx-1||mask[i+1])&&(y===0||mask[i-s[1]])&&(y===cy-1||mask[i+s[1]])&&(z===0||mask[i-s[2]])&&(z===cz-1||mask[i+s[2]])?1:0;
      }
      yield;
    }
    return out;
  }
  // Grows seed by up to steps six-neighbour moves, only through cells set in limit (every cell when limit is null).
  function* reach(seed,p,limit,steps){
    const [cx,cy,cz]=p.cells,s=step(p),out=new Uint8Array(seed),distance=new Uint8Array(p.count),queue=new Int32Array(p.count);let head=0,tail=0,work=0;
    for(let i=0;i<p.count;i++)if(seed[i])queue[tail++]=i;
    while(head<tail){
      const i=queue[head++],d=distance[i];if(d>=steps)continue;
      const x=i%cx,y=((i/cx)|0)%cy,z=(i/s[2])|0;
      const visit=j=>{if(!out[j]&&(!limit||limit[j])){out[j]=1;distance[j]=d+1;queue[tail++]=j;}};
      if(x>0)visit(i-1);if(x<cx-1)visit(i+1);if(y>0)visit(i-s[1]);if(y<cy-1)visit(i+s[1]);if(z>0)visit(i-s[2]);if(z<cz-1)visit(i+s[2]);
      if(++work%BFS_YIELD===0)yield;
    }
    return out;
  }
  // Box erosion or dilation with a radius per axis, one axis at a time over each line of cells.
  function* box(mask,p,radii,dilate){
    let current=new Uint8Array(mask);
    const s=step(p);
    for(let axis=0;axis<3;axis++){
      const r=radii[axis];if(!r)continue;
      const n=p.cells[axis],others=[0,1,2].filter(a=>a!==axis),next=new Uint8Array(p.count),line=new Int32Array(n+1);
      for(let b=0;b<p.cells[others[1]];b++){
        for(let a=0;a<p.cells[others[0]];a++){
          const base=a*s[others[0]]+b*s[others[1]];
          // line[k] = cells among the first k that would block: unset ones for erosion, set ones for dilation
          for(let k=0;k<n;k++)line[k+1]=line[k]+((current[base+k*s[axis]]?1:0)===(dilate?1:0)?1:0);
          for(let k=0;k<n;k++){
            const lo=Math.max(0,k-r),hi=Math.min(n,k+r+1),hits=line[hi]-line[lo];
            next[base+k*s[axis]]=dilate?(hits>0?1:0):(hits===0?1:0);
          }
        }
        yield;
      }
      current=next;
    }
    return current;
  }
  // Six-connected regions of mask; keep(queue,length) decides from a region's cells whether it is marked in the result.
  function* regions(mask,p,keep){
    const s=step(p),[cx,cy,cz]=p.cells,seen=new Uint8Array(p.count),out=new Uint8Array(p.count),queue=new Int32Array(p.count);let kept=0,work=0;
    for(let start=0;start<p.count;start++){
      if(!mask[start]||seen[start])continue;
      let head=0,tail=0;queue[tail++]=start;seen[start]=1;
      while(head<tail){
        const i=queue[head++],x=i%cx,y=((i/cx)|0)%cy,z=(i/s[2])|0;
        if(x>0&&mask[i-1]&&!seen[i-1]){seen[i-1]=1;queue[tail++]=i-1;}
        if(x<cx-1&&mask[i+1]&&!seen[i+1]){seen[i+1]=1;queue[tail++]=i+1;}
        if(y>0&&mask[i-s[1]]&&!seen[i-s[1]]){seen[i-s[1]]=1;queue[tail++]=i-s[1];}
        if(y<cy-1&&mask[i+s[1]]&&!seen[i+s[1]]){seen[i+s[1]]=1;queue[tail++]=i+s[1];}
        if(z>0&&mask[i-s[2]]&&!seen[i-s[2]]){seen[i-s[2]]=1;queue[tail++]=i-s[2];}
        if(z<cz-1&&mask[i+s[2]]&&!seen[i+s[2]]){seen[i+s[2]]=1;queue[tail++]=i+s[2];}
        if(++work%BFS_YIELD===0)yield;
      }
      if(keep(queue,tail)){for(let k=0;k<tail;k++)out[queue[k]]=1;kept+=tail;}
    }
    return {mask:out,kept};
  }
  function* boneCells(pooled,p,threshold){
    const t=validateThreshold(threshold),v=pooled.values,s=step(p),[cx,cy,cz]=p.cells,high=new Uint8Array(p.count);
    for(let i=0;i<p.count;i++)high[i]=v[i]>=t?1:0;
    const core=yield* erode6(high,p),counted=new Uint8Array(p.count),voxels=cellVoxels(p);
    const found=yield* regions(core,p,(queue,length)=>{
      if(length*p.cellMl<LIMITS.boneMinMl)return false;
      // Density is judged on the region with its eroded rim, where the cortex lies, from full-resolution voxel counts.
      let total=0,dense=0;const touched=[];
      const count=i=>{if(counted[i]||!high[i])return;counted[i]=1;touched.push(i);total+=voxels(i);dense+=pooled.dense[i];};
      for(let k=0;k<length;k++){
        const i=queue[k],x=i%cx,y=((i/cx)|0)%cy,z=(i/s[2])|0;count(i);
        if(x>0)count(i-1);if(x<cx-1)count(i+1);if(y>0)count(i-s[1]);if(y<cy-1)count(i+s[1]);if(z>0)count(i-s[2]);if(z<cz-1)count(i+s[2]);
      }
      for(const i of touched)counted[i]=0;
      return dense/total>=LIMITS.denseFraction;
    });
    if(!found.kept)return {cells:null,rimHu:Math.min(t,LIMITS.rimHu),threshold:t,found:0};
    let grown=yield* reach(found.mask,p,high,2);
    grown=yield* reach(grown,p,null,1);
    let cells=0;for(let i=0;i<p.count;i++)cells+=grown[i];
    return {cells:grown,rimHu:Math.min(t,LIMITS.rimHu),threshold:t,found:cells};
  }
  // Background each slice of the third axis reaches from its border; what it cannot reach is enclosed (lungs, bowel gas).
  function* outside(mask,p){
    const [cx,cy,cz]=p.cells,area=cx*cy,queue=new Int32Array(area),out=new Uint8Array(p.count);
    for(let z=0;z<cz;z++){
      const base=z*area;let head=0,tail=0;
      const visit=j=>{if(!out[base+j]&&!mask[base+j]){out[base+j]=1;queue[tail++]=j;}};
      for(let x=0;x<cx;x++){visit(x);visit((cy-1)*cx+x);}
      for(let y=0;y<cy;y++){visit(y*cx);visit(y*cx+cx-1);}
      while(head<tail){const j=queue[head++],x=j%cx,y=(j/cx)|0;if(x>0)visit(j-1);if(x<cx-1)visit(j+1);if(y>0)visit(j-cx);if(y<cy-1)visit(j+cx);}
      yield;
    }
    return out;
  }
  // Removes only separate pieces of tissue that are thin everywhere: no cell lies deeper than 3 mm from the outside air.
  // The body, arms, a thick pad and anything touching the body stay; air is not touched.
  function* tableCells(pooled,p){
    const v=pooled.values,body=new Uint8Array(p.count);
    for(let i=0;i<p.count;i++)body[i]=v[i]>=LIMITS.bodyHu?1:0;
    // Cells within 3 mm of the outside air along each axis; an axis whose cells are thicker than 3 mm adds none (a thick
    // slice or a coarse grid never makes a 10 mm piece look thin).
    const radii=p.spacing.map(n=>Math.floor(LIMITS.tableErodeMm/(n*p.factor)));
    // Depth is measured from the outside air only: a lung or bowel cavity does not make the wall around it thin.
    const air=yield* box(yield* outside(body,p),p,radii,true);
    const plates=yield* regions(body,p,(queue,length)=>{for(let k=0;k<length;k++)if(!air[queue[k]])return false;return true;});
    if(!plates.kept)return {cells:null,found:0};
    // One cell of air around each piece, never into other tissue, takes its partial-volume edge.
    const grown=yield* reach(plates.mask,p,null,1);let cells=0;
    for(let i=0;i<p.count;i++){if(body[i]&&!plates.mask[i])grown[i]=0;cells+=grown[i];}
    return {cells:grown,found:plates.kept};
  }
  // Writes the source into out with removed voxels set below every source value.
  function* paint(src,out,p,parts,floor){
    checkSource(src,p);
    if(!ArrayBuffer.isView(out)||out.length!==p.voxels)throw kinError("VR 지우기 결과 배열 크기를 확인할 수 없습니다.");
    const [nx,ny,nz]=p.dims,[cx,cy]=p.cells,f=p.factor,bone=parts.bone?.cells||null,rim=parts.bone?.rimHu,table=parts.table?.cells||null;let removed=0;
    for(let z=0;z<nz;z++){
      const cz=(z/f)|0;
      for(let y=0;y<ny;y++){
        const row=(z*ny+y)*nx,cell=(cz*cy+((y/f)|0))*cx;
        for(let x=0;x<nx;x++){
          const v=src[row+x],c=cell+((x/f)|0);
          if(table&&table[c]||bone&&bone[c]&&v>=rim){out[row+x]=floor;removed++;}else out[row+x]=v;
        }
      }
      yield z/nz;
    }
    return removed;
  }
  // Below every source value and one more step below that, so the viewer can put a fully transparent ramp under the data.
  function floorFor(min){if(!Number.isFinite(min))throw kinError("VR 원본 최솟값을 확인할 수 없습니다.");return Math.floor(min)-2;}
  // Runs a generator to its end without yielding to anything (tests, small volumes).
  function run(generator){for(;;){const next=generator.next();if(next.done)return next.value;}}
  return Object.freeze({LIMITS,plan,validateThreshold,pool,boneCells,tableCells,paint,floorFor,run});
});
