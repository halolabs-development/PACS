// M02: original spacing -> saved geometry -> verified readback -> SR, with no HU inferred for non-CT images.
// REQ-MANUAL-SPACED-MODALITIES -> RISK-WRONG-SCALE-OR-UNITS -> TEST-PLANAR-MEASUREMENT.
const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {viewerCommand,verifyViewerReference}=require('/app/dist/viewer-input.js');
const {srMeasurement,srDataset,srFile}=require('/app/dist/manual-sr-dicom.js');
const {planarGeometry}=require('/app/dist/planar-geometry.js');
const context=vm.createContext({});
for(const file of ['mg-length','planar-geometry'])vm.runInContext(fs.readFileSync('config/ohif/'+file+'.js','utf8'),context);
const base={StudyInstanceUID:'2.25.1',SeriesInstanceUID:'2.25.2',SOPInstanceUID:'2.25.3',SOPClassUID:'1.2.840.10008.5.1.4.1.1.4',Rows:128,Columns:128,PixelSpacing:[.5,.25],ImagePositionPatient:[0,0,0],ImageOrientationPatient:[1,0,0,0,1,0]};
for(const modality of ['MR','DX','US','XA','MG'])test(modality+' length, angle and area survive source verification and SR',()=>{
 const tags={...base,Modality:modality,...(modality==='MG'?{SOPClassUID:'1.2.840.10008.5.1.4.1.1.1.2'}:{})};
 const cases=[['length',[[0,0,0],[3,4,0]],5],['angle',[[0,1,0],[0,0,0],[1,0,0]],90],['angle',[[0,1,0],[0,0,0],[0,2,0]],0],['angle',[[0,1,0],[0,2,0],[0,3,0]],180],['ellipse',[[4,6,0],[4,2,0],[1,4,0],[7,4,0]],Math.PI*6]];
 for(const [kind,points,expected] of cases){
  const browser=context.kinPlanarGeometry(tags,1),server=planarGeometry(tags,1);
  for(const geometry of [browser,server])assert.ok(Math.abs(geometry.measure(kind,points)-expected)<1e-10);
  const item=viewerCommand(Buffer.from(JSON.stringify({requestId:'00000000-0000-4000-8000-000000000001',item:{schemaVersion:1,kind,seriesUid:tags.SeriesInstanceUID,sopUid:tags.SOPInstanceUID,frame:1,frameOfReferenceUid:null,label:'Manual',points,viewPlaneNormal:[0,0,1],viewUp:[0,1,0],baseline:{calculator:server.calculator,values:[expected]}}})),true).item;
  verifyViewerReference(tags.StudyInstanceUID,item,tags);
  const computed=srMeasurement(item,tags);assert.equal(computed.values.length,1);assert.ok(Math.abs(computed.values[0]-expected)<1e-10);
  const dataset=srDataset('sr-planar',tags.StudyInstanceUID,'Reader','reader',new Date('2026-10-26'),[{head:{id:'m-planar',revision:1,snapshot:item},tags,computed}],1);
  const procedure=dataset.ContentSequence.find(node=>node.ConceptNameCodeSequence.CodeValue==='121058').ConceptCodeSequence;
  assert.equal(procedure.CodeValue,modality);
  const group=dataset.ContentSequence.at(-1).ContentSequence[0].ContentSequence;
  const numeric=group.filter(node=>node.ValueType==='NUM');assert.equal(numeric.length,1);
  assert.equal(numeric[0].MeasuredValueSequence.MeasurementUnitsCodeSequence.CodeValue,{length:'mm',angle:'deg',ellipse:'mm2'}[kind]);
  assert.ok(Math.abs(Number(numeric[0].MeasuredValueSequence.NumericValue)-expected)<1e-10);
  assert.equal(numeric[0].ContentSequence.ContentSequence.ReferencedSOPSequence.ReferencedSOPInstanceUID,tags.SOPInstanceUID);
  const file=srFile(dataset);assert.equal(file.subarray(128,132).toString(),'DICM');
  assert.ok(file.includes(Buffer.from(computed.basis)));
  assert.throws(()=>verifyViewerReference(tags.StudyInstanceUID,{...item,baseline:{...item.baseline,values:[expected+1]}},tags));
 }
});
// Projection X-rays mostly carry no ImagePositionPatient / ImageOrientationPatient. The pinned viewer (OHIF's
// imagePlaneModule and the DICOM image loader alike) then places the image at origin [0,0,0] with rows along [0,1,0] and
// columns along [0,0,-1], and every mark's points lie in that plane. The tag sets below follow DICOM PS3.3: Imager Pixel
// Spacing is required in the DX family; Pixel Spacing that differs from it has been corrected or calibrated (10.7.1.1).
// The CR rows mirror public samples of the pydicom project (MIT licence): pydicom test_files dicomdirtests CR (Imager Pixel
// Spacing 0.1\0.1, 16x16, no position or orientation) and pydicom-data RG1 (Philips CR, Pixel Spacing 0.000\0.000, no
// position or orientation). The DX, RF and XA rows are synthetic tag sets, not copies of a device file.
const projection={StudyInstanceUID:'2.25.1',SeriesInstanceUID:'2.25.2',SOPInstanceUID:'2.25.3',Rows:200,Columns:300};
// A multi-frame or functional-group image's frame n has its origin at [0,0,n] in the pinned viewer (OHIF combineFrameInstance).
const viewerPoint=(tags,[x,y],spacing,frame)=>[0,x*spacing[1],(tags.PerFrameFunctionalGroupsSequence||tags.NumberOfFrames>1?frame:0)-y*spacing[0]];
const projections=[
 ['CR Pixel Spacing calibrated',{...projection,Modality:'CR',SOPClassUID:'1.2.840.10008.5.1.4.1.1.1',PixelSpacing:[.15,.15],ImagerPixelSpacing:[.168,.168]},[.15,.15],/원본 기준면/],
 ['CR public sample',{...projection,Modality:'CR',SOPClassUID:'1.2.840.10008.5.1.4.1.1.1',Rows:16,Columns:16,ImagerPixelSpacing:['0.1000','0.1000']},[.1,.1],/검출기/],
 ['DX detector',{...projection,Modality:'DX',SOPClassUID:'1.2.840.10008.5.1.4.1.1.1.1',ImagerPixelSpacing:[.2,.3]},[.2,.3],/검출기/],
 ['RF magnification',{...projection,Modality:'RF',SOPClassUID:'1.2.840.10008.5.1.4.1.1.12.2',ImagerPixelSpacing:[.3,.3],EstimatedRadiographicMagnificationFactor:1.2},[.25,.25],/ERMF/],
 ['XA multiframe',{...projection,Modality:'XA',SOPClassUID:'1.2.840.10008.5.1.4.1.1.12.1',NumberOfFrames:2,ImagerPixelSpacing:[.25,.5]},[.25,.5],/검출기/],
 ['XA enhanced',{...projection,Modality:'XA',SOPClassUID:'1.2.840.10008.5.1.4.1.1.12.1.1',NumberOfFrames:1,PerFrameFunctionalGroupsSequence:[{PixelMeasuresSequence:[{PixelSpacing:[.3,.3]}]}]},[.3,.3],/원본 기준면/],
];
for(const [name,tags,spacing,label] of projections)test(name+' without position or orientation measures in the viewer plane',()=>{
 const small=tags.Columns<100, at=p=>small?p.map(n=>n/20):p;
 const pixels={length:[[10,20],[40,60]],angle:[[40,20],[10,20],[10,60]],ellipse:[[50,70],[50,30],[30,50],[70,50]]};
 const expected={length:Math.hypot(30*spacing[1],40*spacing[0]),angle:90,ellipse:Math.PI*40*spacing[1]*40*spacing[0]/4};
 for(const kind of ['length','angle','ellipse']){
  const image=pixels[kind].map(at),value=small&&kind!=='angle'?expected[kind]/(kind==='ellipse'?400:20):expected[kind];
  for(const frame of tags.NumberOfFrames>1?[1,2]:[1]){
   const points=image.map(p=>viewerPoint(tags,p,spacing,frame));
   const browser=context.kinPlanarGeometry(tags,frame),server=planarGeometry(tags,frame);
   // The browser reads the viewer's combined instance, which carries that frame origin as ImagePositionPatient.
   if(tags.NumberOfFrames>1)assert.deepEqual([...context.kinPlanarGeometry({...tags,ImagePositionPatient:[0,0,frame]},frame).origin],[...browser.origin]);
   assert.deepEqual([...browser.spacing],spacing);assert.match(browser.label,label);assert.equal(browser.label,server.label);
   for(const geometry of [browser,server]){
    assert.ok(Math.abs(geometry.measure(kind,points)-value)<1e-9,name+' '+kind);
    points.forEach((p,i)=>geometry.imagePoint(p).forEach((n,j)=>assert.ok(Math.abs(n-image[i][j])<1e-9)));
   }
   const item=viewerCommand(Buffer.from(JSON.stringify({requestId:'00000000-0000-4000-8000-000000000002',item:{schemaVersion:1,kind,seriesUid:tags.SeriesInstanceUID,sopUid:tags.SOPInstanceUID,frame,frameOfReferenceUid:null,label:'Manual',points,viewPlaneNormal:[-1,0,0],viewUp:[0,0,1],baseline:{calculator:server.calculator,values:[value]}}})),true).item;
   verifyViewerReference(tags.StudyInstanceUID,item,tags);
   // The SR graphic is the image pixel coordinates (pixel corner origin), the same coordinates the viewer drew.
   const computed=srMeasurement(item,tags);assert.ok(Math.abs(computed.values[0]-value)<1e-9);
   const graphic=(kind==='ellipse'&&(image[0][1]-image[1][1])*spacing[0]<(image[3][0]-image[2][0])*spacing[1]?[image[2],image[3],image[0],image[1]]:image).flat().map(n=>n+.5);
   computed.graphic.forEach((n,i)=>assert.ok(Math.abs(n-graphic[i])<1e-9,name+' graphic'));
  }
 }
 // A point off the viewer's plane, or one in the plane once assumed ([1,0,0]/[0,1,0]), is never measured.
 for(const geometry of [context.kinPlanarGeometry(tags,1),planarGeometry(tags,1)]){
  assert.throws(()=>geometry.measure('length',[[1,0,0],[0,4,-3].map(n=>small?n/20:n)]));
  assert.throws(()=>geometry.measure('length',[[0,0,0],[3,4,0]]));
 }
});
test('multi-frame images: the viewer origin, the top-level position, no plane when unsure',()=>{
 const line=[[0,10,-10],[0,20,-10]];
 // NM keeps its position and orientation in DetectorInformationSequence; the viewer moves them into the image by its own
 // rules, which are not repeated here: no measurement, in the browser (which sees them moved) and on the server alike.
 const nm={...projection,Modality:'NM',SOPClassUID:'1.2.840.10008.5.1.4.1.1.20',NumberOfFrames:2,PixelSpacing:[1,1],
  DetectorInformationSequence:[{ImagePositionPatient:'0\\10\\0',ImageOrientationPatient:[0,1,0,0,0,-1]}]};
 for(const frame of [1,2]){
  assert.throws(()=>context.kinPlanarGeometry({...nm,ImagePositionPatient:[0,10,0],ImageOrientationPatient:[0,1,0,0,0,-1]},frame),/원본 프레임의 좌표·간격·보정을 확인할 수 없습니다/);
  assert.throws(()=>planarGeometry(nm,frame),/원본 프레임의 좌표·간격·보정을 확인할 수 없습니다/);
  const mark=viewerCommand(Buffer.from(JSON.stringify({requestId:'00000000-0000-4000-8000-000000000004',item:{schemaVersion:1,kind:'spine',seriesUid:nm.SeriesInstanceUID,sopUid:nm.SOPInstanceUID,frame,frameOfReferenceUid:null,label:'L4',points:[[0,10,-10]]}})),true).item;
  assert.throws(()=>verifyViewerReference(nm.StudyInstanceUID,mark,nm));
 }
 // Groups that give only the spacing: the viewer keeps the top-level position; so do both geometries.
 const grouped={...projection,Modality:'XA',SOPClassUID:'1.2.840.10008.5.1.4.1.1.12.1.1',NumberOfFrames:2,ImagePositionPatient:[0,0,12],
  SharedFunctionalGroupsSequence:[{PixelMeasuresSequence:[{PixelSpacing:[1,1]}]}],PerFrameFunctionalGroupsSequence:[{},{}]};
 const shifted=line.map(([x,y,z])=>[x,y,z+12]);
 for(const geometry of [context.kinPlanarGeometry(grouped,2),planarGeometry(grouped,2)]){
  assert.deepEqual([...geometry.origin],[0,0,12]);assert.deepEqual([...geometry.imagePoint(shifted[0])].map(n=>Math.round(n*1e9)/1e9),[10,10]);
 }
 // Enhanced XA where frame 1 gives a position and frame 2 none: the viewer carries frame 1's over; no plane to measure in.
 const partial={...projection,Modality:'XA',SOPClassUID:'1.2.840.10008.5.1.4.1.1.12.1.1',NumberOfFrames:2,
  SharedFunctionalGroupsSequence:[{PixelMeasuresSequence:[{PixelSpacing:[1,1]}]}],
  PerFrameFunctionalGroupsSequence:[{PlanePositionSequence:[{ImagePositionPatient:[0,0,0]}]},{}]};
 for(const make of [t=>context.kinPlanarGeometry(t,2),t=>planarGeometry(t,2)])assert.throws(()=>make(partial),/원본 프레임의 좌표·간격·보정을 확인할 수 없습니다/);
 for(const geometry of [context.kinPlanarGeometry(partial,1),planarGeometry(partial,1)])assert.ok(Math.abs(geometry.measure('length',line)-10)<1e-9);
});test('projection images without a usable spacing still measure nothing',()=>{
 const cr={...projection,Modality:'CR',SOPClassUID:'1.2.840.10008.5.1.4.1.1.1'};
 for(const tags of [cr,{...cr,PixelSpacing:['0.000','0.000']},{...cr,ImagerPixelSpacing:[.2,.2],EstimatedRadiographicMagnificationFactor:0}]){
  assert.throws(()=>context.kinPlanarGeometry(tags,1),/원본 프레임의 좌표·간격·보정을 확인할 수 없습니다/);
  assert.throws(()=>planarGeometry(tags,1),/원본 프레임의 좌표·간격·보정을 확인할 수 없습니다/);
 }
});
test('selected multiframe spacing and detector calibration remain explicit',()=>{
 const tags={...base,Modality:'XA',NumberOfFrames:2401,PerFrameFunctionalGroupsSequence:Array.from({length:2401},()=>({PixelMeasuresSequence:[{PixelSpacing:[1,2]}],PlanePositionSequence:[{ImagePositionPatient:[0,0,0]}],PlaneOrientationSequence:[{ImageOrientationPatient:[1,0,0,0,1,0]}]}))};
 tags.PerFrameFunctionalGroupsSequence[2400].PixelMeasuresSequence[0].PixelSpacing=[.5,.25];
 assert.deepEqual(planarGeometry(tags,2401).spacing,[.5,.25]);assert.throws(()=>planarGeometry(tags,2402));
 const detector={...base,Modality:'DX',PixelSpacing:undefined,ImagerPixelSpacing:[.2,.4]};
 assert.match(planarGeometry(detector,1).label,/검출기/);
 assert.throws(()=>planarGeometry({...detector,ImagerPixelSpacing:undefined},1));
});
