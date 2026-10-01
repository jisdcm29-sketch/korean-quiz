/* Korean Quiz: one activity clock across study pages. v20261001 */
(() => {
  'use strict';
  if (window.KQSession) return;
  const script = document.currentScript;
  const home = new URL('../index.html', script.src);
  const rootPage = new URL(location.href).pathname === home.pathname;
  const KEY = 'kq_session_v1';
  const HEARTBEAT_KEY = 'kq_server_check_v1';
  const IDLE_MS = 30 * 60 * 1000;
  const WRITE_MS = 5000;
  const CHECK_MS = 15 * 60 * 1000;
  const ENDPOINT = 'https://script.google.com/macros/s/AKfycbz6WBgnJXTAperJK2NwX-VwkmPEQrU4SluCcXjbmYYgcywYM2AcHZwkymBse6E9Kaqg/exec';
  let idleTimer, serverTimer, memoryToken = '', memoryActive = 0;
  let lastWrite = 0, ending = false, pending = false;
  function read() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      return s && s.token && s.name && s.klass ? s : null;
    } catch (_) { return null; }
  }
  function activityAt(s) {
    return Math.max(Number(s && s.lastActive) || 0,
      s && s.token === memoryToken ? memoryActive : 0);
  }
  function expired(s) {
    const t = activityAt(s);
    return !s || !t || Date.now() - t >= IDLE_MS;
  }
  function jsonp(params) {
    return new Promise((resolve, reject) => {
      const cb = 'cb_kq_session_' + Date.now() + '_' + Math.random().toString(16).slice(2);
      const node = document.createElement('script');
      const cleanup = () => { clearTimeout(timer); node.remove(); delete window[cb]; };
      const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 10000);
      window[cb] = data => { cleanup(); resolve(data); };
      node.onerror = () => { cleanup(); reject(new Error('network')); };
      node.src = ENDPOINT + '?' + new URLSearchParams({ ...params, callback: cb });
      document.head.appendChild(node);
    });
  }
  function end(reason = 'timeout', clear = true) {
    if (ending) return;
    ending = true;
    const s = clear ? read() : null;
    clearTimeout(idleTimer); clearTimeout(serverTimer);
    if (clear) try { localStorage.removeItem(KEY); localStorage.removeItem(HEARTBEAT_KEY); } catch (_) {}
    memoryActive = 0; memoryToken = '';
    // Log without delaying logout. session_end is already supported by the server.
    if (s && s.sessionId && s.loginAt) {
      const p = new URLSearchParams({action:'session_end',token:s.token,
        deviceId:s.deviceId || localStorage.getItem('kq_deviceId_v1') || '',
        name:s.name,klass:s.klass,sessionId:s.sessionId,loginAt:s.loginAt,
        logoutAt:new Date().toISOString(),reason,
        ua:navigator.userAgent || '',lang:localStorage.getItem('kq_lang') || 'KR'});
      try { fetch(ENDPOINT + '?' + p.toString(), {mode:'no-cors',keepalive:true}).catch(() => {}); } catch (_) {}
    }
    home.search = ''; home.hash = '';
    home.searchParams.set('logout', reason);
    location.replace(home.href);
  }
  function persist(s) {
    const current = read();
    if (!current || current.token !== s.token) return false;
    current.lastActive = Math.max(activityAt(current), memoryActive);
    try { localStorage.setItem(KEY, JSON.stringify(current)); } catch (_) { return false; }
    lastWrite = Date.now();
    return true;
  }
  function check(reschedule = true) {
    if (ending) return false;
    const s = read();
    if (!s) {
      if (!rootPage || memoryToken) end('session_removed');
      return false;
    }
    if (expired(s)) { end('timeout'); return false; }
    const u = new URL(location.href);
    const keys = ['name', 'klass', 'token'];
    if (keys.some(k => u.searchParams.has(k)) &&
        keys.some(k => (u.searchParams.get(k) || '').trim() !== String(s[k] || ''))) {
      end('url_session_mismatch'); return false;
    }
    memoryToken = s.token;
    if (reschedule || !idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(check, Math.max(1, IDLE_MS - (Date.now() - activityAt(s))));
    }
    return true;
  }
  function touch(force = false) {
    if (!check(false)) return false; // Check BEFORE renewing; an expired session cannot revive.
    const s = read();
    memoryToken = s.token; memoryActive = Date.now();
    if (force || Date.now() - lastWrite >= WRITE_MS || IDLE_MS-(Date.now()-Number(s.lastActive||0))<WRITE_MS) persist(s);
    // No per-pointer-event timer reset: the existing timer checks the latest clock.
    scheduleServer();
    return true;
  }
  function serverState() {
    try { return JSON.parse(localStorage.getItem(HEARTBEAT_KEY) || 'null'); }
    catch (_) { return null; }
  }
  function noteValidated() {
    const s = read(); if (!s || ending) return;
    try { localStorage.setItem(HEARTBEAT_KEY, JSON.stringify({token:s.token,at:Date.now()})); }
    catch (_) {}
  }
  function scheduleServer() {
    if (serverTimer || pending || ending) return;
    const s = read(); if (!s) return;
    let state = serverState();
    if (!state || state.token !== s.token) { noteValidated(); state = serverState(); }
    const wait = Math.max(1000, CHECK_MS - (Date.now() - Number(state && state.at || Date.now())));
    serverTimer = setTimeout(() => { serverTimer = null; heartbeat(); }, wait);
  }
  async function heartbeat() {
    if (!check()) return;
    if (document.visibilityState === 'hidden') return; // Resume checks on visibility/pageshow.
    const s = read(), state = serverState();
    if (state && state.token === s.token && Date.now() - state.at < CHECK_MS) {
      scheduleServer(); return;
    }
    pending = true;
    // Reserve this check across tabs. No cached result is used to grant page access.
    noteValidated();
    try {
      const r = await jsonp({action:'validate',token:s.token,name:s.name,
        deviceId:s.deviceId || localStorage.getItem('kq_deviceId_v1') || ''});
      const current = read();
      if (!current || current.token !== s.token) return;
      if (!r || !r.ok) { end('server_invalid'); return; }
      noteValidated();
    } catch (_) { /* Transient network failures do not renew the local activity clock. */ }
    finally { pending = false; scheduleServer(); }
  }
  window.KQSession = {read,expired,check,touch,end,noteValidated,idleMs:IDLE_MS};
  // Capture before page-specific buttons can navigate or update lastActive.
  ['pointerdown','pointermove','keydown','scroll','touchstart','click'].forEach(evt => {
    window.addEventListener(evt, event => {
      if (ending) { event.stopImmediatePropagation(); event.preventDefault(); return; }
      if (!read()) return;
      if (!touch()) { event.stopImmediatePropagation(); event.preventDefault(); }
    }, {capture:true, passive:false});
  });
  function resume() { if (check()) { touch(true); scheduleServer(); } }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
    else { const s=read(); if(s && s.token===memoryToken && !expired(s)) persist(s); }
  });
  window.addEventListener('pageshow', resume);
  window.addEventListener('pagehide', () => { const s=read(); if(s && s.token===memoryToken && !expired(s)) persist(s); });
  window.addEventListener('storage', event => {
    if (event.key === KEY) {
      const s=read();
      if (s && memoryToken && s.token !== memoryToken) { end('session_changed', false); return; }
      check();
    }
  });
  if (check()) scheduleServer();
})();
