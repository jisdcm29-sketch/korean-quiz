/******************************************************
 * K-Quiz Logger (JSONP) - Google Apps Script
 * action=issue     : 선생님 비번으로 토큰 발급
 * action=validate  : 학생 입장 검증
 * action=log       : 시험 종료 기록 + 텔레그램 알림
 *
 * - iPhone/Android 안정성을 위해 JSONP 지원
 * - 기록은 Spreadsheet에 저장 (최우선)
 * - 텔레그램은 성공/실패 모두 TELEGRAM_LOG 시트에 기록(항상)
 * - 텔레그램 실패는 TELEGRAM_FAIL 시트에도 기록
 *
 * ★★★ 학생 접속 시에도 텔레그램 알림이 오려면 ★★★
 *     반드시 "배포" 시 "실행 사용자: 나" 로 설정해야 합니다.
 *     "실행 사용자: 앱에 접속한 사용자" 이면 학생 계정으로 실행되어
 *     스크립트 속성(TELEGRAM_TOKEN 등)을 읽지 못해 알림이 가지 않습니다.
 *     자세한 설정: 프로젝트 내 gas/DEPLOY-GUIDE.md 참고
 ******************************************************/

// ====== 설정 ======
const TOKEN_TTL_SEC = 60 * 60 * 2; // 토큰 유효시간: 2시간

// ✅ 허용 반(화이트리스트) — 이 반만 토큰 발급/기록 허용
const ALLOWED_CLASSES = ["BBTA1반", "EKO2반"];

// 텔레그램 재시도 설정(429/일시 오류 대비)
const TG_MAX_RETRIES = 5;      // 최대 재시도 횟수
const TG_BASE_WAIT_MS = 1200;  // 기본 대기(ms)

/**
 * (권장) 아래 3개 값은 "스크립트 속성"에 넣어 사용하세요.
 * - MASTER_PASSWORD
 * - TELEGRAM_TOKEN
 * - TELEGRAM_CHAT_ID
 */
const FALLBACK_MASTER_PASSWORD = "";
const FALLBACK_TELEGRAM_TOKEN = "";
const FALLBACK_TELEGRAM_CHAT_ID = "5418932608";

// ====== 공통 유틸 ======
function nowMs_() { return Date.now(); }

// JSONP callback 인젝션 방지: JS 식별자/점(.)만 허용
function sanitizeCallback_(cb) {
  cb = (cb || "").trim();
  if (!cb) return "";
  const ok = /^[a-zA-Z_$][0-9a-zA-Z_$\.]{0,63}$/.test(cb);
  return ok ? cb : "";
}

function jsonp_(callback, obj) {
  const cb = sanitizeCallback_(callback);
  const text = cb ? `${cb}(${JSON.stringify(obj)});` : JSON.stringify(obj);
  return ContentService.createTextOutput(text)
    .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}

// Script Properties에서 값 읽기(없으면 fallback)
function getSecret_(key, fallback) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return (v && String(v).trim()) ? String(v).trim() : (fallback || "");
}

function tokenKey_(t) { return "t_" + t; }

/**
 * 토큰 로드 + 공통 검증
 * - Cache 존재 확인
 * - JSON 파싱 확인
 * - exp(만료) 확인(이중 안전)
 * - deviceId 일치 확인
 */
function loadAndVerifyToken_(token, deviceId) {
  const raw = CacheService.getScriptCache().get(tokenKey_(token));
  if (!raw) return { ok: false, error: "expired_or_invalid" };

  let payload;
  try { payload = JSON.parse(raw); }
  catch (e) { return { ok: false, error: "corrupt_token" }; }

  if (!payload || !payload.deviceId) return { ok: false, error: "corrupt_token" };

  if (payload.exp && nowMs_() > payload.exp) {
    CacheService.getScriptCache().remove(tokenKey_(token));
    return { ok: false, error: "expired_or_invalid" };
  }

  if ((deviceId || "") !== payload.deviceId) {
    return { ok: false, error: "device_mismatch" };
  }

  return { ok: true, payload };
}

