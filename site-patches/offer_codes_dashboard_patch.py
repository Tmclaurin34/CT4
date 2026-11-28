#!/usr/bin/env python3
"""Dashboard pieces for one-time offer codes (store credit / perks).

Preview feature (2026-11-28). Needs migration 20261128050000_offer_codes.sql and the
offer-redeem function, which are NOT live yet, so everything here only shows in the demo
(?demo=1) or with ?planpreview=1 (ctPlanOn() from plan_ready_card_patch.py; apply that patch
first).

Adds:
1. Settings: "Redeem codes on this device". Registers the device (clicktide_redeem_device_register)
   and keeps its token in this browser; staff then just scan a customer's QR with this device.
2. Campaign builder, Digital reward box: "Give each customer their own one-time code", plus
   credit ($ off) and minimum spend. Saved as campaigns.reward_unique / reward_credit /
   reward_min_spend.
3. Gifts page: "Offer codes" card with counts (sent, used, closed by a purchase, open) and
   the latest codes.

Idempotent. Usage: python3 site-patches/offer_codes_dashboard_patch.py [path/to/index.html]
"""
import sys
from pathlib import Path

MARK = "/*ct-offer-codes-dashboard*/"
path = Path(sys.argv[1] if len(sys.argv) > 1 else "index.html")
s = path.read_text(encoding="utf-8")
if MARK in s:
    print("already applied")
    sys.exit(0)
if "/*ct-plan-ready-card*/" not in s:
    sys.exit("apply plan_ready_card_patch.py first (it defines ctPlanOn)")

