const AUTH_SHEET_NAME = "인증목록";
const AUTH_TOKEN_TTL_SEC = 60 * 60 * 2;

function normalizePhone_(value) {
  return String(value == null ? "" : value).replace(/\D/g, "");
}

function isEnabled_(value) {
  if (value === true) return true;
  const s = String(value == null ? "" : value).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y" || s === "사용" || s === "사용중";
}

function authTokenKey_(token) {
  return "phone_auth_" + token;
}

function checkAuthorizedPhone_(ss, phone) {
  const sh = ss.getSheetByName(AUTH_SHEET_NAME);
  if (!sh) return { ok: false, error: "auth_sheet_missing" };

  const target = normalizePhone_(phone);
  if (!target) return { ok: false, error: "missing_phone" };

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: false, error: "not_authorized" };

  // A: 인증번호(전화번호), B: 학생이름(관리용), C: 사용여부
  const values = sh.getRange(2, 1, lastRow - 1, 3).getValues();
  for (let i = 0; i < values.length; i++) {
    const savedPhone = normalizePhone_(values[i][0]);
    const enabled = isEnabled_(values[i][2]);
    if (savedPhone === target && enabled) {
      return { ok: true, phone: target };
    }
  }

  return { ok: false, error: "not_authorized" };
}

function issueAuthToken_(phone, name, deviceId) {
  const token = Utilities.getUuid().replace(/-/g, "");
  const payload = {
    phone: normalizePhone_(phone),
    name: String(name || "").trim(),
    deviceId: String(deviceId || "").trim(),
    iat: Date.now(),
    exp: Date.now() + AUTH_TOKEN_TTL_SEC * 1000
  };
  CacheService.getScriptCache().put(authTokenKey_(token), JSON.stringify(payload), AUTH_TOKEN_TTL_SEC);
  return token;
}

function validateAuthToken_(ss, token, deviceId, name) {
  token = String(token || "").trim();
  deviceId = String(deviceId || "").trim();
  name = String(name || "").trim();

  if (!token) return { ok: false, error: "missing_token" };

  const raw = CacheService.getScriptCache().get(authTokenKey_(token));
  if (!raw) return { ok: false, error: "expired_or_invalid" };

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: "corrupt_token" };
  }

  if (!payload || !payload.phone) return { ok: false, error: "corrupt_token" };
  if (payload.exp && Date.now() > payload.exp) {
    CacheService.getScriptCache().remove(authTokenKey_(token));
    return { ok: false, error: "expired_or_invalid" };
  }

  if (payload.deviceId && deviceId && payload.deviceId !== deviceId) {
    return { ok: false, error: "device_mismatch" };
  }
  if (payload.name && name && payload.name !== name) {
    return { ok: false, error: "identity_mismatch" };
  }

  // 시트에서 삭제하거나 FALSE로 바꾸면 다음 검증부터 즉시 차단
  const auth = checkAuthorizedPhone_(ss, payload.phone);
  if (!auth.ok) {
    CacheService.getScriptCache().remove(authTokenKey_(token));
    return { ok: false, error: "not_authorized" };
  }

  return { ok: true, payload: payload };
}

