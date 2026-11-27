#!/bin/sh
# Runs the free-POS-audit unit tests with macOS JavaScriptCore.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
TMP="$(mktemp -d)"
sed 's/^export //' "$DIR/audit.js" > "$TMP/audit.js"
"$JSC" "$TMP/audit.js" "$DIR/audit_test.js"
sed 's/^export //' "$DIR/shopify.js" > "$TMP/shopify.js"
OUT="$("$JSC" "$TMP/shopify.js" "$DIR/shopify_test.js")"; echo "$OUT"
echo "$OUT" | grep -q " 0 failed" || { rm -rf "$TMP"; exit 1; }
rm -rf "$TMP"
