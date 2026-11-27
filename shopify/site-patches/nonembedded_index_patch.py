"""Shopify non-embedded release: goclicktide.com dashboard changes (index.html).

Usage: python3 -I nonembedded_index_patch.py INDEX_HTML [--check]
Applies anchored replacements; every anchor must match exactly once (or the patch is already
applied), otherwise nothing is written. Safe to re-run.

What it changes, for Shopify merchants only:
 1. A store's own Clicktide account (made at install, app_metadata.shopify_shop) arriving with a
    sign-in link from the Shopify admin goes straight to the dashboard, never the onboarding
    wizard (which lists other POS systems), and gets no welcome e-mail about POS connections.
 2. The sign-in confirmation names the Shopify store instead of an internal e-mail address.
 3. Any account with a Shopify store (or a pending store link) opens the dashboard, unpaid or
    not; "Finish setup" / "Billing required" send it to Shopify's plan page.
 4. isShopifyBiz()/isShopifyBilling() know about the store from the first load, so other POS
    options and Stripe stay hidden everywhere, not just after Settings was opened.
 5. A website account that logs in with a pending store link lands on the dashboard, where the
    existing confirm-and-claim step runs (it used to stall in the wizard).
"""
import sys

MARK = "/*ct-shopify-nonembedded-v1*/"