FUNC = r'''/*ct-offer-codes-dashboard*/
var cmRewUnique=false,cmRewCredit="",cmRewMin="";
var CT_DEV_KEY="ct_redeem_device";
function ctOfferOn(){try{return typeof ctPlanOn==="function"&&ctPlanOn();}catch(e){return false;}}
function ctMoney(n){n=Number(n)||0;return "$"+(Math.round(n*100)/100).toLocaleString();}
function ctRewPayload(isDigital){
  if(!ctOfferOn())return {};
  return {reward_unique:isDigital?!!cmRewUnique:false,
    reward_credit:isDigital&&cmRewUnique&&String(cmRewCredit).trim()!==""?Number(cmRewCredit):null,
    reward_min_spend:isDigital&&cmRewUnique&&String(cmRewMin).trim()!==""?Number(cmRewMin):null};
}
function ctRewSync(){
  var c=Number(cmRewCredit)||0,m=Number(cmRewMin)||0;
  if(cmRewUnique&&c>0&&!String(cmRewOffer||"").trim()){
    cmRewOffer=ctMoney(c)+" off your next visit"+(m>0?" ("+ctMoney(m)+"+)":"");
    var o=document.getElementById("cRewOffer");if(o)o.value=cmRewOffer;
  }
  var box=document.getElementById("ctRewUniqueBox");if(box)box.style.display=cmRewUnique?"block":"none";
}
function ctRewUniqueBlock(){
  if(!ctOfferOn())return "";
  return '<div style="background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.22);border-radius:10px;padding:10px 12px;margin-bottom:10px">'+
    '<label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer;font-size:12px;color:rgba(240,244,255,.85)"><input type="checkbox" '+(cmRewUnique?"checked":"")+' onchange="cmRewUnique=this.checked;ctRewSync()" style="margin-top:2px"/>'+
    '<span><b>Give each customer their own one-time code</b><br><span style="color:rgba(240,244,255,.5)">Each customer gets a code that works once, with a link staff scan at the counter. Forwarded or reused codes are refused.</span></span></label>'+
    '<div id="ctRewUniqueBox" style="display:'+(cmRewUnique?"block":"none")+';margin-top:10px"><div style="display:flex;gap:8px">'+
    '<div style="flex:1"><label class="fl">Credit ($ off)</label><input class="fi" type="number" min="0" step="1" value="'+giftEsc(cmRewCredit)+'" placeholder="10" oninput="cmRewCredit=this.value;ctRewSync()"/></div>'+
    '<div style="flex:1"><label class="fl">Minimum spend</label><input class="fi" type="number" min="0" step="1" value="'+giftEsc(cmRewMin)+'" placeholder="75" oninput="cmRewMin=this.value;ctRewSync()"/></div></div>'+
    '<div style="font-size:10px;color:rgba(240,244,255,.4);margin-top:4px">The code only works on a purchase of at least the minimum. It closes itself when the customer buys again.</div></div></div>';
}
function ctRedeemCard(){
  if(!ctOfferOn())return "";
  var has=false;try{has=!!localStorage.getItem(CT_DEV_KEY);}catch(e){}
  return '<div class="dc" style="margin-bottom:14px" id="ctRedeemCard"><div class="dct">Redeem offer codes at the counter</div>'+
    '<div style="font-size:13px;color:#646A73;line-height:1.6;margin:4px 0 10px">Set up the phone or tablet at your counter once. After that, staff just point its camera at a customer\'s code: the code is used straight away, with a 2-minute undo.</div>'+
    (has?'<div style="font-size:13px;font-weight:700;color:#1E874F;margin-bottom:8px">✓ This device can redeem codes</div><button class="btn btn-ghost" style="padding:8px 14px;font-size:12px" onclick="ctRedeemForget()">Remove from this device</button>'
       :'<button class="btn btn-gold" style="padding:9px 16px;font-size:13px" onclick="ctRedeemSetup(this)">Set up this device for redeeming</button>')+
    '<div id="ctRedeemMsg" style="font-size:12px;color:#646A73;margin-top:8px"></div></div>';
}
async function ctRedeemSetup(btn){
  if(btn){btn.disabled=true;btn.textContent="Setting up…";}
  try{
    var tok;
    if(typeof DEMO!=="undefined"&&DEMO){tok="demo-device-token-0000000000000000000000";}
    else{var r=await db.rpc("clicktide_redeem_device_register",{p_name:"Counter device"},S?.token);tok=r&&r.token;}
    if(!tok)throw new Error("Couldn't set up this device. Try again.");
    localStorage.setItem(CT_DEV_KEY,tok);
    var c=document.getElementById("ctRedeemCard");if(c)c.outerHTML=ctRedeemCard();
    var m=document.getElementById("ctRedeemMsg");if(m)m.textContent="Done. Scan a customer's code with this device's camera to redeem it.";
  }catch(e){if(btn){btn.disabled=false;btn.textContent="Set up this device for redeeming";}try{ctToast(e.message||"Couldn't set up this device.");}catch(_){}}
}
function ctRedeemForget(){try{localStorage.removeItem(CT_DEV_KEY);}catch(e){}var c=document.getElementById("ctRedeemCard");if(c)c.outerHTML=ctRedeemCard();}
function ctDemoCodes(){
  var cs=(typeof DEMO_DATA!=="undefined"&&DEMO_DATA&&DEMO_DATA.customers)||[],out=[],st=["used","used","closed","open","open","used","expired","open","used","closed"],via={used:"scan",closed:"pos_sync"};
  for(var i=0;i<Math.min(40,cs.length);i++){var s2=st[i%st.length],d=new Date(Date.now()-(i*13+3)*3600000);
    out.push({code:"JUNE-"+("K7Q3M9X2PB4T"[i%12])+"Q"+(i%10)+"M-"+("XBWT"[i%4])+"7K"+(i%9),customer:cs[(i*7)%cs.length].name,offer:"$10 off your next visit",status:s2,used_via:via[s2]||null,used_at:s2==="used"||s2==="closed"?d.toISOString():null,created_at:new Date(d.getTime()-86400000*3).toISOString()});}
  return out;
}
function ctOfferCodesCard(){
  if(!ctOfferOn())return "";
  setTimeout(ctLoadOfferCodes,0);
  return '<div class="dc" style="margin-bottom:14px" id="ctCodes"><div class="dct">Offer codes</div><div style="font-size:13px;color:#646A73">Loading…</div></div>';
}
async function ctLoadOfferCodes(){
  var el=document.getElementById("ctCodes");if(!el)return;
  var rows=[];
  try{
    if(typeof DEMO!=="undefined"&&DEMO)rows=ctDemoCodes();
    else{var r=await db.rpc("clicktide_offer_codes_for_owner",{p_limit:200},S?.token);rows=Array.isArray(r)?r:[];}
  }catch(e){rows=[];}
  var n=rows.length,used=rows.filter(function(x){return x.status==="used";}).length,closed=rows.filter(function(x){return x.status==="closed";}).length,open=rows.filter(function(x){return x.status==="open";}).length;
  var stat=function(v,l,c){return '<div style="flex:1;min-width:90px;background:#F7F9FC;border-radius:10px;padding:10px 12px"><div style="font-size:20px;font-weight:800;color:'+(c||"#0F1115")+'">'+v+'</div><div style="font-size:11px;color:#646A73">'+l+'</div></div>';};
  var pill={used:["Used at the counter","#1E874F","rgba(34,197,94,.10)"],closed:["Closed by a purchase","#0B62D6","rgba(11,98,214,.08)"],open:["Open","#8A5A00","rgba(255,209,102,.18)"],expired:["Expired","#646A73","rgba(16,18,21,.06)"]};
  var list=rows.slice(0,8).map(function(x){var p=pill[x.status]||pill.open;return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-top:1px solid rgba(16,18,21,.06);font-size:12.5px"><div><div style="font-weight:700;color:#0F1115">'+giftEsc(x.customer||"Customer")+'</div><div style="color:#646A73;font-family:ui-monospace,Menlo,monospace;font-size:11.5px">'+giftEsc(x.code)+'</div></div><span style="font-size:11px;font-weight:700;color:'+p[1]+';background:'+p[2]+';border-radius:999px;padding:3px 9px;white-space:nowrap">'+p[0]+'</span></div>';}).join("");
  el.innerHTML='<div class="dct">Offer codes</div><div style="font-size:13px;color:#646A73;margin:2px 0 10px">One-time codes sent to customers. Each works once.</div>'+
    (n?'<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">'+stat(n,"Sent")+stat(used,"Used at the counter","#1E874F")+stat(closed,"Closed by a purchase","#0B62D6")+stat(open,"Still open")+'</div>'+list
      :'<div style="font-size:13px;color:#646A73">No codes yet. Turn on "one-time codes" in a Digital Gift campaign and they\'ll appear here.</div>');
}
'''

