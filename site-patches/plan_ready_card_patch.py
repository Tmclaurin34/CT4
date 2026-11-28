#!/usr/bin/env python3
"""Add the "Your win-back plan is ready" budget card to the dashboard Overview.

Preview feature (2026-11-28). The card is computed in the browser from the customers the
Overview already loads (visits, total spent, first/last order), the business type and the
plan. It is display-only: the Start button never sends or spends anything.

It only shows in the demo (?demo=1) or with ?planpreview=1 in the URL, so real customers
don't see it until the feature is built for real (see outputs/winback-autopilot/scope.md).

Idempotent: re-running does nothing once the marker is present.
Usage: python3 site-patches/plan_ready_card_patch.py [path/to/index.html]
"""
import sys
from pathlib import Path

MARK = "/*ct-plan-ready-card*/"
path = Path(sys.argv[1] if len(sys.argv) > 1 else "index.html")
s = path.read_text(encoding="utf-8")
if MARK in s:
    print("already applied")
    sys.exit(0)

FUNC = r'''/*ct-plan-ready-card*/
function ctPlanOn(){try{return !!(typeof DEMO!=="undefined"&&DEMO)||/[?&]planpreview=1/.test(location.search);}catch(e){return false;}}
function ctPlanModel(u){
  var bt=String((typeof bizLock!=="undefined"&&bizLock&&bizLock.business_type)||"").toLowerCase();
  var m=/salon|barber|nail|spa|beauty|gym|yoga|fitness|pilates|massage|lash|brow|tattoo|clinic|dental|med/.test(bt)?.60:/cafe|coffee|restaurant|bakery|food|bar|pizza|juice|tea/.test(bt)?.65:/retail|boutique|store|shop|apparel|clothing|gift|florist|flower/.test(bt)?.45:/auto|repair|mechanic|car|detail/.test(bt)?.50:.40;
  var pk=String((typeof bizLock!=="undefined"&&bizLock&&(bizLock.plan||bizLock.selected_plan))||"growth").toLowerCase();
  var PLANS={local:{n:"Local",p:79,pc:10,tx:0},growth:{n:"Growth",p:199,pc:30,tx:1500},scale:{n:"Scale",p:449,pc:75,tx:5000}};
  var pl=PLANS[pk]||PLANS.growth;
  var now=Date.now(),drift=[],all=[];
  (u||[]).forEach(function(x){
    var v=Number(x.visits||x.order_count||0),sp=Number(x.total_spent)||0;
    var fo=Date.parse(x.first_order_at||""),la=Date.parse(x.last_visit_at||x.last_order_at||"");
    if(v<1||sp<=0)return;
    var avg=sp/v; all.push(avg);
    if(v<2||isNaN(fo)||isNaN(la)||la<=fo)return;
    var iv=Math.max(7,(la-fo)/86400000/(v-1)),since=(now-la)/86400000;
    if(since>1.5*iv)drift.push({v:v,avg:avg,iv:iv,worth:avg*(90/iv)*m});
  });
  if(!drift.length)return null;
  var elig=drift.filter(function(d){return d.v>=3;}).sort(function(a,b){return b.worth-a.worth;});
  all.sort(function(a,b){return a-b;});
  var A=all.length?all[Math.floor(all.length/2)]:0;
  var credit=A<15?0:Math.max(5,Math.round(A*.1/5)*5);
  var minS=credit?Math.ceil(Math.max(credit/(m*.5),.75*A)/5)*5:0;
  var r5=function(n){return n<=0?0:Math.max(5,Math.ceil(n/5)*5);};
  // BASE = how often drifting customers come back on their own (cautious default; the real
  // version uses the business's own history). Profit counts only the EXTRA customers above it.
  var BASE=.077;
  var mk=function(k,who,list,rate,boost,lowList,lowRate){
    lowList=lowList||[];lowRate=lowRate||0;
    var n=list.length+lowList.length;if(!n)return {k:k,who:who,n:0,b:0,back:0,profit:0};
    var all2=list.concat(lowList);
    var avgW=all2.reduce(function(a,d){return a+d.worth;},0)/n*boost;
    var back=Math.max(1,Math.round(list.length*rate+lowList.length*lowRate));
    var extra=Math.max(0,list.length*(rate-BASE)+lowList.length*Math.max(0,lowRate-BASE));
    var pcs=Math.round(n*.4),pcx=Math.max(0,pcs-pl.pc)*1.5;
    var giftsOK=.1*avgW*.5>=7.99,gift=giftsOK?Math.round(n*.1)*7.99:0;
    var cred=credit?back*.55*credit:0;
    var txt=Math.round((u||[]).length*.3)+Math.round(n*2.5),tx=pl.tx?Math.max(0,txt-pl.tx)*.05:0;
    var billExtra=pcx+gift+tx;
    // Same maths as outputs/website-redesign/signup-preview.html: the Clicktide bill and the
    // credit given at checkout are kept apart; the budget is both together.
    return {k:k,who:who,n:n,b:r5(billExtra+cred),bill:r5(billExtra),back:back,extra:Math.round(extra),profit:Math.max(0,Math.round(extra*avgW-billExtra-cred)),pcs:pcs,pcx:pcx,giftsOK:giftsOK,gift:gift,cred:Math.round(cred),txt:txt,tx:tx};
  };
  var top=elig.slice(0,Math.max(1,Math.round(elig.length*.2)));
  var rest=drift.filter(function(d){return d.v<3;});
  var O=[mk("Starter","Your best customers only",elig.length?top:[],.18,1.3),mk("Recommended","Everyone worth winning back",elig,.13,1),mk("Everything","Every drifting customer",elig,.13,1,rest,.08)];
  var yr=Math.round(elig.reduce(function(a,d){return a+d.avg*(365/d.iv);},0));
  return {D:drift.length,W:elig.length,A:A,m:m,pl:pl,credit:credit,minS:minS,O:O,yr:yr};
}
function ctPlanCard(u){
  if(!ctPlanOn())return "";
  var M;try{M=ctPlanModel(u);}catch(e){M=null;}
  if(!M)return "";
  window._ctPlanM=M;if(window._ctPlanSel==null)window._ctPlanSel=M.W?1:2;
  return '<div class="dc" id="ctPlan" style="margin-bottom:14px;border:1px solid rgba(11,98,214,.25)">'+ctPlanInner()+'</div>';
}
function ctPlanInner(){
  var M=window._ctPlanM;if(!M)return "";var sel=window._ctPlanSel,o=M.O[sel];
  var f=function(n){return "$"+Math.round(n).toLocaleString();};
  var mu="color:#646A73;font-size:12px";
  var opts=M.O.map(function(x,i){
    if(!x.n)return "";
    var on=i===sel;
    return '<div onclick="ctPlanPick('+i+')" role="button" tabindex="0" style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;margin-bottom:8px;border-radius:12px;cursor:pointer;border:'+(on?'2px solid #0B62D6':'1px solid rgba(16,18,21,.10)')+';background:#FFFFFF"><div><div style="font-size:14px;font-weight:700;color:#0F1115">'+x.k+(i===1?' <span style="font-size:11px;font-weight:600;background:rgba(11,98,214,.08);color:#0B62D6;padding:2px 8px;border-radius:8px;margin-left:4px">Suggested</span>':'')+'</div><div style="'+mu+'">'+x.who+' · '+x.n+'</div></div><div style="font-size:16px;font-weight:700;color:#0F1115">'+f(x.b)+'<span style="'+mu+'">/mo</span></div></div>';
  }).join("");
  var offer=M.credit?f(M.credit)+" off "+f(M.minS)+"+":"A friendly message (your tickets are small, so no credit)";
  var det='<div style="display:none;border-top:1px solid rgba(16,18,21,.08);margin-top:8px;padding-top:8px;font-size:13px;color:#0F1115" id="ctPlanDet">'+
    '<div style="display:flex;justify-content:space-between;padding:3px 0"><span style="'+mu+'">Covered by your '+M.pl.n+' plan ('+f(M.pl.p)+')</span><span></span></div>'+
    '<div style="display:flex;justify-content:space-between;padding:3px 0"><span style="'+mu+'">Texts</span><span>'+(M.pl.tx?(o.txt||0).toLocaleString()+' of '+M.pl.tx.toLocaleString()+(o.tx>0?' · '+f(o.tx)+' extra':' · $0'):'Email only on Local')+'</span></div>'+
    '<div style="display:flex;justify-content:space-between;padding:3px 0"><span style="'+mu+'">Postcards</span><span>'+(o.pcs||0)+' · '+(o.pcx>0?f(o.pcx)+' extra':'covered')+'</span></div>'+
    '<div style="display:flex;justify-content:space-between;padding:3px 0"><span style="'+mu+'">Mailed gifts</span><span>'+(o.giftsOK?f(o.gift):'Not yet, until results justify it')+'</span></div>'+
    '<div style="display:flex;justify-content:space-between;padding:3px 0"><span style="'+mu+'">Credit given at checkout</span><span>~'+f(o.cred||0)+'</span></div>'+
    '<div style="'+mu+';margin-top:4px;line-height:1.5">Credit only counts when a customer comes back and spends the minimum. Unspent budget stays with you.</div></div>';
  return '<div style="font-size:16px;font-weight:800;color:#0F1115;margin-bottom:4px">Your win-back plan is ready</div>'+
    '<div style="font-size:13px;color:#646A73;line-height:1.6;margin-bottom:12px">We found <b style="color:#0F1115">'+M.D+' customers</b> slipping away'+(M.W?', <b style="color:#0F1115">'+M.W+'</b> worth winning back (they used to spend about <b style="color:#0F1115">'+f(M.yr)+'</b> a year with you)':'')+'.</div>'+
    '<div style="font-size:13px;font-weight:700;color:#0F1115;margin-bottom:6px">Monthly budget</div>'+opts+
    '<div style="background:rgba(34,197,94,.10);border-radius:10px;padding:10px 12px;margin:4px 0 10px"><div style="font-size:12px;color:#1E874F">Expected each month</div><div style="font-size:16px;font-weight:700;color:#1E874F">About '+o.back+' customer'+(o.back===1?'':'s')+' back · about '+f(o.profit)+' extra profit</div><div style="font-size:11px;color:#1E874F;margin-top:2px">Profit counts only the customers who likely wouldn’t have come back on their own.</div></div>'+
    '<div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;color:#0F1115"><span style="'+mu+'">Offer</span><span>'+offer+'</span></div>'+
    '<div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0 0;margin-top:4px;border-top:1px solid rgba(16,18,21,.08);font-weight:700;color:#0F1115"><span>You pay Clicktide</span><span>'+f(M.pl.p+o.bill)+'/mo</span></div>'+
    '<div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0 10px;color:#0F1115"><span style="'+mu+'">Credit given at checkout</span><span>about '+f(o.cred||0)+', only when they come back</span></div>'+det+
    '<div style="display:flex;gap:8px;margin-top:10px"><button class="btn" onclick="ctPlanDet()" style="flex:1">What’s in this</button><button class="btn btn-gold" onclick="ctPlanStart()" style="flex:1">Start</button></div>'+
    '<div style="'+mu+';text-align:center;margin-top:8px">Preview · nothing is sent until you start, and this preview never sends.</div>';
}
function ctPlanPick(i){window._ctPlanSel=i;var el=document.getElementById("ctPlan");if(el)el.innerHTML=ctPlanInner();}
function ctPlanDet(){var d=document.getElementById("ctPlanDet");if(d)d.style.display=d.style.display==="none"?"block":"none";}
function ctPlanStart(){try{ctToast(DEMO?"Demo: this would start your win-back plan. Nothing is sent in the demo.":"Preview only: the plan isn't switched on yet.");}catch(e){}}
'''

