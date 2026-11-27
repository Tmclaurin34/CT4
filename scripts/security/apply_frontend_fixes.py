#!/usr/bin/env python3
"""WP7 frontend security fixes for Clicktide (contract C7).

    python3 apply_frontend_fixes.py <path/to/index.html> [--check] [--out PATH] [--verify] [--tmp DIR]

The page is picked from the file name (index.html, free-pos-audit.html, backoffice.html,
checkin.html) or forced with --page. Every patch replaces one exact anchor. An anchor
must occur exactly once, or the patch must already be present; anything else aborts the
run before a byte is written. Running the script again is a no-op. A few patches only
exist for code that one of the two index.html / free-pos-audit.html lines has; they say
which marker they need and are reported as n/a otherwise.

--check   report what would change, write nothing (exit 1 if anything is missing)
--out     write the result somewhere else instead of in place
--verify  after patching, parse every inline <script> (osascript JavaScript on macOS, or
          node if installed) and re-run the patches to prove idempotency
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile


class Patch:
    def __init__(self, pid, desc, old, new, needs=None, also=(), unless=None):
        self.pid, self.desc, self.old, self.new, self.needs = pid, desc, old, new, needs
        # `unless`: a marker whose presence makes this patch n/a (a variant patch covers it)
        self.unless = unless
        # earlier versions of `new`: a file patched with one of them counts as done (a later
        # patch in the list upgrades that text in place)
        self.also = tuple(also)


def P(pid, desc, old, new, needs=None, also=(), unless=None):
    return Patch(pid, desc, old, new, needs, also, unless)


# ---------------------------------------------------------------------------------------
# index.html (live line and staged line)
# ---------------------------------------------------------------------------------------

AUTH_HELPERS_INDEX = r'''function cleanAuthUrl(){history.replaceState({},"",window.location.pathname);}
// Login-CSRF guard: a session that arrives in a link (#access_token, ?token_hash, ?code) is
// taken silently only for an email this browser asked a link for (sign-up, resend, reset);
// otherwise the visitor first confirms which account they are about to be signed in to.
var AUTH_INTENT_KEY="ct_auth_intent";
function rememberAuthIntent(email,flow){var rec=JSON.stringify({email:String(email||"").trim().toLowerCase(),flow:flow||"",at:Date.now()});[sessionStorage,localStorage].forEach(function(st){try{st.setItem(AUTH_INTENT_KEY,rec);}catch(e){}});}
function hasAuthIntent(email){email=String(email||"").trim().toLowerCase();if(!email)return false;return [sessionStorage,localStorage].some(function(st){try{var r=JSON.parse(st.getItem(AUTH_INTENT_KEY)||"null");return !!(r&&r.email===email&&Date.now()-Number(r.at)<2*86400000);}catch(e){return false;}});}
function clearAuthIntent(){[sessionStorage,localStorage].forEach(function(st){try{st.removeItem(AUTH_INTENT_KEY);}catch(e){}});}
async function acceptLinkSession(u){
  var email=String(u&&u.email||"").trim().toLowerCase(),cur=S&&S.user;
  if((cur&&cur.id&&cur.id===u.id)||hasAuthIntent(email)){clearAuthIntent();return true;}
  var msg="You're about to sign in as "+(email||"another account")+" — continue?";
  if(cur&&cur.email)msg+="\n\nThis signs "+cur.email+" out on this device.";
  msg+="\n\nIf you didn't just ask Clicktide for a sign-in or confirmation link, choose Cancel.";
  var ok=await confirmModal({title:"Sign in to Clicktide?",message:msg,okText:"Continue",cancelText:"Cancel"});
  if(ok)clearAuthIntent();
  return ok;
}'''

OAUTH_HELPERS_INDEX = r'''// -- POS / Stripe connect (contract C3) ----------------------------------------
// oauth-start makes the OAuth state for the signed-in owner and returns the provider's
// consent page. The provider callback parks the grant and sends this browser back with a
// one-time nonce, which only the same signed-in owner can confirm (oauth-confirm).
const OAUTH_PLATFORMS=["square","shopify","clover","stripe"];
const OAUTH_LABEL={square:"Square",shopify:"Shopify",clover:"Clover",stripe:"Stripe"};
async function oauthStart(platform,extra){
  if(DEMO){ctToast("Demo mode — connecting a register is off. Everything else is live to explore.","info");return false;}
  if(!S||!S.token){alert("Log in first, then connect "+(OAUTH_LABEL[platform]||"your platform")+".");go("login");return false;}
  var body=JSON.stringify(Object.assign({platform:platform,flow:"app"},extra||{}));
  var call=function(){return fetch(FN+"/oauth-start",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+S.token},body:body});};
  try{
    var r=await call();
    if(r.status===401&&await refreshSession())r=await call();
    var d=await r.json().catch(function(){return {};});
    if(!r.ok||!/^https:\/\//.test(String(d.url||"")))throw new Error(d.error||"Please try again in a moment.");
    // The Settings return target travels with this connect only, so a failed or cancelled
    // connect can't leave it behind for a later onboarding connect in the same tab.
    savePlatformState(platform,"server",{flow:"app",ret:sessionStorage.getItem("ct_return")||""});
    window.location.href=d.url;
    return true;
  }catch(e){
    alert("Couldn't start the "+(OAUTH_LABEL[platform]||"platform")+" connection. "+e.message);
    if(scr==="onboard")R();
    return false;
  }
}
async function confirmPendingOAuth(platform,pending,toOnboard){
  var label=OAUTH_LABEL[platform]||platform,d={};
  var call=function(){return fetch(FN+"/oauth-confirm",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+((S&&S.token)||"")},body:JSON.stringify({pending:pending})});};
  try{
    var r=await call();
    if(r.status===401&&await refreshSession())r=await call();
    d=await r.json().catch(function(){return {};});
    if(!r.ok||!d.ok)throw new Error(d.error||("Could not finish connecting "+label+"."));
  }catch(e){
    if(toOnboard){obP=platform;obC=false;obS=2;saveOnboardingProgress();R();}
    else if(scr==="dash"&&S)dLoad();
    alert("Platform connection failed: "+e.message);
    return;
  }
  platConn[platform]=null;
  if(toOnboard){obP=platform;obC=true;obS=3;saveOnboardingProgress();R();}
  else{if(scr==="dash"&&S)dLoad();ctToast(label+" connected"+(d.merchant_name?" · "+d.merchant_name:"")+".","success");}
}
'''

OAUTH_RETURN_OLD = r'''  // OAuth success redirect from Edge Function
  if(params.get("ct_platform")){
    const platform=params.get("ct_platform");
    const merchantId=params.get("ct_merchant")||"";
    const merchantName=params.get("ct_name")||platform;
    const stored=loadPlatformState();
    const returnTo=sessionStorage.getItem("ct_return")||"";
    clearPlatformState();
    sessionStorage.removeItem("ct_return");
    // Set the connection in state
    platConn[platform]={merchant_id:merchantId,merchant_name:decodeURIComponent(merchantName)};
    // If we were mid-onboard, mark connected and jump to step 2 (gift)
    if(stored&&obS<=1&&!returnTo){obP=platform;obC=true;obS=3;scr="onboard";}
    else{scr="dash";dpg="settings";}
    if(scr==="onboard")saveOnboardingProgress();
    history.replaceState({},"",window.location.pathname);
    return;
  }

  // OAuth error redirect from Edge Function
  if(params.get("ct_error")){
    const msg=decodeURIComponent(params.get("ct_error")||"Connection failed");'''

OAUTH_RETURN_NEW = r'''  // OAuth return from the server-bound flow (oauth-start): the grant waits until this
  // signed-in owner confirms it. The URL carries only the platform and a one-time nonce.
  if(params.get("ct_oauth")==="pending"){
    const platform=String(params.get("ct_platform")||"");
    const pending=String(params.get("ct_pending")||"");
    const stored=loadPlatformState();
    const returnTo=(stored&&stored.ret)||sessionStorage.getItem("ct_return")||"";
    clearPlatformState();
    sessionStorage.removeItem("ct_return");
    history.replaceState({},"",window.location.pathname);
    if(!OAUTH_PLATFORMS.includes(platform)||!/^[0-9a-f]{64}$/i.test(pending)){ctToast("Platform connection failed. Please try again.","warn");return;}
    if(!S){scr="login";setTimeout(function(){alert("Your session ended before the connection finished. Log in, then connect again.");},80);return;}
    const toOnboard=!!(stored&&stored.platform===platform&&!returnTo);
    if(toOnboard){restoreOnboardingProgress();obP=platform;obC=false;obS=2;scr="onboard";saveOnboardingProgress();}
    else{scr="dash";dpg="settings";}
    ctToast("Finishing your "+(OAUTH_LABEL[platform]||platform)+" connection…","info");
    confirmPendingOAuth(platform,pending,toOnboard);
    return;
  }

  // Legacy OAuth return (a state the old site made). Only the platform id is used: the
  // merchant name and id shown in Settings always come from the database.
  if(params.get("ct_platform")){
    const platform=String(params.get("ct_platform")||"");
    const stored=loadPlatformState();
    const returnTo=sessionStorage.getItem("ct_return")||"";
    clearPlatformState();
    sessionStorage.removeItem("ct_return");
    history.replaceState({},"",window.location.pathname);
    if(!OAUTH_PLATFORMS.includes(platform))return;
    platConn[platform]=null;
    // If this tab started the connect mid-onboarding, mark connected and jump to step 3 (gift)
    if(stored&&stored.platform===platform&&!returnTo){restoreOnboardingProgress();obP=platform;obC=true;obS=3;scr="onboard";saveOnboardingProgress();}
    else{scr="dash";dpg="settings";}
    return;
  }

  // OAuth error redirect from Edge Function
  if(params.get("ct_error")){
    let msg=params.get("ct_error")||"Connection failed";
    try{msg=decodeURIComponent(msg);}catch(e){}'''

LOGO_HELPERS_INDEX = r'''// Logo storage (contract C4): the public 'logos' bucket takes PNG, JPEG, WebP or GIF up to
// 3 MiB, under u/<user id>/ when signed in and anon/ before sign-up. An SVG or a bigger file
// is redrawn on a canvas (PNG; JPEG stays JPEG) and scaled down until it fits.
const LOGO_TYPES={"image/png":"png","image/jpeg":"jpg","image/webp":"webp","image/gif":"gif"},LOGO_MAX_BYTES=3145728;
async function ctLogoFit(src){
  if(LOGO_TYPES[src.type]&&src.size<=LOGO_MAX_BYTES)return {blob:src,type:src.type,ext:LOGO_TYPES[src.type]};
  var url=URL.createObjectURL(src);
  try{
    var img=await new Promise(function(ok,no){var i=new Image();i.onload=function(){ok(i);};i.onerror=function(){no(new Error("That file isn't an image we can read — upload a PNG or JPG logo."));};i.src=url;});
    var w=img.naturalWidth||2000,h=img.naturalHeight||2000,want=src.type==="image/jpeg"?"image/jpeg":"image/png";
    var scale=(src.type==="image/svg+xml"?3000:Math.min(3000,Math.max(w,h)))/Math.max(w,h);
    for(var k=0;k<10;k++){
      var cv=document.createElement("canvas");cv.width=Math.max(1,Math.round(w*scale));cv.height=Math.max(1,Math.round(h*scale));
      cv.getContext("2d").drawImage(img,0,0,cv.width,cv.height);
      var b=await new Promise(function(ok){cv.toBlob(ok,want,0.92);});
      if(b&&LOGO_TYPES[b.type]&&b.size<=LOGO_MAX_BYTES)return {blob:b,type:b.type,ext:LOGO_TYPES[b.type]};
      scale*=0.8;
    }
  }finally{URL.revokeObjectURL(url);}
  throw new Error("That logo file is too large — upload a PNG or JPG under 3 MB.");
}
async function ctLogoUpload(src){
  var fit=await ctLogoFit(src),id=myId();
  var path=(id?"u/"+id+"/":"anon/")+Date.now()+"-"+Math.random().toString(36).slice(2)+"."+fit.ext;
  var r=await fetch(SU+"/storage/v1/object/logos/"+path,{method:"POST",headers:{apikey:SK,Authorization:"Bearer "+((S&&S.token)||SK),"Content-Type":fit.type,"Cache-Control":"3600"},body:fit.blob});
  if(!r.ok)throw new Error("upload failed");
  return SU+"/storage/v1/object/public/logos/"+path;
}
async function uploadLogoToStorage(file){
  try{
    obLogoStorageUrl=await ctLogoUpload(file);
    // Persist to the business profile so gift orders print THEIR logo
    if(S?.user?.id)setBizFields({logo_url:obLogoStorageUrl});
    // Refresh logo section to show "Saved" indicator
    var logoZone=document.getElementById('logoDropZone');
    if(!logoZone)R(); // full re-render if not found
  }catch(e){console.warn('Logo storage upload failed:',e);if(e&&/too large|can read/.test(e.message||""))alert(e.message);}
}'''

LOGO_UPLOAD_OLD_INDEX = r'''async function uploadLogoToStorage(file){
  try{
    const ext=file.name.split('.').pop();
    const path=`logos/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const res=await fetch(`${SU}/storage/v1/object/logos/${path}`,{
      method:'POST',
      headers:{apikey:SK,Authorization:`Bearer ${S?.token||SK}`,'Content-Type':file.type,'Cache-Control':'3600'},
      body:file
    });
    if(res.ok){
      obLogoStorageUrl=`${SU}/storage/v1/object/public/logos/${path}`;
      // Persist to the business profile so gift orders print THEIR logo
      if(S?.user?.id)setBizFields({logo_url:obLogoStorageUrl});
      // Refresh logo section to show "Saved" indicator
      var logoZone=document.getElementById('logoDropZone');
      if(!logoZone)R(); // full re-render if not found
    }
  }catch(e){console.warn('Logo storage upload failed:',e);}
}'''

# ctLogoUpload as first written chose the folder from myId() but sent S.token||SK, so a page
# with a user id but no token (or a token for a different user) sent a path the credential
# can't write. Both now come from the same place: the token's own claims.
LOGO_UPLOAD_V1 = r'''async function ctLogoUpload(src){
  var fit=await ctLogoFit(src),id=myId();
  var path=(id?"u/"+id+"/":"anon/")+Date.now()+"-"+Math.random().toString(36).slice(2)+"."+fit.ext;
  var r=await fetch(SU+"/storage/v1/object/logos/"+path,{method:"POST",headers:{apikey:SK,Authorization:"Bearer "+((S&&S.token)||SK),"Content-Type":fit.type,"Cache-Control":"3600"},body:fit.blob});
  if(!r.ok)throw new Error("upload failed");
  return SU+"/storage/v1/object/public/logos/"+path;
}'''

LOGO_UPLOAD_V2 = r'''// Claims of a signed-in user's access token ({} for the anon key, demo or anything unreadable).
function ctJwtClaims(t){try{var p=String(t||"").split(".")[1];if(!p)return {};p=p.replace(/-/g,"+").replace(/_/g,"/");while(p.length%4)p+="=";var c=JSON.parse(atob(p));return c&&c.role==="authenticated"&&typeof c.sub==="string"&&c.sub?c:{};}catch(e){return {};}}
// Folder and credential always agree: signed in -> u/<the token's own user id>/ sent with that
// token; not signed in -> anon/ sent with the anon key. A signed-in upload whose token has
// expired is refreshed once; it never falls back to an anonymous upload.
async function ctLogoUpload(src){
  var fit=await ctLogoFit(src);
  if(DEMO)return URL.createObjectURL(fit.blob); // demo: the logo stays in this browser
  var send=async function(){
    var tok=(S&&S.token)||"",cl=ctJwtClaims(tok),uid=cl.sub||"";
    if(uid&&cl.exp&&Number(cl.exp)*1000<Date.now()+30000&&await refreshSession()){tok=(S&&S.token)||"";cl=ctJwtClaims(tok);uid=cl.sub||"";}
    var path=(uid?"u/"+uid+"/":"anon/")+Date.now()+"-"+Math.random().toString(36).slice(2)+"."+fit.ext;
    var r=await fetch(SU+"/storage/v1/object/logos/"+path,{method:"POST",headers:{apikey:SK,Authorization:"Bearer "+(uid?tok:SK),"Content-Type":fit.type,"Cache-Control":"3600"},body:fit.blob});
    return {r:r,path:path,uid:uid};
  };
  var x=await send();
  if(!x.r.ok&&x.uid&&[400,401,403].indexOf(x.r.status)>=0&&await refreshSession())x=await send();
  if(!x.r.ok)throw new Error("upload failed");
  return SU+"/storage/v1/object/public/logos/"+x.path;
}'''

# Wallet tab totals follow the wallet ledger kind contract (all packages agree on it):
#   credits  topup, dispute_reinstated
#   debits   gift_debit, postcard_debit, sms_overage, each netted against <debit>_refund
#            (legacy 'reversal' rows are gift refunds)
#   money that left the wallet to the owner/bank: refund, dispute, debt_recovery -- not spend
WALLET_STATS_OLD = r'''${[["Transactions",tx.length],["Gift spend","$"+tx.filter(t=>Number(t.amount)<0&&t.transaction_type!=="refund").reduce((a,t)=>a+Math.abs(Number(t.amount||0)),0).toFixed(2)],["Total added","$"+tx.filter(t=>Number(t.amount)>0).reduce((a,t)=>a+Number(t.amount||0),0).toFixed(2)]].map(([l,v])=>'''

WALLET_STATS_NEW = r'''${walletStatRows(tx).map(([l,v])=>'''

WALLET_HELPERS_ANCHOR = r'''function myId(){return (S&&S.user&&S.user.id)?S.user.id:null;}'''

WALLET_HELPERS = WALLET_HELPERS_ANCHOR + r'''
// Wallet tab totals (wallet ledger kind contract). Credits: topup, dispute_reinstated. Spend:
// gift_debit, postcard_debit, sms_overage, each net of its <debit>_refund (older 'reversal'
// rows are gift refunds). refund / dispute / debt_recovery left the wallet for the owner's
// card or a chargeback, so they are listed apart and never counted as spend.
function walletTotals(tx){
  var t={added:0,gift:0,postcard:0,sms:0,refunded:0,withheld:0,other:0,seen:{}};
  (Array.isArray(tx)?tx:[]).forEach(function(r){
    var a=Number(r&&r.amount);if(!isFinite(a)||!a)return;
    var k=String((r&&r.transaction_type)||"").trim().toLowerCase(),b;
    if(k==="topup"||k==="dispute_reinstated")b="added";
    else if(k==="gift_debit"||k==="gift_refund"||k==="reversal")b="gift";
    else if(k==="postcard_debit"||k==="postcard_refund")b="postcard";
    else if(k==="sms_overage"||k==="sms_overage_refund")b="sms";
    else if(k==="refund")b="refunded";
    else if(k==="dispute"||k==="debt_recovery")b="withheld";
    else if(!k)b=a>0?"added":"gift"; // rows from before the ledger had kinds
    else b="other";
    t.seen[b]=true;
    t[b]+=(b==="added"||b==="other")?a:-a;
  });
  ["added","gift","postcard","sms","refunded","withheld","other"].forEach(function(b){t[b]=Math.round(t[b]*100)/100;if(Math.abs(t[b])<0.005)t[b]=0;});
  return t;
}
function walletStatRows(tx){
  var t=walletTotals(tx),m=function(v){return (v<0?"-$":"$")+Math.abs(v).toFixed(2);};
  var rows=[["Transactions",Array.isArray(tx)?tx.length:0],["Total added",m(t.added)],["Gift spend",m(t.gift)]];
  if(t.seen.postcard)rows.push(["Postcard spend",m(t.postcard)]);
  if(t.seen.sms)rows.push(["Text overage spend",m(t.sms)]);
  if(t.seen.refunded)rows.push(["Refunded to you",m(t.refunded)]);
  if(t.seen.withheld)rows.push(["Chargebacks &amp; repayments",m(t.withheld)]);
  if(t.seen.other)rows.push(["Other adjustments",m(t.other)]);
  return rows;
}'''

PLAT_SYNC_LINE = r'''// Settings line under a connected POS: when it last imported, or what is wrong with it.
function platSyncLine(c){
  if(!c)return "";
  if(c.sync_status==="needs_reconnect")return '<div style="font-size:11px;color:#C0392B;font-weight:600;margin-top:2px">Access expired or was revoked — reconnect to keep your customer data current.</div>';
  if(c.sync_status==="error")return '<div style="font-size:11px;color:#C0392B;margin-top:2px">Last sync hit a problem'+(c.sync_error?': '+giftEsc(String(c.sync_error).slice(0,140)):'')+' — retrying automatically.</div>';
  if(c.last_synced_at){var t=new Date(c.last_synced_at);if(!isNaN(t.getTime()))return '<div style="font-size:11px;color:rgba(240,244,255,.45);margin-top:2px">Last synced '+giftEsc(t.toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}))+'</div>';}
  return "";
}
// Disconnect (mark inactive in DB)
async function disconnectPlatform(platform){'''

INDEX = [
    # --- login CSRF / session fixation ----------------------------------------------
    P("idx-auth-helpers", "login-CSRF helpers (auth intent marker + confirm prompt)",
      r'''function cleanAuthUrl(){history.replaceState({},"",window.location.pathname);}''',
      AUTH_HELPERS_INDEX),
    P("idx-auth-accept", "finishAuthReturn: confirm before adopting a session from a link",
      r'''  if(!u||!u.id)throw new Error("Email confirmed, but Clicktide could not load the account. Please log in.");
  saveSession(Object.assign({},sessionData||{},{access_token:token,user:u}),true);''',
      r'''  if(!u||!u.id)throw new Error("Email confirmed, but Clicktide could not load the account. Please log in.");
  if(!(await acceptLinkSession(u))){scr=S?"dash":"login";R();return;}
  saveSession(Object.assign({},sessionData||{},{access_token:token,user:u}),true);'''),
    P("idx-auth-intent-signup", "sign-up remembers the email it asked a confirmation link for",
      r'''  async up(e,p,m){const r=await fetch(`${SU}/auth/v1/signup?redirect_to=''',
      r'''  async up(e,p,m){rememberAuthIntent(e,"signup");const r=await fetch(`${SU}/auth/v1/signup?redirect_to='''),
    P("idx-auth-intent-resend", "resend confirmation remembers the email",
      r'''    await fetch(SU+"/auth/v1/resend?redirect_to="+encodeURIComponent(authRedirectTo())''',
      r'''    rememberAuthIntent(e,"signup");
    await fetch(SU+"/auth/v1/resend?redirect_to="+encodeURIComponent(authRedirectTo())'''),
    P("idx-auth-intent-reset", "password reset remembers the email",
      '  btn.disabled=true;btn.textContent="Sending…";\n  try{await fetch(FN+"/password-reset"',
      '  btn.disabled=true;btn.textContent="Sending…";\n  rememberAuthIntent(e,"recovery");\n  try{await fetch(FN+"/password-reset"'),

    # --- POS OAuth (C3) -------------------------------------------------------------
    P("idx-oauth-start", "connect buttons use oauth-start; browser no longer writes oauth_states",
      r'''// -- Store state in Supabase then return it -----------------------------------
async function createOAuthState(platform,metadata){
  const state=randomState();
  // Only persist to DB when the user is logged in -- sessionStorage covers the unauthenticated onboard flow
  if(S?.user?.id){
    try{
      const tok=S.token;
      await fetch(`${SU}/rest/v1/oauth_states`,{
        method:"POST",
        headers:{...h(tok),Prefer:"return=minimal"},
        body:JSON.stringify({state,user_id:S.user.id,platform,metadata,expires_at:new Date(Date.now()+10*60*1000).toISOString()})
      });
    }catch(e){console.warn("Could not persist state to DB",e);}
  }
  savePlatformState(platform,state,metadata||{});
  return state;
}
''',
      OAUTH_HELPERS_INDEX),
    P("idx-oauth-square", "Square connect via oauth-start",
      r'''async function squareConnect(){
  var state=await createOAuthState("square",{});
  var redirectUri=FN+"/square-oauth-callback";
  var params=new URLSearchParams({
    client_id:SQ_APP_ID,
    scope:"MERCHANT_PROFILE_READ ORDERS_READ PAYMENTS_READ CUSTOMERS_READ",
    redirect_uri:redirectUri,
    state:state,
    session:"false"
  });
  window.location.href="https://connect.squareup.com/oauth2/authorize?"+params;
}''',
      r'''async function squareConnect(){return oauthStart("square");}'''),
    P("idx-oauth-shopify", "Shopify connect via oauth-start",
      r'''      var state=await createOAuthState("shopify",{shop_domain:raw});
      var redirectUri=FN+"/shopify-oauth-callback";
      var params=new URLSearchParams({
        client_id:SH_CLIENT_ID,
        scope:"read_orders,read_customers",
        redirect_uri:redirectUri,
        state:state
      });
      window.location.href="https://"+raw+"/admin/oauth/authorize?"+params;
      resolve();''',
      r'''      await oauthStart("shopify",{shop_domain:raw});
      resolve();''', unless="const SHOPIFY_INSTALL_URL="),
    P("idx-oauth-clover", "Clover connect via oauth-start",
      r'''async function cloverConnect(){
  var state=await createOAuthState("clover",{});
  var redirectUri=FN+"/clover-oauth-callback";
  var params=new URLSearchParams({
    client_id:CL_APP_ID,
    redirect_uri:redirectUri,
    state:state
  });
  window.location.href="https://www.clover.com/oauth/authorize?"+params;
}''',
      r'''async function cloverConnect(){return oauthStart("clover");}'''),
    P("idx-oauth-stripe", "Stripe connect via oauth-start (read_only scope is set by the server)",
      r'''  var state=await createOAuthState("stripe",{});
  var params=new URLSearchParams({
    response_type:"code",
    client_id:ST_CLIENT_ID,
    scope:"read_write",
    redirect_uri:FN+"/stripe-oauth-callback",
    state:state
  });
  window.location.href="https://connect.stripe.com/oauth/authorize?"+params;
}''',
      r'''  return oauthStart("stripe");
}'''),
    P("idx-oauth-return", "OAuth return: pending/confirm flow; legacy return trusts no URL names (reflected XSS)",
      OAUTH_RETURN_OLD, OAUTH_RETURN_NEW),
    P("idx-oauth-audit-forward", "a pending app-flow return stays in the app (the server already picked the page)",
      r'''if(ctAuditFlow()&&(_ap.get("ct_platform")||_ap.get("ct_error"))){''',
      r'''if(ctAuditFlow()&&_ap.get("ct_oauth")!=="pending"&&(_ap.get("ct_platform")||_ap.get("ct_error"))){'''),
    P("idx-checkout-biz", "?session=success no longer copies ?biz= into the onboarding form",
      r'''  if(params.get("session")==="success"){
    const plan=saveSelectedPlan(params.get("plan")||obPl);
    const biz=params.get("biz")||"";
    obCampaignSkipped=params.get("campaign")==="skip";
    obN=biz;obS=6;scr="onboard";''',
      r'''  if(params.get("session")==="success"){
    const plan=saveSelectedPlan(params.get("plan")||obPl);
    obCampaignSkipped=params.get("campaign")==="skip";
    obS=6;scr="onboard";'''),

    # --- Settings: connections ------------------------------------------------------
    P("idx-settings-conns", "Settings reads last sync time and sync health",
      r'''        const res=await fetch(`${SU}/rest/v1/platform_connections?select=platform,merchant_id,merchant_name,connected_at,is_active&is_active=eq.true&${scope("")}`,{headers:h(tok)});
        conns=await res.json();
        if(!Array.isArray(conns))conns=[];
        conns.forEach(c=>{platConn[c.platform]={merchant_id:c.merchant_id,merchant_name:c.merchant_name,connected_at:c.connected_at};});
      }catch{}''',
      r'''        const res=await fetch(`${SU}/rest/v1/platform_connections?select=platform,merchant_id,merchant_name,connected_at,is_active,last_synced_at&is_active=eq.true&${scope("")}`,{headers:h(tok)});
        conns=await res.json();
        if(!Array.isArray(conns))conns=[];
        conns.forEach(c=>{platConn[c.platform]={merchant_id:c.merchant_id,merchant_name:c.merchant_name,connected_at:c.connected_at,last_synced_at:c.last_synced_at};});
        // Sync health columns come with the POS sync rework; a database without them skips this.
        const sres=await fetch(`${SU}/rest/v1/platform_connections?select=platform,sync_status,sync_error&is_active=eq.true&${scope("")}`,{headers:h(tok)}).catch(()=>null);
        const sync=sres&&sres.ok?await sres.json().catch(()=>[]):[];
        if(Array.isArray(sync))sync.forEach(c=>{if(platConn[c.platform])Object.assign(platConn[c.platform],{sync_status:c.sync_status,sync_error:c.sync_error});});
      }catch{}'''),
    P("idx-settings-card", "Settings card escapes the merchant name; shows sync status and Reconnect",
      r'''              <div style="font-size:11px;color:#22C55E;font-weight:600">● Connected · ${conn.merchant_name||conn.merchant_id}</div>
            </div>
            <button class="btn btn-ghost" style="font-size:11px;padding:6px 12px" onclick="disconnectPlatform('${p.id}')">Disconnect</button>''',
      r'''              <div style="font-size:11px;color:#22C55E;font-weight:600">● Connected · ${giftEsc(conn.merchant_name||conn.merchant_id)}</div>
              ${platSyncLine(conn)}
            </div>
            ${conn.sync_status==="needs_reconnect"?`<button class="btn btn-gold" style="font-size:11px;padding:6px 12px" onclick="connectPlatformDash('${p.id}')">Reconnect</button>`:""}
            <button class="btn btn-ghost" style="font-size:11px;padding:6px 12px" onclick="disconnectPlatform('${p.id}')">Disconnect</button>'''),
    P("idx-connect-return", "Settings connect: the return target is cleared once the connect call ends (success, error or cancel)",
      r'''async function connectPlatformDash(platform){
  sessionStorage.setItem("ct_return","settings");
  if(platform==="square")await squareConnect();
  else if(platform==="shopify")await shopifyConnect();
  else if(platform==="clover")await cloverConnect();
  else if(platform==="stripe")stripeConnect();
  else if(platform==="toast")toastConnect();
  else if(platform==="mindbody")mindbodyConnect();
}''',
      r'''async function connectPlatformDash(platform){
  // oauthStart copies the target into this connect's saved state before it leaves the page.
  sessionStorage.setItem("ct_return","settings");
  try{
    if(platform==="square")await squareConnect();
    else if(platform==="shopify")await shopifyConnect();
    else if(platform==="clover")await cloverConnect();
    else if(platform==="stripe")await stripeConnect();
    else if(platform==="toast")toastConnect();
    else if(platform==="mindbody")mindbodyConnect();
  }finally{sessionStorage.removeItem("ct_return");}
}'''),
    P("idx-sync-line", "platSyncLine helper",
      r'''// Disconnect (mark inactive in DB)
async function disconnectPlatform(platform){''',
      PLAT_SYNC_LINE),
    P("idx-disconnect-scope", "Disconnect PATCH is filtered to the signed-in business and checks the response",
      r'''  const tok=S?.token||SK;
  try{
    await fetch(`${SU}/rest/v1/platform_connections?platform=eq.${platform}`,{
      method:"PATCH",
      headers:{...h(tok),Prefer:"return=minimal"},
      body:JSON.stringify({is_active:false})
    });
    platConn[platform]=false;''',
      r'''  const tok=S?.token||SK;
  const uid=myId();
  if(!uid){alert("Log in again to disconnect.");return;}
  try{
    // Always this business only: a staff session can also see other tenants' connections.
    const r=await fetch(`${SU}/rest/v1/platform_connections?user_id=eq.${encodeURIComponent(uid)}&platform=eq.${encodeURIComponent(platform)}`,{
      method:"PATCH",
      headers:{...h(tok),Prefer:"return=minimal"},
      body:JSON.stringify({is_active:false})
    });
    if(!r.ok)throw new Error("the server refused it ("+r.status+")");
    platConn[platform]=false;'''),

    # --- stored / reflected XSS: escape every DB- and URL-sourced string ----------------
    P("idx-esc-sidebar-logo", "Scale sidebar logo URL",
      r'''<img src="${bizLock.logo_url}" style="width:26px;height:26px;border-radius:6px;object-fit:contain"/>''',
      r'''<img src="${giftEsc(bizLock.logo_url)}" style="width:26px;height:26px;border-radius:6px;object-fit:contain"/>'''),
    P("idx-esc-sidebar-name", "Scale sidebar business name",
      r'''${(bizLock.business_name||"").toUpperCase()}</span>''',
      r'''${giftEsc((bizLock.business_name||"").toUpperCase())}</span>'''),
    P("idx-esc-sidebar-email", "sidebar login email",
      r'''white-space:nowrap">${S.user.email}</div>''',
      r'''white-space:nowrap">${giftEsc(S.user.email)}</div>'''),
    P("idx-esc-overview-campaigns", "Overview campaign name / trigger / gift",
      r'''<div class="dn">${cc.name}</div><div class="dsub">${cc.trigger} · ${cc.gift_name}</div>''',
      r'''<div class="dn">${giftEsc(cc.name)}</div><div class="dsub">${giftEsc(cc.trigger)} · ${giftEsc(cc.gift_name)}</div>'''),
    P("idx-esc-overview-shipments", "Overview recent shipments customer name / gift",
      r'''<div class="dn">${s.customer_name}</div><div class="dsub">${s.gift}</div>''',
      r'''<div class="dn">${giftEsc(s.customer_name)}</div><div class="dsub">${giftEsc(s.gift)}</div>'''),
    P("idx-esc-campaign-status", "campaign Pause/Resume passes a fixed status, not the stored one",
      r'''onclick="tCmp('${cc.id}','${cc.status}')"''',
      r'''onclick="tCmp('${cc.id}','${cc.status==="active"?"active":"paused"}')"'''),
    P("idx-esc-wallet-desc", "Wallet transaction description",
      r'''<div style="font-size:12px;font-weight:600">${t.desc}</div>''',
      r'''<div style="font-size:12px;font-weight:600">${giftEsc(t.desc)}</div>'''),
    P("idx-wallet-helpers", "Wallet tab: totals helpers following the ledger kind contract",
      WALLET_HELPERS_ANCHOR, WALLET_HELPERS),
    P("idx-wallet-totals", "Wallet tab: Total added / spend net of *_refund rows; refunds and disputes listed apart, not as spend",
      WALLET_STATS_OLD, WALLET_STATS_NEW),
    P("idx-demo-wallet-rows", "Demo mode: sample wallet rows carry amount/type/desc (was a balance-only row that rendered -$NaN)",
      r'''    wallet:[{id:1,user_id:"demo-user",balance:42.5}],''',
      r'''    wallet:[{id:2,user_id:"demo-user",transaction_type:"gift_debit",amount:-32.5,balance:42.5,desc:"Gift sent: coffee mug to Maria G.",created_at:"2026-11-20T15:04:00Z"},{id:1,user_id:"demo-user",transaction_type:"topup",amount:75,balance:75,desc:"Wallet top-up",created_at:"2026-11-12T10:00:00Z"}],'''),
    P("idx-ai-jwt", "Write with AI sends the owner's login, so ai-proxy counts it per account instead of in the shared anonymous pool",
      r'''    var r=await fetch(FN+"/ai-proxy",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({max_tokens:600,messages:[{role:"user",content:prompt}]})});''',
      r'''    var aiH={"Content-Type":"application/json"};if(typeof S!=="undefined"&&S&&S.token&&!DEMO)aiH.Authorization="Bearer "+S.token;
    var r=await fetch(FN+"/ai-proxy",{method:"POST",headers:aiH,body:JSON.stringify({max_tokens:600,messages:[{role:"user",content:prompt}]})});'''),
    P("idx-esc-dash-color", "Scale accent color value",
      r'''value="${bizLock?.dashboard_color||'#FFD166'}"''',
      r'''value="${giftEsc(bizLock?.dashboard_color||'#FFD166')}"'''),
    P("idx-esc-dash-bg", "Scale theme color value",
      r'''value="${bizLock?.dashboard_bg||'#080D18'}"''',
      r'''value="${giftEsc(bizLock?.dashboard_bg||'#080D18')}"'''),
    P("idx-esc-dash-error", "dashboard error card message",
      r'''<div style="font-size:13px;color:rgba(240,244,255,.45)">${ex.message}</div>''',
      r'''<div style="font-size:13px;color:rgba(240,244,255,.45)">${giftEsc(ex.message)}</div>'''),
    P("idx-esc-cm-trigger", "campaign editor: stored trigger option",
      r'''<option value="${cmTr}" selected>${cmTr}</option>''',
      r'''<option value="${giftEsc(cmTr)}" selected>${giftEsc(cmTr)}</option>'''),
    P("idx-esc-cm-name", "campaign editor: stored name",
      r'''<input class="fi" id="cN" value="${cmN}"''',
      r'''<input class="fi" id="cN" value="${giftEsc(cmN)}"'''),
    P("idx-esc-cm-message", "campaign editor: stored message",
      r'''oninput="cmM=this.value;pcSyncPreview()">${cmM}</textarea>''',
      r'''oninput="cmM=this.value;pcSyncPreview()">${giftEsc(cmM)}</textarea>'''),
    P("idx-esc-mindbody-code", "Mindbody activation code (server response)",
      r'''      <div style="font-size:22px;font-weight:900;color:#FFD166;letter-spacing:.5px">${code||"Generated"}</div>
    </div>
    <button class="btn-full btn-gold" onclick="navigator.clipboard?.writeText('${code.replace(/'/g,"")}');this.textContent='Copied'">Copy code</button>''',
      r'''      <div style="font-size:22px;font-weight:900;color:#FFD166;letter-spacing:.5px">${giftEsc(code||"Generated")}</div>
    </div>
    <button class="btn-full btn-gold" data-code="${giftEsc(code)}" onclick="navigator.clipboard?.writeText(this.dataset.code);this.textContent='Copied'">Copy code</button>'''),
    P("idx-esc-proof-img", "Brand Studio proof image URL (server response)",
      r'''pv.innerHTML='<img src="'+d.mockup_url+'" alt="proof"''',
      r'''pv.innerHTML='<img src="'+giftEsc(d.mockup_url)+'" alt="proof"'''),
    P("idx-esc-ai-hint", "onboarding AI tip text",
      r''':aiHint)+"</div></div>";''',
      r''':giftEsc(aiHint))+"</div></div>";'''),
    # onboarding form values come from typing, localStorage, the business row and (before
    # this patch set) the ?biz= return URL
    P("idx-esc-ob-other", "onboarding: custom business type", r"""value='"+obOther+"'""", r"""value='"+giftEsc(obOther)+"'"""),
    P("idx-esc-ob-step2", "onboarding step 2: business label + which account the POS connects to",
      r'''Best for <strong>${B.l}</strong>: ${B.pl}</p>''',
      r'''Best for <strong>${giftEsc(B.l)}</strong>: ${B.pl}</p>${S&&S.user&&S.user.email?`<div style="font-size:11px;color:rgba(240,244,255,.45);margin:-8px 0 12px">Signed in as <b>${giftEsc(S.user.email)}</b></div>`:""}'''),
    P("idx-esc-ob-search", "onboarding gift search box", r'''value='"+sq+"' placeholder='Search gifts''', r'''value='"+giftEsc(sq)+"' placeholder='Search gifts'''),
    P("idx-esc-ob-noresults", "onboarding gift search: no-results line", r'''No results for \""+sq+"\"''', r'''No results for \""+giftEsc(sq)+"\"'''),
    P("idx-esc-ob-addq", "onboarding gift search: custom gift button data",
      r'''data-q='"+sq+"' onclick='obCustomGift=this.dataset.q''', r'''data-q='"+giftEsc(sq)+"' onclick='obCustomGift=this.dataset.q'''),
    P("idx-esc-ob-addlabel", "onboarding gift search: custom gift button label", r'''+ Add \""+sq+"\" as my gift''', r'''+ Add \""+giftEsc(sq)+"\" as my gift'''),
    P("idx-esc-ob-custom", "onboarding: chosen custom gift", r'''Custom: "+obCustomGift+"''', r'''Custom: "+giftEsc(obCustomGift)+"'''),
    P("idx-esc-ob-logo", "onboarding: logo preview src", r'''<img src='"+obLogoUrl+"''', r'''<img src='"+giftEsc(obLogoUrl)+"'''),
    P("idx-esc-ob-logoname", "onboarding: logo file name", r'''margin-top:1px'>"+obLogoName+"</div>''', r'''margin-top:1px'>"+giftEsc(obLogoName)+"</div>'''),
    P("idx-esc-ob-step3-label", "onboarding step 3: business label", r''''>"+B.l+"</strong>. Don't see yours?''', r''''>"+giftEsc(B.l)+"</strong>. Don't see yours?'''),
    P("idx-esc-ob-confirm-email", "onboarding: check-your-email address", r'''<strong style="color:#F0F4FF">${obE}</strong>''', r'''<strong style="color:#F0F4FF">${giftEsc(obE)}</strong>'''),
    P("idx-esc-ob-first", "onboarding: first name", r'''value="${(obNm||'').split(' ')[0]||''}"''', r'''value="${giftEsc((obNm||'').split(' ')[0]||'')}"'''),
    P("idx-esc-ob-last", "onboarding: last name", r'''value="${(obNm||'').split(' ').slice(1).join(' ')}"''', r'''value="${giftEsc((obNm||'').split(' ').slice(1).join(' '))}"'''),
    P("idx-esc-ob-email", "onboarding: email", r'''value="${S?(S.user?.email||obE):obE}"''', r'''value="${giftEsc(S?(S.user?.email||obE):obE)}"'''),
    P("idx-esc-ob-pw", "onboarding: password field", r'''value="${obPw}"''', r'''value="${giftEsc(obPw)}"'''),
    P("idx-esc-ob-phone", "onboarding: phone", r'''value="${obPh}"''', r'''value="${giftEsc(obPh)}"'''),
    P("idx-esc-ob-name", "onboarding: business name", r'''value="${obN}"''', r'''value="${giftEsc(obN)}"'''),
    P("idx-esc-ob-bphone", "onboarding: business phone", r'''value="${obBph}"''', r'''value="${giftEsc(obBph)}"'''),
    P("idx-esc-ob-bemail", "onboarding: business email", r'''value="${obBem}"''', r'''value="${giftEsc(obBem)}"'''),
    P("idx-esc-ob-addr", "onboarding: street", r'''value="${obAddr}"''', r'''value="${giftEsc(obAddr)}"'''),
    P("idx-esc-ob-addr2", "onboarding: unit", r'''value="${obAddr2}"''', r'''value="${giftEsc(obAddr2)}"'''),
    P("idx-esc-ob-city", "onboarding: city", r'''value="${obCity}"''', r'''value="${giftEsc(obCity)}"'''),
    P("idx-esc-ob-state", "onboarding: state", r'''value="${obState}"''', r'''value="${giftEsc(obState)}"'''),
    P("idx-esc-ob-zip", "onboarding: ZIP", r'''value="${obZip}"''', r'''value="${giftEsc(obZip)}"'''),
    P("idx-esc-ob-golive-biz", "onboarding go-live: business label", r'''`${B?.l||"Business"} account`''', r'''`${giftEsc(B?.l||"Business")} account`'''),
    P("idx-esc-ob-golive-gift", "onboarding go-live: gift", r'''`Gift: ${obCustomGift||picked?.n||"--"}`''', r'''`Gift: ${giftEsc(obCustomGift||picked?.n||"--")}`'''),
    P("idx-esc-grid-noresults", "gift grid: no-results line", r'''No results for "+sq+"</div>''', r'''No results for "+giftEsc(sq)+"</div>'''),
    P("idx-esc-grid-addq", "gift grid: custom gift button data", r"""data-q='"+sq+"' onclick='addCustomGift(this)'""", r"""data-q='"+giftEsc(sq)+"' onclick='addCustomGift(this)'"""),
    P("idx-esc-grid-addlabel", "gift grid: custom gift button label", r'''+ Add "+sq+" as my gift</button>''', r'''+ Add "+giftEsc(sq)+" as my gift</button>'''),
    P("idx-esc-settings-pv", "Settings profile fields: full escape, not only quotes",
      r'''const pv=v=>(v==null?"":String(v)).replace(/"/g,"&quot;");''',
      r'''const pv=v=>giftEsc(v==null?"":String(v));'''),
    P("idx-esc-billing-line", "Settings billing card: plan and subscription status",
      r'''${blPlan||"—"} plan</span>${blStatus?` · <span style="color:${blStatusColor};font-weight:700">${blStatus}</span>`:""}''',
      r'''${giftEsc(blPlan||"—")} plan</span>${blStatus?` · <span style="color:${blStatusColor};font-weight:700">${giftEsc(blStatus)}</span>`:""}'''),
    P("idx-esc-protect-product", "campaign protection: stored product trigger",
      r'''value='"+p.productName+"' placeholder='e.g. Premium Package''',
      r'''value='"+giftEsc(p.productName)+"' placeholder='e.g. Premium Package'''),
    P("idx-esc-inquiry-email", "launch-inquiry email prefill",
      r'''value="${(pre||"").replace(/"/g,"&quot;")}"''',
      r'''value="${giftEsc(pre||"")}"'''),
    P("idx-esc-studio-thumb", "Brand Studio product thumbnails",
      r'''<img src="'+g.image_url+'" alt="" loading="lazy" style="max-width:100%;max-height:100%;object-fit:contain"/>''',
      r'''<img src="'+giftEsc(g.image_url)+'" alt="" loading="lazy" style="max-width:100%;max-height:100%;object-fit:contain"/>'''),
    P("idx-esc-ds-thumb", "Design Studio product thumbnails",
      r'''<img src="'+p.image_url+'" loading="lazy" style="max-width:100%;max-height:100%;object-fit:contain"/>''',
      r'''<img src="'+giftEsc(p.image_url)+'" loading="lazy" style="max-width:100%;max-height:100%;object-fit:contain"/>'''),

    # --- logo uploads (C4) -----------------------------------------------------------
    P("idx-logo-onboarding", "onboarding logo: C4 path, type and size",
      LOGO_UPLOAD_OLD_INDEX, LOGO_HELPERS_INDEX.replace(LOGO_UPLOAD_V1, LOGO_UPLOAD_V2),
      also=(LOGO_HELPERS_INDEX,)),
    P("idx-logo-design-studio", "Design Studio save: C4 path",
      r'''    var blob=await(await fetch(dataUrl)).blob();
    var path="logos/"+Date.now()+"-"+Math.random().toString(36).slice(2)+".png";
    var up=await fetch(SU+"/storage/v1/object/logos/"+path,{method:"POST",headers:{apikey:SK,Authorization:"Bearer "+(S.token||SK),"Content-Type":"image/png","Cache-Control":"3600"},body:blob});
    if(!up.ok)throw new Error("upload failed");
    var url=SU+"/storage/v1/object/public/logos/"+path;''',
      r'''    var blob=await(await fetch(dataUrl)).blob();
    var url=await ctLogoUpload(blob);'''),
    P("idx-logo-text-logo", "text logo: C4 path",
      r'''    var blob=await new Promise(function(res){cv.toBlob(res,"image/png");});
    if(!blob)throw new Error("render failed");
    var path="logos/"+Date.now()+"-"+Math.random().toString(36).slice(2)+".png";
    var r=await fetch(SU+"/storage/v1/object/logos/"+path,{method:"POST",headers:{apikey:SK,Authorization:"Bearer "+(S.token||SK),"Content-Type":"image/png","Cache-Control":"3600"},body:blob});
    if(!r.ok)throw new Error("upload failed");
    var url=SU+"/storage/v1/object/public/logos/"+path;''',
      r'''    var blob=await new Promise(function(res){cv.toBlob(res,"image/png");});
    if(!blob)throw new Error("render failed");
    var url=await ctLogoUpload(blob);'''),
    P("idx-logo-brand-studio", "Brand Studio logo upload: C4 path, type and size",
      r'''    var ext=(String(f.name).split(".").pop()||"png").toLowerCase().replace(/[^a-z0-9]/g,"")||"png";
    var path="logos/"+Date.now()+"-"+Math.random().toString(36).slice(2)+"."+ext; // same key pattern as onboarding's proven upload (satisfies the storage insert policy)
    var res=await fetch(SU+"/storage/v1/object/logos/"+path,{method:"POST",headers:{apikey:SK,Authorization:"Bearer "+(S.token||SK),"Content-Type":f.type||"image/png","Cache-Control":"3600"},body:f});
    if(!res.ok)throw new Error("upload failed");
    var url=SU+"/storage/v1/object/public/logos/"+path;''',
      r'''    var url=await ctLogoUpload(f);'''),
    # must come after idx-logo-onboarding, which writes the text this one replaces
    P("idx-logo-path-credential", "logo upload: folder and credential come from the same token (u/<uid>/ + user token, or anon/ + anon key)",
      LOGO_UPLOAD_V1, LOGO_UPLOAD_V2),

    # --- other ---------------------------------------------------------------------
    P("idx-a2p-auth", "texting registration sends the owner's login and shows server errors",
      r'''  fetch(FN+"/a2p-register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}).then(function(r){return r.json();}).then(function(d){''',
      r'''  var hdr={"Content-Type":"application/json"};if(typeof S!=="undefined"&&S&&S.token&&!DEMO)hdr.Authorization="Bearer "+S.token;
  fetch(FN+"/a2p-register",{method:"POST",headers:hdr,body:JSON.stringify(payload)}).then(function(r){return r.json().catch(function(){return {};}).then(function(d){if(!r.ok){var ex=new Error((d&&d.error)||"");ex.srv=true;throw ex;}return d;});}).then(function(d){'''),
    P("idx-a2p-error", "texting registration: show the server's error text",
      r'''  }).catch(function(){if(err){err.textContent="Something went wrong — please try again.";err.style.display="block";}if(btn){btn.textContent="Submit →";btn.disabled=false;}});''',
      r'''  }).catch(function(ex){if(err){err.textContent=(ex&&ex.srv&&ex.message)||"Something went wrong — please try again.";err.style.display="block";}if(btn){btn.textContent="Submit →";btn.disabled=false;}});'''),
    P("idx-checkout-login", "pricing checkout requires a login (checkout is no longer anonymous)",
      r'''async function checkoutPlan(plan,email){
  if(!email){''',
      r'''async function checkoutPlan(plan,email){
  if(!S){selPlan(plan);return;}
  if(!email){'''),
    P("idx-mfa-session", "turning on 2-step keeps the upgraded (aal2) session, refresh token included",
      r'''    if(vd.access_token){S.token=vd.access_token;localStorage.setItem("ct",vd.access_token);}''',
      r'''    if(vd.access_token)saveSession(vd);'''),
]


# ---------------------------------------------------------------------------------------
# free-pos-audit.html (live line and staged line)
# ---------------------------------------------------------------------------------------

AUTH_HELPERS_AUDIT = r'''function clearAuditFlow(){try{localStorage.removeItem("ct_audit");}catch(e){}}
// Login-CSRF guard, shared with the main app (same storage key): a session that arrives in a
// link is taken silently only for an email this browser asked a link for; otherwise the
// visitor first confirms which account they are about to use.
var AUTH_INTENT_KEY="ct_auth_intent";
function rememberAuthIntent(email,flow){var rec=JSON.stringify({email:String(email||"").trim().toLowerCase(),flow:flow||"",at:Date.now()});[sessionStorage,localStorage].forEach(function(st){try{st.setItem(AUTH_INTENT_KEY,rec);}catch(e){}});}
function hasAuthIntent(email){email=String(email||"").trim().toLowerCase();if(!email)return false;return [sessionStorage,localStorage].some(function(st){try{var r=JSON.parse(st.getItem(AUTH_INTENT_KEY)||"null");return !!(r&&r.email===email&&Date.now()-Number(r.at)<2*86400000);}catch(e){return false;}});}
function clearAuthIntent(){[sessionStorage,localStorage].forEach(function(st){try{st.removeItem(AUTH_INTENT_KEY);}catch(e){}});}
function acceptLinkSession(u){
  var email=String(u&&u.email||"").trim().toLowerCase(),cur=S&&S.user;
  if((cur&&cur.id&&cur.id===u.id)||hasAuthIntent(email)){clearAuthIntent();return true;}
  var ok=confirm("You're about to sign in as "+(email||"another account")+" — continue?"+(cur&&cur.email?"\n\nThis signs "+cur.email+" out on this device.":"")+"\n\nIf you didn't just ask Clicktide for a sign-in or confirmation link, choose Cancel.");
  if(ok)clearAuthIntent();
  return ok;
}'''

AUDIT = [
    P("fpa-auth-helpers", "login-CSRF helpers (auth intent marker + confirm prompt)",
      r'''function clearAuditFlow(){try{localStorage.removeItem("ct_audit");}catch(e){}}''',
      AUTH_HELPERS_AUDIT),
    P("fpa-auth-intent-signup", "sign-up remembers the email it asked a confirmation link for",
      r'''    var r=await fetch(SU+"/auth/v1/signup?redirect_to="+encodeURIComponent(location.origin+"/free-pos-audit?step=connect")''',
      r'''    rememberAuthIntent(email,"signup");
    var r=await fetch(SU+"/auth/v1/signup?redirect_to="+encodeURIComponent(location.origin+"/free-pos-audit?step=connect")'''),
    P("fpa-auth-intent-resend", "resend confirmation remembers the email",
      '  var email=$("confEmail").textContent;$("resendMsg").textContent=" Sending…";',
      '  var email=$("confEmail").textContent;$("resendMsg").textContent=" Sending…";rememberAuthIntent(email,"signup");'),
    P("fpa-auth-intent-reset", "password reset remembers the email (staged line only)",
      r'''  try{await fetch(FN+"/password-reset",{method:"POST",headers:{"Content-Type":"application/json",apikey:SK},body:JSON.stringify({email:em,redirect_to:"https://goclicktide.com/free-pos-audit"})});}catch(x){}''',
      r'''  rememberAuthIntent(em,"recovery");
  try{await fetch(FN+"/password-reset",{method:"POST",headers:{"Content-Type":"application/json",apikey:SK},body:JSON.stringify({email:em,redirect_to:"https://goclicktide.com/free-pos-audit"})});}catch(x){}''',
      needs='redirect_to:"https://goclicktide.com/free-pos-audit"'),
    P("fpa-auth-accept-recovery", "reset link: confirm before adopting its session (staged line only)",
      r'''      if(ru&&ru.id){RECOVERY_TOKEN=ht;saveSession(''',
      r'''      if(ru&&ru.id&&!acceptLinkSession(ru)){var resetDeclined=true;ru=null;}
      if(ru&&ru.id){RECOVERY_TOKEN=ht;saveSession(''',
      needs='var RECOVERY_TOKEN=""'),
    P("fpa-auth-recovery-cancel", "reset link declined at the prompt: say so instead of 'expired' (staged line only)",
      r'''    show("flow","pForgot");err("fpErr","That reset link has expired or was already used. Request a new one.");return;''',
      r'''    show("flow","pForgot");err("fpErr",resetDeclined?"Reset cancelled — request a new link if you meant to reset your password.":"That reset link has expired or was already used. Request a new one.");return;''',
      needs='var RECOVERY_TOKEN=""'),
    P("fpa-auth-accept", "confirmation link: confirm before adopting its session",
      r'''      if(u&&u.id){saveSession({access_token:ht,''',
      r'''      if(u&&u.id&&acceptLinkSession(u)){saveSession({access_token:ht,'''),
    P("fpa-ensure-biz-race", "business row created in another tab: reuse it instead of failing",
      r'''  var d=await rest("/rest/v1/clicktide",{method:"POST",headers:{Prefer:"return=representation"},body:JSON.stringify(row)});
  return Array.isArray(d)?d[0]:d;''',
      r'''  var d;
  try{d=await rest("/rest/v1/clicktide",{method:"POST",headers:{Prefer:"return=representation"},body:JSON.stringify(row)});}
  catch(e){
    // Another tab created the row first (one business row per user).
    var again=await rest("/rest/v1/clicktide?user_id=eq."+S.user.id+"&select=id,business_name,stripe_subscription_status,churn_days&limit=1");
    if(Array.isArray(again)&&again[0])return again[0];
    throw e;
  }
  return Array.isArray(d)?d[0]:d;'''),
    P("fpa-connect-who", "connect step says which account the POS will be connected to",
      r'''async function goConnect(){
  show("flow","pConnect");''',
      r'''async function goConnect(){
  show("flow","pConnect");
  var who=$("conWho");if(!who){who=document.createElement("p");who.id="conWho";who.className="note";var lead=$("pConnect").querySelector(".lead");lead.parentNode.insertBefore(who,lead.nextSibling);}
  who.textContent=S&&S.user&&S.user.email?"Signed in as "+S.user.email:"";'''),
    P("fpa-oauth-start", "connect uses oauth-start; the page no longer writes oauth_states",
      r'''async function oauthState(platform,meta){
  var state=randomState();
  await rest("/rest/v1/oauth_states",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({state:state,user_id:S.user.id,platform:platform,metadata:Object.assign({audit:true},meta||{}),expires_at:new Date(Date.now()+10*60*1000).toISOString()})});
  sessionStorage.setItem("ct_oauth_state",JSON.stringify(Object.assign({platform:platform,state:state},meta||{})));
  return state;
}''',
      r'''// POS connect (contract C3): oauth-start makes the OAuth state for the signed-in owner and
// returns the provider's consent page; the callback comes back here with a one-time nonce.
async function oauthStart(platform,meta){
  if(typeof DEMO!=="undefined"&&DEMO)return "https://demo.invalid/oauth/"+platform; // demo stops before leaving the page
  var res=await fnCall("oauth-start",Object.assign({platform:platform,flow:"audit"},meta||{}));
  if(!res.ok||!/^https:\/\//.test(String(res.data&&res.data.url||"")))throw new Error((res.data&&res.data.error)||"please try again in a moment.");
  sessionStorage.setItem("ct_oauth_state",JSON.stringify(Object.assign({platform:platform,state:"server"},meta||{})));
  return res.data.url;
}'''),
    # One patch per provider, so the two page lines (prompt vs inline Shopify box, demo stop)
    # both match.
    P("fpa-oauth-square", "Square button calls oauth-start",
      r'''      var st=await oauthState("square");
      u="https://connect.squareup.com/oauth2/authorize?"+new URLSearchParams({client_id:SQ_APP_ID,scope:"MERCHANT_PROFILE_READ ORDERS_READ PAYMENTS_READ CUSTOMERS_READ",redirect_uri:FN+"/square-oauth-callback",state:st,session:"false"});''',
      r'''      u=await oauthStart("square");'''),
    P("fpa-oauth-shopify", "Shopify button calls oauth-start",
      r'''      var st2=await oauthState("shopify",{shop_domain:dom});
      u="https://"+dom+"/admin/oauth/authorize?"+new URLSearchParams({client_id:SH_CLIENT_ID,scope:"read_orders,read_customers",redirect_uri:FN+"/shopify-oauth-callback",state:st2});''',
      r'''      u=await oauthStart("shopify",{shop_domain:dom});'''),
    P("fpa-oauth-clover", "Clover button calls oauth-start",
      r'''      var st3=await oauthState("clover");
      u="https://www.clover.com/oauth/authorize?"+new URLSearchParams({client_id:CL_APP_ID,redirect_uri:FN+"/clover-oauth-callback",state:st3});''',
      r'''      u=await oauthStart("clover");'''),
    P("fpa-oauth-stripe", "Stripe button calls oauth-start",
      r'''      var st4=await oauthState("stripe");
      u="https://connect.stripe.com/oauth/authorize?"+new URLSearchParams({response_type:"code",client_id:ST_CLIENT_ID,scope:"read_only",redirect_uri:FN+"/stripe-oauth-callback",state:st4});''',
      r'''      u=await oauthStart("stripe");'''),
    P("fpa-oauth-return", "return from the provider: confirm the pending grant; legacy ct_platform allowlisted",
      r'''  var ctPlatform=params.get("ct_platform"),ctError=params.get("ct_error"),step=params.get("step"),rep=params.get("report");
  if(ctError){''',
      r'''  var ctPlatform=params.get("ct_platform"),ctError=params.get("ct_error"),step=params.get("step"),rep=params.get("report");
  if(params.get("ct_oauth")==="pending"){
    var pend=params.get("ct_pending")||"";
    history.replaceState({},"",location.pathname);
    if(!S){markAuditFlow();show("flow","pLogin");err("logErr","Your session ended before the connection finished. Log in, then connect your POS again.");return;}
    var cr=await fnCall("oauth-confirm",{pending:pend});
    if(!cr.ok||!cr.data||!cr.data.ok){await goConnect();err("conErr",((cr.data&&cr.data.error)||"The connection didn't complete.")+" You can try again — nothing was changed in your POS.");track("connect_failed");return;}
    sessionStorage.removeItem("ct_oauth_state");
    track("connect_completed",{platform:cr.data.platform});
    try{await ensureBiz({});}catch(e){}
    startAudit(cr.data.platform);return;
  }
  if(ctPlatform&&!POS.some(function(p){return p.id===ctPlatform;}))ctPlatform=null;
  if(ctError){'''),
]


# ---------------------------------------------------------------------------------------
# backoffice.html
# ---------------------------------------------------------------------------------------

BO_CSP = ("<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; "
          "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
          "font-src https://fonts.gstatic.com; img-src 'self' data: https:; "
          "connect-src 'self' https://hmihfncvahsdlmefyxyg.supabase.co; base-uri 'none'; form-action 'none'; "
          "object-src 'none'\"/>\n<title>Clicktide Back Office</title>")

BO_SIGNIN_OLD = r'''async function signIn(){const e=document.getElementById("email").value,p=document.getElementById("pw").value,err=document.getElementById("err");err.style.display="none";try{const r=await fetch(`${SU}/auth/v1/token?grant_type=password`,{method:"POST",headers:{apikey:SK,"Content-Type":"application/json"},body:JSON.stringify({email:e,password:p})});const d=await r.json();if(d.error)throw new Error(d.error.message);S={token:d.access_token,user:d.user};localStorage.setItem("ct_bo",S.token);localStorage.setItem("ct_bou",JSON.stringify(S.user));await load();}catch(ex){err.textContent=ex.message;err.style.display="block";}}
function signOut(){localStorage.removeItem("ct_bo");localStorage.removeItem("ct_bou");S=null;staff=null;clients=[];active=null;render();}'''

BO_SIGNIN_NEW = r'''function storeStaff(d){S={token:d.access_token,user:d.user||(S&&S.user)||null};try{sessionStorage.setItem("ct_bo",S.token);sessionStorage.setItem("ct_bou",JSON.stringify(S.user));}catch{}}
function clearStaff(){["ct_bo","ct_bou"].forEach(k=>{try{sessionStorage.removeItem(k);localStorage.removeItem(k);}catch{}});}
function jwtAal(t){try{return JSON.parse(atob(String(t).split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).aal||"";}catch{return ""}}
function totpFactor(u){return ((u&&u.factors)||[]).find(f=>f.status==="verified"&&f.factor_type==="totp")||null}
// Staff powers need an MFA (aal2) session (contract C6). An account with an authenticator is
// always asked for its code, after typing its password and when an older session resumes.
async function signIn(){const e=document.getElementById("email").value,p=document.getElementById("pw").value,err=document.getElementById("err");err.style.display="none";try{const r=await fetch(`${SU}/auth/v1/token?grant_type=password`,{method:"POST",headers:{apikey:SK,"Content-Type":"application/json"},body:JSON.stringify({email:e,password:p})});const d=await r.json().catch(()=>({}));if(!r.ok||!d.access_token)throw new Error(d.msg||d.error_description||(d.error&&d.error.message)||"Wrong email or password.");const f=totpFactor(d.user);if(f&&jwtAal(d.access_token)!=="aal2"){mfaPending={token:d.access_token,user:d.user,factor:f.id};render();return}storeStaff(d);await load();}catch(ex){err.textContent=ex.message;err.style.display="block";}}
async function verifyMfa(){const code=(document.getElementById("mfaCode")?.value||"").trim(),err=document.getElementById("err"),p=mfaPending;err.style.display="none";if(!p){render();return}if(!/^\d{6}$/.test(code)){err.textContent="Enter the 6-digit code from your authenticator app.";err.style.display="block";return}try{const hd={apikey:SK,Authorization:"Bearer "+p.token,"Content-Type":"application/json"};const c=await fetch(`${SU}/auth/v1/factors/${p.factor}/challenge`,{method:"POST",headers:hd,body:"{}"});const cd=await c.json().catch(()=>({}));if(!c.ok||!cd.id)throw new Error("Couldn't start the code check — log in again.");const v=await fetch(`${SU}/auth/v1/factors/${p.factor}/verify`,{method:"POST",headers:hd,body:JSON.stringify({challenge_id:cd.id,code})});const vd=await v.json().catch(()=>({}));if(!v.ok||!vd.access_token)throw new Error("Wrong code — try again.");mfaPending=null;storeStaff(Object.assign({},vd,{user:vd.user||p.user}));await load();}catch(ex){err.textContent=ex.message;err.style.display="block";}}
function cancelMfa(){mfaPending=null;clearStaff();S=null;render();}
function signOut(){clearStaff();S=null;staff=null;clients=[];active=null;mfaPending=null;render();}
function mfaCard(){return `<div class="login"><div class="card"><div class="logo">CLICK<span style="color:#4DA6FF">TIDE</span></div><div class="title" style="font-size:22px;margin-bottom:4px">Two-step verification</div><div class="muted">Enter the 6-digit code from your authenticator app.</div><div class="field"><div class="label">Code</div><input class="input" id="mfaCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" onkeydown="if(event.key==='Enter')verifyMfa()"></div><button class="btn gold" style="width:100%;margin-top:18px" onclick="verifyMfa()">Verify</button><button class="btn ghost" style="width:100%;margin-top:10px" onclick="cancelMfa()">Cancel</button><div id="err" class="err"></div></div></div>`}'''

BO_LOAD_OLD = r'''async function load(){if(!S){render();return}try{const st=await api(`${SU}/rest/v1/clicktide_staff?select=role,is_active&user_id=eq.${S.user.id}`);staff=Array.isArray(st)?st[0]:null;if(!staff||!staff.is_active)throw new Error("This login is not approved for back office access.");clients=await api(`${SU}/rest/v1/clicktide?select=*&order=created_at.desc`);if(!Array.isArray(clients))clients=[];active=active||clients[0]||null;render();await loadTab();}catch(ex){localStorage.removeItem("ct_bo");localStorage.removeItem("ct_bou");S=null;render(ex.message);}}'''

BO_LOAD_NEW = r'''async function load(){if(!S){render();return}try{const me=await api(`${SU}/auth/v1/user`);const f=totpFactor(me);if(f&&jwtAal(S.token)!=="aal2"){mfaPending={token:S.token,user:me,factor:f.id};clearStaff();S=null;render();return}S.user=me;const st=await api(`${SU}/rest/v1/clicktide_staff?select=role,is_active&user_id=eq.${me.id}`);staff=Array.isArray(st)?st[0]:null;if(!staff||!staff.is_active)throw new Error(f?"This login is not approved for back office access.":"This login is not approved for back office access. Staff accounts need two-step verification: turn it on in the Clicktide app (Settings → Security), then log in here again.");clients=await api(`${SU}/rest/v1/clicktide?select=*&order=created_at.desc`);if(!Array.isArray(clients))clients=[];active=active||clients[0]||null;render();await loadTab();}catch(ex){clearStaff();S=null;render(ex.message);}}'''

BO_LOGVIEW_MARK = "async function logView("
_LV_AT = 'clients=await api(`${SU}/rest/v1/clicktide?select=*&order=created_at.desc`);'
_LV_CALL = 'await logView(null,"client_list");'
assert BO_LOAD_OLD.count(_LV_AT) == 1 and BO_LOAD_NEW.count(_LV_AT) == 1
BO_LOAD_OLD_LV = BO_LOAD_OLD.replace(_LV_AT, _LV_CALL + _LV_AT)
BO_LOAD_NEW_LV = BO_LOAD_NEW.replace(_LV_AT, _LV_CALL + _LV_AT)

BO_REFUND_OLD = r'''async function saveWalletRefund(balance){const amt=Number(document.getElementById("wrAmount")?.value||0);const note=document.getElementById("wrNote")?.value||"";const err=document.getElementById("wrErr");if(!amt||amt<=0||amt>Number(balance||0)){err.textContent="Enter a refund amount greater than $0 and not more than the current balance.";err.style.display="block";return}try{await api(`${SU}/rest/v1/wallet`,{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({user_id:active.user_id,desc:"Unused gift wallet refund",amount:-amt,balance:Number(balance||0)-amt,transaction_type:"refund",note,created_by:S.user.id})});document.querySelector(".login[style*='fixed']")?.remove();await loadTab();}catch(ex){err.textContent=ex.message;err.style.display="block"}}'''

BO_REFUND_NEW = r'''// The database computes the new balance itself (wallet ledger guard). The value sent is only
// the fallback for a database without that guard, so it is read fresh here, not taken from
// when the panel was opened.
async function saveWalletRefund(balance){const amt=Math.round(Number(document.getElementById("wrAmount")?.value||0)*100)/100;const note=document.getElementById("wrNote")?.value||"";const err=document.getElementById("wrErr");const bad=m=>{err.textContent=m;err.style.display="block"};if(!amt||amt<=0)return bad("Enter a refund amount greater than $0 and not more than the current balance.");try{const last=await api(`${SU}/rest/v1/wallet?select=balance&user_id=eq.${active.user_id}&order=created_at.desc&limit=1`);const cur=Number(Array.isArray(last)&&last[0]?last[0].balance:0);if(amt>cur)return bad("Enter a refund amount greater than $0 and not more than the current balance ($"+cur.toFixed(2)+").");await api(`${SU}/rest/v1/wallet`,{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({user_id:active.user_id,desc:"Unused gift wallet refund",amount:-amt,balance:Math.round((cur-amt)*100)/100,transaction_type:"refund",note,created_by:S.user.id})});document.querySelector(".login[style*='fixed']")?.remove();await loadTab();}catch(ex){bad(ex.message)}}'''

BO_PROFILE_OLD = r'''async function saveProfile(){const g=id=>document.getElementById(id).value;await api(`${SU}/rest/v1/clicktide?user_id=eq.${active.user_id}`,{method:"PATCH",headers:{Prefer:"return=representation"},body:JSON.stringify({business_name:g("bn"),contact_name:g("cn"),business_email:g("be"),business_phone:g("bp"),address:g("ad")})});Object.assign(active,{business_name:g("bn"),contact_name:g("cn"),business_email:g("be"),business_phone:g("bp"),address:g("ad")});document.getElementById("saveMsg").textContent="Saved";}'''

BO_PROFILE_NEW = r'''async function saveProfile(){const g=id=>document.getElementById(id).value,msg=document.getElementById("saveMsg");try{const rows=await api(`${SU}/rest/v1/clicktide?user_id=eq.${active.user_id}`,{method:"PATCH",headers:{Prefer:"return=representation"},body:JSON.stringify({business_name:g("bn"),contact_name:g("cn"),business_email:g("be"),business_phone:g("bp"),address:g("ad")})});if(!Array.isArray(rows)||!rows.length)throw new Error("this login can't edit that client right now (two-step verification may be required).");Object.assign(active,{business_name:g("bn"),contact_name:g("cn"),business_email:g("be"),business_phone:g("bp"),address:g("ad")});msg.textContent="Saved";}catch(ex){msg.textContent="Not saved: "+ex.message;}}'''

# Back office wallet panel: same ledger kind contract as the dashboard Wallet tab.
BO_WALLET_HELPER = r'''// Wallet totals (wallet ledger kind contract). Added: topup, dispute_reinstated. Spent: gift_debit,
// postcard_debit, sms_overage, each net of its <debit>_refund (older 'reversal' rows are gift
// refunds). refund = money returned to the client; dispute / debt_recovery = chargebacks. None
// of those three is spend.
function walletTotals(tx){const t={added:0,spent:0,refunded:0,withheld:0,other:0};(Array.isArray(tx)?tx:[]).forEach(r=>{const a=Number(r&&r.amount);if(!isFinite(a)||!a)return;const k=String((r&&r.transaction_type)||"").trim().toLowerCase();if(k==="topup"||k==="dispute_reinstated")t.added+=a;else if(["gift_debit","gift_refund","reversal","postcard_debit","postcard_refund","sms_overage","sms_overage_refund"].includes(k))t.spent-=a;else if(k==="refund")t.refunded-=a;else if(k==="dispute"||k==="debt_recovery")t.withheld-=a;else if(!k){if(a>0)t.added+=a;else t.spent-=a;}else t.other+=a;});Object.keys(t).forEach(k=>{t[k]=Math.round(t[k]*100)/100;if(Math.abs(t[k])<0.005)t[k]=0;});return t}
async function walletPanel(p){'''

BO_WALLET_TOTALS_OLD = r'''const added=tx.filter(t=>Number(t.amount)>0).reduce((a,t)=>a+Number(t.amount||0),0);const spent=tx.filter(t=>Number(t.amount)<0&&t.transaction_type!=="refund").reduce((a,t)=>a+Math.abs(Number(t.amount||0)),0);const refunded=tx.filter(t=>t.transaction_type==="refund").reduce((a,t)=>a+Math.abs(Number(t.amount||0)),0);'''

BO_WALLET_TOTALS_NEW = r'''const wt=walletTotals(tx),added=wt.added,spent=wt.spent,refunded=wt.refunded,withheld=wt.withheld;'''

BO_WALLET_STAT_OLD = r'''<div class="stat"><small>Refunded</small><b>$${refunded.toFixed(2)}</b></div></div>'''

BO_WALLET_STAT_NEW = r'''<div class="stat"><small>Refunded</small><b>$${refunded.toFixed(2)}</b>${withheld?`<div class="muted" style="font-size:11px;margin-top:4px">Chargebacks &amp; repayments: $${withheld.toFixed(2)}</div>`:""}${wt.other?`<div class="muted" style="font-size:11px;margin-top:4px">Other adjustments: ${wt.other<0?"-":""}$${Math.abs(wt.other).toFixed(2)}</div>`:""}</div></div><div class="muted" style="margin:-6px 0 14px">Totals cover the transactions listed below (latest 100).</div>'''

BACKOFFICE = [
    P("bo-csp", "Content-Security-Policy: no third-party script files, fetch/XHR only to Supabase (inline script still allowed)",
      r'''<title>Clicktide Back Office</title>''', BO_CSP),
    P("bo-session-store", "staff token kept per tab (sessionStorage); old localStorage copies wiped",
      r'''try{S={token:localStorage.getItem("ct_bo"),user:JSON.parse(localStorage.getItem("ct_bou")||"null")};if(!S.token)S=null;}catch{S=null}''',
      r'''// Staff sessions stay in this tab only, apart from the dashboard's long-lived login; copies an
// older back office left in localStorage are wiped.
try{localStorage.removeItem("ct_bo");localStorage.removeItem("ct_bou");}catch{}
try{S={token:sessionStorage.getItem("ct_bo"),user:JSON.parse(sessionStorage.getItem("ct_bou")||"null")};if(!S.token)S=null;}catch{S=null}
let mfaPending=null;''', also=('let mfaPending=null,mfaEnroll=null;',)),
    P("bo-signin-mfa", "sign-in asks for the TOTP code (C6 step-up)", BO_SIGNIN_OLD, BO_SIGNIN_NEW, also=('if(!f){await startEnroll(d.access_token,d.user);return}',)),
    P("bo-load-mfa", "a resumed aal1 session of an MFA account is stepped up before staff data loads",
      BO_LOAD_OLD, BO_LOAD_NEW, unless=BO_LOGVIEW_MARK),
    # Production line with the staff access log (other session, 2026-11-27): same patch, the
    # logView(null,"client_list") call kept where it was (after the staff check, before the
    # client list is read), so the step-up still happens before anything is read or logged.
    P("bo-load-mfa-logview", "same step-up, on the back office that logs staff access (clicktide_log_staff_access)",
      BO_LOAD_OLD_LV, BO_LOAD_NEW_LV, needs=BO_LOGVIEW_MARK, also=('if(!f){const t=S.token;clearStaff();S=null;await startEnroll(t,me);return}',)),
    P("bo-render-mfa", "login screen shows the code step while it is pending",
      r'''function render(message){if(!S){document.getElementById("app").innerHTML=login();''',
      r'''function render(message){if(!S){document.getElementById("app").innerHTML=mfaPending?mfaCard():login();''', also=('innerHTML=mfaEnroll?enrollCard():mfaPending?mfaCard():login();',)),
    P("bo-profile-errors", "client profile save reports refused or failed writes", BO_PROFILE_OLD, BO_PROFILE_NEW),
    P("bo-refund-balance", "wallet refund: balance re-read at submit; the database computes the real one",
      BO_REFUND_OLD, BO_REFUND_NEW),
    P("bo-wallet-helper", "wallet panel: totals helper following the ledger kind contract",
      r'''async function walletPanel(p){''', BO_WALLET_HELPER),
    P("bo-wallet-totals", "wallet panel: Added / Spent net of *_refund rows; refunds and chargebacks are not spend",
      BO_WALLET_TOTALS_OLD, BO_WALLET_TOTALS_NEW),
    P("bo-wallet-stat", "wallet panel: chargebacks / other adjustments shown under Refunded when present",
      BO_WALLET_STAT_OLD, BO_WALLET_STAT_NEW),
    P("bo-refund-copy","wallet panel: Stripe refunds now come off the wallet automatically (WP1)",
      r'''Issue the money refund in Stripe or your payment processor first, then record it here to reduce the Clicktide wallet balance.''',
      r'''Refunds issued in Stripe come off the wallet automatically; use this only for refunds paid outside Stripe.'''),
    P("bo-refund-modal-copy", "refund modal: same rule",
      r'''This lowers the client gift wallet balance. Only use it after you have issued the actual money refund outside Clicktide.''',
      r'''This lowers the client gift wallet balance. Use it only for a refund paid outside Stripe — refunds issued in Stripe come off the wallet automatically.'''),
    # -- TOTP enrollment inside the back office (C6). The app's Settings card was never wired
    #    in, so staff had no way to add an authenticator. A login without a verified TOTP
    #    factor must enroll one here before anything else; the staff check runs only on the
    #    resulting aal2 session, so a non-staff login still gets "not approved".
    P("bo-enroll-state", "back office: enrollment state",
      r'''let mfaPending=null;''',
      r'''let mfaPending=null,mfaEnroll=null;'''),
    P("bo-enroll-signin", "back office: a login without an authenticator is sent to enrollment",
      r'''const f=totpFactor(d.user);if(f&&jwtAal(d.access_token)!=="aal2"){mfaPending={token:d.access_token,user:d.user,factor:f.id};render();return}storeStaff(d);await load();''',
      r'''const f=totpFactor(d.user);if(f&&jwtAal(d.access_token)!=="aal2"){mfaPending={token:d.access_token,user:d.user,factor:f.id};render();return}if(!f){await startEnroll(d.access_token,d.user);return}storeStaff(d);await load();'''),
    P("bo-enroll-resume", "back office: a resumed session without an authenticator is sent to enrollment",
      r'''const f=totpFactor(me);if(f&&jwtAal(S.token)!=="aal2"){mfaPending={token:S.token,user:me,factor:f.id};clearStaff();S=null;render();return}''',
      r'''const f=totpFactor(me);if(f&&jwtAal(S.token)!=="aal2"){mfaPending={token:S.token,user:me,factor:f.id};clearStaff();S=null;render();return}if(!f){const t=S.token;clearStaff();S=null;await startEnroll(t,me);return}'''),
    P("bo-enroll-render", "back office: render the enrollment card",
      r'''document.getElementById("app").innerHTML=mfaPending?mfaCard():login();''',
      r'''document.getElementById("app").innerHTML=mfaEnroll?enrollCard():mfaPending?mfaCard():login();'''),
    P("bo-enroll-signout", "back office: sign-out clears enrollment",
      r'''function signOut(){clearStaff();S=null;staff=null;clients=[];active=null;mfaPending=null;render();}''',
      r'''function signOut(){clearStaff();S=null;staff=null;clients=[];active=null;mfaPending=null;mfaEnroll=null;render();}'''),
    P("bo-enroll-fns", "back office: enroll / verify an authenticator (Supabase TOTP factors API)",
      r'''function cancelMfa(){mfaPending=null;clearStaff();S=null;render();}''',
      r'''function cancelMfa(){mfaPending=null;clearStaff();S=null;render();}
// First sign-in without an authenticator. Only active staff are offered setup (checked with
// clicktide_is_staff_member(), which answers for the caller alone and does not need aal2), so a
// customer who wanders in never gets a factor added to their main login. Unverified leftovers
// are removed, a TOTP factor is created, its QR code (GoTrue returns raw SVG) and secret are
// shown, and nothing is stored until one code verifies; the verified session is aal2.
async function startEnroll(token,user){const hd={apikey:SK,Authorization:"Bearer "+token,"Content-Type":"application/json"};try{if(((user&&user.factors)||[]).some(x=>x.status==="verified"))throw new Error("This login already uses a different two-step method. The back office needs an authenticator app — ask an admin to reset your two-step settings.");const sr=await fetch(`${SU}/rest/v1/rpc/clicktide_is_staff_member`,{method:"POST",headers:hd,body:"{}"});const sj=await sr.json().catch(()=>null);if(!sr.ok||sj!==true)throw new Error("This login is not approved for back office access.");for(const f of ((user&&user.factors)||[]).filter(x=>x.status!=="verified")){await fetch(`${SU}/auth/v1/factors/${encodeURIComponent(f.id)}`,{method:"DELETE",headers:hd}).catch(()=>{})}const r=await fetch(`${SU}/auth/v1/factors`,{method:"POST",headers:hd,body:JSON.stringify({factor_type:"totp",friendly_name:"Clicktide back office "+new Date().toISOString().slice(0,16).replace("T"," "),issuer:"Clicktide"})});const d=await r.json().catch(()=>({}));const raw=String((d&&d.totp&&d.totp.qr_code)||"");const qr=/^data:image\/svg\+xml/.test(raw)?raw:/^\s*(<\?xml|<svg)/i.test(raw)?"data:image/svg+xml;utf8,"+encodeURIComponent(raw):"";if(!r.ok||!d.id||!d.totp||(!qr&&!d.totp.secret))throw new Error(d.msg||(d.error&&d.error.message)||d.message||"Couldn't start two-step setup — try again.");mfaPending=null;mfaEnroll={token,user,factor:d.id,qr,secret:String(d.totp.secret||"")};render();}catch(ex){mfaEnroll=null;render(ex.message);}}
function enrollCard(){const e=mfaEnroll;return `<div class="login"><div class="card"><div class="logo">CLICK<span style="color:#4DA6FF">TIDE</span></div><div class="title" style="font-size:22px;margin-bottom:4px">Set up two-step verification</div><div class="muted">The back office needs a code from an authenticator app every time you log in. Scan this QR code with your iPhone's Passwords app (or the camera), Google Authenticator or 1Password, then type the 6-digit code it shows.</div>${e.qr?`<div style="background:#fff;border-radius:12px;padding:12px;margin:16px auto 8px;width:200px;height:200px"><img src="${esc(e.qr)}" alt="QR code for your authenticator app" style="width:176px;height:176px;display:block"></div>`:""}<div class="muted" style="font-size:12px;text-align:center;word-break:break-all">Can't scan? Enter this key by hand:<br><b style="font-family:monospace;letter-spacing:1px">${esc(e.secret)}</b></div><div class="field"><div class="label">6-digit code</div><input class="input" id="enrollCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" onkeydown="if(event.key==='Enter')verifyEnroll()"></div><button class="btn gold" style="width:100%;margin-top:18px" onclick="verifyEnroll()">Turn on two-step</button><button class="btn ghost" style="width:100%;margin-top:10px" onclick="cancelEnroll()">Cancel</button><div id="err" class="err"></div></div></div>`}
async function verifyEnroll(){const code=(document.getElementById("enrollCode")?.value||"").trim(),err=document.getElementById("err"),e=mfaEnroll;err.style.display="none";if(!e){render();return}if(!/^\d{6}$/.test(code)){err.textContent="Enter the 6-digit code from your authenticator app.";err.style.display="block";return}try{const hd={apikey:SK,Authorization:"Bearer "+e.token,"Content-Type":"application/json"};const c=await fetch(`${SU}/auth/v1/factors/${encodeURIComponent(e.factor)}/challenge`,{method:"POST",headers:hd,body:"{}"});const cd=await c.json().catch(()=>({}));if(!c.ok||!cd.id)throw new Error("Couldn't start the code check — log in again.");const v=await fetch(`${SU}/auth/v1/factors/${encodeURIComponent(e.factor)}/verify`,{method:"POST",headers:hd,body:JSON.stringify({challenge_id:cd.id,code})});const vd=await v.json().catch(()=>({}));if(!v.ok||!vd.access_token)throw new Error("That code didn't match — check the time on your phone and try the newest code.");mfaEnroll=null;storeStaff(Object.assign({},vd,{user:vd.user||e.user}));await load();}catch(ex){err.textContent=ex.message;err.style.display="block";}}
function cancelEnroll(){const e=mfaEnroll;mfaEnroll=null;clearStaff();S=null;render();if(e){const hd={apikey:SK,Authorization:"Bearer "+e.token};fetch(`${SU}/auth/v1/factors/${encodeURIComponent(e.factor)}`,{method:"DELETE",headers:hd}).catch(()=>{}).then(()=>fetch(`${SU}/auth/v1/logout?scope=local`,{method:"POST",headers:hd})).catch(()=>{})}}'''),
]


# ---------------------------------------------------------------------------------------
# checkin.html
# ---------------------------------------------------------------------------------------

CHECKIN = [
    P("ck-esc-helper", "HTML-escape helper",
      r'''function fail(msg){var e=document.getElementById("err");e.textContent=msg;e.style.display="block";}''',
      r'''function fail(msg){var e=document.getElementById("err");e.textContent=msg;e.style.display="block";}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c];});}'''),
    P("ck-esc-name", "success card: first name", r'''var who=x.d.first_name||"there";''', r'''var who=esc(x.d.first_name||"there");'''),
    P("ck-esc-biz", "success card: business name",
      r'''"Thanks for coming back to "+(x.d.business_name||"us")+''',
      r'''"Thanks for coming back to "+esc(x.d.business_name||"us")+'''),
]

PAGES = {
    "index.html": (INDEX, "function giftEsc("),
    "free-pos-audit.html": (AUDIT, 'id="posGrid"'),
    "backoffice.html": (BACKOFFICE, "Clicktide Back Office"),
    "checkin.html": (CHECKIN, "functions/v1/checkin"),
}


# ---------------------------------------------------------------------------------------
# engine
# ---------------------------------------------------------------------------------------

def state_of(src, p):
    if p.needs is not None and p.needs not in src:
        return "n/a"
    if p.unless is not None and p.unless in src:
        return "n/a"
    n_old, n_new = src.count(p.old), src.count(p.new)
    if n_new == 1 and n_old == p.new.count(p.old):
        return "done"
    if n_old == 0 and n_new == 0 and any(src.count(t) == 1 for t in p.also):
        return "done"
    if n_old == 1 and n_new == 0:
        return "todo"
    return "error: anchor found %d time(s), patched text found %d time(s)" % (n_old, n_new)


def apply_all(src, patches):
    rows, bad = [], False
    for p in patches:
        st = state_of(src, p)
        if st == "todo":
            src = src.replace(p.old, p.new, 1)
            st2 = state_of(src, p)
            if st2 != "done":
                st, bad = "error: patched text not unique after applying (%s)" % st2, True
            else:
                st = "applied"
        elif st.startswith("error"):
            bad = True
        rows.append((p.pid, st, p.desc))
    return src, rows, bad


def inline_scripts(html):
    return re.findall(r"<script([^>]*)>(.*?)</script>", html, re.S)


def parse_check(html, tmpdir):
    """Parse every inline script the way scripts/preflight.sh does."""
    node = shutil.which("node")
    osa = shutil.which("osascript")
    if not node and not osa:
        return ["skipped: neither node nor osascript is available"]
    out, n = [], 0
    for attrs, code in inline_scripts(html):
        if "src=" in attrs:
            continue
        if "application/ld+json" in attrs:
            try:
                json.loads(code)
            except Exception as e:  # noqa: BLE001
                out.append("FAIL JSON-LD: %s" % e)
            continue
        n += 1
        fd, path = tempfile.mkstemp(suffix=".js", dir=tmpdir)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(code)
        try:
            if osa:
                js = ("var t=$.NSString.stringWithContentsOfFileEncodingError('%s',4,null);"
                      "try{new Function(ObjC.unwrap(t));'PARSE_OK'}catch(e){'PARSE_FAIL: '+e.message}" % path)
                r = subprocess.run([osa, "-l", "JavaScript", "-e", js], capture_output=True, text=True)
                ok = "PARSE_OK" in (r.stdout or "")
                msg = (r.stdout or r.stderr).strip()
            else:
                r = subprocess.run([node, "--check", path], capture_output=True, text=True)
                ok, msg = r.returncode == 0, (r.stderr or "").strip()
        finally:
            os.unlink(path)
        if not ok:
            out.append("FAIL script #%d: %s" % (n, msg))
    out.append("%d inline script(s) parsed" % n)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path")
    ap.add_argument("--page", choices=sorted(PAGES))
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--tmp", default=None, help="directory for the parse check's temporary files")
    a = ap.parse_args()

    page = a.page or os.path.basename(a.path)
    if page not in PAGES:
        sys.exit("unknown page %r: pass --page (one of %s)" % (page, ", ".join(sorted(PAGES))))
    patches, signature = PAGES[page]
    with open(a.path, encoding="utf-8") as f:
        src = f.read()
    if signature not in src:
        sys.exit("%s does not look like Clicktide's %s (missing %r)" % (a.path, page, signature))

    new, rows, bad = apply_all(src, patches)
    width = max(len(r[0]) for r in rows)
    for pid, st, desc in rows:
        print("%-*s  %-8s %s" % (width, pid, st if not st.startswith("error") else "ERROR", desc))
        if st.startswith("error"):
            print("%*s  -> %s" % (width, "", st))
    if bad:
        print("\nNothing written: at least one anchor is missing or ambiguous.")
        sys.exit(1)
    applied = sum(1 for r in rows if r[1] == "applied")

    if a.verify:
        again, rows2, bad2 = apply_all(new, patches)
        if bad2 or again != new or any(r[1] == "applied" for r in rows2):
            print("\nVERIFY FAIL: a second run would change the file")
            sys.exit(1)
        print("\nverify: second run is a no-op")
        msgs = parse_check(new, a.tmp)
        for m in msgs:
            print("verify: " + m)
        if any(m.startswith("FAIL") for m in msgs):
            sys.exit(1)

    if a.check:
        print("\n--check: %d patch(es) would be applied; nothing written" % applied)
        return
    dest = a.out or a.path
    if dest != a.path or new != src:
        with open(dest, "w", encoding="utf-8") as f:
            f.write(new)
    print("\n%d patch(es) applied -> %s" % (applied, dest))


if __name__ == "__main__":
    main()
