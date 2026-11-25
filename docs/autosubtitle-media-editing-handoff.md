# AutoSubtitle 미디어 편집 구현 인수인계

2026-11-26. 사용자는 이미지 오버레이와 이미지·영상 클립 삽입을 모두 개발하도록 요청했다. 세션이 끝나기 전에 진행 상황을 남기고 Claude가 이어서 개발하기를 요청했다.

## 2026-11-26 이어서 완료한 내용 (Claude)

아래 「남은 작업」 1~4를 구현했고 실제 브라우저와 소스 실행 에이전트(포트 19887, `?agentApi=`)로 확인했다. 커밋·에이전트 배포는 하지 않았다.

- **저장**: 미디어 편집이 있으면 `.autosub` 버전 3(`mediaEdits`), 없으면 버전 2. 구형 앱은 버전 3을 거부한다. undo/redo 항목에 `mediaEdits` 포함, 변경 감지 키에 포함. 다시 열 때 파일을 에이전트에 재등록하고 실패한 파일은 「교체」로 재연결.
- **미리보기**: 연속 재생 스케줄을 다음 삽입 경계(`stopSource`)에서 끝내 원본 WebAudio가 경계를 넘지 않는다. 경계에서 `MediaPreviewLayer`의 삽입 플레이어(이미지: 시간, 영상: 영상 자체 시계·소리)가 재생하고 끝나면 `resumeSource`부터 원본 재생. 재생바·시간은 최종 영상 시간. 재생바로 삽입 구간에 가면 그 프레임에서 멈춤. 오버레이는 원본 구간에서만 표시.
- **UI**: 줄 사이 「클립 추가」(이미지 클립·비디오 클립·이미지 덮기), 삽입 카드(길이·영상 시작/길이·소리 끄기·맞추기/채우기·순서·교체·삭제·여기서 재생), 덮기 배지(채우기, 시작/끝 줄 이동, 순서, 교체, 삭제). 줄 단위 배치 계산은 `shared/mediaEditOps.ts`.
- **내보내기**: `exportVideo`가 `composition`을 넘긴다. 오디오 단독(MP3/WAV)은 안내 후 막는다. 짧은 테스트 영상으로 출력 확인(원본 440Hz → 삽입 이미지 무음 → 원본 → 삽입 영상 880Hz, 오버레이 색, 총 19초).
- 남은 것: 에이전트 배포본 갱신(새 엔드포인트), 삽입 영상의 자막 생성(범위 밖), AI 목소리·빈 클립(범위 밖).

**(아래는 이어받기 전 상태 기록)** 데이터 계산과 내보내기 기반을 구현한 상태였다. 편집 UI, 새 미리보기 재생, 프로젝트 저장 연결은 아직 구현하지 않았다. 커밋·배포·에이전트 재시작은 하지 않았다.

## 확정된 동작

- 이미지 오버레이: 기존 영상·원본 오디오가 계속 재생되고 선택한 단어칩 범위에 이미지를 표시한다. 전체 길이는 그대로다.
- 이미지 삽입: 선택한 단어칩 경계에 N초짜리 새 구간을 추가한다. 해당 구간에서는 이미지와 무음이 나오며 원본 영상·오디오는 진행되지 않는다.
- 영상 삽입: 삽입 영상의 지정 구간과 그 영상 자체 오디오를 재생한다. 원본 영상·오디오는 진행되지 않는다. 새 데이터 구조는 삽입 영상의 음소거도 지원한다.
- 삽입 구간이 끝나면 원본 영상·오디오를 삽입 직전의 다음 원본 위치에서 이어 재생한다. 뒤의 자막·단어칩 표시 시각은 삽입 길이만큼 밀린다.
- 사용자가 삽입 구간 중 원본 오디오 재생을 명확히 금지했다. 원본 소리를 뒤에서 계속 흘리거나 새 영상 소리와 혼합하면 안 된다.

## 이번 세션의 구현

### 공통 데이터와 시간 계산

`web-src/auto-subtitle/src/shared/mediaComposition.ts`

