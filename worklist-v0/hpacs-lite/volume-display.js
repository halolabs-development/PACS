// The viewer write path (viewer-language.js): product words in the reader's screen language, or as written.
function kinText(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.text ? l.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinHtml(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.html ? l.html(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinError(t, ...p) { return Object.assign(new Error(kinText(t, ...p)), { kinWords: true }); }
(function(root){
  const vector=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
  function resetZoomPan(current,starting){
    if(!vector(current?.focalPoint)||!vector(current?.position)||!vector(current?.viewPlaneNormal)||!vector(starting?.focalPoint)||!Number.isFinite(starting?.parallelScale)||starting.parallelScale<=0)throw kinError("초기 확대·이동과 현재 단면 좌표를 확인할 수 없습니다.");
    const normal=current.viewPlaneNormal;
    if(Math.abs(Math.hypot(...normal)-1)>1e-4)throw kinError("현재 단면 방향을 확인할 수 없습니다.");
    // Project the starting center onto the current plane. Restoring its depth
    // as well would silently navigate to another reconstructed slice.
    const depth=normal.reduce((sum,n,i)=>sum+n*(current.focalPoint[i]-starting.focalPoint[i]),0)/normal.reduce((sum,n)=>sum+n*n,0);
    const focalPoint=starting.focalPoint.map((n,i)=>n+normal[i]*depth),delta=focalPoint.map((n,i)=>n-current.focalPoint[i]);
    return {focalPoint,position:current.position.map((n,i)=>n+delta[i]),parallelScale:starting.parallelScale};
  }
  function resetWindowing(starting){
    const range=starting?.voiRange,fn=starting?.VOILUTFunction||'LINEAR';
    if(!range||!Number.isFinite(range.lower)||!Number.isFinite(range.upper)||range.lower>=range.upper||!['LINEAR','SIGMOID'].includes(fn))throw kinError("이 배치의 초기 밝기·대비를 확인할 수 없습니다.");
    return {voiRange:{lower:range.lower,upper:range.upper},VOILUTFunction:fn};
  }
  const model={resetZoomPan,resetWindowing};
  if(typeof module==='object'&&module.exports)module.exports=model;
  else root.KinVolumeDisplay=model;
})(globalThis);
