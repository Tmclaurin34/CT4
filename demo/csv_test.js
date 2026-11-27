// Runs the free-pos-audit page's own CSV parser + aggregator (extracted between the
// CSV-* markers) against the demo café export and edge cases. jsc, no Node needed.
var pass=0,fail=0;
function ok(c,n){if(c)pass++;else{fail++;print("FAIL: "+n);}}
function eq(a,b,n){ok(JSON.stringify(a)===JSON.stringify(b),n+" (got "+JSON.stringify(a)+", want "+JSON.stringify(b)+")");}
var text=read(DEMO_CSV);
var rows=parseCSV(text);
eq(rows.length,12559,"demo: header + 12,558 orders parsed");
eq(rows[0],["Date","Customer Name","Customer Email","Customer Phone","Order Total"],"demo: header row");
var h=rows[0].map(function(x){return x.trim().toLowerCase();});
var c={date:guess(h,/date|time|created|closed/),amount:guess(h,/total|amount|net sales|gross|price|paid/),email:guess(h,/e-?mail/),phone:guess(h,/phone|mobile/),cust:guess(h,/customer( id| name)?$|customer|client|member|name/)};
eq(c,{date:0,amount:4,email:2,phone:3,cust:1},"demo: columns auto-detected");
var a=aggregateCsv(rows,c);
eq(a.anon,900,"demo: 900 walk-ins counted as anonymous, not customers");
eq(a.bad,0,"demo: no unreadable rows");
ok(a.facts.length>=590&&a.facts.length<=595,"demo: ~595 customers recognized (got "+a.facts.length+")");
var visits=a.facts.reduce(function(s,f){return s+f.visits;},0);
eq(visits+a.anon,12558,"demo: every order accounted for");
ok(a.facts.every(function(f){return Object.keys(f).sort().join()==="first_at,last_at,spend,visit_days,visits";}),"demo: facts carry no names/emails/phones (counts, spend, dates only)");
ok(a.facts.every(function(f){return f.visit_days.length>=1&&f.visit_days.length<=f.visits&&f.visit_days.every(function(d){return /^\d{4}-\d{2}-\d{2}$/.test(d);});}),"demo: one visit date per day, never more dates than orders");
ok(a.facts.every(function(f){return f.first_at<=f.last_at;}),"demo: first visit never after last");

// edge cases
var r2=parseCSV('Date,Name,Email,Total\r\n"2026-01-02 10:00","Smith, Ann",ann@x.com,"1,234.50"\r\n2026-01-03,Bob,,abc\r\n2026-01-04,Guest,,5\r\n2026-01-05,Ann Smith,ANN@x.com,10\r\n');
eq(r2.length,5,"quoted commas + CRLF parse");
eq(r2[1][1],"Smith, Ann","quoted field kept intact");
var a2=aggregateCsv(r2,{date:0,amount:3,email:2,phone:-1,cust:1});
eq(a2.bad,1,"non-numeric amount rejected");
eq(a2.anon,1,"'Guest' rows are anonymous");
eq(a2.facts.length,1,"same email (case-insensitive) = one person");
eq(a2.facts[0].visits,2,"two visits");
eq(a2.facts[0].spend,1244.5,"'1,234.50' parsed as 1234.50");

// two different people who share a name must NOT merge when emails differ
var r3=parseCSV("Date,Name,Email,Total\n2026-01-01,Omar Chen,a@x.com,5\n2026-02-01,Omar Chen,b@x.com,5\n2026-03-01,Omar Chen,,5\n");
var a3=aggregateCsv(r3,{date:0,amount:3,email:2,phone:-1,cust:1});
eq(a3.facts.length,3,"same name + different emails = different people (name only a fallback)");

// phones: formats unify, junk dropped
var r4=parseCSV("Date,Phone,Total\n2026-01-01,(347) 222-3344,5\n2026-01-09,1-347-222-3344,5\n2026-01-10,555-123-4567,5\n2026-01-11,0000000000,5\n");
var a4=aggregateCsv(r4,{date:0,amount:2,email:-1,phone:1,cust:-1});
eq([a4.facts.length,a4.facts[0].visits,a4.anon],[1,2,2],"phone formats unify; 555/0000 placeholders ignored");

// US-style dates
var r5=parseCSV("Date,Email,Total\n11/25/2026 5:00 PM,a@x.com,5\n");
eq(aggregateCsv(r5,{date:0,amount:2,email:1,phone:-1,cust:-1}).facts.length,1,"US date format accepted");

print("csv tests: "+pass+" passed, "+fail+" failed");
if(fail)throw new Error(fail+" csv test(s) failed");
