# 서버에서 local.itmatzip.com 인증서 자동 갱신

호스팅 서버(cPanel)가 직접 Let's Encrypt 인증서를 갱신하고 `agent-cert/bundle.json`을 덮어씁니다.
한 번만 설정하면 이후 손댈 일이 없습니다. (PC에서 하는 `issue-local-cert.ps1` 수동 방식은 필요 없어집니다.)

## 1회 설정

cPanel > **Terminal** 에서:

```bash
curl -fsSLO https://raw.githubusercontent.com/infohelpful/itmatzip-platform/main/scripts/local-cert/server/setup-server.sh
bash setup-server.sh
```

- 이메일과 Cloudflare API 토큰을 물어봅니다(토큰은 입력해도 화면에 안 보임, `chmod 600` 파일에만 저장).
- 토큰 권한: `Zone - DNS - Edit`, `Zone - Zone - Read` (영역은 `itmatzip.com` 한 곳).
- 끝나면 첫 갱신이 실행되고, 매주 월요일 04:17에 도는 cron 항목이 등록됩니다.

## 동작

- `lego run` 이 인증서 만료까지 30일 미만일 때만 새로 받습니다(그 외에는 아무것도 바꾸지 않음).
- 게시 전 검사: 인증서가 `local.itmatzip.com` 용이 아니거나 24시간 안에 만료되면 **게시하지 않고** 오류로 끝냅니다.
- `bundle.json` 은 임시 파일에 쓴 뒤 교체(atomic)하므로 에이전트가 반쯤 쓴 파일을 받을 일이 없습니다.
- 에이전트는 하루 한 번 이 파일을 받아 인증서를 바꿉니다(재시작 불필요).

## 확인 / 문제 해결

```bash
tail -n 20 ~/.local/share/itmatzip-cert/renew.log     # 갱신 기록
crontab -l | grep renew-local-cert                     # 예약 확인
~/bin/renew-local-cert.sh                              # 수동 실행
```

- 갱신이 계속 실패해도 사이트는 멈추지 않습니다. 웹은 `127.0.0.1` → `localhost` → `itmatzip.localhost` → HTTPS 순으로 시도합니다.
- 토큰을 바꿨다면 `~/.config/itmatzip-cert/env` 를 지우고 `bash setup-server.sh` 를 다시 실행하세요.
- 이 서버에서 갱신하는 인증서는 PC 에서 발급한 것과 별개의 새 인증서입니다.
