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
      return {
        ok: true,
        phone: target,
        studentName: String(values[i][1] == null ? "" : values[i][1]).trim()
      };
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

  return {
    ok: true,
    payload: payload,
    phone: auth.phone || payload.phone || "",
    studentName: auth.studentName || payload.name || ""
  };
}

const TEST_RESULTS_SHEET_NAME = "TestResults";
const TEST_PASS_SCORE = 90;

function testResultDateKey_(ss, dateValue) {
  const tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || "Asia/Ulaanbaatar";
  return Utilities.formatDate(dateValue, tz, "yyyy-MM-dd");
}

function getTestResultsSheet_(ss) {
  const headers = [
    "date", "phone", "name", "klass", "book", "lesson", "testType",
    "bestScore", "attemptsToday", "bestCorrect", "total", "bestTimeout",
    "firstAt", "bestAt", "lastAt", "status"
  ];

  const sh = ss.getSheetByName(TEST_RESULTS_SHEET_NAME) || ss.insertSheet(TEST_RESULTS_SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

function normalizeTestDateKey_(ss, rawValue, displayValue) {
  if (rawValue instanceof Date && !isNaN(rawValue.getTime())) {
    return testResultDateKey_(ss, rawValue);
  }

  const shown = String(displayValue == null ? "" : displayValue).trim();
  const raw = String(rawValue == null ? "" : rawValue).trim();
  const text = shown || raw;
  const m = text.match(/^(\d{4})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})\.?$/);
  if (m) {
    return m[1] + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[3]).padStart(2, "0");
  }

  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) return testResultDateKey_(ss, parsed);
  return text;
}

function normalizeTestBook_(value) {
  return String(value == null ? "" : value).trim().replace(/\s+/g, "").toUpperCase();
}

function normalizeTestLesson_(value) {
  const s = String(value == null ? "" : value).trim();
  if (/^\d+$/.test(s)) return String(Number(s));
  return s.replace(/\s+/g, "").toLowerCase();
}

function normalizeTestType_(value) {
  return String(value == null ? "" : value).trim().replace(/\s+/g, "").toLowerCase();
}

function makeTestResultKey_(dateKey, phone, book, lesson, testType) {
  return [
    String(dateKey || "").trim(),
    normalizePhone_(phone),
    normalizeTestBook_(book),
    normalizeTestLesson_(lesson),
    normalizeTestType_(testType)
  ].join("|");
}

function validDateValue_(value) {
  return value instanceof Date && !isNaN(value.getTime());
}

