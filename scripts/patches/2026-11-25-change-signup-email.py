#!/usr/bin/env python3
"""Signup fixes (2026-11-25). Run against the site's index.html before deploying:
    python3 2026-11-25-change-signup-email.py path/to/index.html
1. "Wrong email? Change it" button on the check-your-email screen (back to the
   filled-in account form, only the email needs fixing).
2. Onboarding answers survive Back / refresh before the account is activated:
   progress (incl. the check-your-email state) is restored when the visitor
   returns to onboarding without a session. Passwords are never stored.
Idempotent: re-running on a patched file changes nothing."""
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "index.html"
s = open(path, encoding="utf-8").read()
if "function obChangeEmail" in s:
    print("already patched"); sys.exit(0)

def rep(old, new):
    global s
    n = s.count(old)
    if n != 1:
        sys.exit(f"patch anchor found {n} times (expected 1): {old[:70]!r}")
    s = s.replace(old, new)

# 1) button under "Resend email"
rep('''onclick="resendConfirm(this)">Didn't get it? Resend email</button>''',
    '''onclick="resendConfirm(this)">Didn't get it? Resend email</button><div style="margin-top:12px"><a href="javascript:void(0)" onclick="obChangeEmail()" style="font-size:13px;font-weight:600;text-decoration:underline">Wrong email? Change it</a></div>''')

# 2) save + restore the check-your-email state
rep('''v:1,step:safeOnboardStep(obS),''',
    '''v:1,step:safeOnboardStep(obS),awaitConfirm:!!obAwaitConfirm&&!S,''')
rep('''    obS=safeOnboardStep(p.step);\n''',
    '''    obS=safeOnboardStep(p.step);\n    obAwaitConfirm=!S&&!!p.awaitConfirm&&obS===1;\n''')

# 3) restore saved answers when returning to onboarding before activation
rep('''function go(s){if(scr==="onboard")saveOnboardingProgress();scr=s;R();}''',
    '''function go(s){if(scr==="onboard")saveOnboardingProgress();if(s==="onboard"&&!S&&!obB&&!obCat)restoreOnboardingProgress();scr=s;R();}
function obChangeEmail(){obAwaitConfirm=false;obS=1;saveOnboardingProgress();R();setTimeout(function(){var el=document.getElementById("oE");if(el){el.focus();try{el.select();}catch(e){}}},60);}''')

open(path, "w", encoding="utf-8").write(s)
print("patched", path)
