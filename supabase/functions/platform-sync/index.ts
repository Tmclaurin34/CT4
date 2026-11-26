// Platform sync: pulls orders from each business's connected platform
// (Square, Shopify, Clover, Stripe) and updates customers' visits /
// total_spent / last_visit_at — and now mailing addresses too, when the
// platform has them (Shopify shipping address, Square customer address,
// Stripe billing/shipping, Clover customer addresses). Imported addresses
// never overwrite one a customer confirmed themselves via /gift-address.
// Runs nightly via pg_cron (cron key), or on demand by a logged-in business
// for their own connections (JWT). First sync backfills 365 days, paginated.

import { aggregateAuditOrders, sufficiency, validateFacts } from "./audit.js";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const stripePlatformKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

const FIRST_SYNC_DAYS = 365;
const MAX_PAGES = 10; // per connection per run; caps runtime on huge merchants

// Fetch options. Nightly sync uses the defaults; the free POS audit asks for a
// deeper read-only history pull bounded by a wall-clock deadline, and collects
// honest counters (orders that can't be tied to a person, truncation).
type FetchStats = { raw: number; anonymous: number; truncated: boolean };
type FetchOpts = { maxPages: number; deadline: number; stats: FetchStats; onPage?: (n: number) => void };
const defaultOpts = (): FetchOpts => ({ maxPages: MAX_PAGES, deadline: Infinity, stats: { raw: 0, anonymous: 0, truncated: false } });
function pageGuard(o: FetchOpts, page: number) {
  if (Date.now() > o.deadline) { o.stats.truncated = true; return false; }
  return page < o.maxPages;
}
function lastPage(o: FetchOpts, page: number, more: boolean) {
  if (more && page === o.maxPages - 1) o.stats.truncated = true;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-clicktide-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Conn = {
  id: string; user_id: string; platform: string; merchant_id: string;
  shop_domain?: string; access_token: string; last_synced_at?: string;
};
type Addr = { address?: string; city?: string; state?: string; zip?: string };
type Order = { email?: string; phone?: string; name?: string; amount: number; at: string; addr?: Addr };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const t = await r.text();
  const data = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(data?.message || data?.error || r.statusText);
  return data;
}

async function expectedCronKey() {
  try { return String(await rest("/rest/v1/rpc/clicktide_internal_key", { method: "POST", body: "{}" }) || ""); }
  catch { return ""; }
}

async function authedUserId(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return "";
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceRoleKey, Authorization: authorization },
  });
  if (!r.ok) return "";
  const user = await r.json();
  return String(user?.id || "");
}

function normalizePhone(v?: string | null) {
  const s = (v || "").trim();
  if (s.startsWith("+")) return s;
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return "";
}

// Obviously-fake / placeholder numbers — or the merchant's own line — must never
// be used to match or store a customer, or every walk-in entered with a store
// default phone collapses into one fake mega-customer. `own` holds the business's
// own numbers (last 10 digits).
function isJunkPhone(phone: string, own: Set<string>) {
  const last10 = (phone || "").replace(/\D/g, "").slice(-10);
  if (last10.length < 10) return true;
  if (/^(\d)\1{9}$/.test(last10)) return true;
  if (last10 === "1234567890" || last10 === "0123456789" || last10 === "1234567891") return true;
  if (/^555/.test(last10)) return true;
  return own.has(last10);
}

// Escape LIKE/ILIKE metacharacters so an email matches literally yet
// case-insensitively — an underscore in an address must not act as a wildcard
// and merge two different people.
function escapeLike(s: string) {
  return s.replace(/([\\%_])/g, "\\$1");
}

// The business's own phone numbers (last 10 digits), so a walk-in ticket rung up
// against the store's number is never treated as a real customer.
async function businessOwnNumbers(userId: string): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const rows = await rest(`/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}&select=phone,business_phone&limit=1`);
    const r = Array.isArray(rows) ? rows[0] : null;
    for (const v of [r?.phone, r?.business_phone]) {
      const d = String(v || "").replace(/\D/g, "").slice(-10);
      if (d.length === 10) set.add(d);
    }
  } catch { /* best effort */ }
  return set;
}

