#!/bin/sh
# Runs the retention engine scenario tests against the Clicktide database.
# Everything runs in ONE transaction that the test block always rolls back, so no
# data is left behind. With --with-migration the migration is applied inside that
# same rolled-back transaction first (lets you test it before it is ever applied).
# Needs a Supabase personal access token in ~/.supabase_pat.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
REF=hmihfncvahsdlmefyxyg
FILES="$DIR/retention_engine_test.sql"
[ "$1" = "--with-migration" ] && FILES="$DIR/../migrations/20261127090000_retention_engine.sql $FILES"
BODY=$(python3 -c "import json,sys;print(json.dumps({'query':'\n'.join(open(f).read() for f in sys.argv[1:])}))" $FILES)
OUT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $(cat ~/.supabase_pat)" -H 'content-type: application/json' --data-binary "$BODY")
echo "$OUT" | python3 -c "import sys,re;t=sys.stdin.read();m=re.search(r'RETENTION TESTS:.*?(?=\\\\n|\")',t);print(m.group(0) if m else t[:1200])"
echo "$OUT" | grep -q 'RETENTION TESTS: [0-9]* passed, 0 failed' || exit 1
