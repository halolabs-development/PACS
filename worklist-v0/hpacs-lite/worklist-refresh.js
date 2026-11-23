/* Browser/account preference only; scheduling and list validation stay in main. */
(function(root) {
  'use strict';
  // Product words reach the screen through the screen-language write path (English only; otherwise as written).
  const kinSayEn = (t, ...p) => globalThis.KinLanguage?.sayEnglish ? globalThis.KinLanguage.sayEnglish(t, ...p)
    : t.replace(/\{(?:[ten]?(\d+)|([A-Za-z]\w*))\}/g, (m, i, n) => { const v = n !== undefined ? (p[0] || {})[n] : p[i]; return v === undefined ? m : String(v && typeof v === 'object' ? (v.t ?? v.e ?? '') : v); });
  const kinWrite = (el, value, name) => { if (globalThis.KinLanguage?.write) return globalThis.KinLanguage.write(el, value, name); if (!el) return el; const text = String(value ?? ''); if (name === 'title' || name === 'placeholder') el[name] = text; else if (name) el.setAttribute(name, text); else el.textContent = text; return el; };
  const intervals = [0, 30, 60, 120, 300];
  function normalize(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).sort().join() === 'seconds,version' && value.version === 1
      && intervals.includes(value.seconds) ? {version:1,seconds:value.seconds} : null;
  }
  function mount({select, status, owner, changed}) {
    const bound = owner(), key = bound && 'kin-worklist-refresh:v1:' + bound;
    let seconds = 30, ended = false;
    try {
      const raw = key && root.localStorage.getItem(key);
      if (raw !== null && raw !== false && raw !== undefined) {
        const saved = typeof raw === 'string' && raw.length <= 100 && normalize(JSON.parse(raw));
        if (saved) seconds = saved.seconds;
        else kinWrite(status, kinSayEn("저장된 간격을 확인할 수 없어 기본 30초를 적용합니다."));
      }
    } catch (_) { kinWrite(status, kinSayEn("간격 설정을 불러오지 못했습니다. 현재 창에서 선택할 수 있습니다.")); }
    select.value = String(seconds); select.disabled = !bound;
    select.addEventListener('change', () => {
      if (ended || !bound || owner() !== bound) { select.disabled = true; return; }
      const value = normalize({version:1,seconds:Number(select.value)});
      if (!value) { select.value = String(seconds); return; }
      seconds = value.seconds;
      try {
        root.localStorage.setItem(key, JSON.stringify(value));
        kinWrite(status, seconds ? kinSayEn("이 브라우저의 계정에 간격을 저장했습니다.") : kinSayEn("자동 목록 갱신을 멈췄습니다. Refresh로 직접 갱신할 수 있습니다."));
      } catch (_) { kinWrite(status, kinSayEn("간격을 저장하지 못했습니다. 현재 창에만 적용합니다.")); }
      changed();
    });
    root.addEventListener('pagehide', () => { ended = true; select.disabled = true; }, {once:true});
    return {seconds:() => !ended && bound && owner() === bound ? seconds : 30};
  }
  const api = {normalize,mount};
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinWorklistRefresh = api;
})(typeof window === 'object' ? window : null);
