// Platform sync: pulls orders from each business's connected platform
// (Square, Shopify, Clover, Stripe) and updates customers' visits /
// total_spent / last_visit_at — and mailing addresses too, when the
// platform has them (Shopify shipping address, Square customer address,
// Stripe billing/shipping, Clover customer addresses). Imported addresses
// never overwrite one a customer confirmed themselves via /gift-address.
// A POS email opt-out (Square "email unsubscribed", Shopify email consent
// "unsubscribed") sets the customer's email_unsubscribed_at; nothing here clears it.
// Runs via pg_cron (cron key) over the connections that are due, or on demand by a
// logged-in business for their own connections (JWT). A first sync imports the last 30
// days first (that sets last_synced_at), then the rest of the year in later rounds/runs.
//
// Replay-safe: clicktide_pos_apply_orders records every provider order id once in
// pos_order_ledger, so retries, overlapping runs and re-reads never add a visit twice.
// Bounded: a run stops at its time budget; each connection keeps its place in
// sync_cursor and carries on next run. Isolated: a connection is claimed before it
// syncs, gets its own time slice, and its failures are recorded on that row only.
// Square tokens are refreshed before they expire (and on a 401). A connection the
// provider refuses is marked needs_reconnect, and the owner and ops are told once.
//
// Retention engine (merged from the 2026-11-26 19:42 live build): every applied order that
// isn't cancelled/refunded is also written to the visit history (clicktide_record_visit,
// inside clicktide_pos_apply_orders); orders that history already counted are duplicates.
// Free-POS-audit accounts without a plan are not imported. Businesses that got new orders
// are re-evaluated with clicktide_refresh_rhythm at the end of the run (time-boxed).

import { aggregateAuditOrders, cleanEmail, isJunkPhone, normalizePhone, sufficiency, validateFacts } from "./audit.js";
import { GQL_PAGE, LOGICAL_PAGE, mapShopifyOrder, ORDERS_QUERY, ordersRangeSearch, ordersSearch, readOrdersResponse, SHOPIFY_API_VERSION, shopifyOrderWindow, throttleWaitMs } from "./shopify.js";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const stripePlatformKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const stripeConnectClientId = Deno.env.get("STRIPE_CONNECT_CLIENT_ID") ?? "";
const squareAppId = Deno.env.get("SQUARE_APP_ID") ?? "";
const squareAppSecret = Deno.env.get("SQUARE_APP_SECRET") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL") ?? "Clicktide <support@goclicktide.com>";
const opsAlertTo = Deno.env.get("OPS_ALERT_EMAIL") ?? "support@goclicktide.com";
const appBaseUrl = Deno.env.get("APP_BASE_URL") ?? "https://goclicktide.com";

const FIRST_SYNC_DAYS = 365;
const HEAD_FIRST_DAYS = 30; // a first import reads this much first, then the rest of the year
const MAX_PAGES = 10; // free-audit default pull
const SQUARE_VERSION = "2024-01-18";
const SQUARE_BULK_VERSION = "2024-07-17"; // customers/bulk-retrieve; falls back to one GET per id
const SYNC_PLATFORMS = ["square", "shopify", "clover", "stripe"];
// The function's wall clock (and pg_net's wait) is 150 s. Syncs stop starting new work at
// 80 s; one in-flight page (orders + customers + apply) can add ~30 s, and the revoke sweep,
// cleanup, run log and lease release must still fit before the wall.
const SYNC_BUDGET_MS = 80_000;
const HOUSEKEEPING_UNTIL_MS = 118_000;
const REVOKE_TIMEOUT_MS = 8_000;
const USER_BUDGET_MS = 45_000;
const CONN_SLICE_MS = 40_000; // one merchant can't take the whole run
const PAGES_PER_RUN = 25;
const FETCH_TIMEOUT_MS = 12_000;
const CLAIM_SECONDS = 180;
const LEASE_SECONDS = 300;
const OVERLAP_MS = 2 * 3600_000; // re-read the tail of the last pass; the ledger drops repeats
const RESYNC_MS = 20 * 3600_000;
const SLICE_MS = 7 * 86400_000;
const SQUARE_REFRESH_BEFORE_MS = 7 * 86400_000;
const RHYTHM_TIMEOUT_MS = 9_000; // clicktide_refresh_rhythm runs under PostgREST's 8 s statement timeout
const AUDIT_ONLY_RECHECK_MS = 50 * 60_000; // a free-audit-only connection is looked at again next hourly run
const CONN_COLUMNS = "id,user_id,platform,merchant_id,merchant_name,shop_domain,access_token,refresh_token,token_expires_at,raw_response,last_synced_at,sync_cursor,sync_status,sync_fail_count,scope";

// Fetch options. The free POS audit asks for a deeper read-only history pull bounded by a
// wall-clock deadline, and collects honest counters (orders that can't be tied to a
// person, truncation).
type FetchStats = { raw: number; anonymous: number; truncated: boolean; window_days?: number };
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

type J = Record<string, unknown>;
type Conn = {
  id: string; user_id: string; platform: string; merchant_id: string; merchant_name?: string | null;
  shop_domain?: string | null; access_token: string; refresh_token?: string | null; token_expires_at?: string | null;
  raw_response?: J | null; last_synced_at?: string | null; sync_cursor?: unknown; sync_status?: string | null;
  sync_fail_count?: number | null; is_active?: boolean; scope?: string | null;
};
type Addr = { address?: string; city?: string; state?: string; zip?: string };
// void: a cancelled / refunded order. It still updates the customer as before, but it is
// not a visit, so it stays out of the retention engine's visit history.
type Order = { id?: string; email?: string; phone?: string; name?: string; amount: number; at: string; addr?: Addr; emailOptOut?: boolean; void?: boolean };
type Who = { email: string; phone: string; name: string; addr?: Addr; emailOptOut: boolean };
// One sync pass covers [since, started); pos is the provider's place inside it.
type Pass = { v: 1; since: string; started: string; pos: string | null };
// sync_cursor. head: the recent pass that moves last_synced_at (incremental since the last
// one, or the last HEAD_FIRST_DAYS on a first import). back: the rest of the first import's
// year, read only after the head is complete, so recent visits never wait for old history.
type Cursor = { v: 2; head: Pass | null; back: Pass | null };
type Phase = "head" | "back";
type Page = { orders: Order[]; anonymous: number; next: string | null; done: boolean; stop?: string };
type SquareCtx = { locIds: string[] | null; cursor: string; endAt: string; cache: Map<string, Who | null>; bulk: boolean };
type Stats = {
  orders: number; applied: number; duplicates: number; updated: number; created: number; capped: number;
  failed: number; addresses_imported: number; opted_out: number; visits_recorded: number; anonymous: number; pages: number;
};

const obj = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? v as J : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown) => (v == null ? "" : String(v));
const iso = (ms: number) => new Date(ms).toISOString();
const LABEL: Record<string, string> = { square: "Square", shopify: "Shopify", clover: "Clover", stripe: "Stripe" };
const label = (p: string) => LABEL[p] || p;

