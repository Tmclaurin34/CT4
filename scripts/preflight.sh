#!/bin/bash
# Local preflight = same checks as ci/github-workflow-checks.yml. Run before deploys.
set -e
cd "$(dirname "$0")/.."

echo "— secret scan —"
PATTERNS='sk_live_[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{20,}|sbp_[A-Za-z0-9]{20,}|cfut_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}'
if grep -rInE "$PATTERNS" --include='*.html' --include='*.ts' --include='*.js' --include='*.sql' --include='*.md' . ; then
  echo "FAIL: possible live secret committed"; exit 1
fi
echo "ok"

echo "— service_role JWT check —"
python3 - <<'PY'
import re, base64, sys, os
bad = []
for root, dirs, files in os.walk("."):
    if "/.git" in root: continue
    for fn in files:
        if not fn.endswith((".html", ".ts", ".js", ".sql", ".md", ".yml", ".json")): continue
        p = os.path.join(root, fn)
        try: s = open(p, encoding="utf-8", errors="ignore").read()
        except OSError: continue
        for m in re.finditer(r'eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}', s):
            pay = m.group(1); pay += "=" * (-len(pay) % 4)
            try: dec = base64.urlsafe_b64decode(pay).decode("utf-8", "ignore")
            except Exception: continue
            if '"role":"service_role"' in dec.replace(" ", ""):
                bad.append(p)
if bad:
    print("FAIL: service_role JWT committed in: " + ", ".join(sorted(set(bad)))); sys.exit(1)
print("ok: no service_role JWTs (public anon keys allowed)")
PY

echo "— HTML inline-script parse —"
python3 - <<'PY'
import re, json, subprocess, sys
bad = 0
for f in ["index.html","clicktide.html","clicktide2026/index.html","clicktide2026/clicktide.html","gift-address.html"]:
    try: html = open(f, encoding="utf-8").read()
    except FileNotFoundError: continue
    n = 0
    for attrs, code in re.findall(r'<script([^>]*)>(.*?)</script>', html, re.S):
        if 'src=' in attrs: continue
        if 'application/ld+json' in attrs:
            try: json.loads(code)
            except Exception as e: print(f"FAIL {f} JSON-LD: {e}"); bad += 1
            continue
        n += 1
        open("/tmp/_chunk.js","w",encoding="utf-8").write(code)
        r = subprocess.run(["osascript","-l","JavaScript","-e",
            "var t=$.NSString.stringWithContentsOfFileEncodingError('/tmp/_chunk.js',4,null);try{new Function(ObjC.unwrap(t));'PARSE_OK'}catch(e){'PARSE_FAIL: '+e.message}"],
            capture_output=True, text=True)
        if "PARSE_OK" not in (r.stdout or ""): print(f"FAIL {f} #{n}: {r.stdout.strip()}"); bad += 1
    print(f"{f}: {n} scripts ok")
sys.exit(1 if bad else 0)
PY

echo "— SECURITY DEFINER revoke check —"
python3 - <<'PY'
import re, glob, sys
sql = "\n".join(open(f, encoding="utf-8").read() for f in glob.glob("supabase/migrations/*.sql"))
allow = {"clicktide_can_access_client","clicktide_can_manage_fulfillment","clicktide_is_staff"}
missing = []
for m in re.finditer(r'FUNCTION public\.([a-z0-9_]+)\([^)]*\).*?SECURITY DEFINER', sql, re.S|re.I):
    fn = m.group(1)
    if fn in allow: continue
    if not re.search(r'revoke[^;]*function public\.' + fn, sql, re.I):
        missing.append(fn)
if missing:
    print("FAIL: SECURITY DEFINER without revoke:", ", ".join(sorted(set(missing)))); sys.exit(1)
print("ok")
PY
echo "PREFLIGHT PASSED"
