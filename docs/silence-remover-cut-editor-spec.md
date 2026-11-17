# Silence Remover 컷 편집 · 미리보기 재생 · MP4 내보내기 설계서

- 작성일: 2026-11-17
- 대상: `web-ui/tools/silence-remover/` (프런트), `agent/routers/silence_remover.py` + `agent/engines/silence_remover_render.py` (에이전트)
- 원칙: **AutoSubtitle 코드는 수정·import 하지 않는다.** 필요한 아이디어(오디오 마스터 클럭 재생, 클립별 프레임 수 고정 렌더 그래프, 인코더 폴백)는 참고만 하고 이 도구 전용으로 새로 작성한다. 기존 분석·XML 내보내기 흐름은 동작을 바꾸지 않는다.

## 1. 목표

1. 분석된 무음 구간을 **건너뛰며 재생**해서 실제 결과를 미리 확인한다 (영상 + 소리).
2. 파형에서 컷 구간을 **편집**한다: 경계 이동, 구간 삭제(복원), 새 컷 추가, 실행 취소/다시 실행.
3. 편집 결과대로 원본을 **재인코딩해 MP4(H.264 + AAC)** 로 저장한다. 프레임 레이트는 사용자가 고른 편집 FPS(분수형)로 CFR 정규화한다.

범위 밖: 속도 변경, 전환 효과, 자막, 다중 트랙, XML 에 편집 내용 반영(XML 은 지금처럼 분석 결과 기준).

## 2. 용어

| 용어 | 뜻 |
|---|---|
| 컷(cut) | 결과물에서 빠지는 구간 `[start, end)` (초). 분석 직후에는 XML 과 같은 무음 구간 |
| 유지 구간(keep) | 컷의 여집합. 렌더러가 이어 붙이는 구간 |
| 편집 FPS | `#opt-fps` 값. 분수형은 분석 응답 `fps_rational` (예 `30000/1001`) |
| 프레임 격자 | 모든 경계는 `k / fps` (정수 k) 에만 놓인다 |

## 3. 데이터 모델 (프런트, `cut-editor.js`)

```js
state = {
  mediaPath,          // 현재 영상 경로
  fps: { num, den },  // 분석 응답 fps_rational (없으면 편집 FPS 를 분수화)
  totalFrames,        // round(durationSec * fps)
  baseKey,            // 분석 스냅숏 지문 (경로 + 설정 + 분석 무음 목록)
  baseCuts,           // 분석 결과 컷 (프레임 정수 [a, b))
  cuts,               // 편집 중 컷 (정렬, 겹침 없음, 길이 ≥ 1프레임)
  undo: [], redo: [], // cuts 스냅숏 스택 (최대 100)
  selected,           // 선택된 컷 index 또는 -1
}
```

- 내부 표현은 **프레임 정수**. 초 변환은 `frame * den / num`. 부동소수 누적 오차가 없다.
- 기준 컷은 `script.js` 의 `getAnalyzedSilenceTimeSegmentsForDraw()` (XML 과 같은 프레임 반올림) 결과를 프레임으로 바꾼 것.
- **활성 조건**: 분석이 끝났고, 분석 설정이 현재 UI 설정과 같을 때만(=기존 코드가 분석 결과 오버레이를 그리는 조건) 편집이 활성화된다.
  - 설정을 바꿔 분석 결과가 무효가 되면 편집기는 비활성(편집 내용은 보존) → 기존처럼 미리보기 오버레이가 보이고, 재생 건너뛰기는 그 미리보기 구간을 따른다. 내보내기는 "다시 분석" 안내와 함께 비활성.
  - 같은 `baseKey` 로 돌아오면(설정을 되돌림) 편집 내용이 그대로 복원된다.
  - 새 분석으로 `baseKey` 가 바뀌면 편집 내용을 버리고 새 기준으로 시작한다. 편집 내용이 있으면 분석 직전에 `confirm()` 으로 묻는다.
- 편집 내용은 `sessionStorage["silenceRemover.cutEdits"] = { baseKey, cuts }` 에 저장해 다운로드 페이지 왕복·새로고침 후 복원한다.

## 4. 파형 상호작용

기존: 드래그 = 가로 팬, 휠 = 줌, 더블클릭 = 100%. 이 동작은 유지하고 아래를 추가한다 (편집기 활성일 때만, 재생 헤드/클릭 탐색은 파형만 있어도 동작).