// Build a usable US mailing address or nothing — partial addresses can't be mailed.
function cleanAddr(line1?: string, line2?: string, city?: string, state?: string, zip?: string, country?: string): Addr | undefined {
  const c = String(country || "").trim().toUpperCase();
  if (c && !["US", "USA", "UNITED STATES"].includes(c)) return undefined;
  const address = [String(line1 || "").trim(), String(line2 || "").trim()].filter(Boolean).join(", ").slice(0, 120);
  const cityV = String(city || "").trim().slice(0, 60);
  const stateV = String(state || "").trim().slice(0, 20);
  const zipV = String(zip || "").trim().slice(0, 12);
  if (!address || !cityV || !stateV || !/^[0-9]{5}(-[0-9]{4})?$/.test(zipV)) return undefined;
  return { address, city: cityV, state: stateV, zip: zipV };
}

// ---- per-platform order fetchers (orders since `since`, paginated) ----

async function squareOrders(c: Conn, since: string, o: FetchOpts = defaultOpts()): Promise<Order[]> {
  const h = { Authorization: `Bearer ${c.access_token}`, "Square-Version": "2024-01-18", "Content-Type": "application/json" };
  const locRes = await fetch("https://connect.squareup.com/v2/locations", { headers: h });
  if (!locRes.ok) throw new Error(`square locations ${locRes.status}`);
  const locIds = ((await locRes.json()).locations || []).map((l: { id: string }) => l.id).slice(0, 10);
  if (!locIds.length) return [];
  const raw: Record<string, unknown>[] = [];
  let cursor = "";
  for (let page = 0; pageGuard(o, page); page++) {
    const body: Record<string, unknown> = {
      location_ids: locIds, limit: 100,
      query: { filter: { date_time_filter: { closed_at: { start_at: since } }, state_filter: { states: ["COMPLETED"] } }, sort: { sort_field: "CLOSED_AT" } },
    };
    if (cursor) body.cursor = cursor;
    const oRes = await fetch("https://connect.squareup.com/v2/orders/search", { method: "POST", headers: h, body: JSON.stringify(body) });
    if (!oRes.ok) throw new Error(`square orders ${oRes.status}`);
    const data = await oRes.json();
    raw.push(...(data.orders || []));
    o.onPage?.(raw.length);
    cursor = String(data.cursor || "");
    lastPage(o, page, !!cursor);
    if (!cursor) break;
  }
  const out: Order[] = [];
  const custCache: Record<string, { email?: string; phone?: string; name?: string; addr?: Addr }> = {};
  o.stats.raw += raw.length;
  for (const ord of raw as Record<string, never>[]) {
    if (Date.now() > o.deadline) { o.stats.truncated = true; break; }
    let who: { email?: string; phone?: string; name?: string; addr?: Addr } = {};
    const cid = (ord as Record<string, string>).customer_id;
    if (cid) {
      if (!custCache[cid]) {
        try {
          const cr = await fetch(`https://connect.squareup.com/v2/customers/${cid}`, { headers: h });
          if (cr.ok) {
            const cu = (await cr.json()).customer || {};
            const a = cu.address || {};
            custCache[cid] = {
              email: cu.email_address, phone: cu.phone_number,
              name: [cu.given_name, cu.family_name].filter(Boolean).join(" "),
              addr: cleanAddr(a.address_line_1, a.address_line_2, a.locality, a.administrative_district_level_1, a.postal_code, a.country),
            };
          } else custCache[cid] = {};
        } catch { custCache[cid] = {}; }
      }
      who = custCache[cid];
    }
    if (!who.email && !who.phone) { o.stats.anonymous++; continue; }
    const om = ord as Record<string, never>;
    out.push({ email: who.email, phone: who.phone, name: who.name, addr: who.addr, amount: (((om.total_money as Record<string, number>)?.amount) || 0) / 100, at: (om.closed_at as string) || (om.created_at as string) });
  }
  return out;
}

