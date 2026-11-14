#!/bin/bash
# One-time setup of automatic local.itmatzip.com certificate renewal on the cPanel host.
#
#   curl -fsSLO https://raw.githubusercontent.com/infohelpful/itmatzip-platform/main/scripts/local-cert/server/setup-server.sh
#   bash setup-server.sh
#
# It installs lego (checksum-verified), the renew script, asks for your e-mail and Cloudflare token (typed
# hidden, stored in a chmod 600 file), runs the first renewal and adds a weekly cron entry.
# Safe to run again: it only replaces what it installed itself.
set -euo pipefail

LEGO_VERSION="5.6.0"
REPO_RAW="https://raw.githubusercontent.com/infohelpful/itmatzip-platform/main/scripts/local-cert/server"
BIN="$HOME/bin"
CONF_DIR="$HOME/.config/itmatzip-cert"
WORK="$HOME/.local/share/itmatzip-cert"
CRON_LINE="17 4 * * 1 $BIN/renew-local-cert.sh >> $WORK/renew.log 2>&1"

say() { printf '\n== %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

say "1/5 environment"
for c in curl openssl tar sha256sum; do command -v "$c" >/dev/null 2>&1 || die "$c not found"; done
if python3 -c "import json" >/dev/null 2>&1; then echo "python3: ok"
elif php -r "exit(0);" >/dev/null 2>&1; then echo "php: ok (python3 not usable)"
else die "need a working python3 or php to build bundle.json"; fi
case "$(uname -m)" in
  x86_64)  ARCH=amd64 ;;
  aarch64) ARCH=arm64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac
DOCROOT="$HOME/tools.itmatzip.com"
[ -d "$DOCROOT" ] || die "web root not found: $DOCROOT"
mkdir -p "$BIN" "$CONF_DIR" "$WORK" "$DOCROOT/agent-cert"
chmod 700 "$CONF_DIR"

say "2/5 lego v$LEGO_VERSION ($ARCH)"
ASSET="lego_v${LEGO_VERSION}_linux_${ARCH}.tar.gz"
BASE="https://github.com/go-acme/lego/releases/download/v${LEGO_VERSION}"
TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT
curl -fsSL -o "$TMPD/$ASSET" "$BASE/$ASSET"
curl -fsSL -o "$TMPD/sums.txt" "$BASE/lego_${LEGO_VERSION}_checksums.txt"
EXPECT="$(grep " $ASSET\$" "$TMPD/sums.txt" | cut -d' ' -f1)"
ACTUAL="$(sha256sum "$TMPD/$ASSET" | cut -d' ' -f1)"
[ -n "$EXPECT" ] && [ "$EXPECT" = "$ACTUAL" ] || die "checksum mismatch for $ASSET"
tar -xzf "$TMPD/$ASSET" -C "$TMPD" lego
install -m 755 "$TMPD/lego" "$BIN/lego"
"$BIN/lego" --version

say "3/5 renew script"
curl -fsSL -o "$BIN/renew-local-cert.sh" "$REPO_RAW/renew-local-cert.sh"
chmod 700 "$BIN/renew-local-cert.sh"
bash -n "$BIN/renew-local-cert.sh"

say "4/5 credentials"
if [ -s "$CONF_DIR/env" ]; then
  echo "$CONF_DIR/env already exists - keeping it."
else
  [ -r /dev/tty ] || die "needs an interactive terminal"
  read -rp "Contact e-mail for Let's Encrypt (expiry notices): " EMAIL </dev/tty
  read -rsp "Cloudflare API token (input is hidden): " TOKEN </dev/tty; echo
  [ -n "$EMAIL" ] && [ -n "$TOKEN" ] || die "e-mail and token are required"
  ( umask 077; printf 'EMAIL=%s\nCLOUDFLARE_DNS_API_TOKEN=%s\n' "$EMAIL" "$TOKEN" >"$CONF_DIR/env" )
  chmod 600 "$CONF_DIR/env"
  unset TOKEN
fi

say "5/5 first run + weekly cron"
"$BIN/renew-local-cert.sh"

if command -v crontab >/dev/null 2>&1; then
  CUR=""
  if ! CUR="$(crontab -l 2>&1)"; then
    case "$CUR" in
      *"no crontab"*) CUR="" ;;
      *) echo "crontab not readable ($CUR). Add this line in cPanel > Cron Jobs instead:"; echo "$CRON_LINE"; exit 0 ;;
    esac
  fi
  [ -n "$CUR" ] && printf '%s\n' "$CUR" >"$WORK/crontab.backup"
  { printf '%s\n' "$CUR" | grep -v 'renew-local-cert.sh' || true; echo "$CRON_LINE"; } | crontab -
  echo "cron installed:"; crontab -l | grep renew-local-cert.sh
else
  echo "No crontab command. Add this line in cPanel > Cron Jobs:"; echo "$CRON_LINE"
fi

printf '\nDone. The certificate renews itself weekly (only when fewer than 30 days remain).\nLog: %s/renew.log\n' "$WORK"
