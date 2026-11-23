/* Pure comparison of completed, permission-filtered worklist snapshots. */
(function(root){
  'use strict';
  // A sentence of the page built from its template and its parts (data as is, {t: words}, {e: message}).
  const kinSay = (typeof window !== 'undefined' && window.KinLanguage && window.KinLanguage.say) || ((t, ...p) => t.replace(/\{(?:[ten]?(\d+)|([A-Za-z]\w*))\}/g, (m, i, n) => { const v = n !== undefined ? (p[0] || {})[n] : p[i]; return v === undefined ? m : String(v && typeof v === 'object' ? (v.t ?? v.e ?? '') : v); })), kinSayEn = (typeof window !== 'undefined' && window.KinLanguage && window.KinLanguage.sayEnglish) || kinSay;
  const validUid=value=>typeof value==='string'&&value.length<=64&&/^\d+(?:\.\d+)+$/.test(value);
  // null is the server's "unknown" (tag absent or non-integer in QIDO). It is neither 0 nor an
  // error: a snapshot that carries it is still comparable on the axes that are known.
  const validCount=value=>value===null||(Number.isSafeInteger(value)&&value>=0);
  // Growth needs two known values. unknown->known is a first observation, not an arrival, and
  // known->unknown is a lost observation; neither may raise a "new images" notice.
  const added=(before,after)=>before!==null&&after!==null&&after>before?after-before:0;
  const invalid=(name,reason,index)=>({error:name+':'+reason+(index===undefined?'':':'+index)});

  function snapshot(rows,name){
    if(!Array.isArray(rows))return invalid(name,'not-array');
    const values=new Map();
    for(let index=0;index<rows.length;index++){
      const row=rows[index];
      if(!row||typeof row!=='object'||Array.isArray(row)||!validUid(row.uid))
        return invalid(name,'invalid-uid',index);
      if(values.has(row.uid))return invalid(name,'duplicate-uid',index);
      if(!validCount(row.count)||!validCount(row.series))
        return invalid(name,'invalid-count',index);
      values.set(row.uid,{count:row.count,series:row.series});
    }
    return {values};
  }

  function diff(previous,next){
    const originals=rows=>root.KinExamScope?root.KinExamScope.originals(rows):rows;
    const before=snapshot(originals(previous),'previous');if(before.error)return {ok:false,changes:[],error:before.error};
    const after=snapshot(originals(next),'next');if(after.error)return {ok:false,changes:[],error:after.error};
    const changes=[];
    for(const [uid,current] of after.values){
      const old=before.values.get(uid);if(!old)continue;
      const addedInstances=added(old.count,current.count),addedSeries=added(old.series,current.series);
      if(!addedInstances&&!addedSeries)continue;
      changes.push({uid,previousCount:old.count,count:current.count,previousSeries:old.series,series:current.series,
        addedInstances,addedSeries});
    }
    return {ok:true,changes};
  }

  /*
   * S4-U1b: what KIN observed, kept apart from institution assignment (axis A) and from what a
   * Gateway reported (axis C). Everything below is session-local and in memory only: the server
   * stores no observation history, so a page load, another account or a known<->unknown count
   * starts the comparison over instead of inventing a baseline.
   */
  const validTime=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
  const PHASES=['pending','announcing','sending','retry','failed','complete'];
  // Only the receipt/observation labels are held to this; ordinary UI text is not scanned.
  const BANNED=/완료|수신 완료|안정|다 옴|received|complete|stable/i;
  // IF-W09: three different situations, three phrases. None of them may stand in for another.
  const PHRASES=Object.freeze({orderWithoutImages:'영상 없는 주문',observationUnavailable:'관측 불가',viewerLoadFailed:'뷰어 로딩 실패'});
  const pad=value=>String(value).padStart(2,'0');
  const localTime=iso=>{const d=new Date(iso);
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());};

  function observationStart(){return {owner:null,observedAt:null,readSince:null,available:null,rows:new Map(),notObserved:null};}

  // null/absent means the server could not decide absence (failed or partly unknown enumeration).
  // It stays unknown; turning it into [] would claim every row was checked.
  // S4-F01V: the own Gateway receipt of an item rides along only when the server sent the key. It is judged later
  // by the same label and retry rules as the receipt of a row, so an unreadable one never fails the observation.
  function readNotObserved(value,observed){
    if(value===null||value===undefined)return {rows:null};
    if(!Array.isArray(value))return {error:'notObserved:not-array'};
    const seen=new Set(),rows=[];
    for(let index=0;index<value.length;index++){
      const row=value[index];
      if(!row||typeof row!=='object'||Array.isArray(row)||!validUid(row.uid)||seen.has(row.uid)||observed.has(row.uid)
        ||typeof row.origin!=='string'||!row.origin||row.origin.length>32||!validTime(row.createdAt))
        return {error:'notObserved:invalid:'+index};
      seen.add(row.uid);rows.push({uid:row.uid,origin:row.origin,createdAt:row.createdAt,...(row.gatewayReceipt===undefined?{}:{gatewayReceipt:row.gatewayReceipt})});
    }
    return {rows};
  }

  // Two observations of one UID are comparable only when both instance counts are known and the
  // series count is known in both or in neither; any known<->unknown step is a reset, not a change.
  function compare(previous,current){
    if(!previous||previous.count===null||current.count===null||(previous.series===null)!==(current.series===null))return null;
    const series=current.series!==null;
    if(current.count<previous.count||series&&current.series<previous.series)return 'decreased';
    if(current.count>previous.count||series&&current.series>previous.series)return 'increased';
    return 'no_observed_change';
  }

  function observationSucceeded(model,result){
    const base=model&&model.rows instanceof Map?model:observationStart();
    const owner=Array.isArray(result?.owner)?JSON.stringify(result.owner):null,observation=result?.observation;
    if(!owner||!observation||typeof observation!=='object'||!validTime(observation.observedAt))return {ok:false,error:'observation:invalid'};
    const current=snapshot(root.KinExamScope?root.KinExamScope.originals(result.studies):result.studies,'next');if(current.error)return {ok:false,error:current.error};
    const absent=readNotObserved(observation.notObserved,current.values);if(absent.error)return {ok:false,error:absent.error};
    const at=observation.observedAt;
    // Another account, or a server clock that went backwards, cannot continue this session's comparison.
    const prior=base.owner===owner&&(base.observedAt===null||Date.parse(at)>=Date.parse(base.observedAt))?base.rows:new Map();
    const rows=new Map();
    // Missing images: each row's Gateway report is kept with the count it is compared with, from this same answer, so a
    // failed observation keeps both and a later row replacement cannot pair an old count with a new report.
    const reports=new Map((root.KinExamScope?root.KinExamScope.originals(result.studies):result.studies).map(row=>[row.uid,row.gatewayReceipt??null]));
    for(const [uid,value] of current.values){
      // Only the immediately preceding successful observation counts; a UID that left the list and came
      // back has no predecessor here, so leaving a page, filter or scope is never a decrease.
      const previous=prior.get(uid),kind=compare(previous,value);
      const row={count:value.count,series:value.series,observedAt:at,change:null,valueSince:value.count===null?null:at,changedAt:null,needsCheck:false,decreasedAt:null,receipt:reports.get(uid)??null};
      if(kind==='no_observed_change')Object.assign(row,{change:{kind,since:previous.valueSince},valueSince:previous.valueSince,
        changedAt:previous.changedAt,needsCheck:previous.needsCheck,decreasedAt:previous.decreasedAt});
      else if(kind)Object.assign(row,{change:{kind,since:previous.observedAt},changedAt:at,
        needsCheck:kind==='decreased'||previous.needsCheck,decreasedAt:kind==='decreased'?at:previous.decreasedAt});
      rows.set(uid,row);
    }
    // readFrom is when the server began the enumeration of the first page (study-pages.js): every count and absence of this
    // answer was read after it, so it bounds the reports they are compared with (receiptGap). Without it, observedAt.
    const from=observation.readFrom,readSince=validTime(from)&&Date.parse(from)<=Date.parse(at)?from:at;
    return {ok:true,model:{owner,observedAt:at,readSince,available:true,rows,notObserved:absent.rows}};
  }

  // A failed observation empties nothing: rows, their observedAt and the last absence list stay as
  // they were, and only availability changes. A cold start keeps observedAt null (no snapshot).
  function observationFailed(model){
    const base=model&&model.rows instanceof Map?model:observationStart();
    return {...base,available:false};
  }

  function studyObservation(model,uid){
    const m=model&&model.rows instanceof Map?model:observationStart(),row=m.rows.get(uid)||null;
    const absent=m.notObserved?m.notObserved.find(item=>item.uid===uid)||null:null;
    // readSince and receipt: what the missing-images answer compares (receiptGap), both from the last successful answer.
    const readSince=m.readSince??m.observedAt,receipt=row?row.receipt??null:absent?absent.gatewayReceipt??null:null;
    if(m.available===false)return {state:'observation_unavailable',
      last:row?{count:row.count,series:row.series,observedAt:row.observedAt}:absent?{notObserved:true,observedAt:m.observedAt}:null,
      changedAt:row?row.changedAt:null,needsCheck:!!row&&row.needsCheck,decreasedAt:row?row.decreasedAt:null,readSince,receipt};
    if(m.available!==true)return {state:'not_attempted'};
    if(row)return {state:'observed',count:row.count,series:row.series,observedAt:row.observedAt,change:row.change,
      changedAt:row.changedAt,needsCheck:row.needsCheck,decreasedAt:row.decreasedAt,readSince,receipt};
    if(absent)return {state:'not_observed',observedAt:m.observedAt,origin:absent.origin,createdAt:absent.createdAt,readSince,receipt};
    return {state:'outside_list'};
  }

  function kinHeld(count,at,format){return count===null?kinSayEn('HALO PACS 보유 개수 모름({0})',format(at)):kinSayEn('HALO PACS 보유 {n0}건({1})',count,format(at));}

  function assignmentLabel(value){
    if(value==='assigned')return {key:'assigned',text:'Institution Assigned',title:kinSayEn('검사가 기관에 연결되어 있습니다. 영상 수신 상태가 아닙니다.')};
    if(value==='unassigned')return {key:'unassigned',text:'Institution Unmatched',
      title:kinSayEn('DICOM 기관명이 등록된 별칭과 맞지 않아 기관이 정해지지 않았습니다. 영상 수신 상태가 아닙니다.')};
    throw new TypeError('assignment');
  }

  function observationLabel(b,format){
    if(b.state==='observed')return {key:'observed',text:kinHeld(b.count,b.observedAt,format),
      title:kinSayEn('성공한 HALO PACS 관측 시각의 보유 개수입니다.{t0}',{t:b.count===null?kinSayEn(' 개수 태그가 없거나 정수가 아니어서 알 수 없습니다.'):''})};
    if(b.state==='not_observed')return {key:'not_observed',text:'Not Observed('+format(b.observedAt)+')',
      title:kinSayEn('성공한 HALO PACS 관측에 이 검사의 영상 행이 없습니다. 예고만 된 검사·아직 저장 전·제거된 검사를 구분하지 않습니다.')};
    if(b.state==='observation_unavailable')return {key:'observation_unavailable',
      text:kinSayEn('{t0}{t1}',{t:kinSayEn(PHRASES.observationUnavailable)},{t:!b.last?'':b.last.notObserved?kinSayEn(' · 마지막 관측({0}) Not Observed',format(b.last.observedAt)):kinSayEn(' · 마지막 {0}',kinHeld(b.last.count,b.last.observedAt,format))}),
      title:kinSayEn('HALO PACS 관측 요청이 실패했습니다. 마지막으로 성공한 관측값과 그 시각을 그대로 보여 줍니다.')};
    if(b.state==='outside_list')return {key:'outside_list',text:'Outside Observed List',title:kinSayEn('이번 관측 목록에 없는 검사입니다. 삭제나 감소로 보지 않습니다.')};
    if(b.state==='not_attempted')return {key:'not_attempted',text:'',title:''};
    throw new TypeError('observation');
  }

  function changeLabel(b,format){
    if(b.state!=='observed'||!b.change)return null;
    const since=format(b.change.since),context=kinSayEn('이 세션에서 관측한 변화');
    if(b.change.kind==='increased')return {key:'increased',text:kinSayEn('{0}: 증가({1} 이후)',context,since)};
    if(b.change.kind==='decreased')return {key:'decreased',text:kinSayEn('{0}: 감소({1} 이후) · Needs Check',context,since)};
    if(b.change.kind==='no_observed_change')return {key:'no_observed_change',text:kinSayEn('{0} 없음({1} 이후)',context,since)};
    throw new TypeError('change');
  }

  const count=value=>Number.isSafeInteger(value)&&value>=0;
  function gatewayLabel(receipt,b,format){
    if(receipt===null||receipt===undefined)return {label:{key:'none',text:'No Gateway Report',
      title:kinSayEn('Gateway 전송 보고가 없습니다. 장비 직송·이전 버전 agent·미설치에서도 정상이며 실패나 오프라인을 뜻하지 않습니다.')},reasons:[]};
    const M=receipt?.successCount,N=receipt?.localCount;
    if(typeof receipt!=='object'||!PHASES.includes(receipt.phase)||!count(M)||!count(N)||M>N||!validTime(receipt.serverReceivedAt))
      return {label:{key:'reported_unreadable',text:kinSayEn('Gateway 보고 형식을 확인할 수 없습니다'),title:kinSayEn('보고 내용을 해석하지 못해 비교하지 않았습니다.')},reasons:['receipt_unreadable']};
    const reasons=[];
    // K<M is receiptGap's answer, the one the Technician list and the Info panel draw; null K is never read as zero.
    // The title says why it did not compare exactly when that answer did not (count unknown, or read before this report),
    // so it never contradicts a missing-images line or a count shown beside it.
    // Comparable here is the images' answer: a series answer alone never stands in for a count that was not compared.
    const gap=receiptGap(b,receipt,format),comparable=gap!==null&&!gap.pending&&gap.held!==null;
    if(gap?.missing&&!gap.stale)reasons.push(b.state==='observed'?'kin_below_reported':'not_observed_with_reported_transfer');
    if(b.changedAt&&Date.parse(receipt.serverReceivedAt)<Date.parse(b.changedAt))reasons.push('receipt_older_than_change');
    return {label:{key:'reported',text:kinSayEn('Gateway 보고({0}): Gateway가 집계한 {1}건 중 {2}건 전송',format(receipt.serverReceivedAt),N,M),
      title:kinSayEn('Gateway가 보고한 전송 수입니다. 검사 종료나 영상 수신 여부를 뜻하지 않습니다.{t0}',{t:comparable?'':gap?.pending&&gap.held!==null
        ?kinSayEn(' 이 보고는 목록 조회가 시작된 뒤 도착해 다음 관측에서 HALO PACS 보유 개수와 비교합니다.'):kinSayEn(' HALO PACS 보유 개수를 알 수 없어 비교하지 않았습니다.')})},reasons};
  }

  /*
   * S4-U4 Now Retry. Only a readable `retry` receipt offers the request, keyed by the exact receipt it was
   * drawn from (epoch|agentSeq), so an answer can never be written over a newer state. `failed` is F-01:
   * the same bytes cannot succeed, so it gets the sentence and never a control. A failed report whose code is
   * IDENTITY_REFUSED_CODE is not F-01: HALO PACS did not take the images because their patient ID is not the one this
   * study is stored under (or the study is already stored under two). It gets its own sentence, never a control and
   * never a promise that sending the same images again helps. The Gateway label above is
   * not touched by any of this. A request is stored, not run: nothing here says the retry happened.
   */
  const RETRY_EPOCH=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const RETRY_TEXT=Object.freeze({
    unsupported:'같은 바이트로는 성공할 수 없습니다 — 지원 범위 밖(F-01)',
    unsupportedTitle:'Gateway가 보낼 수 없는 영상(단일 인스턴스가 전송 상한을 넘음)이라 다시 시도해도 같은 결과입니다. 요청할 수 없습니다.',
    button:'Now Retry',
    buttonTitle:'HALO PACS에 재시도 요청을 남깁니다. Gateway가 30초 주기로 가져가 대기 중인 재시도를 앞당기며, 진행 중인 전송이 있으면 그 뒤에 반영됩니다.',
    requestedTitle:'요청이 HALO PACS에 저장됐다는 뜻이며 재시도가 실행됐다는 뜻은 아닙니다. Gateway는 30초 주기로 요청을 가져가고, 진행 중인 전송이 있으면 그 전송이 끝난 뒤에 가져갑니다.',
    notFound:'검사를 찾을 수 없어 요청하지 않았습니다.',
    notRetry:'지금은 재시도 대기 상태가 아니어서 요청하지 않았습니다. 목록이 갱신되면 다시 확인하세요.',
    busy:'요청이 겹쳐 처리하지 못했습니다. 잠시 후 다시 시도하세요.',
    failed:'재시도 요청을 보내지 못했습니다. 다시 시도하세요.'});
  const IDENTITY_REFUSED_CODE='stow_patient_conflict';
  const IDENTITY_REFUSED='이 검사 UID의 원본 환자 번호를 하나로 확인할 수 없어 영상을 받지 않았습니다';
  const IDENTITY_REFUSED_TITLE='Gateway가 보낸 영상의 환자 번호가 HALO PACS에 이미 저장된 이 검사의 영상과 다르거나, 이 검사가 이미 서로 다른 환자 번호로 저장되어 있습니다. 받지 않은 영상은 저장되지 않았고 Gateway는 같은 영상을 자동으로 다시 보내지 않습니다.';
  const readableReceipt=receipt=>!!receipt&&typeof receipt==='object'&&PHASES.includes(receipt.phase)
    &&count(receipt.successCount)&&count(receipt.localCount)&&receipt.successCount<=receipt.localCount&&validTime(receipt.serverReceivedAt);

  /*
   * Missing images: the one answer to "does HALO PACS hold fewer images of this study than its Gateway reported sent?".
   * K is what the last successful observation saw (0 for an own study it did not see at all), M the images a readable
   * Gateway report says were sent. Only a report the observation came after is compared: images a newer report counts
   * may have reached HALO PACS after that observation, so the next observation answers (no answer, not "fine").
   * No report, an unreadable one, an unknown K, a failed or no observation: no answer — never "missing".
   * K>=M is no gap whatever the hospital total N is: images still to send are the transfer's state (the Gateway line and
   * its retry), not images missing at HALO PACS. A retry request is never a part of this answer.
   */
  // readSince is when the earliest row of that observation was read (its first page); without it, its observedAt.
  // While an observation fails, the answer is the last successful one's, said as such (stale), never a new answer.
  /*
   * Series, beside the images and apart from them: the report's successSeries is how many distinct series the images it
   * says were sent belong to (the Gateway counts them; an older Gateway does not, and that is unknown, never 0). It is
   * compared with the series count the same observation read for that study (0 for an own study it did not see).
   * Each axis is answered only when both of its numbers are known; one short axis is missing images whatever the other
   * says, and an axis that is not known is never shown as a number or as "fine". The time rule (pending) is the same.
   */
  const SERIES_TITLE='Gateway가 보낸 영상이 속한 series보다 HALO PACS가 가진 series가 적습니다. 다음 관측에서 채워지면 이 표시는 사라집니다. 재시도 요청이나 전송 성공과는 다른 표시입니다.';
  const reportedSeries=receipt=>count(receipt.successSeries)&&receipt.successSeries<=receipt.successCount
    &&(receipt.successSeries===0)===(receipt.successCount===0)?receipt.successSeries:null;
  function receiptGap(b,receipt,format=localTime){
    if(!readableReceipt(receipt)||!b||typeof b!=='object')return null;
    const stale=b.state==='observation_unavailable',seen=stale?b.last:b;
    if(!seen||typeof seen!=='object')return null;
    const absent=b.state==='not_observed'||stale&&seen.notObserved===true;
    const kept=b.state==='observed'||stale;
    const held=absent?0:kept?seen.count:null,heldSeries=absent?0:kept?seen.series:null;
    const since=b.readSince??seen.observedAt,sent=receipt.successCount,expected=reportedSeries(receipt);
    const images=count(held),series=expected!==null&&count(heldSeries);
    if(!images&&!series||!validTime(since))return null;
    const base={held:images?held:null,sent,stale};
    // A known count read before this report: not compared yet (the next observation answers), never "missing" or "fine".
    if(Date.parse(receipt.serverReceivedAt)>Date.parse(since))
      return {missing:null,pending:true,...base,series:series?{held:heldSeries,sent:expected,missing:null}:null};
    const imagesShort=images&&held<sent,seriesShort=series&&heldSeries<expected;
    const answer={missing:imagesShort||seriesShort,...base,series:series?{held:heldSeries,sent:expected,missing:seriesShort}:null};
    if(!answer.missing)return answer;
    const lead=imagesShort?(stale?kinSay('Needs Check · 영상 누락(관측 불가 · 마지막 관측 {0} 기준): Gateway 전송 {n1}건 중 HALO PACS 보유 {n2}건',format(seen.observedAt),sent,held)
        :kinSay('Needs Check · 영상 누락: Gateway 전송 {n0}건 중 HALO PACS 보유 {n1}건',sent,held))
      :stale?kinSay('Needs Check · series 누락(관측 불가 · 마지막 관측 {0} 기준)',format(seen.observedAt)):kinSay('Needs Check · series 누락');
    // Expected N of them held M; a count above the expected one is said as the two counts, never as "M of N".
    const part=!series?null:heldSeries<=expected?kinSay('기대 series {n0} 가운데 {n1}',expected,heldSeries):kinSay('기대 series {n0} · 보유 {n1}',expected,heldSeries);
    return {...answer,imagesMissing:imagesShort,text:part?kinSay('{t0} · {t1}',{t:lead},{t:part}):lead,
      title:imagesShort?'Gateway가 보냈다고 보고한 영상보다 HALO PACS가 가진 영상이 적습니다. 다음 관측에서 채워지면 이 표시는 사라집니다. 재시도 요청이나 전송 성공과는 다른 표시입니다.':SERIES_TITLE};
  }

  // Missing images of one original: receiptGap of what the observation model holds for that study UID (its last observed
  // count and the Gateway report read with it). An original of a merged or split exam is answered the same way.
  function originalGap(model,uid,format=localTime){
    const seen=studyObservation(model,uid);
    return receiptGap(seen,seen.receipt??null,format);
  }
  /*
   * Missing images of an exam that is several originals (a merged exam) or part of one (a split exam): answered per
   * original by originalGap, never from the exam's summed count — one original's shortfall is not filled by another's
   * images. The answer says how many of its originals miss images; each original's own numbers are that original's line.
   * Only originals the caller can read are given here: an exam whose originals cannot all be read is said elsewhere.
   */
  function examGap(model,uids,format=localTime){
    const originals=[...new Set(uids)],gaps=originals.map(uid=>originalGap(model,uid,format)).filter(gap=>gap?.missing===true);
    if(!gaps.length)return null;
    const stale=model?.available===false,short=gaps.length;
    // An original short of series only is said as such: the exam's words name images alone only when every short
    // original holds fewer images.
    if(gaps.some(gap=>!gap.imagesMissing))return {missing:true,stale,originals:originals.length,short,
      text:stale?kinSay('Needs Check · 영상·series 누락(관측 불가 · 마지막 관측 {0} 기준): 원본 검사 {n1}건 중 {n2}건',format(model.observedAt),originals.length,short)
        :kinSay('Needs Check · 영상·series 누락: 원본 검사 {n0}건 중 {n1}건',originals.length,short),
      title:'Gateway가 보냈다고 보고한 영상이나 그 series보다 HALO PACS가 가진 것이 적은 원본 검사가 있습니다. 원본마다의 수는 Study Panel ▸ Info의 원본 검사 줄에 있습니다. 다음 관측에서 채워지면 이 표시는 사라집니다. 재시도 요청이나 전송 성공과는 다른 표시입니다.'};
    return {missing:true,stale,originals:originals.length,short,
      text:stale?kinSay('Needs Check · 영상 누락(관측 불가 · 마지막 관측 {0} 기준): 원본 검사 {n1}건 중 {n2}건',format(model.observedAt),originals.length,short)
        :kinSay('Needs Check · 영상 누락: 원본 검사 {n0}건 중 {n1}건',originals.length,short),
      title:'Gateway가 보냈다고 보고한 영상보다 HALO PACS가 가진 영상이 적은 원본 검사가 있습니다. 원본마다의 수는 Study Panel ▸ Info의 원본 검사 줄에 있습니다. 다음 관측에서 채워지면 이 표시는 사라집니다. 재시도 요청이나 전송 성공과는 다른 표시입니다.'};
  }

  function gatewayRetryAction(receipt){
    if(!readableReceipt(receipt))return null;
    if(receipt.phase==='failed')return receipt.errorCode===IDENTITY_REFUSED_CODE
      ?{kind:'identity_refused',text:IDENTITY_REFUSED,title:IDENTITY_REFUSED_TITLE}
      :{kind:'unsupported_f01',text:RETRY_TEXT.unsupported,title:RETRY_TEXT.unsupportedTitle};
    if(receipt.phase!=='retry'||!count(receipt.agentSeq)||typeof receipt.epoch!=='string'||!RETRY_EPOCH.test(receipt.epoch))return null;
    return {kind:'now_retry',key:receipt.epoch+'|'+receipt.agentSeq,text:RETRY_TEXT.button,title:RETRY_TEXT.buttonTitle};
  }

  // The one POST's answer as fixed text. Server wording is never echoed; only these sentences are shown.
  function gatewayRetryAnswer(uid,answer,error,format=localTime){
    if(!error&&answer&&typeof answer==='object'&&answer.studyUid===uid&&(answer.result==='requested'||answer.result==='already_requested')
      &&validTime(answer.requestedAt))
      return {requested:true,text:'Retry Requested ('+format(answer.requestedAt)+')',title:RETRY_TEXT.requestedTitle};
    const status=error?.status,code=error?.code;
    const text=status===404?RETRY_TEXT.notFound:status===409&&code==='GATEWAY_RETRY_UNSUPPORTED_F01'?RETRY_TEXT.unsupported
      :status===409&&code==='GATEWAY_RETRY_NOT_RETRY'?RETRY_TEXT.notRetry:status===503?RETRY_TEXT.busy:RETRY_TEXT.failed;
    return {requested:false,text,title:''};
  }

  /*
   * S5-U6a admin Gateway Status. The page lists the own-institution receipts GET /studies already carries (rows and
   * Not Observed items) and names each with one of five words that never stand in for one another.
   * Report Received: KIN holds a readable Gateway report that shows no failure. It is what the Gateway counted in its
   * own queue when it reported, never images received or a transfer ended, so the phase word is not shown.
   * Transfer Failed: a retry or failed report. Only a bindable retry offers Now Retry (the U4 action above); failed is
   * F-01 and says why as a failure reason, never as something the Gateway can still send (H-2).
   * Retry Requested: this page stored a request for exactly the drawn receipt key. Stored, not retried.
   * Unknown: a report that cannot be read, counted as neither failed nor received.
   * Query Failed belongs to the list, not to a receipt: the last successful answer stays and says so.
   */
  const GATEWAY_STATUS=Object.freeze({
    received:Object.freeze({text:'Report Received',
      title:kinSayEn('HALO PACS가 이 검사의 Gateway 전송 보고를 받았습니다. 보고 시점에 Gateway가 자기 큐에서 센 수이며 영상 수신이나 전송 종료를 뜻하지 않습니다.')}),
    retry_requested:Object.freeze({text:'Retry Requested',title:kinSayEn(RETRY_TEXT.requestedTitle)}),
    failed:Object.freeze({text:'Transfer Failed',
      title:kinSayEn('Gateway가 이 검사의 전송 실패를 보고했습니다. 마지막 보고 기준이며 그 뒤의 결과는 다음 보고로만 알 수 있습니다.')}),
    unknown:Object.freeze({text:'Unknown',title:kinSayEn('Gateway 보고 형식을 해석하지 못해 상태를 알 수 없습니다. 실패나 정상으로 세지 않습니다.')}),
    query_failed:Object.freeze({text:'Query Failed',title:kinSayEn('검사 목록 조회가 실패했습니다. 보이는 목록과 상태는 마지막으로 성공한 조회 기준입니다.')})});
  const GATEWAY_STATUS_ORDER=Object.freeze(['failed','retry_requested','unknown','received']);
  // A closed server set (gateway-receipt.ts); anything else is not echoed, whatever it says.
  const ERROR_CODE=/^[a-z_]{1,40}$/;
  const OVERSIZED='단일 DICOM 인스턴스가 Gateway 전송 상한(최대 24 MiB)을 넘어 보낼 수 없습니다';

  // requestedKey is the epoch|agentSeq this page stored a request for; any other key is not this receipt.
  function gatewayStatus(receipt,requestedKey=null,format=localTime){
    const pick=(key,detail,reason,retry)=>({key,text:GATEWAY_STATUS[key].text,title:GATEWAY_STATUS[key].title,detail,reason,retry});
    if(!readableReceipt(receipt))return pick('unknown','Gateway 보고 형식을 확인할 수 없습니다','',null);
    const detail=kinSayEn('Gateway 보고({0}): Gateway가 집계한 {1}건 중 {2}건 전송',format(receipt.serverReceivedAt),receipt.localCount,receipt.successCount);
    const code=typeof receipt.errorCode==='string'&&ERROR_CODE.test(receipt.errorCode)?['오류 코드 '+receipt.errorCode]:[];
    const retry=gatewayRetryAction(receipt);
    // failed keeps the U4 F-01 sentence as its note and never a control; the size reason is shown only for its code.
    // A refused patient ID is its own reason, with no F-01 note beside it.
    if(receipt.phase==='failed'){
      if(receipt.errorCode===IDENTITY_REFUSED_CODE)
        return pick('failed',detail,kinSayEn('{0} · {1}',kinSayEn(IDENTITY_REFUSED),kinSayEn('오류 코드 {0}',receipt.errorCode)),null);
      return pick('failed',detail,[...(receipt.errorCode==='instance_exceeds_budget'?[OVERSIZED]:[]),...code].join(' · '),retry);
    }
    if(receipt.phase==='retry'){
      const reason=['Gateway 자동 재시도 대기',...(count(receipt.attempt)?['시도 '+receipt.attempt+'회']:[]),...code].join(' · ');
      if(retry&&retry.kind==='now_retry'&&requestedKey===retry.key)return pick('retry_requested',detail,reason,null);
      return pick('failed',detail,reason,retry);
    }
    return pick('received',detail,'',null);
  }

  // The admin list is the GET /studies answer itself. Only entries the server gave a receipt are listed: no report is
  // normal and is counted nowhere. An answer that cannot be read is no observation (null), so the caller keeps the last.
  function gatewayStatusRows(result){
    if(!result||typeof result!=='object'||Array.isArray(result)||!Array.isArray(result.studies)||!validTime(result.observedAt))return null;
    const seen=new Set(),rows=[],text=value=>typeof value==='string'?value:'';
    for(const row of root.KinExamScope?root.KinExamScope.originals(result.studies):result.studies){
      if(!row||typeof row!=='object'||Array.isArray(row)||!validUid(row.uid)||seen.has(row.uid))return null;
      seen.add(row.uid);
      if(row.gatewayReceipt===null||row.gatewayReceipt===undefined)continue;
      rows.push({uid:row.uid,absent:false,name:text(row.name),patientId:text(row.id),date:text(row.date),acc:text(row.acc),receipt:row.gatewayReceipt});
    }
    // Absent own studies carry their receipt only with a decided absence list; undecided stays null (unknown), not [].
    const absent=readNotObserved(result.notObserved,seen);if(absent.error)return null;
    for(const item of absent.rows===null?[]:absent.rows)if(item.gatewayReceipt!==null&&item.gatewayReceipt!==undefined)
      rows.push({uid:item.uid,absent:true,origin:item.origin,createdAt:item.createdAt,receipt:item.gatewayReceipt});
    // Failures first, then unreadable, then the rest; newest report first. The order never uses a request this page made.
    const group=receipt=>!readableReceipt(receipt)?1:receipt.phase==='retry'||receipt.phase==='failed'?0:2;
    const at=receipt=>readableReceipt(receipt)?Date.parse(receipt.serverReceivedAt):0;
    rows.sort((a,b)=>group(a.receipt)-group(b.receipt)||at(b.receipt)-at(a.receipt)||(a.uid<b.uid?-1:a.uid>b.uid?1:0));
    return {observedAt:result.observedAt,absentKnown:absent.rows!==null,rows};
  }

  // Unknown is never 0: before a successful read there are no counts, and while absence is undecided the absent
  // studies (whose receipts come only with a decided list) are Not Observed Unknown.
  function gatewayStatusSummary(view,format=localTime){
    const v=view&&typeof view==='object'?view:{};
    if(!validTime(v.observedAt))return v.failed
      ?{key:'query_failed',text:kinSayEn('{0} · 아직 성공한 조회가 없습니다',GATEWAY_STATUS.query_failed.text),
        title:kinSayEn('검사 목록 조회가 실패했고 성공한 조회가 없어 보일 목록이 없습니다.'),counts:'Counts Unknown'}
      :{key:'not_loaded',text:'Not Loaded',title:kinSayEn('아직 조회하지 않았습니다.'),counts:'Counts Unknown'};
    const n=Object.fromEntries(GATEWAY_STATUS_ORDER.map(key=>[key,0]));
    for(const key of Array.isArray(v.statuses)?v.statuses:[])if(Object.prototype.hasOwnProperty.call(n,key))n[key]++;
    const counts=GATEWAY_STATUS_ORDER.map(key=>GATEWAY_STATUS[key].text+' '+n[key]).join(' · ')+(v.absentKnown===true?'':' · Not Observed Unknown');
    if(v.failed)return {key:'query_failed',text:kinSayEn('{0} · 마지막 관측 기준 {1}',GATEWAY_STATUS.query_failed.text,format(v.observedAt)),
      title:GATEWAY_STATUS.query_failed.title,counts};
    return {key:'observed',text:'Observed '+format(v.observedAt),counts,
      title:kinSayEn('이 시각에 성공한 검사 목록 조회 기준입니다.{t0}',{t:v.absentKnown===true?'':kinSayEn(' 영상이 관측되지 않은 검사의 Gateway 보고는 이번 조회로 확인하지 못했습니다.')})};
  }

  // One study's three axes. The axes never feed each other: a Gateway report of M-of-N, whatever
  // its phase, cannot change the observation label, and assignment says nothing about receipt.
  function receiptLabels({assignment,observation,gateway},format=localTime){
    const b=observation;
    if(!b||typeof b!=='object')throw new TypeError('observation');
    const a=assignmentLabel(assignment),o=observationLabel(b,format),change=changeLabel(b,format),g=gatewayLabel(gateway,b,format);
    const reasons=[...(b.needsCheck?['decreased_in_session']:[]),...g.reasons];
    return {assignment:a,observation:o,change,gateway:g.label,needsCheck:reasons.length>0,reasons,retry:gatewayRetryAction(gateway)};
  }

  // The list-level line. `notObserved` is the last successful answer (or null when absence was never
  // decided); while unavailable it is shown as that observation's answer, never as a new one.
  function observationSummary(model,format=localTime){
    const m=model&&model.rows instanceof Map?model:observationStart();
    let needsCheck=0;for(const row of m.rows.values())if(row.needsCheck)needsCheck++;
    const tail=needsCheck?' · Needs Check '+needsCheck:'';
    if(m.available===false)return {key:'observation_unavailable',
    text:kinSay('{t0}{t1}{t2}',{t:kinSayEn(PHRASES.observationUnavailable)},{t:m.observedAt?kinSay(' · 마지막 관측 {0} 유지',format(m.observedAt)):''},{t:tail}),
      title:kinSayEn(m.observedAt?'HALO PACS 관측 요청이 실패했습니다. 목록·개수·관측 시각은 마지막으로 성공한 관측값입니다.':'아직 성공한 HALO PACS 관측이 없습니다. 개수를 표시하지 않습니다.'),
      notObserved:m.notObserved,needsCheck};
    if(m.available!==true)return {key:'not_attempted',text:'',title:'',notObserved:null,needsCheck};
  const absent=m.notObserved===null?' · Not Observed Unknown':m.notObserved.length?kinSay(' · Not Observed {n0}',m.notObserved.length):'';
  return {key:'observed',text:kinSay('Observed {0}{t1}{t2}',format(m.observedAt),{t:absent},{t:tail}),
      title:kinSayEn('HALO PACS가 이 시각에 성공한 관측으로 확인한 목록입니다.{t0}',{t:m.notObserved===null?kinSayEn(' 이번 관측으로는 부재를 판정하지 못했습니다.'):''}),
      notObserved:m.notObserved,needsCheck};
  }

  function phrase(kind){if(!Object.prototype.hasOwnProperty.call(PHRASES,kind))throw new TypeError('phrase');return PHRASES[kind];}

  const api={diff,observationStart,observationSucceeded,observationFailed,studyObservation,receiptLabels,observationSummary,phrase,formatTime:localTime,
    receiptGap,originalGap,examGap,gatewayRetryAction,gatewayRetryAnswer,RETRY_TEXT,PHASES:Object.freeze([...PHASES]),BANNED,PHRASES,
    gatewayStatus,gatewayStatusRows,gatewayStatusSummary,GATEWAY_STATUS};root.KinStudyArrivals=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis==='object'?globalThis:this);