async function shopifyOrders(c: Conn, since: string, op: FetchOpts = defaultOpts()): Promise<Order[]> {
  const domain = c.shop_domain || c.merchant_id;
  const raw: Record<string, never>[] = [];
  let sinceId = "";
  for (let page = 0; pageGuard(op, page); page++) {
    const url = `https://${domain}/admin/api/2024-01/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(since)}${sinceId ? `&since_id=${sinceId}` : ""}`;
    const r = await fetch(url, { headers: { "X-Shopify-Access-Token": c.access_token } });
    if (!r.ok) throw new Error(`shopify orders ${r.status}`);
    const orders = (await r.json()).orders || [];
    if (!orders.length) break;
    raw.push(...orders);
    op.onPage?.(raw.length);
    sinceId = String(orders[orders.length - 1].id || "");
    lastPage(op, page, orders.length === 250 && !!sinceId);
    if (orders.length < 250 || !sinceId) break;
  }
  op.stats.raw += raw.length;
  const mapped = raw.map((o) => {
    const cu = (o.customer || {}) as Record<string, never>;
    const sa = ((o as Record<string, never>).shipping_address || (cu.default_address as Record<string, string>) || {}) as Record<string, string>;
    return {
      email: (cu as Record<string, string>).email || (o as Record<string, string>).email,
      phone: (cu as Record<string, string>).phone,
      name: [(cu as Record<string, string>).first_name, (cu as Record<string, string>).last_name].filter(Boolean).join(" "),
      addr: cleanAddr(sa.address1, sa.address2, sa.city, sa.province_code || sa.province, sa.zip, sa.country_code || sa.country),
      amount: Number((o as Record<string, string>).total_price) || 0,
      at: (o as Record<string, string>).created_at,
    };
  });
  const kept = mapped.filter((x: Order) => x.email || x.phone);
  op.stats.anonymous += mapped.length - kept.length;
  return kept;
}