function jsonpOutput_(callback, obj) {
  const cb = String(callback || "callback").replace(/[^\w$]/g, "") || "callback";
  return ContentService
    .createTextOutput(`${cb}(${JSON.stringify(obj)})`)
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function doGet(e) {
  const p = (e && e.parameter) ? e.parameter : {};
  const ss = SpreadsheetApp.getActive();
  const action = String(p.action || "").trim().toLowerCase();
  const callback = p.callback || "callback";

  // 1) 전화번호 인증 + 서버 토큰 발급
  if (action === "auth") {
    const phone = normalizePhone_(p.phone || "");
    const name = String(p.name || "").trim();
    const deviceId = String(p.deviceId || "").trim();

    if (!name) return jsonpOutput_(callback, { ok: false, error: "missing_name" });

    const auth = checkAuthorizedPhone_(ss, phone);
    if (!auth.ok) return jsonpOutput_(callback, auth);

    const token = issueAuthToken_(phone, name, deviceId);
    return jsonpOutput_(callback, { ok: true, token: token });
  }

  // 2) 페이지 진입 시 토큰 검증
  if (action === "validate") {
    const result = validateAuthToken_(ss, p.token, p.deviceId, p.name);
    if (!result.ok) return jsonpOutput_(callback, result);
    return jsonpOutput_(callback, { ok: true });
  }

  // 3) 인증이 필요한 기록 요청 보호
  if (action === "log" || action === "session_start") {
    const result = validateAuthToken_(ss, p.token, p.deviceId, p.name);
    if (!result.ok) return jsonpOutput_(callback, result);
  }

  // 일반 이벤트 로그 시트
  const sheetName = p.sheet || "Log";
  const sh = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);

  // 세션 시트
  const sessName = "Sessions";
  const sess = ss.getSheetByName(sessName) || ss.insertSheet(sessName);

  if (sh.getLastRow() === 0) {
    sh.appendRow([
      "ts","action","name","klass","token","deviceId","book","lesson",
      "score","attempts","ua","lang","extra"
    ]);
  }

  if (sess.getLastRow() === 0) {
    sess.appendRow([
      "sessionId","name","klass","token","deviceId","lang",
      "loginAt","logoutAt","durationSec","reason","ua","updatedAt"
    ]);
  }

  const ts = new Date();
  const sessionId = String(p.sessionId || "");

  if ((action === "session_start" || action === "session_end") && sessionId) {
    const lock = LockService.getScriptLock();
    lock.tryLock(5000);
    try {
      const lastRow = sess.getLastRow();
      const values = lastRow ? sess.getRange(1, 1, lastRow, 12).getValues() : [];
      let rowIndex = -1;

      for (let i = 1; i < values.length; i++) {
        if (String(values[i][0]) === sessionId) {
          rowIndex = i + 1;
          break;
        }
      }

      if (action === "session_start" && rowIndex === -1) {
        const loginAt = p.loginAt ? new Date(p.loginAt) : ts;
        sess.appendRow([
          sessionId,
          p.name || "",
          p.klass || "",
          p.token || "",
          p.deviceId || "",
          p.lang || "",
          loginAt,
          "",
          "",
          "login",
          p.ua || "",
          ts
        ]);
      }

      if (action === "session_end") {
        const loginAt = p.loginAt ? new Date(p.loginAt) : ts;
        const logoutAt = p.logoutAt ? new Date(p.logoutAt) : ts;
        const durSec = Math.max(0, Math.round((logoutAt.getTime() - loginAt.getTime()) / 1000));
        const reason = String(p.reason || "logout");

        if (rowIndex === -1) {
          sess.appendRow([
            sessionId,
            p.name || "",
            p.klass || "",
            p.token || "",
            p.deviceId || "",
            p.lang || "",
            loginAt,
            logoutAt,
            durSec,
            reason,
            p.ua || "",
            ts
          ]);
        } else {
          sess.getRange(rowIndex, 2).setValue(p.name || "");
          sess.getRange(rowIndex, 3).setValue(p.klass || "");
          sess.getRange(rowIndex, 4).setValue(p.token || "");
          sess.getRange(rowIndex, 5).setValue(p.deviceId || "");
          sess.getRange(rowIndex, 6).setValue(p.lang || "");
          sess.getRange(rowIndex, 7).setValue(loginAt);
          sess.getRange(rowIndex, 8).setValue(logoutAt);
          sess.getRange(rowIndex, 9).setValue(durSec);
          sess.getRange(rowIndex, 10).setValue(reason);
          sess.getRange(rowIndex, 11).setValue(p.ua || "");
          sess.getRange(rowIndex, 12).setValue(ts);
        }
      }
    } finally {
      try { lock.releaseLock(); } catch (err) {}
    }
  }

  // 모든 일반 요청을 Log 시트에 기록
  sh.appendRow([
    ts,
    p.action || "",
    p.name || "",
    p.klass || "",
    p.token || "",
    p.deviceId || "",
    p.book || "",
    p.lesson || "",
    p.score || "",
    p.attempts || "",
    p.ua || "",
    p.lang || "",
    JSON.stringify(p)
  ]);

  return jsonpOutput_(callback, { ok: true, ts: ts.toISOString() });
}
