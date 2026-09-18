#!/bin/sh
# Restores the shared libraries Chromium needs in this container, where apt is
# unavailable and /tmp does not survive between sessions.
#
#   . ./scripts/chrome-libs.sh      (source it: it exports LD_LIBRARY_PATH)
#
# Idempotent: downloads each .deb once, skips anything already extracted.
set -e

ROOT=/tmp/chromedeps/root
LIBDIR="$ROOT/usr/lib/x86_64-linux-gnu"
POOL=https://deb.debian.org/debian
DEBS=/tmp/chromedeps/debs

PACKAGES="
pool/main/libx/libxdamage/libxdamage1_1.1.6-1+b2_amd64.deb
pool/main/a/alsa-lib/libasound2t64_1.2.14-1+deb13u1_amd64.deb
pool/main/a/at-spi2-core/libatk1.0-0t64_2.56.2-1+deb13u2_amd64.deb
pool/main/a/at-spi2-core/libatk-bridge2.0-0t64_2.56.2-1+deb13u2_amd64.deb
pool/main/a/at-spi2-core/libatspi2.0-0t64_2.56.2-1+deb13u2_amd64.deb
pool/main/a/avahi/libavahi-common3_0.8-16_amd64.deb
pool/main/a/avahi/libavahi-client3_0.8-16_amd64.deb
pool/main/c/cups/libcups2t64_2.4.10-3+deb13u2_amd64.deb
pool/main/n/nspr/libnspr4_4.36-1_amd64.deb
pool/main/n/nss/libnss3_3.110-1+deb13u4_amd64.deb
pool/main/libx/libxkbcommon/libxkbcommon0_1.7.0-2_amd64.deb
"

mkdir -p "$LIBDIR" "$DEBS"

for path in $PACKAGES; do
  file="$DEBS/$(basename "$path")"
  [ -f "$file" ] || curl -sS -o "$file" "$POOL/$path"
  dpkg-deb -x "$file" "$ROOT"
done

LD_LIBRARY_PATH="$LIBDIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export LD_LIBRARY_PATH
echo "Chromium libraries ready in $LIBDIR"