class ProviderError extends Error {
  status: number;
  platform: string;
  constructor(platform: string, what: string, status: number) {
    super(`${platform} ${what} ${status}`);
    this.status = status;
    this.platform = platform;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

async function rest(path: string, init: RequestInit = {}, ms = 0) {
  const req: RequestInit = {
    ...init,
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json", ...(init.headers || {}) },
  };
  const r = ms > 0 ? await fetchT(`${supabaseUrl}${path}`, req, ms) : await fetch(`${supabaseUrl}${path}`, req);
  const t = await r.text();
  const data = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(data?.message || data?.error || r.statusText);
  return data;
}

async function fetchT(url: string, init: RequestInit = {}, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
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

// failOpen: true for owner-facing calls; false for anything that sends a message.
async function underLimit(bucket: string, windowSeconds: number, max: number, failOpen = true) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_rate_limit_hit`, {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
    });
    if (!r.ok) return failOpen;
    return (await r.json()) === true;
  } catch {
    return failOpen;
  }
}

// POS names end up in the owner's dashboard; angle brackets are never part of a real name.
function cleanName(v?: string | null) {
  return String(v || "").replace(/[<>]/g, "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

function esc(v: unknown) {
  return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
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

// ---- provider records -> Order ----

function squareCustomer(cu: J): Who {
  const a = obj(cu.address);
  return {
    email: str(cu.email_address), phone: str(cu.phone_number),
    name: [str(cu.given_name), str(cu.family_name)].filter(Boolean).join(" "),
    addr: cleanAddr(str(a.address_line_1), str(a.address_line_2), str(a.locality), str(a.administrative_district_level_1), str(a.postal_code), str(a.country)),
    emailOptOut: obj(cu.preferences).email_unsubscribed === true,
  };
}

// Only an explicit opt-out counts; "not_subscribed" is how most US customers start out.
function cloverOrder(o: J): Order | null {
  const cu = obj(arr(obj(o.customers).elements)[0]);
  if (!Object.keys(cu).length) return null;
  const email = str(obj(arr(obj(cu.emailAddresses).elements)[0]).emailAddress);
  const phone = str(obj(arr(obj(cu.phoneNumbers).elements)[0]).phoneNumber);
  if (!email && !phone) return null;
  const a = obj(arr(obj(cu.addresses).elements)[0]);
  const t = Number(o.createdTime);
  return {
    id: str(o.id), email, phone,
    name: [str(cu.firstName), str(cu.lastName)].filter(Boolean).join(" "),
    addr: cleanAddr(str(a.address1), str(a.address2), str(a.city), str(a.state), str(a.zip), str(a.country)),
    amount: (Number(o.total) || 0) / 100,
    at: Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : "",
  };
}

function stripeOrder(ch: J): Order {
  const bd = obj(ch.billing_details);
  const ship = obj(ch.shipping);
  const a = obj(ship.address || bd.address);
  return {
    id: str(ch.id), email: str(bd.email), phone: str(bd.phone), name: str(bd.name),
    addr: cleanAddr(str(a.line1), str(a.line2), str(a.city), str(a.state), str(a.postal_code), str(a.country)),
    amount: (Number(ch.amount) || 0) / 100,
    at: new Date((Number(ch.created) || 0) * 1000).toISOString(),
  };
}

function shopDomainOf(c: Conn) {
  const d = String(c.shop_domain || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d) ? d : "";
}

// Clicktide's platform key reads any account connected to its Stripe platform, so the
// Stripe-Account header may only carry an id that stripe-oauth-callback stored.
function trustedStripeAccount(c: Conn) {
  const id = String(c.merchant_id || "");
  return /^acct_[A-Za-z0-9]+$/.test(id) && obj(c.raw_response).stripe_user_id === id;
}

function connUsable(c: Conn) {
  if (c.platform === "stripe") return trustedStripeAccount(c);
  if (c.platform === "shopify" && !shopDomainOf(c)) return false;
  return !!c.access_token;
}

function squareHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Square-Version": SQUARE_VERSION, "Content-Type": "application/json" };
}

// ---- free-audit fetchers (orders since `since`, newest pages first, bounded by FetchOpts) ----

async function squareOrders(c: Conn, since: string, o: FetchOpts = defaultOpts()): Promise<Order[]> {
  const h = squareHeaders(c.access_token);
  const locRes = await fetchT("https://connect.squareup.com/v2/locations", { headers: h });
  if (!locRes.ok) throw new ProviderError("square", "locations", locRes.status);
  const locIds = arr(obj(await locRes.json()).locations).map((l) => str(obj(l).id)).filter(Boolean).slice(0, 10);
  if (!locIds.length) return [];
  const raw: J[] = [];
  let cursor = "";
  for (let page = 0; pageGuard(o, page); page++) {
    const body: J = {
      location_ids: locIds, limit: 100,
      query: { filter: { date_time_filter: { closed_at: { start_at: since } }, state_filter: { states: ["COMPLETED"] } }, sort: { sort_field: "CLOSED_AT" } },
    };
    if (cursor) body.cursor = cursor;
    const oRes = await fetchT("https://connect.squareup.com/v2/orders/search", { method: "POST", headers: h, body: JSON.stringify(body) });
    if (!oRes.ok) throw new ProviderError("square", "orders", oRes.status);
    const data = obj(await oRes.json());
    raw.push(...arr(data.orders).map(obj));
    o.onPage?.(raw.length);
    cursor = str(data.cursor);
    lastPage(o, page, !!cursor);
    if (!cursor) break;
  }
  const out: Order[] = [];
  const cache = new Map<string, Who | null>();
  o.stats.raw += raw.length;
  for (const ord of raw) {
    if (Date.now() > o.deadline) { o.stats.truncated = true; break; }
    const cid = str(ord.customer_id);
    let who: Who | null = null;
    if (cid) {
      if (!cache.has(cid)) {
        try {
          const cr = await fetchT(`https://connect.squareup.com/v2/customers/${encodeURIComponent(cid)}`, { headers: h });
          cache.set(cid, cr.ok ? squareCustomer(obj(obj(await cr.json()).customer)) : null);
        } catch { cache.set(cid, null); }
      }
      who = cache.get(cid) || null;
    }
    if (!who || (!who.email && !who.phone)) { o.stats.anonymous++; continue; }
    out.push({ id: str(ord.id), ...who, amount: (Number(obj(ord.total_money).amount) || 0) / 100, at: str(ord.closed_at) || str(ord.created_at) });
  }
  return out;
}

// Shopify: GraphQL Admin API (REST is retired for public apps, App Store rule 2.2.4).
// One request = up to 100 orders; the shop's cost budget is respected between calls.
async function shopifyGql(c: Conn, domain: string, variables: J): Promise<{ orders: J[]; hasNext: boolean; cursor: string }> {
  const url = `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetchT(url, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": c.access_token, "Content-Type": "application/json" },
      body: JSON.stringify({ query: ORDERS_QUERY, variables }),
    });
    const body = obj(await r.json().catch(() => ({})));
    const res = readOrdersResponse(r.status, body) as { throttled?: boolean; error?: string; orders?: J[]; hasNext?: boolean; cursor?: string; fieldErrors?: number };
    if (res.throttled) { await new Promise((ok) => setTimeout(ok, Math.max(1000, throttleWaitMs(body.extensions, 1000)))); continue; }
    if (res.error) {
      const code = Number((res.error.match(/ (\d{3})/) || [])[1]) || (r.ok ? 500 : r.status);
      throw new ProviderError("shopify", "orders", code);
    }
    if (res.fieldErrors) console.warn(`shopify ${domain}: ${res.fieldErrors} field error(s); protected customer fields may be redacted`);
    const wait = throttleWaitMs(body.extensions, 1000);
    if (wait) await new Promise((ok) => setTimeout(ok, Math.min(wait, 10_000)));
    return { orders: res.orders || [], hasNext: !!res.hasNext, cursor: res.cursor || "" };
  }
  throw new ProviderError("shopify", "orders", 429);
}

async function shopifyOrders(c: Conn, since: string, op: FetchOpts = defaultOpts()): Promise<Order[]> {
  const domain = shopDomainOf(c);
  if (!domain) throw new ProviderError("shopify", "shop domain", 400);
  // Without Shopify's approved read_all_orders scope only the last 60 days are visible:
  // ask for exactly that window and report it, so the audit says so.
  const window = shopifyOrderWindow(since, c.scope);
  if (window.limited) op.stats.window_days = window.days;
  const q = ordersSearch(window.since);
  const raw: J[] = [];
  let cursor = "";
  let more = true;
  for (let page = 0; more && pageGuard(op, page); page++) {
    let got = 0;
    while (got < LOGICAL_PAGE && more) {
      if (Date.now() > op.deadline) { op.stats.truncated = true; more = false; break; }
      const res = await shopifyGql(c, domain, { first: Math.min(GQL_PAGE, LOGICAL_PAGE - got), after: cursor || null, q });
      raw.push(...res.orders);
      got += res.orders.length;
      cursor = res.cursor;
      more = res.hasNext && !!cursor && res.orders.length > 0;
    }
    op.onPage?.(raw.length);
    lastPage(op, page, more);
  }
  op.stats.raw += raw.length;
  const mapped = raw.map((o) => mapShopifyOrder(o, cleanAddr) as Order);
  const kept = mapped.filter((x) => x.email || x.phone);
  op.stats.anonymous += mapped.length - kept.length;
  return kept;
}

async function cloverOrders(c: Conn, since: string): Promise<Order[]> {
  const ts = Date.parse(since);
  const out: Order[] = [];
  for (let page = 0; pageGuard(op, page); page++) {
    const r = await fetchT(`https://api.clover.com/v3/merchants/${encodeURIComponent(c.merchant_id)}/orders?filter=createdTime>=${ts}&expand=customers.addresses&limit=100&offset=${page * 100}`, {
      headers: { Authorization: `Bearer ${c.access_token}`, Accept: "application/json" },
    });
    if (!r.ok) throw new ProviderError("clover", "orders", r.status);
    const orders = arr(obj(await r.json()).elements).map(obj);
    if (!orders.length) break;
    for (const o of orders) {
      const m = cloverOrder(o);
      if (!m) { op.stats.anonymous++; continue; }
      out.push(m);
    }
    if (orders.length < 100) break;
  }
  return out;
}

