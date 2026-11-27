// Tests for the free-POS-audit aggregation (audit.js).
// Run with macOS JavaScriptCore (no Node/Deno needed):
//   supabase/functions/platform-sync/run_audit_tests.sh
// The runner strips `export` from audit.js and loads it ahead of this file.

var pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; print("FAIL: " + name); } }
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name + " (got " + JSON.stringify(a) + ", want " + JSON.stringify(b) + ")"); }

var own = new Set(["2125550000".slice(-10), "9175551234"]);
own.add("7185550199");
own.add("6465550100");
var none = new Set();

// --- identity / dedupe ---------------------------------------------------
var r = aggregateAuditOrders([
  { email: "Ann@Example.com", amount: 10, at: "2026-01-01T10:00:00Z" },
  { email: "ann@example.com ", amount: 15, at: "2026-02-01T10:00:00Z" },     // same person, case/space
  { phone: "(347) 222-3344", amount: 20, at: "2026-01-05T10:00:00Z" },
  { email: "bo@example.com", phone: "347-222-3344", amount: 5, at: "2026-03-05T10:00:00Z" }, // phone links to prior person
  { amount: 99, at: "2026-01-01T10:00:00Z" },                                   // walk-in, no identity
  { phone: "1111111111", amount: 7, at: "2026-01-01T10:00:00Z" },               // junk phone
  { phone: "555-123-4567", amount: 7, at: "2026-01-01T10:00:00Z" },             // 555 placeholder
], none);
eq(r.customers, 2, "dedupes by email (case-insensitive) and by phone");
eq(r.anonymous, 3, "orders with no usable identity are counted, not dropped silently");
eq(r.orders, 4, "only identified orders are used");
var ann = r.facts.filter(function (f) { return f.first_at === "2026-01-01T10:00:00.000Z"; })[0];
ok(!!ann && ann.visits === 2 && ann.spend === 25, "Ann has 2 visits / $25");
eq(ann && ann.last_at, "2026-02-01T10:00:00.000Z", "last visit date");
var p2 = r.facts.filter(function (f) { return f.first_at === "2026-01-05T10:00:00.000Z"; })[0];
eq(p2 && p2.visits, 2, "phone-matched orders merge into one customer");
eq(p2 && p2.spend, 25, "phone person spend");
eq(p2 && p2.last_at, "2026-03-05T10:00:00.000Z", "phone person last visit");

// --- the business's own number is never a customer ---------------------
var r2 = aggregateAuditOrders([
  { phone: "555-010-1234", amount: 10, at: "2026-01-01T00:00:00Z" },
  { phone: "+1 (646) 321-0000", amount: 10, at: "2026-01-02T00:00:00Z" },
], new Set(["6463210000"]));
eq(r2.customers, 0, "store's own phone and 555 numbers are excluded");
eq(r2.anonymous, 2, "...and counted as anonymous");

// --- money and dates ----------------------------------------------------
var r3 = aggregateAuditOrders([
  { email: "a@x.com", amount: "12.345", at: "2026-01-01T00:00:00Z" },
  { email: "a@x.com", amount: -50, at: "2026-01-03T00:00:00Z" },     // refund-ish negative never reduces spend
  { email: "a@x.com", amount: "abc", at: "2026-01-04T00:00:00Z" },
  { email: "b@x.com", amount: 5, at: "not a date" },
], none);
eq(r3.bad_dates, 1, "unparseable dates are rejected");
eq(r3.facts[0].visits, 3, "visits count every identified order");
eq(r3.facts[0].spend, 12.35, "spend rounds to cents and ignores negatives/garbage");
eq(r3.facts[0].last_at, "2026-01-04T00:00:00.000Z", "out-of-order input still yields correct last date");

// --- empty input ---------------------------------------------------------
var r4 = aggregateAuditOrders([], none);
eq([r4.customers, r4.orders, r4.anonymous], [0, 0, 0], "empty import");
eq(aggregateAuditOrders(null, none).customers, 0, "null import is safe");