/**
 * (선택) token 공유 방지: URL로 넘어온 klass/name과 payload 비교
 * - validate/log에서 klass/name이 비어있으면 검증 스킵(호환성 유지)
 */
function verifyIdentityOptional_(payload, klass, name) {
  if (klass && klass !== payload.klass) return { ok: false, error: "identity_mismatch" };
  if (name && name !== payload.name) return { ok: false, error: "identity_mismatch" };
  return { ok: true };
}

// ====== 메인 엔드포인트 ======
function doGet(e) {
  const p = (e && e.parameter) ? e.parameter : {};
  const action = (p.action || "").toLowerCase();
  const callback = p.callback || "";

  // 1) 토큰 발급: action=issue
  if (action === "issue") {
    const MASTER_PASSWORD = getSecret_("MASTER_PASSWORD", FALLBACK_MASTER_PASSWORD);

    const pass = (p.pass || "").trim();
    const klass = (p.klass || "").trim();
    const name = (p.name || "").trim();
    const deviceId = (p.deviceId || "").trim();

    if (!MASTER_PASSWORD) return jsonp_(callback, { ok: false, error: "server_not_configured" });
    if (pass !== MASTER_PASSWORD) return jsonp_(callback, { ok: false, error: "bad_password" });
    if (!klass || !name || !deviceId) return jsonp_(callback, { ok: false, error: "missing_fields" });

    // ✅ 허용 반만 발급
    if (!ALLOWED_CLASSES.includes(klass)) {
      return jsonp_(callback, { ok: false, error: "invalid_class" });
    }

    const t = Utilities.getUuid().replace(/-/g, "");
    const payload = { klass, name, deviceId, iat: nowMs_(), exp: nowMs_() + TOKEN_TTL_SEC * 1000 };

    CacheService.getScriptCache().put(tokenKey_(t), JSON.stringify(payload), TOKEN_TTL_SEC);
    return jsonp_(callback, { ok: true, token: t });
  }

  // 2) 토큰 검증: action=validate
  if (action === "validate") {
    const token = (p.token || "").trim();
    const deviceId = (p.deviceId || "").trim();

    const klass = (p.klass || "").trim();
    const name = (p.name || "").trim();

    if (!token || !deviceId) return jsonp_(callback, { ok: false, error: "missing_fields" });

    const v = loadAndVerifyToken_(token, deviceId);
    if (!v.ok) return jsonp_(callback, v);

    if (!ALLOWED_CLASSES.includes(v.payload.klass)) {
      return jsonp_(callback, { ok: false, error: "invalid_class" });
    }

    const idv = verifyIdentityOptional_(v.payload, klass, name);
    if (!idv.ok) return jsonp_(callback, idv);

    return jsonp_(callback, { ok: true });
  }

  // 3) 기록 저장 + 텔레그램: action=log
  if (action === "log") {
    const token = (p.token || "").trim();
    const deviceId = (p.deviceId || "").trim();

    const klassParam = (p.klass || "").trim();
    const nameParam = (p.name || "").trim();

    const book = (p.book || "").trim();
    const lesson = (p.lesson || "").trim();
    const score = (p.score || "").trim();
    const attempts = (p.attempts || "").trim();
    const ua = (p.ua || "").trim();

    if (!token || !deviceId || !book || !lesson) {
      return jsonp_(callback, { ok: false, error: "missing_fields" });
    }

    const v = loadAndVerifyToken_(token, deviceId);
    if (!v.ok) return jsonp_(callback, v);

    // ✅ 허용 반이 아니면 차단(시트 생성 방지)
    if (!ALLOWED_CLASSES.includes(v.payload.klass)) {
      CacheService.getScriptCache().remove(tokenKey_(token));
      return jsonp_(callback, { ok: false, error: "invalid_class" });
    }

    const idv = verifyIdentityOptional_(v.payload, klassParam, nameParam);
    if (!idv.ok) return jsonp_(callback, idv);

    const lock = LockService.getScriptLock();
    lock.waitLock(15000);

    try {
      // [A] 스프레드시트 기록(최우선)
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      let sh = ss.getSheetByName(v.payload.klass);
      if (!sh) sh = ss.insertSheet(v.payload.klass);

      const header = ["timestamp", "class", "name", "book", "lesson", "score", "attempts", "deviceId", "userAgent"];
      if (sh.getLastRow() === 0) {
        sh.appendRow(header);
      } else {
        const existing = sh.getRange(1, 1, 1, 9).getValues()[0];
        const same = existing && existing.length === 9 && existing.every((val, i) => String(val) === header[i]);
        if (!same) {
          sh.insertRowBefore(1);
          sh.getRange(1, 1, 1, 9).setValues([header]);
        }
      }

      const uaSafe = ua.length > 500 ? ua.slice(0, 500) : ua;

      sh.appendRow([
        new Date(),
        v.payload.klass,
        v.payload.name,
        book,
        lesson,
        score,
        attempts,
        v.payload.deviceId,
        uaSafe
      ]);

      // [B] 텔레그램 알림 (성공/실패 모두 TELEGRAM_LOG에 기록)
      const tgToken = getSecret_("TELEGRAM_TOKEN", FALLBACK_TELEGRAM_TOKEN);
      const tgChatId = getSecret_("TELEGRAM_CHAT_ID", FALLBACK_TELEGRAM_CHAT_ID);

      const tgMessage =
        `✅ [학습 기록 접수]\n` +
        `반: ${v.payload.klass}\n` +
        `이름: ${v.payload.name}\n` +
        `교재: ${book}\n` +
        `단원: ${lesson}\n` +
        `점수: ${score}점\n` +
        `시도: ${attempts}회`;

      let tgRes;
      if (tgToken && tgChatId) {
        try {
          tgRes = sendTelegram_(tgToken, tgChatId, tgMessage);
        } catch (ex) {
          tgRes = { ok: false, code: "EXCEPTION", body: String(ex), tries: 0, message_id: "" };
        }
      } else {
        tgRes = { ok: false, code: "NO_CONFIG", body: "Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID", tries: 0, message_id: "" };
      }

      // ✅ 항상 기록: 성공/실패 모두 TELEGRAM_LOG
      logTelegramLog_(v.payload, book, lesson, score, attempts, tgChatId, tgRes);

      // ✅ 실패면 TELEGRAM_FAIL에도 기록
      if (!tgRes.ok) {
        logTelegramFail_(v.payload, book, lesson, score, attempts, tgChatId, tgRes);
      }

      // [C] 토큰 무효화(재사용 방지)
      CacheService.getScriptCache().remove(tokenKey_(token));

      return jsonp_(callback, { ok: true });

    } catch (err) {
      return jsonp_(callback, { ok: false, error: "save_failed", detail: String(err) });
    } finally {
      try { lock.releaseLock(); } catch (e2) {}
    }
  }

  return jsonp_(callback, { ok: false, error: "unknown_action" });
}