async function stripeOrders(c: Conn, since: string): Promise<Order[]> {
  if (!stripePlatformKey) return [];
  if (!trustedStripeAccount(c)) throw new ProviderError("stripe", "account", 403);
  const ts = Math.floor(Date.parse(since) / 1000);
  const out: Order[] = [];
  let after = "";
  for (let page = 0; pageGuard(op, page); page++) {
    const r = await fetchT(`https://api.stripe.com/v1/charges?limit=100&created[gte]=${ts}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`, {
      headers: { Authorization: `Bearer ${stripePlatformKey}`, "Stripe-Account": c.merchant_id },
    });
    if (!r.ok) throw new ProviderError("stripe", "charges", r.status);
    const data = obj(await r.json());
    const charges = arr(data.data).map(obj);
    for (const ch of charges) {
      if (!ch.paid || ch.refunded) continue;
      op.stats.raw++;
      const m = stripeOrder(ch);
      if (!m.email && !m.phone) { op.stats.anonymous++; continue; }
      out.push(m);
    }
    if (!data.has_more || !charges.length) break;
    after = str(charges[charges.length - 1].id);
  }
  return out;
}

// ---- sync pages: one page of the current pass, plus where to resume ----

function readPass(v: unknown): Pass | null {
  const p = obj(v);
  if (p.v !== 1 || !Number.isFinite(Date.parse(str(p.since))) || !Number.isFinite(Date.parse(str(p.started)))) return null;
  return { v: 1, since: str(p.since), started: str(p.started), pos: p.pos == null || p.pos === "" ? null : str(p.pos) };
}

function readCursor(v: unknown): Cursor {
  const p = obj(v);
  if (p.v === 2) return { v: 2, head: readPass(p.head), back: readPass(p.back) };
  return { v: 2, head: readPass(p), back: null }; // a v1 cursor was one pass
}

// The cursor for this run: an unfinished head carries on; otherwise a new head starts at
// the last completed one (minus the overlap). A first import is split at HEAD_FIRST_DAYS.
function planCursor(c: Conn, phase: Phase): Cursor {
  const cur = readCursor(c.sync_cursor);
  if (cur.head || phase === "back") return cur;
  const now = Date.now();
  const last = Date.parse(str(c.last_synced_at));
  if (Number.isFinite(last)) {
    cur.head = { v: 1, since: iso(last - OVERLAP_MS), started: iso(now), pos: null };
    return cur;
  }
  const split = now - HEAD_FIRST_DAYS * 86400000;
  cur.head = { v: 1, since: iso(split), started: iso(now), pos: null };
  if (!cur.back) cur.back = { v: 1, since: iso(now - FIRST_SYNC_DAYS * 86400000), started: iso(split), pos: null };
  return cur;
}

// Time slices walked newest first ("<sliceEndMs>:<inner position>:<sliceMs>"), so a long
// first import fills in recent visits before old history. A quiet slice doubles the next
// one (up to 16 weeks), so a small store's year takes a handful of calls, not 53.
function slicePos(pass: Pass) {
  const [e, k, l] = str(pass.pos).split(":");
  const end = Number(e);
  const len = Number(l);
  const ok = Number.isFinite(end) && end > 0;
  return {
    end: ok ? end : Date.parse(pass.started),
    k: ok ? k || "" : "",
    len: Number.isFinite(len) && len >= SLICE_MS ? Math.min(len, 16 * SLICE_MS) : SLICE_MS,
  };
}

function nextSlice(start: number, len: number, firstPage: boolean, count: number, pageSize: number) {
  const grow = firstPage && count < pageSize / 2;
  return `${start}::${grow ? Math.min(len * 2, 16 * SLICE_MS) : len}`;
}

// Fills ctx.cache for up to 100 Square customer ids: one bulk call per page of orders, or
// one GET per id if bulk-retrieve isn't available to this app. Returns "" when every id
// was resolved, otherwise why it stopped. 401/403 are thrown (the connection is refused).
async function squareLookup(ids: string[], h: Record<string, string>, ctx: SquareCtx, deadline: number): Promise<string> {
  try {
    if (ctx.bulk) {
      const r = await fetchT("https://connect.squareup.com/v2/customers/bulk-retrieve", {
        method: "POST", headers: { ...h, "Square-Version": SQUARE_BULK_VERSION }, body: JSON.stringify({ customer_ids: ids.slice(0, 100) }),
      });
      if (r.status === 401 || r.status === 403) throw new ProviderError("square", "customers", r.status);
      if (r.ok) {
        const res = obj(obj(await r.json()).responses);
        for (const id of ids) {
          const cu = obj(obj(res[id]).customer); // a deleted customer comes back as errors
          ctx.cache.set(id, Object.keys(cu).length ? squareCustomer(cu) : null);
        }
        return "";
      }
      if (r.status === 429 || r.status >= 500) return `square customers ${r.status}`;
      ctx.bulk = false;
    }
    for (const id of ids) {
      if (Date.now() > deadline) return "time budget";
      const cr = await fetchT(`https://connect.squareup.com/v2/customers/${encodeURIComponent(id)}`, { headers: h });
      if (cr.status === 401 || cr.status === 403) throw new ProviderError("square", "customers", cr.status);
      if (cr.ok) ctx.cache.set(id, squareCustomer(obj(obj(await cr.json()).customer)));
      else if (cr.status === 404) ctx.cache.set(id, null);
      else return `square customers ${cr.status}`;
    }
    return "";
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    return e instanceof Error && e.name === "AbortError" ? "square customers timed out" : "square customers unreachable";
  }
}

