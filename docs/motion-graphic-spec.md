# 모션그래픽도구 (Motion Graphic Tool) — 명세 v2

- 웹: `web-ui/tools/motion-graphic/` (`tools.itmatzip.com/motion-graphic/`) · 툴 ID `motion-graphic`
- 사용 흐름: **영상 + SRT → 스타일 프리셋 → ① AI 설계서·자동 품질 검사·미리보기 적용 → (구간 수정) → ③ MP4 내보내기**. ② 버튼은 저장된 설계를 다시 검사하고 미리보기를 연다.
- 기준 품질: 사용자의 `motion-graphics` 스킬(FULL / OVERLAY / NONE 분석 + 문장별 비트). 사각형에 글자만 띄우는 PPT식 연출 금지.

## 1. 원칙

| 원칙 | 구현 |
| --- | --- |
| 미리보기 = 결과물 | 화면과 렌더가 같은 `mg-core.js` 의 `composeFrame(design, frame)` 을 그린다 (브라우저 DOM / Remotion React) |
| AI 는 매핑만 | 장면 연출·좌표·카메라는 템플릿 코드. AI 는 구간 · 템플릿 · 문구 · 비트(자막 번호)만 고른다 → 30초 영상 설계 약 30초 |
| 하이라이트 위치는 로컬 측정 | OVERLAY 대상 = 비트 시점 화면 변화 박스(35% 넘으면 버림) 또는 수정 요청 때 캡처 1장을 보고 AI 가 지정 → `track.mjs` 가 원본의 스크롤·확대를 따라가는 경로로 만든다 |
| 원본 fps 유지 | 29.97 영상은 30000/1001 그대로 (30 으로 두면 14분 끝에서 27프레임 어긋남) |
| 설계 없이는 진행 불가 | ② 는 설계서가 있어야, ③ 은 「적용」된 설계서가 있어야 눌린다 (서버도 같은 조건으로 막는다) |

## 2. 구성

| 계층 | 파일 | 역할 |
| --- | --- | --- |
| 공용 렌더 코어 (SSOT) | `web-ui/tools/motion-graphic/mg-core.js` | 스타일 프리셋 5종(`STYLES`), FULL 장면 템플릿 10종(`TEMPLATES`), OVERLAY 효과 6종, `composeFrame`, `boxAt`(추적 경로 보간) |
| 엔진 복사본 | `agent/engines/motion_graphic_core/src/mg-core.js` | 위 파일의 바이트 복사본 (`mg-core.test.mjs` 검사) |
| 카탈로그 | `agent/engines/motion_graphic_core/catalog.json` | `make-catalog.mjs` 로 mg-core 에서 생성. Python 설계 검증·MCP 용 (테스트가 일치 검사) |
| Remotion | `src/Main.tsx`, `src/Root.tsx`, `src/components/NodeTree.tsx`, `render.mjs` | 원본(OffthreadVideo) + MG + 오디오를 한 번에 H.264 MP4 로. OVERLAY→FULL 전환 16f 동안 원본 Freeze |
| 추적 | `agent/engines/motion_graphic_core/track.mjs` | 320×180·10fps 템플릿 매칭(위치 ±28px, 크기 0.9~1.1배), 의존성 없음 |
| 분석 | `agent/engines/motion_graphic_analyze.py` | 2fps·160×90 프레임 차이 모션, 정지 구간, 화면 급변, 로고 후보, 지시문 파싱·경계 후보 |
| 설계 | `agent/engines/motion_graphic_design.py` | 설계(AI 1회) · 정규화 · 하이라이트 위치 · 추적 · 수정 요청 · 적용 · 단계별 소요 시간 |
| 웹 소재 | `agent/engines/motion_graphic_assets.py` | 장면 맥락별 로고·사진·짧은 영상 후보 검색, 라이선스 검사, 중복 회피, 제한된 병렬 다운로드 |
| 엔진 | `agent/engines/motion_graphic.py` | `/prepare`(포터블 Node + npm ci + Chrome), 전처리, 렌더 워커(길이 검증 후 `<영상>_모션그래픽_최종.mp4` 복사) |
| 라우터 | `agent/routers/motion_graphic.py` | `/api/tools/motion-graphic/*` |
| MCP | `agent/mcp_server.py` | `motion_get_design`, `motion_save_segment`, 프롬프트 `itmatzip-MotionGraphic` |

## 3. 설계서 (`design.json`, version 2)

