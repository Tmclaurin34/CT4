#!/bin/sh
# Runs the retention engine scenario tests against the Clicktide database.
# Everything runs in ONE transaction that the test block always rolls back, so no
# data is left behind. With --with-migration the migration is applied inside that
# same rolled-back transaction first (lets you test it before it is ever applied).
# Needs a Supabase personal access token in ~/.supabase_pat.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
REF=hmihfncvahsdlmefyxyg
RC=0
for T in retention_engine_test.sql retention_phase3_test.sql; do
  BODY=$(python3 -c "import json,sys;print(json.dumps({'query':open(sys.argv[1]).read()}))" "$DIR/$T")
  OUT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
    -H "Authorization: Bearer $(cat ~/.supabase_pat)" -H 'content-type: application/json' --data-binary "$BODY")
  printf '%s: ' "$T"; echo "$OUT" | grep -o 'RETENTION TESTS: [0-9]* passed, [0-9]* failed[^\\"]*' || echo "$OUT" | head -c 600
  echo "$OUT" | grep -q 'RETENTION TESTS: [0-9]* passed, 0 failed' || RC=1
done
exit $RC
