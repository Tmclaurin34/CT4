#!/usr/bin/env python3
"""The Win-Back Playbook is never installed without the owner's click.

    python3 playbook_no_auto_install_patch.py <path/to/index.html> [--check]

The homepage button "Install this playbook on your business" saves ct_pb_intent in the
browser. The dashboard used to see that flag and call wbPlaybook() on its own, with no click
and no confirmation: three active campaigns, including the paid day-30 postcard and day-45
gift. The flag outlives the visit and isn't tied to an account, so it armed whichever account
next opened the dashboard in that browser (it armed a Shopify store account this way). It
also contradicted the App Store listing ("Nothing is sent until you turn a campaign on").

Now the flag only adds a short "you picked this earlier" note to the normal Install card, and
is cleared on the next dashboard visit either way. Installing always takes the owner's click.
"""
import sys

MARK = "/*ct-playbook-no-auto-install*/"

PATCHES = [
    ("no-auto-install",
     'var pbAuto=!hasPB&&localStorage.getItem("ct_pb_intent")==="1";if(pbAuto){localStorage.removeItem("ct_pb_intent");wbPlaybook();}',
     MARK + 'var pbAuto=false;var pbAsked=!hasPB&&localStorage.getItem("ct_pb_intent")==="1";try{localStorage.removeItem("ct_pb_intent");}catch(e){}'),
    ("asked-note",
     '<div class="dct"><i class=ig-shield></i> Win-Back Playbook</div><div style="font-size:12px;color:rgba(240,244,255,.5);margin-top:4px;line-height:1.6">One click installs your full protection',
     '<div class="dct"><i class=ig-shield></i> Win-Back Playbook\'+(pbAsked?\' <span style="font-size:11px;font-weight:700;color:#0B62D6">\\u2014 you picked this earlier</span>\':\'\')+\'</div><div style="font-size:12px;color:rgba(240,244,255,.5);margin-top:4px;line-height:1.6">One click installs your full protection'),
]


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    path, check = sys.argv[1], "--check" in sys.argv
    s = open(path, encoding="utf-8").read()
    if MARK in s:
        print("already applied")
        return
    out, problems = s, []
    for name, old, new in PATCHES:
        n = out.count(old)
        if n != 1:
            problems.append(f"{name}: anchor found {n} times")
            continue
        out = out.replace(old, new, 1)
    if problems:
        print("NOT APPLIED:\n  " + "\n  ".join(problems))
        sys.exit(1)
    if check:
        print(f"{len(PATCHES)} patch(es) would apply")
        return
    open(path, "w", encoding="utf-8").write(out)
    print(f"applied {len(PATCHES)} patch(es)")


if __name__ == "__main__":
    main()