async function squarePage(c: Conn, pass: Pass, ctx: SquareCtx, deadline: number): Promise<Page> {
  const h = squareHeaders(c.access_token);
  if (!ctx.locIds) {
    const r = await fetchT("https://connect.squareup.com/v2/locations", { headers: h });
    if (!r.ok) throw new ProviderError("square", "locations", r.status);
    ctx.locIds = arr(obj(await r.json()).locations).map((l) => str(obj(l).id)).filter(Boolean).slice(0, 10);
  }
  if (!ctx.locIds.length) return { orders: [], anonymous: 0, next: null, done: true };
  if (!ctx.cursor) {
    // A fresh query reads back from the oldest order this pass already handled. The bound
    // is pushed out a second because Square may treat end_at as exclusive.
    const pos = Date.parse(str(pass.pos));
    ctx.endAt = Number.isFinite(pos) ? iso(pos + 1000) : pass.started;
  }
  const body: J = {
    location_ids: ctx.locIds, limit: 100,
    query: {
      filter: { date_time_filter: { closed_at: { start_at: pass.since, end_at: ctx.endAt } }, state_filter: { states: ["COMPLETED"] } },
      sort: { sort_field: "CLOSED_AT", sort_order: "DESC" },
    },
  };
  if (ctx.cursor) body.cursor = ctx.cursor;
  const r = await fetchT("https://connect.squareup.com/v2/orders/search", { method: "POST", headers: h, body: JSON.stringify(body) });
  if (!r.ok) throw new ProviderError("square", "orders", r.status);
  const data = obj(await r.json());
  const raw = arr(data.orders).map(obj);
  const missing = [...new Set(raw.map((o) => str(o.customer_id)).filter((id) => id && !ctx.cache.has(id)))];
  if (missing.length) {
    const why = Date.now() > deadline ? "time budget" : await squareLookup(missing, h, ctx, deadline);
    if (why) {
      // Rate limited, slow or out of time: stop before this page so it is read again next
      // run, instead of its orders being written off as anonymous walk-ins.
      ctx.cursor = "";
      return { orders: [], anonymous: 0, next: pass.pos, done: false, stop: why };
    }
  }
  const orders: Order[] = [];
  let anonymous = 0;
  let next: string | null = pass.pos;
  for (const ord of raw) {
    const at = str(ord.closed_at) || str(ord.created_at);
    const cid = str(ord.customer_id);
    const who = cid ? ctx.cache.get(cid) || null : null;
    if (who && (who.email || who.phone) && at) {
      orders.push({ id: str(ord.id), ...who, amount: (Number(obj(ord.total_money).amount) || 0) / 100, at });
    } else anonymous++;
    if (at) next = at;
  }
  ctx.cursor = str(data.cursor);
  return { orders, anonymous, next, done: !ctx.cursor };
}

async function shopifyPage(c: Conn, pass: Pass): Promise<Page> {
  const domain = shopDomainOf(c);
  if (!domain) throw new ProviderError("shopify", "shop domain", 400);
  // read_orders alone only reaches 60 days back; don't ask for slices Shopify won't return.
  const since = Date.parse(shopifyOrderWindow(pass.since, c.scope).since);
  const { end, k, len } = slicePos(pass);
  const start = Math.max(since, end - len);
  // k: GraphQL cursor inside this slice (a numeric k is a REST since_id from before the
  // switch: restart the slice; applying orders is replay-safe).
  let after = "";
  try { after = k && !/^\d+$/.test(k) ? decodeURIComponent(k) : ""; } catch { after = ""; }
  const res = await shopifyGql(c, domain, { first: GQL_PAGE, after: after || null, q: ordersRangeSearch(start, end) });
  const orders: Order[] = [];
  let anonymous = 0;
  for (const o of res.orders) {
    const m = mapShopifyOrder(o, cleanAddr) as Order;
    if (m.email || m.phone) orders.push(m);
    else anonymous++;
  }
  if (res.hasNext && res.cursor) return { orders, anonymous, next: `${end}:${encodeURIComponent(res.cursor)}:${len}`, done: false };
  if (start <= since) return { orders, anonymous, next: null, done: true };
  return { orders, anonymous, next: nextSlice(start, len, !after, res.orders.length, GQL_PAGE), done: false };
}

async function cloverPage(c: Conn, pass: Pass): Promise<Page> {
  const since = Date.parse(pass.since);
  const { end, k, len } = slicePos(pass);
  const start = Math.max(since, end - len);
  const offset = /^\d+$/.test(k) ? Number(k) : 0;
  const q = `filter=${encodeURIComponent(`createdTime>=${start}`)}&filter=${encodeURIComponent(`createdTime<${end}`)}` +
    `&expand=customers.addresses&limit=100&offset=${offset}`;
  const r = await fetchT(`https://api.clover.com/v3/merchants/${encodeURIComponent(c.merchant_id)}/orders?${q}`, {
    headers: { Authorization: `Bearer ${c.access_token}`, Accept: "application/json" },
  });
  if (!r.ok) throw new ProviderError("clover", "orders", r.status);
  const raw = arr(obj(await r.json()).elements).map(obj);
  const orders: Order[] = [];
  let anonymous = 0;
  for (const o of raw) {
    const m = cloverOrder(o);
    if (m && m.at) orders.push(m);
    else anonymous++;
  }
  if (raw.length === 100) return { orders, anonymous, next: `${end}:${offset + 100}:${len}`, done: false };
  if (start <= since) return { orders, anonymous, next: null, done: true };
  return { orders, anonymous, next: nextSlice(start, len, offset === 0, raw.length, 100), done: false };
}

async function stripePage(c: Conn, pass: Pass): Promise<Page> {
  if (!stripePlatformKey) return { orders: [], anonymous: 0, next: null, done: true };
  if (!trustedStripeAccount(c)) throw new ProviderError("stripe", "account", 403);
  const gte = Math.floor(Date.parse(pass.since) / 1000);
  const lt = Math.floor(Date.parse(pass.started) / 1000);
  const r = await fetchT(`https://api.stripe.com/v1/charges?limit=100&created[gte]=${gte}&created[lt]=${lt}${pass.pos ? `&starting_after=${encodeURIComponent(pass.pos)}` : ""}`, {
    headers: { Authorization: `Bearer ${stripePlatformKey}`, "Stripe-Account": c.merchant_id },
  });
  if (!r.ok) throw new ProviderError("stripe", "charges", r.status);
  const data = obj(await r.json());
  const charges = arr(data.data).map(obj);
  const orders: Order[] = [];
  let anonymous = 0;
  let next: string | null = pass.pos;
  for (const ch of charges) {
    next = str(ch.id) || next;
    if (!ch.paid || ch.refunded) continue;
    const m = stripeOrder(ch);
    if (m.email || m.phone) orders.push(m);
    else anonymous++;
  }
  return { orders, anonymous, next, done: !data.has_more || !charges.length };
}

function fetchPage(c: Conn, pass: Pass, sq: SquareCtx, deadline: number): Promise<Page> {
  if (c.platform === "square") return squarePage(c, pass, sq, deadline);
  if (c.platform === "shopify") return shopifyPage(c, pass);
  if (c.platform === "clover") return cloverPage(c, pass);
  return stripePage(c, pass);
}

// ---- tokens ----

