
/* S5-UI5 (VUI-04). 고정 뷰어 도구막대의 이름과 설명: aria-label은 영어 이름, title은 한국어 설명이다. 도구 ID·data-cy·명령·
   순서·단축키는 뷰어의 것이라 DOM 속성만 붙인다. 켜고 끄는 도구에는 켜짐 상태(aria-pressed)와 title의 "사용 중"을 더해 색에만
   기대지 않게 한다. 뷰어가 이미 aria-pressed를 주는 버튼은 그 값을 그대로 둔다. 같은 값이면 쓰지 않으므로 여러 번 불러도
   속성 변경이 생기지 않고, 도구막대가 다시 그려지면(계정 도구막대 적용·writer가 아닌 문서의 도구막대 줄이기 포함) 새 버튼에 다시 붙는다.
   분할 버튼의 목록 항목처럼 글자가 보이는 항목은 보이는 이름을 aria-label로 써서 화면 글자와 읽히는 이름이 어긋나지 않게 한다. */
const kinViewerToolbarLabels = (() => {
  // Also run on its own (a page test takes this function out of config/ohif.js): the words then stay as written.
  const kinText = globalThis.kinText || ((t, ...p) => t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i]))), kinHtml = globalThis.kinHtml || kinText, kinError = globalThis.kinError || ((t, ...p) => Object.assign(new Error(kinText(t, ...p)), { kinWords: true }));
  const PRIMARY = {
    MeasurementTools: ['Measurements', kinText("측정 도구")],
    Zoom: ['Zoom', kinText("확대/축소")],
    Pan: ['Pan', kinText("이동")],
    TrackballRotate: ['3D Rotate', kinText("3D 회전(볼륨에서만 동작)")],
    WindowLevel: ['Window / Level', kinText("창/레벨 조절(드래그)")],
    // The pinned download form passes 'jpg'/'png' to canvas.toDataURL, which only knows MIME types, so every
    // choice writes PNG bytes; a jpg choice changes the file name only.
    Capture: ['Capture', kinText("선택한 영상 칸의 화면을 PNG 이미지로 다운로드 · File Type을 jpg로 두어도 파일 내용은 PNG입니다 · DICOM 원본·판독문·서버 작업 저장 아님 · 식별정보가 포함될 수 있습니다. Image Text/Images Only는 익명화가 아닙니다.")],
    Layout: ['Layout', kinText("화면 배치")],
    Crosshairs: ['Crosshairs', kinText("MPR 교차선(3D/MPR에서만 동작)")],
    MoreTools: ['More Tools', kinText("기타 도구")],
  };
  const ITEMS = {
    Length: ['Length', kinText("길이")],
    Bidirectional: ['Bidirectional', kinText("장축·단축 길이")],
    ArrowAnnotate: ['Arrow', kinText("화살표 주석")],
    EllipticalROI: ['Ellipse ROI', kinText("타원 ROI(HU)")],
    RectangleROI: ['Rectangle ROI', kinText("사각형 ROI")],
    CircleROI: ['Circle ROI', kinText("원형 ROI")],
    PlanarFreehandROI: ['Freehand ROI', kinText("자유곡선 ROI")],
    SplineROI: ['Spline ROI', kinText("스플라인 ROI")],
    LivewireContour: ['Livewire Contour', kinText("라이브와이어 윤곽")],
    Reset: ['Reset', kinText("재설정(현재 영상 칸의 화면 조작을 처음으로)")],
    'rotate-right': ['Rotate Right', kinText("시계 방향 90° 회전")],
    flipHorizontal: ['Flip Horizontal', kinText("좌우 반전")],
    ImageSliceSync: ['Image Slice Sync', kinText("영상 칸 사이 단면 위치 맞춤")],
    ReferenceLines: ['Reference Lines', kinText("기준선 표시")],
    ImageOverlayViewer: ['Image Overlay', kinText("영상 오버레이 표시")],
    StackScroll: ['Stack Scroll', kinText("영상 넘기기(드래그)")],
    invert: ['Invert', kinText("흑백 반전")],
    Probe: ['Probe', kinText("한 지점의 값 확인")],
    Cine: ['Cine', kinText("연속 재생")],
    Angle: ['Angle', kinText("각도")],
    CobbAngle: ['Cobb Angle', kinText("Cobb 각도")],
    Magnify: ['Magnify', kinText("돋보기")],
    CalibrationLine: ['Calibration Line', kinText("길이 보정선")],
    TagBrowser: ['Tag Browser', kinText("DICOM 태그 보기")],
    AdvancedMagnify: ['Magnify Probe', kinText("고급 돋보기")],
    UltrasoundDirectionalTool: ['Ultrasound Directional', kinText("초음파 방향 측정")],
    WindowLevelRegion: ['Window Level Region', kinText("영역 창/레벨")],
  };
  // 누르면 켜지고 다른 도구를 고르면 꺼지는 버튼. Capture·Layout·More Tools는 동작·목록이라 켜짐 상태가 없다.
  const TOGGLES = new Set(['MeasurementTools', 'Zoom', 'Pan', 'TrackballRotate', 'WindowLevel', 'Crosshairs']);
  const ACTIVE = 'bg-primary-light';
  const put = (element, name, value) => { if (element.getAttribute(name) !== value) element.setAttribute(name, value); };
  const shown = element => element.nodeType === 1
    ? (element.localName === 'svg' ? '' : [...element.childNodes].map(shown).join('')) : element.nodeType === 3 ? element.data : '';
  // data-cy 하나가 가리키는 것: 주 도구막대 버튼, 분할 버튼의 주/목록 부분, 또는 분할 버튼 목록의 항목.
  function entry(cy) {
    const split = /^(.+)-split-button-(primary|secondary)$/.exec(cy || '');
    const id = split ? split[1] : cy;
    if (Object.hasOwn(PRIMARY, id)) {
      const [name, description] = PRIMARY[id];
      return split?.[2] === 'secondary'
        ? { id, name: name + ' Menu', description: kinText("{0} 목록 열기", description), toggle: false, item: false }
        : { id, name, description, toggle: TOGGLES.has(id), item: false };
    }
    if (!split && Object.hasOwn(ITEMS, id)) { const [name, description] = ITEMS[id]; return { id, name, description, toggle: false, item: true }; }
    return null;
  }
  function apply(scope) {
    for (const element of scope.querySelectorAll('*')) {
      const found = entry(element.getAttribute('data-cy'));
      if (!found) continue;
      const visible = found.item ? shown(element).trim() : '';
      let active = false;
      if (found.toggle) {
        const nativePressed = element.hasAttribute('aria-pressed') && !element.hasAttribute('data-kin-pressed');
        active = nativePressed ? element.getAttribute('aria-pressed') === 'true'
          : (element.getAttribute('class') || '').split(/\s+/).includes(ACTIVE);
        if (!nativePressed) { put(element, 'aria-pressed', String(active)); put(element, 'data-kin-pressed', ''); }
      }
      put(element, 'aria-label', visible || found.name);
      put(element, 'title', found.description + (active ? kinText(" · 사용 중") : ''));
      // viewer-tech-note.js의 Zoom 진입 보완이 정리할 때 이 이름을 자기 것으로 알고 지우지 않게 표시한다.
      put(element, 'data-kin-tool-label', found.id);
    }
  }
  // The Viewer-UX toolbar owns its button title (name, shortcut, drag hint); the output meaning goes in front of it.
  function outputScope(scope) {
    const meaning = PRIMARY.Capture[1];
    for (const button of scope.querySelectorAll('[data-tool="Capture"]')) {
      const title = button.getAttribute('title') || '';
      if (!title.startsWith(meaning)) put(button, 'title', meaning + (title ? ' · ' + title : ''));
    }
  }
  return { PRIMARY, ITEMS, TOGGLES, entry, apply, outputScope };
})();
