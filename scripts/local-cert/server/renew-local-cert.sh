#!/bin/bash
# Renew the Let's Encrypt certificate for local.itmatzip.com ON THE HOSTING SERVER and publish the bundle the
# agent downloads (https://tools.itmatzip.com/agent-cert/bundle.json). Meant to run from cPanel "Cron Jobs".
# Setup steps: scripts/local-cert/server/README.md
#
# Needs: lego v5 (single binary), python3 or php, openssl.
# Reads EMAIL and CLOUDFLARE_DNS_API_TOKEN from $CONF (chmod 600). The token never goes on a command line.
set -euo pipefail
umask 077

CONF="${ITMATZIP_CERT_CONF:-$HOME/.config/itmatzip-cert/env}"
LEGO="${LEGO:-$HOME/bin/lego}"
WORK="${WORK:-$HOME/.local/share/itmatzip-cert}"
OUT="${OUT:-$HOME/tools.itmatzip.com/agent-cert/bundle.json}"
DOMAIN="local.itmatzip.com"
RENEW_DAYS="${RENEW_DAYS:-30}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

[ -r "$CONF" ] || die "config not found: $CONF"
[ -x "$LEGO" ] || die "lego not executable: $LEGO"
# shellcheck disable=SC1090
set -a; . "$CONF"; set +a
: "${EMAIL:?EMAIL missing in $CONF}"
: "${CLOUDFLARE_DNS_API_TOKEN:?CLOUDFLARE_DNS_API_TOKEN missing in $CONF}"

mkdir -p "$WORK" "$(dirname "$OUT")"

log "lego run (renews only when fewer than $RENEW_DAYS days remain)"
"$LEGO" run --accept-tos --email "$EMAIL" --dns cloudflare -d "$DOMAIN" \
  --path "$WORK" --renew-days "$RENEW_DAYS" --dns.propagation.disable-rns

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