| 입력 | 동작 |
|---|---|
| 클릭(이동 없음), 컷 바깥 | 재생 위치 이동 + 선택 해제 |
| 클릭, 컷 안 | 컷 선택 (노란 테두리) + 재생 위치 이동 |
| 컷 경계 ±6px 위에서 드래그 | 경계 이동 (프레임 스냅, 이웃 컷과 1프레임 이상 간격 유지). 길이 0 이 되면 놓을 때 삭제 |
| Shift + 드래그 (유지 구간) | 새 컷 생성 (프레임 스냅, 기존 컷과 겹치면 병합) |
| 그 외 드래그 | 기존 팬 |
| Space | 재생/일시정지 |
| Delete / Backspace | 선택 컷 삭제(=그 구간 유지로 복원) |
| Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y | 실행 취소 / 다시 실행 |
| ← / → | 일시정지 중 1프레임 이동 (Shift = 1초) |

입력란(`input`, `textarea`, `select`)에 포커스가 있으면 키보드 단축키는 무시한다. 경계 근처에서는 커서를 `ew-resize` 로 바꾼다.

그리기: 기존 `drawSilenceWaveform` 에 편집된 컷을 `silenceTimeSegments` 로 넘기고, 그린 뒤 같은 캔버스에 선택 테두리·재생 헤드(하늘색 세로선)를 덧그린다. 재생 중에는 rAF 로 다시 그리며, 재생 헤드가 화면 오른쪽 끝을 넘으면 화면이 따라간다.

## 5. 미리보기 재생 엔진

AutoSubtitle 의 구조(오디오 = 기준 시계, 영상 = 따라오기)를 이 도구 크기에 맞게 단순화해 새로 작성한다.

- 요소: 숨겨진 `<audio>` (기준 시계) + 보이는 `<video muted>`. 둘 다 `GET /media?video_path=…` 를 직접 src 로 쓴다 (Range 지원).
- rAF 루프 (재생 중):
  1. `t = audio.currentTime`.
  2. 건너뛰기 켜짐이고 `t` 가 컷 `[a, b)` 안이면 `audio.currentTime = b` (마지막 컷이 끝까지면 일시정지).
  3. 영상 동기: `|video.currentTime - t| > 0.15s` 이고 `video.seeking` 이 아니면 `video.currentTime = t`. 영상이 멈춰 있으면 `play()`.
  4. 오디오가 버퍼링 중(`readyState < HAVE_FUTURE_DATA`)이면 영상을 잠시 멈춘다.
  5. 재생 헤드 다시 그리기.
- 컷 탐색은 정렬 배열 이진 탐색(프레임마다 O(log K)).
- 탭이 보이면 rAF, 숨겨지면(rAF 정지) 15 ms 타이머로 루프를 돌린다. 소리가 나는 탭은 백그라운드 타이머 제한을 받지 않아 다른 탭에서도 건너뛰기가 계속된다.
- 29.97(`2997/100`) · 23.976 · 59.94 처럼 NTSC 에 가까운 FPS 는 프런트·에이전트 모두 `×1000/1001` 분수로 맞춘다.
- 영상이 디코드 불가(`MEDIA_ERR_SRC_NOT_SUPPORTED`)면 영상 칸에 안내를 띄우고 오디오만 재생한다. 오디오 파일 입력도 같은 경로(영상 칸 숨김).
- 시간 표시: `원본 위치 / 결과 위치` (결과 위치 = 원본 위치 − 앞쪽 컷 길이 합).

## 6. 내보내기 UI

미리보기 패널(재생 줄 오른쪽)의 "MP4로 내보내기" 버튼 → 모달:
- 화질: 고화질 / 표준(기본) / 빠르게
- 저장 위치: 원본 폴더 `<이름>_cut.mp4` (같은 이름이 있으면 ` (2)` …). 드래그 업로드된 임시 파일이면 사용자 "다운로드" 폴더.
- 진행 중: 진행률 바, 사용 인코더 이름, 취소 버튼. 완료: 저장 경로, "폴더에서 보기" 버튼.
- 내보내기 중에는 `setAgentLongOperationActive(true)` 로 연결 모니터가 에이전트를 재시작하지 않게 한다.