async function ensureSquareToken(c: Conn, force: boolean): Promise<"ok" | "auth" | "transient"> {
  const exp = Date.parse(str(c.token_expires_at));
  const expiring = Number.isFinite(exp) && exp < Date.now() + SQUARE_REFRESH_BEFORE_MS;
  if (!force && !expiring) return "ok";
  if (!c.refresh_token || !squareAppId || !squareAppSecret) {
    return force || (Number.isFinite(exp) && exp <= Date.now()) ? "auth" : "ok";
  }
  let r: Response;
  try {
    r = await fetchT("https://connect.squareup.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Square-Version": SQUARE_VERSION, Accept: "application/json" },
      body: JSON.stringify({ client_id: squareAppId, client_secret: squareAppSecret, grant_type: "refresh_token", refresh_token: c.refresh_token }),
    });
  } catch {
    return "transient";
  }
  const d = obj(await r.json().catch(() => ({})));
  if (!r.ok || !str(d.access_token)) {
    console.error("platform-sync: square token refresh failed", c.id, r.status);
    return r.status === 400 || r.status === 401 ? "auth" : "transient";
  }
  c.access_token = str(d.access_token);
  if (str(d.refresh_token)) c.refresh_token = str(d.refresh_token);
  c.token_expires_at = str(d.expires_at) || null;
  try {
    await rest(`/rest/v1/platform_connections?id=eq.${c.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ access_token: c.access_token, refresh_token: c.refresh_token, token_expires_at: c.token_expires_at, updated_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.error("platform-sync: saving refreshed square token failed", c.id, e);
  }
  return "ok";
}

// Best effort: tell the provider Clicktide's access is over. Skipped when another
// business holds the same merchant actively, because Square and Stripe revoke the whole
// app grant for that merchant, not one token.
async function revokeIfUnshared(c: Conn, ms = FETCH_TIMEOUT_MS) {
  try {
    const others = await rest(`/rest/v1/platform_connections?platform=eq.${encodeURIComponent(c.platform)}&merchant_id=eq.${encodeURIComponent(c.merchant_id)}&is_active=eq.true&id=neq.${c.id}&select=id&limit=1`);
    if (arr(others).length) return;
    if (c.platform === "square" && squareAppId && squareAppSecret && c.merchant_id) {
      const r = await fetchT("https://connect.squareup.com/oauth2/revoke", {
        method: "POST",
        headers: { Authorization: `Client ${squareAppSecret}`, "Content-Type": "application/json", "Square-Version": SQUARE_VERSION },
        body: JSON.stringify({ client_id: squareAppId, merchant_id: c.merchant_id }),
      }, ms);
      if (!r.ok) console.error("platform-sync: square revoke", c.id, r.status);
    } else if (c.platform === "stripe" && stripePlatformKey && stripeConnectClientId && trustedStripeAccount(c)) {
      const r = await fetchT("https://connect.stripe.com/oauth/deauthorize", {
        method: "POST",
        headers: { Authorization: `Bearer ${stripePlatformKey}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: stripeConnectClientId, stripe_user_id: c.merchant_id }),
      }, ms);
      if (!r.ok) console.error("platform-sync: stripe deauthorize", c.id, r.status);
    } else if (c.platform === "shopify" && c.access_token && shopDomainOf(c)) {
      const r = await fetchT(`https://${shopDomainOf(c)}/admin/api_permissions/current.json`, {
        method: "DELETE", headers: { "X-Shopify-Access-Token": c.access_token },
      }, ms);
      if (!r.ok) console.error("platform-sync: shopify uninstall", c.id, r.status);
    }
  } catch (e) {
    console.error("platform-sync: provider revoke failed", c.id, e);
  }
}

// sync_cursor is kept (it holds only times and provider positions), so a reconnect of the
// same merchant carries on with an unfinished first import.
const wipedSecrets = () => ({ access_token: "", refresh_token: null, raw_response: {}, revoked_at: new Date().toISOString() });

// Connections the owner switched off in Settings (or replaced with another merchant): end
// the grant at the provider, then drop the stored tokens. Waits 10 minutes so a quick
// reconnect isn't revoked underneath.
async function sweepDisconnected(deadline: number) {
  let done = 0;
  if (Date.now() + REVOKE_TIMEOUT_MS + 3000 > deadline) return done;
  try {
    const cutoff = iso(Date.now() - 10 * 60000);
    const rows = await rest(`/rest/v1/platform_connections?is_active=eq.false&revoked_at=is.null&disconnected_at=lt.${encodeURIComponent(cutoff)}&select=id,user_id,platform,merchant_id,shop_domain,access_token,raw_response&limit=20`) as Conn[];
    for (const c of Array.isArray(rows) ? rows : []) {
      if (Date.now() + REVOKE_TIMEOUT_MS + 3000 > deadline) break;
      await revokeIfUnshared(c, REVOKE_TIMEOUT_MS);
      await rest(`/rest/v1/platform_connections?id=eq.${c.id}&is_active=eq.false&revoked_at=is.null`, {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(wipedSecrets()),
      });
      done++;
    }
  } catch (e) {
    console.error("platform-sync: disconnect sweep failed", e);
  }
  return done;
}

// Expired OAuth leftovers: provider grants nobody confirmed (they hold live tokens) and
// states that were never used. Both are single-use auth artifacts, not business data.
async function cleanupOAuth(deadline: number) {
  if (Date.now() + 3000 > deadline) return false;
  try {
    const now = new Date().toISOString();
    await rest(`/rest/v1/oauth_pending?expires_at=lt.${encodeURIComponent(now)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    await rest(`/rest/v1/oauth_states?expires_at=lt.${encodeURIComponent(iso(Date.now() - 86400000))}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    return true;
  } catch (e) {
    console.error("platform-sync: oauth cleanup failed", e);
    return false;
  }
}

// ---- alerts ----

async function sendEmail(to: string, subject: string, html: string) {
  if (!resendApiKey || !to) return false;
  try {
    const r = await fetchT("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: resendFrom, to: [to], subject, html }),
    }, 10_000);
    if (!r.ok) console.error("platform-sync: alert email failed", r.status);
    return r.ok;
  } catch {
    return false;
  }
}

async function opsEmail(subject: string, lines: string[]) {
  if (!(await underLimit("platform-sync:ops-email", 86400, 30, false))) return;
  await sendEmail(opsAlertTo, subject,
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827">${lines.map((l) => `<p style="margin:0 0 8px">${esc(l)}</p>`).join("")}</div>`);
}

async function resolveAlerts(userId: string, type: string) {
  await rest(`/rest/v1/alerts?user_id=eq.${encodeURIComponent(userId)}&type=eq.${type}&resolved=eq.false`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ resolved: true }),
  }).catch(() => {});
}

// The in-app reconnect alert is one per business, so it stays open while any of the
// business's active connections still needs a reconnect.
async function resolveReconnectAlert(c: Conn) {
  try {
    const still = await rest(`/rest/v1/platform_connections?user_id=eq.${encodeURIComponent(c.user_id)}&is_active=eq.true&sync_status=eq.needs_reconnect&id=neq.${c.id}&select=id&limit=1`);
    if (!arr(still).length) await resolveAlerts(c.user_id, "pos_reconnect");
  } catch { /* best effort */ }
}

async function reconnectAlert(c: Conn, why: string) {
  const name = label(c.platform);
  let biz: J = {};
  try {
    biz = obj(arr(await rest(`/rest/v1/clicktide?user_id=eq.${encodeURIComponent(c.user_id)}&select=email,business_name&limit=1`))[0]);
  } catch { /* still tell ops */ }
  try {
    const open = await rest(`/rest/v1/alerts?user_id=eq.${encodeURIComponent(c.user_id)}&type=eq.pos_reconnect&resolved=eq.false&select=id&limit=1`);
    if (!arr(open).length) {
      await rest("/rest/v1/alerts", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ user_id: c.user_id, type: "pos_reconnect", message: `Your ${name} connection stopped working (${why}). Reconnect it in Settings so new visits keep coming in.`, resolved: false }),
      });
    }
  } catch (e) {
    console.error("platform-sync: reconnect alert", c.id, e);
  }
  const to = str(biz.email);
  if (to && await underLimit(`platform-sync:owner-email:${c.user_id}`, 86400, 3, false)) {
    const merchant = cleanName(c.merchant_name);
    const business = str(biz.business_name);
    await sendEmail(to, `Action needed: reconnect ${name} to Clicktide`,
      `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111827;max-width:560px">
      <p>Hi,</p>
      <p>Clicktide can no longer read new sales from your ${esc(name)} account${merchant ? ` (${esc(merchant)})` : ""}${business ? ` for ${esc(business)}` : ""}. Until it is reconnected, new visits aren't recorded, so regulars can look like they've stopped coming and get win-back messages they don't need.</p>
      <p><b>To fix it:</b> open <a href="${esc(appBaseUrl)}">${esc(appBaseUrl)}</a>, go to Settings, click Disconnect on ${esc(name)}, then connect it again. It takes about a minute.</p>
      <p>Questions? Just reply to this email.</p>
      <p>— Clicktide</p></div>`);
  }
  await opsEmail(`Clicktide: ${name} connection needs reconnect (${str(biz.business_name) || c.user_id})`, [
    `Business: ${str(biz.business_name) || "(no name)"} · ${c.user_id}`,
    `Platform: ${name} · merchant ${c.merchant_id} · connection ${c.id}`,
    `Reason: ${why}`,
    "The owner got an email and an in-app alert. This business's visit data is frozen until they reconnect.",
  ]);
}

