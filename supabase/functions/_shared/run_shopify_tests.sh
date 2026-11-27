#!/bin/sh
# Runs _shared/shopify.js unit tests with macOS JavaScriptCore.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
TMP="$(mktemp -d)"
sed 's/^export //' "$DIR/shopify.js" > "$TMP/shopify.js"
OUT="$("$JSC" "$TMP/shopify.js" "$DIR/shopify_test.js")"; rm -rf "$TMP"; echo "$OUT"
echo "$OUT" | grep -q " 0 failed"