## 7. 에이전트 API (`/api/tools/silence-remover`)

### `GET /media?video_path=…`
원본 미디어 파일 스트리밍(`FileResponse`, Range 지원 — Starlette 1.3). 허용 확장자(업로드 허용 목록과 동일)의 실제 파일만.

### `POST /render/start`
```json
{ "video_path": "...", "fps_rational": "30000/1001",
  "keeps": [{"start_frame": 0, "end_frame": 120}, ...],
  "quality": "high" | "standard" | "fast" }
```
응답: `{ job_id, output_path, expected_sec, encoder_name, has_video, has_audio }`. 이미 실행 중인 작업이 있으면 409.

### `GET /render/status?job_id=…`
`{ state: "running"|"done"|"error"|"canceled", percent, label, encoder_name, error, output_path }`

### `POST /render/cancel` `{ job_id }`
### `POST /render/reveal` `{ path }` — 이 세션에서 내보낸 파일만 탐색기에서 선택 표시.

## 8. 렌더 엔진 (`agent/engines/silence_remover_render.py`, 신규)

### 8.1 소스 정보
`ffprobe -show_streams -show_format -of json` → 영상/오디오 유무, 영상 시작 시각(origin), 길이, 크기. origin 은 영상 스트림 `start_time` (없으면 format, 오디오 전용이면 오디오 스트림).

### 8.2 유지 구간 검증
- 프레임 정수, 정렬, 겹침 없음, 각 길이 ≥ 1, `end_frame ≤ 사용 가능 프레임 수` (초과분은 잘라냄), 1개 이상.
- 기대 길이 = Σ(b − a) / fps.

### 8.3 영상 필터 (컷 수와 무관하게 필터 1개)
```
[0:v:0]setpts=PTS-ORIGIN/TB,fps=fps=N/D:start_time=0,
       scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,
       select='if(lt(n,A_mid),<왼쪽>,<오른쪽>)',setpts=N/(N/D)/TB,format=yuv420p[vout]
```
- `fps` 필터로 먼저 CFR 로 만든 뒤 프레임 번호 `n` 으로 고른다 → 결과 프레임 수가 정확히 Σ(b − a). (VFR 원본 대응)
- `select` 수식은 유지 구간에 대한 **이진 탐색 트리**다. `if` 는 고른 쪽만 계산하므로 프레임당 O(log K), 중첩 깊이도 log K.
- 처음 설계(컷마다 `split` → `trim` → `concat`)는 실측에서 버렸다: libavfilter 스케줄러가 매 단계 모든 필터를 훑어서 컷 600개에서 67초, 1500개에서는 5분이 지나도 40% 였다. 긴 `+` 사슬 수식은 ffmpeg 수식 파서 깊이 제한으로 ~100항에서 실패했다.
- 실측(10분 720p, NVENC): 컷 600개 21초 · 1500개 18초 · 3000개 15초. 프레임 수·영상/오디오 길이 일치.
- 필터 문자열은 임시 파일에 쓰고 `common.ffmpeg_filter.filter_complex_argv` 로 넘긴다 (명령줄 길이 제한 회피).

### 8.3a 오디오 (Python 에서 샘플 단위로 자르기)
- `ffmpeg … -af asetpts=PTS-ORIGIN/TB,aresample=48000:async=1:first_pts=0 -f s16le -` 로 PCM 을 한 번 읽으며
  유지 구간만 임시 WAV 에 쓴다. 필요한 만큼 읽으면 디코더를 끝낸다.
- `S_i = round(a_i·48000/fps)`, 길이 `L_i = round(P_{i+1}·48000/fps) − round(P_i·48000/fps)` (P = 결과 타임라인 누적 프레임) → 누적 오차 0.
- 접합부마다 4 ms 페이드 인/아웃(192 샘플)으로 "틱" 소리를 막는다. 스트림이 짧으면 무음으로 채운다.
- 인코딩 단계는 영상(원본) + 오디오(WAV) 두 입력을 받아 AAC 로 인코딩한다.

### 8.4 인코더
- `ffmpeg -encoders` 목록에서 `h264_nvenc → h264_qsv → h264_amf → libx264` 순으로 고른다. 하드웨어 인코딩이 실패하면(취소 제외) libx264 로 한 번 다시 시도한다.
- 화질별 인자:

| 화질 | libx264 | nvenc | qsv | amf |
|---|---|---|---|---|
| high | `-preset medium -crf 18` | `-preset p5 -rc vbr -cq 19 -b:v 0` | `-preset medium -global_quality 20` | `-quality quality -rc cqp -qp_i 18 -qp_p 20` |
| standard | `-preset veryfast -crf 21` | `-preset p4 -rc vbr -cq 23 -b:v 0` | `-preset fast -global_quality 23` | `-quality balanced -rc cqp -qp_i 21 -qp_p 23` |
| fast | `-preset ultrafast -crf 23` | `-preset p1 -rc vbr -cq 26 -b:v 0` | `-preset veryfast -global_quality 26` | `-quality speed -rc cqp -qp_i 24 -qp_p 26` |

- 공통: `-pix_fmt yuv420p -r N/D -c:a aac -b:a 192k -movflags +faststart -progress pipe:2`.
- 오디오 전용 입력은 `.m4a` (AAC) 로 저장한다.

### 8.5 작업 관리
- 동시에 1개. 백그라운드 스레드, `.partial.mp4` 에 쓰고 검증 후 `os.replace`.
- 진행률: `out_time_us / expected`. 취소: 이벤트 → 프로세스 kill → 부분 파일 삭제.
- 검증: 출력 ffprobe 길이가 기대 길이 ± (0.1초 + 1프레임) 이내, 원본에 오디오가 있으면 출력에도 있어야 함.

## 9. 파일 변경 목록

| 파일 | 변경 |
|---|---|
| `agent/engines/silence_remover_render.py` | 신규: 소스 프로브, 유지 구간 검증, 그래프 생성, 인코더 선택/폴백, 작업 관리 |
| `agent/engines/test_silence_remover_render.py` | 신규: 그래프·검증 단위 테스트 + 실제 ffmpeg 렌더 통합 테스트 (ffmpeg 있을 때) |
| `agent/routers/silence_remover.py` | 엔드포인트 5개 추가 (기존 엔드포인트 변경 없음) |
| `web-ui/tools/silence-remover/cut-model.js` | 신규: 편집 모델 순수 함수 (프레임 정수 컷) |
| `web-ui/tools/silence-remover/cut-editor.js` | 신규: 파형 상호작용, 재생 엔진, 내보내기 모달 |
| `web-ui/tools/silence-remover/cut-editor.css` | 신규: 미리보기 패널·모달 스타일 |
| `web-ui/tools/silence-remover/cut-model.test.mjs` | 신규: 편집 모델 순수 함수 테스트 (node) |
| `web-ui/tools/silence-remover/index.html` | 미리보기 패널·모달 마크업, CSS/JS 버전 |
| `web-ui/tools/silence-remover/script.js` | 편집기 연결 훅(그리기·포인터·분석 완료·미디어 변경) — 최소 변경 |
| `web-ui/tools/common/i18n/silence-remover.js` | 새 문구(ko/en) |

AutoSubtitle 관련 파일: 변경 없음.

## 10. 검증 계획

1. 단위: 유지 구간 검증, 오디오 샘플 계산(누적 오차 0), 그래프 문자열, 인코더 인자 / 편집 모델(스냅, 병합, 경계 이동 제한, 실행 취소).
2. 통합: 합성 영상(색 + 사인파, VFR 포함)으로 컷 수십 개 렌더 → 길이·오디오 유무 검증, 컷 수백 개 성능 측정.
3. 수동(브라우저): 분석 → 재생/건너뛰기 → 경계 드래그·추가·삭제·실행취소 → MP4 내보내기 → 결과 재생 확인. 다운로드 페이지 왕복 후 편집 복원. 기존 XML 다운로드 회귀 확인.

## 부록 B. 다빈치 방식 편집 도구 (2026-11-17 추가)

- 편집 상태는 `{ cuts, splits }`. `splits` 는 화면에만 있는 자르기 선(프레임)이라 렌더 결과에는 영향이 없다.
  타임라인은 0·끝·컷 경계·자르기 선으로 나뉜 구간이고, 각 구간은 유지 또는 컷이다 (`cut-model.js` `buildSegments`).