// ====== 텔레그램 전송(내부용) ======
// ✅ 429(Too Many Requests) / 5xx 대비 재시도, 결과 리턴
function sendTelegram_(telegramToken, chatId, text) {
  const url = "https://api.telegram.org/bot" + telegramToken + "/sendMessage";

  let lastCode = "";
  let lastBody = "";
  let tries = 0;
  let messageId = "";

  for (let attempt = 1; attempt <= TG_MAX_RETRIES; attempt++) {
    tries = attempt;

    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      muteHttpExceptions: true,
      payload: JSON.stringify({
        chat_id: chatId,
        text: text,
        disable_web_page_preview: true
      })
    });

    const code = res.getResponseCode();
    const body = res.getContentText();

    lastCode = code;
    lastBody = body;

    // 성공
    if (code >= 200 && code < 300) {
      try {
        const obj = JSON.parse(body);
        messageId = obj?.result?.message_id ? String(obj.result.message_id) : "";
      } catch (e) {}
      return { ok: true, code, body, tries, message_id: messageId };
    }

    // 429면 retry_after 존중
    if (code === 429) {
      let waitMs = TG_BASE_WAIT_MS;
      try {
        const obj = JSON.parse(body);
        const retryAfter = obj?.parameters?.retry_after;
        if (retryAfter) waitMs = (Number(retryAfter) + 1) * 1000;
      } catch (e) {}
      Utilities.sleep(waitMs);
      continue;
    }

    // 5xx면 잠깐 쉬고 재시도
    if (code >= 500 && code <= 599) {
      Utilities.sleep(TG_BASE_WAIT_MS * attempt);
      continue;
    }

    // 그 외(401/400/403 등)는 즉시 종료
    return { ok: false, code, body, tries, message_id: "" };
  }

  return { ok: false, code: lastCode || "UNKNOWN", body: lastBody || "no response body", tries, message_id: "" };
}

