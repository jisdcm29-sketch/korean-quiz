(function(){
  'use strict';
  const QUESTIONS = window.WORKBOOK_REVIEW_QUESTIONS || [];
  const DURATION_SEC = 15 * 60;
  const STORAGE_KEY = 'snu1a_workbook_review1_eval_v3';
  const RESULT_LOG_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbz6WBgnJXTAperJK2NwX-VwkmPEQrU4SluCcXjbmYYgcywYM2AcHZwkymBse6E9Kaqg/exec';
  const SESSION_KEY = 'kq_session_v1';
  const DEVICE_KEY = 'kq_deviceId_v1';

  const qs = new URLSearchParams(location.search);
  function readMainSession(){
    try{
      const raw = localStorage.getItem(SESSION_KEY);
      if(!raw) return null;
      const session = JSON.parse(raw);
      return session && session.token ? session : null;
    }catch(_e){ return null; }
  }

  const mainSession = readMainSession();
  const student = {
    name: qs.get('name') || (mainSession && mainSession.name) || '',
    phone: qs.get('phone') || qs.get('tel') || (mainSession && mainSession.phone) || '',
    klass: qs.get('klass') || qs.get('class') || (mainSession && mainSession.klass) || '',
    token: qs.get('token') || (mainSession && mainSession.token) || '',
    deviceId: localStorage.getItem(DEVICE_KEY) || (mainSession && mainSession.deviceId) || ''
  };

  let state = {
    started: false,
    submitted: false,
    startAt: 0,
    current: 0,
    answers: Array(QUESTIONS.length).fill(null),
    submittedAt: 0,
    attemptId: '',
    resultSaved: false,
    timedOut: false
  };
  let ticker = null;
  let deadlineTimer = null;

  const $ = sel => document.querySelector(sel);
  const els = {
    start: $('#startView'),
    exam: $('#examView'),
    result: $('#resultView'),
    timer: $('#timer'),
    progressText: $('#progressText'),
    answeredCount: $('#answeredCount'),
    progressBar: $('#progressBar'),
    group: $('#groupText'),
    context: $('#contextBox'),
    prompt: $('#promptText'),
    imageWrap: $('#imageWrap'),
    image: $('#questionImage'),
    options: $('#options'),
    prev: $('#prevBtn'),
    next: $('#nextBtn'),
    nav: $('#navBtn'),
    startBtn: $('#startBtn'),
    resetBtn: $('#resetBtn'),
    paletteModal: $('#paletteModal'),
    palette: $('#palette'),
    closePalette: $('#closePalette'),
    resultContent: $('#resultContent'),
    studentChip: $('#studentChip'),
    backEvalBtn: $('#backEvalBtn'),
    homeBtn: $('#homeBtn')
  };

  init();

  function init(){
    // STEP31-8: 워크북 평가는 인증 후에만 입장한다.
    // 직접 주소로 들어온 경우에는 기존 로그인 화면으로 돌려보내 현재 인증 체계를 그대로 사용한다.
    if (!mainSession || !mainSession.token || !mainSession.name || !mainSession.phone) {
      location.replace(new URL('../../../', location.href).toString());
      return;
    }
    if (student.name || student.phone) {
      const parts = [student.name, student.klass, student.phone].filter(Boolean);
      els.studentChip.textContent = parts.join(' · ');
      els.studentChip.classList.remove('hidden');
    }
    bind();
    restore();
  }

  function bind(){
    els.startBtn.addEventListener('click', startExam);
    els.resetBtn.addEventListener('click', () => {
      if(confirm('현재 응시 기록을 지우고 처음부터 다시 시작할까요?')) resetState();
    });
    els.prev.addEventListener('click', () => move(-1));
    els.next.addEventListener('click', () => {
      if(state.current === QUESTIONS.length - 1) {
        confirmSubmit();
      } else move(1);
    });
    els.nav.addEventListener('click', openPalette);
    els.closePalette.addEventListener('click', closePalette);
    els.paletteModal.addEventListener('click', e => {
      if(e.target === els.paletteModal) closePalette();
    });
    els.backEvalBtn.addEventListener('click', () => navigateAway('../'));
    els.homeBtn.addEventListener('click', () => navigateAway('../../../'));
    window.addEventListener('beforeunload', () => save());
  }

  function authUrl(target){
    const u = new URL(target, location.href);
    const vals = {
      name: student.name,
      klass: student.klass,
      phone: student.phone,
      token: student.token,
      lang: qs.get('lang') || localStorage.getItem('kq_lang') || localStorage.getItem('lang') || 'KR'
    };
    Object.entries(vals).forEach(([k,v]) => {
      if(v !== undefined && v !== null && String(v) !== '') u.searchParams.set(k, String(v));
    });
    return u.toString();
  }

  function navigateAway(target){
    if(state.started && !state.submitted){
      const ok = confirm('시험이 진행 중입니다. 다른 화면으로 이동해도 제한시간은 계속 진행됩니다. 이동할까요?');
      if(!ok) return;
      save();
    }
    location.href = authUrl(target);
  }

  function restore(){
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch(_e) {}
    if(saved && Array.isArray(saved.answers) && saved.answers.length === QUESTIONS.length){
      state = Object.assign(state, saved);
      if(state.submitted){
        showResult(!!state.timedOut);
        return;
      }
      if(state.started){
        if(remainingSec() <= 0){
          submitExam(true);
        } else {
          showExam();
          startTicker();
        }
        return;
      }
    }
    showStart();
  }

  function startExam(){
    state = {
      started: true,
      submitted: false,
      startAt: Date.now(),
      current: 0,
      answers: Array(QUESTIONS.length).fill(null),
      submittedAt: 0,
      attemptId: makeAttemptId(),
      resultSaved: false,
      timedOut: false
    };
    save();
    showExam();
    startTicker();
  }

  function resetState(){
    clearInterval(ticker);
    clearTimeout(deadlineTimer);
    localStorage.removeItem(STORAGE_KEY);
    state = {
      started: false, submitted: false, startAt: 0, current: 0,
      answers: Array(QUESTIONS.length).fill(null), submittedAt: 0,
      attemptId: '', resultSaved: false, timedOut: false
    };
    showStart();
  }

  function showStart(){
    document.body.dataset.view = 'start';
    els.start.classList.remove('hidden');
    els.exam.classList.add('hidden');
    els.result.classList.add('hidden');
    els.timer.textContent = '15:00';
  }

  function showExam(){
    document.body.dataset.view = 'exam';
    els.start.classList.add('hidden');
    els.exam.classList.remove('hidden');
    els.result.classList.add('hidden');
    renderQuestion();
    renderTimer();
  }

  function renderQuestion(doScroll = true){
    const q = QUESTIONS[state.current];
    els.progressText.textContent = `${q.id} / ${QUESTIONS.length}`;
    const answered = state.answers.filter(v => v !== null).length;
    els.answeredCount.textContent = `응답 ${answered}/${QUESTIONS.length}`;
    els.progressBar.style.width = `${((state.current + 1) / QUESTIONS.length) * 100}%`;
    els.group.textContent = q.group || '';
    if(q.context){
      els.context.textContent = q.context;
      els.context.classList.remove('hidden');
    } else {
      els.context.classList.add('hidden');
      els.context.textContent = '';
    }
    els.prompt.textContent = q.prompt;
    if(q.image){
      els.image.src = q.image;
      els.image.alt = `${q.id}번 문제 그림`;
      els.imageWrap.classList.remove('hidden');
    } else {
      els.imageWrap.classList.add('hidden');
      els.image.removeAttribute('src');
    }
    els.options.innerHTML = '';
    q.options.forEach((text, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option' + (state.answers[state.current] === idx ? ' selected' : '');
      btn.innerHTML = `<span class="num">${idx + 1}</span><span>${escapeHtml(text)}</span>`;
      btn.addEventListener('click', () => selectAnswer(idx));
      els.options.appendChild(btn);
    });
    els.prev.disabled = state.current === 0;
    els.prev.style.opacity = state.current === 0 ? '.45' : '1';
    const isLast = state.current === QUESTIONS.length - 1;
    els.next.textContent = isLast ? '제출' : '다음';
    els.next.classList.toggle('submit-mode', isLast);
    if(doScroll) window.scrollTo({top:0, behavior:'smooth'});
  }

  function selectAnswer(idx){
    state.answers[state.current] = idx;
    save();
    renderQuestion(false);
  }

  function move(delta){
    const next = state.current + delta;
    if(next < 0 || next >= QUESTIONS.length) return;
    state.current = next;
    save();
    renderQuestion();
  }

  function openPalette(){
    els.palette.innerHTML = '';
    QUESTIONS.forEach((q, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      const answered = state.answers[idx] !== null;
      b.className = `${answered ? 'done' : 'unanswered'}${idx === state.current ? ' current' : ''}`;
      b.textContent = q.id;
      b.addEventListener('click', () => {
        state.current = idx;
        save();
        closePalette();
        renderQuestion();
      });
      els.palette.appendChild(b);
    });
    els.paletteModal.classList.remove('hidden');
  }

  function closePalette(){ els.paletteModal.classList.add('hidden'); }

  function confirmSubmit(){
    const unanswered = state.answers.filter(v => v === null).length;
    const msg = unanswered
      ? `아직 ${unanswered}문항에 답하지 않았습니다. 그래도 제출할까요?`
      : '답안을 제출할까요? 제출 후에는 답을 바꿀 수 없습니다.';
    if(confirm(msg)) submitExam(false);
  }

  function submitExam(auto){
    if(state.submitted) return;
    state.submitted = true;
    state.timedOut = !!auto;
    state.submittedAt = Date.now();
    save();
    clearInterval(ticker);
    clearTimeout(deadlineTimer);
    showResult(!!auto);
  }

  function showResult(autoTimedOut){
    document.body.dataset.view = 'result';
    els.start.classList.add('hidden');
    els.exam.classList.add('hidden');
    els.result.classList.remove('hidden');
    els.timer.textContent = '완료';
    els.timer.classList.remove('warn','danger');

    let correct = 0;
    QUESTIONS.forEach((q, idx) => { if(state.answers[idx] === q.answer) correct++; });
    const wrong = QUESTIONS.length - correct;
    const unanswered = state.answers.filter(v => v === null).length;
    const percent = Math.round((correct / QUESTIONS.length) * 100);
    const elapsed = Math.max(0, Math.min(DURATION_SEC, Math.floor(((state.submittedAt || Date.now()) - state.startAt) / 1000)));
    const elapsedText = `${Math.floor(elapsed/60)}분 ${String(elapsed%60).padStart(2,'0')}초`;

    const items = QUESTIONS.map((q, idx) => {
      const selected = state.answers[idx];
      const ok = selected === q.answer;
      const my = selected === null ? '미응답' : `${selected+1}번 ${q.options[selected]}`;
      const ans = `${q.answer+1}번 ${q.options[q.answer]}`;
      return `<div class="review-item ${ok ? 'correct' : 'wrong'}">
        <div class="review-title">${q.id}번 ${ok ? '✓ 정답' : '✕ 오답'}</div>
        <div class="review-answer">내 답: <span class="${ok?'ok':'bad'}">${escapeHtml(my)}</span><br>정답: <span class="ok">${escapeHtml(ans)}</span></div>
      </div>`;
    }).join('');

    els.resultContent.innerHTML = `
      <div class="score-big">${correct} / ${QUESTIONS.length}</div>
      <div class="score-sub">${percent}점 · ${autoTimedOut ? '시간 종료로 자동 제출되었습니다.' : '시험이 제출되었습니다.'}</div>
      <div class="result-grid">
        <div class="result-stat"><b>${correct}</b>정답</div>
        <div class="result-stat"><b>${wrong}</b>오답/미응답</div>
        <div class="result-stat"><b>${unanswered}</b>미응답</div>
        <div class="result-stat"><b>${elapsedText}</b>응시시간</div>
      </div>
      <div class="start-actions">
        <button type="button" class="secondary" id="toggleReviewBtn">오답/정답 보기</button>
        <button type="button" class="primary" id="retryBtn">다시 응시</button>
      </div>
      <div id="reviewList" class="review-list hidden">${items}</div>
      <div id="resultSaveStatus" class="save-status">${state.resultSaved ? '구글 시트에 저장되었습니다.' : '시험 결과를 구글 시트에 저장하는 중입니다.'}</div>
      <div class="footer-note">워크북 평가는 별도 결과 시트에만 저장되며 기존 어휘·문법·종합 시험 점수와 진도에는 영향을 주지 않습니다.</div>
    `;
    $('#toggleReviewBtn').addEventListener('click', () => $('#reviewList').classList.toggle('hidden'));
    $('#retryBtn').addEventListener('click', () => {
      if(confirm('새 시험을 시작할까요? 현재 결과는 이 기기에서 지워집니다.')) resetState();
    });
    if(state.resultSaved){
      const el=$('#resultSaveStatus');
      if(el) el.classList.add('ok');
    } else {
      saveWorkbookResult({correct, total:QUESTIONS.length, unanswered, percent, elapsed, autoTimedOut:!!autoTimedOut});
    }
  }

  function enforceDeadline(){
    if(state.started && !state.submitted && remainingSec() <= 0){
      submitExam(true);
      return true;
    }
    return false;
  }

  function startTicker(){
    clearInterval(ticker);
    clearTimeout(deadlineTimer);
    if(enforceDeadline()) return;

    // 화면 타이머와 별개로 마감 시각용 timeout을 둔다.
    // 모바일 브라우저가 백그라운드에서 타이머를 늦추더라도 focus/visibility 복귀 즉시 다시 검사한다.
    deadlineTimer = setTimeout(() => enforceDeadline(), Math.max(50, remainingSec() * 1000 + 80));
    ticker = setInterval(() => {
      renderTimer();
      enforceDeadline();
    }, 500);
  }

  document.addEventListener('visibilitychange', () => {
    if(!document.hidden) enforceDeadline();
  });
  window.addEventListener('focus', enforceDeadline);

  function remainingSec(){
    if(!state.startAt) return DURATION_SEC;
    return Math.max(0, DURATION_SEC - Math.floor((Date.now() - state.startAt) / 1000));
  }

  function renderTimer(){
    const sec = remainingSec();
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    els.timer.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    els.timer.classList.toggle('warn', sec <= 300 && sec > 60);
    els.timer.classList.toggle('danger', sec <= 60);
  }

  function makeAttemptId(){
    return `wb1a_r1_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;
  }

  function sendResultJsonp(payload){
    return new Promise((resolve,reject)=>{
      const cb=`kq_workbook_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script=document.createElement('script');
      const query=new URLSearchParams({...payload,callback:cb});
      let settled=false;
      const cleanup=()=>{
        try{ delete window[cb]; }catch(_e){}
        if(script.parentNode) script.parentNode.removeChild(script);
      };
      const wait=setTimeout(()=>{
        if(settled) return; settled=true; cleanup(); reject(new Error('workbook_result_timeout'));
      },10000);
      window[cb]=(result)=>{
        if(settled) return; settled=true; clearTimeout(wait); cleanup(); resolve(result);
      };
      script.onerror=()=>{
        if(settled) return; settled=true; clearTimeout(wait); cleanup(); reject(new Error('workbook_result_network'));
      };
      script.src=`${RESULT_LOG_SCRIPT_URL}?${query.toString()}`;
      document.head.appendChild(script);
    });
  }

  async function saveWorkbookResult(summary){
    const status=$('#resultSaveStatus');
    if(!state.attemptId) state.attemptId=makeAttemptId();
    if(!student.token || !student.name){
      if(status){
        status.textContent='로그인 정보가 없어 구글 시트에는 저장하지 않았습니다. 메인 화면에서 로그인한 뒤 다시 응시해 주세요.';
        status.classList.add('err');
      }
      save();
      return;
    }
    try{
      const result=await sendResultJsonp({
        action:'workbook_eval_submit',
        token:student.token,
        deviceId:student.deviceId,
        name:student.name,
        klass:student.klass,
        attemptId:state.attemptId,
        book:'SNU-1A',
        review:'복습1(1-2과)',
        evalType:'평가하기',
        score:String(summary.percent),
        correct:String(summary.correct),
        total:String(summary.total),
        unanswered:String(summary.unanswered),
        elapsedSec:String(summary.elapsed),
        timedOut:summary.autoTimedOut?'TRUE':'FALSE',
        answers:JSON.stringify(state.answers),
        ua:(navigator.userAgent||'').slice(0,300)
      });
      if(result && result.ok!==false){
        state.resultSaved=true;
        save();
        if(status){
          status.textContent=result.duplicate ? '이미 저장된 응시 결과입니다.' : '구글 시트에 시험 결과가 저장되었습니다.';
          status.classList.remove('err');
          status.classList.add('ok');
        }
        return;
      }
      const code=(result&&result.error)?String(result.error):'server_rejected';
      if(status){
        status.textContent=`구글 시트 저장 실패: ${code}`;
        status.classList.add('err');
      }
    }catch(err){
      if(status){
        status.textContent='구글 시트 저장 실패: 네트워크 오류';
        status.classList.add('err');
      }
      console.log('workbook result save failed:',err);
    }
  }

  function save(){
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(_e) {}
  }

  function escapeHtml(str){
    return String(str).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  }
})();