- `MediaEdits`: 편집·저장용 데이터. `assets`, `insertions`, `overlays` 배열, 내부 스키마 `version: 1`.
- 이 내부 버전 1은 `.autosub` 파일 버전과 별개다. 기존 프로젝트 파일은 아직 버전 2이며 수정하지 않았다.
- `MediaAnchor`: 원본 시간 `sourceTime`과 선택적 `wordId`·`edge`를 저장한다. 단어 시간 수정과 단어 분할(`~1`, `~2` ID)에 따라 경계를 다시 계산한다. 참조 ID가 완전히 사라지면 저장된 원본 시간으로 돌아간다.
- `parseMediaEdits`: 파일 참조·중복 ID·길이·영상 trim 범위 등을 검사한다. 잘못된 편집을 일부 버리고 성공 처리하지 않는다.
- `buildMediaComposition(sourceDuration, cuts, subtitles, edits)`: 삭제 구간과 삽입을 합쳐 최종 프로그램 시간의 `MediaComposition`을 만든다. 원본 자막·단어의 저장 시각은 변경하지 않는다.
- 같은 경계의 여러 삽입은 배열 순서를 유지한다. 원본 단어를 삭제해도 독립적인 삽입 클립은 유지된다.
- `compositionPositionAt`: 프로그램 시각을 현재 클립과 원본/삽입 영상 위치로 변환한다. 삽입 구간의 `originalSourceTime`은 **null**이다. 이를 원본 재생 중지 조건으로 써야 한다.
- `sourceBoundaryToProgram`: 같은 원본 경계에서 삽입 전/후 위치를 `before`/`after`로 구분한다.
- `compositionSourceClips`: 원본 자막을 최종 시간으로 매핑할 원본 클립 목록. 삽입 구간이 있으므로 `programStart`가 연속적이지 않을 수 있다. 기존 `validateClipPlan`에 이 부분 목록을 넣지 않는다.

오버레이는 현재 이미지 전용이다. 시작·끝 단어 사이의 **원본 구간**에 적용되며, 그 사이에 삽입된 새 클립에는 표시하지 않는다. 배열 뒤쪽 오버레이가 위에 표시되고, 자막·워터마크가 그 위에 표시된다. 이 정책은 코드와 테스트에 명시되어 있다.

예: 원본 10초의 원본 시각 2초에 이미지 3초를 삽입하면 `source[0,2] @ program0`, `image[3초] @ program2`, `source[2,10] @ program5`가 된다. 최종 길이는 13초이며 원본 시각 2초 자막은 최종 시각 5초부터 나온다.

### 에이전트 합성과 내보내기

`agent/engines/autosub/composition.py`

- `inspect_asset`: 실제 파일을 ffprobe로 확인한 후 기존 미디어 제공 허용 목록에 등록한다. 이미지 PNG/JPG/JPEG/WebP, 영상은 현재 원본과 같은 MP4/MKV/AVI를 지원한다.
- `resolve_composition`: 브라우저에서 보낸 최종 계획을 검증한다. 영상 길이는 클라이언트 값을 믿지 않고 실제 파일을 확인한다. 편집에서 쓰지 않는 잔여 파일 참조는 열지 않는다.
- `build_composition_graph`: 여러 파일 입력, 이미지 정지 구간, 영상 trim, 정규화, 오디오·영상 연결, 이미지 오버레이를 구성한다.
- 출력 30fps, 오디오 48kHz stereo. 누적 프로그램 경계를 프레임으로 변환하고 각 구간 오디오 샘플 수도 같은 경계에 맞춘다.
- 이미지·무음 영상 구간에는 `anullsrc`를 넣는다. 삽입 영상에는 해당 영상 오디오만 사용한다. 원본 오디오를 삽입 구간으로 연결하지 않는다.
- 삽입 이미지 `contain`의 여백은 검정이며 이미지 오버레이 `contain`의 여백은 투명하다. `cover`는 화면을 채우도록 자른다.
- 이미지 합성은 에이전트에서 실제 출력 해상도로 한다. 브라우저의 자막 PNG에 이미지를 또 그리지 않는다.

`agent/engines/autosub/export.py`