async function cloverOrders(c: Conn, since: string, op: FetchOpts = defaultOpts()): Promise<Order[]> {
  const ts = Date.parse(since);
  const out: Order[] = [];
  for (let page = 0; pageGuard(op, page); page++) {
    const r = await fetch(`https://api.clover.com/v3/merchants/${c.merchant_id}/orders?filter=createdTime>=${ts}&expand=customers.addresses&limit=100&offset=${page * 100}`, {
      headers: { Authorization: `Bearer ${c.access_token}`, Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`clover orders ${r.status}`);
    const orders = (await r.json()).elements || [];
    if (!orders.length) break;
    op.stats.raw += orders.length;
    for (const o of orders) {
      const cu = o.customers?.elements?.[0];
      if (!cu) { op.stats.anonymous++; continue; }
      const email = cu.emailAddresses?.elements?.[0]?.emailAddress;
      const phone = cu.phoneNumbers?.elements?.[0]?.phoneNumber;
      if (!email && !phone) { op.stats.anonymous++; continue; }
      const a = cu.addresses?.elements?.[0] || {};
      out.push({
        email, phone,
        name: [cu.firstName, cu.lastName].filter(Boolean).join(" "),
        addr: cleanAddr(a.address1, a.address2, a.city, a.state, a.zip, a.country),
        amount: (o.total || 0) / 100, at: new Date(o.createdTime).toISOString(),
      });
    }
    op.onPage?.(op.stats.raw);
    lastPage(op, page, orders.length === 100);
    if (orders.length < 100) break;
  }
  return out;
}

async function stripeOrders(c: Conn, since: string, op: FetchOpts = defaultOpts()): Promise<Order[]> {
  if (!stripePlatformKey) return [];
  const ts = Math.floor(Date.parse(since) / 1000);
  const out: Order[] = [];
  let after = "";
  for (let page = 0; pageGuard(op, page); page++) {
    const r = await fetch(`https://api.stripe.com/v1/charges?limit=100&created[gte]=${ts}${after ? `&starting_after=${after}` : ""}`, {
      headers: { Authorization: `Bearer ${stripePlatformKey}`, "Stripe-Account": c.merchant_id },
    });
    if (!r.ok) throw new Error(`stripe charges ${r.status}`);
    const data = await r.json();
    const charges = data.data || [];
    for (const ch of charges) {
      if (!ch.paid || ch.refunded) continue;
      op.stats.raw++;
      const bd = (ch.billing_details || {}) as Record<string, never>;
      const ship = (ch.shipping || {}) as Record<string, never>;
      if (!(bd as Record<string, string>).email && !(bd as Record<string, string>).phone) { op.stats.anonymous++; continue; }
      const a = ((ship.address || bd.address) || {}) as Record<string, string>;
      out.push({
        email: (bd as Record<string, string>).email, phone: (bd as Record<string, string>).phone, name: (bd as Record<string, string>).name,
        addr: cleanAddr(a.line1, a.line2, a.city, a.state, a.postal_code, a.country),
        amount: (ch.amount || 0) / 100, at: new Date((ch.created || 0) * 1000).toISOString(),
      });
    }
    op.onPage?.(op.stats.raw);
    lastPage(op, page, !!data.has_more && !!charges.length);
    if (!data.has_more || !charges.length) break;
    after = String(charges[charges.length - 1].id || "");
  }
  return out;
}

// ---- upsert one customer's new activity ----
async function applyOrder(userId: string, o: Order, own: Set<string>): Promise<{ res: "updated" | "created" | "skipped"; addrAdded: boolean }> {
  const email = (o.email || "").trim().toLowerCase();
  const rawPhone = normalizePhone(o.phone);
  const phone = isJunkPhone(rawPhone, own) ? "" : rawPhone; // never match or store junk/own numbers
  if (!email && !phone) return { res: "skipped", addrAdded: false };
  const ors: string[] = [];
  if (email) ors.push(`email.ilike.${encodeURIComponent(escapeLike(email))}`);
  if (phone) ors.push(`phone.eq.${encodeURIComponent(phone)}`, `phone.like.*${phone.replace(/\D/g, "").slice(-10)}`);
  const rows = await rest(`/rest/v1/customers?user_id=eq.${userId}&or=(${ors.join(",")})&select=id,name,email,phone,visits,total_spent,last_visit_at,first_order_at,address,city,state,zip&limit=1`);
  const ex = Array.isArray(rows) ? rows[0] : null;
  if (ex) {
    const newer = !ex.last_visit_at || Date.parse(o.at) > Date.parse(ex.last_visit_at);
    const hasAddr = !!(ex.address && ex.city && ex.state && ex.zip);
    const addAddr = !hasAddr && o.addr ? o.addr : null;
    // Identifier backfill: capture any strong identifier this record was missing, so
    // the customer still matches after a future phone or email change (their other ID holds).
    const backfill: Record<string, unknown> = {};
    if (!ex.email && email) backfill.email = email;
    if (!ex.phone && phone) backfill.phone = phone;
    if ((!ex.name || !String(ex.name).trim()) && o.name) backfill.name = o.name;
    await rest(`/rest/v1/customers?id=eq.${ex.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        visits: (Number(ex.visits) || 0) + 1,
        total_spent: Math.round(((Number(ex.total_spent) || 0) + o.amount) * 100) / 100,
        ...(newer ? { last_visit_at: o.at, last_order_at: o.at, last_order_amount: o.amount } : {}),
        ...((!ex.first_order_at || Date.parse(o.at) < Date.parse(ex.first_order_at)) ? { first_order_at: o.at } : {}),
        ...(addAddr ? addAddr : {}),
        ...backfill,
      }),
    });
    return { res: "updated", addrAdded: !!addAddr };
  }
  await rest("/rest/v1/customers", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: userId, name: o.name || email || "Customer", email: email || null, phone: phone || null,
      visits: 1, total_spent: o.amount, last_order_amount: o.amount, status: "active", last_visit_at: o.at, last_order_at: o.at, first_order_at: o.at, sms_consent: false,
      ...(o.addr ? o.addr : {}),
    }),
  });
  return { res: "created", addrAdded: !!o.addr };
}

// =====================================================================
// FREE POS AUDIT (mode: audit_*). Read-only: pulls order history through the
// business's own connection, reduces it to PII-free per-customer facts, runs
// the shared drift definition (clicktide_drift_eval via
// clicktide_audit_build_report), stores ONLY the aggregate report, and deletes
// the facts. It never writes customers, never touches last_synced_at (so the
// paid sync still does its own full backfill), and never sends anything.
// =====================================================================
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
const AUDIT_DAYS = 365;
const AUDIT_MAX_PAGES = 40;
const AUDIT_BUDGET_MS = 100_000;
const AUDIT_PLATFORMS = ["square", "shopify", "clover", "stripe"];
const AUDITS_PER_DAY = 6;

async function patchAudit(id: string, body: Record<string, unknown>) {
  await rest(`/rest/v1/pos_audits?id=eq.${id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }),
  });
}

async function insertFacts(auditId: string, facts: { visits: number; spend: number; first_at: string; last_at: string }[]) {
  for (let i = 0; i < facts.length; i += 1000) {
    await rest("/rest/v1/pos_audit_facts", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify(facts.slice(i, i + 1000).map((f) => ({ audit_id: auditId, ...f }))),
    });
  }
}

