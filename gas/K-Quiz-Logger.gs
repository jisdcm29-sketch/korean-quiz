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

// STEP29-4: 학생별 시험 통계를 Script Cache에 보관해 TestResults 전체 스캔을 반복하지 않는다.
// CacheService는 만료/축출될 수 있으므로 캐시가 없으면 기존 시트를 읽어 자동 복구한다.
const STUDENT_TEST_STATS_CACHE_VERSION = "2026-09-10-v1";
const STUDENT_TEST_STATS_CACHE_TTL_SEC = 60 * 60 * 6;
const TEST_RESULT_ROW_CACHE_TTL_SEC = 60 * 60 * 6;

// STEP29-5: 학생별 개별 결과 시트도 같은 시험 재응시 때 전체 행을 매번 찾지 않는다.
// 전화번호 -> 학생 시트명, 날짜/교재/과/유형 -> 정확한 행 번호를 캐시에 보관한다.
// 캐시는 성능 보조용이며 만료/축출/수동 시트 변경 시 기존 검색 방식으로 자동 복구한다.
const STUDENT_RESULT_SHEET_CACHE_VERSION = "2026-09-10-v1";
const STUDENT_RESULT_SHEET_CACHE_TTL_SEC = 60 * 60 * 6;
const STUDENT_RESULT_ROW_CACHE_TTL_SEC = 60 * 60 * 6;

function shortSpreadsheetCacheId_(ss) {
  const id = String((ss && ss.getId && ss.getId()) || "default");
  return id.slice(-16);
}

function studentTestStatsCacheKey_(ss, phone) {
  return [
    "s29_stats",
    STUDENT_TEST_STATS_CACHE_VERSION,
    shortSpreadsheetCacheId_(ss),
    normalizePhone_(phone)
  ].join("_");
}

function testResultRowCacheKey_(ss, dateKey, phone, book, lesson, testType) {
  return [
    "s29_row",
    shortSpreadsheetCacheId_(ss),
    String(dateKey || "").replace(/[^0-9]/g, ""),
    normalizePhone_(phone),
    normalizeTestBook_(book),
    normalizeTestLesson_(lesson),
    normalizeTestType_(testType)
  ].join("_");
}

function emptyStudentTestStats_() {
  return {
    scores: {},
    attemptsByKey: {},
    totalAttempts: 0,
    firstTestAt: null,
    lastTestAt: null,
    lastTestType: "",
    lastTestScore: ""
  };
}

function serializeStudentTestStats_(stats) {
  stats = stats || emptyStudentTestStats_();
  return JSON.stringify({
    scores: stats.scores || {},
    attemptsByKey: stats.attemptsByKey || {},
    totalAttempts: Number(stats.totalAttempts) || 0,
    firstTestAt: dateOrNull_(stats.firstTestAt) ? dateOrNull_(stats.firstTestAt).getTime() : null,
    lastTestAt: dateOrNull_(stats.lastTestAt) ? dateOrNull_(stats.lastTestAt).getTime() : null,
    lastTestType: String(stats.lastTestType || ""),
    lastTestScore: stats.lastTestScore === "" || stats.lastTestScore == null ? "" : Number(stats.lastTestScore)
  });
}

function deserializeStudentTestStats_(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const stats = emptyStudentTestStats_();
    stats.scores = parsed && parsed.scores && typeof parsed.scores === "object" ? parsed.scores : {};
    stats.attemptsByKey = parsed && parsed.attemptsByKey && typeof parsed.attemptsByKey === "object" ? parsed.attemptsByKey : {};
    stats.totalAttempts = Number(parsed && parsed.totalAttempts) || 0;
    stats.firstTestAt = parsed && parsed.firstTestAt ? new Date(Number(parsed.firstTestAt)) : null;
    stats.lastTestAt = parsed && parsed.lastTestAt ? new Date(Number(parsed.lastTestAt)) : null;
    stats.lastTestType = String((parsed && parsed.lastTestType) || "");
    const lastScore = parsed ? parsed.lastTestScore : "";
    stats.lastTestScore = lastScore === "" || lastScore == null ? "" : Number(lastScore);
    return stats;
  } catch (err) {
    return null;
  }
}

function getCachedStudentTestStats_(ss, phone) {
  const targetPhone = normalizePhone_(phone);
  if (!targetPhone) return null;
  try {
    return deserializeStudentTestStats_(
      CacheService.getScriptCache().get(studentTestStatsCacheKey_(ss, targetPhone))
    );
  } catch (err) {
    return null;
  }
}

function putCachedStudentTestStats_(ss, phone, stats) {
  const targetPhone = normalizePhone_(phone);
  if (!targetPhone || !stats) return;
  try {
    CacheService.getScriptCache().put(
      studentTestStatsCacheKey_(ss, targetPhone),
      serializeStudentTestStats_(stats),
      STUDENT_TEST_STATS_CACHE_TTL_SEC
    );
  } catch (err) {
    // 캐시는 성능 보조 기능이므로 실패해도 기존 시트 기반 동작은 계속한다.
  }
}

function cacheTestResultRow_(ss, dateKey, phone, book, lesson, testType, sheetRow) {
  const row = Number(sheetRow);
  if (!Number.isFinite(row) || row < 2) return;
  try {
    CacheService.getScriptCache().put(
      testResultRowCacheKey_(ss, dateKey, phone, book, lesson, testType),
      String(Math.floor(row)),
      TEST_RESULT_ROW_CACHE_TTL_SEC
    );
  } catch (err) {}
}

function getCachedTestResultRow_(ss, dateKey, phone, book, lesson, testType) {
  try {
    const raw = CacheService.getScriptCache().get(
      testResultRowCacheKey_(ss, dateKey, phone, book, lesson, testType)
    );
    const row = Number(raw);
    return Number.isFinite(row) && row >= 2 ? Math.floor(row) : -1;
  } catch (err) {
    return -1;
  }
}

function studentResultSheetCacheKey_(ss, phone) {
  return [
    "s29_student_sheet",
    STUDENT_RESULT_SHEET_CACHE_VERSION,
    shortSpreadsheetCacheId_(ss),
    normalizePhone_(phone)
  ].join("_");
}

function studentResultRowCacheKey_(ss, phone, dateKey, book, lesson, testType) {
  return [
    "s29_student_row",
    shortSpreadsheetCacheId_(ss),
    normalizePhone_(phone),
    String(dateKey || "").replace(/[^0-9]/g, ""),
    normalizeTestBook_(book),
    normalizeTestLesson_(lesson),
    normalizeTestType_(testType)
  ].join("_");
}

function cacheStudentResultSheetName_(ss, phone, sheetName) {
  const targetPhone = normalizePhone_(phone);
  const name = String(sheetName || "").trim();
  if (!targetPhone || !name) return;
  try {
    CacheService.getScriptCache().put(
      studentResultSheetCacheKey_(ss, targetPhone),
      name,
      STUDENT_RESULT_SHEET_CACHE_TTL_SEC
    );
  } catch (err) {}
}

function getCachedStudentResultSheet_(ss, phone) {
  const targetPhone = normalizePhone_(phone);
  if (!targetPhone) return null;
  try {
    const name = CacheService.getScriptCache().get(studentResultSheetCacheKey_(ss, targetPhone));
    if (!name) return null;
    return ss.getSheetByName(name) || null;
  } catch (err) {
    return null;
  }
}

function cacheStudentResultRow_(ss, phone, dateKey, book, lesson, testType, sheetRow) {
  const row = Number(sheetRow);
  if (!Number.isFinite(row) || row < 2) return;
  try {
    CacheService.getScriptCache().put(
      studentResultRowCacheKey_(ss, phone, dateKey, book, lesson, testType),
      String(Math.floor(row)),
      STUDENT_RESULT_ROW_CACHE_TTL_SEC
    );
  } catch (err) {}
}