- 기존 `start_encode(job_id, schedule, clips)` 호출을 유지하면서 선택적인 `composition` 인수를 추가했다.
- composition과 기존 clip plan을 동시에 전달하면 거부한다.
- 기존 PNG 자막·워터마크 스트리밍 및 인코더 폴백을 재사용한다. 새 합성 결과 위에 자막 PNG를 올린다.
- 실제 통합 테스트에서 발견한 PNG 디코더 stdout과 인코더 stderr 핸들 미해제도 정리했다.

`agent/routers/autosub.py`

- `GET /api/tools/auto-subtitle/v2/composition/capabilities`
- `POST /api/tools/auto-subtitle/v2/media/asset`에 `{ path, kind }` 전달.
- 기존 `POST /export/video/{job_id}/encode`가 `{ schedule, composition }`을 받는다. 기존 `{ schedule, clips }`도 유지한다.

### 웹 API 연결

`web-src/auto-subtitle/src/shared/ipc.ts`의 `ExportVideoRequest`에 선택적인 `composition`을 추가했다.

`web-src/auto-subtitle/src/renderer/src/platform/webApi.ts`는 composition이 전달되면 원본 자막을 삽입 구간 밖으로 매핑하고, 확장된 전체 길이를 워터마크·인코딩에 사용한다. SRT/VTT/ASS/TXT도 같은 매핑을 사용한다. 미디어 삽입이 있는 MP3/WAV 단독 내보내기는 현재 명시적으로 거부한다. 기존 원본 전용 내보내기는 유지된다.

`web-src/auto-subtitle/src/renderer/src/platform/compositionClient.ts`

- `requireCompositionSupport`: 구형 에이전트가 새 필드를 무시해 잘못된 파일을 만드는 상황을 막는다.
- `pickCompositionAsset('image' | 'video')`: 기존 Go 에이전트의 이미지/영상 파일 선택 창을 사용하고 새 API로 파일을 검사한다. 취소하면 null. 저장할 실제 경로와 안정적인 asset ID를 반환한다.
- `registerCompositionAsset`: 프로젝트를 다시 열 때 경로를 재등록한다. 미디어 제공 허용 목록은 에이전트 재시작 후 유지되지 않는다.
- 기존 파일 선택 API가 이미 있어서 Go 코드는 수정하지 않았다.

## 아직 연결되지 않은 부분과 다음 작업 순서

### 1. 프로젝트 상태와 저장

`App.tsx`에 `MediaEdits` 상태를 추가하고 `buildMediaComposition`을 자막·삭제 구간·미디어 편집 변경에 맞춰 계산한다. 원본 길이는 `preparedMedia.duration` 등 확인된 원본 길이를 사용한다.

`shared/autosubProject.ts`, `App.tsx`의 `buildAutosubProjectJson`과 `applyAutosubPayload`를 함께 수정한다. `.autosub` 버전 3을 추가하는 것이 안전하다. 기존 버전 1·2는 빈 미디어 편집으로 읽고, 새 버전에는 `mediaEdits`를 저장한다. 구형 앱이 새 편집을 무시하고 덮어쓰지 않도록 버전 정책을 정한다. **현재 버전 2 파서는 mediaEdits를 보존하지 않는다.**

`SubtitleHistoryEntry`, 모든 undo/redo 스냅샷, `applySubtitleChange`, 프로젝트 변경 감지(`currentSnapRef`, `projectStyleKey`, `markSaved`)에 미디어 편집을 포함한다. 클립 추가·삭제·길이·범위 변경을 Ctrl+Z로 함께 복구해야 한다. 미디어 경로를 다시 연결할 때도 편집 데이터를 보존한다.

`export/exportHandoff.ts`의 `EditorSnapshot.projectJson`은 프로젝트 JSON이 확장되면 함께 보존할 수 있다. 내보내기 페이지에서 편집 화면으로 돌아오는 경우도 확인한다.

### 2. 미리보기 재생

현재 `App.tsx`의 `timelineMapping`과 `playbackTimelineMapping`은 **원본 시간으로의 항등 매핑**이다. 컷은 별도 `playbackEdlClips`로 건너뛴다. 함수 이름만 보고 이미 새 프로그램 시간으로 동작한다고 가정하면 안 된다.

