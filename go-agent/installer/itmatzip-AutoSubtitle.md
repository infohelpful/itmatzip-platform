---
description: 현재 열린 ItMatZip AutoSubtitle 자막을 음성과 문맥에 맞게 교정하고 편집기에 전달
---

현재 열려 있는 ItMatZip AutoSubtitle 편집기의 자막을 교정해 주세요.
먼저 itmatzip MCP의 autosub_get_active_subtitles 도구로 현재 자막과 revision을 가져오세요.
오타를 고치고 문맥과 쉼 구간에 맞게 줄을 나눠 읽기 쉽게 만드세요.
음성이 제공되고 직접 들을 수 있다면 autosub_listen_active_audio 도구로 필요한 구간을 듣고 실제 발화와 자막을 대조하세요. 들을 수 없는 경우에는 들었다고 주장하지 마세요.
수정 결과는 autosub_submit_active_edits 도구에 revision, corrections, lineStarts를 전달해 현재 편집기에 적용하세요. 편집기의 확인 후 적용/자동 수정 설정을 따르세요.
현재 편집기가 없거나 도구 호출이 실패하면 수정했다고 말하지 말고 원인을 알려 주세요.