FUNC += r'''/*ct-demo-real-size*/
// Demo only: grow June's Beauty Bar from 14 showcase customers to a realistic ~600-customer
// salon (seeded, so every visit to the demo shows the same numbers). Real accounts never call this.
function ctDemoMore(start){
  var seed=20261128;function rnd(){seed|=0;seed=seed+0x6D2B79F5|0;var t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;}
  var FN=["Olivia","Emma","Ava","Mia","Isabella","Amelia","Harper","Evelyn","Abigail","Ella","Camila","Luna","Sofia","Avery","Scarlett","Layla","Nora","Zoe","Riley","Lily","Maya","Elena","Naomi","Aria","Valentina","Jasmine","Leah","Gabriela","Nia","Imani","Rosa","Tanya","Keisha","Lauren","Megan","Rachel","Dana","Carmen","Yara","Sasha"];
  var LN=["Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","Thompson","White","Harris","Clark","Lewis","Robinson","Walker","Young","Allen","King","Wright","Scott","Torres","Nguyen","Hill","Flores","Green","Adams","Baker","Rivera","Campbell","Mitchell","Carter","Roberts"];
  var out=[],N=586;
  for(var k=0;k<N;k++){
    var iv=24+Math.round(rnd()*30);
    var visits=1+Math.floor(Math.pow(rnd(),1.6)*20);
    var avg=Math.round(55+Math.pow(rnd(),1.3)*95);
    var roll=rnd(),last;
    if(roll<0.74)last=Math.round(rnd()*iv*1.3);
    else if(roll<0.88)last=Math.round(iv*(1.6+rnd()*1.4));
    else last=Math.round(iv*(3+rnd()*4));
    var first=last+Math.round((visits-1)*iv*(0.9+rnd()*0.2));
    var fn=FN[Math.floor(rnd()*FN.length)],ln=LN[Math.floor(rnd()*LN.length)];
    var hasEmail=rnd()<0.85,hasPhone=rnd()<0.6,cons=hasPhone&&rnd()<0.5,addr=rnd()<0.7;
    var canMsg=hasEmail||(hasPhone&&cons),reach=!canMsg?"nocontact":(!addr?"noaddress":"ok");
    var phone=hasPhone?"+1212555"+String(1000+((start+k)*37)%9000):"";
    out.push({id:start+k+1,user_id:"demo-user",name:fn+" "+ln,email:hasEmail?(fn+"."+ln+(start+k)+"@example.com").toLowerCase():"",phone:phone,visits:visits,order_count:visits,total_spent:visits*avg,satisfaction_score:rnd()<0.6?(rnd()<0.85?5:4):0,loyalty_score:0,last_visit_at:dDay(last),last_order_at:dDay(last),last_order_amount:avg,first_order_at:dDay(first),sms_consent:cons,sms_unsubscribed_at:null,address:addr?(100+k)+" Park Pl":"",city:addr?"Brooklyn":"",state:addr?"NY":"",zip:addr?"11217":"",reach:reach});
  }
  return out;
}
'''

