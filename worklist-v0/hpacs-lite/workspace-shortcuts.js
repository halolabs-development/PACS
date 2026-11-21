/* Only explicit workspace chords are configurable; no clinical data enters preferences.
 * Resolving a chord never cancels a browser command: the caller must actually run it. */
(function (root) {
  'use strict';
  // A sentence of the page built from its template and its parts ({t: words}); written so the screen language reads it.
  const kinSay = (typeof window !== 'undefined' && window.KinLanguage && window.KinLanguage.say) || ((t, ...p) => t.replace(/\{(?:[ten]?(\d+)|([A-Za-z]\w*))\}/g, (m, i, n) => { const v = n !== undefined ? (p[0] || {})[n] : p[i]; return v === undefined ? m : String(v && typeof v === 'object' ? (v.t ?? v.e ?? '') : v); })), kinSayEn = (typeof window !== 'undefined' && window.KinLanguage && window.KinLanguage.sayEnglish) || kinSay;
  const kinWrite = (el, value, name) => { if (typeof window !== 'undefined' && window.KinLanguage) return window.KinLanguage.write(el, value, name); if (name) el.setAttribute(name, value); else el.textContent = value; return el; };  const defaults = Object.freeze({list:'Digit1',image:'Digit2',prior:'Digit3',report:'Digit4',context:'Digit5',note:'Digit6',tools:'Digit7',nativeTools:'Digit9',previous:'ArrowLeft',next:'ArrowRight'});
  const labels = {list:'Worklist',image:'Image',prior:'Related Report',report:'Report Editor',context:'Study Info & Templates',note:'Image Tech Note',tools:'Tool Panels',nativeTools:'Viewer Toolbar',previous:'Previous Study',next:'Next Study',finalize:'Finalize (Approve)',finalizeNext:'Finalize & Next (Approve & Next)'};
  // Finalize & Next (the Approve & Next button) has no key until the reader gives it one; a map saved before it existed has no entry.
  const defaultsV2 = Object.freeze({version:2,...Object.fromEntries(Object.entries(defaults).map(([id,key])=>[id,'Control+Alt+'+key])),finalize:'Control+KeyS',finalizeNext:null});
  const ids = Object.keys(labels);
  const optional = (value,id) => id!=='finalizeNext'||Object.hasOwn(value,id);
  const prefix = 'kin-workspace-shortcuts:v2:', legacyPrefix = 'kin-workspace-shortcuts:v1:';
  const chord = key => typeof key==='string' && (/^Control\+Alt\+(Digit[1-9]|Key[A-Z]|ArrowLeft|ArrowRight)$/.test(key) && !['Control+Alt+KeyC','Control+Alt+Digit8'].includes(key) || key==='Control+KeyS');
  function valid(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const v2=value.version===2, present=v2?ids.filter(id=>optional(value,id)):Object.keys(defaults), names=v2?['version',...present]:present;
    if(Object.keys(value).sort().join(',')!==names.slice().sort().join(','))return false;
    const used = new Set();
    return present.every(id => {
      const key = value[id];
      if(v2&&key===null)return true;
      if (!(v2?chord(key):typeof key==='string'&&/^(Digit[1-9]|Key[A-Z]|ArrowLeft|ArrowRight)$/.test(key)&&!['KeyC','Digit8'].includes(key)) || used.has(key)) return false;
      used.add(key); return true;
    });
  }
  const unassigned = () => ({map:{version:2,...Object.fromEntries(ids.map(id=>[id,null]))},notices:['저장된 단축키를 확인할 수 없어 미배정으로 두었습니다. Shortcuts에서 확인하세요.']});
  const scope = id => ['image','note','tools','nativeTools'].includes(id)?'Viewer':'Worklist';
  function migrate(value) {
    if(value===null)return {map:{...defaultsV2},notices:[]};
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.hasOwn(value,'version')&&value.version!==2)return unassigned();
    const map={version:2},notices=[],used=new Map(),source=value;
    for(const id of ids){
      if(id==='finalize'&&!Object.hasOwn(source,'version')&&!Object.hasOwn(source,id))continue;
      if(!optional(source,id)){map[id]=null;continue;}
      const raw=source[id];
      const key=source.version===2?raw:typeof raw==='string'?'Control+Alt+'+raw:null;
      map[id]=chord(key)&&!used.has(key)?key:null;
      if(map[id])used.set(key,id);
      else if(raw!==null||source.version!==2)notices.push(labels[id]+': 알 수 없거나 중복된 키를 미배정으로 두었습니다. Shortcuts에서 지정하세요.');
    }
    if(!Object.hasOwn(map,'finalize')){
      const key=defaultsV2.finalize;
      map.finalize=used.has(key)?null:key;
      if(used.has(key))notices.push(display(key)+'는 이미 '+labels[used.get(key)]+'에 지정됨 — Shortcuts에서 지정하세요.');
    }
    return {map,notices};
  }
  const display = code => code ? (code.includes('+')?code:'Control+Alt+'+code).replace(/Digit|Key/g,'') : 'Unassigned';
  const eventChord = e => e.ctrlKey&&!e.shiftKey&&!e.metaKey ? 'Control+'+(e.altKey?'Alt+':'')+e.code : null;
  function action(map, e) {
    if (!map || e.defaultPrevented || e.repeat || e.isComposing || e.keyCode===229 || e.getModifierState?.('AltGraph')) return null;
    const key=eventChord(e);if(!chord(key))return null;
    return ids.find(id => map[id] && (map.version===2?map[id]:'Control+Alt+'+map[id])===key) || null;
  }
  function create({host, owner, allowed, changed}) {
    const work=root.KinWorkContext,transport=root.KinSessionTransport.page();
    const storage=()=>{try{return root.localStorage;}catch(_){return undefined;}};
    const d = host.ownerDocument;
    const el = (tag, text, parent) => { const n = d.createElement(tag); kinWrite(n, text); parent?.append(n); return n; };
    let map = {...defaultsV2}, currentOwner = null, ended = false, draftOwner = null, baseline = null;
    let accountRequest=null, accountEpoch=0, accountRevision=null, accountBusy=false;
    const edit = el('button','Edit Shortcuts',host); edit.type='button'; edit.className='chip'; edit.id='workspace-shortcuts-edit';
    const status = el('span','',host); status.id='workspace-shortcuts-status'; status.setAttribute('role','status');
    // Its place in the bar (one line kept for it, beside the buttons where the bar has room) is reading-workspace.css's.
    const dialog = el('dialog','',d.body); dialog.id='workspace-shortcuts-dialog'; dialog.style.cssText='max-height:85vh;overflow:auto;width:640px;max-width:95vw;box-sizing:border-box;padding:20px;background:#111c2f;color:#d6e6ff;border:1px solid #718eaa;border-radius:8px';
    // One look for every key field of the dialog (the work page's keys and the viewer's image tool keys).
    const fieldCss='box-sizing:border-box;width:100%;padding:6px;background:#0b1320;color:inherit;border:1px solid #718eaa;border-radius:4px';
    const title = el('h2','Workspace Shortcuts',dialog); title.id='workspace-shortcuts-title'; dialog.setAttribute('aria-labelledby',title.id);
    el('p',kinSayEn('이 브라우저의 현재 계정에 저장합니다. Ctrl+Alt 조합 또는 Ctrl+S를 지정하세요. Ctrl+Alt+C(환자 ID 복사), Ctrl+Alt+8(영상 배치)과 나머지 브라우저·입력 키는 예약되어 있습니다. Backspace/Delete로 미배정할 수 있습니다. Viewer 창의 새 Ctrl+Alt 키는 다음 열기부터 적용하며 열린 창은 현재 키를 유지합니다.'),dialog);
    const tabs=el('div','',dialog);tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Shortcut scope');
    const panels={},tabButtons={};
    function showTab(name,focus=false){for(const key of Object.keys(panels)){const active=key===name;panels[key].hidden=!active;tabButtons[key].setAttribute('aria-selected',String(active));tabButtons[key].tabIndex=active?0:-1;}if(focus)tabButtons[name].focus();}
    for(const name of ['Worklist','Viewer']){
      const tab=el('button',name,tabs);tab.type='button';tab.id='workspace-shortcuts-tab-'+name.toLowerCase();tab.setAttribute('role','tab');
      const panel=el('div','',dialog);panel.id=tab.id+'-panel';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);tab.setAttribute('aria-controls',panel.id);panels[name]=panel;tabButtons[name]=tab;
      tab.onclick=()=>showTab(name);
      tab.onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();showTab(e.key==='Home'?'Worklist':e.key==='End'?'Viewer':name==='Worklist'?'Viewer':'Worklist',true);}};
    }
    showTab('Worklist');
    const fields = {};
    for (const id of ids) {
      const row=el('label',labels[id],panels[scope(id)]); row.style.cssText='display:grid;grid-template-columns:minmax(100px,1fr) minmax(130px,1fr);align-items:center;gap:12px;margin:8px 0';
      const field=el('input','',row);field.readOnly=true;field.id='workspace-shortcut-'+id;kinWrite(field,kinSay('{t0} 단축키',kinSay(labels[id])),'aria-label');field.style.cssText=fieldCss;fields[id]=field;
      field.onkeydown=e=>{
        if (e.key==='Tab'||e.key==='Escape') return;
        e.preventDefault();e.stopPropagation();
        if(e.repeat||e.isComposing||e.getModifierState('AltGraph'))return;
        if(!e.ctrlKey&&!e.altKey&&!e.shiftKey&&!e.metaKey&&['Backspace','Delete'].includes(e.key)){field.dataset.code='';field.value=display(null);kinWrite(message, kinSay('미배정했습니다. 적용하려면 저장하세요.'));return;}
        const key=eventChord(e);
        if(!chord(key)) { kinWrite(message, kinSay('예약 키입니다. Ctrl+Alt와 숫자 1~9(8 제외), 영문(C 제외), 좌우 방향키 또는 Ctrl+S를 사용하세요.'));return; }
        field.dataset.code=key;field.value=display(key);kinWrite(message, kinSay('적용 전에 중복 단축키를 확인합니다.'));
      };
    }
    // The image tool keys of the Viewer windows, in the Viewer tab: one key each, kept in the account (viewerSettings.shortcuts
    // of the same record), the very value the viewer's own Viewer Settings edits. Each read of the account below gives them
    // as the viewer reads them (viewer-ux-shortcuts.js current); a press is read as the viewer reads it (pressed). Until an
    // answer is in, they cannot be changed. The tools are every one a Viewer window offers a key for, and any other the
    // account holds a key for.
    const viewerKeys=root.KinViewerUXShortcuts?.pressed?root.KinViewerUXShortcuts:null, toolFields={};
    let toolBase=null, toolRows=null, toolStatus=null;
    if(viewerKeys){
      const heading=el('h3','Image Tool Keys',panels.Viewer);heading.id='workspace-viewer-keys-title';heading.style.cssText='margin:16px 0 4px;font-size:15px';
      el('p','별도 Viewer 창에서 입력 칸 밖에서 누르는 영상 도구 키입니다(영문자·숫자 한 개 또는 Shift+영문자). 계정에 저장되어 다른 PC에도 적용되고, 저장하면 이 브라우저에 열린 Viewer 창에도 바로 적용됩니다. 판독 화면 안에 붙은 영상은 뷰어 기본 키를 씁니다.',panels.Viewer);
      toolStatus=el('p','',panels.Viewer);toolStatus.id='workspace-viewer-keys-status';toolStatus.setAttribute('role','status');
      toolRows=el('div','',panels.Viewer);toolRows.id='workspace-viewer-keys';toolRows.setAttribute('role','group');toolRows.setAttribute('aria-labelledby',heading.id);
    }
    const toolName=id=>viewerKeys.names[id]||id;
    const toolDraft=()=>Object.fromEntries(Object.entries(toolFields).map(([id,f])=>[id,f.dataset.key||null]));
    const toolChanged=()=>!!toolBase&&Object.entries(toolDraft()).some(([id,key])=>(toolBase.map[id]??null)!==key);
    // The rows for an account answer: the tools a Viewer window offers keys for, then any other tool the account keeps.
    function fillTools(values){
      if(!toolRows)return;
      toolRows.replaceChildren();for(const id of Object.keys(toolFields))delete toolFields[id];
      // No rows before the account's answer: an empty key there would read as "no key".
      if(!toolBase)return;
      for(const id of [...new Set([...Object.keys(viewerKeys.names),...Object.keys(toolBase?.map||{})])]){
        const row=el('label','',toolRows);row.style.cssText='display:grid;grid-template-columns:minmax(100px,1fr) minmax(130px,1fr);align-items:center;gap:12px;margin:6px 0';
        // A viewer tool's name as the viewer shows it (its own words, not this page's), so it is not translated here.
        const name=d.createElement('span');name.textContent=toolName(id);name.setAttribute('translate','no');row.append(name);
        const field=el('input','',row);field.readOnly=true;field.id='workspace-viewer-key-'+id;field.dataset.tool=id;
        kinWrite(field,kinSay('{0} 단축키',toolName(id)),'aria-label');field.style.cssText=fieldCss;
        setTool(field,values?.[id]??null);toolFields[id]=field;
        field.onkeydown=e=>{
          if(e.key==='Tab'||e.key==='Escape')return;
          e.preventDefault();e.stopPropagation();
          if(field.disabled||e.repeat||e.isComposing||e.getModifierState?.('AltGraph'))return;
          if(!e.ctrlKey&&!e.altKey&&!e.shiftKey&&!e.metaKey&&['Backspace','Delete'].includes(e.key)){setTool(field,null);kinWrite(message, kinSay('미배정했습니다. 적용하려면 저장하세요.'));return;}
          const key=viewerKeys.pressed(e);
          if(!key){kinWrite(message, kinSay('영상 도구 키는 영문자·숫자 한 개 또는 Shift+영문자입니다. Backspace/Delete로 미배정할 수 있습니다.'));return;}
          setTool(field,key);kinWrite(message, kinSay('적용 전에 중복 단축키를 확인합니다.'));
        };
      }
      refreshTools();
    }
    function setTool(field,key){field.dataset.key=key||'';field.value=key?viewerKeys.display(key):display(null);}
    function refreshTools(){for(const field of Object.values(toolFields))field.disabled=!toolBase||accountBusy||!dialog.open;}
    // The account's answer for the tool keys; a missing or unreadable viewerSettings is the viewer's defaults (as the viewer reads it).
    function takeTools(data){
      if(!toolRows)return;
      const settings=data.viewerSettings&&typeof data.viewerSettings==='object'&&!Array.isArray(data.viewerSettings)&&data.viewerSettings.shortcuts&&typeof data.viewerSettings.shortcuts==='object'?data.viewerSettings:null;
      toolBase={settings,map:viewerKeys.current(settings)};fillTools(toolBase.map);kinWrite(toolStatus, kinSay('계정의 영상 도구 키입니다.'));
    }
    // Tool keys the draft gives twice, by name; none when every key is used once.
    const toolConflicts=()=>{const draft=toolDraft();return Object.keys(draft).filter(id=>draft[id]&&Object.keys(draft).some(other=>other!==id&&draft[other]===draft[id]));};
    // The viewer settings to save: the account's as read (bar, mammography, hanging, features and the rest kept), its keys
    // as the viewer reads them with the draft's on top; an account without viewer settings starts from the viewer's defaults.
    function viewerNext(){
      const base=toolBase.settings||{version:2,bar:[...viewerKeys.defaultBar],shortcuts:{}};
      return {...base,version:2,shortcuts:{...viewerKeys.current(toolBase.settings),...toolDraft()}};
    }
    // Open Viewer windows of this account in this browser read the new revision (viewer-ux-toolbar.js listens).
    function announce(bound,revision){try{const channel=new root.BroadcastChannel('kin-viewer-settings');channel.postMessage({owner:bound,revision});channel.close();}catch(_){}}
    const message=el('p','',dialog);message.id='workspace-shortcuts-message';message.setAttribute('role','status');
    const button=(text,id,run)=>{const b=el('button',text,dialog);b.type='button';b.className='chip';b.style.marginRight='8px';b.id=id;b.onclick=run;return b;};
    const fill=value=>{for(const id of ids){fields[id].dataset.code=value[id]||'';fields[id].value=display(value[id]);}};
    const close=()=>{cancelAccount();dialog.close();draftOwner=null;refreshTools();if(!ended)edit.focus();};
    const draft=()=>({version:2,...Object.fromEntries(ids.map(id=>[id,fields[id].dataset.code||null]))});
    el('p',kinSayEn('계정에서 불러오면 아래 입력란에 채워집니다. 계정 저장은 표시된 키를 보관하며, 현재 브라우저에는 Apply & Save로 적용하세요.'),dialog);
    const accountLoad=button(kinSay('Load from Account'),'workspace-shortcuts-account-load',()=>accountRun('load'));
    const accountSave=button(kinSay('Save to Account'),'workspace-shortcuts-account-save',()=>accountRun('save'));
    const accountStatus=el('p','',dialog);accountStatus.id='workspace-shortcuts-account-status';accountStatus.setAttribute('role','status');
    function refreshAccount(){accountLoad.disabled=ended||accountBusy||!dialog.open||!allowed()||owner()!==draftOwner;accountSave.disabled=accountLoad.disabled||accountRevision===null;refreshTools();}
    function cancelAccount(){accountEpoch++;accountRequest?.abort();accountRequest=null;accountRevision=null;accountBusy=false;}
    let interruptedAction=null;
    // action: 'inspect' (the read when the window opens: tool keys only), 'load', 'save' (Save to Account: the work-page keys,
    // and the tool keys when they changed, at one revision) or 'apply' (Apply & Save with changed tool keys: those go to the
    // account first; the work-page keys are applied to this browser only once the account took them).
    async function accountRun(action,local=null){
      if(work.state()!=='active')return;const at=work.capture('document');
      const writes=action==='save'||action==='apply';
      if(ended||accountBusy||!dialog.open||!allowed()||!draftOwner||owner()!==draftOwner||writes&&accountRevision===null)return;
      const snapshot=draft(), bound=draftOwner, ticket=++accountEpoch, tools=writes&&toolChanged();
      if(action==='save'&&!valid(snapshot)){
        const conflicts=ids.filter(id=>snapshot[id]&&ids.some(other=>other!==id&&snapshot[other]===snapshot[id]));
        kinWrite(accountStatus, kinSayEn("중복 단축키: {0}. 서로 다른 키로 지정하세요.", conflicts.map(id=>labels[id]+' ('+scope(id)+')').join(', ')));return;
      }
      if(tools&&toolConflicts().length){kinWrite(accountStatus, kinSay('중복 영상 도구 키: {0}. 서로 다른 키로 지정하세요.',toolConflicts().map(toolName).join(', ')));return;}
      const viewerSettings=tools?viewerNext():null;
      const body=action==='save'?{expectedOwner:JSON.parse(bound),revision:accountRevision,bindings:snapshot,...(tools?{viewerSettings}:{})}
        :action==='apply'?{expectedOwner:JSON.parse(bound),revision:accountRevision,viewerSettings}:null;
      const live=()=>!ended&&ticket===accountEpoch&&dialog.open&&allowed()&&owner()===bound&&draftOwner===bound;
      const controller=new AbortController();accountRequest=controller;accountBusy=true;interruptedAction=action;refreshAccount();
      const timeout=setTimeout(()=>controller.abort(),10000);kinWrite(accountStatus, kinSay('계정 단축키를 확인하는 중…'));
      try{
        const response=await transport.request('/api/workspace-shortcuts',{context:at,method:body?'PUT':'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
        if(!live())return;

        if(!response.ok)throw Error(response.status===409?'다른 창에서 설정이 바뀌었습니다. 불러온 뒤 다시 저장하세요.':'계정 설정을 확인하지 못했습니다. 다시 불러오세요.');
        const data=response.body;if(!live())return;
        // bindings null is "no work-page keys saved" at any revision: a record may hold only the viewer settings (C05).
        if(JSON.stringify(data.owner)!==bound||!Number.isInteger(data.revision)||data.revision<0||data.revision>2147483647||(data.revision===0?data.bindings!==null||data.invalid===true:data.bindings!==null&&!valid(data.bindings)))throw Error('계정 단축키 응답을 확인할 수 없습니다.');
        work.commit(at,()=>{
        if(action==='load'&&JSON.stringify(snapshot)!==JSON.stringify(draft())){accountRevision=null;kinWrite(accountStatus, kinSay('입력이 바뀌어 불러온 설정을 적용하지 않았습니다.'));return;}
        accountRevision=data.revision;
        if(tools)announce(bound,data.revision);
        // The tool keys are the account's at every answer (they cannot change while it is awaited).
        takeTools(data);
        if(action==='apply'){local(snapshot);return;}
        if(data.invalid===true){kinWrite(accountStatus, kinSay('저장된 단축키를 읽을 수 없습니다. 현재 입력으로 계정에 다시 저장할 수 있습니다.'));return;}
        if(action==='load'&&data.bindings!==null){const migrated=migrate(data.bindings);fill(migrated.map);message.textContent=migrated.notices.join(' ');kinWrite(accountStatus, kinSay('계정 단축키를 입력란에 불러왔습니다. Apply & Save로 적용하세요.'));}
        else if(action==='save')kinWrite(accountStatus, JSON.stringify(snapshot)===JSON.stringify(draft())?kinSay('단축키를 계정에 저장했습니다.'):kinSay('요청 당시 단축키를 저장했습니다. 이후 입력 변경은 저장되지 않았습니다.'));
        else kinWrite(accountStatus, data.bindings===null?kinSay('계정에 저장된 단축키가 없습니다.'):kinSay('계정 설정이 있습니다. 불러오면 입력란에 표시합니다.'));
        });
      }catch(e){work.commit(at,()=>{if(live()){accountRevision=null;kinWrite(accountStatus, e instanceof TypeError||e.name==='AbortError'?kinSay('응답을 확인하지 못했습니다. 입력은 유지했습니다. 다시 불러오세요.'):e instanceof SyntaxError?kinSay('계정 응답 형식을 확인하지 못했습니다.'):e.message);
        if(toolRows&&!toolBase)kinWrite(toolStatus, kinSay('계정의 영상 도구 키를 불러오지 못했습니다. Load from Account로 다시 불러오세요.'));
        else if(action==='apply')kinWrite(message, kinSay('영상 도구 키를 계정에 저장하지 못해 아무것도 적용하지 않았습니다. 입력은 유지했습니다.'));}});}
      finally{clearTimeout(timeout);if(ticket===accountEpoch){accountRequest=null;accountBusy=false;work.commit(at,()=>{interruptedAction=null;refreshAccount();});}}
    }
    button(kinSay('Defaults'),'workspace-shortcuts-default',()=>{
      fill(defaultsV2);
      // The viewer's own tools only: a key the account keeps for another tool stays as it is.
      if(toolBase)for(const [id,field] of Object.entries(toolFields))if(!field.disabled&&Object.hasOwn(viewerKeys.names,id))setTool(field,viewerKeys.defaults[id]??null);
      kinWrite(message, kinSay('기본값을 적용하려면 저장하세요.'));
    });
    button(kinSay('Cancel'),'workspace-shortcuts-cancel',close);
    // The work-page keys into this browser; false (with the reason said) when they were not stored.
    function applyLocal(next,toolsSaved){
      try {
        if(localBaseline(storage(),draftOwner)!==baseline){kinWrite(message, toolsSaved?kinSay('영상 도구 키는 계정에 저장했습니다. 작업 화면 키는 다른 창에서 설정이 바뀌어 적용하지 않았습니다. 취소 후 다시 열어 확인하세요.'):kinSay('다른 창에서 설정이 바뀌었습니다. 취소 후 다시 열어 확인하세요.'));return false;}
        storage().setItem(prefix+draftOwner,JSON.stringify(next));
      } catch (_) {kinWrite(message, toolsSaved?kinSay('영상 도구 키는 계정에 저장했습니다. 작업 화면 키는 이 브라우저에 저장하지 못했습니다. 다시 시도하세요.'):kinSay('설정을 저장하지 못했습니다. 입력을 유지했습니다. 다시 시도하세요.'));return false;}
      map=next;changed(map);
      kinWrite(status, toolsSaved?kinSay('단축키를 저장했습니다. 영상 도구 키는 열린 Viewer 창에도 적용되고, 작업 화면 키는 열린 Viewer 창에서 다음 열기부터 적용됩니다.'):kinSay('단축키를 저장했습니다. 열린 Viewer의 새 키는 다음 열기부터 적용됩니다.'));
      close();return true;
    }
    button(kinSay('Apply & Save'),'workspace-shortcuts-apply',()=>{
      if(ended||!allowed()||!draftOwner||owner()!==draftOwner){kinWrite(message, kinSay('계정이 바뀌었습니다. 창을 닫고 다시 확인하세요.'));return;}
      const next=draft();
      if(!valid(next)){
        const conflicts=ids.filter(id=>next[id]&&ids.some(other=>other!==id&&next[other]===next[id]));
        kinWrite(message, kinSayEn("중복 단축키: {0}. 서로 다른 키로 지정하세요.", conflicts.map(id=>labels[id]+' ('+scope(id)+')').join(', ')));return;
      }
      if(!toolChanged()){applyLocal(next,false);return;}
      if(accountBusy){kinWrite(message, kinSay('계정 단축키를 확인하는 중…'));return;}
      // Changed tool keys exist only in the account: they are saved there first, and nothing is applied if that fails.
      if(toolConflicts().length){kinWrite(message, kinSay('중복 영상 도구 키: {0}. 서로 다른 키로 지정하세요.',toolConflicts().map(toolName).join(', ')));return;}
      try{if(localBaseline(storage(),draftOwner)!==baseline){kinWrite(message, kinSay('다른 창에서 설정이 바뀌었습니다. 취소 후 다시 열어 확인하세요.'));return;}}catch(_){}
      if(accountRevision===null){kinWrite(message, kinSay('영상 도구 키를 저장하려면 먼저 Load from Account로 계정 설정을 불러오세요.'));return;}
      accountRun('apply',sent=>{
        if(JSON.stringify(sent)!==JSON.stringify(draft())){kinWrite(message, kinSay('영상 도구 키는 계정에 저장했습니다. 그 뒤 바뀐 작업 화면 키는 아직 적용하지 않았습니다. Apply & Save를 다시 누르세요.'));accountStatus.textContent='';return;}
        if(applyLocal(sent,true))accountStatus.textContent='';
      });
    });
    function sync() {
      if(ended)return;
      const next=allowed()?owner():null;edit.disabled=!next;
      if(next===currentOwner)return;
      cancelAccount();currentOwner=next;map={...defaultsV2};status.textContent='';
      if(dialog.open)dialog.close();
      if(next){const saved=readLocal(storage(),next);map=saved.map;status.textContent=saved.notices.join(' ');}
      changed(map);
    }
    edit.onclick=()=>{
      sync();if(!currentOwner||ended)return;
      draftOwner=currentOwner;
      try{baseline=localBaseline(storage(),draftOwner);}catch(_){baseline=null;}
      const saved=readLocal(storage(),draftOwner);map=saved.map;changed(map);
      // The tool keys come with the account's answer below; until then (and if it fails) they cannot be changed.
      toolBase=null;fillTools(null);if(toolStatus)kinWrite(toolStatus, kinSay('계정의 영상 도구 키를 불러오는 중…'));
      fill(map);kinWrite(message, saved.notices.join(' ')||kinSay('각 항목에서 사용할 조합을 누르세요.'));showTab('Worklist');dialog.showModal();fields.list.focus();refreshAccount();accountRun('inspect');
    };
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
    dialog.addEventListener('keydown',e=>e.stopPropagation());
    let timer;
    function startTimer(){clearInterval(timer);const at=work.capture('document');timer=setInterval(()=>work.commit(at,sync),500);}
    function end(){ended=true;cancelAccount();clearInterval(timer);map={...defaultsV2};dialog.remove();edit.remove();status.remove();}
    work.onInvalidate(event=>{
      if(event.reason==='lifecycle'&&!['active','preparing'].includes(event.state))end();
      if(event.reason==='prepare')clearInterval(timer);
      if(event.reason==='lifecycle'&&event.state==='active'){startTimer();sync();}
      if(event.reason==='cancel'){const action=interruptedAction;interruptedAction=null;accountEpoch++;accountRequest=null;accountBusy=false;refreshAccount();startTimer();if(action&&dialog.open)accountRun(action==='load'?'load':'inspect');}
    });
    startTimer();sync();
    return {action:e=>{sync();return action(map,e);},end,read:()=>({...map})};
  }
  function localBaseline(storage,owner){return JSON.stringify([storage.getItem(prefix+owner),storage.getItem(legacyPrefix+owner)]);}
  function readLocal(storage,owner){
    if(!owner)return migrate(null);
    let raw;
    // Storage denial observes no preference; only an observed bad value is unassigned.
    try{raw=storage.getItem(prefix+owner)??storage.getItem(legacyPrefix+owner);}catch(_){return migrate(null);}
    if(raw==null)return migrate(null);
    try{
      if(raw.length>4096)throw Error();
      const value=JSON.parse(raw);if(value===null)throw Error();
      return migrate(value);
    }catch(_){return unassigned();}
  }
  function readV2(storage,owner){return readLocal(storage,owner).map;}
  function read(storage, owner) {
    const map=readV2(storage,owner);
    return Object.fromEntries(Object.keys(defaults).map(id=>[id,map[id]?.startsWith('Control+Alt+')?map[id].slice(12):null]));
  }
  const api={defaults,defaultsV2,valid,display,action,create,read,readV2,migrate};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinWorkspaceShortcuts=api;
})(typeof window==='object'?window:globalThis);
