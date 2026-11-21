// M02: original spacing -> saved geometry -> verified readback -> SR, with no HU inferred for non-CT images.
// REQ-MANUAL-SPACED-MODALITIES -> RISK-WRONG-SCALE-OR-UNITS -> TEST-PLANAR-MEASUREMENT.
const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {viewerCommand,verifyViewerReference}=require('/app/dist/viewer-input.js');
const {srMeasurement,srDataset,srFile}=require('/app/dist/manual-sr-dicom.js');
const {planarGeometry,manualGeometry,viewerPlaneImage}=require('/app/dist/planar-geometry.js');
// The viewer's write path (viewer-language.js) first, as config/ohif.js carries it before these sources.
const context=vm.createContext({window:{}});
for(const file of ['worklist-v0/hpacs-lite/viewer-language.js','config/ohif/mg-length.js','config/ohif/planar-geometry.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
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
const viewerPoint=(tags,[x,y],spacing)=>[0,x*spacing[1],-y*spacing[0]];
const projections=[
 ['CR Pixel Spacing calibrated',{...projection,Modality:'CR',SOPClassUID:'1.2.840.10008.5.1.4.1.1.1',PixelSpacing:[.15,.15],ImagerPixelSpacing:[.168,.168]},[.15,.15],/원본 기준면/],
 ['CR public sample',{...projection,Modality:'CR',SOPClassUID:'1.2.840.10008.5.1.4.1.1.1',Rows:16,Columns:16,ImagerPixelSpacing:['0.1000','0.1000']},[.1,.1],/검출기/],
 ['DX detector',{...projection,Modality:'DX',SOPClassUID:'1.2.840.10008.5.1.4.1.1.1.1',ImagerPixelSpacing:[.2,.3]},[.2,.3],/검출기/],
 ['RF magnification',{...projection,Modality:'RF',SOPClassUID:'1.2.840.10008.5.1.4.1.1.12.2',ImagerPixelSpacing:[.3,.3],EstimatedRadiographicMagnificationFactor:1.2},[.25,.25],/ERMF/],
 ['XA single frame',{...projection,Modality:'XA',SOPClassUID:'1.2.840.10008.5.1.4.1.1.12.1',NumberOfFrames:'1',ImagerPixelSpacing:['0.25','0.5']},[.25,.5],/검출기/],
 ['RF with a position',{...projection,Modality:'RF',SOPClassUID:'1.2.840.10008.5.1.4.1.1.12.2',ImagerPixelSpacing:[.3,.3],ImagePositionPatient:'0\\0\\0'},[.3,.3],/검출기/],
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
// Outside the projection list (other modalities, functional groups, detector information, an orientation, spacing tags that
// are empty, zero or malformed) nothing changes: the geometry keeps the default plane it always had ([1,0,0,0,1,0] at
// [0,0,0]) and the same answer in the browser and on the server, so what was refused stays refused and what was measured
// gives the same value.
test('images outside the projection list keep the geometry they had',()=>{
 const regions={SequenceOfUltrasoundRegions:[{RegionSpatialFormat:1,PhysicalUnitsXDirection:3,PhysicalUnitsYDirection:3,PhysicalDeltaX:.02,PhysicalDeltaY:.02,RegionLocationMinX0:0,RegionLocationMinY0:0,RegionLocationMaxX1:299,RegionLocationMaxY1:199}]};
 const cr={...projection,Modality:'CR',SOPClassUID:'1.2.840.10008.5.1.4.1.1.1'};
 const outside=[
  {...projection,Modality:'US',SOPClassUID:'1.2.840.10008.5.1.4.1.1.6.1',PixelSpacing:[.5,.5]},
  {...projection,Modality:'US',SOPClassUID:'1.2.840.10008.5.1.4.1.1.6.1',...regions},
  {...projection,Modality:'US',SOPClassUID:'1.2.840.10008.5.1.4.1.1.6.1',PixelSpacing:[.5,.5],...regions},
  {...projection,Modality:'NM',SOPClassUID:'1.2.840.10008.5.1.4.1.1.20',NumberOfFrames:2,PixelSpacing:[1,1],DetectorInformationSequence:[{ImagePositionPatient:[0,0,0],ImageOrientationPatient:[0,1,0,0,0,-1]}]},
  {...projection,Modality:'OT',SOPClassUID:'1.2.840.10008.5.1.4.1.1.7',PixelSpacing:[.5,.5]},
  {...cr,PixelSpacing:null,ImagerPixelSpacing:[.2,.2]},
  {...cr,PixelSpacing:['0.000','0.000']},
  {...cr,ImagerPixelSpacing:[.2,.2],EstimatedRadiographicMagnificationFactor:0},
  {...cr,ImagerPixelSpacing:'0.2'},
  {...cr,PixelSpacing:[.2,.2],EstimatedRadiographicMagnificationFactor:'2.00000000000000000'},
  {...cr,PixelSpacing:[.2,.2],EstimatedRadiographicMagnificationFactor:'\t2'},
  {...cr,PixelSpacing:'0.2\\0.2',ImagePositionPatient:'0\\0\\0x1'},
  {...cr,PixelSpacing:'0.2\\0.2',ImagePositionPatient:[0,0]},
  {...cr,PixelSpacing:[.2,.2],NumberOfFrames:'0000000000001'},
  {...projection,Modality:'XA',SOPClassUID:'1.2.840.10008.5.1.4.1.1.12.1',NumberOfFrames:2,ImagerPixelSpacing:[.25,.5]},
  {...projection,Modality:'RF',SOPClassUID:'1.2.840.10008.5.1.4.1.1.12.2',NumberOfFrames:'3',ImagerPixelSpacing:[.3,.3]},
  {...cr,PixelSpacing:[.2,.2],EstimatedRadiographicMagnificationFactor:'0x2'},
  {...cr,ImagerPixelSpacing:'Infinity\\Infinity'},
  {...cr,PixelSpacing:'0x1\\0x1'},
  {...cr},
  {...projection,Modality:'XA',SOPClassUID:'1.2.840.10008.5.1.4.1.1.12.1.1',NumberOfFrames:1,PerFrameFunctionalGroupsSequence:[{PixelMeasuresSequence:[{PixelSpacing:[.3,.3]}]}]},
  {...cr,PixelSpacing:[.5,.5],ImageOrientationPatient:[1,0,0,0,1,0],ImagePositionPatient:[0,0,0]},
 ];
 for(const tags of outside){
  assert.equal(context.kinViewerPlaneImage(tags),false,JSON.stringify(tags));assert.equal(viewerPlaneImage(tags),false,JSON.stringify(tags));
  const make=[()=>context.kinPlanarGeometry(tags,1),()=>planarGeometry(tags,1)];
  const built=make.map(f=>{try{return f();}catch(_){return null;}});
  assert.equal(!!built[0],!!built[1],JSON.stringify(tags));
  for(const geometry of built.filter(Boolean)){
   assert.equal(geometry.viewerPlane,false);
   assert.deepEqual([...geometry.orientation],tags.ImageOrientationPatient||[1,0,0,0,1,0]);assert.deepEqual([...geometry.origin],(typeof tags.ImagePositionPatient==='string'?tags.ImagePositionPatient.split('\\').map(Number):tags.ImagePositionPatient)||[0,0,0]);
  }
 }
});
test('projection images without a usable spacing still measure nothing',()=>{
 for(const tags of [{...projection,Modality:'CR',SOPClassUID:'1.2.840.10008.5.1.4.1.1.1'},{...projection,Modality:'CR',SOPClassUID:'1.2.840.10008.5.1.4.1.1.1',PixelSpacing:['0.000','0.000']},{...projection,Modality:'CR',SOPClassUID:'1.2.840.10008.5.1.4.1.1.1',ImagerPixelSpacing:[.2,.2],EstimatedRadiographicMagnificationFactor:0}]){
  assert.throws(()=>context.kinPlanarGeometry(tags,1),/원본 프레임의 좌표·간격·보정을 확인할 수 없습니다/);
  assert.throws(()=>planarGeometry(tags,1),/원본 프레임의 좌표·간격·보정을 확인할 수 없습니다/);
 }
});
// A Length on an ultrasound image without spacing, orientation or functional groups: the viewer shows pixel (x, y) of frame
// f at [0, x, z0 - y] (z0 = 0 for one frame, f for a multi-frame image: the pinned OHIF combineFrameInstance), and the mm
// come from the deltas (cm) of the Region Calibration that holds both points (DICOM PS3.3 C.8.5.5). Hand-computed values.
test('Length inside an ultrasound region is measured with that region\'s deltas, the same in the browser, on the server and in the SR',()=>{
 const region=(x0,x1,dx,dy,extra={})=>({RegionSpatialFormat:1,RegionDataType:1,PhysicalUnitsXDirection:3,PhysicalUnitsYDirection:3,PhysicalDeltaX:dx,PhysicalDeltaY:dy,
  RegionLocationMinX0:x0,RegionLocationMinY0:0,RegionLocationMaxX1:x1,RegionLocationMaxY1:199,...extra});
 const us={...projection,Modality:'US',SOPClassUID:'1.2.840.10008.5.1.4.1.1.6.1',SequenceOfUltrasoundRegions:[region(0,149,.02,.03),region(150,299,'0.05','0.04')]};
 const at=(x,y,z0=0)=>[0,x,z0-y];
 const ask=(tags,frame,kind,points,value)=>viewerCommand(Buffer.from(JSON.stringify({requestId:'00000000-0000-4000-8000-000000000003',item:{schemaVersion:1,kind,seriesUid:tags.SeriesInstanceUID,sopUid:tags.SOPInstanceUID,
  frame,frameOfReferenceUid:null,label:'Manual',points,viewPlaneNormal:[-1,0,0],viewUp:[0,0,1],baseline:{calculator:'kin-planar-manual-v1:us',values:[value]}}})),true).item;
 const cases=[
  // One frame, the left region: (20,20)→(50,60) → hypot(30×0.2, 40×0.3) = hypot(6, 12) mm.
  [us,1,[at(20,20),at(50,60)],Math.hypot(6,12),[20.5,20.5,50.5,60.5]],
  // The right region, its own deltas: (160,10)→(190,50) → hypot(30×0.5, 40×0.4) = hypot(15, 16) mm.
  [us,1,[at(160,10),at(190,50)],Math.hypot(15,16),[160.5,10.5,190.5,50.5]],
  // Frame 2 of a cine without a position: the frame's origin [0,0,2].
  [{...us,SOPClassUID:'1.2.840.10008.5.1.4.1.1.3.1',NumberOfFrames:'2'},2,[at(20,20,2),at(50,60,2)],Math.hypot(6,12),[20.5,20.5,50.5,60.5]],
  // A position of its own (the browser's combined instance carries the frame origin so): that origin.
  [{...us,ImagePositionPatient:'0\\0\\7'},1,[at(20,20,7),at(50,60,7)],Math.hypot(6,12),[20.5,20.5,50.5,60.5]],
  // Two regions over the same pixels with the same deltas: the same value.
  [{...us,SequenceOfUltrasoundRegions:[region(0,299,.02,.03),region(0,149,'0.020','0.030')]},1,[at(20,20),at(50,60)],Math.hypot(6,12),[20.5,20.5,50.5,60.5]],
 ];
 for(const [tags,frame,points,expected,graphic] of cases){
  const browser=context.kinManualGeometry(tags,frame,'length'),server=manualGeometry(tags,frame,'length');
  for(const geometry of [browser,server]){
   assert.equal(geometry.calculator,'kin-planar-manual-v1:us');assert.equal(geometry.label,'US Region Calibration');assert.equal(geometry.viewerPlane,true);
   assert.ok(Math.abs(geometry.measure('length',points)-expected)<1e-9,JSON.stringify([tags.NumberOfFrames,points]));
  }
  const item=ask(tags,frame,'length',points,expected);
  verifyViewerReference(tags.StudyInstanceUID,item,tags);
  assert.throws(()=>verifyViewerReference(tags.StudyInstanceUID,{...item,baseline:{...item.baseline,values:[expected+.01]}},tags),/저장값이 일치하지 않습니다/);
  const computed=srMeasurement(item,tags);
  assert.ok(Math.abs(computed.values[0]-expected)<1e-9);assert.equal(computed.basis,'US Region Calibration');
  computed.graphic.forEach((n,i)=>assert.ok(Math.abs(n-graphic[i])<1e-9,'graphic '+JSON.stringify(computed.graphic)));
  const dataset=srDataset('sr-us',tags.StudyInstanceUID,'Reader','reader',new Date('2026-11-21'),[{head:{id:'m-us',revision:1,snapshot:item},tags,computed}],1);
  const numeric=dataset.ContentSequence.at(-1).ContentSequence[0].ContentSequence.filter(node=>node.ValueType==='NUM');
  assert.equal(numeric[0].MeasuredValueSequence.MeasurementUnitsCodeSequence.CodeValue,'mm');
 }
 // Frame 2's points read on frame 1 (origin [0,0,1]) are a row off.
 const cine={...us,SOPClassUID:'1.2.840.10008.5.1.4.1.1.3.1',NumberOfFrames:'2'};
 for(const geometry of [context.kinManualGeometry(cine,1,'length'),manualGeometry(cine,1,'length')])
  assert.deepEqual([...geometry.imagePoint(at(20,20,2))],[20,19]);
 // Refused: one end in each region, a point outside every region, regions of different deltas over the same pixels, the
 // same point twice, a point off the plane.
 const refused=[
  [us,[at(100,20),at(200,20)],/초음파 보정 영역 안에서만 mm로 잴 수 있습니다/],
  [{...us,SequenceOfUltrasoundRegions:[region(0,149,.02,.03)]},[at(100,20),at(200,20)],/초음파 보정 영역 안에서만 mm로 잴 수 있습니다/],
  [{...us,SequenceOfUltrasoundRegions:[region(0,299,.02,.03),region(0,149,.02,.04)]},[at(20,20),at(50,60)],/초음파 보정 영역 안에서만 mm로 잴 수 있습니다/],
  [us,[at(20,20),at(20,20)],/원본 프레임의 좌표·간격·보정을 확인할 수 없습니다/],
  [us,[[1,20,-20],at(50,60)],/원본 프레임의 좌표·간격·보정을 확인할 수 없습니다/],
 ];
 for(const [tags,points,reason] of refused){
  assert.throws(()=>context.kinManualGeometry(tags,1,'length').measure('length',points),reason,JSON.stringify(points));
  assert.throws(()=>manualGeometry(tags,1,'length').measure('length',points),reason,JSON.stringify(points));
  assert.throws(()=>verifyViewerReference(tags.StudyInstanceUID,ask(tags,1,'length',points,10),tags));
 }
 // No usable region (deltas missing, a Doppler / M-mode region, units other than cm), spacing or an orientation of its own,
 // another tool: the rules it had (kinPlanarGeometry), the same in the browser and on the server.
 const planarOnly=[
  [{...us,SequenceOfUltrasoundRegions:[region(0,299,undefined,undefined)]},'length'],
  [{...us,SequenceOfUltrasoundRegions:[region(0,299,.02,.03,{RegionSpatialFormat:3,PhysicalUnitsYDirection:7})]},'length'],
  [{...us,SequenceOfUltrasoundRegions:[region(0,299,.02,.03,{RegionSpatialFormat:2,PhysicalUnitsXDirection:4})]},'length'],
  [{...us,PixelSpacing:[.5,.5]},'length'],
  [{...us,ImagerPixelSpacing:[.5,.5]},'length'],
  [{...us,ImageOrientationPatient:[1,0,0,0,1,0]},'length'],
  [us,'angle'],[us,'ellipse'],
 ];
 for(const [tags,kind] of planarOnly){
  const built=[()=>context.kinManualGeometry(tags,1,kind),()=>manualGeometry(tags,1,kind)].map(f=>{try{return f();}catch(error){return error.message;}});
  const before=[()=>context.kinPlanarGeometry(tags,1),()=>planarGeometry(tags,1)].map(f=>{try{return f();}catch(error){return error.message;}});
  for(const i of [0,1]){
   if(typeof before[i]==='string')assert.equal(built[i],before[i],JSON.stringify([kind,tags]));
   else assert.equal(built[i].calculator,before[i].calculator,JSON.stringify([kind,tags]));
  }
 }
 // The server takes an ultrasound region's calculator for a Length only.
 assert.throws(()=>ask(us,1,'angle',[at(20,20),at(30,20),at(30,40)],90),/완료된 측정값이 필요합니다/);
});
test('selected multiframe spacing and detector calibration remain explicit',()=>{
 const tags={...base,Modality:'XA',NumberOfFrames:2401,PerFrameFunctionalGroupsSequence:Array.from({length:2401},()=>({PixelMeasuresSequence:[{PixelSpacing:[1,2]}],PlanePositionSequence:[{ImagePositionPatient:[0,0,0]}],PlaneOrientationSequence:[{ImageOrientationPatient:[1,0,0,0,1,0]}]}))};
 tags.PerFrameFunctionalGroupsSequence[2400].PixelMeasuresSequence[0].PixelSpacing=[.5,.25];
 assert.deepEqual(planarGeometry(tags,2401).spacing,[.5,.25]);assert.throws(()=>planarGeometry(tags,2402));
 const detector={...base,Modality:'DX',PixelSpacing:undefined,ImagerPixelSpacing:[.2,.4]};
 assert.match(planarGeometry(detector,1).label,/검출기/);
 assert.throws(()=>planarGeometry({...detector,ImagerPixelSpacing:undefined},1));
});
// A CT Ellipse ROI is saved in HU when the original's values are HU: Rescale Type HU, or not given (the CT Image module's
// default, PS3.3 C.8.2.1) unless the acquisition is multi-energy; another Rescale Type, a Modality LUT or slope 0 is refused.
test('CT Ellipse ROI: HU unless the original names another rescale',()=>{
 const ct={StudyInstanceUID:'2.25.1',SeriesInstanceUID:'2.25.2',SOPInstanceUID:'2.25.3',SOPClassUID:'1.2.840.10008.5.1.4.1.1.2',Modality:'CT',Rows:128,Columns:128,
  PixelSpacing:['0.5','0.25'],ImagePositionPatient:['0','0','0'],ImageOrientationPatient:['1','0','0','0','1','0'],FrameOfReferenceUID:'2.25.9',RescaleSlope:'1',RescaleIntercept:'-1000'};
 const item=viewerCommand(Buffer.from(JSON.stringify({requestId:'00000000-0000-4000-8000-000000000002',item:{schemaVersion:1,kind:'ellipse',seriesUid:ct.SeriesInstanceUID,
  sopUid:ct.SOPInstanceUID,frame:1,frameOfReferenceUid:ct.FrameOfReferenceUID,label:'ROI',points:[[4,6,0],[4,2,0],[1,4,0],[7,4,0]],viewPlaneNormal:[0,0,1],viewUp:[0,-1,0],
  baseline:{calculator:'kin-native-manual-v1',values:[Math.PI*6,-1000,-1000,-1000,24]}}})),true).item;
 const omit=(tags,key)=>{const copy={...tags};delete copy[key];return copy;};
 for(const tags of [{...ct,RescaleType:'HU'},ct,{...ct,RescaleType:''},{...ct,RescaleType:' HU '},{...ct,MultienergyCTAcquisition:'NO'},{...ct,MultienergyCTAcquisition:'YES',RescaleType:'HU'}])
  assert.doesNotThrow(()=>verifyViewerReference(ct.StudyInstanceUID,item,tags),JSON.stringify(tags));
 for(const tags of [{...ct,RescaleType:'OD'},{...ct,RescaleType:'US'},{...ct,ModalityLUTSequence:[{}]},{...ct,RescaleSlope:'0'},{...ct,MultienergyCTAcquisition:'YES'},{...ct,Modality:'MR'}])
  assert.throws(()=>verifyViewerReference(ct.StudyInstanceUID,item,tags),/HU 보정을 확인할 수 없습니다|지원하지 않는 측정 보정입니다/,JSON.stringify(tags));
 for(const key of ['RescaleSlope','RescaleIntercept'])assert.throws(()=>verifyViewerReference(ct.StudyInstanceUID,item,omit(ct,key)),undefined,key);
});