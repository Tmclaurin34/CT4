#!/bin/sh
# Runs the free-POS-audit unit tests with macOS JavaScriptCore.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
TMP="$(mktemp -d)"
sed 's/^export //' "$DIR/audit.js" > "$TMP/audit.js"
"$JSC" "$TMP/audit.js" "$DIR/audit_test.js"
rm -rf "$TMP"
