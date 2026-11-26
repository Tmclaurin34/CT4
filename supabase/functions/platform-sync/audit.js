// Free POS audit: turn raw POS orders into PII-free per-customer facts.
//
// Identity rules match applyOrder() in index.ts exactly (lower-cased email,
// normalized phone, junk/own numbers ignored), so the audit counts the same
// people a paid sync would create. Orders with no usable email or phone can't
// be tied to a person and are counted as `anonymous` — the report discloses it.
//
// Plain JavaScript (Deno imports it directly) so the jsc test rig can load it as
// well (see audit_test.js).

export function normalizePhone(v) {
  const s = String(v || "").trim();
  if (s.startsWith("+")) return s;
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return "";
}

export function isJunkPhone(phone, own) {
  const last10 = String(phone || "").replace(/\D/g, "").slice(-10);
  if (last10.length < 10) return true;
  if (/^(\d)\1{9}$/.test(last10)) return true;
  if (last10 === "1234567890" || last10 === "0123456789" || last10 === "1234567891") return true;
  if (/^555/.test(last10)) return true;
  return own.has(last10);
}

// orders: [{email, phone, amount, at}] ; own: Set of the business's own last-10 numbers.
// Returns { facts: [{visits, spend, first_at, last_at}], customers, orders, anonymous, bad_dates }
export function aggregateAuditOrders(orders, own) {
  const byEmail = new Map();
  const byPhone = new Map();
  const people = [];
  let anonymous = 0, badDates = 0, used = 0;
  for (const o of orders || []) {
    const email = String(o.email || "").trim().toLowerCase();
    const raw = normalizePhone(o.phone);
    const phone = raw && !isJunkPhone(raw, own) ? raw.replace(/\D/g, "").slice(-10) : "";
    if (!email && !phone) { anonymous++; continue; }
    const t = Date.parse(o.at);
    if (!Number.isFinite(t)) { badDates++; continue; }
    let p = (email && byEmail.get(email)) || (phone && byPhone.get(phone)) || null;
    if (!p) { p = { visits: 0, spend: 0, first: t, last: t }; people.push(p); }
    if (email && !byEmail.has(email)) byEmail.set(email, p);
    if (phone && !byPhone.has(phone)) byPhone.set(phone, p);
    const amt = Number(o.amount);
    p.visits += 1;
    p.spend += Number.isFinite(amt) && amt > 0 ? amt : 0;
    if (t < p.first) p.first = t;
    if (t > p.last) p.last = t;
    used++;
  }
  const facts = people.map((p) => ({
    visits: p.visits,
    spend: Math.round(p.spend * 100) / 100,
    first_at: new Date(p.first).toISOString(),
    last_at: new Date(p.last).toISOString(),
  }));
  return { facts, customers: facts.length, orders: used, anonymous, bad_dates: badDates };
}

// CSV uploads are aggregated in the browser (names/emails never leave it);
// the server only re-validates the facts it receives.
export function validateFacts(rows, maxRows) {
  const out = [];
  let rejected = 0;
  const now = Date.now() + 86400000;
  for (const r of Array.isArray(rows) ? rows.slice(0, maxRows) : []) {
    const visits = Math.floor(Number(r && r.visits));
    const spend = Number(r && r.spend);
    const f = Date.parse(r && r.first_at), l = Date.parse(r && r.last_at);
    if (!(visits >= 1 && visits <= 100000) || !Number.isFinite(spend) || spend < 0 || spend > 10000000 ||
        !Number.isFinite(f) || !Number.isFinite(l) || f > l || l > now || f < Date.parse("1990-01-01")) { rejected++; continue; }
    out.push({ visits, spend: Math.round(spend * 100) / 100, first_at: new Date(f).toISOString(), last_at: new Date(l).toISOString() });
  }
  return { facts: out, rejected };
}

// Whether there's enough history for drift to mean anything.
export function sufficiency(report) {
  const n = Number(report && report.customers_analyzed) || 0;
  const rep = Number(report && report.repeat_customers) || 0;
  const reasons = [];
  if (n < 20) reasons.push(`Only ${n} identifiable customer${n === 1 ? "" : "s"} were found — we need at least 20 for a meaningful report.`);
  if (rep < 5) reasons.push(`Only ${rep} customer${rep === 1 ? "" : "s"} visited more than once, so individual visit rhythms can't be learned yet.`);
  return { ok: reasons.length === 0, reasons };
}