function updateTestResultBest_(ss, p, verifiedIdentity, ts) {
  const testType = normalizeTestType_(p.testType);
  const scoreRaw = String(p.score == null ? "" : p.score).trim();
  if (!testType || !scoreRaw) return null;

  const score = Number(scoreRaw);
  if (!Number.isFinite(score)) return null;

  const phone = normalizePhone_((verifiedIdentity && verifiedIdentity.phone) || "");
  if (!phone) return null;

  const registeredName = String(
    (verifiedIdentity && verifiedIdentity.studentName) || p.name || ""
  ).trim();
  const dateKey = testResultDateKey_(ss, ts);
  const book = String(p.book || "").trim();
  const lesson = String(p.lesson || "").trim();
  const klass = String(p.klass || "").trim();
  const correct = String(p.correct == null ? "" : p.correct).trim();
  const total = String(p.total == null ? "" : p.total).trim();
  const timeout = String(p.timeout == null ? "" : p.timeout).trim();
  const wantedKey = makeTestResultKey_(dateKey, phone, book, lesson, testType);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = getTestResultsSheet_(ss);
    const lastRow = sh.getLastRow();
    const rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, 16).getValues() : [];
    const shownRows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, 16).getDisplayValues() : [];
    const matches = [];

    for (let i = 0; i < rows.length; i++) {
      const rowDate = normalizeTestDateKey_(ss, rows[i][0], shownRows[i][0]);
      const rowKey = makeTestResultKey_(
        rowDate,
        rows[i][1],
        rows[i][4],
        rows[i][5],
        rows[i][6]
      );
      if (rowKey === wantedKey) matches.push(i);
    }

    if (matches.length === 0) {
      const status = score >= TEST_PASS_SCORE ? "PASS" : "RETRY";
      sh.appendRow([
        dateKey, phone, registeredName, klass, book, lesson, testType,
        score, 1, correct, total, timeout,
        ts, ts, ts, status
      ]);
      return {
        bestScore: score,
        attemptsToday: 1,
        status: status,
        updated: true,
        mergedDuplicates: 0
      };
    }

    // 기존 중복 행이 있더라도 한 행으로 자동 병합한다.
    let attemptsToday = 0;
    let bestScore = -Infinity;
    let bestCorrect = "";
    let bestTotal = "";
    let bestTimeout = "";
    let firstAt = null;
    let bestAt = null;
    let lastAt = null;

    for (let j = 0; j < matches.length; j++) {
      const row = rows[matches[j]];
      const rowAttempts = Number(row[8]);
      attemptsToday += Number.isFinite(rowAttempts) && rowAttempts > 0 ? rowAttempts : 1;

      const rowScore = Number(row[7]);
      if (Number.isFinite(rowScore) && rowScore > bestScore) {
        bestScore = rowScore;
        bestCorrect = row[9];
        bestTotal = row[10];
        bestTimeout = row[11];
        bestAt = row[13] || row[14] || row[12] || null;
      }

      if (validDateValue_(row[12]) && (!firstAt || row[12].getTime() < firstAt.getTime())) {
        firstAt = row[12];
      }
      if (validDateValue_(row[14]) && (!lastAt || row[14].getTime() > lastAt.getTime())) {
        lastAt = row[14];
      }
    }

    attemptsToday += 1;
    const isNewBest = !Number.isFinite(bestScore) || score > bestScore;
    if (isNewBest) {
      bestScore = score;
      bestCorrect = correct;
      bestTotal = total;
      bestTimeout = timeout;
      bestAt = ts;
    }

    if (!firstAt) firstAt = ts;
    if (!bestAt) bestAt = ts;
    lastAt = ts;

    const status = bestScore >= TEST_PASS_SCORE ? "PASS" : "RETRY";
    const targetSheetRow = matches[0] + 2;
    sh.getRange(targetSheetRow, 1, 1, 16).setValues([[
      dateKey,
      phone,
      registeredName,
      klass,
      book,
      lesson,
      testType,
      bestScore,
      attemptsToday,
      bestCorrect,
      bestTotal,
      bestTimeout,
      firstAt,
      bestAt,
      lastAt,
      status
    ]]);

    // 첫 번째 행만 남기고 같은 키의 중복 행은 아래에서부터 삭제한다.
    for (let j = matches.length - 1; j >= 1; j--) {
      sh.deleteRow(matches[j] + 2);
    }

    return {
      bestScore: bestScore,
      attemptsToday: attemptsToday,
      status: status,
      updated: isNewBest,
      mergedDuplicates: Math.max(0, matches.length - 1)
    };
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}


const STUDENT_SHEET_PREFIX = "학생_";

function sanitizeStudentSheetBase_(studentName) {
  let name = String(studentName || "학생").trim() || "학생";
  name = name.replace(/[\\\/\?\*\[\]\:]/g, "_");
  let base = STUDENT_SHEET_PREFIX + name;
  if (base.length > 90) base = base.slice(0, 90);
  return base;
}

function getStudentResultSheet_(ss, studentName, phone) {
  const headers = [
    "date", "phone", "name", "book", "lesson", "testType",
    "bestScore", "attemptsToday", "status", "lastAt"
  ];

  const normalizedPhone = normalizePhone_(phone);
  const base = sanitizeStudentSheetBase_(studentName);
  let sheetName = base;
  let sh = ss.getSheetByName(sheetName);

  // 같은 이름의 다른 학생 시트가 이미 있으면 전화번호 끝 4자리로 구분한다.
  if (sh && sh.getLastRow() >= 2) {
    const savedPhone = normalizePhone_(sh.getRange(2, 2).getValue());
    if (savedPhone && normalizedPhone && savedPhone !== normalizedPhone) {
      const suffix = normalizedPhone ? "_" + normalizedPhone.slice(-4) : "_2";
      sheetName = (base + suffix).slice(0, 100);
      sh = ss.getSheetByName(sheetName);
    }
  }

  if (!sh) sh = ss.insertSheet(sheetName);

  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    sh.autoResizeColumns(1, headers.length);
  }

  return sh;
}