PATCHES = [
    # --- helpers + store lookup ---------------------------------------------------------
    ("helpers",
     "function isShopifyBilling(){",
     MARK + """
// The Shopify store this account belongs to: an account Clicktide made for a store at install
// (app_metadata.shopify_shop), or any account with a Shopify store attached.
var ctShopifyShop="";
function ctIsShopDomain(s){return /^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$/.test(String(s||""));}
function shopifyAccountShop(){try{var s=String(S&&S.user&&S.user.app_metadata&&S.user.app_metadata.shopify_shop||"").toLowerCase();return ctIsShopDomain(s)?s:"";}catch(e){return "";}}
function shopifyStoreOf(biz){
  var c=[shopifyAccountShop(),biz&&biz.shopify_shop_domain,typeof bizLock!=="undefined"&&bizLock&&bizLock.shopify_shop_domain,ctShopifyShop];
  for(var i=0;i<c.length;i++){var s=String(c[i]||"").toLowerCase();if(ctIsShopDomain(s))return s;}
  return "";
}
function shopifyPlanUrl(shop){return "https://admin.shopify.com/store/"+encodeURIComponent(String(shop).replace(/\\.myshopify\\.com$/,""))+"/charges/"+SHOPIFY_APP_HANDLE+"/pricing_plans";}
// Pays through Shopify: a Shopify store and no Stripe subscription of its own (website-first
// businesses that already pay through Stripe keep Stripe until they pick a Shopify plan).
function shopifyPaysInShopify(biz){var b=biz||(typeof bizLock!=="undefined"?bizLock:null)||{};if(b.billing_provider==="shopify")return true;if(b.billing_provider==="stripe"||b.stripe_subscription_id)return false;return !!shopifyStoreOf(b);}
async function loadShopifyStore(tok){
  if(DEMO||!S||!S.token)return "";
  try{var r=await fetch(SU+"/rest/v1/platform_connections?select=shop_domain&platform=eq.shopify&is_active=eq.true&"+scope("")+"&order=updated_at.desc&limit=1",{headers:h(tok||S.token)});
    var rows=await r.json();var s=Array.isArray(rows)&&rows[0]?String(rows[0].shop_domain||"").toLowerCase():"";ctShopifyShop=ctIsShopDomain(s)?s:"";}catch(e){}
  return ctShopifyShop;
}
// Sign-in link from the Shopify admin for a store's own account: same login-CSRF rule as
// acceptLinkSession (silent only when that account is already signed in here), but the prompt
// names the store instead of an internal e-mail address.
async function shopifyLinkOk(u){
  var cur=S&&S.user,shop=String(u&&u.app_metadata&&u.app_metadata.shopify_shop||"");
  if(cur&&cur.id&&cur.id===u.id)return true;
  var m="Open Clicktide for the Shopify store "+shop+"?";
  if(cur&&cur.email)m+="\\n\\nThis signs "+cur.email+" out on this device.";
  m+="\\n\\nIf you didn't just open Clicktide from your Shopify admin, choose Cancel.";
  var ok=await confirmModal({title:"Open Clicktide?",message:m,okText:"Open Clicktide",cancelText:"Cancel"});
  if(ok)rememberAuthIntent(u.email,"shopify");
  return ok;
}
function goFinishSetup(){
  var shop=shopifyStoreOf(null);
  if(shop&&shopifyPaysInShopify(null)){window.location.href=shopifyPlanUrl(shop);return;}
  resumeOnboarding();
}
function isShopifyBilling(){"""),

    ("isShopifyBilling",
     """    if(typeof bizLock==="undefined"||!bizLock)return false;
    if(bizLock.billing_provider==="shopify")return true;""",
     """    if(shopifyAccountShop())return true;
    if(typeof bizLock==="undefined"||!bizLock)return false;
    if(bizLock.billing_provider==="shopify")return true;"""),

    ("isShopifyBiz",
     """  try{return !!((typeof platConn!=="undefined"&&platConn.shopify&&platConn.shopify.merchant_id)||(typeof bizLock!=="undefined"&&bizLock&&bizLock.billing_provider==="shopify"));}catch(e){return false;}""",
     """  try{return !!((typeof platConn!=="undefined"&&platConn.shopify&&platConn.shopify.merchant_id)||(typeof bizLock!=="undefined"&&bizLock&&bizLock.billing_provider==="shopify")||shopifyStoreOf(null));}catch(e){return false;}"""),

    # --- plan page for unbilled Shopify businesses -------------------------------------
    ("shopifyBillingUrl",
     """    if(b.billing_provider==="shopify"&&/^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$/.test(String(b.shopify_shop_domain||""))){""",
     """    var _ss=shopifyStoreOf(b);
    if(_ss&&shopifyPaysInShopify(b)&&!(b.billing_provider==="shopify"&&ctIsShopDomain(b.shopify_shop_domain)))return shopifyPlanUrl(_ss);
    if(b.billing_provider==="shopify"&&/^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$/.test(String(b.shopify_shop_domain||""))){"""),

    ("banner",
     """<button class="btn btn-gold" style="padding:10px 16px" onclick="resumeOnboarding()">Finish setup</button></div>""",
     """<button class="btn btn-gold" style="padding:10px 16px" onclick="goFinishSetup()">${shopifyStoreOf(biz)&&shopifyPaysInShopify(biz)?"Choose a plan":"Finish setup"}</button></div>"""),

    ("banner-text",
     """Your campaigns and gifts switch on the moment your plan is active — finish setting up to start your 30-day free trial.</div>""",
     """${shopifyStoreOf(biz)&&shopifyPaysInShopify(biz)?"Your campaigns and gifts switch on the moment your plan is active. Choose a plan in Shopify to start your 30-day free trial.":"Your campaigns and gifts switch on the moment your plan is active — finish setting up to start your 30-day free trial."}</div>"""),

    ("requirePaid",
     """onclick="this.closest('.ov').remove();resumeOnboarding()">Finish setup</button>""",
     """onclick="this.closest('.ov').remove();goFinishSetup()">${shopifyStoreOf(biz)&&shopifyPaysInShopify(biz)?"Choose a plan":"Finish setup"}</button>"""),

    # --- never strand a Shopify business in the wizard ---------------------------------
    ("goDashboardOrResume",
     """  if(hasPaidAccess(biz)){clearOnboardingProgress();if(biz&&biz.onboarding_complete!==true)setBizFields({onboarding_complete:true});go("dash");return;}
  return resumeOnboarding(biz);""",
     """  if(hasPaidAccess(biz)){clearOnboardingProgress();if(biz&&biz.onboarding_complete!==true)setBizFields({onboarding_complete:true});go("dash");return;}
  // Shopify stores (and a store link waiting to be confirmed) use the dashboard; their plan is
  // chosen in Shopify, and the dashboard runs the store-link confirmation.
  if(shopifyStoreOf(biz)||pendingShopifyClaim()||await loadShopifyStore()){clearOnboardingProgress();go("dash");return;}
  return resumeOnboarding(biz);"""),

    ("finishAuthReturn",
     """  await ensureBizProfile(token,u);
  const biz=await loadBiz();
  hydrateOnboardingFromBiz(biz);""",
     """  await ensureBizProfile(token,u);
  // A Shopify store's own account (opened from the Shopify admin), or a store link waiting to
  // be confirmed: straight to the dashboard (no onboarding wizard, no POS welcome e-mail).
  if(shopifyAccountShop()||pendingShopifyClaim()){clearOnboardingProgress();obAwaitConfirm=false;history.replaceState({view:"dash"},"","/");go("dash");return;}
  const biz=await loadBiz();
  hydrateOnboardingFromBiz(biz);"""),

    ("acceptLinkSession",
     """  if(!u||!u.id)throw new Error("Email confirmed, but Clicktide could not load the account. Please log in.");""",
     """  // A Shopify store's own account: ask with the store's name (shopifyLinkOk). On yes it marks
  // this e-mail as expected, so the general check below accepts it without asking again.
  if(u&&u.id&&ctIsShopDomain(u.app_metadata&&u.app_metadata.shopify_shop)&&!(await shopifyLinkOk(u))){scr=S?"dash":"login";R();return;}
  if(!u||!u.id)throw new Error("Email confirmed, but Clicktide could not load the account. Please log in.");"""),

    ("dLoad",
     """    bizLock=await loadBiz()||{};
    const paid=hasPaidAccess(bizLock);""",
     """    bizLock=await loadBiz()||{};
    if(!shopifyStoreOf(bizLock))await loadShopifyStore(tok);
    const paid=hasPaidAccess(bizLock);"""),
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