// ✅ 텔레그램 전송 결과를 항상 기록(성공/실패 공통)
function logTelegramLog_(payload, book, lesson, score, attempts, tgChatId, tgRes) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName("TELEGRAM_LOG");
  if (!sh) sh = ss.insertSheet("TELEGRAM_LOG");

  if (sh.getLastRow() === 0) {
    sh.appendRow([
      "timestamp","class","name","book","lesson","score","attempts","deviceId",
      "tgChatId","tgOk","tgHttp","tgTries","tgMessageId","tgBody"
    ]);
  }

  const bodyShort = String(tgRes.body || "").slice(0, 500);

  sh.appendRow([
    new Date(),
    payload.klass,
    payload.name,
    book,
    lesson,
    score,
    attempts,
    payload.deviceId,
    tgChatId || "",
    tgRes.ok ? "TRUE" : "FALSE",
    String(tgRes.code),
    String(tgRes.tries || ""),
    String(tgRes.message_id || ""),
    bodyShort
  ]);
}

// ✅ 실패만 따로 모으는 탭(빠른 확인용)
function logTelegramFail_(payload, book, lesson, score, attempts, tgChatId, tgRes) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName("TELEGRAM_FAIL");
  if (!sh) sh = ss.insertSheet("TELEGRAM_FAIL");

  if (sh.getLastRow() === 0) {
    sh.appendRow([
      "timestamp","class","name","book","lesson","score","attempts","deviceId",
      "tgChatId","tgHttp","tgTries","tgBody"
    ]);
  }

  const bodyShort = String(tgRes.body || "").slice(0, 500);

  sh.appendRow([
    new Date(),
    payload.klass,
    payload.name,
    book,
    lesson,
    score,
    attempts,
    payload.deviceId,
    tgChatId || "",
    String(tgRes.code),
    String(tgRes.tries || ""),
    bodyShort
  ]);
}

// ====== 권한 승인용(유지) ======
function authorizeUrlFetch() {
  const tgToken = getSecret_("TELEGRAM_TOKEN", FALLBACK_TELEGRAM_TOKEN);
  const tgChatId = getSecret_("TELEGRAM_CHAT_ID", FALLBACK_TELEGRAM_CHAT_ID);
  if (!tgToken || !tgChatId) {
    throw new Error("스크립트 속성에 TELEGRAM_TOKEN, TELEGRAM_CHAT_ID를 설정한 뒤 다시 실행하세요.");
  }
  const url = "https://api.telegram.org/bot" + tgToken + "/sendMessage";
  UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ chat_id: tgChatId, text: "✅ Apps Script 권한 승인 테스트" }),
    muteHttpExceptions: true
  });
}