function updateStudentResultSheet_(ss, p, verifiedIdentity, ts, testResult) {
  if (!testResult || testResult.ok === false) return null;

  const bestScore = Number(testResult.bestScore);
  if (!Number.isFinite(bestScore)) return null;

  const phone = normalizePhone_((verifiedIdentity && verifiedIdentity.phone) || "");
  if (!phone) return null;

  const studentName = String(
    (verifiedIdentity && verifiedIdentity.studentName) || p.name || "학생"
  ).trim() || "학생";

  const dateKey = testResultDateKey_(ss, ts);
  const book = String(p.book || "").trim();
  const lesson = String(p.lesson || "").trim();
  const testType = normalizeTestType_(p.testType);
  const attemptsToday = Number(testResult.attemptsToday) || 1;
  const status = String(testResult.status || (bestScore >= TEST_PASS_SCORE ? "PASS" : "RETRY"));

  const sh = getStudentResultSheet_(ss, studentName, phone);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const lastRow = sh.getLastRow();
    const rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, 10).getValues() : [];
    const shownRows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, 10).getDisplayValues() : [];
    const wantedKey = [
      dateKey,
      normalizeTestBook_(book),
      normalizeTestLesson_(lesson),
      testType
    ].join("|");

    let targetRow = -1;
    for (let i = 0; i < rows.length; i++) {
      const rowKey = [
        normalizeTestDateKey_(ss, rows[i][0], shownRows[i][0]),
        normalizeTestBook_(rows[i][3]),
        normalizeTestLesson_(rows[i][4]),
        normalizeTestType_(rows[i][5])
      ].join("|");
      if (rowKey === wantedKey) {
        targetRow = i + 2;
        break;
      }
    }

    const rowValues = [[
      dateKey,
      phone,
      studentName,
      book,
      lesson,
      testType,
      bestScore,
      attemptsToday,
      status,
      ts
    ]];

    if (targetRow === -1) {
      sh.getRange(sh.getLastRow() + 1, 1, 1, 10).setValues(rowValues);
      targetRow = sh.getLastRow();
    } else {
      sh.getRange(targetRow, 1, 1, 10).setValues(rowValues);
    }

    return {
      sheetName: sh.getName(),
      row: targetRow,
      bestScore: bestScore,
      attemptsToday: attemptsToday,
      status: status
    };
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}


function getTestStatus_(ss, phone, book, lesson, testType, now) {
  const sh = ss.getSheetByName(TEST_RESULTS_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) {
    return { found: false, bestScore: 0, attemptsToday: 0, status: "NONE" };
  }

  const dateKey = testResultDateKey_(ss, now || new Date());
  const wantedKey = makeTestResultKey_(dateKey, phone, book, lesson, testType);
  const lastRow = sh.getLastRow();
  const rows = sh.getRange(2, 1, lastRow - 1, 16).getValues();
  const shownRows = sh.getRange(2, 1, lastRow - 1, 16).getDisplayValues();

  for (let i = 0; i < rows.length; i++) {
    const rowDate = normalizeTestDateKey_(ss, rows[i][0], shownRows[i][0]);
    const rowKey = makeTestResultKey_(
      rowDate,
      rows[i][1],
      rows[i][4],
      rows[i][5],
      rows[i][6]
    );
    if (rowKey === wantedKey) {
      const bestScore = Number(rows[i][7]);
      const attemptsToday = Number(rows[i][8]);
      return {
        found: true,
        bestScore: Number.isFinite(bestScore) ? bestScore : 0,
        attemptsToday: Number.isFinite(attemptsToday) ? attemptsToday : 0,
        status: String(rows[i][15] || ((Number.isFinite(bestScore) && bestScore >= TEST_PASS_SCORE) ? "PASS" : "RETRY"))
      };
    }
  }

  return { found: false, bestScore: 0, attemptsToday: 0, status: "NONE" };
}

function getTestMasteryStatus_(ss, phone, book, lesson, testType) {
  const sh = ss.getSheetByName(TEST_RESULTS_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) {
    return { found: false, bestScore: 0, attemptsTotal: 0, status: "NONE" };
  }

  const targetPhone = normalizePhone_(phone);
  const targetBook = normalizeTestBook_(book);
  const targetLesson = normalizeTestLesson_(lesson);
  const targetType = normalizeTestType_(testType);
  const lastRow = sh.getLastRow();
  const rows = sh.getRange(2, 1, lastRow - 1, 16).getValues();

  let found = false;
  let bestScore = 0;
  let attemptsTotal = 0;

  for (let i = 0; i < rows.length; i++) {
    if (normalizePhone_(rows[i][1]) !== targetPhone) continue;
    if (normalizeTestBook_(rows[i][4]) !== targetBook) continue;
    if (normalizeTestLesson_(rows[i][5]) !== targetLesson) continue;
    if (normalizeTestType_(rows[i][6]) !== targetType) continue;

    found = true;
    const rowScore = Number(rows[i][7]);
    const rowAttempts = Number(rows[i][8]);
    if (Number.isFinite(rowScore) && rowScore > bestScore) bestScore = rowScore;
    if (Number.isFinite(rowAttempts) && rowAttempts > 0) attemptsTotal += rowAttempts;
  }

  return {
    found: found,
    bestScore: found ? bestScore : 0,
    attemptsTotal: attemptsTotal,
    status: found ? (bestScore >= TEST_PASS_SCORE ? "PASS" : "RETRY") : "NONE"
  };
}