type AuditImport = {
  source: string; platform: string; orders_read: number; orders_used: number; anonymous_orders: number;
  customers: number; truncated: boolean; recent_history_missing: boolean; window_days: number; rejected_rows?: number;
};

function auditLimitations(imp: AuditImport): string[] {
  const out: string[] = [];
  if (imp.source === "csv") out.push("Built from the CSV you uploaded. Names, emails and phone numbers stayed in your browser — only per-customer visit counts, spend and dates were sent.");
  else out.push(`Built from up to the last ${imp.window_days} days of completed orders in your ${imp.platform} account.`);
  if (imp.anonymous_orders > 0) out.push(`${imp.anonymous_orders.toLocaleString("en-US")} order${imp.anonymous_orders === 1 ? " had" : "s had"} no customer email or phone attached (walk-ins, cash, guest checkouts), so they can't be tied to a person and aren't counted.`);
  if (imp.truncated && !imp.recent_history_missing) out.push("Your account has more history than the free audit reads in one pass, so the oldest orders in the window weren't included. A full sync runs after you subscribe.");
  if (imp.rejected_rows) out.push(`${imp.rejected_rows.toLocaleString("en-US")} CSV row${imp.rejected_rows === 1 ? " was" : "s were"} skipped because a date or amount couldn't be read.`);
  out.push("Customer satisfaction isn't in POS data, so unhappy customers can't be identified until Clicktide's post-visit surveys run.");
  out.push("Drift is judged against each customer's own visit rhythm (or a 60-day default for one-time customers) — the same rule Clicktide's dashboard uses.");
  return out;
}

