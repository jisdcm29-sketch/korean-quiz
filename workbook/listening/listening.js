/* STEP14 UI. Public answer sheet only; grading keys live in Apps Script. */
(() => {
  'use strict';
  const ENDPOINT='https://script.google.com/macros/s/AKfycbz6WBgnJXTAperJK2NwX-VwkmPEQrU4SluCcXjbmYYgcywYM2AcHZwkymBse6E9Kaqg/exec';
  const TESTS={
    '1A-review1':{book:'1A',rangeKr:'1–2과',rangeMn:'1–2-р хичээл',source:'Workbook pp.73–75',prompts:[
      {end:3,text:'잘 듣고 알맞은 것을 고르세요.'},
      {end:10,text:'잘 듣고 알맞은 대답을 고르세요.'},
      {end:13,text:'여기는 어디입니까? 잘 듣고 알맞은 것을 고르세요.'},
      {end:15,text:'다음 대화를 듣고 알맞은 그림을 고르세요.'},
      {end:20,text:'잘 듣고 대화 내용과 같은 것을 고르세요.'}
    ]},
    '1A-review2':{book:'1A',rangeKr:'3–4과',rangeMn:'3–4-р хичээл',source:'Workbook pp.119–121',prompts:[
      {end:3,text:'잘 듣고 알맞은 것을 고르세요.'},
      {end:8,text:'잘 듣고 알맞은 대답을 고르세요.'},
      {end:12,text:'여기는 어디입니까? 잘 듣고 알맞은 것을 고르세요.'},
      {end:15,text:'다음 대화를 듣고 알맞은 그림을 고르세요.'},
      {end:20,text:'잘 듣고 대화 내용과 같은 것을 고르세요.'}
    ]},
    '1A-review3':{book:'1A',rangeKr:'5–6과',rangeMn:'5–6-р хичээл',source:'Workbook pp.165–167',prompts:[
      {end:3,text:'잘 듣고 알맞은 것을 고르세요.'},
      {end:8,text:'잘 듣고 알맞은 대답을 고르세요.'},
      {end:12,text:'여기는 어디입니까? 잘 듣고 알맞은 것을 고르세요.'},
      {end:15,text:'다음 대화를 듣고 알맞은 그림을 고르세요.'},
      {end:20,text:'잘 듣고 대화 내용과 같은 것을 고르세요.'}
    ]},
    '1A-review4':{book:'1A',rangeKr:'7–8과',rangeMn:'7–8-р хичээл',source:'Workbook pp.211–213',prompts:[
      {end:3,text:'잘 듣고 알맞은 것을 고르세요.'},
      {end:8,text:'잘 듣고 알맞은 대답을 고르세요.'},
      {end:10,text:'여기는 어디입니까? 잘 듣고 알맞은 것을 고르세요.'},
      {end:12,text:'무엇에 대해 이야기합니까? 잘 듣고 알맞은 것을 고르세요.'},
      {end:15,text:'다음 대화를 듣고 알맞은 그림을 고르세요.'},
      {end:20,text:'잘 듣고 대화 내용과 같은 것을 고르세요.'}
    ]},
    '1B-review1':{book:'1B',rangeKr:'9–10과',rangeMn:'9–10-р хичээл',source:'Workbook pp.51–53',prompts:[
      {end:2,text:'잘 듣고 알맞은 것을 고르세요.'},
      {end:8,text:'잘 듣고 알맞은 대답을 고르세요.'},
      {end:11,text:'무엇에 대해 이야기합니까? 잘 듣고 알맞은 것을 고르세요.'},
      {end:14,text:'다음 대화를 듣고 알맞은 그림을 고르세요.'},
      {end:18,text:'잘 듣고 대화 내용과 같은 것을 고르세요.'},
      {end:20,text:'잘 듣고 질문에 답하세요.'}
    ]},
    '1B-review2':{book:'1B',rangeKr:'11–12과',rangeMn:'11–12-р хичээл',source:'Workbook pp.97–99',prompts:[
      {end:3,text:'잘 듣고 알맞은 것을 고르세요.'},
      {end:8,text:'잘 듣고 알맞은 대답을 고르세요.'},
      {end:11,text:'여기는 어디입니까? 잘 듣고 알맞은 것을 고르세요.'},
      {end:14,text:'다음 대화를 듣고 알맞은 그림을 고르세요.'},
      {end:18,text:'잘 듣고 대화 내용과 같은 것을 고르세요.'},
      {end:20,text:'잘 듣고 질문에 답하세요.'}
    ]},
    '1B-review3':{book:'1B',rangeKr:'13–14과',rangeMn:'13–14-р хичээл',source:'Workbook pp.143–145',prompts:[
      {end:3,text:'잘 듣고 알맞은 것을 고르세요.'},
      {end:8,text:'잘 듣고 알맞은 대답을 고르세요.'},
      {end:10,text:'여기는 어디입니까? 잘 듣고 알맞은 것을 고르세요.'},
      {end:12,text:'무엇에 대해 이야기합니까? 잘 듣고 알맞은 것을 고르세요.'},
      {end:15,text:'다음 대화를 듣고 알맞은 그림을 고르세요.'},
      {end:18,text:'잘 듣고 대화 내용과 같은 것을 고르세요.'},
      {end:20,text:'잘 듣고 질문에 답하세요.'}
    ]},
    '1B-review4':{book:'1B',rangeKr:'15–16과',rangeMn:'15–16-р хичээл',source:'Workbook pp.189–191',prompts:[
      {end:2,text:'잘 듣고 알맞은 것을 고르세요.'},
      {end:8,text:'잘 듣고 알맞은 대답을 고르세요.'},
      {end:11,text:'여기는 어디입니까? 잘 듣고 알맞은 것을 고르세요.'},
      {end:14,text:'무엇에 대해 이야기합니까? 잘 듣고 알맞은 것을 고르세요.'},
      {end:16,text:'다음 대화를 듣고 알맞은 그림을 고르세요.'},
      {end:18,text:'잘 듣고 대화 내용과 같은 것을 고르세요.'},
      {end:20,text:'잘 듣고 질문에 답하세요.'}
    ]},
    '2A-review1':{book:'2A',rangeKr:'1–3과',rangeMn:'1–3-р хичээл',source:'Workbook pp.61–63',total:15,prompts:[
      {end:2,text:'잘 듣고 알맞은 그림을 고르세요.'},
      {end:7,text:'잘 듣고 맞는 대화를 고르세요.'},
      {end:9,text:'다음은 무엇에 대해 말하고 있습니까?'},
      {end:11,text:'잘 듣고 대화 내용과 같은 것을 고르세요.'},
      {end:15,text:'잘 듣고 질문에 맞는 답을 고르세요.'}
    ]},
    '2A-review2':{book:'2A',rangeKr:'4–6과',rangeMn:'4–6-р хичээл',source:'Workbook pp.119–121',total:15,prompts:[
      {end:2,text:'잘 듣고 알맞은 그림을 고르세요.'},
      {end:7,text:'잘 듣고 맞는 대화를 고르세요.'},
      {end:9,text:'다음은 무엇에 대해 말하고 있습니까?'},
      {end:11,text:'잘 듣고 대화 내용과 같은 것을 고르세요.'},
      {end:15,text:'잘 듣고 질문에 맞는 답을 고르세요.'}
    ]},
    '2A-review3':{book:'2A',rangeKr:'7–9과',rangeMn:'7–9-р хичээл',source:'Workbook pp.179–181',total:15,prompts:[
      {end:2,text:'잘 듣고 알맞은 그림을 고르세요.'},
      {end:7,text:'잘 듣고 맞는 대화를 고르세요.'},
      {end:9,text:'다음은 무엇에 대해 말하고 있습니까?'},
      {end:11,text:'잘 듣고 대화 내용과 같은 것을 고르세요.'},
      {end:15,text:'잘 듣고 질문에 맞는 답을 고르세요.'}
    ]}
  };
  const testParam=new URLSearchParams(location.search).get('test')||'1A-review1';
  const TEST=Object.prototype.hasOwnProperty.call(TESTS,testParam)?testParam:'1A-review1';
  const CFG=TESTS[TEST], TOTAL=CFG.total||20, PROMPTS=CFG.prompts;
  // Public UI contains only workbook prompt groups; answers stay in Apps Script.
  const $=id=>document.getElementById(id);
  const guard=window.KQSession;
  if (!guard || !guard.check()) return;
  const session=guard.read();
  const device=session.deviceId || localStorage.getItem('kq_deviceId_v1') || '';
  const lang=new URLSearchParams(location.search).get('lang') || localStorage.getItem('kq_lang') || 'KR';
  const mn=lang.toUpperCase()==='MN';
  const key='kql_v1_'+session.phone+'_'+device+'_'+TEST;
  let state=null, selected=0, ready=false, submitting=false, syncing=false, syncTimer=null, lastSynced=0;
  const t=(kr,mnText)=>mn?mnText:kr;
  const clone=value=>JSON.parse(JSON.stringify(value));
  function active(){const current=guard.read();return guard.check() && current && current.token===session.token;}
  function validAnswers(a){return Array.isArray(a)&&a.length<=TOTAL&&a.every(n=>Number.isInteger(n)&&n>=1&&n<=4);}
  function compatible(a,b){return a.slice(0,Math.min(a.length,b.length)).every((n,i)=>n===b[i]);}
  function read(){try{const s=JSON.parse(localStorage.getItem(key)||'null');return s&&/^[A-Za-z0-9_-]{16,80}$/.test(s.attemptId)&&validAnswers(s.answers)?s:null;}catch(_){return null;}}
  function persist(){localStorage.setItem(key,JSON.stringify(state));}
  function show(id){['intro','exam','submission','result'].forEach(x=>$(x).hidden=x!==id);}
  function status(kr,mnText){$('status').textContent=t(kr,mnText);}
  function id(){return crypto.randomUUID ? crypto.randomUUID() : 'kql_'+Date.now()+'_'+Math.random().toString(36).slice(2);}
  function authUrl(path){const u=new URL(path,location.href);Object.entries({name:session.name,klass:session.klass,token:session.token,lang}).forEach(([k,v])=>u.searchParams.set(k,v));return u.href;}
  function exit(){if(state && state.answers.length && !state.result && !confirm(t('이동해도 확정한 답안은 잠금 상태로 유지됩니다. 나갈까요?','Баталгаажуулсан хариулт өөрчлөгдөхгүй. Гарах уу?')))return;location.href=authUrl('../snu'+CFG.book.toLowerCase()+'/?view=listening');}
  function api(action,extra={}) {
    return new Promise((resolve,reject)=>{
      if(!active()){reject(new Error('expired_or_invalid'));return;}
      const cb='cb_kql_'+Date.now()+'_'+Math.random().toString(16).slice(2),node=document.createElement('script');
      const cleanup=()=>{clearTimeout(timer);node.remove();delete window[cb];};
      const timer=setTimeout(()=>{cleanup();reject(new Error('network'));},18000);
      window[cb]=r=>{cleanup();if(!active()){reject(new Error('expired_or_invalid'));return;}if(!r||!r.ok){reject(new Error(r&&r.error||'listening_not_installed'));return;}guard.noteValidated();resolve(r);};
      node.onerror=()=>{cleanup();reject(new Error('network'));};
      node.src=ENDPOINT+'?'+new URLSearchParams({action,testId:TEST,attemptId:state.attemptId,token:session.token,deviceId:device,name:session.name,klass:session.klass,ua:navigator.userAgent,...extra,callback:cb});
      document.head.appendChild(node);
    });
  }
  function checkReply(r){
    if(r.protocol!==1||r.testId!==TEST||r.total!==TOTAL||r.choices!==4||!validAnswers(r.answers)||!/^[A-Za-z0-9_-]{16,80}$/.test(r.attemptId)||typeof r.version!=='string')throw new Error('invalid_reply');
    if(r.submitted && (!r.saved||r.answers.length!==TOTAL||!Number.isInteger(r.score)||r.score<0||r.score>100||!Number.isInteger(r.correct)||r.correct<0||r.correct>TOTAL))throw new Error('invalid_reply');
  }
  function merge(r,begin=false){
    checkReply(r);
    if(!begin && (r.attemptId!==state.attemptId||r.version!==state.version))throw new Error('invalid_reply');
    const local=read();
    let answers=local&&local.attemptId===r.attemptId ? local.answers : [];
    if(!compatible(answers,r.answers)){
      if(!begin)throw new Error('listening_answer_locked');
      answers=r.answers;
      status('다른 창에서 저장한 답안으로 이어갑니다.','Өөр цонхонд хадгалсан хариултаас үргэлжлүүлнэ.');
    }else if(r.answers.length>answers.length)answers=r.answers;
    if(r.submitted)answers=r.answers;
    state={attemptId:r.attemptId,version:r.version,startedAt:r.startedAt,answers:clone(answers),result:r.submitted?r:null};
    persist();
  }
  function error(e){
    const code=e.message;
    if(['missing_token','expired_or_invalid','not_authorized','identity_mismatch','device_mismatch','corrupt_token'].includes(code)){guard.end('server_invalid');return;}
    if(code==='listening_answer_locked'||code==='attempt_identity_mismatch'||code==='listening_version_changed'){
      ready=false;show('intro');$('start').disabled=false;$('start').textContent=t('시작','Эхлэх');
      status('다른 창의 답안과 충돌했습니다. 다른 창을 닫고 시작을 누르세요.','Өөр цонхны хариулттай зөрчилдлөө. Тэр цонхыг хаагаад үргэлжлүүлнэ үү.');return;
    }
    if(code==='listening_not_installed'||code==='listening_test_unavailable'||code==='invalid_reply')status('듣기평가 서버 설치·배포를 확인해 주세요.','Сонсох шалгалтын серверийн тохиргоог шалгана уу.');
    else status('연결 또는 저장 오류입니다. 답안은 이 기기에 보관됩니다. 다시 시도해 주세요.','Холболт эсвэл хадгалалтын алдаа. Хариулт энэ төхөөрөмжид хадгалагдсан. Дахин оролдоно уу.');
  }
  async function begin(){
    if(!active()||$('start').disabled)return;
    $('start').disabled=true;
    status('시험을 준비하고 있습니다.','Шалгалтыг бэлтгэж байна.');
    try{
      state=read()||{attemptId:id(),answers:[]};persist();
      const r=await api('workbook_listening_begin');
      merge(r,true);lastSynced=r.answers.length;ready=true;render();
      if(!r.submitted && state.answers.length>r.answers.length)scheduleSync();
      if($('status').textContent===t('시험을 준비하고 있습니다.','Шалгалтыг бэлтгэж байна.'))$('status').textContent='';
    }catch(e){error(e);}finally{$('start').disabled=false;}
  }
  function refreshLocal(){
    const latest=read();
    if(!latest||latest.attemptId!==state.attemptId)throw new Error('attempt_identity_mismatch');
    if(!compatible(state.answers,latest.answers))throw new Error('listening_answer_locked');
    if(latest.answers.length>=state.answers.length)state=latest;
  }
  function render(){
    if(!ready)return;
    if(state.result){show('result');$('score').textContent=state.result.score+t('점',' оноо');$('correct').textContent=t(`${state.result.correct} / ${TOTAL} 정답`,`${TOTAL} асуултаас ${state.result.correct} зөв`);$('saved').textContent=t('구글 시트에 저장되었습니다.','Google Sheets-д хадгалагдсан.');return;}
    if(state.answers.length===TOTAL){show('submission');$('submitMessage').textContent=t('답안이 확정되었습니다. 제출하여 점수를 확인하세요.','Хариулт баталгаажлаа. Илгээж оноогоо харна уу.');$('retry').disabled=submitting;return;}
    show('exam');const index=state.answers.length;
    $('progress').textContent=`${index+1} / ${TOTAL}`;
    $('questionNumber').textContent=t(`${index+1}번`,`${index+1}`);
    $('questionPrompt').textContent=PROMPTS.find(group=>index+1<=group.end).text;
    $('options').replaceChildren();selected=0;
    for(let n=1;n<=4;n++){
      const b=document.createElement('button');b.type='button';b.textContent=String(n);b.setAttribute('aria-pressed','false');
      b.onclick=()=>{try{if(!active()||!ready||submitting)return;refreshLocal();if(state.answers.length!==index){render();return;}selected=n;[...$('options').children].forEach((x,i)=>x.setAttribute('aria-pressed',String(i+1===n)));$('next').disabled=false;}catch(e){error(e);}};
      $('options').appendChild(b);
    }
    $('next').disabled=true;$('next').textContent=index===TOTAL-1?t('제출','Илгээх'):t('다음 →','Дараах →');
    $('next').onclick=()=>{
      try{
        if(!active()||!ready||!selected||submitting)return;
        refreshLocal();if(state.answers.length!==index){render();return;}
        const before=clone(state);state.answers.push(selected);
        try{persist();}catch(e){state=before;throw e;}
        render();
        if(state.answers.length===TOTAL)submit();else scheduleSync();
      }catch(e){error(e);}
    };
  }
  function scheduleSync(){
    if(state.result||state.answers.length<=lastSynced)return;
    // Batch five committed answers, or save at most a minute of pending progress.
    // Each Next commits locally and renders immediately; it never waits for this request.
    if(state.answers.length-lastSynced>=5){clearTimeout(syncTimer);syncTimer=setTimeout(()=>{syncTimer=null;sync();},0);}
    else if(!syncTimer)syncTimer=setTimeout(()=>{syncTimer=null;sync();},60000);
  }
  async function sync(){
    if(syncing||submitting||!ready||state.result||!active())return;
    syncing=true;const sent=state.answers.slice();
    try{
      const r=await api('workbook_listening_checkpoint',{answers:JSON.stringify(sent)});
      const oldLength=state.answers.length;merge(r);lastSynced=r.answers.length;
      if(state.result||oldLength!==state.answers.length)render();
      $('status').textContent='';
    }catch(e){error(e);}finally{
      syncing=false;
      if(ready&&!submitting&&!state.result&&state.answers.length>sent.length)scheduleSync();
    }
  }
  async function submit(){
    if(submitting||!ready||!active())return;
    try{refreshLocal();}catch(e){error(e);return;}
    if(state.result){render();return;}if(state.answers.length!==TOTAL)return;
    clearTimeout(syncTimer);submitting=true;show('submission');$('retry').disabled=true;
    $('submitMessage').textContent=t('채점하고 구글 시트에 저장하고 있습니다.','Оноог тооцоолж Google Sheets-д хадгалж байна.');
    try{
      const r=await api('workbook_listening_submit',{answers:JSON.stringify(state.answers)});
      if(!r.submitted)throw new Error('invalid_reply');merge(r);render();$('status').textContent='';
    }catch(e){error(e);if(ready){show('submission');$('submitMessage').textContent=t('제출 완료를 확인하지 못했습니다. 같은 답안으로 다시 제출하세요.','Илгээсэн эсэхийг баталгаажуулж чадсангүй. Ижил хариултаа дахин илгээнэ үү.');}}
    finally{submitting=false;$('retry').disabled=false;}
  }
  $('start').onclick=begin;$('retry').onclick=submit;$('exit').onclick=exit;$('done').onclick=exit;
  window.addEventListener('storage',e=>{if(e.key===key&&ready&&!submitting){try{refreshLocal();render();}catch(err){error(err);}}});
  window.addEventListener('online',()=>{if(ready&&!state.result)scheduleSync();});
  window.addEventListener('pageshow',()=>{if(ready){try{if(active()){refreshLocal();render();scheduleSync();}}catch(e){error(e);}}});
  const bookLabel='SNU '+CFG.book;
  $('range').textContent=mn?CFG.rangeMn:CFG.rangeKr;
  document.title=bookLabel+(mn?' Сонсох шалгалт':' 듣기평가');
  $('title').textContent=bookLabel+' · '+t('듣기평가','Сонсох шалгалт');
  if(mn){document.documentElement.lang='mn';$('start').textContent='Эхлэх';$('exit').textContent='Гарах';$('submitTitle').textContent='Хариулт илгээх';$('retry').textContent='Дахин илгээх';$('resultTitle').textContent='Сонсох шалгалтын дүн';$('done').textContent='Шалгалтын жагсаалт';$('options').setAttribute('aria-label','Хариултын дугаар');}
  if(!session.phone||!device){$('start').disabled=true;status('로그인 정보를 확인한 뒤 다시 로그인해 주세요.','Нэвтрэх мэдээллээ шалгаад дахин нэвтэрнэ үү.');return;}
  if(read())begin();
})();
