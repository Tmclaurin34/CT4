#!/bin/sh
# Extracts daysSince/effChurn/matchesTrigger from index.ts, strips TypeScript types,
# and runs winback_test.js with macOS JavaScriptCore.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
TMP="$(mktemp -d)"
python3 - "$DIR/index.ts" "$TMP/lib.js" <<'PY'
import re,sys
s=open(sys.argv[1]).read()
def grab(name):
    i=s.index("function "+name+"(")
    depth=0;j=s.index("{",i)
    for k in range(j,len(s)):
        if s[k]=="{":depth+=1
        elif s[k]=="}":
            depth-=1
            if depth==0:return s[i:k+1]
out="\n".join(grab(n) for n in ["daysSince","effChurn","matchesTrigger"])
out=re.sub(r"\(([^()]*)\)(\s*:\s*[A-Za-z<>\[\]| ]+)?\s*\{", lambda m:"("+re.sub(r"\??:\s*[A-Za-z<>\[\]|. ]+","",m.group(1))+") {", out)
out=re.sub(r"\s+as\s+[A-Za-z<>\[\]|]+","",out)
open(sys.argv[2],"w").write(out)
PY
"$JSC" "$TMP/lib.js" "$DIR/winback_test.js"
rm -rf "$TMP"