async function finishAudit(auditId: string, userId: string, imp: AuditImport) {
  await patchAudit(auditId, { stage: "analyzing", progress: { ...imp } });
  let churn = 60;
  try {
    const b = await rest(`/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}&select=churn_days&limit=1`);
    const v = Number(Array.isArray(b) && b[0]?.churn_days);
    if (v > 0) churn = v;
  } catch { /* default */ }
  const report = await rest("/rest/v1/rpc/clicktide_audit_build_report", {
    method: "POST", body: JSON.stringify({ p_audit: auditId, p_churn: churn }),
  }) as Record<string, unknown>;
  const suff = sufficiency(report);
  if (imp.recent_history_missing) {
    suff.ok = false;
    suff.reasons.unshift("Your account has more order history than the free audit can read in one pass, and we couldn't reach your most recent orders — so we can't tell who has actually stopped coming. Try the CSV option with your last 6–12 months, or contact us.");
  }
  const full = { ...report, import: imp, limitations: auditLimitations(imp), sufficient: suff.ok, insufficient_reasons: suff.reasons };
  await rest(`/rest/v1/pos_audit_facts?audit_id=eq.${auditId}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  await patchAudit(auditId, {
    status: suff.ok ? "complete" : "insufficient_data", stage: "done", report: full,
    completed_at: new Date().toISOString(),
  });
}

function friendlyAuditError(platform: string, e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
  if (/ 401| 403/.test(m)) return `${platform} refused the request — the connection may have been revoked. Reconnect and try again.`;
  if (/ 429/.test(m)) return `${platform} is rate-limiting requests right now. Wait a few minutes and try again.`;
  if (/ 5\d\d/.test(m)) return `${platform} had a temporary problem answering. Try again in a few minutes.`;
  return "Something went wrong while reading your order history. Try again — if it keeps failing, contact support@goclicktide.com.";
}

async function runPosAudit(auditId: string, conn: Conn, fetcher: (c: Conn, s: string, o?: FetchOpts) => Promise<Order[]>) {
  try {
    await patchAudit(auditId, { stage: "importing", progress: { orders_read: 0 } });
    let lastPatch = 0;
    const opts: FetchOpts = {
      maxPages: AUDIT_MAX_PAGES, deadline: Date.now() + AUDIT_BUDGET_MS,
      stats: { raw: 0, anonymous: 0, truncated: false },
      onPage: (n) => {
        if (Date.now() - lastPatch < 2500) return;
        lastPatch = Date.now();
        patchAudit(auditId, { progress: { orders_read: n } }).catch(() => {});
      },
    };
    const since = new Date(Date.now() - AUDIT_DAYS * 86400000).toISOString();
    const orders = await fetcher(conn, since, opts);
    const own = await businessOwnNumbers(conn.user_id);
    const agg = aggregateAuditOrders(orders, own);
    // If the pull stopped early AND the newest order we saw is old, the missing
    // part is the recent history — drift can't be judged honestly.
    const newest = orders.reduce((m, o) => Math.max(m, Date.parse(o.at) || 0), 0);
    const recentMissing = opts.stats.truncated && (!newest || newest < Date.now() - 3 * 86400000);
    await insertFacts(auditId, agg.facts);
    await finishAudit(auditId, conn.user_id, {
      source: "pos", platform: conn.platform, orders_read: opts.stats.raw, orders_used: agg.orders,
      anonymous_orders: opts.stats.anonymous + agg.anonymous, customers: agg.customers,
      truncated: opts.stats.truncated, recent_history_missing: recentMissing, window_days: AUDIT_DAYS,
    });
  } catch (e) {
    console.error("pos audit failed", auditId, e);
    await rest(`/rest/v1/pos_audit_facts?audit_id=eq.${auditId}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => {});
    await patchAudit(auditId, { status: "failed", stage: "failed", error: friendlyAuditError(conn.platform, e) }).catch(() => {});
  }
}

function cleanAttribution(a: unknown) {
  const out: Record<string, string> = {};
  if (a && typeof a === "object") {
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "variant", "session_id", "landing"]) {
      const v = (a as Record<string, unknown>)[k];
      if (typeof v === "string" && v) out[k] = v.slice(0, 120);
    }
  }
  return out;
}

async function auditsToday(userId: string) {
  const since = new Date(Date.now() - 86400000).toISOString();
  const rows = await rest(`/rest/v1/pos_audits?user_id=eq.${userId}&created_at=gte.${since}&select=id`);
  return Array.isArray(rows) ? rows.length : 0;
}

async function createAudit(userId: string, source: string, platform: string, attribution: unknown) {
  const rows = await rest("/rest/v1/pos_audits", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ user_id: userId, source, platform, status: "running", stage: "connecting", attribution: cleanAttribution(attribution) }),
  });
  return String(rows?.[0]?.id || "");
}