function getCachedStudentResultRow_(ss, phone, dateKey, book, lesson, testType) {
  try {
    const raw = CacheService.getScriptCache().get(
      studentResultRowCacheKey_(ss, phone, dateKey, book, lesson, testType)
    );
    const row = Number(raw);
    return Number.isFinite(row) && row >= 2 ? Math.floor(row) : -1;
  } catch (err) {
    return -1;
  }
}

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
    let lastRow = sh.getLastRow();
    let matches = [];
    let allRows = null;
    let shownRows = null;

    // 같은 학생이 같은 시험을 다시 보는 경우가 많으므로, 먼저 캐시된 정확한 행 하나만 읽는다.
    // 캐시가 맞으면 TestResults 전체를 전혀 읽지 않는다.
    const cachedRow = getCachedTestResultRow_(ss, dateKey, phone, book, lesson, testType);
    if (cachedRow >= 2 && cachedRow <= lastRow) {
      const cachedValues = sh.getRange(cachedRow, 1, 1, 16).getValues()[0];
      const cachedKey = makeTestResultKey_(
        normalizeTestDateKey_(ss, cachedValues[0], ""),
        cachedValues[1],
        cachedValues[4],
        cachedValues[5],
        cachedValues[6]
      );
      if (cachedKey === wantedKey) {
        matches.push({ sheetRow: cachedRow, row: cachedValues });
      }
    }

    // 첫 응시/캐시 만료/행 이동 시에만 기존 방식으로 전체를 한 번 읽어 정확한 행을 찾는다.
    if (matches.length === 0 && lastRow > 1) {
      allRows = sh.getRange(2, 1, lastRow - 1, 16).getValues();
      shownRows = sh.getRange(2, 1, lastRow - 1, 16).getDisplayValues();
      for (let i = 0; i < allRows.length; i++) {
        const rowDate = normalizeTestDateKey_(ss, allRows[i][0], shownRows[i][0]);
        const rowKey = makeTestResultKey_(
          rowDate,
          allRows[i][1],
          allRows[i][4],
          allRows[i][5],
          allRows[i][6]
        );
        if (rowKey === wantedKey) {
          matches.push({ sheetRow: i + 2, row: allRows[i] });
        }
      }
    }

    let bestScore;
    let attemptsToday;
    let bestCorrect;
    let bestTotal;
    let bestTimeout;
    let firstAt;
    let bestAt;
    let targetSheetRow;
    let mergedDuplicates = 0;
    let isNewBest = true;

    if (matches.length === 0) {
      bestScore = score;
      attemptsToday = 1;
      bestCorrect = correct;
      bestTotal = total;
      bestTimeout = timeout;
      firstAt = ts;
      bestAt = ts;
      const status = score >= TEST_PASS_SCORE ? "PASS" : "RETRY";
      sh.appendRow([
        dateKey, phone, registeredName, klass, book, lesson, testType,
        bestScore, attemptsToday, bestCorrect, bestTotal, bestTimeout,
        firstAt, bestAt, ts, status
      ]);
      targetSheetRow = sh.getLastRow();
      cacheTestResultRow_(ss, dateKey, phone, book, lesson, testType, targetSheetRow);

      // 전체 rows를 이미 읽었다면 그 메모리 데이터로 학생 통계 캐시를 즉시 만든다.
      let stats = getCachedStudentTestStats_(ss, phone);
      if (!stats && allRows) stats = buildStudentTestStatsFromRows_(allRows, phone);
      if (stats) {
        applyCurrentTestAttemptToStats_(stats, book, lesson, testType, bestScore, ts);
        putCachedStudentTestStats_(ss, phone, stats);
      }

      return {
        bestScore: bestScore,
        attemptsToday: attemptsToday,
        status: status,
        updated: true,
        mergedDuplicates: 0,
        optimizedRowLookup: cachedRow >= 2
      };
    }

    // 기존 중복 행이 있더라도 한 행으로 자동 병합한다.
    attemptsToday = 0;
    bestScore = -Infinity;
    bestCorrect = "";
    bestTotal = "";
    bestTimeout = "";
    firstAt = null;
    bestAt = null;
    let lastAt = null;

    for (let j = 0; j < matches.length; j++) {
      const row = matches[j].row;
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
    isNewBest = !Number.isFinite(bestScore) || score > bestScore;
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
    targetSheetRow = matches[0].sheetRow;
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

    // 전체 검색을 한 경우에만 발견된 과거 중복 행을 정리한다.
    for (let j = matches.length - 1; j >= 1; j--) {
      sh.deleteRow(matches[j].sheetRow);
      mergedDuplicates++;
    }

    cacheTestResultRow_(ss, dateKey, phone, book, lesson, testType, targetSheetRow);

    // 학생 통계 캐시도 현재 시도 1회만 증분 반영한다.
    // 캐시가 없지만 이번 요청에서 allRows를 읽었다면 그 데이터를 재사용해 두 번째 전체 스캔을 없앤다.
    let stats = getCachedStudentTestStats_(ss, phone);
    if (!stats && allRows) stats = buildStudentTestStatsFromRows_(allRows, phone);
    if (stats) {
      applyCurrentTestAttemptToStats_(stats, book, lesson, testType, bestScore, ts);
      putCachedStudentTestStats_(ss, phone, stats);
    }

    return {
      bestScore: bestScore,
      attemptsToday: attemptsToday,
      status: status,
      updated: isNewBest,
      mergedDuplicates: mergedDuplicates,
      optimizedRowLookup: matches.length === 1 && allRows === null
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

  // STEP29-5: 같은 학생의 반복 응시는 캐시된 시트명을 먼저 사용한다.
  // 수동으로 시트를 이름 변경/삭제했으면 캐시된 이름이 열리지 않으므로 기존 탐색으로 자동 복구한다.
  const cachedSheet = getCachedStudentResultSheet_(ss, normalizedPhone);
  if (cachedSheet) return cachedSheet;

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
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    sh.autoResizeColumns(1, headers.length);
  }

  cacheStudentResultSheetName_(ss, normalizedPhone, sh.getName());
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
  const wantedKey = [
    dateKey,
    normalizeTestBook_(book),
    normalizeTestLesson_(lesson),
    testType
  ].join("|");

  const sh = getStudentResultSheet_(ss, studentName, phone);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const lastRow = sh.getLastRow();
    let targetRow = -1;
    let optimizedRowLookup = false;

    // 같은 학생이 같은 날 같은 시험을 재응시하면 캐시된 한 행만 읽는다.
    const cachedRow = getCachedStudentResultRow_(ss, phone, dateKey, book, lesson, testType);
    if (cachedRow >= 2 && cachedRow <= lastRow) {
      const row = sh.getRange(cachedRow, 1, 1, 10).getValues()[0];
      const rowKey = [
        normalizeTestDateKey_(ss, row[0], ""),
        normalizeTestBook_(row[3]),
        normalizeTestLesson_(row[4]),
        normalizeTestType_(row[5])
      ].join("|");
      if (rowKey === wantedKey && normalizePhone_(row[1]) === phone) {
        targetRow = cachedRow;
        optimizedRowLookup = true;
      }
    }

    // 첫 응시, 캐시 만료, 행 이동 때에만 학생 시트 전체를 한 번 검색한다.
    if (targetRow === -1 && lastRow > 1) {
      const rows = sh.getRange(2, 1, lastRow - 1, 10).getValues();
      const shownRows = sh.getRange(2, 1, lastRow - 1, 10).getDisplayValues();
      for (let i = 0; i < rows.length; i++) {
        const rowKey = [
          normalizeTestDateKey_(ss, rows[i][0], shownRows[i][0]),
          normalizeTestBook_(rows[i][3]),
          normalizeTestLesson_(rows[i][4]),
          normalizeTestType_(rows[i][5])
        ].join("|");
        if (rowKey === wantedKey && normalizePhone_(rows[i][1]) === phone) {
          targetRow = i + 2;
          break;
        }
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
      targetRow = sh.getLastRow() + 1;
      sh.getRange(targetRow, 1, 1, 10).setValues(rowValues);
    } else {
      sh.getRange(targetRow, 1, 1, 10).setValues(rowValues);
    }

    cacheStudentResultSheetName_(ss, phone, sh.getName());
    cacheStudentResultRow_(ss, phone, dateKey, book, lesson, testType, targetRow);

    return {
      sheetName: sh.getName(),
      row: targetRow,
      bestScore: bestScore,
      attemptsToday: attemptsToday,
      status: status,
      optimizedRowLookup: optimizedRowLookup
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

  // STEP29-4: 반복 조회는 캐시된 한 행만 확인한다.
  const cachedRow = getCachedTestResultRow_(ss, dateKey, phone, book, lesson, testType);
  if (cachedRow >= 2 && cachedRow <= lastRow) {
    const row = sh.getRange(cachedRow, 1, 1, 16).getValues()[0];
    const rowKey = makeTestResultKey_(
      normalizeTestDateKey_(ss, row[0], ""),
      row[1], row[4], row[5], row[6]
    );
    if (rowKey === wantedKey) {
      const bestScore = Number(row[7]);
      const attemptsToday = Number(row[8]);
      return {
        found: true,
        bestScore: Number.isFinite(bestScore) ? bestScore : 0,
        attemptsToday: Number.isFinite(attemptsToday) ? attemptsToday : 0,
        status: String(row[15] || ((Number.isFinite(bestScore) && bestScore >= TEST_PASS_SCORE) ? "PASS" : "RETRY"))
      };
    }
  }

  const rows = sh.getRange(2, 1, lastRow - 1, 16).getValues();
  const shownRows = sh.getRange(2, 1, lastRow - 1, 16).getDisplayValues();
  for (let i = 0; i < rows.length; i++) {
    const rowDate = normalizeTestDateKey_(ss, rows[i][0], shownRows[i][0]);
    const rowKey = makeTestResultKey_(rowDate, rows[i][1], rows[i][4], rows[i][5], rows[i][6]);
    if (rowKey === wantedKey) {
      cacheTestResultRow_(ss, dateKey, phone, book, lesson, testType, i + 2);
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
  // STEP29-4: 누적 최고점은 학생별 캐시된 통계 한 번으로 처리한다.
  const stats = buildStudentTestStats_(ss, phone);
  const key = progressTestKey_(book, lesson, testType);
  const found = hasProgressScore_(stats, book, lesson, testType);
  const bestScore = found ? getProgressScore_(stats, book, lesson, testType) : 0;
  const attemptsTotal = Number(stats && stats.attemptsByKey ? stats.attemptsByKey[key] : 0) || 0;
  return {
    found: found,
    bestScore: bestScore,
    attemptsTotal: attemptsTotal,
    status: found ? (bestScore >= TEST_PASS_SCORE ? "PASS" : "RETRY") : "NONE"
  };
}


// STEP29-2: 서울대 교재 선택 화면용 일괄 진도 조회.
// 기존에는 과마다 vocab/grammar/mixed를 각각 mastery_status로 요청해서
// 1A는 최대 24회, 2A는 최대 27회의 GAS 요청과 TestResults 반복 읽기가 발생했다.
// 아래 함수들은 TestResults를 한 번만 읽은 stats를 재사용해 교재 전체 상태를 만든다.
function masteryStatusFromStats_(stats, book, lesson, testType) {
  const found = hasProgressScore_(stats, book, lesson, testType);
  const bestScore = found ? getProgressScore_(stats, book, lesson, testType) : 0;
  return {
    found: found,
    bestScore: bestScore,
    status: found ? (bestScore >= TEST_PASS_SCORE ? "PASS" : "RETRY") : "NONE"
  };
}

function lessonMasteryFromStats_(stats, book, lesson) {
  const vocab = masteryStatusFromStats_(stats, book, lesson, "vocab");
  const grammar = masteryStatusFromStats_(stats, book, lesson, "grammar");
  const mixed = masteryStatusFromStats_(stats, book, lesson, "mixed");
  const passed = [vocab, grammar, mixed].every(function(item) {
    return item.status === "PASS" && Number(item.bestScore || 0) >= TEST_PASS_SCORE;
  });
  return {
    ok: true,
    status: passed ? "PASS" : "RETRY",
    tests: { vocab: vocab, grammar: grammar, mixed: mixed }
  };
}

function getLearningAccessProfileFast_(ss, phone, requestedBook) {
  const sh = getLearningStartSheet_(ss);
  const targetPhone = normalizePhone_(phone);
  const targetBook = normalizeTestBook_(requestedBook);
  let start = null;
  let curriculumStart = null;
  let developerDecision = null;

  if (targetPhone && sh.getLastRow() >= 2) {
    const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues();
    for (let i = 0; i < rows.length; i++) {
      const rowPhone = normalizePhone_(rows[i][0]);
      if (rowPhone !== targetPhone) continue;

      const rawDeveloper = rows[i][7];
      if (rawDeveloper !== "" && rawDeveloper != null) {
        developerDecision = isEnabled_(rawDeveloper);
      }

      const rowBook = normalizeTestBook_(rows[i][2]);
      const enabled = isEnabled_(rows[i][4]);
      const startLesson = Number(String(rows[i][3] == null ? "" : rows[i][3]).trim());
      if (!enabled || getSnuBookRank_(rowBook) < 0 || !Number.isFinite(startLesson) || startLesson <= 0) continue;

      const candidate = {
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

      // 기존 함수와 동일하게 같은 학생의 활성 시작점이 여러 줄이면 마지막 행을 우선한다.
      curriculumStart = candidate;
      if (rowBook === targetBook) start = candidate;
    }
  }

  const developer = developerDecision === true;
  const requestedRank = getSnuBookRank_(targetBook);
  const curriculumStartBook = curriculumStart ? normalizeTestBook_(curriculumStart.book) : "";
  const curriculumStartRank = getSnuBookRank_(curriculumStartBook);
  let bookRelation = "none";
  if (requestedRank >= 0 && curriculumStartRank >= 0) {
    if (requestedRank < curriculumStartRank) bookRelation = "lower";
    else if (requestedRank === curriculumStartRank) bookRelation = "same";
    else bookRelation = "higher";
  }

  return {
    found: !!start,
    startLesson: start ? start.startLesson : 0,
    enabled: !!(start && start.enabled),
    note: start ? start.note || "" : "",
    source: start ? "teacher_override" : "none",
    curriculumFound: !!curriculumStart,
    curriculumStartBook: curriculumStartBook,
    curriculumStartLesson: curriculumStart ? curriculumStart.startLesson : 0,
    curriculumEnabled: !!(curriculumStart && curriculumStart.enabled),
    curriculumNote: curriculumStart ? curriculumStart.note || "" : "",
    bookRelation: bookRelation,
    lowerBookAccess: bookRelation === "lower",
    sameStartBook: bookRelation === "same",
    higherBook: bookRelation === "higher",
    isDeveloper: developer,
    developerAccess: developer,
    role: developer ? "developer" : "student"
  };
}

function getSnuBookStatusSnapshot_(ss, phone, requestedBook) {
  const book = normalizeTestBook_(requestedBook);
  const rank = getSnuBookRank_(book);
  const range = getSnuLessonRange_(book);
  if (rank < 0 || !range) return { ok: false, error: "invalid_book" };

  const access = getLearningAccessProfileFast_(ss, phone, book);
  const lessons = {};
  let previousGate = null;

  // 시작점보다 낮은 복습 교재는 원래 전체 접근 허용이므로 TestResults를 읽을 필요조차 없다.
  if (access.lowerBookAccess === true && access.isDeveloper !== true) {
    for (let lesson = range[0]; lesson <= range[1]; lesson++) {
      lessons[String(lesson)] = {
        ok: true,
        status: "RECOGNIZED",
        tests: {
          vocab: { found: false, bestScore: 0, status: "NONE" },
          grammar: { found: false, bestScore: 0, status: "NONE" },
          mixed: { found: false, bestScore: 0, status: "NONE" }
        }
      };
    }
  } else {
    // 가장 큰 비용이었던 TestResults 전체 읽기를 이 요청에서 단 한 번 수행한다.
    const stats = buildStudentTestStats_(ss, phone);
    for (let lesson = range[0]; lesson <= range[1]; lesson++) {
      lessons[String(lesson)] = lessonMasteryFromStats_(stats, book, lesson);
    }

    if (rank > 0) {
      const previousBook = SNU_CURRICULUM_BOOKS[rank - 1];
      const previousRange = getSnuLessonRange_(previousBook);
      if (previousRange) {
        const previousLesson = previousRange[1];
        previousGate = {
          book: previousBook,
          lesson: previousLesson,
          mastery: lessonMasteryFromStats_(stats, previousBook, previousLesson)
        };
      }
    }
  }

  return Object.assign({
    ok: true,
    scope: "book_snapshot",
    book: book,
    passScore: TEST_PASS_SCORE,
    lessons: lessons,
    previousGate: previousGate
  }, access);
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

function accumulateStudentTestStatsRow_(stats, row) {
  stats = stats || emptyStudentTestStats_();
  if (!row) return stats;

  const key = progressTestKey_(row[4], row[5], row[6]);
  const score = Number(row[7]);
  if (Number.isFinite(score)) {
    const prev = Number(stats.scores[key]);
    if (!Number.isFinite(prev) || score > prev) stats.scores[key] = score;
  }

  const attempts = Number(row[8]);
  if (Number.isFinite(attempts) && attempts > 0) {
    stats.totalAttempts += attempts;
    stats.attemptsByKey[key] = (Number(stats.attemptsByKey[key]) || 0) + attempts;
  }

  const firstAt = dateOrNull_(row[12]);
  const lastAt = dateOrNull_(row[14]) || dateOrNull_(row[13]) || firstAt;
  if (firstAt) stats.firstTestAt = earlierDate_(stats.firstTestAt, firstAt);

  if (lastAt) {
    const previousLast = dateOrNull_(stats.lastTestAt);
    if (!previousLast || lastAt.getTime() >= previousLast.getTime()) {
      stats.lastTestAt = lastAt;
      stats.lastTestType = normalizeTestType_(row[6]);
      stats.lastTestScore = Number.isFinite(score) ? score : "";
    }
  }

  return stats;
}

function buildStudentTestStatsFromRows_(rows, phone) {
  const stats = emptyStudentTestStats_();
  const targetPhone = normalizePhone_(phone);
  if (!targetPhone || !rows) return stats;

  for (let i = 0; i < rows.length; i++) {
    if (normalizePhone_(rows[i][1]) !== targetPhone) continue;
    accumulateStudentTestStatsRow_(stats, rows[i]);
  }
  return stats;
}

function applyCurrentTestAttemptToStats_(stats, book, lesson, testType, bestScore, ts) {
  stats = stats || emptyStudentTestStats_();
  const key = progressTestKey_(book, lesson, testType);
  const n = Number(bestScore);
  const previous = Number(stats.scores[key]);
  if (Number.isFinite(n) && (!Number.isFinite(previous) || n > previous)) {
    stats.scores[key] = n;
  }

  stats.totalAttempts = (Number(stats.totalAttempts) || 0) + 1;
  stats.attemptsByKey[key] = (Number(stats.attemptsByKey[key]) || 0) + 1;
  const when = dateOrNull_(ts) || new Date();
  if (!stats.firstTestAt) stats.firstTestAt = when;
  stats.lastTestAt = when;
  stats.lastTestType = normalizeTestType_(testType);
  stats.lastTestScore = Number.isFinite(n) ? n : "";
  return stats;
}

function buildStudentTestStats_(ss, phone, forceRefresh) {
  const targetPhone = normalizePhone_(phone);
  if (!targetPhone) return emptyStudentTestStats_();

  if (!forceRefresh) {
    const cached = getCachedStudentTestStats_(ss, targetPhone);
    if (cached) return cached;
  }

  const sh = ss.getSheetByName(TEST_RESULTS_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) {
    const empty = emptyStudentTestStats_();
    putCachedStudentTestStats_(ss, targetPhone, empty);
    return empty;
  }

  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 16).getValues();
  const stats = buildStudentTestStatsFromRows_(rows, targetPhone);
  putCachedStudentTestStats_(ss, targetPhone, stats);
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

// 진도현황에서 제외할 개발자/관리자 이름.
// 유정태는 학생이 아니라 개발자이므로 developerAccess 값을 FALSE로 바꾸어
// 학생 잠금 동작을 시험하더라도 진도현황에는 다시 나타나지 않게 한다.
const STUDENT_PROGRESS_EXCLUDED_NAMES = ["유정태"];

function normalizeStudentProgressExcludedName_(value) {
  return String(value == null ? "" : value).replace(/\s+/g, "").trim();
}

function getStudentProgressDeveloperPhoneMap_(ss) {
  const result = {};
  const sh = ss.getSheetByName(LEARNING_START_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return result;

  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues();
  for (let i = 0; i < rows.length; i++) {
    const phone = normalizePhone_(rows[i][0]);
    if (!phone) continue;
    if (isEnabled_(rows[i][7])) result[phone] = true;
  }
  return result;
}

function isStudentProgressExcluded_(phone, name, developerPhoneMap) {
  const normalizedName = normalizeStudentProgressExcludedName_(name);
  for (let i = 0; i < STUDENT_PROGRESS_EXCLUDED_NAMES.length; i++) {
    if (normalizedName === normalizeStudentProgressExcludedName_(STUDENT_PROGRESS_EXCLUDED_NAMES[i])) {
      return true;
    }
  }
  const targetPhone = normalizePhone_(phone);
  return !!(targetPhone && developerPhoneMap && developerPhoneMap[targetPhone]);
}

function removeExcludedStudentProgressRows_(ss) {
  const sh = ss.getSheetByName(STUDENT_PROGRESS_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return 0;

  const developerPhoneMap = getStudentProgressDeveloperPhoneMap_(ss);
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, STUDENT_PROGRESS_HEADERS.length).getValues();
  const rowsToDelete = [];
  for (let i = 0; i < values.length; i++) {
    const phone = normalizePhone_(values[i][1]);
    const name = String(values[i][2] == null ? "" : values[i][2]).trim();
    if (isStudentProgressExcluded_(phone, name, developerPhoneMap)) rowsToDelete.push(i + 2);
  }

  for (let i = rowsToDelete.length - 1; i >= 0; i--) sh.deleteRow(rowsToDelete[i]);
  if (rowsToDelete.length > 0) sortStudentProgressRows_(sh);
  return rowsToDelete.length;
}

// STEP29-3: 로그인만 발생했을 때는 시험 전체(TestResults)를 다시 읽지 않는다.
// 기존 진도행의 최근접속/최근활동만 갱신하고, 시작점이 바뀌었거나 첫 접속인 경우에만
// 기존의 전체 진도 계산으로 안전하게 되돌아간다.
function updateStudentProgressDashboardLoginFields_(ss, name, currentBook, lastLoginAt) {
  const b = normalizeTestBook_(currentBook);
  const targetSheetName = b === "SNU-1A"
    ? STUDENT_PROGRESS_DASHBOARD_1A
    : ((b === "SNU-1B" || b === "SNU-2A") ? STUDENT_PROGRESS_DASHBOARD_1B2A : "");
  if (!targetSheetName) return { ok: true, skipped: true, reason: "book_not_dashboard_target" };

  const sh = ss.getSheetByName(targetSheetName);
  if (!sh || sh.getLastRow() < 4) return { ok: true, skipped: true, reason: "dashboard_missing" };

  const count = Math.max(sh.getLastRow() - 3, 0);
  if (count <= 0) return { ok: true, skipped: true, reason: "dashboard_empty" };

  const targetName = String(name || "").trim();
  const values = sh.getRange(4, 1, count, 2).getValues();
  let updated = 0;
  for (let i = 0; i < values.length; i++) {
    const rowName = String(values[i][0] == null ? "" : values[i][0]).trim();
    const rowBook = normalizeTestBook_(values[i][1]);
    if (rowName !== targetName || rowBook !== b) continue;

    const row = i + 4;
    sh.getRange(row, 7).setValue(lastLoginAt).setNumberFormat("yyyy-MM-dd HH:mm");
    sh.getRange(row, 8).setFormula(
      '=IF(G' + row + '="","-",IF(TODAY()<=INT(G' + row + '),"오늘",(TODAY()-INT(G' + row + '))&"일 전"))'
    );
    updated++;
  }

  return { ok: true, updated: updated };
}

function updateStudentProgressLoginOnly_(ss, identity, context) {
  context = context || {};
  const phone = normalizePhone_(identity && identity.phone);
  if (!phone) return null;

  const now = dateOrNull_(context.ts) || new Date();
  const name = String(
    (identity && identity.studentName) ||
    (identity && identity.name) ||
    "학생"
  ).trim() || "학생";

  const developerPhoneMap = getStudentProgressDeveloperPhoneMap_(ss);
  if (isStudentProgressExcluded_(phone, name, developerPhoneMap)) {
    const progressSh = ss.getSheetByName(STUDENT_PROGRESS_SHEET_NAME);
    let removed = false;
    if (progressSh) {
      const lock = LockService.getScriptLock();
      lock.waitLock(10000);
      try {
        const excludedRow = findStudentProgressRow_(progressSh, phone);
        if (excludedRow > 0) {
          progressSh.deleteRow(excludedRow);
          sortStudentProgressRows_(progressSh);
          removed = true;
        }
      } finally {
        try { lock.releaseLock(); } catch (err) {}
      }
    }
    if (removed) {
      try { refreshStudentProgressDashboards_(ss); } catch (err) {
        console.error("Student progress dashboard exclusion refresh failed", err);
      }
    }
    return {
      sheetName: STUDENT_PROGRESS_SHEET_NAME,
      phone: phone,
      name: name,
      skipped: true,
      reason: "excluded_developer"
    };
  }

  const sh = getStudentProgressSheet_(ss);
  let row = findStudentProgressRow_(sh, phone);

  // 첫 접속 학생은 기존 전체 계산을 한 번 수행해 현재 진도를 정확하게 만든다.
  if (row < 0) {
    return updateStudentProgressSummary_(ss, identity, {
      ts: now,
      klass: String(context.klass || ""),
      isLogin: true,
      skipDashboardRefresh: false
    });
  }

  let existing = sh.getRange(row, 1, 1, STUDENT_PROGRESS_HEADERS.length).getValues()[0];

  // 교사가 학습시작점을 바꿨다면 로그인 시에도 진도현황이 즉시 따라가야 하므로
  // 이 경우에만 전체 진도 계산으로 되돌아간다.
  const configured = getLearningCurriculumStartPoint_(ss, phone);
  const configuredStart = normalizeSnuStartPosition_(
    configured.found ? configured.book : "SNU-1A",
    configured.found ? configured.startLesson : 1
  );
  const existingStartBook = normalizeTestBook_(existing[8]);
  const existingStartLesson = Number(existing[9]);
  if (
    existingStartBook !== configuredStart.book ||
    !Number.isFinite(existingStartLesson) ||
    existingStartLesson !== configuredStart.lesson
  ) {
    return updateStudentProgressSummary_(ss, identity, {
      ts: now,
      klass: String(context.klass || ""),
      isLogin: true,
      skipDashboardRefresh: false
    });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // 정렬 등으로 행 위치가 바뀌었을 수 있으므로 잠금 후 다시 찾는다.
    row = findStudentProgressRow_(sh, phone);
    if (row < 0) {
      // 아주 드문 동시 수정 상황. 잠금을 해제한 뒤 전체 계산하도록 표식만 반환한다.
      return { fallbackRequired: true };
    }

    existing = sh.getRange(row, 1, 1, STUDENT_PROGRESS_HEADERS.length).getValues()[0];
    const klass = String(context.klass || existing[4] || "").trim();
    const firstLoginAt = dateOrNull_(existing[5]) || now;

    existing[2] = name;        // C 학생이름
    existing[3] = "TRUE";     // D 사용여부: 인증을 통과한 요청이므로 TRUE
    existing[4] = klass;       // E 반
    existing[5] = firstLoginAt;// F 최초접속
    existing[6] = now;         // G 최근접속
    existing[20] = now;        // U 최근활동

    sh.getRange(row, 1, 1, STUDENT_PROGRESS_HEADERS.length).setValues([existing]);
    sortStudentProgressRows_(sh);
    row = findStudentProgressRow_(sh, phone);
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }

  // 전체 그래프 재작성 대신, 그래프 시트의 최근접속/접속경과 두 칸만 갱신한다.
  try {
    updateStudentProgressDashboardLoginFields_(ss, name, existing[10], now);
  } catch (err) {
    console.error("Student progress dashboard login-only update failed", err);
  }

  return {
    sheetName: sh.getName(),
    row: row,
    phone: phone,
    name: name,
    currentBook: existing[10],
    currentLesson: existing[11],
    status: existing[16],
    nextStep: existing[17],
    lightweight: true
  };
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

  // 개발자/관리자는 학생 진도현황에 기록하지 않는다. 기존 행이 있으면 즉시 제거한다.
  if (isStudentProgressExcluded_(phone, name, getStudentProgressDeveloperPhoneMap_(ss))) {
    const progressSh = ss.getSheetByName(STUDENT_PROGRESS_SHEET_NAME);
    if (progressSh) {
      const lock = LockService.getScriptLock();
      lock.waitLock(10000);
      try {
        const excludedRow = findStudentProgressRow_(progressSh, phone);
        if (excludedRow > 0) {
          progressSh.deleteRow(excludedRow);
          sortStudentProgressRows_(progressSh);
        }
      } finally {
        try { lock.releaseLock(); } catch (err) {}
      }
    }

    if (!context.skipDashboardRefresh) {
      try { refreshStudentProgressDashboards_(ss); } catch (err) {
        console.error("Student progress dashboard exclusion refresh failed", err);
      }
    }

    return {
      sheetName: STUDENT_PROGRESS_SHEET_NAME,
      phone: phone,
      name: name,
      skipped: true,
      reason: "excluded_developer"
    };
  }

  const stats = context.preloadedStats || buildStudentTestStats_(ss, phone, !!context.forceStatsRefresh);
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
      existing
        ? (Number(existing[0]) > 0 ? Number(existing[0]) : Math.max(row - 1, 1))
        : "", // 기존 학생은 현재 순번을 보존하고, 신규 학생만 정렬 후 순번을 부여한다.
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

    // STEP29-6: 시험 결과가 들어올 때마다 진도현황 전체를 정렬하고 그래프 두 시트를
    // 통째로 다시 쓰지 않는다. 최근접속 정렬 기준은 시험으로 바뀌지 않으므로,
    // 로그인/신규 학생/이름 변경 때만 정렬한다. 그래프도 실제 진행 위치가 바뀐 경우만 갱신한다.
    const wasNewProgressRow = row < 0;
    const previousName = existing ? String(existing[2] == null ? "" : existing[2]).trim() : "";
    const previousEnabled = existing ? isEnabled_(existing[3]) : false;
    const previousBook = existing ? normalizeTestBook_(existing[10]) : "";
    const previousLesson = existing ? String(existing[11] == null ? "" : existing[11]).trim() : "";
    const previousPassSummary = existing ? String(existing[12] == null ? "" : existing[12]).trim() : "";
    const nextEnabled = !!(authInfo.found && authInfo.enabled);

    if (row < 0) {
      row = sh.getLastRow() + 1;
      sh.getRange(row, 1, 1, STUDENT_PROGRESS_HEADERS.length).setValues(values);
    } else {
      sh.getRange(row, 1, 1, STUDENT_PROGRESS_HEADERS.length).setValues(values);
    }

    const needsProgressSort = !!context.isLogin || wasNewProgressRow || previousName !== name;
    if (needsProgressSort) {
      sortStudentProgressRows_(sh);
      row = findStudentProgressRow_(sh, phone);
    } else {
      // STEP29-6 FIX1: 시험 결과 갱신은 최근접속 순서를 바꾸지 않으므로 전체 정렬을 생략한다.
      // 다만 위의 setValues()가 H열(접속경과)의 기존 수식을 빈칸으로 덮어쓰므로,
      // 해당 학생의 H셀 하나만 즉시 복원한다. 전체 시트 재정렬/재수식은 하지 않는다.
      sh.getRange(row, 8).setFormula(
        '=IF(G' + row + '=\"\",\"-\",IF(TODAY()<=INT(G' + row + '),\"오늘\",(TODAY()-INT(G' + row + '))&\"일 전\"))'
      );
    }

    const dashboardProgressChanged =
      wasNewProgressRow ||
      previousName !== name ||
      previousEnabled !== nextEnabled ||
      previousBook !== normalizeTestBook_(snu.currentBook) ||
      previousLesson !== String(snu.currentLesson == null ? "" : snu.currentLesson).trim() ||
      previousPassSummary !== String(snu.passSummary == null ? "" : snu.passSummary).trim();

    // 점수만 바뀌고 현재 과/통과현황이 그대로라면 진행그래프의 값도 그대로이므로
    // 두 그래프 시트 전체를 다시 쓰지 않는다. 90점 통과 등으로 실제 진도가 변할 때만 갱신한다.
    let dashboardRefreshed = false;
    if (!context.skipDashboardRefresh && (dashboardProgressChanged || context.forceDashboardRefresh)) {
      try {
        refreshStudentProgressDashboards_(ss);
        dashboardRefreshed = true;
      } catch (err) {
        console.error("Student progress dashboard refresh failed", err);
      }
    }

    return {
      sheetName: sh.getName(),
      row: row,
      phone: phone,
      name: name,
      currentBook: snu.currentBook,
      currentLesson: snu.currentLesson,
      status: snu.status,
      nextStep: snu.nextStep,
      dashboardRefreshed: dashboardRefreshed,
      optimizedWrites: true
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
  const statsByPhone = {};
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
      if (!statsByPhone[phone]) statsByPhone[phone] = emptyStudentTestStats_();
      accumulateStudentTestStatsRow_(statsByPhone[phone], rows[i]);
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
    const updated = updateStudentProgressSummary_(
      ss,
      { phone: phone, studentName: info ? info.name : "" },
      {
        ts: v.lastLoginAt || v.firstLoginAt || new Date(),
        firstLoginAt: v.firstLoginAt,
        lastLoginAt: v.lastLoginAt,
        klass: v.klass,
        isLogin: !!v.lastLoginAt,
        skipDashboardRefresh: true,
        preloadedStats: statsByPhone[phone] || emptyStudentTestStats_()
      }
    );
    if (statsByPhone[phone]) putCachedStudentTestStats_(ss, phone, statsByPhone[phone]);
    if (updated && !updated.skipped) count++;
  }

  // 전체 재구성 후에도 서식, 최근접속 정렬, 순번, 접속경과를 한 번 더 확정한다.
  formatStudentProgressSheet_(progressSh);
  PropertiesService.getScriptProperties().setProperty(
    studentProgressStyleKey_(ss),
    STUDENT_PROGRESS_STYLE_VERSION
  );
  sortStudentProgressRows_(progressSh);

  // STEP27: 기존에 그래프 시트를 만들어 둔 경우 전체 재구성 후 한 번만 동기화한다.
  try {
    refreshStudentProgressDashboards_(ss);
  } catch (err) {
    console.error("Student progress dashboard rebuild refresh failed", err);
  }

  return { ok: true, count: count, sheetName: STUDENT_PROGRESS_SHEET_NAME };
}


// -----------------------------------------------------------------------------
// STEP27 FIX2 - 학생 진도 그래프 대시보드
// STEP29-3: 로그인 시 전체 대시보드 재작성 대신 최근접속 두 칸만 경량 갱신
// -----------------------------------------------------------------------------
// 수정사항:
// 1) Google Sheets에서 빈 대형 차트가 나타나는 문제를 피하기 위해 EmbeddedChart를 사용하지 않는다.
// 2) 각 학생 행에 SPARKLINE 가로 막대를 직접 표시해 이름과 진도를 한눈에 비교한다.
// 3) 진행률 숫자와 막대그래프를 함께 표시하고, 로그인/시험 시 자동 갱신을 유지한다.
// 4) 유정태 및 developerAccess=TRUE 계정은 진도현황/그래프에서 계속 제외한다.

const STUDENT_PROGRESS_DASHBOARD_1A = "1A 진도그래프";
const STUDENT_PROGRESS_DASHBOARD_1B2A = "1B-2A 진도그래프";
const WORKBOOK_EVAL_RESULTS_SHEET_NAME = "워크북평가결과";

// -----------------------------------------------------------------------------
// STEP28 - 관리용 핵심 시트를 항상 시트 탭 맨 앞에 유지
// -----------------------------------------------------------------------------
// Google Sheets에는 시트 탭 자체를 영구적으로 "고정(pin)"하는 기능이 없으므로,
// 아래 관리 시트를 항상 앞쪽에 자동 재배치한다.
// 순서: 인증목록 -> 워크북평가결과 -> 진도현황 -> 1A 진도그래프 -> 1B-2A 진도그래프
const MANAGEMENT_SHEET_FRONT_ORDER = [
  AUTH_SHEET_NAME,
  WORKBOOK_EVAL_RESULTS_SHEET_NAME,
  STUDENT_PROGRESS_SHEET_NAME,
  STUDENT_PROGRESS_DASHBOARD_1A,
  STUDENT_PROGRESS_DASHBOARD_1B2A
];

function ensureManagementSheetsAtFront_(ss) {
  if (!ss) return { ok: false, sheets: [] };

  // STEP29-3: 이미 원하는 위치라면 setActiveSheet/moveActiveSheet를 전혀 호출하지 않는다.
  // 로그인/시험이 많아질수록 불필요한 시트 이동 작업이 누적되는 것을 막는다.
  let position = 1;
  let needsMove = false;
  for (let i = 0; i < MANAGEMENT_SHEET_FRONT_ORDER.length; i++) {
    const sh = ss.getSheetByName(MANAGEMENT_SHEET_FRONT_ORDER[i]);
    if (!sh) continue;
    if (sh.getIndex() !== position) {
      needsMove = true;
      break;
    }
    position++;
  }

  if (!needsMove) {
    return { ok: true, sheets: [], skipped: true, reason: "already_in_front" };
  }

  let originalActive = null;
  try { originalActive = ss.getActiveSheet(); } catch (err) {}

  const moved = [];
  position = 1;
  for (let i = 0; i < MANAGEMENT_SHEET_FRONT_ORDER.length; i++) {
    const name = MANAGEMENT_SHEET_FRONT_ORDER[i];
    const sh = ss.getSheetByName(name);
    if (!sh) continue;

    try {
      if (sh.getIndex() !== position) {
        ss.setActiveSheet(sh);
        ss.moveActiveSheet(position);
        moved.push(name);
      }
      position++;
    } catch (err) {
      console.error("Management sheet reorder failed: " + name, err);
    }
  }

  // 실제로 이동한 경우에만 사용자가 보고 있던 시트를 복원한다.
  if (originalActive && moved.length > 0) {
    try { ss.setActiveSheet(originalActive); } catch (err) {}
  }

  return { ok: true, sheets: moved, skipped: moved.length === 0 };
}

// Apps Script 편집기에서 한 번 직접 실행하면 현재 시트 순서를 즉시 정리할 수 있다.
function arrangeManagementSheetsAtFront() {
  return ensureManagementSheetsAtFront_(SpreadsheetApp.getActive());
}

// 스프레드시트를 열 때에도 관리 시트가 맨 앞 순서로 복원된다.
function onOpen(e) {
  try {
    ensureManagementSheetsAtFront_(SpreadsheetApp.getActive());
  } catch (err) {
    console.error("Management sheet onOpen reorder failed", err);
  }
}
const STUDENT_PROGRESS_DASHBOARD_MAX_STUDENTS = 200;
const STUDENT_PROGRESS_DASHBOARD_HEADERS = [
  "학생이름", "현재교재", "현재과", "통과현황", "진행률(%)", "진행그래프", "최근접속", "접속경과"
];

function parseStudentProgressPassCount_(value) {
  const m = String(value == null ? "" : value).trim().match(/^(\d+)\s*\/\s*3$/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(3, Math.floor(n)));
}

function clampStudentProgressPercent_(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function computeStudentDashboardPercent_(book, lesson, passSummary) {
  const b = normalizeTestBook_(book);
  const n = Number(lesson);
  const passCount = parseStudentProgressPassCount_(passSummary);
  const partial = passCount / 3;

  if (b === "SNU-1A") {
    const lessonNo = Number.isFinite(n) ? n : 1;
    return clampStudentProgressPercent_((((lessonNo - 1) + partial) / 8) * 100);
  }

  if (b === "SNU-1B") {
    const lessonNo = Number.isFinite(n) ? n : 9;
    return clampStudentProgressPercent_((((lessonNo - 9) + partial) / 17) * 100);
  }

  if (b === "SNU-2A") {
    const lessonNo = Number.isFinite(n) ? n : 1;
    return clampStudentProgressPercent_(((8 + (lessonNo - 1) + partial) / 17) * 100);
  }

  return 0;
}

function collectStudentProgressDashboardRows_(ss) {
  const progressSh = ss.getSheetByName(STUDENT_PROGRESS_SHEET_NAME);
  const result = { oneA: [], oneBTwoA: [] };
  if (!progressSh || progressSh.getLastRow() < 2) return result;

  const range = progressSh.getRange(
    2, 1, progressSh.getLastRow() - 1, STUDENT_PROGRESS_HEADERS.length
  );
  const rows = range.getValues();
  const shownRows = range.getDisplayValues();
  const developerPhoneMap = getStudentProgressDeveloperPhoneMap_(ss);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const shown = shownRows[i];
    const enabled = isEnabled_(row[3]);                 // D 사용여부
    const phone = normalizePhone_(row[1]);              // B 전화번호
    const name = String(row[2] == null ? "" : row[2]).trim();
    const currentBook = normalizeTestBook_(row[10]);    // K 현재교재
    const currentLesson = row[11];                      // L 현재과
    const passSummary = String(shown[12] || row[12] || "").trim(); // M 통과현황
    const lastLogin = row[6] || "";                    // G 최근접속
    const elapsed = String(shown[7] || row[7] || "").trim();       // H 접속경과

    if (!enabled || !name) continue;
    if (isStudentProgressExcluded_(phone, name, developerPhoneMap)) continue;
    if (currentBook !== "SNU-1A" && currentBook !== "SNU-1B" && currentBook !== "SNU-2A") continue;

    const out = [
      name,
      currentBook,
      currentLesson,
      passSummary,
      computeStudentDashboardPercent_(currentBook, currentLesson, passSummary),
      lastLogin,
      elapsed
    ];

    if (currentBook === "SNU-1A") result.oneA.push(out);
    else result.oneBTwoA.push(out);
  }

  // 진행률이 높은 학생부터 보고, 같은 진행률이면 이름순으로 정렬한다.
  function sortRows(a, b) {
    const diff = Number(b[4]) - Number(a[4]);
    if (diff !== 0) return diff;
    return String(a[0]).localeCompare(String(b[0]));
  }
  result.oneA.sort(sortRows);
  result.oneBTwoA.sort(sortRows);

  result.oneA = result.oneA.slice(0, STUDENT_PROGRESS_DASHBOARD_MAX_STUDENTS);
  result.oneBTwoA = result.oneBTwoA.slice(0, STUDENT_PROGRESS_DASHBOARD_MAX_STUDENTS);
  return result;
}

function removeStudentProgressDashboardCharts_(sh) {
  if (!sh) return;
  const charts = sh.getCharts();
  for (let i = 0; i < charts.length; i++) sh.removeChart(charts[i]);
}

function formatStudentProgressDashboardSheet_(sh, title, note) {
  if (!sh) return;

  // FIX1에서 생성된 빈 대형 차트가 남아 있으면 먼저 제거한다.
  removeStudentProgressDashboardCharts_(sh);

  // setup 함수를 다시 실행해도 같은 두 시트를 안전하게 새로 구성한다.
  sh.getRange("A1:H2").breakApart();
  sh.clear();

  if (sh.getMaxColumns() < 8) {
    sh.insertColumnsAfter(sh.getMaxColumns(), 8 - sh.getMaxColumns());
  }
  if (sh.getMaxRows() < STUDENT_PROGRESS_DASHBOARD_MAX_STUDENTS + 3) {
    sh.insertRowsAfter(
      sh.getMaxRows(),
      STUDENT_PROGRESS_DASHBOARD_MAX_STUDENTS + 3 - sh.getMaxRows()
    );
  }

  sh.getRange("A1:H1").merge();
  sh.getRange("A1")
    .setValue(title)
    .setFontSize(16)
    .setFontWeight("bold")
    .setFontColor("#ffffff")
    .setBackground("#1f4e78")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
  sh.setRowHeight(1, 38);

  sh.getRange("A2:H2").merge();
  sh.getRange("A2")
    .setValue(note)
    .setFontColor("#555555")
    .setBackground("#eef4fb")
    .setWrap(true)
    .setHorizontalAlignment("left")
    .setVerticalAlignment("middle");
  sh.setRowHeight(2, 46);

  sh.getRange("A3:H3")
    .setValues([STUDENT_PROGRESS_DASHBOARD_HEADERS])
    .setFontWeight("bold")
    .setFontColor("#ffffff")
    .setBackground("#4f81bd")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
  sh.setRowHeight(3, 30);
  sh.setFrozenRows(3);

  const widths = [130, 95, 70, 85, 90, 280, 145, 90];
  for (let c = 0; c < widths.length; c++) sh.setColumnWidth(c + 1, widths[c]);

  const dataRows = STUDENT_PROGRESS_DASHBOARD_MAX_STUDENTS;
  sh.getRange(4, 1, dataRows, 8).setVerticalAlignment("middle");
  sh.getRange(4, 2, dataRows, 4).setHorizontalAlignment("center");
  sh.getRange(4, 8, dataRows, 1).setHorizontalAlignment("center");
  sh.getRange(4, 4, dataRows, 1).setNumberFormat("@");
  sh.getRange(4, 5, dataRows, 1).setNumberFormat('0.0"%"');
  sh.getRange(4, 7, dataRows, 1).setNumberFormat("yyyy-MM-dd HH:mm");

  const existingFilter = sh.getFilter();
  if (existingFilter) existingFilter.remove();
  sh.getRange(3, 1, dataRows + 1, 8).createFilter();
}

function studentProgressSparklineFormula_(row, color) {
  const safeColor = String(color || "#4f81bd").replace(/"/g, "");
  return '=IF(E' + row + '="","",SPARKLINE(E' + row + ',{"charttype","bar";"max",100;"color1","' + safeColor + '"}))';
}

function writeStudentProgressDashboardRows_(sh, rows, barColor) {
  if (!sh) return 0;
  const maxRows = STUDENT_PROGRESS_DASHBOARD_MAX_STUDENTS;
  sh.getRange(4, 1, maxRows, 8).clearContent();

  if (!rows || rows.length === 0) {
    sh.getRange("A4").setValue("현재 해당 과정 학생이 없습니다.").setFontColor("#777777");
    return 0;
  }

  const values = rows.map(function(row) {
    return [row[0], row[1], row[2], row[3], row[4], "", row[5], row[6]];
  });
  sh.getRange(4, 1, values.length, 8).setValues(values);
  sh.getRange(4, 4, values.length, 1).setNumberFormat("@");
  sh.getRange(4, 5, values.length, 1).setNumberFormat('0.0"%"');
  sh.getRange(4, 7, values.length, 1).setNumberFormat("yyyy-MM-dd HH:mm");

  const formulas = [];
  for (let i = 0; i < values.length; i++) {
    const sheetRow = i + 4;
    formulas.push([studentProgressSparklineFormula_(sheetRow, barColor)]);
    sh.setRowHeight(sheetRow, 28);
  }
  sh.getRange(4, 6, formulas.length, 1).setFormulas(formulas);
  return rows.length;
}

function setupStudentProgressDashboard1A_(ss) {
  let sh = ss.getSheetByName(STUDENT_PROGRESS_DASHBOARD_1A);
  if (!sh) sh = ss.insertSheet(STUDENT_PROGRESS_DASHBOARD_1A);

  formatStudentProgressDashboardSheet_(
    sh,
    "서울대 1A 학생 진도현황",
    "현재교재가 SNU-1A이고 사용여부가 TRUE인 학생을 표시합니다. 진행률은 1A 1과 시작=0%, 8과 3/3=100% 기준이며 현재 과의 어휘·문법·종합 통과현황도 반영합니다. 이름 옆 진행그래프는 학생별 현재 진행률을 막대로 표시하며 개발자 계정은 제외됩니다."
  );
  sh.setTabColor("#4f81bd");
  return sh;
}

function setupStudentProgressDashboard1B2A_(ss) {
  let sh = ss.getSheetByName(STUDENT_PROGRESS_DASHBOARD_1B2A);
  if (!sh) sh = ss.insertSheet(STUDENT_PROGRESS_DASHBOARD_1B2A);

  formatStudentProgressDashboardSheet_(
    sh,
    "서울대 1B · 2A 학생 진도현황",
    "현재교재가 SNU-1B 또는 SNU-2A이고 사용여부가 TRUE인 학생을 한 시트에 표시합니다. 통합 진행률은 1B 9과 시작=0%, 2A 1과 시작≈47.1%, 2A 9과 3/3=100% 기준입니다. 이름 옆 진행그래프는 학생별 현재 진행률을 막대로 표시하며 개발자 계정은 제외됩니다."
  );
  sh.setTabColor("#70ad47");
  return sh;
}

// 현재 진도현황으로 표와 학생별 막대그래프를 함께 갱신한다.
function refreshStudentProgressDashboards_(ss) {
  const sh1 = ss.getSheetByName(STUDENT_PROGRESS_DASHBOARD_1A);
  const sh2 = ss.getSheetByName(STUDENT_PROGRESS_DASHBOARD_1B2A);
  if (!sh1 && !sh2) {
    ensureManagementSheetsAtFront_(ss);
    return { ok: true, skipped: true, reason: "dashboard_not_created" };
  }

  removeExcludedStudentProgressRows_(ss);
  const rows = collectStudentProgressDashboardRows_(ss);

  let oneACount = 0;
  let oneBTwoACount = 0;
  if (sh1) {
    removeStudentProgressDashboardCharts_(sh1);
    oneACount = writeStudentProgressDashboardRows_(sh1, rows.oneA, "#4f81bd");
  }
  if (sh2) {
    removeStudentProgressDashboardCharts_(sh2);
    oneBTwoACount = writeStudentProgressDashboardRows_(sh2, rows.oneBTwoA, "#70ad47");
  }

  // 로그인/시험으로 진도와 그래프가 갱신될 때마다 핵심 관리 시트 순서도 자동 복원한다.
  const sheetOrder = ensureManagementSheetsAtFront_(ss);

  return {
    ok: true,
    oneACount: oneACount,
    oneBTwoACount: oneBTwoACount,
    graphType: "sparkline_bar",
    sheetOrder: sheetOrder
  };
}

// Apps Script 편집기에서 실행한다.
// 기존 두 그래프 시트를 다시 구성하고 FIX1의 빈 차트를 제거한 뒤 학생별 막대그래프를 만든다.
function setupStudentProgressDashboards() {
  const ss = SpreadsheetApp.getActive();
  const progressSh = ss.getSheetByName(STUDENT_PROGRESS_SHEET_NAME);
  if (!progressSh) {
    throw new Error("'진도현황' 시트가 없습니다. 먼저 rebuildStudentProgressSummary()를 실행해 주세요.");
  }

  const excludedRemoved = removeExcludedStudentProgressRows_(ss);
  setupStudentProgressDashboard1A_(ss);
  setupStudentProgressDashboard1B2A_(ss);
  const refreshed = refreshStudentProgressDashboards_(ss);
  const sheetOrder = ensureManagementSheetsAtFront_(ss);

  return {
    ok: true,
    sourceSheet: STUDENT_PROGRESS_SHEET_NAME,
    dashboardSheets: [STUDENT_PROGRESS_DASHBOARD_1A, STUDENT_PROGRESS_DASHBOARD_1B2A],
    excludedRemoved: excludedRemoved,
    counts: refreshed,
    sheetOrder: sheetOrder
  };
}

function jsonpOutput_(callback, obj) {
  const cb = String(callback || "callback").replace(/[^\w$]/g, "") || "callback";
  return ContentService
    .createTextOutput(`${cb}(${JSON.stringify(obj)})`)
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

// STEP29-3: Sessions 전체 12개 열을 매 로그인마다 읽지 않고 A열의 sessionId만 찾는다.
function findSessionRowById_(sess, sessionId) {
  const target = String(sessionId || "").trim();
  if (!sess || !target || sess.getLastRow() < 2) return -1;
  try {
    const found = sess.getRange(2, 1, sess.getLastRow() - 1, 1)
      .createTextFinder(target)
      .matchEntireCell(true)
      .findNext();
    return found ? found.getRow() : -1;
  } catch (err) {
    console.error("Session id lookup failed", err);
    return -1;
  }
}

function sessionStartCacheKey_(sessionId) {
  return "session_started_" + String(sessionId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 180);
}

// STEP29-6: 새 프런트엔드는 세션 시작과 LOGIN 로그를 한 번의 GAS 요청으로 처리한다.
// 기존 session_start API는 그대로 남겨 이전 GitHub 페이지와도 호환된다.
const FAST_SESSION_START_ACTION = "session_start_fast";

function isSessionStartAction_(action) {
  const a = String(action || "").trim().toLowerCase();
  return a === "session_start" || a === FAST_SESSION_START_ACTION;
}

function makeGeneralLogRow_(ts, p, overrides) {
  overrides = overrides || {};
  function pick_(key, fallback) {
    return Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : fallback;
  }
  const extraObject = Object.prototype.hasOwnProperty.call(overrides, "extraObject")
    ? overrides.extraObject
    : p;
  return [
    ts,
    pick_("action", p.action || ""),
    pick_("name", p.name || ""),
    pick_("klass", p.klass || ""),
    pick_("token", p.token || ""),
    pick_("deviceId", p.deviceId || ""),
    pick_("book", p.book || ""),
    pick_("lesson", p.lesson || ""),
    pick_("score", p.score || ""),
    pick_("attempts", p.attempts || ""),
    pick_("ua", p.ua || ""),
    pick_("lang", p.lang || ""),
    JSON.stringify(extraObject || {})
  ];
}

function appendGeneralLogRows_(sh, rows) {
  if (!sh || !rows || rows.length === 0) return 0;
  const startRow = sh.getLastRow() + 1;
  sh.getRange(startRow, 1, rows.length, 13).setValues(rows);
  return rows.length;
}

function makeFastLoginLogRows_(ts, p) {
  const sessionExtra = Object.assign({}, p, { action: "session_start" });
  const loginExtra = {
    action: "log",
    token: p.token || "",
    deviceId: p.deviceId || "",
    klass: p.klass || "",
    name: p.name || "",
    book: "LOGIN",
    lesson: "index",
    score: 0,
    attempts: 0,
    ua: p.ua || "",
    lang: p.lang || ""
  };
  return [
    makeGeneralLogRow_(ts, p, {
      action: "session_start",
      book: "",
      lesson: "",
      score: "",
      attempts: "",
      extraObject: sessionExtra
    }),
    makeGeneralLogRow_(ts, p, {
      action: "log",
      book: "LOGIN",
      lesson: "index",
      // 기존 sendLoginLog도 p.score || "" 처리로 Log 시트에는 빈칸이 기록되었다.
      score: "",
      attempts: "",
      extraObject: loginExtra
    })
  ];
}

// ============================================================
// STEP30-1: 개발자용 콘텐츠 편집 기반
// - 문항/어휘 원본 파일은 그대로 두고 수정본만 Google Sheet에 저장한다.
// - 콘텐츠 편집 권한은 developerAccess와 분리해서 관리한다.
// - 이후 프런트엔드에서 이 API를 연결하면 코드/JSON을 직접 수정하지 않고도
//   문항별 수정 -> 저장 -> 즉시 영구 반영이 가능하다.
// ============================================================
const CONTENT_EDITOR_PERMISSION_SHEET_NAME = "콘텐츠편집권한";
const CONTENT_OVERRIDE_SHEET_NAME = "콘텐츠수정";
const CONTENT_OVERRIDE_HISTORY_SHEET_NAME = "콘텐츠수정이력";
const CONTENT_EDITOR_PERMISSION_HEADERS = [
  "phone", "name", "enabled", "role", "note", "updatedAt"
];
const CONTENT_OVERRIDE_HEADERS = [
  "key", "area", "book", "lesson", "section", "itemId",
  "payloadJson", "enabled", "updatedByPhone", "updatedByName", "updatedAt"
];
const CONTENT_OVERRIDE_HISTORY_HEADERS = [
  "ts", "key", "action", "area", "book", "lesson", "section", "itemId",
  "beforeJson", "afterJson", "editorPhone", "editorName"
];
const CONTENT_OVERRIDE_CACHE_TTL_SEC = 60 * 5;
const CONTENT_OVERRIDE_MAX_PAYLOAD_CHARS = 12000;

function ensureSheetWithHeaders_(ss, sheetName, headers) {
  const sh = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    const current = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    let changed = false;
    for (let i = 0; i < headers.length; i++) {
      if (String(current[i] == null ? "" : current[i]).trim() !== headers[i]) {
        current[i] = headers[i];
        changed = true;
      }
    }
    if (changed) sh.getRange(1, 1, 1, headers.length).setValues([current]);
  }
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, headers.length)
    .setFontWeight("bold")
    .setBackground("#1f4e78")
    .setFontColor("#ffffff")
    .setHorizontalAlignment("center");
  return sh;
}

function getContentEditorPermissionSheet_(ss) {
  const sh = ensureSheetWithHeaders_(
    ss,
    CONTENT_EDITOR_PERMISSION_SHEET_NAME,
    CONTENT_EDITOR_PERMISSION_HEADERS
  );
  sh.setColumnWidth(1, 110);
  sh.setColumnWidth(2, 120);
  sh.setColumnWidth(3, 80);
  sh.setColumnWidth(4, 100);
  sh.setColumnWidth(5, 220);
  sh.setColumnWidth(6, 150);
  return sh;
}

function getContentOverrideSheet_(ss) {
  const sh = ensureSheetWithHeaders_(ss, CONTENT_OVERRIDE_SHEET_NAME, CONTENT_OVERRIDE_HEADERS);
  sh.setColumnWidth(1, 300);
  sh.setColumnWidth(2, 110);
  sh.setColumnWidth(3, 100);
  sh.setColumnWidth(4, 70);
  sh.setColumnWidth(5, 110);
  sh.setColumnWidth(6, 100);
  sh.setColumnWidth(7, 500);
  sh.setColumnWidth(8, 80);
  sh.setColumnWidth(9, 110);
  sh.setColumnWidth(10, 120);
  sh.setColumnWidth(11, 150);
  return sh;
}

function getContentOverrideHistorySheet_(ss) {
  const sh = ensureSheetWithHeaders_(
    ss,
    CONTENT_OVERRIDE_HISTORY_SHEET_NAME,
    CONTENT_OVERRIDE_HISTORY_HEADERS
  );
  sh.setColumnWidth(1, 150);
  sh.setColumnWidth(2, 300);
  sh.setColumnWidth(3, 90);
  sh.setColumnWidth(9, 450);
  sh.setColumnWidth(10, 450);
  sh.setColumnWidth(11, 110);
  sh.setColumnWidth(12, 120);
  return sh;
}

function normalizeContentPart_(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeContentKeyPart_(value) {
  return normalizeContentPart_(value).replace(/\|/g, "／");
}

function makeContentOverrideKey_(area, book, lesson, section, itemId) {
  return [area, book, lesson, section, itemId]
    .map(normalizeContentKeyPart_)
    .join("|");
}

function contentOverrideCacheKey_(ss, area, book, lesson, section) {
  const ssId = String((ss && ss.getId && ss.getId()) || "default").slice(-16);
  const raw = [ssId, area, book, lesson, section].map(normalizeContentKeyPart_).join("|");
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw);
  const hex = digest.map(function(b) {
    const n = (b + 256) % 256;
    return ("0" + n.toString(16)).slice(-2);
  }).join("");
  return "content_override_scope_" + hex;
}

function invalidateContentOverrideCache_(ss, area, book, lesson, section) {
  try {
    CacheService.getScriptCache().remove(
      contentOverrideCacheKey_(ss, area, book, lesson, section)
    );
  } catch (err) {
    console.error("Content override cache invalidate failed", err);
  }
}

function isContentEditor_(ss, phone) {
  const targetPhone = normalizePhone_(phone);
  if (!targetPhone) return false;

  const sh = getContentEditorPermissionSheet_(ss);
  if (sh.getLastRow() < 2) return false;

  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  let allowed = false;
  for (let i = 0; i < rows.length; i++) {
    if (normalizePhone_(rows[i][0]) !== targetPhone) continue;
    allowed = isEnabled_(rows[i][2]);
  }
  return allowed === true;
}

// 최초 1회 실행용. 현재 학습시작점 시트에서 developerAccess=TRUE인 계정을
// 콘텐츠 편집 권한 시트로 복사한다. 복사 후에는 developerAccess를 FALSE로 바꾸어도
// 콘텐츠 편집 권한은 별도로 유지된다.
function seedContentEditorsFromDeveloperAccess_(ss) {
  const permissionSh = getContentEditorPermissionSheet_(ss);
  const startSh = ss.getSheetByName(LEARNING_START_SHEET_NAME);
  if (!startSh || startSh.getLastRow() < 2) return 0;

  const width = Math.max(8, startSh.getLastColumn());
  const rows = startSh.getRange(2, 1, startSh.getLastRow() - 1, width).getValues();
  const existing = {};
  if (permissionSh.getLastRow() >= 2) {
    const saved = permissionSh.getRange(2, 1, permissionSh.getLastRow() - 1, 3).getValues();
    saved.forEach(function(row) {
      const p = normalizePhone_(row[0]);
      if (p) existing[p] = true;
    });
  }

  const now = new Date();
  const appendRows = [];
  rows.forEach(function(row) {
    const phone = normalizePhone_(row[0]);
    const name = normalizeContentPart_(row[1]);
    const developerAccess = isEnabled_(row[7]);
    if (!phone || !developerAccess || existing[phone]) return;
    appendRows.push([phone, name, true, "editor", "developerAccess에서 최초 등록", now]);
    existing[phone] = true;
  });

  if (appendRows.length) {
    permissionSh.getRange(permissionSh.getLastRow() + 1, 1, appendRows.length, 6).setValues(appendRows);
  }
  return appendRows.length;
}

function setupContentEditorSystem() {
  const ss = SpreadsheetApp.getActive();
  getContentEditorPermissionSheet_(ss);
  getContentOverrideSheet_(ss);
  getContentOverrideHistorySheet_(ss);
  const seeded = seedContentEditorsFromDeveloperAccess_(ss);
  return {
    ok: true,
    seededEditors: seeded,
    sheets: [
      CONTENT_EDITOR_PERMISSION_SHEET_NAME,
      CONTENT_OVERRIDE_SHEET_NAME,
      CONTENT_OVERRIDE_HISTORY_SHEET_NAME
    ]
  };
}

function parseContentPayload_(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return { ok: false, error: "missing_payload" };
  if (text.length > CONTENT_OVERRIDE_MAX_PAYLOAD_CHARS) {
    return { ok: false, error: "payload_too_large" };
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "invalid_payload" };
    }
    return { ok: true, value: value, json: JSON.stringify(value) };
  } catch (err) {
    return { ok: false, error: "invalid_payload_json" };
  }
}

function getContentOverridesForScope_(ss, area, book, lesson, section) {
  area = normalizeContentPart_(area);
  book = normalizeContentPart_(book);
  lesson = normalizeContentPart_(lesson);
  section = normalizeContentPart_(section);
  if (!area || !book || !lesson || !section) return [];

  const cache = CacheService.getScriptCache();
  const cacheKey = contentOverrideCacheKey_(ss, area, book, lesson, section);
  try {
    const rawCached = cache.get(cacheKey);
    if (rawCached) return JSON.parse(rawCached);
  } catch (err) {}

  const sh = getContentOverrideSheet_(ss);
  if (sh.getLastRow() < 2) return [];

  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, CONTENT_OVERRIDE_HEADERS.length).getValues();
  const out = [];
  rows.forEach(function(row) {
    if (!isEnabled_(row[7])) return;
    if (normalizeContentPart_(row[1]) !== area) return;
    if (normalizeContentPart_(row[2]) !== book) return;
    if (normalizeContentPart_(row[3]) !== lesson) return;
    if (normalizeContentPart_(row[4]) !== section) return;

    let payload = null;
    try { payload = JSON.parse(String(row[6] || "{}")); } catch (err) { return; }
    out.push({
      key: String(row[0] || ""),
      itemId: String(row[5] || ""),
      payload: payload,
      updatedAt: row[10] instanceof Date ? row[10].toISOString() : String(row[10] || "")
    });
  });

  try { cache.put(cacheKey, JSON.stringify(out), CONTENT_OVERRIDE_CACHE_TTL_SEC); } catch (err) {}
  return out;
}

function saveContentOverride_(ss, identity, params) {
  const phone = normalizePhone_(identity && identity.phone);
  const editorName = normalizeContentPart_(identity && identity.studentName);
  if (!isContentEditor_(ss, phone)) return { ok: false, error: "editor_forbidden" };

  const area = normalizeContentPart_(params.area);
  const book = normalizeContentPart_(params.book);
  const lesson = normalizeContentPart_(params.lesson);
  const section = normalizeContentPart_(params.section);
  const itemId = normalizeContentPart_(params.itemId);
  if (!area || !book || !lesson || !section || !itemId) {
    return { ok: false, error: "missing_content_key" };
  }

  const parsed = parseContentPayload_(params.payload);
  if (!parsed.ok) return parsed;

  const key = makeContentOverrideKey_(area, book, lesson, section, itemId);
  const sh = getContentOverrideSheet_(ss);
  const historySh = getContentOverrideHistorySheet_(ss);
  const now = new Date();
  let rowIndex = -1;
  let beforeJson = "";

  if (sh.getLastRow() >= 2) {
    const finder = sh.getRange(2, 1, sh.getLastRow() - 1, 1)
      .createTextFinder(key)
      .matchEntireCell(true)
      .findNext();
    if (finder) {
      rowIndex = finder.getRow();
      beforeJson = String(sh.getRange(rowIndex, 7).getValue() || "");
    }
  }

  const row = [
    key, area, book, lesson, section, itemId,
    parsed.json, true, phone, editorName, now
  ];

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    if (rowIndex > 0) {
      sh.getRange(rowIndex, 1, 1, CONTENT_OVERRIDE_HEADERS.length).setValues([row]);
    } else {
      rowIndex = sh.getLastRow() + 1;
      sh.getRange(rowIndex, 1, 1, CONTENT_OVERRIDE_HEADERS.length).setValues([row]);
    }

    historySh.appendRow([
      now, key, beforeJson ? "UPDATE" : "CREATE", area, book, lesson, section, itemId,
      beforeJson, parsed.json, phone, editorName
    ]);
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }

  invalidateContentOverrideCache_(ss, area, book, lesson, section);
  return {
    ok: true,
    key: key,
    area: area,
    book: book,
    lesson: lesson,
    section: section,
    itemId: itemId,
    payload: parsed.value,
    updatedAt: now.toISOString()
  };
}

function disableContentOverride_(ss, identity, params) {
  const phone = normalizePhone_(identity && identity.phone);
  const editorName = normalizeContentPart_(identity && identity.studentName);
  if (!isContentEditor_(ss, phone)) return { ok: false, error: "editor_forbidden" };

  const area = normalizeContentPart_(params.area);
  const book = normalizeContentPart_(params.book);
  const lesson = normalizeContentPart_(params.lesson);
  const section = normalizeContentPart_(params.section);
  const itemId = normalizeContentPart_(params.itemId);
  if (!area || !book || !lesson || !section || !itemId) {
    return { ok: false, error: "missing_content_key" };
  }

  const key = makeContentOverrideKey_(area, book, lesson, section, itemId);
  const sh = getContentOverrideSheet_(ss);
  if (sh.getLastRow() < 2) return { ok: true, restored: true, found: false };

  const finder = sh.getRange(2, 1, sh.getLastRow() - 1, 1)
    .createTextFinder(key)
    .matchEntireCell(true)
    .findNext();
  if (!finder) return { ok: true, restored: true, found: false };

  const rowIndex = finder.getRow();
  const beforeJson = String(sh.getRange(rowIndex, 7).getValue() || "");
  const now = new Date();
  sh.getRange(rowIndex, 8, 1, 4).setValues([[false, phone, editorName, now]]);
  getContentOverrideHistorySheet_(ss).appendRow([
    now, key, "RESTORE_ORIGINAL", area, book, lesson, section, itemId,
    beforeJson, "", phone, editorName
  ]);
  invalidateContentOverrideCache_(ss, area, book, lesson, section);
  return { ok: true, restored: true, found: true, key: key };
}



// STEP31-7: 워크북 복습 평가는 기존 TestResults/진도현황과 완전히 분리해 저장한다.
const WORKBOOK_EVAL_HEADERS = [
  "제출시각","응시ID","전화번호","학생이름","반","교재","복습","평가영역",
  "점수(100)","정답수","전체문항","미응답","응시시간(초)","시간초과","답안JSON","userAgent"
];

function getWorkbookEvaluationSheet_(ss) {
  let sh = ss.getSheetByName(WORKBOOK_EVAL_RESULTS_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(WORKBOOK_EVAL_RESULTS_SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, WORKBOOK_EVAL_HEADERS.length).setValues([WORKBOOK_EVAL_HEADERS]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, WORKBOOK_EVAL_HEADERS.length)
      .setFontWeight("bold")
      .setHorizontalAlignment("center");
  }
  // STEP31-8: 결과 시트를 사용자가 옮겨도 다시 관리 시트 앞쪽으로 복원한다.
  ensureManagementSheetsAtFront_(ss);
  return sh;
}

function setupWorkbookEvaluationSystem() {
  const ss = SpreadsheetApp.getActive();
  const sh = getWorkbookEvaluationSheet_(ss);
  return { ok: true, sheet: sh.getName() };
}

function saveWorkbookEvaluationResult_(ss, identity, p) {
  const phone = normalizePhone_(identity && identity.phone);
  const studentName = String((identity && identity.studentName) || p.name || "").trim();
  const attemptId = String(p.attemptId || "").trim().slice(0, 120);
  const book = String(p.book || "").trim().slice(0, 40);
  const review = String(p.review || "").trim().slice(0, 80);
  const evalType = String(p.evalType || "").trim().slice(0, 60);
  const klass = String(p.klass || "").trim().slice(0, 80);
  const score = Number(p.score);
  const correct = Number(p.correct);
  const total = Number(p.total);
  const unanswered = Number(p.unanswered);
  const elapsedSec = Number(p.elapsedSec);
  const timedOut = String(p.timedOut || "").trim().toUpperCase() === "TRUE";
  const answersJson = String(p.answers || "").slice(0, 20000);
  const ua = String(p.ua || "").slice(0, 500);

  if (!phone || !studentName) return { ok: false, error: "missing_identity" };
  if (!attemptId || !book || !review || !evalType) return { ok: false, error: "missing_workbook_fields" };
  if (!Number.isFinite(total) || total <= 0) return { ok: false, error: "invalid_total" };
  if (!Number.isFinite(score) || score < 0 || score > 100) return { ok: false, error: "invalid_score" };

  const sh = getWorkbookEvaluationSheet_(ss);
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    if (sh.getLastRow() >= 2) {
      const found = sh.getRange(2, 2, sh.getLastRow() - 1, 1)
        .createTextFinder(attemptId)
        .matchEntireCell(true)
        .findNext();
      if (found) {
        return { ok: true, saved: true, duplicate: true, row: found.getRow(), sheet: sh.getName() };
      }
    }

    const row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, WORKBOOK_EVAL_HEADERS.length).setValues([[
      new Date(), attemptId, phone, studentName, klass, book, review, evalType,
      Math.round(score), Number.isFinite(correct) ? correct : "", total,
      Number.isFinite(unanswered) ? unanswered : "",
      Number.isFinite(elapsedSec) ? Math.max(0, Math.round(elapsedSec)) : "",
      timedOut, answersJson, ua
    ]]);
    return { ok: true, saved: true, duplicate: false, row: row, sheet: sh.getName() };
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
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

    // STEP29-1: 인증 요청은 전화번호 확인 + 토큰 발급까지만 처리한다.
    // 기존에는 여기서 전체 TestResults를 다시 읽고 진도현황/그래프까지 갱신한 뒤,
    // 곧바로 이어지는 session_start에서도 같은 진도 갱신을 다시 실행했다.
    // 로그인 체감 속도와 동시 접속 부하를 줄이기 위해 진도 갱신은 session_start 한 번으로만 수행한다.
    const token = issueAuthToken_(phone, name, deviceId);
    return jsonpOutput_(callback, {
      ok: true,
      token: token,
      registeredName: auth.studentName || "",
      progressSummary: null,
      progressDeferred: true
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


  // STEP29-2: 서울대 한 교재의 전체 과 진도 + 시작점 + 개발자 권한을 한 번에 조회한다.
  // snu/index.html의 교재 선택 화면 전용이며 기존 mastery_status/learning_start API는 호환성을 위해 유지한다.
  if (action === "snu_book_status") {
    const result = validateAuthToken_(ss, p.token, p.deviceId, p.name);
    if (!result.ok) return jsonpOutput_(callback, result);

    const phone = result.phone || (result.payload && result.payload.phone) || "";
    const snapshot = getSnuBookStatusSnapshot_(ss, phone, p.book || "");
    if (!snapshot.ok) return jsonpOutput_(callback, snapshot);

    snapshot.phone = normalizePhone_(phone);
    snapshot.name = result.studentName || (result.payload && result.payload.name) || "";
    return jsonpOutput_(callback, snapshot);
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

  // STEP30-1: 콘텐츠 편집 권한 확인. developerAccess와 별도 권한이다.
  if (action === "content_editor_status") {
    const result = validateAuthToken_(ss, p.token, p.deviceId, p.name);
    if (!result.ok) return jsonpOutput_(callback, result);
    const phone = result.phone || (result.payload && result.payload.phone) || "";
    return jsonpOutput_(callback, {
      ok: true,
      canEdit: isContentEditor_(ss, phone),
      phone: normalizePhone_(phone),
      name: result.studentName || (result.payload && result.payload.name) || ""
    });
  }

  // STEP30-1: 학생/개발자 모두 읽을 수 있는 수정본 조회.
  // 실제 화면에서는 원본 JSON을 먼저 읽고 이 응답을 해당 itemId에 덮어 적용한다.
  if (action === "content_overrides") {
    const result = validateAuthToken_(ss, p.token, p.deviceId, p.name);
    if (!result.ok) return jsonpOutput_(callback, result);
    const phone = result.phone || (result.payload && result.payload.phone) || "";
    const items = getContentOverridesForScope_(
      ss, p.area || "", p.book || "", p.lesson || "", p.section || ""
    );
    return jsonpOutput_(callback, {
      ok: true,
      area: normalizeContentPart_(p.area),
      book: normalizeContentPart_(p.book),
      lesson: normalizeContentPart_(p.lesson),
      section: normalizeContentPart_(p.section),
      items: items,
      // STEP30-2: 수정본 조회와 편집 권한 확인을 한 요청으로 처리한다.
      // 학생은 수정본만 적용되고, 콘텐츠편집권한=TRUE인 계정만 편집 UI가 열린다.
      canEdit: isContentEditor_(ss, phone),
      editorName: result.studentName || (result.payload && result.payload.name) || ""
    });
  }

  // STEP30-1: 콘텐츠 편집 권한이 있는 계정만 수정본을 영구 저장할 수 있다.
  if (action === "content_override_save") {
    const result = validateAuthToken_(ss, p.token, p.deviceId, p.name);
    if (!result.ok) return jsonpOutput_(callback, result);
    const identity = {
      phone: result.phone || (result.payload && result.payload.phone) || "",
      studentName: result.studentName || (result.payload && result.payload.name) || ""
    };
    return jsonpOutput_(callback, saveContentOverride_(ss, identity, p));
  }

  // STEP30-1: 수정본을 비활성화해 원본 JSON으로 복원한다.
  if (action === "content_override_restore") {
    const result = validateAuthToken_(ss, p.token, p.deviceId, p.name);
    if (!result.ok) return jsonpOutput_(callback, result);
    const identity = {
      phone: result.phone || (result.payload && result.payload.phone) || "",
      studentName: result.studentName || (result.payload && result.payload.name) || ""
    };
    return jsonpOutput_(callback, disableContentOverride_(ss, identity, p));
  }

  // STEP31-7: 워크북 평가 결과 저장. 기존 TestResults/진도현황에는 쓰지 않는다.
  if (action === "workbook_eval_submit") {
    const result = validateAuthToken_(ss, p.token, p.deviceId, p.name);
    if (!result.ok) return jsonpOutput_(callback, result);
    const identity = {
      phone: result.phone || (result.payload && result.payload.phone) || "",
      studentName: result.studentName || (result.payload && result.payload.name) || ""
    };
    return jsonpOutput_(callback, saveWorkbookEvaluationResult_(ss, identity, p));
  }

  // 7) 인증이 필요한 기록 요청 보호
  const isSessionStart = isSessionStartAction_(action);
  const isFastSessionStart = action === FAST_SESSION_START_ACTION;
  if (action === "log" || isSessionStart) {
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
    sh.getRange(1, 1, 1, 13).setValues([[
      "ts","action","name","klass","token","deviceId","book","lesson",
      "score","attempts","ua","lang","extra"
    ]]);
  }

  if (sess.getLastRow() === 0) {
    sess.getRange(1, 1, 1, 12).setValues([[
      "sessionId","name","klass","token","deviceId","lang",
      "loginAt","logoutAt","durationSec","reason","ua","updatedAt"
    ]]);
  }

  const ts = new Date();
  const sessionId = String(p.sessionId || "");
  let sessionStartWasNew = null;

  if ((isSessionStart || action === "session_end") && sessionId) {
    const lock = LockService.getScriptLock();
    lock.tryLock(5000);
    try {
      if (isSessionStart) {
        const cache = CacheService.getScriptCache();
        const cacheKey = sessionStartCacheKey_(sessionId);
        const recentlyStarted = cacheKey ? cache.get(cacheKey) : null;

        // 재시도 요청이면 같은 세션/로그/진도 갱신을 중복 처리하지 않는다.
        // 캐시가 비어 있어도 A열만 TextFinder로 확인하므로 Sessions 전체 12열을 읽지 않는다.
        if (!recentlyStarted) {
          const rowIndex = findSessionRowById_(sess, sessionId);
          if (rowIndex === -1) {
            const loginAt = p.loginAt ? new Date(p.loginAt) : ts;
            const targetRow = sess.getLastRow() + 1;
            sess.getRange(targetRow, 1, 1, 12).setValues([[
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
            ]]);
            sessionStartWasNew = true;
          } else {
            sessionStartWasNew = false;
          }
          if (cacheKey) cache.put(cacheKey, "1", 21600); // 6시간
        } else {
          sessionStartWasNew = false;
        }
      }

      if (action === "session_end") {
        const rowIndex = findSessionRowById_(sess, sessionId);
        const loginAt = p.loginAt ? new Date(p.loginAt) : ts;
        const logoutAt = p.logoutAt ? new Date(p.logoutAt) : ts;
        const durSec = Math.max(0, Math.round((logoutAt.getTime() - loginAt.getTime()) / 1000));
        const reason = String(p.reason || "logout");

        if (rowIndex === -1) {
          const targetRow = sess.getLastRow() + 1;
          sess.getRange(targetRow, 1, 1, 12).setValues([[
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
          ]]);
        } else {
          // 11개 셀을 하나씩 쓰지 않고 B:L을 한 번에 갱신한다.
          sess.getRange(rowIndex, 2, 1, 11).setValues([[
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
          ]]);
        }
      }
    } finally {
      try { lock.releaseLock(); } catch (err) {}
    }
  }

  let progressSummary = null;
  if (isSessionStart && verifiedIdentity && sessionStartWasNew !== false) {
    try {
      progressSummary = updateStudentProgressLoginOnly_(
        ss,
        verifiedIdentity,
        { ts: ts, klass: String(p.klass || ""), isLogin: true }
      );

      // 극히 드문 동시 수정으로 행을 다시 찾지 못한 경우에만 전체 계산으로 복구한다.
      if (progressSummary && progressSummary.fallbackRequired) {
        progressSummary = updateStudentProgressSummary_(
          ss,
          verifiedIdentity,
          { ts: ts, klass: String(p.klass || ""), isLogin: true }
        );
      }
    } catch (err) {
      console.error("Progress summary lightweight session update failed", err);
    }
  }

  // STEP29-6: 새 로그인 경로는 session_start + LOGIN 두 로그를 한 번의 setValues로 기록한다.
  // 같은 sessionId 재시도는 Sessions뿐 아니라 Log/진도 갱신도 중복 저장하지 않는다.
  let logRowsWritten = 0;
  if (isFastSessionStart) {
    if (sessionStartWasNew !== false) {
      logRowsWritten = appendGeneralLogRows_(sh, makeFastLoginLogRows_(ts, p));
    }
  } else if (!(action === "session_start" && sessionStartWasNew === false)) {
    logRowsWritten = appendGeneralLogRows_(sh, [makeGeneralLogRow_(ts, p)]);
  }

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
    progressSummary: progressSummary,
    logRowsWritten: logRowsWritten,
    fastSessionStart: isFastSessionStart
  });
}
