#!/bin/sh
# Tests the free-pos-audit page's CSV import code against the demo café export.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
TMP="$(mktemp -d)"
PAGE="$DIR/../free-pos-audit.html"
sed -n '/\/\/ CSV-PARSE-START/,/\/\/ CSV-PARSE-END/p' "$PAGE" > "$TMP/lib.js"
echo 'function guess(headers,re){for(var i=0;i<headers.length;i++)if(re.test(headers[i]))return i;return -1;}' >> "$TMP/lib.js"
sed -n '/\/\/ CSV-AGG-START/,/\/\/ CSV-AGG-END/p' "$PAGE" >> "$TMP/lib.js"
echo "var DEMO_CSV='$DIR/demo-cafe-orders.csv';" >> "$TMP/lib.js"
"$JSC" "$TMP/lib.js" "$DIR/csv_test.js"
rm -rf "$TMP"