async function planLimitAlert(c: Conn, capped: number) {
  try {
    const open = await rest(`/rest/v1/alerts?user_id=eq.${encodeURIComponent(c.user_id)}&type=eq.plan_limit&resolved=eq.false&created_at=gt.${encodeURIComponent(iso(Date.now() - 86400000))}&select=id&limit=1`);
    if (arr(open).length) return;
    await rest("/rest/v1/alerts", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: c.user_id, type: "plan_limit", message: `${capped} new customers from your ${c.platform} sync couldn't be added — your plan's customer limit is reached. Upgrade to keep syncing.`, resolved: false }),
    });
  } catch { /* best effort */ }
}

// ---- one connection ----

async function claim(id: string, holder: string): Promise<boolean> {
  return (await rest("/rest/v1/rpc/clicktide_pos_claim", {
    method: "POST", body: JSON.stringify({ p_connection: id, p_holder: holder, p_seconds: CLAIM_SECONDS }),
  })) === true;
}

// Writes only while this run still holds the claim; extends it unless the patch releases it.
async function saveProgress(id: string, holder: string, patch: J) {
  const body = "sync_claimed_until" in patch ? patch : { ...patch, sync_claimed_until: iso(Date.now() + CLAIM_SECONDS * 1000) };
  await rest(`/rest/v1/platform_connections?id=eq.${id}&sync_claim_holder=eq.${encodeURIComponent(holder)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(body),
  });
}

async function releaseClaim(id: string, holder: string) {
  await saveProgress(id, holder, { sync_claimed_until: null, sync_claim_holder: null }).catch(() => {});
}

function classify(e: unknown): "auth" | "rate" | "transient" {
  if (e instanceof ProviderError) {
    if (e.status === 401 || e.status === 403) return "auth";
    if (e.status === 429) return "rate";
  }
  return "transient";
}

function describe(e: unknown) {
  if (e instanceof ProviderError) {
    if (e.status === 401 || e.status === 403) return `${label(e.platform)} refused the connection (${e.status})`;
    if (e.status === 429) return `${label(e.platform)} is rate limiting`;
    return e.message;
  }
  if (e instanceof Error && e.name === "AbortError") return "the platform did not answer in time";
  return "unexpected error";
}

async function applyPage(c: Conn, orders: Order[], own: Set<string>, st: Stats): Promise<"ok" | "inactive"> {
  const rows: J[] = [];
  for (const o of orders) {
    const email: string = cleanEmail(o.email);
    const raw: string = normalizePhone(o.phone);
    const phone = raw && !isJunkPhone(raw, own) ? raw : ""; // never match or store junk/own numbers
    if (!email && !phone) { st.anonymous++; continue; }
    const at = Date.parse(o.at);
    if (!o.id || !Number.isFinite(at)) { st.failed++; continue; }
    rows.push({
      id: o.id, email: email || null, phone: phone || null, name: cleanName(o.name) || null,
      amount: Math.round((Number(o.amount) || 0) * 100) / 100, at: iso(at),
      address: o.addr?.address || null, city: o.addr?.city || null, state: o.addr?.state || null, zip: o.addr?.zip || null,
      email_opt_out: o.emailOptOut === true,
      void: o.void === true,
    });
  }
  st.orders += rows.length;
  if (!rows.length) return "ok";
  const r = obj(await rest("/rest/v1/rpc/clicktide_pos_apply_orders", {
    method: "POST", body: JSON.stringify({ p_connection: c.id, p_orders: rows }),
  }));
  if (r.ok !== true) {
    if (r.reason === "inactive") return "inactive";
    throw new Error(`apply orders: ${str(r.reason) || "failed"}`);
  }
  st.applied += Number(r.applied) || 0;
  st.duplicates += Number(r.duplicates) || 0;
  st.updated += Number(r.updated) || 0;
  st.created += Number(r.created) || 0;
  st.capped += Number(r.capped) || 0;
  st.failed += Number(r.failed) || 0;
  st.addresses_imported += Number(r.addresses) || 0;
  st.opted_out += Number(r.opted_out) || 0;
  st.visits_recorded += Number(r.visits_recorded) || 0;
  return "ok";
}

async function recordFailure(c: Conn, holder: string, cur: Cursor, st: Stats, kind: "auth" | "transient", why: string): Promise<J> {
  const fails = (Number(c.sync_fail_count) || 0) + 1;
  const backoff = kind === "auth" ? 24 * 3600_000 : Math.min(2 * 3600_000 * fails, 12 * 3600_000);
  await saveProgress(c.id, holder, {
    sync_cursor: cur, sync_status: kind === "auth" ? "needs_reconnect" : "error", sync_error: why,
    sync_error_at: new Date().toISOString(), sync_fail_count: fails, sync_next_at: iso(Date.now() + backoff),
    sync_claimed_until: null, sync_claim_holder: null,
  }).catch((e) => console.error("platform-sync: recording failure", c.id, e));
  if (kind === "auth" && c.sync_status !== "needs_reconnect") await reconnectAlert(c, why);
  if (kind === "transient" && fails === 6) {
    await opsEmail(`Clicktide: ${label(c.platform)} sync failing for 12+ hours`, [
      `Connection ${c.id} · business ${c.user_id} · merchant ${c.merchant_id}`,
      `Last error: ${why}`,
      "It keeps retrying with backoff; its visit data is stale meanwhile.",
    ]);
  }
  if (st.capped) await planLimitAlert(c, st.capped);
  return { connection: c.id, platform: c.platform, ...st, error: why, kind };
}

// One phase of one connection: "head" (recent, moves last_synced_at) or "back" (the rest
// of a first import). c is updated in place so a later phase in the same run continues.
async function syncConnection(c: Conn, holder: string, runDeadline: number, own: Set<string>, phase: Phase): Promise<J> {
  const deadline = Math.min(runDeadline, Date.now() + CONN_SLICE_MS);
  const st: Stats = { orders: 0, applied: 0, duplicates: 0, updated: 0, created: 0, capped: 0, failed: 0, addresses_imported: 0, opted_out: 0, visits_recorded: 0, anonymous: 0, pages: 0 };
  const prevStatus = c.sync_status;
  const cur = planCursor(c, phase);
  if (!connUsable(c)) return await recordFailure(c, holder, cur, st, "auth", `the ${label(c.platform)} connection is incomplete`);
  if (c.platform === "square") {
    const t = await ensureSquareToken(c, false);
    if (t === "auth") return await recordFailure(c, holder, cur, st, "auth", "Square sign-in expired");
  }
  const pass = phase === "head" ? cur.head : cur.back;
  const sq: SquareCtx = { locIds: null, cursor: "", endAt: "", cache: new Map(), bulk: true };
  let refreshed = false;
  let done = !pass;
  let stop = "";
  while (pass && !done && !stop && st.pages < PAGES_PER_RUN && Date.now() < deadline) {
    let page: Page;
    try {
      page = await fetchPage(c, pass, sq, deadline);
    } catch (e) {
      if (c.platform === "square" && !refreshed && e instanceof ProviderError && e.status === 401) {
        refreshed = true;
        const t = await ensureSquareToken(c, true);
        if (t === "ok") continue;
        if (t === "auth") return await recordFailure(c, holder, cur, st, "auth", "Square sign-in expired");
        return await recordFailure(c, holder, cur, st, "transient", "Square token refresh failed");
      }
      const kind = classify(e);
      if (kind === "rate") { stop = describe(e); break; }
      return await recordFailure(c, holder, cur, st, kind, describe(e));
    }
    st.pages++;
    st.anonymous += page.anonymous;
    let applied: "ok" | "inactive";
    try {
      applied = await applyPage(c, page.orders, own, st);
    } catch (e) {
      console.error("platform-sync: applying orders failed", c.id, e);
      return await recordFailure(c, holder, cur, st, "transient", "saving imported orders failed");
    }
    if (applied === "inactive") {
      await releaseClaim(c.id, holder);
      return { connection: c.id, platform: c.platform, phase, ...st, skipped: "disconnected during sync" };
    }
    if (page.next != null) pass.pos = page.next;
    if (page.done) done = true;
    else if (page.stop) stop = page.stop;
    else await saveProgress(c.id, holder, { sync_cursor: cur });
  }
  const now = Date.now();
  const patch: J = { sync_status: "ok", sync_error: null, sync_fail_count: 0, sync_claimed_until: null, sync_claim_holder: null };
  if (pass && done) {
    if (phase === "head") {
      cur.head = null;
      patch.last_synced_at = pass.started;
      c.last_synced_at = pass.started;
    } else {
      cur.back = null;
      patch.sync_backfill_done_at = iso(now);
    }
  }
  const open = !!(cur.head || cur.back);
  // An unfinished pass (head or history) is due again on the next run.
  Object.assign(patch, { sync_cursor: open ? cur : null, sync_next_at: iso(open ? now : now + RESYNC_MS) });
  await saveProgress(c.id, holder, patch);
  Object.assign(c, { sync_cursor: patch.sync_cursor, sync_status: "ok", sync_fail_count: 0 });
  if (prevStatus !== "ok") await resolveReconnectAlert(c);
  if (st.capped) await planLimitAlert(c, st.capped);
  return {
    connection: c.id, platform: c.platform, phase, ...st, more: open,
    head_open: !!cur.head, backfilling: !!cur.back, ...(stop ? { paused: stop } : {}),
  };
}

// ---- a run ----

// rhythmUsers collects the businesses that got new orders this run, so the retention engine
// re-evaluates them (refreshRhythm) once the syncs are done.
async function syncConnections(o: { holder: string; userId: string; deadline: number; rhythmUsers: Set<string> }): Promise<J> {
  let filter = `is_active=eq.true&user_id=not.is.null&platform=in.(${SYNC_PLATFORMS.join(",")})`;
  if (o.userId) filter += `&user_id=eq.${encodeURIComponent(o.userId)}`;
  else filter += `&or=(sync_next_at.is.null,sync_next_at.lte.${encodeURIComponent(new Date().toISOString())})`;
  const conns = await rest(
    `/rest/v1/platform_connections?${filter}&select=${CONN_COLUMNS}&order=sync_next_at.asc.nullsfirst,last_synced_at.asc.nullsfirst&limit=${o.userId ? 20 : 200}`,
  ) as Conn[];

  const results: J[] = [];
  const ownNumbers = new Map<string, Set<string>>();
  const due = Array.isArray(conns) ? conns : [];
  // Free POS audit accounts that haven't started a plan: the audit already gave them their
  // report from PII-free facts, so their customers' names, emails and phones aren't copied
  // into Clicktide. The full import runs once their subscription starts. If the check
  // itself fails, sync as before.
  let auditOnly = new Set<string>();
  try { auditOnly = await freeAuditOnlyUsers(due.map((c) => c.user_id)); }
  catch (e) { console.error("platform-sync: free-audit check failed; syncing as before", e); }
  const list: Conn[] = [];
  let auditOnlySkipped = 0;
  for (const c of due) {
    if (!auditOnly.has(c.user_id)) { list.push(c); continue; }
    auditOnlySkipped++;
    results.push({ connection: c.id, platform: c.platform, skipped: "free audit account, no plan yet" });
    // Not due again until the next hourly run, so these rows can't crowd paying
    // businesses out of the 200 connections one run reads.
    if (!o.userId) {
      await rest(`/rest/v1/platform_connections?id=eq.${c.id}&is_active=eq.true`, {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ sync_next_at: iso(Date.now() + AUDIT_ONLY_RECHECK_MS) }),
      }).catch((e) => console.error("platform-sync: deferring audit-only connection", c.id, e));
    }
  }
  let attempted = 0, succeeded = 0, failedTransient = 0, deferred = 0, backfillDeferred = 0;
  const one = async (c: Conn, phase: Phase): Promise<J | null> => {
    let claimed = false;
    try {
      claimed = await claim(c.id, o.holder);
    } catch (e) {
      console.error("platform-sync: claim failed", c.id, e);
      failedTransient++;
      results.push({ connection: c.id, platform: c.platform, phase, error: "claim failed" });
      return null;
    }
    if (!claimed) { results.push({ connection: c.id, platform: c.platform, phase, skipped: "already syncing" }); return null; }
    if (phase === "head") attempted++;
    try {
      if (!ownNumbers.has(c.user_id)) ownNumbers.set(c.user_id, await businessOwnNumbers(c.user_id));
      const r = await syncConnection(c, o.holder, o.deadline, ownNumbers.get(c.user_id) || new Set<string>(), phase);
      results.push(r);
      if ((Number(r.applied) || 0) > 0) o.rhythmUsers.add(c.user_id);
      if (r.kind === "transient") failedTransient++;
      return r;
    } catch (e) {
      // Nothing about one connection may stop the others.
      console.error("platform-sync: connection crashed", c.id, e);
      failedTransient++;
      results.push({ connection: c.id, platform: c.platform, phase, error: "sync crashed" });
      await releaseClaim(c.id, o.holder);
      return null;
    }
  };
  // Round 1: every due connection brings its recent orders up to date. Round 2: first-import
  // history, with whatever time is left, so a long backfill never holds up anyone's new visits.
  const backlog: Conn[] = [];
  for (const c of list) {
    if (Date.now() > o.deadline - 3000) { deferred++; continue; }
    const r = await one(c, "head");
    if (r && !r.error && !r.skipped) {
      succeeded++;
      if (r.backfilling && !r.head_open && !r.paused) backlog.push(c);
    }
  }
  for (const c of backlog) {
    if (Date.now() > o.deadline - 5000) { backfillDeferred++; continue; }
    await one(c, "back");
  }
  return {
    ok: !(failedTransient > 0 && succeeded === 0),
    connections: due.length, audit_only_skipped: auditOnlySkipped, attempted, succeeded, failed: failedTransient, deferred,
    backfills: backlog.length, backfills_deferred: backfillDeferred,
    results: results.slice(0, 100),
  };
}

// Retention engine (shadow mode): re-evaluate each business that got new orders, so the
// dashboard's statuses reflect the visits just imported. Bounded: a call that would not fit
// before the deadline is left to the nightly clicktide_refresh_rhythm_all job (and
// campaign-runner refreshes a business itself before it evaluates it).
async function refreshRhythm(users: Set<string>, deadline: number): Promise<{ rhythm: J[]; rhythm_deferred: number }> {
  const rhythm: J[] = [];
  let deferredN = 0;
  for (const u of users) {
    if (Date.now() + RHYTHM_TIMEOUT_MS > deadline) { deferredN++; continue; }
    try {
      rhythm.push(obj(await rest("/rest/v1/rpc/clicktide_refresh_rhythm", { method: "POST", body: JSON.stringify({ p_user: u }) }, RHYTHM_TIMEOUT_MS)));
    } catch (e) {
      rhythm.push({ user_id: u, error: e instanceof Error ? (e.name === "AbortError" ? "timed out" : e.message) : String(e) });
    }
  }
  return { rhythm: rhythm.slice(0, 100), rhythm_deferred: deferredN };
}

async function leaseAcquire(holder: string): Promise<"ok" | "held" | "unavailable"> {
  try {
    const got = await rest("/rest/v1/rpc/clicktide_job_lease_acquire", {
      method: "POST", body: JSON.stringify({ p_job: "platform-sync", p_holder: holder, p_seconds: LEASE_SECONDS }),
    });
    return got === true ? "ok" : "held";
  } catch (e) {
    // Lease table missing or unreachable: run anyway. The ledger and the per-connection
    // claims already stop overlapping runs from double counting.
    console.error("platform-sync: lease unavailable", e);
    return "unavailable";
  }
}

async function leaseRelease(holder: string) {
  try {
    await rest("/rest/v1/rpc/clicktide_job_lease_release", { method: "POST", body: JSON.stringify({ p_job: "platform-sync", p_holder: holder }) });
  } catch { /* it expires on its own */ }
}

async function runStart(): Promise<number> {
  try {
    const rows = await rest("/rest/v1/engine_runs", {
      method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ job: "platform-sync" }),
    });
    const id = Number(obj(arr(rows)[0]).id);
    return Number.isFinite(id) ? id : 0;
  } catch {
    return 0;
  }
}

async function runFinish(id: number, ok: boolean, summary: J) {
  if (!id) return;
  try {
    await rest(`/rest/v1/engine_runs?id=eq.${id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ finished_at: new Date().toISOString(), ok, summary }),
    });
  } catch (e) {
    console.error("platform-sync: engine_runs update failed", e);
  }
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