const LEARNING_START_SHEET_NAME = "학습시작점";
const LEARNING_START_HEADERS = [
  "phone", "name", "book", "startLesson", "enabled", "note", "updatedAt", "developerAccess"
];

function getLearningStartSheet_(ss) {
  const sh = ss.getSheetByName(LEARNING_START_SHEET_NAME) || ss.insertSheet(LEARNING_START_SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.appendRow(LEARNING_START_HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, LEARNING_START_HEADERS.length).setFontWeight("bold");
    sh.autoResizeColumns(1, LEARNING_START_HEADERS.length);
    return sh;
  }

  // 기존 7열 시트를 안전하게 확장한다. 기존 데이터는 이동하지 않고 H열만 추가한다.
  const currentH = String(sh.getRange(1, 8).getValue() == null ? "" : sh.getRange(1, 8).getValue()).trim();
  if (!currentH) {
    sh.getRange(1, 8).setValue("developerAccess").setFontWeight("bold");
  }
  sh.setFrozenRows(1);
  return sh;
}

// 개발자 전체 접근 권한은 코드에 하드코딩하지 않고 '학습시작점' 시트 H열에서 관리한다.
// 같은 전화번호가 여러 줄이면 아래쪽의 마지막 비어 있지 않은 developerAccess 값이 우선한다.
function getDeveloperAccess_(ss, phone) {
  const sh = getLearningStartSheet_(ss);
  const targetPhone = normalizePhone_(phone);
  if (!targetPhone || sh.getLastRow() < 2) return false;

  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues();
  let decided = null;

  for (let i = 0; i < rows.length; i++) {
    const rowPhone = normalizePhone_(rows[i][0]);
    if (rowPhone !== targetPhone) continue;

    const raw = rows[i][7];
    if (raw === "" || raw == null) continue;
    decided = isEnabled_(raw);
  }

  return decided === true;
}