```json
{ "version": 2, "style": "MINT_WAVE", "fps": {"num": 30000, "den": 1001, "value": 29.97003},
  "width": 1920, "height": 1080, "durationInFrames": 900, "applied": true, "revision": 6,
  "segments": [
    {"id": "A", "type": "FULL", "from": 0, "durationInFrames": 420, "template": "TITLE",
     "vars": {"eyebrow": "ITMatzip Tools", "title": "영상 무음 자동 제거", "sub": "…"},
     "beats": [{"sub": 1, "frame": 0}, {"sub": 3, "frame": 158}], "reason": "지시 0:00~0:14 → 실측 …"},
    {"id": "B", "type": "NONE", "from": 420, "durationInFrames": 104, "beats": []},
    {"id": "C", "type": "OVERLAY", "from": 524, "durationInFrames": 376,
     "beats": [{"sub": 7, "frame": 599, "fx": "zoom", "zoom": 1.8, "target": [20, 718, 244, 42], "target_frame": 570,
                "track": [[570, 20, 718, 244, 42], [645, 5, 564, 358, 62], …]}]}
  ] }
```

- 구간은 빈틈없이 이어진다. 비트 frame = 자막 시작 − 3프레임(`useAt`).
- FULL 의 `beats[i]` 는 템플릿 `slots[i]` 가 나타나는 시점. OVERLAY 의 `target` 은 원본 픽셀, `track` 은 [프레임, x, y, w, h].
- 같은 내용이 스킬 형식 `segments.json` 으로도 저장된다.

## 4. 화면 (다크 앱 셸)

- 왼쪽: 스타일 프리셋 · 설계할 AI(Claude Code / Codex / Antigravity) · 설계 파라미터(효과 최소 간격, 정지 화면 FULL 자동) · 구간 지시(.txt) · 상태 · ①②③ 단계 버튼
- 가운데: 영상/SRT 경로 · 상태 바(타임코드 · 단계 안내 · AI 진행) · 「설계서 보기 / 모션 적용 미리보기」 · 수정 요청 바(선택 대상 + 문장 + 「이 구간만 수정」)
- 미리보기: 원본 + MG, 이전/현재/다음 구간 이동, 구간·비트·자막·파형 타임라인. 렌더 중 탭 제목에 진행률, 완료 시 윈도우 알림 후 다운로드 화면

