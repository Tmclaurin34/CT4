#!/bin/sh
# Renders every Clicktide ad concept at Meta's three sizes with headless Chrome.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
T="$(mktemp -d)"
mkdir -p "$DIR/images"
for c in report salon rhythm auto; do
  for s in 1080x1080 1080x1350 1080x1920; do
    W=${s%x*}; H=${s#*x}
    "$CH" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$T" --force-device-scale-factor=1 \
      --window-size=$W,$H --virtual-time-budget=6000 \
      --screenshot="$DIR/images/clicktide-$c-$s.png" "file://$DIR/src/ad.html#$c-$s" >/dev/null 2>&1
  done
done
rm -rf "$T"
ls "$DIR/images"