function getLearningStartPoint_(ss, phone, book) {
  const sh = getLearningStartSheet_(ss);
  if (sh.getLastRow() < 2) {
    return { found: false, startLesson: 0, enabled: false };
  }

  const targetPhone = normalizePhone_(phone);
  const targetBook = normalizeTestBook_(book);
  if (!targetPhone || !targetBook) {
    return { found: false, startLesson: 0, enabled: false };
  }

  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  let matched = null;

  // 동일 학생/교재가 여러 줄이면 가장 아래의 활성 행을 우선한다.
  for (let i = 0; i < rows.length; i++) {
    const rowPhone = normalizePhone_(rows[i][0]);
    const rowBook = normalizeTestBook_(rows[i][2]);
    const enabled = isEnabled_(rows[i][4]);
    const startLesson = Number(String(rows[i][3] == null ? "" : rows[i][3]).trim());

    if (rowPhone !== targetPhone || rowBook !== targetBook || !enabled) continue;
    if (!Number.isFinite(startLesson) || startLesson <= 0) continue;

    matched = {
      found: true,
      phone: rowPhone,
      name: String(rows[i][1] == null ? "" : rows[i][1]).trim(),
      book: String(rows[i][2] == null ? "" : rows[i][2]).trim(),
      startLesson: Math.floor(startLesson),
      enabled: true,
      note: String(rows[i][5] == null ? "" : rows[i][5]).trim(),
      updatedAt: rows[i][6] || "",
      row: i + 2
    };
  }

  return matched || { found: false, startLesson: 0, enabled: false };
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
  let verifiedIdentity = null;

  // 1) 등록 전화번호의 학생이름 조회
  if (action === "lookup") {
    const phone = normalizePhone_(p.phone || "");
    const auth = checkAuthorizedPhone_(ss, phone);
    if (!auth.ok) return jsonpOutput_(callback, auth);
    return jsonpOutput_(callback, {
      ok: true,
      phone: auth.phone,
      name: auth.studentName || ""
    });
  }

  // 2) 전화번호 인증 + 서버 토큰 발급
  if (action === "auth") {
    const phone = normalizePhone_(p.phone || "");
    const name = String(p.name || "").trim();
    const deviceId = String(p.deviceId || "").trim();

    if (!name) return jsonpOutput_(callback, { ok: false, error: "missing_name" });

    const auth = checkAuthorizedPhone_(ss, phone);
    if (!auth.ok) return jsonpOutput_(callback, auth);

    const token = issueAuthToken_(phone, name, deviceId);
    return jsonpOutput_(callback, {
      ok: true,
      token: token,
      registeredName: auth.studentName || ""
    });
  }

  // 3) 페이지 진입 시 토큰 검증
  if (action === "validate") {
    const result = validateAuthToken_(ss, p.token, p.deviceId, p.name);
    if (!result.ok) return jsonpOutput_(callback, result);
    return jsonpOutput_(callback, { ok: true });
  }

  // 4) 오늘의 시험 최고점수/통과 상태 조회 (기록을 남기지 않는 읽기 전용 요청)
  if (action === "test_status") {
    const result = validateAuthToken_(ss, p.token, p.deviceId, p.name);
    if (!result.ok) return jsonpOutput_(callback, result);

    const phone = result.phone || (result.payload && result.payload.phone) || "";
    const status = getTestStatus_(
      ss,
      phone,
      p.book || "",
      p.lesson || "",
      p.testType || "",
      new Date()
    );
    return jsonpOutput_(callback, {
      ok: true,
      phone: normalizePhone_(phone),
      book: String(p.book || ""),
      lesson: String(p.lesson || ""),
      testType: normalizeTestType_(p.testType),
      found: status.found,
      bestScore: status.bestScore,
      attemptsToday: status.attemptsToday,
      status: status.status,
      passScore: TEST_PASS_SCORE
    });
  }

  // 5) 누적 시험 최고점수/통과 상태 조회 (날짜가 바뀌어도 PASS 유지)
  if (action === "mastery_status") {
    const result = validateAuthToken_(ss, p.token, p.deviceId, p.name);
    if (!result.ok) return jsonpOutput_(callback, result);

    const phone = result.phone || (result.payload && result.payload.phone) || "";
    const status = getTestMasteryStatus_(
      ss,
      phone,
      p.book || "",
      p.lesson || "",
      p.testType || ""
    );
    return jsonpOutput_(callback, {
      ok: true,
      phone: normalizePhone_(phone),
      book: String(p.book || ""),
      lesson: String(p.lesson || ""),
      testType: normalizeTestType_(p.testType),
      scope: "all",
      found: status.found,
      bestScore: status.bestScore,
      attemptsTotal: status.attemptsTotal,
      status: status.status,
      passScore: TEST_PASS_SCORE
    });
  }


  // 6) 교사가 지정한 학생별/교재별 시작 과 조회
  if (action === "learning_start") {
    const result = validateAuthToken_(ss, p.token, p.deviceId, p.name);
    if (!result.ok) return jsonpOutput_(callback, result);

    const phone = result.phone || (result.payload && result.payload.phone) || "";
    const start = getLearningStartPoint_(ss, phone, p.book || "");
    const developer = getDeveloperAccess_(ss, phone);
    return jsonpOutput_(callback, {
      ok: true,
      phone: normalizePhone_(phone),
      name: result.studentName || (result.payload && result.payload.name) || "",
      book: String(p.book || ""),
      found: !!start.found,
      startLesson: start.found ? start.startLesson : 0,
      enabled: !!start.enabled,
      note: start.note || "",
      source: start.found ? "teacher_override" : "none",
      isDeveloper: developer,
      developerAccess: developer,
      role: developer ? "developer" : "student"
    });
  }

  // 7) 인증이 필요한 기록 요청 보호
  if (action === "log" || action === "session_start") {
    const result = validateAuthToken_(ss, p.token, p.deviceId, p.name);
    if (!result.ok) return jsonpOutput_(callback, result);
    verifiedIdentity = {
      phone: result.phone || (result.payload && result.payload.phone) || "",
      studentName: result.studentName || (result.payload && result.payload.name) || ""
    };
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

  let testResult = null;
  let studentResult = null;
  if (action === "log" && p.testType) {
    try {
      testResult = updateTestResultBest_(ss, p, verifiedIdentity, ts);
    } catch (err) {
      console.error("TestResults update failed", err);
      testResult = { ok: false, error: "test_results_update_failed" };
    }

    if (testResult && testResult.ok !== false) {
      try {
        studentResult = updateStudentResultSheet_(ss, p, verifiedIdentity, ts, testResult);
      } catch (err) {
        console.error("Student sheet update failed", err);
        studentResult = { ok: false, error: "student_sheet_update_failed" };
      }
    }
  }

  return jsonpOutput_(callback, {
    ok: true,
    ts: ts.toISOString(),
    testResult: testResult,
    studentResult: studentResult
  });
}
