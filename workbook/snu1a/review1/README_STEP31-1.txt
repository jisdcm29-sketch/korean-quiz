STEP31-1 - SNU 1A Workbook 복습 1 (1-2과) 평가하기

목적
- 기존 어플에 영향을 주지 않는 독립 시험판입니다.
- 기존 index.html, snu/, grammar/, GAS 파일은 수정하지 않습니다.
- 새 폴더 workbook/snu1a/review1/ 만 추가합니다.

시험 구성
- 20문항
- 제한시간 15분
- 문항당 1점, 총 20점
- 답 선택 후 자동 다음 이동 없음
- 이전/다음/문항목록 이동 가능
- 시간 종료 시 자동 제출
- 제출 후 점수 및 정답/오답 확인
- 새로고침 시 진행상태를 같은 기기의 localStorage에서 복원

로컬 테스트
1) C:\korean-quiz-main\workbook\snu1a\review1 폴더가 생기도록 복사
2) PowerShell:
   cd C:\korean-quiz-main
   py -m http.server 8000
3) 브라우저:
   http://localhost:8000/workbook/snu1a/review1/

현재 의도적으로 하지 않은 것
- 기존 어플 메뉴에 링크 추가하지 않음
- Google Apps Script 수정하지 않음
- Google Sheet 결과 저장하지 않음
- 기존 학생 진도/점수/인증에 연결하지 않음

다음 단계(승인 후)
- 이 독립 시험판을 먼저 검토한 뒤,
- 결과 저장용 별도 시트/별도 GAS action을 추가하고,
- 마지막에 기존 어플 메뉴에는 독립 링크만 추가하는 방식으로 연결 가능.