프로그램 재생 위치를 따로 관리하고 `compositionPositionAt`으로 현재 구간을 판정해야 한다. 원본 구간은 원본 영상·오디오를 재생하고, 삽입 구간은 원본 재생을 확실히 중지한 뒤 이미지 타이머 또는 삽입 영상 시계를 사용한다. 새 파일을 매번 전체 인코딩한 뒤 미리보기하는 방식으로 우회하지 않는다.

실제 원본 소리는 `<video>`나 `<audio>`가 아니라 `timeline/webAudioMasterPlayback.ts`의 `WebAudioMasterPlayback`에서 나온다. `<video>.pause()`만 호출하면 원본 소리가 계속 나올 수 있다. 삽입 경계에서 기존 오디오 스케줄을 중지/분할하고, 삽입 완료 후 올바른 원본 위치부터 다시 스케줄해야 한다.

중요 연결 위치:

- `App.tsx`: `pausePlayback`, `dispatchSeekIntent`, `armPlaybackSchedule`, `commitEditSecToUi`, 재생 RAF와 `videoRef`.
- `timeline/playbackSchedule.ts`, `timeline/playbackCommandRouter.ts`, `timeline/webAudioMasterPlayback.ts`.
- 단어 클릭은 원본 시간, 삽입 클립 클릭·길이 표시·최종 재생바는 프로그램 시간이라는 구분을 유지한다.
- 삽입 중 원본 자막을 숨긴다. 현재 내보내기 계산은 이미 그렇게 동작한다.
- 스크럽, 일시정지/재개, 구간 끝, 파일 로딩 지연, 빠른 연속 seek, 프로젝트 교체 중 늦게 끝난 비동기 작업을 처리한다.
- 원본과 추가 영상 URL은 기존 `prepareSourceMedia`, `getMediaFileUrl`, `useBrowserMediaUrl`을 검토해 사용한다. blob URL을 프로젝트에 저장하지 않는다.
- 오버레이 미리보기는 합성 계획의 overlay 구간과 `contain`/`cover`를 그대로 적용한다. 삽입 구간을 가리지 않는다.

### 3. 단어칩 기반 UI

`SubtitleVirtualList.tsx`의 행 내부에는 caret/선택 구간이 이미 있으나, 미디어 편집용 외부 콜백은 추가해야 한다. 저장용 단어 인덱스와 화면 표시 인덱스가 다르므로 기존 `subtitleWordCaretMap` 매핑을 따른다.

- 단어칩 경계에서 이미지/영상 삽입.
- 단어칩 범위를 선택해 이미지 오버레이 추가.
- 썸네일, 적용 범위, 이미지 삽입 길이, 영상 시작점/길이, 채우기/맞추기, 교체·삭제.
- 삽입된 미디어를 선택하고 다시 찾아갈 수 있는 행/칩 표시. 위치를 단순 원본 초 입력만으로 끝내지 않는다.
- 파일 선택은 `pickCompositionAsset`을 호출한다. 선택 중 프로젝트가 바뀌면 결과를 취소한다.
- 원본 단어칩 ID 기반으로 범위를 저장하고 파일 이동/누락 시 재연결 UI를 제공한다.

사용자가 처음 제시한 참고 화면은 아직 확인하지 않았다. UI 구현 전에 다음 로컬 캡처를 확인한다:

- `C:/Users/MyComputer/AppData/Roaming/EZCode/captures/image_20261125_234302_16f486.png`
- `C:/Users/MyComputer/AppData/Roaming/EZCode/captures/image_20261125_234316_638dde.png`
- `C:/Users/MyComputer/AppData/Roaming/EZCode/captures/image_20261125_234345_c7dc01.png`
- `C:/Users/MyComputer/AppData/Roaming/EZCode/captures/image_20261125_234409_e3dee7.png`

### 4. 앱 내보내기 연결과 검증

`App.tsx`의 `exportVideo`에서 새 상태로 계산한 계획을 `ExportRequest.composition`에 넣는다. **현재 App은 이 필드를 아직 전달하지 않는다.** 자막 배열은 원본 시간 그대로 전달하고, 앞에서 미리 밀지 않는다. `webApi.ts`가 프로그램 시간으로 매핑한다. 미디어가 없는 프로젝트는 기존 경로를 유지할 수 있다.