async function handleAudit(req: Request, body: Record<string, unknown>, fetchers: Record<string, (c: Conn, s: string, o?: FetchOpts) => Promise<Order[]>>) {
  const userId = await authedUserId(req);
  if (!userId) return json({ error: "Please sign in first." }, 401);
  const mode = String(body.mode);

  if (mode === "audit_start") {
    const platform = String(body.platform || "");
    if (!AUDIT_PLATFORMS.includes(platform)) return json({ error: "That POS isn't supported for the free audit yet." }, 400);
    // A run already in flight for this user? Hand it back instead of starting a second pull.
    const fresh = new Date(Date.now() - 4 * 60000).toISOString();
    const running = await rest(`/rest/v1/pos_audits?user_id=eq.${userId}&status=eq.running&updated_at=gte.${fresh}&select=id&order=created_at.desc&limit=1`);
    if (Array.isArray(running) && running[0]) return json({ ok: true, audit_id: running[0].id, reused: true });
    if (await auditsToday(userId) >= AUDITS_PER_DAY) return json({ error: "You've run the free audit several times today. Try again tomorrow." }, 429);
    const conns = await rest(`/rest/v1/platform_connections?user_id=eq.${userId}&platform=eq.${platform}&is_active=eq.true&select=id,user_id,platform,merchant_id,shop_domain,access_token,last_synced_at&order=updated_at.desc.nullslast&limit=1`) as Conn[];
    const conn = conns?.[0];
    if (!conn || !conn.access_token) return json({ error: "not_connected" }, 409);
    const auditId = await createAudit(userId, "pos", platform, body.attribution);
    if (!auditId) return json({ error: "Could not start the audit." }, 500);
    const job = runPosAudit(auditId, conn, fetchers[platform]);
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(job);
    else await job;
    return json({ ok: true, audit_id: auditId });
  }

  if (mode === "audit_csv") {
    if (await auditsToday(userId) >= AUDITS_PER_DAY) return json({ error: "You've run the free audit several times today. Try again tomorrow." }, 429);
    const v = validateFacts(body.facts, 50000);
    const meta = (body.meta || {}) as Record<string, unknown>;
    const auditId = await createAudit(userId, "csv", "csv", body.attribution);
    if (!auditId) return json({ error: "Could not start the audit." }, 500);
    try {
      await patchAudit(auditId, { stage: "importing", progress: { customers: v.facts.length } });
      await insertFacts(auditId, v.facts);
      const newest = v.facts.reduce((m, f) => Math.max(m, Date.parse(f.last_at)), 0);
      await finishAudit(auditId, userId, {
        source: "csv", platform: "csv", orders_read: Number(meta.rows) || 0,
        orders_used: v.facts.reduce((s, f) => s + f.visits, 0), anonymous_orders: Math.max(0, Number(meta.anonymous) || 0),
        customers: v.facts.length, truncated: false, recent_history_missing: !!newest && newest < Date.now() - 120 * 86400000,
        window_days: 0, rejected_rows: v.rejected + Math.max(0, Number(meta.bad) || 0),
      });
    } catch (e) {
      console.error("csv audit failed", e);
      await rest(`/rest/v1/pos_audit_facts?audit_id=eq.${auditId}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => {});
      await patchAudit(auditId, { status: "failed", stage: "failed", error: "We couldn't analyze that file. Check it has a date, an amount and a customer column, then try again." }).catch(() => {});
    }
    return json({ ok: true, audit_id: auditId });
  }

  if (mode === "audit_viewed") {
    const id = String(body.audit_id || "");
    if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "bad id" }, 400);
    await rest(`/rest/v1/pos_audits?id=eq.${id}&user_id=eq.${userId}&report_viewed_at=is.null`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ report_viewed_at: new Date().toISOString() }),
    });
    return json({ ok: true });
  }

  if (mode === "audit_delete") {
    // Disconnect + delete. Only for businesses that haven't subscribed — a paying
    // account manages its data from Settings, where campaigns depend on it.
    const b = await rest(`/rest/v1/clicktide?user_id=eq.${userId}&select=stripe_subscription_status&limit=1`);
    const status = String((Array.isArray(b) && b[0]?.stripe_subscription_status) || "").toLowerCase();
    if (["active", "trialing", "past_due"].includes(status)) return json({ error: "Your account has an active subscription — manage connections and data from Settings, or email support@goclicktide.com." }, 409);
    await rest(`/rest/v1/platform_connections?user_id=eq.${userId}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ is_active: false, access_token: "", refresh_token: null, updated_at: new Date().toISOString() }),
    });
    await rest(`/rest/v1/pos_audits?user_id=eq.${userId}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    try {
      await rest(`/rest/v1/customers?user_id=eq.${userId}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    } catch (e) {
      console.error("audit_delete customers", e);
      return json({ ok: false, partial: true, error: "Your POS is disconnected and the audit report is deleted, but some customer records are linked to past messages. Email support@goclicktide.com and we'll finish the deletion." }, 200);
    }
    return json({ ok: true });
  }

  return json({ error: "Unknown audit mode" }, 400);
}

