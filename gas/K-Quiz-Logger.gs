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

const SNU_CURRICULUM_BOOKS = [
  "SNU-1A", "SNU-1B", "SNU-2A", "SNU-2B",
  "SNU-3A", "SNU-3B", "SNU-4A", "SNU-4B"
];

function getSnuBookRank_(book) {
  const normalized = normalizeTestBook_(book);
  return SNU_CURRICULUM_BOOKS.indexOf(normalized);
}

// 학생의 전체 서울대 과정 기준 시작점을 찾는다.
// 학습시작점 시트에서 같은 학생의 활성 행이 여러 개라면 가장 아래 행을 우선한다.
function getLearningCurriculumStartPoint_(ss, phone) {
  const sh = getLearningStartSheet_(ss);
  if (sh.getLastRow() < 2) {
    return { found: false, startLesson: 0, enabled: false };
  }

  const targetPhone = normalizePhone_(phone);
  if (!targetPhone) {
    return { found: false, startLesson: 0, enabled: false };
  }

  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  let matched = null;

  for (let i = 0; i < rows.length; i++) {
    const rowPhone = normalizePhone_(rows[i][0]);
    const rowBook = normalizeTestBook_(rows[i][2]);
    const enabled = isEnabled_(rows[i][4]);
    const startLesson = Number(String(rows[i][3] == null ? "" : rows[i][3]).trim());

    if (rowPhone !== targetPhone || !enabled) continue;
    if (getSnuBookRank_(rowBook) < 0) continue;
    if (!Number.isFinite(startLesson) || startLesson <= 0) continue;

    matched = {
      found: true,
      phone: rowPhone,
      name: String(rows[i][1] == null ? "" : rows[i][1]).trim(),
      book: rowBook,
      startLesson: Math.floor(startLesson),
      enabled: true,
      note: String(rows[i][5] == null ? "" : rows[i][5]).trim(),
      updatedAt: rows[i][6] || "",
      row: i + 2
    };
  }

  return matched || { found: false, startLesson: 0, enabled: false };
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



// -----------------------------------------------------------------------------
// 학생 전체 진도 현황
// -----------------------------------------------------------------------------
const STUDENT_PROGRESS_SHEET_NAME = "진도현황";
const STUDENT_PROGRESS_HEADERS = [
  "순번", "전화번호", "학생이름", "사용여부", "반",
  "최초접속", "최근접속", "접속경과",
  "시작교재", "시작과",
  "현재교재", "현재과", "통과현황",
  "어휘최고", "문법최고", "종합최고",
  "현재상태", "다음단계",
  "TOPIK연어", "TOPIK문법",
  "최근활동", "최근시험", "최근점수", "총응시"
];

const SNU_BOOK_LESSON_RANGES = {
  "SNU-1A": [1, 8],
  "SNU-1B": [9, 16],
  "SNU-2A": [1, 9],
  "SNU-2B": [10, 18],
  "SNU-3A": [1, 9],
  "SNU-3B": [10, 18],
  "SNU-4A": [1, 9],
  "SNU-4B": [10, 18]
};

const STUDENT_PROGRESS_STYLE_VERSION = "2026-09-06-v6";

function studentProgressStyleKey_(ss) {
  return "student_progress_style_" + String(ss.getId() || "default");
}

// 기존 진도현황 형식을 최신 형식(A 순번 ... H 접속경과 ... M 통과현황 ...)으로 자동 변환한다.
function migrateStudentProgressSheetSchema_(sh) {
  if (!sh || sh.getLastRow() < 1) return;

  let h1 = String(sh.getRange(1, 1).getValue() || "").trim();
  let h2 = String(sh.getRange(1, 2).getValue() || "").trim();
  let h3 = String(sh.getRange(1, 3).getValue() || "").trim();

  // STEP23 format: A phone, B student name, C sequence -> move sequence to the first column.
  if (h1 === "전화번호" && h2 === "학생이름" && h3 === "순번") {
    const lastRow = sh.getLastRow();
    const oldWidth = 22;
    const rows = sh.getRange(1, 1, lastRow, oldWidth).getValues();
    const reordered = rows.map(function(row) {
      return [row[2], row[0], row[1]].concat(row.slice(3));
    });
    sh.getRange(1, 1, lastRow, oldWidth).setValues(reordered);
  } else if (h1 === "전화번호" && h2 === "학생이름" && h3 === "사용여부") {
    // STEP21/22 format: A phone, B student name, C enabled -> insert sequence at far left.
    sh.insertColumnBefore(1);
    sh.getRange(1, 1).setValue("순번");
  }

  // STEP26: 최근접속 바로 다음 H열에 '접속경과'를 추가한다.
  h1 = String(sh.getRange(1, 1).getValue() || "").trim();
  h2 = String(sh.getRange(1, 2).getValue() || "").trim();
  h3 = String(sh.getRange(1, 3).getValue() || "").trim();
  const h7 = String(sh.getRange(1, 7).getValue() || "").trim();
  const h8 = String(sh.getRange(1, 8).getValue() || "").trim();
  if (h1 === "순번" && h2 === "전화번호" && h3 === "학생이름" && h7 === "최근접속" && h8 !== "접속경과") {
    sh.insertColumnAfter(7);
    sh.getRange(1, 8).setValue("접속경과");
  }

  // STEP25 이전 형식에는 통과현황이 없었다. STEP26에서는 M열에 위치한다.
  const h13 = String(sh.getRange(1, 13).getValue() || "").trim();
  if (h1 === "순번" && h2 === "전화번호" && h3 === "학생이름" && h13 !== "통과현황") {
    sh.insertColumnBefore(13);
    sh.getRange(1, 13).setValue("통과현황");
  }
}
function formatStudentProgressSheet_(sh) {
  if (!sh) return null;

  migrateStudentProgressSheetSchema_(sh);

  const headerCount = STUDENT_PROGRESS_HEADERS.length;
  const maxRows = Math.max(sh.getMaxRows(), 2);
  const header = sh.getRange(1, 1, 1, headerCount);

  // 1행 고정 + 제목 행 가독성
  sh.setFrozenRows(1);
  header
    .setValues([STUDENT_PROGRESS_HEADERS])
    .setFontWeight("bold")
    .setFontColor("#ffffff")
    .setBackground("#1f4e78")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setWrap(true);
  sh.setRowHeight(1, 34);

  // 기본 정렬/표시 형식
  sh.getRange(1, 1, maxRows, headerCount).setVerticalAlignment("middle");
  sh.getRange("A:A").setNumberFormat("0");
  sh.getRange("B:B").setNumberFormat("@");
  sh.getRange("F:G").setNumberFormat("yyyy-MM-dd HH:mm");
  sh.getRange("U:U").setNumberFormat("yyyy-MM-dd HH:mm");
  sh.getRange("N:P").setNumberFormat("0");
  sh.getRange("W:W").setNumberFormat("0");
  sh.getRange("X:X").setNumberFormat("0");
  sh.getRange("R:R").setWrap(true);

  // 교사가 보기 편하도록 주요 열 너비를 고정한다.
  const widths = [
    55,  // A 순번
    100, // B 전화번호
    120, // C 학생이름
    75,  // D 사용여부
    70,  // E 반
    135, // F 최초접속
    135, // G 최근접속
    85,  // H 접속경과
    90,  // I 시작교재
    60,  // J 시작과
    90,  // K 현재교재
    60,  // L 현재과
    75,  // M 통과현황
    75,  // N 어휘최고
    75,  // O 문법최고
    75,  // P 종합최고
    90,  // Q 현재상태
    260, // R 다음단계
    90,  // S TOPIK연어
    90,  // T TOPIK문법
    135, // U 최근활동
    90,  // V 최근시험
    75,  // W 최근점수
    70   // X 총응시
  ];
  for (let c = 0; c < widths.length; c++) {
    sh.setColumnWidth(c + 1, widths[c]);
  }

  // 숫자/상태 열은 가운데 정렬한다.
  sh.getRange(2, 1, Math.max(maxRows - 1, 1), 1).setHorizontalAlignment("center"); // A 순번
  sh.getRange(2, 4, Math.max(maxRows - 1, 1), 2).setHorizontalAlignment("center"); // D:E
  sh.getRange(2, 8, Math.max(maxRows - 1, 1), 10).setHorizontalAlignment("center"); // H:Q
  sh.getRange(2, 19, Math.max(maxRows - 1, 1), 2).setHorizontalAlignment("center"); // S:T
  sh.getRange(2, 22, Math.max(maxRows - 1, 1), 3).setHorizontalAlignment("center"); // V:X

  // 필터는 빈 행을 포함한 시트 전체 범위에 걸어 새 학생도 자동 포함되게 한다.
  const existingFilter = sh.getFilter();
  if (existingFilter) existingFilter.remove();
  sh.getRange(1, 1, maxRows, headerCount).createFilter();

  // 상태와 점수, 현재 과 통과현황은 조건부 서식으로 빠르게 확인할 수 있게 한다.
  const elapsedRange = sh.getRange(2, 8, Math.max(maxRows - 1, 1), 1); // H 접속경과
  const passRange = sh.getRange(2, 13, Math.max(maxRows - 1, 1), 1); // M 통과현황
  const statusRange = sh.getRange(2, 17, Math.max(maxRows - 1, 1), 1); // Q 현재상태
  const scoreRange = sh.getRange(2, 14, Math.max(maxRows - 1, 1), 3); // N:P
  const recentScoreRange = sh.getRange(2, 23, Math.max(maxRows - 1, 1), 1); // W

  const rules = [
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("오늘")
      .setBackground("#d9ead3")
      .setFontColor("#274e13")
      .setRanges([elapsedRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($G2<>"",TODAY()-INT($G2)>=1,TODAY()-INT($G2)<3)')
      .setBackground("#d9eaf7")
      .setFontColor("#134f5c")
      .setRanges([elapsedRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($G2<>"",TODAY()-INT($G2)>=3,TODAY()-INT($G2)<7)')
      .setBackground("#fff2cc")
      .setFontColor("#7f6000")
      .setRanges([elapsedRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($G2<>"",TODAY()-INT($G2)>=7)')
      .setBackground("#f4cccc")
      .setFontColor("#990000")
      .setRanges([elapsedRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("3/3")
      .setBackground("#d9ead3")
      .setFontColor("#274e13")
      .setRanges([passRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("2/3")
      .setBackground("#d9eaf7")
      .setFontColor("#134f5c")
      .setRanges([passRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("1/3")
      .setBackground("#fff2cc")
      .setFontColor("#7f6000")
      .setRanges([passRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("0/3")
      .setBackground("#eeeeee")
      .setFontColor("#666666")
      .setRanges([passRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("서울대 완료")
      .setBackground("#d9ead3")
      .setFontColor("#274e13")
      .setRanges([statusRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("진행 중")
      .setBackground("#fff2cc")
      .setFontColor("#7f6000")
      .setRanges([statusRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo("시작 전")
      .setBackground("#eeeeee")
      .setFontColor("#666666")
      .setRanges([statusRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied("=AND(ISNUMBER(N2),N2>=0,N2<90)")
      .setBackground("#f4cccc")
      .setFontColor("#990000")
      .setRanges([scoreRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied("=AND(ISNUMBER(N2),N2>=90)")
      .setBackground("#d9ead3")
      .setFontColor("#274e13")
      .setRanges([scoreRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied("=AND(ISNUMBER(W2),W2>=0,W2<90)")
      .setBackground("#f4cccc")
      .setFontColor("#990000")
      .setRanges([recentScoreRange])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied("=AND(ISNUMBER(W2),W2>=90)")
      .setBackground("#d9ead3")
      .setFontColor("#274e13")
      .setRanges([recentScoreRange])
      .build()
  ];
  sh.setConditionalFormatRules(rules);

  return sh;
}

function ensureStudentProgressStyle_(ss, sh) {
  const props = PropertiesService.getScriptProperties();
  const key = studentProgressStyleKey_(ss);
  if (props.getProperty(key) !== STUDENT_PROGRESS_STYLE_VERSION) {
    formatStudentProgressSheet_(sh);
    props.setProperty(key, STUDENT_PROGRESS_STYLE_VERSION);
  }
}

// 최근접속(G열)을 기준으로 H열에 경과일을 자동 계산한다. TODAY()를 사용하므로 날짜가 바뀌면 표시도 자동 갱신된다.
function refreshStudentProgressElapsed_(sh) {
  if (!sh) return;
  const dataCount = Math.max(sh.getLastRow() - 1, 0);
  if (dataCount <= 0) return;

  const formulas = [];
  for (let i = 0; i < dataCount; i++) {
    const row = i + 2;
    formulas.push([
      '=IF(G' + row + '="","-",IF(TODAY()<=INT(G' + row + '),"오늘",(TODAY()-INT(G' + row + '))&"일 전"))'
    ]);
  }
  sh.getRange(2, 8, dataCount, 1).setFormulas(formulas);
}

// 최근접속(G열)이 가장 최근인 학생을 위로 올리고, 현재 표시 순서대로 순번(A열)을 다시 매긴다.
function sortStudentProgressRows_(sh) {
  if (!sh) return;

  const dataCount = Math.max(sh.getLastRow() - 1, 0);
  if (dataCount <= 0) return;

  if (dataCount > 1) {
    sh.getRange(2, 1, dataCount, STUDENT_PROGRESS_HEADERS.length)
      .sort([
        { column: 7, ascending: false }, // G 최근접속: 최근 학생 우선
        { column: 3, ascending: true }   // 동률이면 학생이름
      ]);
  }

  const seq = [];
  for (let i = 0; i < dataCount; i++) seq.push([i + 1]);
  sh.getRange(2, 1, dataCount, 1).setValues(seq);
  refreshStudentProgressElapsed_(sh);
}

// Apps Script 편집기에서 직접 실행해 기존 진도현황 시트의 서식/최근접속순 정렬을 다시 적용할 수 있다.
function formatStudentProgressSheet() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(STUDENT_PROGRESS_SHEET_NAME) || ss.insertSheet(STUDENT_PROGRESS_SHEET_NAME);
  formatStudentProgressSheet_(sh);
  PropertiesService.getScriptProperties().setProperty(
    studentProgressStyleKey_(ss),
    STUDENT_PROGRESS_STYLE_VERSION
  );
  sortStudentProgressRows_(sh);
  return { ok: true, sheetName: STUDENT_PROGRESS_SHEET_NAME, count: Math.max(sh.getLastRow() - 1, 0) };
}

function getStudentProgressSheet_(ss) {
  const sh = ss.getSheetByName(STUDENT_PROGRESS_SHEET_NAME) || ss.insertSheet(STUDENT_PROGRESS_SHEET_NAME);

  // 기존 시트가 있으면 순번/접속경과/통과현황 열을 최신 구조로 자동 맞춘다.
  migrateStudentProgressSheetSchema_(sh);

  const needsHeader = sh.getLastRow() === 0 || !String(sh.getRange(1, 1).getValue() || "").trim();
  if (needsHeader) {
    sh.getRange(1, 1, 1, STUDENT_PROGRESS_HEADERS.length).setValues([STUDENT_PROGRESS_HEADERS]);
  }

  ensureStudentProgressStyle_(ss, sh);
  return sh;
}

function getAuthStudentInfo_(ss, phone) {
  const sh = ss.getSheetByName(AUTH_SHEET_NAME);
  const target = normalizePhone_(phone);
  if (!sh || !target || sh.getLastRow() < 2) {
    return { found: false, phone: target, name: "", enabled: false };
  }

  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  let matched = null;
  for (let i = 0; i < rows.length; i++) {
    if (normalizePhone_(rows[i][0]) !== target) continue;
    matched = {
      found: true,
      phone: target,
      name: String(rows[i][1] == null ? "" : rows[i][1]).trim(),
      enabled: isEnabled_(rows[i][2])
    };
  }
  return matched || { found: false, phone: target, name: "", enabled: false };
}

function progressTestKey_(book, lesson, testType) {
  return [
    normalizeTestBook_(book),
    normalizeTestLesson_(lesson),
    normalizeTestType_(testType)
  ].join("|");
}

function dateOrNull_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  if (value == null || value === "") return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function laterDate_(a, b) {
  const da = dateOrNull_(a);
  const db = dateOrNull_(b);
  if (!da) return db;
  if (!db) return da;
  return da.getTime() >= db.getTime() ? da : db;
}

function earlierDate_(a, b) {
  const da = dateOrNull_(a);
  const db = dateOrNull_(b);
  if (!da) return db;
  if (!db) return da;
  return da.getTime() <= db.getTime() ? da : db;
}

function buildStudentTestStats_(ss, phone) {
  const stats = {
    scores: {},
    totalAttempts: 0,
    firstTestAt: null,
    lastTestAt: null,
    lastTestType: "",
    lastTestScore: ""
  };

  const sh = ss.getSheetByName(TEST_RESULTS_SHEET_NAME);
  const targetPhone = normalizePhone_(phone);
  if (!sh || !targetPhone || sh.getLastRow() < 2) return stats;

  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 16).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (normalizePhone_(rows[i][1]) !== targetPhone) continue;

    const key = progressTestKey_(rows[i][4], rows[i][5], rows[i][6]);
    const score = Number(rows[i][7]);
    if (Number.isFinite(score)) {
      const prev = Number(stats.scores[key]);
      if (!Number.isFinite(prev) || score > prev) stats.scores[key] = score;
    }

    const attempts = Number(rows[i][8]);
    if (Number.isFinite(attempts) && attempts > 0) stats.totalAttempts += attempts;

    const firstAt = dateOrNull_(rows[i][12]);
    const lastAt = dateOrNull_(rows[i][14]) || dateOrNull_(rows[i][13]) || firstAt;
    if (firstAt) stats.firstTestAt = earlierDate_(stats.firstTestAt, firstAt);

    if (lastAt) {
      const wasLast = stats.lastTestAt;
      stats.lastTestAt = laterDate_(stats.lastTestAt, lastAt);
      if (!wasLast || (stats.lastTestAt && lastAt.getTime() >= stats.lastTestAt.getTime())) {
        stats.lastTestType = normalizeTestType_(rows[i][6]);
        stats.lastTestScore = Number.isFinite(score) ? score : "";
      }
    }
  }

  return stats;
}

function hasProgressScore_(stats, book, lesson, testType) {
  const key = progressTestKey_(book, lesson, testType);
  return !!(
    stats &&
    stats.scores &&
    Object.prototype.hasOwnProperty.call(stats.scores, key)
  );
}

function getProgressScore_(stats, book, lesson, testType) {
  const value = Number(stats && stats.scores ? stats.scores[progressTestKey_(book, lesson, testType)] : 0);
  return Number.isFinite(value) ? value : 0;
}

// 진도현황 표시용: 미응시는 '-'로, 실제 응시 점수 0은 숫자 0으로 구분한다.
function getProgressDisplayScore_(stats, book, lesson, testType) {
  return hasProgressScore_(stats, book, lesson, testType)
    ? getProgressScore_(stats, book, lesson, testType)
    : "-";
}

function getSnuLessonRange_(book) {
  return SNU_BOOK_LESSON_RANGES[normalizeTestBook_(book)] || null;
}

function normalizeSnuStartPosition_(book, lesson) {
  let normalizedBook = normalizeTestBook_(book);
  if (getSnuBookRank_(normalizedBook) < 0) normalizedBook = "SNU-1A";

  const range = getSnuLessonRange_(normalizedBook) || [1, 1];
  let n = Number(lesson);
  if (!Number.isFinite(n)) n = range[0];
  n = Math.floor(n);
  if (n < range[0] || n > range[1]) n = range[0];

  return { book: normalizedBook, lesson: n };
}

function getNextSnuPosition_(book, lesson) {
  const normalizedBook = normalizeTestBook_(book);
  const rank = getSnuBookRank_(normalizedBook);
  const range = getSnuLessonRange_(normalizedBook);
  if (rank < 0 || !range) return null;

  const n = Number(lesson);
  if (n < range[1]) return { book: normalizedBook, lesson: n + 1 };

  if (rank + 1 >= SNU_CURRICULUM_BOOKS.length) return null;
  const nextBook = SNU_CURRICULUM_BOOKS[rank + 1];
  const nextRange = getSnuLessonRange_(nextBook);
  return { book: nextBook, lesson: nextRange ? nextRange[0] : 1 };
}

function computeSnuProgress_(ss, phone, stats) {
  const configured = getLearningCurriculumStartPoint_(ss, phone);
  const start = normalizeSnuStartPosition_(
    configured.found ? configured.book : "SNU-1A",
    configured.found ? configured.startLesson : 1
  );

  let pos = { book: start.book, lesson: start.lesson };
  for (let guard = 0; guard < 200 && pos; guard++) {
    const vocabAttempted = hasProgressScore_(stats, pos.book, pos.lesson, "vocab");
    const grammarAttempted = hasProgressScore_(stats, pos.book, pos.lesson, "grammar");
    const mixedAttempted = hasProgressScore_(stats, pos.book, pos.lesson, "mixed");

    const vocab = getProgressScore_(stats, pos.book, pos.lesson, "vocab");
    const grammar = getProgressScore_(stats, pos.book, pos.lesson, "grammar");
    const mixed = getProgressScore_(stats, pos.book, pos.lesson, "mixed");
    const allPass = vocab >= TEST_PASS_SCORE && grammar >= TEST_PASS_SCORE && mixed >= TEST_PASS_SCORE;

    if (!allPass) {
      const attempted = vocabAttempted || grammarAttempted || mixedAttempted;
      const passCount = [vocab, grammar, mixed].filter(function(score) {
        return score >= TEST_PASS_SCORE;
      }).length;
      const missing = [];
      if (vocab < TEST_PASS_SCORE) missing.push("어휘");
      if (grammar < TEST_PASS_SCORE) missing.push("문법");
      if (mixed < TEST_PASS_SCORE) missing.push("종합");

      return {
        startBook: start.book,
        startLesson: start.lesson,
        currentBook: pos.book,
        currentLesson: pos.lesson,
        passSummary: passCount + "/3",
        vocabBest: vocabAttempted ? vocab : "-",
        grammarBest: grammarAttempted ? grammar : "-",
        mixedBest: mixedAttempted ? mixed : "-",
        status: attempted ? "진행 중" : "시작 전",
        nextStep: pos.book.replace(/^SNU-/, "") + " " + pos.lesson + "과 " + missing.join("·") + " 90% 필요",
        completed: false
      };
    }

    pos = getNextSnuPosition_(pos.book, pos.lesson);
  }

  return {
    startBook: start.book,
    startLesson: start.lesson,
    currentBook: "완료",
    currentLesson: "",
    passSummary: "3/3",
    vocabBest: 100,
    grammarBest: 100,
    mixedBest: 100,
    status: "서울대 완료",
    nextStep: "서울대 4B까지 전체 완료",
    completed: true
  };
}

function computeTopikSequentialProgress_(stats, testType) {
  let anyAttempt = false;
  for (let stage = 1; stage <= 10; stage++) {
    const key = progressTestKey_("TOPIK1", stage, testType);
    if (Object.prototype.hasOwnProperty.call(stats.scores, key)) anyAttempt = true;
    const score = getProgressScore_(stats, "TOPIK1", stage, testType);
    if (score < TEST_PASS_SCORE) {
      if (!anyAttempt && stage === 1) return "미시작";
      return stage + "단계";
    }
  }
  return "완료";
}

function progressTestTypeLabel_(testType) {
  const t = normalizeTestType_(testType);
  if (t === "vocab") return "어휘";
  if (t === "grammar") return "문법";
  if (t === "mixed") return "종합";
  if (t === "collocation") return "연어";
  return t;
}

function findStudentProgressRow_(sh, phone) {
  const target = normalizePhone_(phone);
  if (!target || sh.getLastRow() < 2) return -1;
  const phones = sh.getRange(2, 2, sh.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < phones.length; i++) {
    if (normalizePhone_(phones[i][0]) === target) return i + 2;
  }
  return -1;
}

function updateStudentProgressSummary_(ss, identity, context) {
  context = context || {};
  const phone = normalizePhone_(identity && identity.phone);
  if (!phone) return null;

  const now = dateOrNull_(context.ts) || new Date();
  const authInfo = getAuthStudentInfo_(ss, phone);
  const name = String(
    (authInfo && authInfo.name) ||
    (identity && identity.studentName) ||
    (identity && identity.name) ||
    "학생"
  ).trim() || "학생";

  const stats = buildStudentTestStats_(ss, phone);
  const snu = computeSnuProgress_(ss, phone, stats);
  const topikCollocation = computeTopikSequentialProgress_(stats, "collocation");
  const topikGrammar = computeTopikSequentialProgress_(stats, "grammar");

  const sh = getStudentProgressSheet_(ss);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    let row = findStudentProgressRow_(sh, phone);
    let existing = row > 0 ? sh.getRange(row, 1, 1, STUDENT_PROGRESS_HEADERS.length).getValues()[0] : null;

    let firstLoginAt = existing ? dateOrNull_(existing[5]) : null;
    let lastLoginAt = existing ? dateOrNull_(existing[6]) : null;
    let klass = String(context.klass || (existing ? existing[4] : "") || "").trim();

    if (context.firstLoginAt) firstLoginAt = earlierDate_(firstLoginAt, context.firstLoginAt);
    if (context.lastLoginAt) lastLoginAt = laterDate_(lastLoginAt, context.lastLoginAt);

    if (context.isLogin) {
      firstLoginAt = firstLoginAt || now;
      lastLoginAt = laterDate_(lastLoginAt, now);
    } else if (!firstLoginAt) {
      firstLoginAt = dateOrNull_(stats.firstTestAt) || now;
    }

    let lastActivityAt = laterDate_(existing ? existing[20] : null, stats.lastTestAt);
    lastActivityAt = laterDate_(lastActivityAt, now);

    let lastTestType = String(existing ? existing[21] || "" : "");
    let lastScore = existing ? existing[22] : "";
    if (stats.lastTestType) {
      lastTestType = progressTestTypeLabel_(stats.lastTestType);
      lastScore = stats.lastTestScore;
    }
    if (context.lastTestType) lastTestType = progressTestTypeLabel_(context.lastTestType);
    if (context.lastScore !== undefined && context.lastScore !== null && String(context.lastScore) !== "") {
      const n = Number(context.lastScore);
      lastScore = Number.isFinite(n) ? n : context.lastScore;
    }
    if (!lastTestType && (lastScore === "" || lastScore === null || lastScore === undefined)) {
      lastScore = "-";
    }

    const values = [[
      "", // 순번은 최근접속 정렬 후 자동으로 다시 매긴다.
      phone,
      name,
      authInfo.found ? (authInfo.enabled ? "TRUE" : "FALSE") : "",
      klass,
      firstLoginAt || "",
      lastLoginAt || "",
      "", // H 접속경과는 최근접속 기준 수식으로 자동 계산한다.
      snu.startBook,
      snu.startLesson,
      snu.currentBook,
      snu.currentLesson,
      snu.passSummary,
      snu.vocabBest,
      snu.grammarBest,
      snu.mixedBest,
      snu.status,
      snu.nextStep,
      topikCollocation,
      topikGrammar,
      lastActivityAt || now,
      lastTestType,
      lastScore,
      stats.totalAttempts
    ]];

    if (row < 0) {
      row = sh.getLastRow() + 1;
      sh.getRange(row, 1, 1, STUDENT_PROGRESS_HEADERS.length).setValues(values);
    } else {
      sh.getRange(row, 1, 1, STUDENT_PROGRESS_HEADERS.length).setValues(values);
    }

    // 학생이 추가/갱신될 때마다 최근접속 기준 정렬과 순번을 유지한다.
    sortStudentProgressRows_(sh);
    row = findStudentProgressRow_(sh, phone);

    return {
      sheetName: sh.getName(),
      row: row,
      phone: phone,
      name: name,
      currentBook: snu.currentBook,
      currentLesson: snu.currentLesson,
      status: snu.status,
      nextStep: snu.nextStep
    };
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

// 기존 Sessions / TestResults를 이용해 진도현황을 한 번에 다시 만드는 관리용 함수.
// Apps Script 편집기에서 이 함수를 직접 실행하면 이미 접속했던 학생도 즉시 반영된다.
function rebuildStudentProgressSummary() {
  const ss = SpreadsheetApp.getActive();
  const progressSh = getStudentProgressSheet_(ss);
  if (progressSh.getLastRow() > 1) {
    progressSh.getRange(2, 1, progressSh.getLastRow() - 1, STUDENT_PROGRESS_HEADERS.length).clearContent();
  }

  const authSh = ss.getSheetByName(AUTH_SHEET_NAME);
  if (!authSh || authSh.getLastRow() < 2) return { ok: true, count: 0 };

  const authRows = authSh.getRange(2, 1, authSh.getLastRow() - 1, 3).getValues();
  const authByPhone = {};
  const phonesByName = {};
  for (let i = 0; i < authRows.length; i++) {
    const phone = normalizePhone_(authRows[i][0]);
    const name = String(authRows[i][1] == null ? "" : authRows[i][1]).trim();
    if (!phone) continue;
    authByPhone[phone] = { phone: phone, name: name, enabled: isEnabled_(authRows[i][2]) };
    if (name) {
      if (!phonesByName[name]) phonesByName[name] = [];
      if (phonesByName[name].indexOf(phone) < 0) phonesByName[name].push(phone);
    }
  }

  const visited = {};
  const sessions = ss.getSheetByName("Sessions");
  if (sessions && sessions.getLastRow() >= 2) {
    const rows = sessions.getRange(2, 1, sessions.getLastRow() - 1, 12).getValues();
    for (let i = 0; i < rows.length; i++) {
      const name = String(rows[i][1] == null ? "" : rows[i][1]).trim();
      const matches = phonesByName[name] || [];
      if (matches.length !== 1) continue;
      const phone = matches[0];
      const loginAt = dateOrNull_(rows[i][6]);
      if (!visited[phone]) visited[phone] = { firstLoginAt: null, lastLoginAt: null, klass: "" };
      if (loginAt) {
        visited[phone].firstLoginAt = earlierDate_(visited[phone].firstLoginAt, loginAt);
        visited[phone].lastLoginAt = laterDate_(visited[phone].lastLoginAt, loginAt);
      }
      const klass = String(rows[i][2] == null ? "" : rows[i][2]).trim();
      if (klass) visited[phone].klass = klass;
    }
  }

  const results = ss.getSheetByName(TEST_RESULTS_SHEET_NAME);
  if (results && results.getLastRow() >= 2) {
    const rows = results.getRange(2, 1, results.getLastRow() - 1, 16).getValues();
    for (let i = 0; i < rows.length; i++) {
      const phone = normalizePhone_(rows[i][1]);
      if (!phone || !authByPhone[phone]) continue;
      if (!visited[phone]) visited[phone] = { firstLoginAt: null, lastLoginAt: null, klass: "" };
      const firstAt = dateOrNull_(rows[i][12]);
      const lastAt = dateOrNull_(rows[i][14]) || dateOrNull_(rows[i][13]) || firstAt;
      if (!visited[phone].firstLoginAt && firstAt) visited[phone].firstLoginAt = firstAt;
      if (!visited[phone].lastLoginAt && lastAt) visited[phone].lastLoginAt = lastAt;
      const klass = String(rows[i][3] == null ? "" : rows[i][3]).trim();
      if (klass) visited[phone].klass = klass;
    }
  }

  let count = 0;
  for (let i = 0; i < authRows.length; i++) {
    const phone = normalizePhone_(authRows[i][0]);
    if (!phone || !visited[phone]) continue;
    const info = authByPhone[phone];
    const v = visited[phone];
    updateStudentProgressSummary_(
      ss,
      { phone: phone, studentName: info ? info.name : "" },
      {
        ts: v.lastLoginAt || v.firstLoginAt || new Date(),
        firstLoginAt: v.firstLoginAt,
        lastLoginAt: v.lastLoginAt,
        klass: v.klass,
        isLogin: !!v.lastLoginAt
      }
    );
    count++;
  }

  // 전체 재구성 후에도 서식, 최근접속 정렬, 순번, 접속경과를 한 번 더 확정한다.
  formatStudentProgressSheet_(progressSh);
  PropertiesService.getScriptProperties().setProperty(
    studentProgressStyleKey_(ss),
    STUDENT_PROGRESS_STYLE_VERSION
  );
  sortStudentProgressRows_(progressSh);

  return { ok: true, count: count, sheetName: STUDENT_PROGRESS_SHEET_NAME };
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
    let progressSummary = null;
    try {
      progressSummary = updateStudentProgressSummary_(
        ss,
        { phone: auth.phone || phone, studentName: auth.studentName || name },
        { ts: new Date(), klass: String(p.klass || ""), isLogin: true }
      );
    } catch (err) {
      console.error("Progress summary login update failed", err);
    }
    return jsonpOutput_(callback, {
      ok: true,
      token: token,
      registeredName: auth.studentName || "",
      progressSummary: progressSummary
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
    const requestedBook = normalizeTestBook_(p.book || "");
    const start = getLearningStartPoint_(ss, phone, requestedBook);
    const curriculumStart = getLearningCurriculumStartPoint_(ss, phone);
    const developer = getDeveloperAccess_(ss, phone);

    const requestedRank = getSnuBookRank_(requestedBook);
    const curriculumStartBook = curriculumStart.found ? normalizeTestBook_(curriculumStart.book) : "";
    const curriculumStartRank = getSnuBookRank_(curriculumStartBook);
    let bookRelation = "none";
    if (requestedRank >= 0 && curriculumStartRank >= 0) {
      if (requestedRank < curriculumStartRank) bookRelation = "lower";
      else if (requestedRank === curriculumStartRank) bookRelation = "same";
      else bookRelation = "higher";
    }

    return jsonpOutput_(callback, {
      ok: true,
      phone: normalizePhone_(phone),
      name: result.studentName || (result.payload && result.payload.name) || "",
      book: requestedBook,

      // 기존 교재별 조회 필드: 이전 클라이언트와의 호환을 유지한다.
      found: !!start.found,
      startLesson: start.found ? start.startLesson : 0,
      enabled: !!start.enabled,
      note: start.note || "",
      source: start.found ? "teacher_override" : "none",

      // 전체 서울대 과정 기준 시작점.
      curriculumFound: !!curriculumStart.found,
      curriculumStartBook: curriculumStartBook,
      curriculumStartLesson: curriculumStart.found ? curriculumStart.startLesson : 0,
      curriculumEnabled: !!curriculumStart.enabled,
      curriculumNote: curriculumStart.note || "",
      bookRelation: bookRelation,
      lowerBookAccess: bookRelation === "lower",
      sameStartBook: bookRelation === "same",
      higherBook: bookRelation === "higher",

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

  let progressSummary = null;
  if (action === "session_start" && verifiedIdentity) {
    try {
      progressSummary = updateStudentProgressSummary_(
        ss,
        verifiedIdentity,
        { ts: ts, klass: String(p.klass || ""), isLogin: true }
      );
    } catch (err) {
      console.error("Progress summary session update failed", err);
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

      try {
        progressSummary = updateStudentProgressSummary_(
          ss,
          verifiedIdentity,
          {
            ts: ts,
            klass: String(p.klass || ""),
            isLogin: false,
            lastTestType: p.testType || "",
            lastScore: p.score
          }
        );
      } catch (err) {
        console.error("Progress summary test update failed", err);
      }
    }
  }

  return jsonpOutput_(callback, {
    ok: true,
    ts: ts.toISOString(),
    testResult: testResult,
    studentResult: studentResult,
    progressSummary: progressSummary
  });
}
