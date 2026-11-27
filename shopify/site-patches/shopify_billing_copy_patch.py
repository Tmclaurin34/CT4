#!/usr/bin/env python3
"""Shopify-billed stores: no "wallet" wording, and no wallet-balance gate on gift sends.

    python3 shopify_billing_copy_patch.py <path/to/index.html> [--check]

Shopify's App Store review (requirement 1.2) needs every charge to go through Shopify
Billing. For a Shopify-billed store the backend already does that: clicktide_wallet_apply
spends any prepaid balance left from before the switch first, then bills the whole debit
as a Shopify usage charge. The dashboard still said "$1.50 from wallet", showed a Wallet
page with "Add Funds", and refused manual gift sends when the wallet balance was below the
gift cost (so a Shopify store could not send a gift by hand at all).

Website (Stripe) accounts see exactly what they saw before. Every patch replaces one exact
anchor; an anchor that is not found exactly once aborts the run before anything is written.
"""
import sys

MARK = "/*ct-shopify-billing-copy*/"

PATCHES = [
    # 1. Campaign builder, step 2: postcard line
    ("wizard-postcard",
     '"Mailed Postcard","Real postcard mailed to their door. $1.50 from wallet.","sel-b"]',
     '"Mailed Postcard","Real postcard mailed to their door. "+(isShopifyBilling()?"$1.50 each, billed through Shopify.":"$1.50 from wallet."),"sel-b"]'),

    # 2. Sidebar: the Wallet page becomes "Usage & billing"
    ("nav-label",
     '{id:"wallet",i:"<i class=ig-card></i>",l:"Wallet"}',
     '{id:"wallet",i:"<i class=ig-card></i>",l:isShopifyBilling()?"Usage & billing":"Wallet"}'),

    # 3. Overview stat tile
    ("overview-tile",
     '["Gifts Sent",sh.length],["Wallet","$"+bal]]',
     '["Gifts Sent",sh.length],(isShopifyBilling()?["Extras billed by","Shopify"]:["Wallet","$"+bal])]'),

    # 4. Wallet page header card: no balance headline, no Add Funds, for Shopify billing
    ("wallet-page",
     '''color:#0F1115;margin-bottom:8px">Gift Wallet</div><div style="font-family:'Space Grotesk',sans-serif;font-size:36px;font-weight:800;color:#0F1115;margin-bottom:6px">$${Number(bal||0).toFixed(2)}</div><div style="font-size:12px;color:rgba(240,244,255,.45);margin-bottom:12px">Available for this business only</div>${(bizLock&&bizLock.billing_provider==="shopify")?shopifyUsageLine(shu,bal):""}<button class="btn btn-gold" onclick="oWalletTopup()" style="margin-bottom:10px">Add Funds</button><div style="font-size:12px;color:rgba(240,244,255,.55);line-height:1.6">Funds are charged securely and credited to your wallet after payment is confirmed. Gifts deduct from this business wallet when they are sent.</div>''',
     '''color:#0F1115;margin-bottom:8px">${isShopifyBilling()?"Usage &amp; billing":"Gift Wallet"}</div>${isShopifyBilling()?`<div style="font-family:'Space Grotesk',sans-serif;font-size:22px;font-weight:800;color:#0F1115;margin-bottom:8px">Billed through Shopify</div>${shopifyUsageLine(shu,bal)}<div style="font-size:12px;color:rgba(240,244,255,.55);line-height:1.6">Your plan, and postcards, gifts and texts beyond your plan's limit, appear on your Shopify bill. Nothing is charged to a card here.</div>`:`<div style="font-family:'Space Grotesk',sans-serif;font-size:36px;font-weight:800;color:#0F1115;margin-bottom:6px">$${Number(bal||0).toFixed(2)}</div><div style="font-size:12px;color:rgba(240,244,255,.45);margin-bottom:12px">Available for this business only</div>${(bizLock&&bizLock.billing_provider==="shopify")?shopifyUsageLine(shu,bal):""}<button class="btn btn-gold" onclick="oWalletTopup()" style="margin-bottom:10px">Add Funds</button><div style="font-size:12px;color:rgba(240,244,255,.55);line-height:1.6">Funds are charged securely and credited to your wallet after payment is confirmed. Gifts deduct from this business wallet when they are sent.</div>`}'''),

    # 5. Settings: gift auto-send line
    ("settings-autosend",
     '"Auto-send — gifts ship automatically, paid from your wallet"',
     '"Auto-send — gifts ship automatically, "+(isShopifyBilling()?"billed through Shopify":"paid from your wallet")'),

    # 6. Auto-send explainer
    ("autosend-explainer",
     '["Your gift wallet is charged at that moment","Each gift costs its catalog price (for example, the mug is $6.44). No wallet balance = nothing ships."]',
     '(isShopifyBilling()?["It is billed at that moment","Each gift costs its catalog price (for example, the mug is $6.44), added to your Shopify bill as a usage charge."]:["Your gift wallet is charged at that moment","Each gift costs its catalog price (for example, the mug is $6.44). No wallet balance = nothing ships."])'),

    # 7. Auto-send final confirmation (single-quoted string)
    ("autosend-confirm",
     ''' and your <b style="color:#0F1115">wallet will be charged</b> \\u2014 with no review step.''',
     ''' and '+(isShopifyBilling()?'each one goes on <b style="color:#0F1115">your Shopify bill</b>':'your <b style="color:#0F1115">wallet will be charged</b>')+' \\u2014 with no review step.'''),

    # 8. Send a gift (one customer): note, balance line, gate, confirmation
    ("gift-note",
     '''note.textContent=cost>bal?"Add wallet funds before this can ship.":"This will ship once you confirm.";
    note.style.color=cost>bal?"#FF9F4D":"rgba(240,244,255,.55)";''',
     '''const short=!shopifyBilledNow()&&cost>bal;
    note.textContent=short?(isShopifyBilling()?"Gifts start once your Clicktide plan is active in Shopify.":"Add wallet funds before this can ship."):"This will ship once you confirm.";
    note.style.color=short?"#FF9F4D":"rgba(240,244,255,.55)";'''),
    ("gift-balance-line",
     '''<span style="font-size:12px;color:rgba(240,244,255,.5)">Wallet balance: <b style="color:#F0F4FF">$${balance.toFixed(2)}</b></span>''',
     '''${isShopifyBilling()?`<span style="font-size:12px;color:rgba(240,244,255,.5)">Billed through Shopify</span>`:`<span style="font-size:12px;color:rgba(240,244,255,.5)">Wallet balance: <b style="color:#F0F4FF">$${balance.toFixed(2)}</b></span>`}'''),
    ("gift-gate",
     'if(cost>balance){alert("Not enough gift wallet funds. Add funds before sending this gift.");return;}',
     'if(!shopifyBilledNow()&&cost>balance){alert(isShopifyBilling()?"Gifts start once your Clicktide plan is active in Shopify.":"Not enough gift wallet funds. Add funds before sending this gift.");return;}'),
    ("gift-confirm",
     'message:"Send "+gift.n+" to "+name+" now? Your gift wallet will be charged $"+cost.toFixed(2)+".",',
     'message:"Send "+gift.n+" to "+name+" now? "+(shopifyBilledNow()&&cost>balance?"$"+cost.toFixed(2)+" will be added to your Shopify bill.":"Your gift wallet will be charged $"+cost.toFixed(2)+"."),'),

    # 9. Gift cart: balance line, note, gate, confirmation
    ("cart-balance-line",
     '''<span style="font-size:12px;color:rgba(240,244,255,.5)">Wallet: <b style="color:#F0F4FF">$${giftCartBalance.toFixed(2)}</b></span>''',
     '''${isShopifyBilling()?`<span style="font-size:12px;color:rgba(240,244,255,.5)">Billed through Shopify</span>`:`<span style="font-size:12px;color:rgba(240,244,255,.5)">Wallet: <b style="color:#F0F4FF">$${giftCartBalance.toFixed(2)}</b></span>`}'''),
    ("cart-note",
     'else if(total>giftCartBalance){note.textContent="Add wallet funds before this cart can ship.";',
     'else if(!shopifyBilledNow()&&total>giftCartBalance){note.textContent=isShopifyBilling()?"Gifts start once your Clicktide plan is active in Shopify.":"Add wallet funds before this cart can ship.";'),
    ("cart-gate",
     'if(total>giftCartBalance){alert("Not enough gift wallet funds for this cart.");return;}',
     'if(!shopifyBilledNow()&&total>giftCartBalance){alert(isShopifyBilling()?"Gifts start once your Clicktide plan is active in Shopify.":"Not enough gift wallet funds for this cart.");return;}'),
    ("cart-confirm",
     'message:"Your gift wallet will be charged about $"+total.toFixed(2)+".",',
     'message:(shopifyBilledNow()&&total>giftCartBalance?"About $"+total.toFixed(2)+" will be added to your Shopify bill.":"Your gift wallet will be charged about $"+total.toFixed(2)+"."),'),

    # 10. Survey routing note: neutral for everyone
    ("survey-note",
     "Physical gifts only go to happy customers — saving your wallet for people",
     "Physical gifts only go to happy customers — saving your gift budget for people"),

    # marker (proves the patch is applied; harmless comment in the first script)
    ("marker",
     "function shopifyUsageLine(u,bal){",
     MARK + "function shopifyUsageLine(u,bal){"),
]