// Users who came in through the free POS audit and have no live subscription.
async function freeAuditOnlyUsers(userIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  const out = new Set<string>();
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).map(encodeURIComponent).join(",");
    const audits = await rest(`/rest/v1/pos_audits?user_id=in.(${chunk})&select=user_id`) as { user_id: string }[];
    const withAudit = new Set((audits || []).map((a) => a.user_id));
    if (!withAudit.size) continue;
    const bizs = await rest(`/rest/v1/clicktide?user_id=in.(${[...withAudit].map(encodeURIComponent).join(",")})&select=user_id,stripe_subscription_status`) as { user_id: string; stripe_subscription_status?: string }[];
    const live = new Set((bizs || []).filter((b) => ["active", "trialing", "past_due"].includes(String(b.stripe_subscription_status || "").toLowerCase())).map((b) => b.user_id));
    for (const u of withAudit) if (!live.has(u)) out.add(u);
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey) return json({ error: "Server is not configured" }, 500);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* nightly cron may send no body */ }

  const fetchers: Record<string, (c: Conn, s: string, o?: FetchOpts) => Promise<Order[]>> = {
    square: squareOrders, shopify: shopifyOrders, clover: cloverOrders, stripe: stripeOrders,
  };
  if (typeof body?.mode === "string" && body.mode.startsWith("audit_")) {
    try { return await handleAudit(req, body, fetchers); }
    catch (e) { console.error("audit handler", e); return json({ error: "The audit service had a problem. Please try again." }, 500); }
  }

  // Auth: cron key (nightly, all businesses) or a logged-in business (their own connections only).
  const key = req.headers.get("x-clicktide-cron-key") || "";
  const isCron = !!key && key === await expectedCronKey();
  const userId = isCron ? "" : await authedUserId(req);
  if (!isCron && !userId) return json({ error: "Not authorized" }, 401);

  let connFilter = "is_active=eq.true&user_id=not.is.null";
  if (userId) connFilter += `&user_id=eq.${encodeURIComponent(userId)}`;
  const conns = await rest(
    `/rest/v1/platform_connections?${connFilter}&select=id,user_id,platform,merchant_id,shop_domain,access_token,last_synced_at&limit=500`,
  ) as Conn[];

  const results: Record<string, unknown>[] = [];
  const ownNumbersCache: Record<string, Set<string>> = {};
  let auditOnly = new Set<string>();
  try { auditOnly = await freeAuditOnlyUsers(conns.map((c) => c.user_id)); }
  catch (e) { console.error("free-audit check failed; syncing as before", e); }
  for (const c of conns) {
    // Free POS audit accounts that haven't started a plan: the audit already gave them
    // their report from PII-free facts, so don't copy their customers' names/emails/
    // phones into Clicktide. The full import runs once their subscription starts.
    if (auditOnly.has(c.user_id)) { results.push({ platform: c.platform, skipped: "free audit account, no plan yet" }); continue; }
    const fetcher = fetchers[c.platform];
    if (!fetcher || !c.access_token) { results.push({ platform: c.platform, skipped: "no fetcher or token" }); continue; }
    const since = c.last_synced_at || new Date(Date.now() - FIRST_SYNC_DAYS * 86400000).toISOString();
    try {
      const own = ownNumbersCache[c.user_id] || (ownNumbersCache[c.user_id] = await businessOwnNumbers(c.user_id));
      const orders = await fetcher(c, since);
      let updated = 0, created = 0, capped = 0, addresses = 0;
      for (const o of orders) {
        try {
          const r = await applyOrder(c.user_id, o, own);
          if (r.res === "updated") updated++;
          if (r.res === "created") created++;
          if (r.addrAdded) addresses++;
        } catch (e) {
          if (String(e).includes("PLAN_CUSTOMER_LIMIT_REACHED")) capped++;
        }
      }
      await rest(`/rest/v1/platform_connections?id=eq.${c.id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ last_synced_at: new Date().toISOString() }),
      });
      if (capped) {
        rest("/rest/v1/alerts", {
          method: "POST", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: c.user_id, type: "plan_limit", message: `${capped} new customers from your ${c.platform} sync couldn't be added — your plan's customer limit is reached. Upgrade to keep syncing.`, resolved: false }),
        }).catch(() => {});
      }
      results.push({ platform: c.platform, orders: orders.length, updated, created, capped, addresses_imported: addresses });
    } catch (e) {
      results.push({ platform: c.platform, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return json({ ok: true, connections: conns.length, results });
});
