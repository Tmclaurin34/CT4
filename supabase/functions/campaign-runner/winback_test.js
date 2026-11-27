// Win-back decision tests for campaign-runner's matchesTrigger(), run against the real
// function text extracted from index.ts (run_winback_tests.sh). jsc, no Node/Deno.
var pass=0,fail=0;
function ok(c,n){if(c)pass++;else{fail++;print("FAIL: "+n);}}
var day=86400000, iso=function(daysAgo){return new Date(Date.now()-daysAgo*day).toISOString();};
var weekly={id:1,visits:10,first_order_at:iso(75),last_visit_at:iso(12)};   // old rule: 1.5*7=10.5 -> 14-day floor
var oneVisit={id:2,visits:1,first_order_at:iso(70),last_visit_at:iso(70)};
var rDrift={status:"drifting",status_since:iso(1),episode_started_at:iso(1),confidence:"high"};
var rRisk={status:"at_risk",status_since:iso(1),episode_started_at:iso(9),confidence:"high"};
var rHealthy={status:"healthy",status_since:iso(30),confidence:"high"};
var rRecovered={status:"recovered",status_since:iso(2),confidence:"high"};
var rOne={status:"at_risk",status_since:iso(5),confidence:"insufficient"};
var m;
m=matchesTrigger("Win-back: inactive customers",weekly,60,iso(400),rDrift,false); ok(m.match&&m.reason==="inactive","engine drifting -> win-back fires");
m=matchesTrigger("Win-back: inactive customers",weekly,60,iso(400),undefined,false); ok(!m.match,"without engine, old rule (14-day floor) would NOT fire at 12 days");
m=matchesTrigger("Win-back: inactive customers",weekly,60,iso(400),rHealthy,false); ok(!m.match,"healthy -> no win-back");
m=matchesTrigger("Win-back: inactive customers",weekly,60,iso(400),rRecovered,false); ok(!m.match,"returned (recovered) -> win-back stops");
m=matchesTrigger("At-risk VIP rescue (win-back)",weekly,60,iso(400),rDrift,false); ok(!m.match,"'at risk' campaign ignores merely drifting");
m=matchesTrigger("At-risk VIP rescue (win-back)",weekly,60,iso(400),rRisk,false); ok(m.match,"'at risk' campaign fires on at_risk");
m=matchesTrigger("Drifting nudge (win-back)",weekly,60,iso(400),rRisk,false); ok(!m.match,"'drifting' campaign ignores at_risk");
m=matchesTrigger("Win-back: inactive customers",oneVisit,60,iso(400),rOne,false); ok(!m.match&&m.reason==="inactive_estimated","one-visit customer skipped by default");
m=matchesTrigger("Win-back: inactive customers",oneVisit,60,iso(400),rOne,true); ok(m.match,"one-visit customer reached when owner opts in");
m=matchesTrigger("Inactive 90 days",weekly,60,iso(400),rDrift,false); ok(!m.match,"explicit day count still overrides (12 < 90)");
m=matchesTrigger("Inactive 10 days",weekly,60,iso(400),rHealthy,false); ok(m.match,"explicit day count overrides even when engine says healthy");
m=matchesTrigger("5th visit milestone",weekly,60,iso(1),rDrift,false); ok(m.reason==="milestone","other triggers unaffected");
print("winback tests: "+pass+" passed, "+fail+" failed");
if(fail)throw new Error(fail+" failed");
