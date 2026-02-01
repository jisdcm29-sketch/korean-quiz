# K-Quiz Grammar Project Notes (문법)

## 0) 한 줄 요약
- 이 프로젝트는 GitHub Pages에서 동작하는 정적 HTML 기반 퀴즈(단어/문법)이며,
- URL 파라미터 name/klass/token을 유지하고,
- iPhone/Android 안정성을 위해 외부 통신은 JSONP로만 처리한다.

---

## 1) 핵심 규칙(절대 변경 금지)
1. 구조: 정적 단일 HTML 파일 기반 (GitHub Pages)
2. 흐름/파라미터: index.html → (선택) → 허브 → 레슨
   - URL 파라미터: name / klass / token (항상 그대로 전달)
   - 레슨에서 이름 다시 묻지 않음
3. 통신: JSONP(스크립트 태그 + callback)만 사용
4. 합격/채점/시도:
   - 100점 만점
   - 80점 이상: “Тэнцлээ!”
   - 80점 미만: Review(틀린 문제 → 정답 목록) 먼저
   - 5회 이상 실패 시 점수와 무관하게 합격 처리
   - 결과 화면: 이름/반/점수/시도/날짜 + “스크린샷해서 선생님께 보내라” 몽골어 강조
   - 결과 화면 “Капчер” 버튼: navigator.share 시도 → 안 되면 스크린샷 안내
5. 기록(로그): Google Apps Script 웹앱을 통해 validate / log / issue 흐름 유지
   - token, deviceId, book, lesson, score, attempts, ua 포함

---

## 2) Apps Script 정보
- SCRIPT_URL:
  https://script.google.com/macros/s/AKfycbwBe6Y0W3IJKjWV8MLFnR5b9OMePDPHGVACPekJQpvLWRrlayRmHBJCezamKqN9rZg6/exec

- validate (JSONP):
  action=validate&token=...&deviceId=...&klass=...&name=...

- log (JSONP):
  action=log&token=...&deviceId=...&book=...&lesson=...&score=...&attempts=...&ua=...

---

## 3) 폴더/파일 구조(권장)
/
  index.html                     (로그인/선택)
  lessonHub.html                 (단어 허브)
  grammar/
    index.html                   (문법 메인 허브)
    GRAM-SNU-hub.html            (SNU 레벨 선택 1A~4B)
    GRAM-TOPIK-hub.html          (TOPIK 레벨 선택 TOPIK1/2)
    GRAM-SNU-1A-hub.html         (레슨 목록)
    GRAM-SNU-1A-lesson01.html    (레슨 파일)
    PROJECT-NOTES.md             (이 문서)

---

## 4) 파일명 규칙
- 단어(기존 유지): SNU-1B-lesson13.html 등
- 문법(계층 허브):
  - GRAM-SNU-hub.html
  - GRAM-SNU-[레벨]-hub.html        (예: GRAM-SNU-1A-hub.html)
  - GRAM-SNU-[레벨]-lessonXX.html   (예: GRAM-SNU-1A-lesson01.html)
  - GRAM-TOPIK-[레벨]-hub.html      (예: GRAM-TOPIK-2-hub.html)
  - GRAM-TOPIK-[레벨]-lessonXX.html (예: GRAM-TOPIK-2-lesson01.html)

---

## 5) 레슨을 추가하는 표준 절차(체크리스트)
[ ] (1) 레슨 파일 복사로 새 파일 만들기 (lesson02 등)
[ ] (2) lessonId 변경: "GRAM-...-lesson02"
[ ] (3) 표시 제목/배지/타이틀에서 lesson 번호 수정
[ ] (4) rawQ(문항 데이터) 교체
[ ] (5) 허브(레슨 목록)에서 버튼/링크 1개 추가
[ ] (6) GitHub Pages에서 실제 클릭 테스트
[ ] (7) 합격 시 기록이 시트에 들어오는지 확인

---

## 6) 문법 문항 데이터 형식(예시)
- rawQ 항목 구조:
  { q:"문제", a:"정답", c:["오답1","오답2","오답3"] }
- choices는 항상 4개(정답 1 + 오답 3)

---

## 7) 현재 상태(업데이트)
- 문법 허브/레슨 목록 생성됨
- 문법 레슨 수행 후 Google Sheet에 기록됨
- 다음 작업: SNU 1B/2A/… 허브 복제 및 레슨 확장