FUNC += r'''/*ct-plan-drift-match*/
// Preview only: the Overview's "customers drifting" section counts the same customers as the
// plan card: past 1.5x their own usual gap between visits (2+ visits needed to know a rhythm).
function ctPlanDriftList(u){
  var now=Date.now();
  return (u||[]).filter(function(x){
    var v=Number(x.visits||x.order_count||0),sp=Number(x.total_spent)||0;
    var fo=Date.parse(x.first_order_at||""),la=Date.parse(x.last_visit_at||x.last_order_at||"");
    if(v<2||sp<=0||isNaN(fo)||isNaN(la)||la<=fo)return false;
    var iv=Math.max(7,(la-fo)/86400000/(v-1));
    return (now-la)/86400000>1.5*iv;
  });
}
'''

anchor_dorm = 'var _dorm=u.filter(function(x){var d=_days(x.last_visit_at||x.last_order_at);return d!==null&&d>=effChurn(x,_chv);});'
assert s.count(anchor_dorm) == 1, "drift list anchor not unique"
s = s.replace(anchor_dorm, 'var _dorm=(typeof ctPlanOn==="function"&&ctPlanOn())?ctPlanDriftList(u):u.filter(function(x){var d=_days(x.last_visit_at||x.last_order_at);return d!==null&&d>=effChurn(x,_chv);});', 1)
anchor_txt = "No visit in '+_chv+'+ days"
assert s.count(anchor_txt) == 1, "drift wording anchor not unique"
s = s.replace(anchor_txt, "'+((typeof ctPlanOn===\"function\"&&ctPlanOn())?\"Past their own usual visit rhythm\":\"No visit in \"+_chv+\"+ days\")+'", 1)