- 도구 줄(파형 위, 기존 제목·범례 자리): 선택(A) · 자르기(B) · 구간 잘라내기(R) | 재생 위치 자르기(Ctrl+B) · 선택 구간 잘라내기 · 선택 구간 복원 | 스냅(N) | 실행 취소 · 다시 실행 · 초기화 | 확대/축소.
- 선택 도구: 구간 클릭 = 선택 + 재생 위치, 경계 드래그 = 트림(`moveBoundary`). 유지|컷 경계를 컷 쪽으로 끌면 잘렸던 부분이 복원되고,
  반대로 끌면 더 잘린다. 같은 상태끼리의 경계(자르기 선)는 선만 옮겨진다. 이웃 구간 끝을 넘지 않는다.
- Delete/Backspace: 선택 구간이 유지면 잘라내고, 컷이면 복원한다 (`setRangeCut`). 구간 양끝은 자르기 선으로 남는다.
- 스냅: 재생 헤드와 근처 경계에 8px 안이면 붙는다. 트림 중에는 끌기 전 경계를 기준으로 한다.
- 아래 눈금자 드래그 = 재생 위치 이동, ↑/↓ = 이전/다음 편집점.
- 영상 파일 경로 줄은 미리보기 위(작업 영역 맨 위)로 옮겼다. sessionStorage 저장 형식은 `{ baseKey, cuts, splits }`.

## 부록 C. MP4 내보내기 페이지 (2026-11-17 추가)

내보내기 대화상자(팝업)를 없애고, XML 다운로드 페이지(`download.html`)처럼 **별도 페이지 `export.html`** 에서 인코딩한다. 페이지 이동 시 위·아래 광고가 노출된다.

- 편집 화면: 「MP4로 내보내기」 옆에 화질 선택(`#cut-quality`: 고화질/표준/빠르게, `silenceRemover.exportQuality` 에 기억).
- 버튼을 누르면 `silenceRemover.exportRequest` 에 요청(`id, video_path, fps_rational, keeps[], quality, cut_count, out_sec, name`)을 저장하고, 편집 복원 플래그(`markEditorRestorePending`)를 세운 뒤 `export.html` 로 이동한다.
- `export.html` / `export.js`: 요청을 읽어 바로 `POST /render/start` → `GET /render/status` 폴링으로 진행률 표시. 완료 시 저장 위치 + 「폴더 열기」(`/render/reveal`), 실패·취소 시 「다시 시도」.
- 새로고침해도 같은 작업을 이어 본다: `silenceRemover.exportJob = {requestId, jobId}`. 에이전트가 재시작돼 작업이 없으면 새로 시작.
- 인코딩 중 「편집 화면으로 돌아가기」 = 확인 후 인코딩 취소하고 복귀. 탭 닫기는 `beforeunload` 경고.
- 편집 화면 복귀 시 분석 결과와 컷 편집(`silenceRemover.cutEdits`)이 그대로 복원된다.
- 백엔드 변경 없음. AutoSubtitle 코드는 참고만 했고 공유하지 않는다.

## 부록 D. 다빈치식 타임라인 표시 (2026-11-17 추가)

- 눈금자를 파형 **위**로 옮겼다 (`rulerPosition: "top"`). 큰 눈금 옆에 `HH:MM:SS:FF` 타임코드(비드롭, 29.97 → 30 기준)를 쓰고, 눈금은 타임코드 프레임 배수에 세워 29.97fps 에서도 `00:00:20:00` 처럼 딱 맞는다. 위치는 실제 시간(프레임 ÷ 실제 FPS).
- 남는 구간 = 초록 클립 상자(`#3a6a4e`) + 연한 파형 + 아래쪽 파일 이름(공간이 있을 때). 잘린 구간 = 어두운 트랙 + 빨간 반투명 + 가운데 가는 선.
- 재생 헤드 = 빨간 선 + 눈금자 안의 빨간 표식. 눈금자(위)를 끌면 재생 위치 이동.
- 툴바 맨 왼쪽(선택 도구 왼쪽) 타임코드 = **제거 구간을 뺀 결과 영상 길이** (`framesToTimecode(전체 프레임 − 컷 프레임)`), 편집할 때마다 갱신.
- 렌더러는 `waveTop / waveH / rulerH` 를 돌려주고, 컷 편집 오버레이·무음 표시가 이 값으로 위치를 맞춘다.
