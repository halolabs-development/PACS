/* S4-U2 order-side reconciliation display model. Engineering only; pure (no storage, network or DOM). */
(function(root){
  'use strict';
  // A sentence of the page built from its template and its parts ({t: words}); written so the screen language reads it.
  const kinSay = (typeof window !== 'undefined' && window.KinLanguage && window.KinLanguage.say) || ((t, ...p) => t.replace(/\{(?:[ten]?(\d+)|([A-Za-z]\w*))\}/g, (m, i, n) => { const v = n !== undefined ? (p[0] || {})[n] : p[i]; return v === undefined ? m : String(v && typeof v === 'object' ? (v.t ?? v.e ?? '') : v); }));
  // The sentences this display adds read in English on an English screen only (otherwise exactly as written).
  const kinSayEn = (typeof window !== 'undefined' && window.KinLanguage && window.KinLanguage.sayEnglish) || kinSay;
  /*
   * The only source the server may name while no authoritative site order source is connected. Any
   * other value is not an answer this build knows how to show, so it is treated as unreadable.
   * The display never shows patient fields or scheduled times: an order here is its oid and its state,
   * so a seed order is never presented as a scheduled clinical patient.
   */
  const SOURCE='engineering_only',MARKER='Engineering Only';
  // IF-W09 phrases, the same text as study-arrivals.js (tests hold the two equal).
  const ORDER_WITHOUT_IMAGES='영상 없는 주문',OBSERVATION_UNAVAILABLE='관측 불가';
  const TITLE='권위 있는 병원 오더 출처가 연결되지 않아 오더 대사는 엔지니어링 확인 전용입니다. 예정 환자 목록이나 확정된 대사 결과로 쓰지 마세요.';
  const validUid=value=>typeof value==='string'&&value.length<=64&&/^\d+(?:\.\d+)+$/.test(value);
  const validOid=value=>typeof value==='string'&&value.length>0&&value.length<=64&&!/[\u0000-\u001f\u007f]/.test(value);
  const validTime=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
  const exactKeys=(row,keys)=>{const own=Object.keys(row).sort();return own.length===keys.length&&own.every((key,index)=>key===keys[index]);};
  const pad=value=>String(value).padStart(2,'0');
  const localTime=iso=>{const d=new Date(iso);
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());};

  function start(){return {owner:null,observedAt:null,available:null,orders:null};}
  const usable=model=>model&&typeof model==='object'&&'available' in model&&'orders' in model?model:start();

  // null/absent: the server could not decide or did not say. It stays unknown; [] would claim an answer.
  function read(value){
    if(value===null||value===undefined)return {orders:null};
    if(!value||typeof value!=='object'||Array.isArray(value)||!exactKeys(value,['orders','source'])||value.source!==SOURCE||!Array.isArray(value.orders))
      return {error:'orders:invalid'};
    const seen=new Set(),orders=[];
    for(let index=0;index<value.orders.length;index++){
      const row=value.orders[index],bad={error:'orders:invalid:'+index};
      if(!row||typeof row!=='object'||Array.isArray(row)||!validOid(row.oid)||seen.has(row.oid))return bad;
      if(row.link==='observed'||row.link==='not_observed'){
        if(!exactKeys(row,['link','oid','studyUid'])||!validUid(row.studyUid))return bad;
        orders.push({oid:row.oid,link:row.link,studyUid:row.studyUid});
      }else if(row.link==='unlinked'){
        if(!exactKeys(row,['accession','candidates','link','oid'])||(row.accession!=='present'&&row.accession!=='absent')||!Array.isArray(row.candidates))return bad;
        // Without an accession nothing was compared, so a pair would be invented.
        if(row.accession==='absent'&&row.candidates.length)return bad;
        const uids=new Set();
        for(const uid of row.candidates){if(!validUid(uid)||uids.has(uid))return bad;uids.add(uid);}
        orders.push({oid:row.oid,link:'unlinked',accession:row.accession,candidates:[...row.candidates]});
      }else return bad;
      seen.add(row.oid);
    }
    return {orders};
  }

  // The answer rides on the observation of the page that completed the list and is replaced whole.
  function succeeded(model,result){
    const base=usable(model),owner=Array.isArray(result?.owner)?JSON.stringify(result.owner):null,observation=result?.observation;
    if(!owner||!observation||typeof observation!=='object'||!validTime(observation.observedAt))return failed(base);
    const answer=read(observation.orderReconciliation);
    if(answer.error)return failed(base);
    return {owner,observedAt:observation.observedAt,available:true,orders:answer.orders};
  }

  // A failed or unreadable observation empties nothing: the last answer and its time stay.
  function failed(model){return {...usable(model),available:false};}

  function rowLabel(row){
    if(row.link==='observed')return {key:'observed',text:row.oid+' · Linked · Observed',
      title:kinSayEn('연결된 검사의 영상 행이 성공한 HALO PACS 관측에 있습니다. 영상 수나 검사 종료를 뜻하지 않습니다.')};
    if(row.link==='not_observed')return {key:'not_observed',text:kinSayEn('{0} · Linked · {1}',row.oid,kinSayEn(ORDER_WITHOUT_IMAGES)),
      title:kinSayEn('연결된 검사가 성공한 HALO PACS 관측에 없습니다. 관측 실패나 뷰어 로딩 실패가 아닙니다.')};
    if(row.accession==='absent')return {key:'unlinked_no_accession',text:kinSayEn('{0} · Unlinked · {1} · No Accession',row.oid,kinSayEn(ORDER_WITHOUT_IMAGES)),
      title:kinSayEn('오더에 accession이 없어 어떤 검사와도 비교할 수 없습니다. 같음도 불일치도 아닙니다.')};
    if(!row.candidates.length)return {key:'unlinked_no_match',text:kinSayEn('{0} · Unlinked · {1} · No Accession Match',row.oid,kinSayEn(ORDER_WITHOUT_IMAGES)),
      title:kinSayEn('같은 기관의 연결되지 않은 관측 검사 중 accession이 같은 검사가 없습니다.')};
    return {key:'unlinked_match',text:row.oid+' · Unlinked · Accession Match: '+row.candidates.join(', '),
      title:kinSayEn('같은 기관의 연결되지 않은 관측 검사와 accession이 같습니다. 자동으로 연결하지 않습니다. 확인 후 Match로만 연결합니다.')};
  }
  const WITHOUT_IMAGES=new Set(['not_observed','unlinked_no_accession','unlinked_no_match']);

  // The heading always carries the engineering marker. A cold start shows nothing (no invented snapshot).
  function summary(model,format=localTime){
    const m=usable(model),head='Order Reconciliation · '+MARKER;
    if(m.available===null)return {key:'not_attempted',hidden:true,text:'',title:'',rows:[]};
    const rows=(m.orders||[]).map(rowLabel),missing=rows.filter(row=>WITHOUT_IMAGES.has(row.key)).length;
    if(m.available===false)return {key:'observation_unavailable',hidden:false,
      text:kinSayEn('{0} · {1}{2}',head,kinSayEn(OBSERVATION_UNAVAILABLE),m.observedAt?kinSayEn(' · 마지막 관측 {0} 기준',format(m.observedAt)):''),
      title:m.observedAt?kinSay('{t0} {t1} {t2}',{t:kinSay(TITLE)},{t:kinSay('HALO PACS 관측 요청이 실패했습니다.')},{t:kinSay('아래 목록은 마지막으로 성공한 관측의 답입니다.')}):kinSay('{t0} {t1}',{t:kinSay(TITLE)},{t:kinSay('HALO PACS 관측 요청이 실패했습니다.')}),rows};
    if(m.orders===null)return {key:'unknown',hidden:false,text:head+' · Unknown · Observed '+format(m.observedAt),
      title:kinSay('{t0} {t1}',{t:kinSay(TITLE)},{t:kinSay('이번 관측으로는 오더 대사를 판정하지 못했습니다.')}),rows:[]};
    return {key:'observed',hidden:false,
      text:kinSayEn('{0} · Orders {n1}{2} · Observed {3}',head,rows.length,missing?kinSayEn(' · {0} {n1}',kinSayEn(ORDER_WITHOUT_IMAGES),missing):'',format(m.observedAt)),
      title:kinSayEn(TITLE),rows};
  }

  const api={start,read,succeeded,failed,rowLabel,summary,SOURCE,MARKER,
    PHRASES:Object.freeze({orderWithoutImages:ORDER_WITHOUT_IMAGES,observationUnavailable:OBSERVATION_UNAVAILABLE})};
  root.KinOrderReconciliation=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis==='object'?globalThis:this);