anchor_isdrift = "function isDrift(c){return sinceLast(c)>=effChurn(c,churn);}"
assert s.count(anchor_isdrift) == 1, "demo isDrift anchor not unique"
s = s.replace(anchor_isdrift, 'function isDrift(c){if(typeof ctPlanOn==="function"&&ctPlanOn())return ctPlanDriftList([c]).length===1;return sinceLast(c)>=effChurn(c,churn);}', 1)

anchor_demo = "DEMO_DATA={"
assert s.count(anchor_demo) == 1, f"DEMO_DATA anchor count {s.count(anchor_demo)}"
s = s.replace(anchor_demo, "custs=custs.concat(ctDemoMore(custs.length));" + anchor_demo, 1)

anchor_func = "function buildDemoData(){"
assert s.count(anchor_func) == 1, "buildDemoData anchor not unique"
s = s.replace(anchor_func, FUNC + anchor_func, 1)

anchor_ins = "el.innerHTML=paidBanner+moneyHtml+("
assert s.count(anchor_ins) == 1, f"overview anchor count {s.count(anchor_ins)}"
s = s.replace(anchor_ins, "el.innerHTML=paidBanner+ctPlanCard(u)+moneyHtml+(", 1)

path.write_text(s, encoding="utf-8")
print("applied")
