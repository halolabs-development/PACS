/* Monitors in Hanging Protocol: the rule's monitors (validation, cells dealt per monitor) and the split of one viewer
 * window over the displays it covers (regions, target, bands, rectangles, rows and their copies). Pure: no browser. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const model=require('../worklist-v0/hpacs-lite/hanging-protocol-model.js');
const plan=require('../worklist-v0/hpacs-lite/viewer-features-monitors.js');

const monitor=(images,extra={})=>({images,worklist:'none',thumbs:'top',toolbar:'top',...extra});
const rule=(cells,monitors,rows=2,cols=2)=>({layout:{rows,cols,cells},monitors:{count:monitors.length,list:monitors}});
const screens=[{left:0,top:0,width:1920,height:1040},{left:1920,top:0,width:1920,height:1040},{left:3840,top:0,width:1080,height:1880}];

test('monitors: one Show at most, and some image monitor keeps a toolbar',()=>{
  assert.deepEqual(model.monitorsRule({count:1,list:[monitor('auto')]}),{count:1,list:[monitor('auto')]});
  assert.equal(model.monitorsRule({count:2,list:[monitor('none',{worklist:'show'}),monitor('2x2',{worklist:'show'})]}),null);
  assert.equal(model.monitorsRule({count:2,list:[monitor('none',{toolbar:'top'}),monitor('2x2',{toolbar:'none'})]}),null);
  assert.equal(model.monitorsRule({count:2,list:[monitor('auto')]}),null,'count is the list length');
  assert.equal(model.monitorsRule({count:5,list:Array(5).fill(monitor('auto'))}),null);
  assert.equal(model.monitorsRule({count:1,list:[{...monitor('auto'),extra:1}]}),null);
});

test('a rule without monitors keeps loading, and monitors survive normalize (import, export, duplicate)',()=>{
  const base={version:1,activeRuleId:null,rules:[{id:'11111111-1111-4111-8111-111111111111',name:'CT',enabled:true,
    match:{modality:null,retrieveAE:null,bodyPart:null,description:null},
    selectors:[{alias:'Current1',role:'current',historical:false,modality:null,retrieveAE:null,bodyPart:null,description:null,laterality:null,order:'ascending',occurrence:1}],
    layout:{rows:1,cols:2,cells:['Current1',null]}}]};
  assert.ok(model.normalize(base));
  assert.equal('monitors' in model.normalize(base).rules[0],false,'no default monitors are put into an old rule');
  const withMonitors=structuredClone(base);withMonitors.rules[0].monitors={count:2,list:[monitor('1x1'),monitor('2x2',{thumbs:'left'})]};
  assert.deepEqual(model.normalize(JSON.parse(JSON.stringify(model.normalize(withMonitors)))).rules[0].monitors,withMonitors.rules[0].monitors);
});

test('cells are dealt in monitor order, row by row inside each monitor; a rule cell left over is hidden',()=>{
  const r=rule(['a','b','c','d'],[monitor('2x1'),monitor('2x1')]);
  assert.deepEqual(model.monitorCells(r),{plan:[{monitor:0,rows:2,cols:1,cells:[0,1]},{monitor:1,rows:2,cols:1,cells:[2,3]}],hidden:0});
  const small=rule(['a','b','c','d'],[monitor('1x1'),monitor('none'),monitor('1x2')]);
  assert.deepEqual(model.monitorCells(small),{plan:[{monitor:0,rows:1,cols:1,cells:[0]},{monitor:2,rows:1,cols:2,cells:[1,2]}],hidden:1});
  const auto=rule(['a',null],[monitor('auto'),monitor('2x2')],1,2);
  assert.deepEqual(model.monitorCells(auto).plan,[{monitor:0,rows:1,cols:2,cells:[0,1]},{monitor:1,rows:2,cols:2,cells:[null,null,null,null]}]);
});

test('target: the first image monitor, and the next one only when the two displays touch side by side',()=>{
  const two={list:[monitor('none',{worklist:'show'}),monitor('2x2')]};
  assert.deepEqual(plan.target(two,screens),{monitors:[1],rect:screens[1],skipped:[]});
  const pair={list:[monitor('1x2'),monitor('1x2')]};
  assert.deepEqual(plan.target(pair,screens).rect,{left:0,top:0,width:3840,height:1040});
  const apart={list:[monitor('1x1'),monitor('none',{worklist:'show'}),monitor('1x1')]};
  assert.deepEqual(plan.target(apart,screens),{monitors:[0],rect:screens[0],skipped:[{monitor:2,reason:'one-window'}]},'never covers the worklist monitor between');
  const missing={list:[monitor('1x1'),monitor('1x1')]};
  assert.deepEqual(plan.target(missing,[screens[0]]),{monitors:[0],rect:screens[0],skipped:[{monitor:1,reason:'no-display'}]});
  const stacked=[{left:0,top:0,width:1920,height:1040},{left:0,top:1080,width:1920,height:1040}];
  assert.deepEqual(plan.target(pair,stacked).monitors,[0],'a display above another is not side by side');
});

test('regions: the parts of the window on each display, in client px, from where the window actually is',()=>{
  // A window across the first two displays: 8px frame each side, 30px title bar.
  const win={screenX:-8,screenY:0,outerWidth:3856,outerHeight:1040,innerWidth:3840,innerHeight:1002};
  assert.deepEqual(plan.regions(screens,win,1,{left:0,right:3840}),[{monitor:0,left:0,right:1920},{monitor:1,left:1920,right:3840}]);
  // Barely over the edge: no region on the second display.
  const edge={screenX:1700,screenY:0,outerWidth:416,outerHeight:600,innerWidth:400,innerHeight:562};
  assert.deepEqual(plan.regions(screens,edge,1,{left:0,right:400}).map(r=>r.monitor),[0]);
  assert.deepEqual(plan.regions(screens,{...win,outerWidth:3900},null,{left:0,right:3840}),[],'an unknown zoom with an odd frame is not guessed');
  // One display above another: the same columns of the window, so not a split; the one holding more of it is the monitor.
  const stacked=[{left:0,top:0,width:1920,height:1080},{left:0,top:1080,width:1920,height:1080}];
  const tall={screenX:-8,screenY:300,outerWidth:1936,outerHeight:1200,innerWidth:1920,innerHeight:1162};
  assert.deepEqual(plan.regions(stacked,tall,1,{left:0,right:1920}),[{monitor:0,left:0,right:1920}]);
  assert.deepEqual(plan.regions(stacked,{...tall,screenY:900},1,{left:0,right:1920}),[{monitor:1,left:0,right:1920}]);
  // Parts that do not meet edge to edge are not one split either.
  const gap=[{left:0,top:0,width:1000,height:1040},{left:1500,top:0,width:1000,height:1040}];
  assert.deepEqual(plan.regions(gap,{screenX:0,screenY:0,outerWidth:2500,outerHeight:1040,innerWidth:2500,innerHeight:1002},1,{left:0,right:2500}).map(r=>r.monitor),[0]);
});

test('split: two 2x1 monitors keep rule cell order per monitor, not the screen order',()=>{
  const r=rule(['a','b','c','d'],[monitor('2x1',{thumbs:'left'}),monitor('2x1',{thumbs:'right',toolbar:'top'})]);
  const regions=[{monitor:0,left:0,right:1000},{monitor:1,left:1000,right:2000}],column={left:0,right:2000,top:0,bottom:1000};
  const s=plan.split(model,r,regions,column,{left:0,top:0,width:2000,height:1000});
  // Screen order is top to bottom, then left to right: a (monitor 1 top), c (monitor 2 top), b, d.
  assert.deepEqual(s.cells,[0,2,1,3]);
  assert.equal(s.rects.length,4);assert.ok(plan.validRects(s.rects));
  // Monitor 1: toolbar 36px on top, strip 156px on the left inside it.
  assert.deepEqual(s.rects[0],{x:0.078,y:0.036,width:0.422,height:0.482});
  assert.deepEqual(s.rects[1],{x:0.5,y:0.036,width:0.422,height:0.482});
  assert.equal(s.rows.toolbar.original.monitor,0);assert.equal(s.rows.toolbar.copy.monitor,1);
  assert.deepEqual([s.rows.thumbs.original.side,s.rows.thumbs.copy.side],['left','right']);
  assert.ok(s.numRows*s.numCols>=s.rects.length);
  assert.deepEqual(s.applied,[0,1]);assert.deepEqual(s.hidden,[]);
});

test('laid: each cell\'s monitor and its row and column there are read from where it stands - also where one monitor\'s images start higher',()=>{
  // Monitor 1 with both rows on top, monitor 2 with its toolbar at the bottom: monitor 2's images start higher.
  const r=rule(['a','b','c','d','e','f','g','h'],[monitor('2x2'),monitor('2x2',{thumbs:'none',toolbar:'bottom'})],2,4);
  const regions=[{monitor:0,left:0,right:1000},{monitor:1,left:1000,right:2000}],column={left:0,right:2000,top:0,bottom:1000};
  const s=plan.split(model,r,regions,column,{left:0,top:0,width:2000,height:1000});
  assert.ok(s.areas[1].y<s.areas[0].y);
  const cells=s.rects.map((rect,i)=>({...rect,viewportId:'v'+s.cells[i]}));
  // On screen (top to bottom) monitor 2's top row comes first: the order of the list says nothing of the monitor.
  assert.deepEqual(cells.map(c=>c.viewportId).slice(0,2),['v4','v5']);
  const stood=plan.laid(cells,s.areas);
  assert.deepEqual(stood.shapes,[{rows:2,cols:2},{rows:2,cols:2}]);
  const at=id=>stood.places[cells.findIndex(c=>c.viewportId===id)];
  assert.deepEqual([at('v0'),at('v1'),at('v2'),at('v3')],[{monitor:0,row:0,col:0},{monitor:0,row:0,col:1},{monitor:0,row:1,col:0},{monitor:0,row:1,col:1}]);
  assert.deepEqual([at('v4'),at('v5'),at('v6'),at('v7')],[{monitor:1,row:0,col:0},{monitor:1,row:0,col:1},{monitor:1,row:1,col:0},{monitor:1,row:1,col:1}]);
  // Laid again (lay) every cell is back on its own rectangle, with the place key the split gave it.
  const back=plan.lay(s.areas,stood.shapes);
  assert.deepEqual([back.numRows,back.numCols],[2,4]);
  cells.forEach((c,i)=>{const p=stood.places[i],own=back.cells.find(b=>b.monitor===p.monitor&&b.row===p.row&&b.col===p.col);
    assert.deepEqual({x:own.x,y:own.y,width:own.width,height:own.height},{x:c.x,y:c.y,width:c.width,height:c.height},c.viewportId);
    assert.equal(own.positionId,s.positions[i],c.viewportId);});
  // Each rectangle's place key: its column across both monitors, its row on its own monitor.
  assert.deepEqual(s.positions,['2-0','3-0','0-0','1-0','2-1','3-1','0-1','1-1']);
  // fit is lay with the same grid on every monitor, in the base grid's order (row by row, across the monitors).
  assert.deepEqual(plan.fit(s.areas,2,4),back.cells.map(({x,y,width,height})=>({x,y,width,height})));
  assert.deepEqual(back.cells.map(c=>c.positionId),['0-0','1-0','2-0','3-0','0-1','1-1','2-1','3-1']);
  // A plain grid lying over the monitors (under their rows) does not stand on them; nor do cells without two areas.
  const plain=Array.from({length:8},(_,i)=>({viewportId:'p'+i,x:(i%4)/4,y:Math.floor(i/4)/2,width:0.25,height:0.5}));
  assert.equal(plan.laid(plain,s.areas),null);
  assert.equal(plan.laid(cells,[s.areas[0]]),null);
  assert.equal(plan.laid(cells,null),null);
  // A cell across the display edge, and a monitor left without a cell, are not laid either.
  assert.equal(plan.laid([{x:s.areas[0].x,y:s.areas[0].y,width:0.8,height:0.2},cells[0]],s.areas),null);
  assert.equal(plan.laid(cells.filter((c,i)=>stood.places[i].monitor===0),s.areas),null);
});

test('lay: monitors holding different grids - a monitor with fewer rows has no cell in the lower ones, every cell its own key',()=>{
  const areas=[{x:0.05,y:0.1,width:0.4,height:0.9},{x:0.5,y:0,width:0.5,height:0.95}];
  const out=plan.lay(areas,[{rows:2,cols:1},{rows:1,cols:1}]);
  assert.deepEqual([out.numRows,out.numCols],[2,2]);
  assert.deepEqual(out.cells.map(c=>[c.monitor,c.row,c.col,c.positionId]),[[0,0,0,'0-0'],[1,0,0,'1-0'],[0,1,0,'0-1']]);
  assert.deepEqual(out.cells[1],{monitor:1,row:0,col:0,x:0.5,y:0,width:0.5,height:0.95,positionId:'1-0'});
  // Read back: the same shapes and places (a monitor's one cell filling its area is its 1 x 1 - also an enlarged cell).
  assert.deepEqual(plan.laid(out.cells,areas),{shapes:[{rows:2,cols:1},{rows:1,cols:1}],places:out.cells.map(({monitor,row,col})=>({monitor,row,col}))});
  // Different columns: 2 x 1 beside 2 x 2 is a base grid of 2 x 3.
  const wide=plan.lay(areas,[{rows:2,cols:1},{rows:2,cols:2}]);
  assert.deepEqual([wide.numRows,wide.numCols,wide.cells.length],[2,3,6]);
  assert.deepEqual(wide.cells.map(c=>c.positionId),['0-0','1-0','2-0','0-1','1-1','2-1']);
  assert.equal(new Set(wide.cells.map(c=>c.positionId)).size,6);
  // The two sides of a display edge (no rule's rows): the same reading.
  const sides=[{x:0,y:0,width:0.46,height:1},{x:0.46,y:0,width:0.54,height:1}];
  assert.deepEqual(plan.laid(out.cells,sides)?.shapes,[{rows:2,cols:1},{rows:1,cols:1}]);
  assert.equal(plan.lay(areas,[{rows:1,cols:1}]),null);
  assert.equal(plan.lay(areas,[{rows:0,cols:1},{rows:1,cols:1}]),null);
  assert.equal(plan.fit(areas,1,3),null,'an odd number of columns is not shared between two monitors');
});

test('keyed: the cells by the place keys they carry, only when each has its own',()=>{
  const cells=[{viewportId:'b',positionId:'1-0'},{viewportId:'c',positionId:'0-1'},{viewportId:'a',positionId:'0-0'},{viewportId:'d',positionId:'1-1'}];
  assert.deepEqual(plan.keyed(cells).map(c=>c.viewportId),['a','b','c','d']);
  assert.equal(plan.keyed(cells.map((c,i)=>i===2?{...c,positionId:'1-0'}:c)),null,'two cells with one key');
  assert.equal(plan.keyed([{viewportId:'x'}]),null);
  assert.equal(plan.keyed([]),null);
});
test('split: where the displays meet off the middle each rectangle still has a place key of its own',()=>{
  // Monitor 1 holds 700 of the window's 2000 px: rounded to the 4-column grid, two of the four would share key 1-0.
  const r=rule(['a','b','c','d'],[monitor('1x2'),monitor('1x2')],1,4);
  const regions=[{monitor:0,left:0,right:700},{monitor:1,left:700,right:2000}],column={left:0,right:2000,top:0,bottom:1000};
  const s=plan.split(model,r,regions,column,{left:0,top:0,width:2000,height:1000});
  assert.deepEqual(s.rects.map(x=>Math.round(x.x*4)+'-'+Math.round(x.y*1)),['0-0','1-0','1-0','3-0']);
  assert.deepEqual(s.positions,['0-0','1-0','2-0','3-0']);
  // One monitor: no place keys (the native grid keys a plain split as before).
  assert.equal(plan.split(model,r,[regions[0]],column,{left:0,top:0,width:2000,height:1000}).positions,null);
});

test('split: a monitor without a toolbar gives the original to the next; no toolbar anywhere keeps it on top',()=>{
  const regions=[{monitor:0,left:0,right:1000},{monitor:1,left:1000,right:2000}],column={left:0,right:2000,top:0,bottom:1000},grid={left:0,top:0,width:2000,height:1000};
  const r=rule(['a','b'],[monitor('1x1',{toolbar:'none',thumbs:'none'}),monitor('1x1',{toolbar:'bottom',thumbs:'none'})],1,2);
  const s=plan.split(model,r,regions,column,grid);
  assert.equal(s.rows.toolbar.original.monitor,1,'the real toolbar (with Viewer Settings) stands on the monitor that shows one');
  assert.equal(s.rows.toolbar.copy,null);assert.equal(s.rows.thumbs.original,null);
  assert.deepEqual(s.rects[0],{x:0,y:0,width:0.5,height:1},'monitor 1 has no rows: its cell fills it');
  assert.deepEqual(s.rects[1],{x:0.5,y:0,width:0.5,height:0.964});
  // Only monitor 1 is covered, and it has no toolbar: the toolbar stays on its top edge (Viewer Settings within reach).
  const kept=plan.split(model,r,regions.slice(0,1),column,grid);
  assert.equal(kept.toolbarKept,true);assert.equal(kept.rows.toolbar.original.side,'top');assert.deepEqual(kept.applied,[0]);
  assert.deepEqual(kept.hidden,[1],'the rule cell of the monitor not covered is not shown');
});

test('split: nothing when the covered displays show no images; Images None leaves its display empty',()=>{
  const column={left:0,right:2000,top:0,bottom:1000},grid={left:0,top:0,width:2000,height:1000};
  const r=rule(['a','b'],[monitor('none',{worklist:'show'}),monitor('1x2')],1,2);
  assert.equal(plan.split(model,r,[{monitor:0,left:0,right:1000}],column,grid),null);
  const s=plan.split(model,r,[{monitor:0,left:0,right:1000},{monitor:1,left:1000,right:2000}],column,grid);
  assert.ok(s.rects.every(rect=>rect.x>=0.5),'no cell on the worklist monitor');
  assert.deepEqual(s.applied,[1]);
});

test('place: a band keeps its monitor edge in percentages and its thickness in px',()=>{
  const regions=[{monitor:0,left:0,right:1000},{monitor:1,left:1000,right:2000}],column={left:0,right:2000,top:0,bottom:1000},grid={left:0,top:0,width:2000,height:1000};
  const s=plan.split(model,rule(['a','b'],[monitor('1x1',{thumbs:'bottom'}),monitor('1x1',{toolbar:'right',thumbs:'left'})],1,2),regions,column,grid);
  assert.deepEqual(plan.place(s.rows.toolbar.original),{left:'calc(0% + 0px)',right:'calc(50% + 0px)',width:'auto',height:'36px',top:'0px',bottom:'auto'});
  assert.deepEqual(plan.place(s.rows.toolbar.copy),{top:'0px',bottom:'0px',width:'108px',height:'auto',left:'auto',right:'calc(0% + 0px)'});
  assert.deepEqual(plan.place(s.rows.thumbs.copy),{top:'0px',bottom:'0px',width:'156px',height:'auto',left:'calc(50% + 0px)',right:'auto'});
  assert.deepEqual(plan.place(s.rows.thumbs.original),{left:'calc(0% + 0px)',right:'calc(50% + 0px)',width:'auto',height:'66px',top:'auto',bottom:'0px'});
});

test('monitorOf: the display holding the centre of a window',()=>{
  assert.equal(plan.monitorOf(screens,{left:2000,top:10,width:800,height:600}),1);
  assert.equal(plan.monitorOf(screens,{left:-5000,top:10,width:800,height:600}),-1);
  assert.equal(plan.monitorOf(screens,null),-1);
});

test('validRects: inside the screen and not overlapping',()=>{
  assert.ok(plan.validRects([{x:0,y:0,width:.5,height:1},{x:.5,y:0,width:.5,height:1}]));
  assert.equal(plan.validRects([{x:0,y:0,width:.6,height:1},{x:.5,y:0,width:.5,height:1}]),false);
  assert.equal(plan.validRects([{x:.6,y:0,width:.5,height:1}]),false);
  assert.equal(plan.validRects([]),false);
});

test('edges: where the displays meet inside the viewport grid, as fractions of its width',()=>{
  // The window over the first two displays; the grid fills its client area but for a 40px panel on the left.
  const win={screenX:-8,screenY:0,outerWidth:3856,outerHeight:1040,innerWidth:3840,innerHeight:1002};
  const grid={left:40,width:3800};
  assert.deepEqual(plan.edges(screens,win,1,grid),[Math.round((1920-40)/3800*1e6)/1e6]);
  // One display under the grid: none.
  const one={screenX:100,screenY:0,outerWidth:1216,outerHeight:900,innerWidth:1200,innerHeight:862};
  assert.deepEqual(plan.edges(screens,one,1,{left:0,width:1200}),[]);
  // Over an edge by less than a monitor region (188px) is still over it: the maximize must not reach across.
  const barely={screenX:1700,screenY:0,outerWidth:416,outerHeight:600,innerWidth:400,innerHeight:562};
  assert.deepEqual(plan.edges(screens,barely,1,{left:0,width:400}),[Math.round((1920-1708)/400*1e6)/1e6]);
  // Over it by no more than the error of reading a frame (10px): none.
  const within={screenX:1522,screenY:0,outerWidth:416,outerHeight:600,innerWidth:400,innerHeight:562};
  assert.deepEqual(plan.edges(screens,within,1,{left:0,width:400}),[]);
  // And the same without the access: only the own display is known, 188px past it is another monitor.
  assert.deepEqual(plan.edges([screens[0]],barely,null,{left:0,width:400}),[Math.round((1920-1708)/400*1e6)/1e6]);
  // Only the window's own display is known (no window-management access): the grid past it is another monitor.
  assert.deepEqual(plan.edges([screens[0]],win,null,grid),[Math.round((1920-40)/3800*1e6)/1e6]);
  assert.deepEqual(plan.edges([screens[1]],win,null,grid),[Math.round((1920-40)/3800*1e6)/1e6]);
  // Three displays under one window: two edges.
  const wide={screenX:-8,screenY:0,outerWidth:4936,outerHeight:1040,innerWidth:4920,innerHeight:1002};
  assert.deepEqual(plan.edges(screens,wide,1,{left:0,width:4920}),[Math.round(1920/4920*1e6)/1e6,Math.round(3840/4920*1e6)/1e6]);
  // Nothing readable: unknown.
  assert.equal(plan.edges(screens,{...win,outerWidth:3956},null,grid),null,'a frame that is not plain without a known zoom');
  assert.equal(plan.edges([],win,1,grid),null);
  assert.equal(plan.edges(screens,win,1,{left:0,width:0}),null);
});

test('pair: two monitors side by side under the viewport grid, and nothing else',()=>{
  const win={screenX:-8,screenY:0,outerWidth:3856,outerHeight:1040,innerWidth:3840,innerHeight:1002};
  const grid={left:40,width:3800};
  assert.equal(plan.pair(screens,win,1,grid),true);
  // One display under the grid.
  const one={screenX:100,screenY:0,outerWidth:1216,outerHeight:900,innerWidth:1200,innerHeight:862};
  assert.equal(plan.pair(screens,one,1,{left:0,width:1200}),false);
  // Three displays under it: not a pair.
  const wide={screenX:-8,screenY:0,outerWidth:4936,outerHeight:1040,innerWidth:4920,innerHeight:1002};
  assert.equal(plan.pair(screens,wide,1,{left:0,width:4920}),false);
  // One display above the other, touching, set apart sideways, the window laid over both: the upper one (more of the
  // window's height) ends in the middle of the grid, the lower one lies under all of it. The upper display's side edge is
  // inside the grid (edges counts the grid past it as another monitor), yet one monitor stands there.
  const stacked=[{left:0,top:0,width:1000,height:700},{left:-200,top:700,width:3000,height:900}];
  const over={screenX:92,screenY:100,outerWidth:1816,outerHeight:1038,innerWidth:1800,innerHeight:1000};
  assert.deepEqual(plan.regions(stacked,over,1,{left:0,right:1800},16),[{monitor:0,left:0,right:900}]);
  assert.deepEqual(plan.edges(stacked,over,1,{left:0,width:1800}),[0.5]);
  assert.equal(plan.pair(stacked,over,1,{left:0,width:1800}),false);
  // Two displays meeting at a corner only (one under the top of the left half, the other under the bottom of the right
  // half): the left one holds less than half of the window's height.
  const corner=[{left:0,top:0,width:1000,height:400},{left:1000,top:400,width:1000,height:900}];
  assert.equal(plan.pair(corner,over,1,{left:0,width:1800}),false);
  // Only the window's own display is known (no access): the grid past it is not a known monitor.
  assert.equal(plan.pair([screens[0]],win,null,grid),false);
  // Nothing readable: unknown.
  assert.equal(plan.pair(screens,{...win,outerWidth:3956},null,grid),null);
  assert.equal(plan.pair([],win,1,grid),null);
  assert.equal(plan.pair(screens,win,1,{left:0,width:0}),null);
});
