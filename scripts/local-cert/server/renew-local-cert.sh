#!/bin/bash
# Renew the Let's Encrypt certificate for local.itmatzip.com ON THE HOSTING SERVER and publish the bundle the
# agent downloads (https://tools.itmatzip.com/agent-cert/bundle.json). Meant to run from cron.
# Setup steps: scripts/local-cert/server/README.md
#
# Needs: lego v5 (single binary), python3 or php, openssl, sendmail (for failure alerts).
# Reads EMAIL, CLOUDFLARE_DNS_API_TOKEN and optionally NOTIFY_EMAIL from $CONF (chmod 600).
# If a run fails, the full output is mailed to NOTIFY_EMAIL (default: EMAIL).
#
#   renew-local-cert.sh              normal run
#   renew-local-cert.sh --test-mail  only send a test mail to check that alerts arrive
set -uo pipefail
umask 077

CONF="${ITMATZIP_CERT_CONF:-$HOME/.config/itmatzip-cert/env}"
WORK="${WORK:-$HOME/.local/share/itmatzip-cert}"
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

send_mail() { # send_mail <to> <subject> <body>
  local to="$1" subject="$2" body="$3" sm
  [[ "$to" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { log "alert mail skipped: invalid NOTIFY_EMAIL"; return 1; }
  sm="$(command -v sendmail || true)"
  [ -z "$sm" ] && [ -x /usr/sbin/sendmail ] && sm=/usr/sbin/sendmail
  [ -n "$sm" ] || { log "alert mail skipped: sendmail not found"; return 1; }
  {
    printf 'From: itmatzip cert renewal <%s@%s>\n' "$(id -un)" "$(hostname -f 2>/dev/null || hostname)"
    printf 'To: %s\nSubject: %s\nMIME-Version: 1.0\nContent-Type: text/plain; charset=UTF-8\n\n%s\n' "$to" "$subject" "$body"
  } | "$sm" -t -oi
}

load_conf() {
  [ -r "$CONF" ] || return 1
  # shellcheck disable=SC1090
  set -a; . "$CONF"; set +a
}

# ---------------------------------------------------------------- outer: run, keep the output, alert on failure
if [ -z "${_ITMATZIP_RENEW_INNER:-}" ]; then
  load_conf || { echo "config not found: $CONF" >&2; exit 1; }
  TO="${NOTIFY_EMAIL:-${EMAIL:-}}"

  if [ "${1:-}" = "--test-mail" ]; then
    send_mail "$TO" "[itmatzip] test alert from $(hostname)" \
      "If you can read this, certificate renewal failure alerts reach you. (sent $(date '+%F %T %Z'))" \
      && log "test mail handed to sendmail for $TO (check the inbox and the spam folder)"
    exit $?
  fi

  mkdir -p "$WORK"
  RUNLOG="$(mktemp "$WORK/run.XXXXXX")"
  trap 'rm -f "$RUNLOG"' EXIT
  _ITMATZIP_RENEW_INNER=1 bash "$0" "$@" >"$RUNLOG" 2>&1
  rc=$?
  cat "$RUNLOG"
  if [ "$rc" -ne 0 ]; then
    send_mail "$TO" "[itmatzip] local.itmatzip.com certificate renewal FAILED" \
"The weekly renewal on $(hostname) failed (exit $rc) at $(date '+%F %T %Z').

The site keeps working: the web page falls back to 127.0.0.1 / itmatzip.localhost.
Only the https://local.itmatzip.com:19878 route stops once the current certificate expires.

Last output:
$(tail -n 60 "$RUNLOG")

Retry by hand:  ~/bin/renew-local-cert.sh
Log:            $WORK/renew.log" || log "could not send the failure alert"
  fi
  exit "$rc"
fi

# ---------------------------------------------------------------- inner: the actual renewal
set -e
LEGO="${LEGO:-$HOME/bin/lego}"
OUT="${OUT:-$HOME/tools.itmatzip.com/agent-cert/bundle.json}"
DOMAIN="local.itmatzip.com"
RENEW_DAYS="${RENEW_DAYS:-30}"
# Public resolver used to find the zone's nameservers. The server's own resolver can keep an outdated
# delegation for up to 2 days after a DNS provider change (lego then asks the OLD nameservers and fails).
DNS_RESOLVERS="${DNS_RESOLVERS:-1.1.1.1:53}"
die() { log "ERROR: $*" >&2; exit 1; }

load_conf || die "config not found: $CONF"
[ -x "$LEGO" ] || die "lego not executable: $LEGO"
: "${EMAIL:?EMAIL missing in $CONF}"
: "${CLOUDFLARE_DNS_API_TOKEN:?CLOUDFLARE_DNS_API_TOKEN missing in $CONF}"

mkdir -p "$WORK" "$(dirname "$OUT")"

log "lego run (renews only when fewer than $RENEW_DAYS days remain)"
"$LEGO" run --accept-tos --email "$EMAIL" --dns cloudflare -d "$DOMAIN" \
  --path "$WORK" --renew-days "$RENEW_DAYS" --dns.propagation.disable-rns \
  --dns.resolvers "$DNS_RESOLVERS"

CRT="$WORK/certificates/$DOMAIN.crt"
KEY="$WORK/certificates/$DOMAIN.key"
[ -s "$CRT" ] && [ -s "$KEY" ] || die "certificate files missing under $WORK/certificates"

# Never publish a certificate that is about to expire or is not for this host.
openssl x509 -in "$CRT" -noout -checkend 86400 >/dev/null || die "certificate expires within 24h or is already expired"
openssl x509 -in "$CRT" -noout -ext subjectAltName 2>/dev/null | grep -q "DNS:$DOMAIN" \
  || die "certificate does not cover $DOMAIN"

TMP="$(mktemp "$(dirname "$OUT")/.bundle.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

if python3 -c "import json" >/dev/null 2>&1; then
  python3 - "$DOMAIN" "$CRT" "$KEY" >"$TMP" <<'PY'
import json, sys
host, crt, key = sys.argv[1:4]
print(json.dumps({"hostname": host, "cert_pem": open(crt).read(), "key_pem": open(key).read()}))
PY
elif php -r "exit(0);" >/dev/null 2>&1; then
  php -r 'echo json_encode(["hostname"=>$argv[1],"cert_pem"=>file_get_contents($argv[2]),"key_pem"=>file_get_contents($argv[3])]), "\n";' \
    "$DOMAIN" "$CRT" "$KEY" >"$TMP"
else
  die "neither python3 nor php found"
fi

[ -s "$TMP" ] || die "bundle came out empty"
# The bundle is public by design (every agent downloads it), so the web server must be able to read it.
chmod 644 "$TMP"
mv -f "$TMP" "$OUT"
trap - EXIT

END="$(openssl x509 -in "$CRT" -noout -enddate | cut -d= -f2)"
log "published $OUT (certificate valid until $END)"