# Round 2 (same day): the Usage & billing page's empty state and stat rows.
MARK2 = "/*ct-shopify-billing-copy-2*/"
PATCHES_2 = [
    ("wallet-empty-state",
     '<div style="font-size:13px;color:rgba(240,244,255,.45)">Wallet activity will appear here when funds are added or gifts are sent.</div>',
     '<div style="font-size:13px;color:rgba(240,244,255,.45)">${isShopifyBilling()?"Postcards, gifts and extra texts will be listed here as they are sent.":"Wallet activity will appear here when funds are added or gifts are sent."}</div>'),
    # (walletStatRows is left alone: scripts/security/apply_frontend_fixes.py patch
    # idx-wallet-helpers owns that exact text.)
    ("marker-2",
     "function shopifyWalletNote(){",
     MARK2 + "function shopifyWalletNote(){"),
]


def apply(s, mark, patches):
    """Returns (text, applied_count, problems)."""
    if mark in s:
        return s, 0, []
    out, problems = s, []
    for name, old, new in patches:
        n = out.count(old)
        if n != 1:
            problems.append(f"{name}: anchor found {n} times")
            continue
        out = out.replace(old, new, 1)
    return (s, 0, problems) if problems else (out, len(patches), [])


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    path, check = sys.argv[1], "--check" in sys.argv
    s = open(path, encoding="utf-8").read()
    total, problems = 0, []
    for mark, patches in ((MARK, PATCHES), (MARK2, PATCHES_2)):
        s, n, p = apply(s, mark, patches)
        total += n
        problems += p
    if problems:
        print("NOT APPLIED:\n  " + "\n  ".join(problems))
        sys.exit(1)
    if not total:
        print("already applied")
        return
    if check:
        print(f"{total} patch(es) would apply")
        return
    open(path, "w", encoding="utf-8").write(s)
    print(f"applied {total} patch(es)")


if __name__ == "__main__":
    main()
