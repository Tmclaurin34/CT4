#!/bin/sh
# Applies the (unapplied) Shopify migration and runs its tests in ONE transaction
# that the test block always rolls back — nothing is left behind.
# Needs a Supabase personal access token in ~/.supabase_pat.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
REF=hmihfncvahsdlmefyxyg
BODY=$(python3 -c "import json,sys;print(json.dumps({'query':open(sys.argv[1]).read()+'\n'+open(sys.argv[2]).read()}))" "$DIR/../migrations/20261128090000_shopify_public_app.sql" "$DIR/shopify_app_test.sql")
OUT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $(cat ~/.supabase_pat)" -H 'content-type: application/json' --data-binary "$BODY")
echo "$OUT" | grep -o 'SHOPIFY TESTS: [0-9]* passed, [0-9]* failed[^\\"]*' || echo "$OUT" | head -c 800
echo "$OUT" | grep -q 'SHOPIFY TESTS: [0-9]* passed, 0 failed'