function auditLimitations(imp: AuditImport, report: Record<string, unknown> = {}): string[] {
  const out: string[] = [];
  if (imp.source === "csv") out.push("Built from the CSV you uploaded. Names, emails and phone numbers stayed in your browser — only per-customer visit counts, spend and dates were sent.");
  else out.push(`Built from up to the last ${imp.window_days} days of completed orders in your ${imp.platform} account.`);
  if (imp.platform === "shopify" && imp.window_days && imp.window_days < AUDIT_DAYS) out.push(`Shopify only lets Clicktide read your last ${imp.window_days} days of orders until it approves full order-history access, so customers who order less often than that may not show a rhythm yet. The report will deepen automatically once access is approved.`);
  if (imp.anonymous_orders > 0) out.push(`${imp.anonymous_orders.toLocaleString("en-US")} order${imp.anonymous_orders === 1 ? " had" : "s had"} no customer email or phone attached (walk-ins, cash, guest checkouts), so they can't be tied to a person and aren't counted.`);
  if (imp.truncated && !imp.recent_history_missing) out.push("Your account has more history than the free audit reads in one pass, so the oldest orders in the window weren't included. A full sync runs after you subscribe.");
  if (imp.rejected_rows) out.push(`${imp.rejected_rows.toLocaleString("en-US")} CSV row${imp.rejected_rows === 1 ? " was" : "s were"} skipped because a date or amount couldn't be read.`);
  out.push("Customer satisfaction isn't in POS data, so unhappy customers can't be identified until Clicktide's post-visit surveys run.");
  out.push("Drift is judged against each customer's own usual gap between visits (the median of their past gaps, ignoring one-off long breaks) — the same engine Clicktide's dashboard and win-back campaigns use.");
  const conf = (report.confidence || {}) as Record<string, number>;
  const one = Number(conf.insufficient) || 0, low = Number(conf.low) || 0;
  if (one > 0) out.push(`${one.toLocaleString("en-US")} customer${one === 1 ? " has" : "s have"} only one visit, so there's no personal rhythm yet: they're compared with your business's typical gap and counted as estimates.`);
  if (low > 0) out.push(`${low.toLocaleString("en-US")} customer${low === 1 ? " has" : "s have"} only a few visits or very irregular ones, so their rhythm is a low-confidence estimate.`);
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
  const full = { ...report, import: imp, limitations: auditLimitations(imp, report), sufficient: suff.ok, insufficient_reasons: suff.reasons };
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
      truncated: opts.stats.truncated, recent_history_missing: recentMissing, window_days: opts.stats.window_days || AUDIT_DAYS,
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
    const conns = await rest(`/rest/v1/platform_connections?user_id=eq.${userId}&platform=eq.${platform}&is_active=eq.true&select=${CONN_COLUMNS}&order=updated_at.desc.nullslast&limit=1`) as Conn[];
    const conn = conns?.[0];
    if (!conn || !connUsable(conn)) return json({ error: "not_connected" }, 409);
    if (conn.platform === "square" && await ensureSquareToken(conn, false) === "auth") return json({ error: "not_connected" }, 409);
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
    // Clicktide's access ends at the provider too, and no token copy is left behind.
    const conns = await rest(`/rest/v1/platform_connections?user_id=eq.${userId}&revoked_at=is.null&select=id,user_id,platform,merchant_id,shop_domain,access_token,raw_response`) as Conn[];
    for (const c of Array.isArray(conns) ? conns : []) await revokeIfUnshared(c, 8000);
    const now = new Date().toISOString();
    await rest(`/rest/v1/platform_connections?user_id=eq.${userId}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ is_active: false, ...wipedSecrets(), last_synced_at: null, sync_cursor: null, sync_backfill_done_at: null, disconnected_at: now, updated_at: now }),
    });
    // Forget which orders were imported, so a later reconnect imports them again.
    await rest(`/rest/v1/pos_order_ledger?user_id=eq.${userId}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
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
    const part = ids.slice(i, i + 100);
    const chunk = part.map(encodeURIComponent).join(",");
    const audits = await rest(`/rest/v1/pos_audits?user_id=in.(${chunk})&select=user_id&limit=1000`) as { user_id: string }[];
    const withAudit = new Set((audits || []).map((a) => a.user_id));
    // PostgREST returns at most 1,000 rows. A full page may have cut some users off, so ask
    // about each user not seen yet, one row each.
    if (arr(audits).length >= 1000) {
      for (const u of part) {
        if (withAudit.has(u)) continue;
        const one = await rest(`/rest/v1/pos_audits?user_id=eq.${encodeURIComponent(u)}&select=user_id&limit=1`);
        if (arr(one).length) withAudit.add(u);
      }
    }
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
  try { body = await req.json(); } catch { /* cron may send no body */ }

  const fetchers: Record<string, (c: Conn, s: string, o?: FetchOpts) => Promise<Order[]>> = {
    square: squareOrders, shopify: shopifyOrders, clover: cloverOrders, stripe: stripeOrders,
  };
  if (typeof body?.mode === "string" && body.mode.startsWith("audit_")) {
    try { return await handleAudit(req, body, fetchers); }
    catch (e) { console.error("audit handler", e); return json({ error: "The audit service had a problem. Please try again." }, 500); }
  }

  // Auth: cron key (every due business) or a logged-in business (their own connections only).
  const key = req.headers.get("x-clicktide-cron-key") || "";
  const isCron = !!key && key === await expectedCronKey();
  const userId = isCron ? "" : await authedUserId(req);
  if (!isCron && !userId) return json({ error: "Not authorized" }, 401);

  const holder = crypto.randomUUID();
  if (!isCron) {
    if (!(await underLimit(`platform-sync:user:${userId}`, 600, 6))) return json({ error: "A sync just ran — try again in a few minutes." }, 429);
    try {
      const rhythmUsers = new Set<string>();
      const res = await syncConnections({ holder, userId, deadline: Date.now() + USER_BUDGET_MS, rhythmUsers });
      return json({ ...res, ...(await refreshRhythm(rhythmUsers, Date.now() + RHYTHM_TIMEOUT_MS + 1000)) });
    } catch (e) {
      console.error("platform-sync (on demand) failed", e);
      return json({ error: "Sync failed — it will retry automatically." }, 500);
    }
  }

  const t0 = Date.now();
  const lease = await leaseAcquire(holder);
  if (lease === "held") return json({ ok: true, skipped: "another platform-sync run holds the lease" });
  const runId = await runStart();
  let summary: J = {};
  let ok = false;
  try {
    const rhythmUsers = new Set<string>();
    summary = await syncConnections({ holder, userId: "", deadline: t0 + SYNC_BUDGET_MS, rhythmUsers });
    summary.revoked = await sweepDisconnected(t0 + HOUSEKEEPING_UNTIL_MS);
    summary.oauth_cleanup = await cleanupOAuth(t0 + HOUSEKEEPING_UNTIL_MS);
    Object.assign(summary, await refreshRhythm(rhythmUsers, t0 + HOUSEKEEPING_UNTIL_MS));
    summary.lease = lease;
    ok = summary.ok === true;
  } catch (e) {
    console.error("platform-sync run failed", e);
    summary = { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await runFinish(runId, ok, summary);
    if (lease === "ok") await leaseRelease(holder);
  }
  return json(summary, ok ? 200 : 500);
});