// --- no PII in facts -----------------------------------------------------
var keys = Object.keys(r.facts[0]).sort();
eq(keys, ["first_at", "last_at", "spend", "visit_days", "visits"], "facts carry no name/email/phone (only counts, spend, dates)");
eq(ann && ann.visit_days, ["2026-01-01", "2026-02-01"], "visit dates collected per customer, sorted");
var rd = aggregateAuditOrders([
  { email: "z@x.com", amount: 1, at: "2026-03-01T09:00:00Z" },
  { email: "z@x.com", amount: 1, at: "2026-03-01T15:00:00Z" },
  { email: "z@x.com", amount: 1, at: "2026-02-20T09:00:00Z" },
], none);
eq(rd.facts[0].visit_days, ["2026-02-20", "2026-03-01"], "same-day orders = one visit date");
var vd = validateFacts([{ visits: 2, spend: 5, first_at: "2025-01-01", last_at: "2025-02-01", visit_days: ["2025-02-01", "2025-01-01", "bad", "2099-01-01", "2025-01-01", 7] }], 10);
eq(vd.facts[0].visit_days, ["2025-01-01", "2025-02-01"], "CSV visit dates validated, de-duplicated, sorted");
eq(validateFacts([{ visits: 2, spend: 5, first_at: "2025-01-01", last_at: "2025-02-01" }], 10).facts[0].visit_days, undefined, "facts without dates still accepted");

// --- CSV fact validation -------------------------------------------------
var v = validateFacts([
  { visits: 3, spend: 120.5, first_at: "2025-06-01", last_at: "2026-01-01" },
  { visits: 0, spend: 10, first_at: "2025-06-01", last_at: "2026-01-01" },        // bad visits
  { visits: 2, spend: -1, first_at: "2025-06-01", last_at: "2026-01-01" },        // bad spend
  { visits: 2, spend: 10, first_at: "2026-02-01", last_at: "2026-01-01" },        // first > last
  { visits: 2, spend: 10, first_at: "2025-02-01", last_at: "2099-01-01" },        // future
  { visits: 2, spend: 10, first_at: "1980-02-01", last_at: "2025-01-01" },        // ancient
  { visits: 2, spend: 10, first_at: "x", last_at: "2025-01-01" },
  null,
], 50000);
eq(v.facts.length, 1, "only valid CSV facts are kept");
eq(v.rejected, 7, "invalid CSV facts are counted");
eq(validateFacts("nope", 10).facts.length, 0, "non-array CSV payload is safe");
eq(validateFacts(new Array(20).fill({ visits: 1, spend: 1, first_at: "2025-01-01", last_at: "2025-01-02" }), 5).facts.length, 5, "row cap enforced");

// --- sufficiency ---------------------------------------------------------
ok(sufficiency({ customers_analyzed: 300, repeat_customers: 90 }).ok, "plenty of data is sufficient");
var s1 = sufficiency({ customers_analyzed: 12, repeat_customers: 1 });
ok(!s1.ok && s1.reasons.length === 2, "too few customers + too few repeaters both explained");
ok(!sufficiency({ customers_analyzed: 400, repeat_customers: 2 }).ok, "no repeat rhythm = insufficient");
ok(!sufficiency(null).ok, "missing report = insufficient");

// --- phone normalization parity with index.ts ----------------------------
eq(normalizePhone("3472223344"), "+13472223344", "10-digit phone");
eq(normalizePhone("1-347-222-3344"), "+13472223344", "11-digit phone");
eq(normalizePhone("+44 20 7946 0000"), "+44 20 7946 0000", "+intl kept as-is (same as sync)");
eq(normalizePhone("12345"), "", "short phone dropped");

print("audit tests: " + pass + " passed, " + fail + " failed");
if (fail) throw new Error(fail + " audit test(s) failed");