def rep(a, b):
    global s
    c = s.count(a)
    assert c == 1, (c, a[:80])
    s = s.replace(a, b, 1)

# Settings page card, after the security card
# On its own line: the security script (idx-mfa-settings) checks the exact
# "${bizTextingCard}\n        ${securityCard()}\n" lines, so they must stay untouched.
rep("        ${bizTextingCard}\n        ${securityCard()}\n", "        ${bizTextingCard}\n        ${securityCard()}\n        ${ctRedeemCard()}\n")
# Gifts page card
rep("el.innerHTML=paidBanner+intro+actions+brandBanner+body;", "el.innerHTML=paidBanner+intro+actions+brandBanner+ctOfferCodesCard()+body;")
# Campaign builder: toggle above the Online link field
rep('<div class="fg" style="margin-bottom:0"><label class="fl">Online link', '${ctRewUniqueBlock()}<div class="fg" style="margin-bottom:0"><label class="fl">Online link')
# State: reset when the builder closes, load when editing
rep('cmRewExp="";cmProt={', 'cmRewExp="";cmRewUnique=false;cmRewCredit="";cmRewMin="";cmProt={')
rep('cmRewExp=row.reward_expires||"";', 'cmRewExp=row.reward_expires||"";cmRewUnique=!!row.reward_unique;cmRewCredit=row.reward_credit==null?"":String(row.reward_credit);cmRewMin=row.reward_min_spend==null?"":String(row.reward_min_spend);')
# Save (edit + create)
rep('reward_expires:ety==="digital_gift"?(cmRewExp||null):null}', 'reward_expires:ety==="digital_gift"?(cmRewExp||null):null,...ctRewPayload(ety==="digital_gift")}')
rep('reward_expires:ty==="digital_gift"?(cmRewExp||null):null,user_id:myId()}', 'reward_expires:ty==="digital_gift"?(cmRewExp||null):null,...ctRewPayload(ty==="digital_gift"),user_id:myId()}')

anchor = "function buildDemoData(){"
assert s.count(anchor) == 1
s = s.replace(anchor, FUNC + anchor, 1)
path.write_text(s, encoding="utf-8")
print("applied")