## 5. API (`/api/tools/motion-graphic`)

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/readiness` · POST `/prepare` · GET `/prepare/status` | 엔진 설치 |
| POST | `/project/init` | `{video_path, srt_text?, srt_name?}` → 전처리(분석·파형) |
| GET | `/projects` · `/project/{id}?include=subs,waveform` · `/project/{id}/revision` | 조회 (설계서·진행 중 AI 작업 포함) |
| GET | `/catalog` · `/ai/clients` | 스타일·템플릿·효과 / 설치된 AI CLI |
| POST | `/project/{id}/design` | `{client, style, directives?, instruction?}` → 설계 작업 |
| POST | `/project/{id}/design/edit` | `{client, request, segment_id?, frame?}` → 그 구간만 수정 |
| POST | `/project/{id}/design/segment/{sid}` · `/design/segment/{sid}/type` | 구간 저장(MCP) · 종류 변경 |
| POST | `/project/{id}/design/apply` | 설계대로 적용 (렌더 허용) |
| GET/POST | `/design/{job}` · `/design/{job}/cancel` | AI 작업 진행·중지 |
| GET | `/media/{id}` · `/project/{id}/design/thumb/{sid}` | 원본(Range) · 구간 썸네일 |
| POST/GET | `/render` · `/render/{job}` · `/render/{job}/cancel` · `/download` · `/open-folder` | MP4 |

## 6. 실측 (601화 원본에서 자른 30초 샘플, Claude Code)

| 단계 | 결과 |
| --- | --- |
| 전처리 | 정지 구간 2개, 29.97fps |
| ① 설계 | 27~35초. FULL TITLE / NONE 로고 0:14.00~0:17.50 / OVERLAY |
| 수정 요청 「설명란 링크를 1.8배 확대하고 링으로 강조」 | 약 40초. 원본이 스스로 확대·스크롤해도 링이 링크를 따라감 (0:21.5 · 0:24.5 확인) |
| ③ 렌더 | 37초. 길이 30.03초(원본과 같음), 평균/최대 음량 원본과 같음 |

## 7. 테스트

```bash
node --test web-ui/tools/motion-graphic/mg-core.test.mjs        # 코어 복사본·카탈로그·템플릿·FULL 가림·줌 클램프 (6)
cd agent && python -m unittest engines.test_motion_graphic_analyze engines.test_motion_graphic_ctx   # 분석·SRT (14)
```

`mg-core.js` 를 고치면 `agent/engines/motion_graphic_core/src/mg-core.js` 로 복사하고 `node agent/engines/motion_graphic_core/make-catalog.mjs` 를 실행한다.

## 8. 남은 것

- 템플릿이 쓰는 글꼴: 미리보기는 Pretendard(웹 폰트), 렌더는 맑은 고딕 — 엔진에 Pretendard 를 넣어 맞춰야 한다.
- 소재 모드는 사진·로고·이모지·사진+짧은 영상. 영상은 Wikimedia Commons(WebM/Ogg를 12초 이하 무음 MP4로 변환)와 Pexels(기존 API 키가 있을 때)를 검색해 PHOTO_POINTS·IMAGE_CARDS·SHOWCASE에 넣고, 없으면 같은 주제의 사진을 찾는다. 외부 MP4의 오디오는 사용하지 않는다.
- 설계 저장·적용 전에 구간 연속성, FULL 장면 시작, 자막별 키워드, 이미지 파일 존재 여부를 검사한다. 소재를 못 받은 사진 장면은 내용이 남는 COMPARE·CHECKLIST·STATEMENT 그래픽으로 바꾼다. 원본 영상의 해당 장면에 실제 움직임이 있을 때만 화면 캡처를 소재로 쓴다. 고정 배경화면 캡처는 제거한다.
- 구간 재설계는 AI 초안을 먼저 저장해 설계서 화면에 보여주고, 웹 소재 다운로드와 하이라이트 추적을 완료한 뒤 최종 설계서를 다시 저장한다. 작업 상태에 AI·소재·추적 소요 시간을 각각 기록한다.
- 웹 검색 결과의 시각적 적합성은 현재 제목·태그·장면 맥락·출처·해상도로 평가한다. 실제 픽셀의 의미를 판별하는 모델은 아직 연결되지 않았으므로 자동 선택 결과는 사용자가 설계서에서 확인해야 한다.
- 아이콘은 이모지 1글자 — 스킬의 Phosphor 듀오톤 아이콘은 아직 없다.
- 14분 영상 전체는 이 구조로 아직 돌려 보지 않았다 (지시대로 30초 샘플로 먼저 관통).
- Remotion 은 회사·단체 사용 시 유료 라이선스가 필요할 수 있다 (`ITMATZIP_REMOTION_LICENSE_KEY`).

## 9. 강제 규칙 v2.1 (코드가 보장, 자동 테스트로 고정)

| 규칙 | 구현 |
| --- | --- |
| 하단 20% 자막 안전영역 | FULL 의 콘텐츠·빛·플래시는 상단 80% 로 잘린 무대 안에만 그려지고, 배경 하단 20% 는 단색. 줌 중심은 상단 80% 의 가운데(0.4H) 기준 |
| 문장이 끝나면 원상복구 | OVERLAY 효과의 `until` = 그 자막 문장의 끝 프레임. 줌은 문장이 끝나면 14f 안에 `scale 1.0` 으로 복귀(잔류 금지) |
| 연속 확대 | 줌 비트 사이 간격 ≤ 3초이고 대상이 화면 폭 45% 안이면 줌을 풀지 않고 확대한 채 다음 대상으로 이동. 이어지지 않을 때만 복귀. 이어진 OVERLAY 구간 묶음 전체에서 계산 |
| 공백 제로 | FULL: 모든 자막 시작마다 카메라 푸시·배경 맥동·빛줄기. OVERLAY: 문장마다 상단 가장자리 진행선(HUD) — 원본을 가리지 않음 |
| 이미지 비율 | 사진·스크린샷은 항상 `contain`(잘림·왜곡 없음) + 같은 이미지를 흐리게 깐 배경 |
| 정지 판정 | 움직임 없는 구간 ≥ 2.5초 → 풀 모션 후보 (짧은 움직임은 합침). 사용자 지시(directives)·범위 수정이 항상 우선 |

### 시간 범위 수정
미리보기 타임라인을 드래그 → 누른 곳 = 시작, 놓은 곳 = 끝 (드래그 중 미리보기가 따라감). 놓은 뒤 양쪽 손잡이로 조정, Esc 로 해제.
`POST /project/{id}/design/edit` 에 `start_frame`·`end_frame` 을 보내면 서버가 범위 양 끝에서 구간을 쪼개(`split_at`, FULL 은 진행 중인 장면이 양쪽에 이어짐) 범위 안 구간만 AI 가 고친다. 「이 부분은 풀 모션으로」처럼 구간 종류 변경도 가능.