현재 export 버튼은 원본 자막이 하나도 없으면 일찍 반환하는 조건도 있다. 이미지/삽입 영상만 남은 경우 영상 내보내기가 가능하도록 UI 조건을 정리한다. 빈 텍스트 자막 내보내기는 별도 처리한다.

삽입 영상의 새 음성인식·자막 생성은 이번 구현에 포함하지 않았다. 자동으로 원본 자막을 새 영상에 복사하면 안 된다. 영상 삽입 자체는 자막 없는 클립으로도 동작해야 한다.

UI를 연결한 뒤 저장/다시 열기, undo/redo, 단어 삭제·분할, 삽입 경계 재생, 이미지 오버레이 미리보기/출력 일치, 추가 영상 오디오, 빠른 탐색을 브라우저에서 확인한다. 마지막에 웹 번들과 에이전트 배포본을 갱신한다.

## 검증과 실행 환경

최종 검사에서 웹 테스트 38개와 Python 테스트 18개가 통과했다. TypeScript 타입 검사와 Python 라우터 구문 검사도 통과했다. 전체 저장소 테스트를 실행한 것은 아니며 아래 변경 관련 테스트를 실행했다.

검증 대상 파일:

- `src/shared/mediaComposition.test.ts`: 삽입·삭제·범위·단어 ID·분할 후 앵커·자막 공백.
- `src/renderer/src/platform/compositionClient.test.ts`: 파일 선택·취소·메타데이터·경로 재등록.
- `src/renderer/src/platform/compositionExport.test.ts`: 실제 Web API 어댑터의 요청·자막 시간·구형 에이전트 거부. 렌더러/HTTP는 mock.
- 기존 `clipPlan.test.ts`, `exportRenderSchedule.test.ts` 회귀.
- `agent/engines/autosub/test_autosub_composition.py`: 계획 검증과 **실제 FFmpeg** 샘플 인코딩.
- 기존 `agent/engines/autosub/test_autosub_export.py` 회귀.

FFmpeg 통합 검증은 임시 원본 영상(440Hz)·삽입 영상(880Hz)·이미지를 만들어 결과 픽셀과 PCM 샘플을 검사한다. 이미지 삽입 무음, 삽입 영상의 주파수, 원본 복귀, 오버레이 구간과 contain 여백, 40개 소수점 길이 구간의 프레임/샘플 수, 기존 내보내기 작업과 PNG 자막 합성까지 확인했다. 라이브 브라우저/설치된 에이전트는 이 테스트에서 조작하지 않았다.

웹 검사 명령은 `web-src/auto-subtitle`에서:

```powershell
npx.cmd vitest run src/shared/mediaComposition.test.ts src/shared/clipPlan.test.ts src/shared/exportRenderSchedule.test.ts src/renderer/src/platform/compositionExport.test.ts src/renderer/src/platform/compositionClient.test.ts
npm.cmd run typecheck
```

Python은 PATH에 없었으며 다음 번들 실행 파일을 사용했다. `agent` 디렉터리에서:

```powershell
$env:AUTOSUB_TEST_FFMPEG = 'C:/Users/MyComputer/AppData/Roaming/ItMatZip/bin/gpl-shared/ffmpeg.exe'
$env:AUTOSUB_TEST_FFPROBE = 'C:/Users/MyComputer/AppData/Roaming/ItMatZip/bin/gpl-shared/ffprobe.exe'
& 'C:/Users/MyComputer/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' -m unittest engines.autosub.test_autosub_composition engines.autosub.test_autosub_export
```

Vite 빌드는 임시 디렉터리로 출력해 성공했다. 기존 500kB 초과 번들 경고는 남아 있다. `web-ui/tools/auto-subtitle/app` 배포 파일은 생성/교체하지 않았다.

## 기존 사용자 변경

작업 시작부터 motion-graphic 관련 Python·라우터·웹 파일, tray 아이콘 두 개, `docs/platform-overview.md`, `docs/silence-detector-spec.md`가 변경/추가되어 있었다. 이번 작업 범위가 아니므로 보존했다. 현재 diff를 통째로 되돌리거나 관련 없는 파일을 함께 커밋하지 않는다. 이번 구현은 AutoSubtitle 관련 파일과 이 인수인계 문서에 한정된다.
