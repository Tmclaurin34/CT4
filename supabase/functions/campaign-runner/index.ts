// Clicktide campaign engine. 2026-11-28: owner-verified offer codes — each customer gets their own one-time counter code (offer_codes, redeemed on the business's counter device) and/or one of the business's own website codes (offer_code_pool); a code offer only goes out after the owner's counter/website test passed. 2026-11-27 (package sms) — recipient-local quiet hours + double opt-in (see the SMS notes below). v43 — security hardening merged onto the retention-engine v42: complete reads (customers, campaigns and businesses are paged past PostgREST's 1,000-row cap; cooldowns, win-back touch counts and SMS usage come from one SQL aggregate, clicktide_campaign_state), the published "three win-back touches, then nothing until they return" rule, marketing vs. account/service text consent, per-business email opt-outs + signed per-business unsubscribe links, a real postal address in every email, wallet debits through the atomic ledger (clicktide_wallet_apply) BEFORE a postcard or overage text goes out, one live run at a time (job lease) with a run log (engine_runs) that ops-alerts watches, and a timed-out run resumes where it stopped. A provider that gives no clear answer (timeout) makes the touch "unconfirmed": kept paid, never refunded or retried; ledger, Lob and Resend calls carry the touch's idempotency key. A staff-triggered run needs clicktide_is_staff(['admin']) answered with the caller's own token (so the staff-MFA rule applies); gift auto-sends name their gift_catalog row. v42 — win-back runs on the shared retention engine: before each business is evaluated its customers' statuses are refreshed (clicktide_refresh_rhythm) and "inactive/win-back" fires on status drifting/at_risk (a campaign naming "at risk" or "drifting" targets just that status; an explicit day count still overrides). One-visit customers (no personal rhythm) are skipped unless the owner opts in (clicktide.winback_include_estimated). A customer gets a given win-back campaign at most once per drift episode. v26 — reliability: every external call (Resend/Twilio/Lob/Printify/Supabase) now has a hard timeout (fetchT), and the run stops cleanly at a 110s deadline (timed_out flag) so it can never hit the ~150s gateway 504; unreached businesses are picked up next hour (cooldown prevents double-sends). v25 — adds the New-Customer Welcome Journey: "welcome" / "second-visit nudge (day N)" / "win the second visit (day N)" triggers, keyed on first-visit recency + visit count, staged so a brand-new customer is walked through their first weeks (and the journey self-pauses the moment they return). v24 — win-back trigger is cadence-aware: "inactive/win-back" fires on each customer's OWN learned visit rhythm (effChurn), not a flat owner-set timer. Mirrors effChurn() in index.html so dashboard drift flags and actual sends agree. (v20 — backfill-safe: event triggers gated by campaign.created_at; 48h warm-up after first POS connection)
// SMS quiet hours (2026-11; recipient-local since 2026-11-27): customer texts leave only inside the
// RECIPIENT's send window — 9:00–20:00, Sundays 12:00–20:00 (see smsRecipientWindow). The
// recipient's zones come from the customer's own state, else their ZIP, else their phone's
// area code intersected with the business's zones (non-geographic / unlisted codes: the
// all-US window), else the business's state. A customer who is due a text while their
// window is closed has the WHOLE touch held, so the email and the text go out together on
// the first hourly run inside the window instead of the email's cooldown swallowing the
// text. Double opt-in (2026-11-27): a public check-in's marketing box only creates a PENDING
// request (sms_consent_requests); the customer is texted marketing only once a YES reply
// has set sms_consent=true. Pending is never consent here.
// Hourly via pg_cron (or staff admin). Customer-facing emails ship in a branded
// shell and cite the customer's real last visit. Physical gifts respect the
// business's gift_auto_send toggle: ON = order placed automatically through
// printify-fulfill-gift (internal cron-key call, wallet-funded); OFF (default)
// = queued as an alert for owner review. Auto-send failures fall back to the
// review queue so no gift is ever silently lost.

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || ""; // only for asking the database about the CALLER
const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL") || "Clicktide <support@goclicktide.com>";
const EMAIL_FROM_DOMAIN = "support@goclicktide.com"; // verified Resend sender; the display name is the business
const EMAIL_UNSUB_SECRET = Deno.env.get("EMAIL_UNSUB_SECRET") || serviceRoleKey; // signs one-click unsubscribe links
const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const twilioToken = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
const lobKey = Deno.env.get("LOB_API_KEY") || "";
const POSTCARD_PRICE = 1.5; // debited from the gift wallet per mailed postcard
const ADDRESS_FORM_URL = "https://goclicktide.com/gift-address";
const ADDRESS_ASK_COOLDOWN_DAYS = 14;
const lobFrontTpl = Deno.env.get("LOB_FRONT_TEMPLATE") || "";
const lobBackTpl = Deno.env.get("LOB_BACK_TEMPLATE") || "";

const MAX_SENDS_PER_BUSINESS = 25;
const PLAN_SMS_LIMITS: Record<string, number> = { local: 0, growth: 1500, scale: 5000 }; // local = 0 → texting is a Growth/Scale feature
const SMS_OVERAGE_PRICE = 0.05;

// The published promise: at most three win-back touches, then nothing until the customer
// comes back. They are also spaced, so a customer who was already long lapsed when the
// Playbook went in gets its steps a week apart instead of in one afternoon.
const WINBACK_MAX_TOUCHES = 3;
const WINBACK_MIN_GAP_DAYS = 7;
// An active POS connection that has not synced for this long has frozen visit data, so
// "hasn't been in" may be false: win-back and second-visit triggers wait for a sync.
// Only platforms platform-sync imports from count (Mindbody connections have no sync).
const POS_STALE_HOURS = 48;
const SYNCED_PLATFORMS = ["square", "shopify", "clover", "stripe"];
const PAGE_SIZE = 1000; // PostgREST max-rows here: a bigger page silently comes back cut to this
const LEASE_JOB = "campaign-runner";
const LEASE_SECONDS = 180; // longer than any run can last, so a killed run frees the lock long before the next hour
const GIFT_CALL_MS = 30000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-clicktide-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Campaign = {
  id: number;
  user_id: string;
  created_at?: string;
  name?: string;
  trigger?: string;
  campaign_type?: string;
  delivery_channel?: string;
  message?: string;
  sms_message?: string;
  gift_name?: string;
  gift_cost?: number;
  min_spend?: number;
  cooldown_days?: number;
  status?: string;
  postcard_design?: string;
  printify_product_id?: string;
  printify_variant_id?: number;
  gift_catalog_id?: string | null;
  reward_offer?: string;
  reward_code?: string;
  reward_link?: string;
  reward_expires?: string;
  reward_unique?: boolean;          // one-time code per customer (2026-11-28)
  reward_where?: string | null;     // store | web | both
  reward_credit?: number | null;    // dollars off (null for % off or a free item)
  reward_min_spend?: number | null;
  reward_valid_days?: number | null;
};

type Customer = {
  id: number;
  user_id: string;
  name?: string;
  email?: string;
  phone?: string;
  visits?: number;
  order_count?: number;
  total_spent?: number;
  satisfaction_score?: number;
  loyalty_score?: number;
  last_visit_at?: string;
  last_order_at?: string;
  last_order_amount?: number;
  first_order_at?: string;
  sms_consent?: boolean;
  sms_service_consent?: boolean;
  sms_unsubscribed_at?: string;
  email_unsubscribed_at?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  address_request_token?: string;
  address_requested_at?: string;
};

type Business = {
  id?: number;
  user_id: string;
  email?: string;
  business_name?: string;
  churn_days?: number;
  stripe_subscription_status?: string;
  plan?: string;
  logo_url?: string;
  state?: string;
  gift_auto_send?: boolean;
  winback_include_estimated?: boolean;
  address?: string;
  city?: string;
  zip?: string;
  offers_store_verified_at?: string | null;
  offers_web_verified_at?: string | null;
};

// clicktide_campaign_state(p_user): one jsonb value, so no row cap applies.
type SendState = {
  last?: Record<string, number>;
  touches?: Array<[number, number, number, number]>;
  triggers?: Record<string, string>;
  sms_used?: number;
  texted_recently?: number[];
};

type WalletResult = {
  ok?: boolean;
  duplicate?: boolean;
  reason?: string;
  balance?: number;
};

// Retention engine output for one customer (customer_rhythm).
type Rhythm = { status: string; status_since: string; episode_started_at?: string | null; confidence: string; drift_after_days?: number };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Fetch with a hard timeout. One slow provider (Resend/Twilio/Lob/Printify/Supabase)
// must never stall the whole hourly run into a gateway 504; on timeout this throws,
// which every caller treats as a normal failure (and falls back / records it).
function fetchT(url: string, init: RequestInit = {}, ms = 12000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function rest(path: string, init: RequestInit = {}) {
  const response = await fetchT(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  }, 15000);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.message || data?.error || response.statusText);
  return data;
}

async function restPage(path: string, offset: number) {
  const sep = path.includes("?") ? "&" : "?";
  const response = await fetchT(`${supabaseUrl}${path}${sep}limit=${PAGE_SIZE}&offset=${offset}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "count=exact",
    },
  }, 15000);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.message || data?.error || response.statusText);
  const total = /\/(\d+)\s*$/.exec(response.headers?.get("content-range") || "");
  return { rows: Array.isArray(data) ? data : [], total: total ? Number(total[1]) : -1 };
}

// Every row a read matches. A single PostgREST response stops at 1,000 rows without
// saying so; `path` must carry an order= so the pages don't shift under each other.
async function restAll(path: string) {
  const all = [];
  for (let offset = 0, pages = 0; pages < 500; pages++) {
    const { rows, total } = await restPage(path, offset);
    all.push(...rows);
    offset += rows.length;
    if (!rows.length || (total >= 0 ? offset >= total : rows.length < PAGE_SIZE)) break;
  }
  return all;
}

async function walletBalance(userId: string) {
  try {
    const data = await rest("/rest/v1/rpc/clicktide_wallet_balance", { method: "POST", body: JSON.stringify({ client_id: userId }) });
    return Number(data || 0);
  } catch {
    return 0;
  }
}

// The ledger's single atomic entry point (contract C1): it locks the wallet, refuses an
// overdraft and turns a repeated idempotency key into {duplicate:true} without a row.
async function walletApply(userId: string, delta: number, kind: string, description: string, reference: string, key: string): Promise<WalletResult> {
  const data = await rest("/rest/v1/rpc/clicktide_wallet_apply", {
    method: "POST",
    body: JSON.stringify({
      p_user: userId, p_delta: delta, p_kind: kind, p_description: description,
      p_reference: reference, p_idempotency_key: key,
    }),
  });
  return data && typeof data === "object" ? data : {};
}

// A call that timed out may still have committed, so it is asked once more with the same
// key: the ledger then answers duplicate:true instead of charging twice. null = unreachable.
async function walletApplySafe(userId: string, delta: number, kind: string, description: string, reference: string, key: string): Promise<WalletResult | null> {
  try {
    return await walletApply(userId, delta, kind, description, reference, key);
  } catch {
    return await walletApply(userId, delta, kind, description, reference, key).catch(() => null);
  }
}

// Whether the ledger holds a row with this idempotency key (null = it couldn't be read).
async function ledgerHas(key: string) {
  try {
    const rows = await rest(`/rest/v1/wallet?idempotency_key=eq.${encodeURIComponent(key)}&select=id&limit=1`);
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return null;
  }
}

// campaign_id:customer_id:channel:UTC date — one paid touch per pair, channel and day.
function sendKey(campaign: Campaign, customer: Customer, channel: string) {
  return `${campaign.id}:${customer.id}:${channel}:${new Date().toISOString().slice(0, 10)}`;
}

function utcDayStart() {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
}

async function expectedCronKey() {
  try {
    const data = await rest("/rest/v1/rpc/clicktide_internal_key", { method: "POST", body: "{}" });
    return String(data || "");
  } catch {
    return "";
  }
}

// Constant-time string compare for the cron key.
function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A staff-triggered run (it can send to every business) is allowed only when the database
// says the CALLER is an active admin: clicktide_is_staff is asked with the caller's own
// token, never the service role, so the staff rules there decide — including the C6 rule
// that staff powers need an MFA (aal2) session once 'staff_require_mfa' is switched on.
// Any error, a missing anon key or anything but a literal `true` = not allowed.
async function isStaffAdmin(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!/^bearer\s+\S+/i.test(authorization)) return false;
  if (!anonKey) return false;
  try {
    const response = await fetchT(`${supabaseUrl}/rest/v1/rpc/clicktide_is_staff`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ required_roles: ["admin"] }),
    }, 10000);
    if (!response.ok) return false;
    return (await response.json().catch(() => null)) === true;
  } catch {
    return false;
  }
}

// ── One live run at a time, and a log of every run (contract C5) ──────────────────
async function leaseAcquire(holder: string) {
  const got = await rest("/rest/v1/rpc/clicktide_job_lease_acquire", {
    method: "POST",
    body: JSON.stringify({ p_job: LEASE_JOB, p_holder: holder, p_seconds: LEASE_SECONDS }),
  });
  return got === true;
}

async function leaseRelease(holder: string) {
  await rest("/rest/v1/rpc/clicktide_job_lease_release", {
    method: "POST",
    body: JSON.stringify({ p_job: LEASE_JOB, p_holder: holder }),
  }).catch(() => {}); // it expires on its own
}

async function runStart() {
  try {
    const rows = await rest("/rest/v1/engine_runs", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ job: LEASE_JOB }),
    });
    return Array.isArray(rows) && rows[0]?.id ? Number(rows[0].id) : 0;
  } catch {
    return 0;
  }
}

async function runFinish(id: number, ok: boolean, summary: unknown) {
  if (!id) return;
  await rest(`/rest/v1/engine_runs?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ finished_at: new Date().toISOString(), ok, summary }),
  }).catch(() => {}); // ops-alerts reports a run that never finished
}

// The business the last run did not get to when it ran out of time ("" = start at the top).
async function resumePoint() {
  try {
    const rows = await rest(
      `/rest/v1/engine_runs?job=eq.${LEASE_JOB}&finished_at=not.is.null&order=started_at.desc&limit=1&select=summary`,
    );
    const s = Array.isArray(rows) && rows[0] ? rows[0].summary : null;
    return s && s.timed_out && typeof s.resume_from === "string" ? s.resume_from : "";
  } catch {
    return "";
  }
}

async function campaignState(userId: string): Promise<SendState> {
  const data = await rest("/rest/v1/rpc/clicktide_campaign_state", {
    method: "POST",
    body: JSON.stringify({ p_user: userId }),
  });
  if (!data || typeof data !== "object") throw new Error("campaign state unavailable");
  return data;
}

function daysSince(value?: string | null) {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

// Rough business-state -> IANA timezone so visit times read correctly.
function tzForState(st?: string) {
  const s = String(st || "").toUpperCase().trim();
  if (["CA", "WA", "OR", "NV"].includes(s)) return "America/Los_Angeles";
  if (s === "AZ") return "America/Phoenix";
  if (["CO", "UT", "NM", "MT", "WY", "ID"].includes(s)) return "America/Denver";
  if (["TX", "IL", "MN", "WI", "MO", "LA", "OK", "KS", "NE", "SD", "ND", "IA", "AR", "MS", "AL"].includes(s)) return "America/Chicago";
  return "America/New_York";
}

// "May 27 at 2:14 PM" — the proof-it's-real line. Empty when no timestamp.
function fmtLastVisit(value?: string | null, state?: string) {
  if (!value) return "";
  const t = Date.parse(value);
  if (Number.isNaN(t)) return "";
  const tz = tzForState(state);
  const d = new Date(t);
  const date = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: tz }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(d);
  return `${date} at ${time}`;
}

// Per-customer drift threshold: learn each customer's OWN visit rhythm from POS
// history instead of trusting the owner's flat guess. cadence = avg gap between
// visits = (last_activity - first_order) / (visits-1); threshold = clamp(cadence*1.5, 14, 120).
// Falls back to the business default for new/thin-history customers (visits<2 or no
// first_order). MUST mirror effChurn() in index.html so the dashboard's "drifting"
// flag and the actual win-back sends agree — otherwise the owner sees a customer
// flagged as drifting on the dashboard but the engine fires on a different timer.
function effChurn(c: Customer, def = 60): number {
  const v = Number(c.visits || c.order_count || 0);
  const fo = c.first_order_at ? Date.parse(c.first_order_at) : NaN;
  const la = Date.parse(c.last_visit_at || c.last_order_at || "");
  if (v >= 2 && !Number.isNaN(fo) && !Number.isNaN(la) && la > fo) {
    const cad = (la - fo) / 86400000 / (v - 1);
    if (Number.isFinite(cad) && cad > 0) return Math.max(14, Math.min(120, Math.round(cad * 1.5)));
  }
  return def || 60;
}

function matchesTrigger(trigger: string, c: Customer, churnDays: number, campCreatedAt?: string, rh?: Rhythm, includeEstimated = false) {
  // Event-style triggers only react to activity AFTER the campaign was created —
  // imported history is a baseline, never a trigger (prevents day-one backfill blasts).
  const campAt = campCreatedAt ? Date.parse(campCreatedAt) : 0;
  const lastActivity = Date.parse(c.last_visit_at || c.last_order_at || "") || 0;
  const postActivation = !campAt || lastActivity > campAt;
  const t = (trigger || "").toLowerCase();
  const numMatch = t.match(/(\d+)/);
  const num = numMatch ? parseInt(numMatch[1], 10) : null;
  const visits = c.visits || c.order_count || 0;
  const since = daysSince(c.last_visit_at || c.last_order_at);
  // First-activity recency, for the Welcome Journey. Prefer first_order_at; for a
  // single-visit customer with no first_order_at, their only visit IS their first.
  const firstAct = c.first_order_at || (visits <= 1 ? (c.last_visit_at || c.last_order_at) : null);
  const sinceFirst = daysSince(firstAct);

  // New-customer Welcome Journey (first-100-days). The only triggers keyed on
  // first-visit recency + visit count, to walk a brand-new customer through their
  // first weeks and turn a one-timer into a regular. postActivation guarantees we
  // never "welcome" the existing base — only customers whose first visit lands AFTER
  // the journey is installed. The second-visit stages only fire while visits<=1, so
  // the journey self-pauses the moment they come back.
  if (/welcome|second[- ]?visit|win (the )?second|first[- ]?100/.test(t)) {
    const secondVisit = /second|win/.test(t);
    if (secondVisit) {
      // Windowed by day so the day-12 and day-30 stages never double-fire (contiguous at 30).
      const lo = num || 12;
      const hi = lo < 20 ? 30 : (lo + 45);
      return { match: visits <= 1 && sinceFirst !== null && sinceFirst >= lo && sinceFirst < hi && postActivation, reason: "second_visit" };
    }
    // Plain welcome: shortly after the first visit, once (cooldown handles repeats).
    const within = num ? num + 5 : 7;
    return { match: sinceFirst !== null && sinceFirst <= within && postActivation, reason: "welcome" };
  }

  // Anniversary / tenure: "1-Year Anniversary", "12 months with us", "2-year member" —
  // months since the customer's first known order. Yearly cooldown makes it recur.
  if (/anniversary|year (with|together|member)|months? with|member for/.test(t)) {
    const months = num ? (/year/.test(t) && num <= 10 ? num * 12 : num) : 12;
    const firstAt = c.first_order_at ? Date.parse(c.first_order_at) : NaN;
    const tenureMonths = Number.isNaN(firstAt) ? 0 : (Date.now() - firstAt) / (30.44 * 86400000);
    return { match: tenureMonths >= months, reason: "anniversary" };
  }
  if (/inactive|win[- ]?back|churn/.test(t)) {
    // An explicit number in the trigger ("inactive 90 days") is an owner override
    // and wins; otherwise use the customer's learned rhythm so a quarterly regular
    // isn't chased at the flat default. Same model as the dashboard drift flag.
    if (num) return { match: since !== null && since >= num, reason: "inactive" };
    if (rh) {
      // The shared retention engine decides. One-visit customers have no personal
      // rhythm yet; they're only chased if the owner has opted in.
      if (rh.confidence === "insufficient" && !includeEstimated) return { match: false, reason: "inactive_estimated" };
      const atRiskOnly = /at[- ]?risk/.test(t);
      const driftOnly = !atRiskOnly && /drift/.test(t);
      const ok = atRiskOnly ? rh.status === "at_risk" : driftOnly ? rh.status === "drifting" : (rh.status === "drifting" || rh.status === "at_risk");
      return { match: ok, reason: "inactive" };
    }
    // Not evaluated by the engine yet: previous per-customer rule.
    const threshold = effChurn(c, churnDays || 60);
    return { match: since !== null && since >= threshold, reason: "inactive" };
  }
  if (/first (purchase|visit|order|class|payment)|new customer|welcome/.test(t)) {
    return { match: visits >= 1 && postActivation, reason: "first" };
  }
  if (num && /(visit|order|class|milestone)/.test(t) && !/\$/.test(t)) {
    return { match: visits >= num && postActivation, reason: "milestone" };
  }
  // High-ticket / big-spender rewards: "Spent $500+", "High-Ticket $1,000", "premium package buyer"
  const dollarMatch = t.match(/\$\s*([\d,]+)/);
  const dollars = dollarMatch ? parseInt(dollarMatch[1].replace(/,/g, ""), 10) : null;
  // Single big order: "Single order $500+", "one $500 cart", "big purchase over $500" —
  // fires on the most recent order amount, within a 14-day freshness window so old
  // orders never retro-trigger. Cooldown handles repeat big orders gracefully.
  if (/(one|single|per)[- ]?(order|purchase|cart)|order (of|over)|cart (of|over)|big (order|purchase)/.test(t)) {
    const threshold = dollars || 500;
    const recent = since !== null && since <= 14;
    return { match: recent && postActivation && (Number(c.last_order_amount) || 0) >= threshold, reason: "bigorder" };
  }
  if (/spent|high[- ]?ticket|big[- ]?spender|top customer|premium (buyer|package)/.test(t)) {
    const threshold = dollars || 500;
    return { match: (c.total_spent || 0) >= threshold, reason: "highticket" };
  }
  if (/vip|loyal/.test(t)) {
    return { match: (c.loyalty_score || 0) >= 75, reason: "vip" };
  }
  return { match: false, reason: "unsupported" };
}

// Which matchesTrigger branch a campaign's trigger text selects (the text alone decides).
function triggerReason(trigger: string) {
  return matchesTrigger(trigger, { id: 0, user_id: "" }, 60).reason;
}

function fillTemplate(template: string, customer: Customer, businessName: string) {
  const firstName = (customer.name || "there").trim().split(/\s+/)[0];
  return template
    .replaceAll("{{first_name}}", firstName)
    .replaceAll("{{business_name}}", businessName || "us");
}

// US numbers only — a business's carrier registration covers domestic texting, so a
// "+<country>" number stored via the public check-in form is unreachable, not a target.
function normalizePhone(value?: string | null) {
  const digits = String(value || "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : "";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Text stored for the dashboard: angle brackets never belong in a name and would carry HTML.
function plainText(value: string) {
  return String(value || "").replace(/[<>]/g, "");
}

// The customer-facing "From" shows the BUSINESS name — recipients recognize their own
// salon/shop, not "Clicktide" — sent from the one verified, authenticated domain.
function bizFrom(name: string): string {
  const clean = (name || "Clicktide").replace(/[<>"\r\n,;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Clicktide";
  return `${clean} <${EMAIL_FROM_DOMAIN}>`;
}

// One-click unsubscribe link for THIS business (contract C2): signed over
// user_id|address, so it opts the address out of this business only and can't be forged.
async function unsubUrlFor(userId: string, email: string): Promise<string> {
  const addr = (email || "").trim().toLowerCase();
  const uid = String(userId || "");
  if (!addr || !uid) return "";
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(EMAIL_UNSUB_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${uid}|${addr}`));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${supabaseUrl}/functions/v1/email-unsubscribe?b=${encodeURIComponent(uid)}&e=${encodeURIComponent(addr)}&s=${hex}`;
  } catch {
    return "";
  }
}

// Per run: each business's own mailing-address line, when its profile has a full one.
const postalByUser = new Map<string, string>();

function postalLine(biz: Business, businessName: string) {
  const street = String(biz.address || "").trim();
  const city = String(biz.city || "").trim();
  const st = String(biz.state || "").trim();
  const zip = String(biz.zip || "").trim();
  return street && city && st && zip ? `${businessName}, ${street}, ${city}, ${st} ${zip}` : "";
}

// The physical postal address every commercial email must carry (CAN-SPAM): the
// business's own, else Clicktide's mailing address as the sender of record. "" means
// there is none, and no email may go out.
function postalFor(userId: string, businessName: string) {
  const own = postalByUser.get(String(userId || "")) || "";
  if (own) return own;
  const fallback = (Deno.env.get("CLICKTIDE_POSTAL_ADDRESS") || "").trim();
  return fallback ? `Sent on behalf of ${businessName} by Clicktide, ${fallback}` : "";
}

// This business's whole opt-out list (contract C2, written by email-unsubscribe), read
// once per run. null = it couldn't be read, so the business gets no email this run.
async function loadSuppressions(userId: string) {
  try {
    const rows = await restAll(
      `/rest/v1/email_suppressions?user_id=eq.${encodeURIComponent(userId)}&select=email_lower&order=email_lower.asc`,
    );
    return new Set(rows.map((r) => String(r.email_lower || "")));
  } catch {
    return null;
  }
}

// Per run, read only for businesses that actually reach an email (cleared at run start).
const suppressionCache = new Map();
function suppressionsFor(userId: string): Promise<Set<string> | null> {
  let list = suppressionCache.get(userId);
  if (!list) {
    list = loadSuppressions(userId);
    suppressionCache.set(userId, list);
  }
  return list;
}

// One address on that list; null = the list couldn't be read, so no email.
async function emailSuppressed(userId: string, email: string) {
  try {
    const rows = await rest(
      `/rest/v1/email_suppressions?user_id=eq.${encodeURIComponent(userId)}&email_lower=eq.${encodeURIComponent(email.trim().toLowerCase())}&select=email_lower&limit=1`,
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return null;
  }
}

// Branded shell for customer-facing emails. Header centering uses a table cell
// with align=center — the only method every mail client respects. The footer carries
// the CAN-SPAM essentials: why-you're-getting-this, a working unsubscribe, and a
// physical mailing address.
function brandedShell(businessName: string, inner: string, whiteLabel: boolean, logoUrl = "", brandColor = "#0B62D6", unsubUrl = "", postal = "") {
  const header = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="" width="56" style="max-height:56px;display:inline-block;vertical-align:middle"/><div style="font-size:15px;font-weight:bold;color:#111827;margin-top:6px">${escapeHtml(businessName)}</div>`
    : `<div style="font-size:23px;font-weight:bold;color:${escapeHtml(brandColor)}">${escapeHtml(businessName)}</div>`;
  const unsub = unsubUrl ? `<a href="${escapeHtml(unsubUrl)}" style="color:#9CA3AF;text-decoration:underline">Unsubscribe</a> · ` : "";
  const powered = whiteLabel ? "" : `Sent via <a href="https://goclicktide.com" style="color:#9CA3AF;text-decoration:underline">Clicktide</a> · `;
  const footer = `You're receiving this because you're a customer of ${escapeHtml(businessName)}.<br>${unsub}${powered}${escapeHtml(postal)}`;
  return `<div style="background:#F4F5F7;padding:26px 12px;font-family:Arial,Helvetica,sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border-radius:14px;border:1px solid #E9EBEF">
      <tr><td align="center" style="padding:26px 30px 20px;border-bottom:1px solid #F0F1F4">${header}</td></tr>
      <tr><td style="padding:26px 30px;color:#1F2937;font-size:15px;line-height:1.7">${inner}</td></tr>
      <tr><td align="center" style="padding:16px 30px 22px;border-top:1px solid #F0F1F4;font-size:11px;color:#9CA3AF;line-height:1.7">${footer}</td></tr>
    </table></td></tr></table></div>`;
}

function normalizeUrl(u: string): string {
  const s = (u || "").trim();
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : "https://" + s;
}
function fmtExpires(d?: string): string {
  if (!d) return "";
  try {
    return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}
// One-time offer codes (2026-11-28). Counter codes come from clicktide_offer_code_issue (Clicktide
// checks them itself on the business's counter device, so the register never has to know them);
// website codes are the business's OWN codes from offer_code_pool, created in their store's
// discount settings, so their checkout accepts them. null = a needed code couldn't be issued
// (pool empty / RPC down): the touch waits for the next run instead of going out without it.
type OfferCodes = { store: string | null; web: string | null; expires: string | null };
const OFFER_LINK_BASE = Deno.env.get("OFFER_LINK_BASE") || "https://goclicktide.com/o?c=";
function offerKey(campaign: Campaign, customer: Customer, kind: string) {
  return `offer:${kind}:${campaign.id}:${customer.id}:${new Date().toISOString().slice(0, 10)}`;
}
async function offerCodesFor(userId: string, campaign: Campaign, customer: Customer, needStore: boolean, needWeb: boolean): Promise<OfferCodes | null> {
  const offer = (campaign.reward_offer || "").trim();
  const days = Number(campaign.reward_valid_days || 0);
  const expires = days > 0
    ? new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
    : (campaign.reward_expires || null);
  const out: OfferCodes = { store: null, web: null, expires };
  try {
    if (needStore) {
      const d = await rest("/rest/v1/rpc/clicktide_offer_code_issue", {
        method: "POST",
        body: JSON.stringify({
          p_user: userId, p_customer: customer.id, p_campaign: campaign.id, p_offer: offer,
          p_credit: campaign.reward_credit ?? null, p_min_spend: campaign.reward_min_spend ?? 0,
          p_expires: expires, p_issue_key: offerKey(campaign, customer, "store"),
        }),
      });
      out.store = String((d as { code?: string } | null)?.code || "") || null;
      if (!out.store) return null;
    }
    if (needWeb) {
      const d = await rest("/rest/v1/rpc/clicktide_offer_pool_assign", {
        method: "POST",
        body: JSON.stringify({ p_user: userId, p_customer: customer.id, p_campaign: campaign.id, p_issue_key: offerKey(campaign, customer, "web") }),
      });
      out.web = String((d as { code?: string } | null)?.code || "") || null;
      if (!out.web) return null;
    }
    return out;
  } catch {
    return null;
  }
}
function uniqueRewardBlocks(campaign: Campaign, codes: OfferCodes): { html: string; sms: string } {
  const offer = (campaign.reward_offer || "").trim();
  const exp = fmtExpires(codes.expires || undefined);
  const box = (c: string) => `<div style="margin:8px 0 2px"><span style="display:inline-block;border:2px dashed #0B62D6;border-radius:10px;padding:9px 18px;font-family:'Courier New',monospace;font-size:20px;font-weight:bold;letter-spacing:2px;color:#0B62D6">${escapeHtml(c)}</span></div>`;
  const storeLink = codes.store ? OFFER_LINK_BASE + encodeURIComponent(codes.store) : "";
  const webLink = normalizeUrl(campaign.reward_link || "");
  const storePart = codes.store
    ? `<div style="font-size:12px;color:#6B7280;margin-top:10px">In store: show this code at the counter</div>${box(codes.store)}<div style="margin:8px 0 0"><a href="${escapeHtml(storeLink)}" style="display:inline-block;background:#0B62D6;color:#FFFFFF;font-size:14px;font-weight:bold;text-decoration:none;padding:10px 22px;border-radius:8px">Open my code</a></div>`
    : "";
  const webPart = codes.web
    ? `<div style="font-size:12px;color:#6B7280;margin-top:14px">Online: enter this code at checkout</div>${box(codes.web)}${webLink ? `<div style="margin:8px 0 0"><a href="${escapeHtml(webLink)}" style="display:inline-block;background:#0B62D6;color:#FFFFFF;font-size:14px;font-weight:bold;text-decoration:none;padding:10px 22px;border-radius:8px">Shop online</a></div>` : ""}`
    : "";
  const expRow = exp ? `<div style="font-size:12px;color:#6B7280;margin-top:10px">Works once · expires ${escapeHtml(exp)}</div>` : `<div style="font-size:12px;color:#6B7280;margin-top:10px">Works once</div>`;
  const html = `<div style="margin:18px 0 0;background:#F0F6FF;border:1px solid #D6E4FF;border-radius:12px;padding:18px;text-align:center">${
    offer ? `<div style="font-size:16px;font-weight:bold;color:#0B3D91">${escapeHtml(offer)}</div>` : ""
  }${storePart}${webPart}${expRow}</div>`;
  let sms = offer ? ` ${offer}.` : "";
  if (codes.store) sms += ` In store, show code ${codes.store}: ${storeLink}`;
  if (codes.web) sms += `${codes.store ? "." : ""} Online, use code ${codes.web} at checkout.`;
  if (exp) sms += ` Expires ${exp}.`;
  return { html, sms: " —" + sms };
}

// Build the digital-reward block (promo code / offer / online link) for email + SMS.
function rewardBlocks(campaign: Campaign, codes: OfferCodes | null = null): { html: string; sms: string } {
  if (codes && (codes.store || codes.web)) return uniqueRewardBlocks(campaign, codes);
  const offer = (campaign.reward_offer || "").trim();
  const code = (campaign.reward_code || "").trim();
  const link = normalizeUrl(campaign.reward_link || "");
  if (!offer && !code && !link) return { html: "", sms: "" };
  const exp = fmtExpires(campaign.reward_expires);
  const codeRow = code
    ? `<div style="margin:12px 0 2px"><span style="display:inline-block;border:2px dashed #0B62D6;border-radius:10px;padding:9px 18px;font-family:'Courier New',monospace;font-size:20px;font-weight:bold;letter-spacing:2px;color:#0B62D6">${escapeHtml(code)}</span></div>`
    : "";
  const linkBtn = link
    ? `<div style="margin:12px 0 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#0B62D6;color:#FFFFFF;font-size:14px;font-weight:bold;text-decoration:none;padding:11px 24px;border-radius:8px">Use it online</a></div>`
    : "";
  const expRow = exp ? `<div style="font-size:12px;color:#6B7280;margin-top:10px">Expires ${escapeHtml(exp)}</div>` : "";
  const html = `<div style="margin:18px 0 0;background:#F0F6FF;border:1px solid #D6E4FF;border-radius:12px;padding:18px;text-align:center">${
    offer ? `<div style="font-size:16px;font-weight:bold;color:#0B3D91">${escapeHtml(offer)}</div>` : ""
  }${code ? `<div style="font-size:12px;color:#6B7280;margin-top:6px">Show this code:</div>` : ""}${codeRow}${linkBtn}${expRow}</div>`;
  let sms = "";
  if (offer) sms += ` ${offer}.`;
  if (code) sms += ` Code: ${code}.`;
  if (link) sms += ` ${link}`;
  if (exp) sms += ` (Expires ${exp})`;
  return { html, sms: sms.trim() ? " —" + sms : "" };
}

type EmailTemplate = {
  subject?: string;
  blocks?: Array<{ t: string; v?: string; s?: string; url?: string }>;
  brand?: { color?: string; btn?: string; font?: string; logo?: string };
  html?: string;
};

function renderTemplate(tpl: EmailTemplate, message: string, businessName: string, firstName: string, whiteLabel = false) {
  const brand = tpl.brand || {};
  const font = brand.font || "Arial";
  const fill = (s: string) =>
    escapeHtml(s).replaceAll("{{first_name}}", escapeHtml(firstName)).replaceAll("{{business_name}}", escapeHtml(businessName));
  const header = brand.logo
    ? `<img src="${escapeHtml(brand.logo)}" style="max-height:46px;max-width:200px;display:block;margin:0 auto 14px"/>`
    : `<div style="font-family:${font};font-size:20px;font-weight:bold;color:${brand.color || "#0B62D6"};text-align:center;margin-bottom:14px">${escapeHtml(businessName)}</div>`;
  const body = (tpl.blocks || []).map((b) => {
    if (b.t === "text") return `<div style="font-family:${font};font-size:${b.s === "greet" ? "16px" : "14px"};line-height:1.7;color:#111827;padding:6px 0">${fill(b.v || "").replaceAll("\n", "<br>")}</div>`;
    if (b.t === "button") return `<div style="text-align:center;padding:10px 0"><a href="${escapeHtml(b.url || "#")}" style="display:inline-block;background:${brand.btn || "#0B62D6"};color:#FFFFFF;font-family:${font};font-size:14px;font-weight:bold;text-decoration:none;padding:12px 28px;border-radius:8px">${fill(b.v || "")}</a></div>`;
    if (b.t === "divider") return `<div style="border-top:1px solid #E5E7EB;margin:14px 0"></div>`;
    if (b.t === "image" && b.url) return `<img src="${escapeHtml(b.url)}" style="max-width:100%;border-radius:8px;display:block;margin:8px auto"/>`;
    return "";
  }).join("");
  return `<div style="max-width:600px;margin:0 auto;background:#FFFFFF;padding:28px 26px">${header}${body}
    ${whiteLabel ? "" : `<div style="border-top:1px solid #F3F4F6;margin-top:18px;padding-top:12px;font-family:Arial;font-size:11px;color:#9CA3AF;text-align:center">Sent by Clicktide on behalf of ${escapeHtml(businessName)}.</div>`}</div>`;
}

// Unlayer-designed template: fill the merge tags in the exported HTML per customer.
function renderUnlayer(html: string, message: string, businessName: string, firstName: string) {
  return html
    .replaceAll("{{first_name}}", escapeHtml(firstName))
    .replaceAll("{{business_name}}", escapeHtml(businessName))
    .replaceAll("{{message}}", escapeHtml(message).replaceAll("\n", "<br>"));
}

// A 429 or 5xx from Resend means the shared account is throttled or down: stop emailing
// for the rest of the run instead of burning every remaining touch on the same error.
let resendBackoffUntil = 0;
function emailBackoff() {
  return Date.now() < resendBackoffUntil;
}

async function sendEmail(to: string, subject: string, message: string, businessName: string, customerName: string, htmlOverride?: string, whiteLabel = false, logoUrl = "", brandColor = "#0B62D6", lastVisitText = "", rewardHtml = "", userId = "", idemKey = "") {
  if (!resendApiKey) return { ok: false, retry: false, detail: "RESEND_API_KEY is not configured" };
  // CAN-SPAM: no working opt-out link or no postal address, no email.
  const unsubUrl = await unsubUrlFor(userId, to);
  if (!unsubUrl) return { ok: false, retry: false, detail: "unsubscribe link unavailable" };
  const postal = postalFor(userId, businessName);
  if (!postal) return { ok: false, retry: false, detail: "no postal address on file" };
  const first = escapeHtml(customerName.split(/\s+/)[0] || "there");
  const visitLine = lastVisitText
    ? `<p style="margin:18px 0 0;font-size:12px;color:#9CA3AF">\u{1F4CD} Your last visit to ${escapeHtml(businessName)}: ${escapeHtml(lastVisitText)}</p>`
    : "";
  const inner = `<p style="margin:0 0 14px">Hi ${first},</p><p style="margin:0">${escapeHtml(message).replaceAll("\n", "<br>")}</p>${visitLine}${rewardHtml}`;
  let html = htmlOverride ? (htmlOverride + rewardHtml) : brandedShell(businessName, inner, whiteLabel, logoUrl, brandColor, unsubUrl, postal);
  // A custom/Unlayer template can't contain this recipient's signed link, so it gets the
  // compliance footer appended; only a shell built for this recipient already has it.
  if (htmlOverride && !html.includes(escapeHtml(unsubUrl))) {
    html += `<div style="text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#9CA3AF;padding:14px 12px;line-height:1.7">${escapeHtml(postal)}<br><a href="${escapeHtml(unsubUrl)}" style="color:#9CA3AF;text-decoration:underline">Unsubscribe</a></div>`;
  }
  const listUnsub = { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  let response;
  try {
    // Same key for the same touch on the same UTC day: if this touch's send record is lost
    // and it is tried again today, Resend returns the first email instead of a second one.
    response = await fetchT("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
        ...(idemKey ? { "Idempotency-Key": idemKey } : {}),
      },
      body: JSON.stringify({ from: bizFrom(businessName), to: [to], subject, html, headers: listUnsub }),
    });
  } catch (e) {
    // The request may have reached Resend, so this is a final failure, never a retry.
    const why = e instanceof Error && e.name === "AbortError" ? "timeout" : "network error";
    return { ok: false, retry: false, detail: `Resend request failed: ${why}` };
  }
  const data = await response.json().catch(() => ({}));
  const retry = !response.ok && (response.status === 429 || response.status >= 500);
  if (retry) resendBackoffUntil = Date.now() + 10 * 60000;
  return { ok: response.ok, retry, detail: response.ok ? String(data.id || "") : String(data?.message || `Resend failed (${response.status})`) };
}

// ── SMS send window (quiet hours) ───────────────────────────────────────────
// Customer texts go out only 9:00–20:00 in the RECIPIENT's local time, and only
// 12:00–20:00 on Sundays. That sits inside the federal TCPA window (8am–9pm
// recipient-local) and the stricter state windows (e.g. FL/OK 8am–8pm; TX 9am–9pm
// Mon–Sat, noon–9pm Sunday). The cron fires every hour around the clock, so this
// gate — not the schedule — is what keeps texts out of quiet hours.
// SHARED BLOCK: campaign-runner and send-customer-sms carry this block byte for byte
// (from this banner to the end of smsWindowOpenFor) — change both together.
const SMS_WINDOW_START_HOUR = 9; // Monday–Saturday
const SMS_WINDOW_SUNDAY_START_HOUR = 12;
const SMS_WINDOW_END_HOUR = 20; // exclusive: the last text can leave at 19:59

const TZ_EASTERN = "America/New_York";
const TZ_CENTRAL = "America/Chicago";
const TZ_MOUNTAIN = "America/Denver";
const TZ_PACIFIC = "America/Los_Angeles";
const TZ_ALASKA = "America/Anchorage";
const TZ_HAWAII = "Pacific/Honolulu";

// Every time zone a state's territory touches. A text needs the window open in ALL
// of them, so a state split by a time-zone line (FL panhandle, El Paso TX, east TN…)
// is never texted early or late on its far side — it just gets a slightly shorter day.
// (campaign-runner's tzForState() is display-only: it guesses Eastern for anything it
// doesn't list — AK, HI, a blank state… — fine for a "last visit" line, unsafe for this.)
const SMS_ZONE_GROUPS: Array<[string, string[]]> = [
  ["CT DE DC GA ME MD MA NH NJ NY NC OH PA RI SC VT VA WV", [TZ_EASTERN]],
  ["FL IN KY MI TN", [TZ_EASTERN, TZ_CENTRAL]],
  ["AL AR IL IA LA MN MS MO OK WI", [TZ_CENTRAL]],
  ["KS NE ND SD TX", [TZ_CENTRAL, TZ_MOUNTAIN]],
  ["CO MT NM UT WY", [TZ_MOUNTAIN]],
  ["ID NV OR", [TZ_MOUNTAIN, TZ_PACIFIC]],
  ["CA WA", [TZ_PACIFIC]],
  ["AZ", ["America/Phoenix", TZ_MOUNTAIN]],
  ["AK", [TZ_ALASKA, "America/Adak"]],
  ["HI", [TZ_HAWAII]],
  ["PR VI", ["America/Puerto_Rico"]],
  ["GU MP", ["Pacific/Guam"]],
  ["AS", ["Pacific/Pago_Pago"]],
];
const SMS_STATE_ZONES: Record<string, string[]> = {};
for (const [codes, zones] of SMS_ZONE_GROUPS) {
  for (const code of codes.split(" ")) SMS_STATE_ZONES[code] = zones;
}

// The signup form takes the state as free text, so "ny", "N.Y." and "New York" all count.
const SMS_STATE_NAMES: Record<string, string> = {
  "ALABAMA": "AL", "ALASKA": "AK", "ARIZONA": "AZ", "ARKANSAS": "AR", "CALIFORNIA": "CA", "COLORADO": "CO",
  "CONNECTICUT": "CT", "DELAWARE": "DE", "DISTRICT OF COLUMBIA": "DC", "WASHINGTON DC": "DC", "FLORIDA": "FL",
  "GEORGIA": "GA", "HAWAII": "HI", "IDAHO": "ID", "ILLINOIS": "IL", "INDIANA": "IN", "IOWA": "IA", "KANSAS": "KS",
  "KENTUCKY": "KY", "LOUISIANA": "LA", "MAINE": "ME", "MARYLAND": "MD", "MASSACHUSETTS": "MA", "MICHIGAN": "MI",
  "MINNESOTA": "MN", "MISSISSIPPI": "MS", "MISSOURI": "MO", "MONTANA": "MT", "NEBRASKA": "NE", "NEVADA": "NV",
  "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC",
  "NORTH DAKOTA": "ND", "OHIO": "OH", "OKLAHOMA": "OK", "OREGON": "OR", "PENNSYLVANIA": "PA", "PUERTO RICO": "PR",
  "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", "TENNESSEE": "TN", "TEXAS": "TX", "UTAH": "UT",
  "VERMONT": "VT", "VIRGINIA": "VA", "WASHINGTON": "WA", "WEST VIRGINIA": "WV", "WISCONSIN": "WI", "WYOMING": "WY",
};

// No usable location: text only while the window is open everywhere from the East
// Coast to Hawaii (roughly 2–8pm Eastern).
const SMS_ZONES_UNKNOWN = [TZ_EASTERN, TZ_CENTRAL, TZ_MOUNTAIN, TZ_PACIFIC, TZ_ALASKA, TZ_HAWAII];

const smsHas = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// A recognised state / territory code for free-text input ("ny", "N.Y.", "New York",
// "Washington, D.C."), or "".
function smsStateCode(state?: string | null): string {
  const raw = String(state || "").toUpperCase().replace(/\./g, "").replace(/[^A-Z]+/g, " ").trim();
  const code = (smsHas(SMS_STATE_NAMES, raw) ? SMS_STATE_NAMES[raw] : "") || raw.replace(/ /g, "");
  return smsHas(SMS_STATE_ZONES, code) ? code : "";
}

function smsZonesForState(state?: string | null): string[] {
  const code = smsStateCode(state);
  return code ? SMS_STATE_ZONES[code] : SMS_ZONES_UNKNOWN;
}

// ZIP → state by its first three digits (USPS prefix allocation). Military (AA/AE/AP),
// unassigned prefixes, Wake Island and the freely associated states fall through to the
// next source.
const SMS_ZIP3: Array<[number, number, string]> = [
  [5, 5, "NY"], [6, 7, "PR"], [8, 8, "VI"], [9, 9, "PR"], [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"],
  [39, 49, "ME"], [50, 54, "VT"], [55, 55, "MA"], [56, 59, "VT"], [60, 69, "CT"], [70, 89, "NJ"],
  [100, 149, "NY"], [150, 196, "PA"], [197, 199, "DE"], [200, 200, "DC"], [201, 201, "VA"], [202, 205, "DC"],
  [206, 219, "MD"], [220, 246, "VA"], [247, 268, "WV"], [270, 289, "NC"], [290, 299, "SC"], [300, 319, "GA"],
  [320, 339, "FL"], [341, 342, "FL"], [344, 344, "FL"], [346, 347, "FL"], [349, 349, "FL"], [350, 369, "AL"],
  [370, 385, "TN"], [386, 397, "MS"], [398, 399, "GA"], [400, 427, "KY"], [430, 459, "OH"], [460, 479, "IN"],
  [480, 499, "MI"], [500, 528, "IA"], [530, 549, "WI"], [550, 567, "MN"], [569, 569, "DC"], [570, 577, "SD"],
  [580, 588, "ND"], [590, 599, "MT"], [600, 629, "IL"], [630, 658, "MO"], [660, 679, "KS"], [680, 693, "NE"],
  [700, 714, "LA"], [716, 729, "AR"], [730, 731, "OK"], [733, 733, "TX"], [734, 749, "OK"], [750, 799, "TX"],
  [800, 816, "CO"], [820, 831, "WY"], [832, 838, "ID"], [840, 847, "UT"], [850, 865, "AZ"], [870, 884, "NM"],
  [885, 885, "TX"], [889, 898, "NV"], [900, 961, "CA"], [967, 968, "HI"], [970, 979, "OR"], [980, 994, "WA"],
  [995, 999, "AK"],
];

function smsZipState(zip?: string | null): string {
  const m = /^(\d{5})(?:-?\d{4})?$/.exec(String(zip ?? "").trim());
  if (!m) return "";
  const z5 = Number(m[1]);
  if (z5 === 96799) return "AS"; // American Samoa shares Hawaii's 967 prefix
  if (z5 === 96898) return ""; // Wake Island (UTC+12) shares Hawaii's 968 prefix
  if (z5 >= 96910 && z5 <= 96932) return "GU";
  if (z5 >= 96950 && z5 <= 96952) return "MP";
  const z3 = Math.floor(z5 / 100);
  for (const [lo, hi, st] of SMS_ZIP3) if (z3 >= lo && z3 <= hi) return st;
  return "";
}

// NANP area code → the US state or territory it serves (NANPA assignments in service
// or announced as of 2026-11, checked against a public reference list). A number's
// area code says where it was issued, not where its owner is today (ported and moved
// numbers), so callers intersect it with the business's zones.
const SMS_AREA_CODE_GROUPS: Array<[string, string]> = [
  ["AL", "205 251 256 334 483 659 938"],
  ["AK", "907"],
  ["AZ", "480 520 602 623 928"],
  ["AR", "327 479 501 870"],
  ["CA", "209 213 279 310 323 341 350 357 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 738 747 760 805 818 820 831 837 840 858 909 916 925 949 951"],
  ["CO", "303 719 720 748 970 983"],
  ["CT", "203 475 860 959"],
  ["DE", "302"],
  ["DC", "202 771"],
  ["FL", "239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 850 863 904 941 954"],
  ["GA", "229 404 470 478 678 706 762 770 912 943"],
  ["HI", "808"],
  ["ID", "208 986"],
  ["IL", "217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872"],
  ["IN", "219 260 317 463 574 765 812 930"],
  ["IA", "319 515 563 641 712"],
  ["KS", "316 620 785 913"],
  ["KY", "270 364 502 606 859"],
  ["LA", "225 318 337 457 504 985"],
  ["ME", "207"],
  ["MD", "227 240 301 410 443 667"],
  ["MA", "339 351 413 508 617 774 781 857 978"],
  ["MI", "231 248 269 313 517 586 616 679 734 810 906 947 989"],
  ["MN", "218 320 507 612 651 763 924 952"],
  ["MS", "228 471 601 662 769"],
  ["MO", "235 314 417 557 573 636 660 816 975"],
  ["MT", "406"],
  ["NE", "308 402 531"],
  ["NV", "702 725 775"],
  ["NH", "603"],
  ["NJ", "201 551 609 640 732 848 856 862 908 973"],
  ["NM", "505 575"],
  ["NY", "212 315 329 332 347 363 465 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934"],
  ["NC", "252 336 472 704 743 828 910 919 980 984"],
  ["ND", "701"],
  ["OH", "216 220 234 283 326 330 380 419 440 513 567 614 740 937"],
  ["OK", "405 539 572 580 918"],
  ["OR", "458 503 541 971"],
  ["PA", "215 223 267 272 412 445 484 570 582 610 717 724 814 835 878"],
  ["RI", "401"],
  ["SC", "803 821 839 843 854 864"],
  ["SD", "605"],
  ["TN", "423 615 629 729 731 865 901 931"],
  ["TX", "210 214 254 281 325 346 361 409 430 432 469 512 621 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979"],
  ["UT", "385 435 801"],
  ["VT", "802"],
  ["VA", "276 434 540 571 686 703 757 804 826 948"],
  ["WA", "206 253 360 425 509 564"],
  ["WV", "304 681"],
  ["WI", "262 274 353 414 534 608 715 920"],
  ["WY", "307"],
  ["PR", "787 939"],
  ["VI", "340"],
  ["GU", "671"],
  ["MP", "670"],
  ["AS", "684"],
];
const SMS_AREA_CODE_STATE: Record<string, string> = {};
for (const [st, codes] of SMS_AREA_CODE_GROUPS) {
  for (const code of codes.split(" ")) SMS_AREA_CODE_STATE[code] = st;
}
// Non-geographic area codes: toll-free, personal communications (5XX), Canadian
// non-geographic (6XX), carrier / government (7XX) and premium (900). They say nothing
// about where the phone is, so they get the all-US window — as does any code not listed
// above (Canada, the Caribbean, unassigned).
const SMS_NON_GEOGRAPHIC = new Set(
  ("800 833 844 855 866 877 888 822 880 881 882 883 884 885 886 887 889 " +
    "500 521 522 523 524 525 526 527 528 529 532 533 544 566 577 588 600 622 633 700 710 900").split(" "),
);

// The 10 digits of a US-format number, or "".
function smsPhoneTen(phone?: string | null): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? ten : "";
}

// The state a phone number's area code belongs to, or "" (non-geographic / unlisted).
function smsAreaCodeState(phone?: string | null): string {
  const npa = smsPhoneTen(phone).slice(0, 3);
  if (!npa || SMS_NON_GEOGRAPHIC.has(npa) || !smsHas(SMS_AREA_CODE_STATE, npa)) return "";
  return SMS_AREA_CODE_STATE[npa];
}

function smsZoneUnion(a: string[], b: string[]): string[] {
  const out = a.slice();
  for (const z of b) if (!out.includes(z)) out.push(z);
  return out;
}

const SMS_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const smsHourFmt = new Map<string, Intl.DateTimeFormat>();

function smsWindowOpenIn(tz: string, at: Date): boolean {
  let fmt = smsHourFmt.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23" });
    smsHourFmt.set(tz, fmt);
  }
  const parts = fmt.formatToParts(at);
  // An AM/PM part would mean the runtime ignored the 24-hour cycle (9pm reads as "9").
  if (parts.some((p) => p.type === "dayPeriod")) return false;
  const weekday = parts.find((p) => p.type === "weekday")?.value || "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  if (!SMS_WEEKDAYS.includes(weekday) || !Number.isInteger(hour) || hour < 0 || hour > 23) return false;
  const start = weekday === "Sun" ? SMS_WINDOW_SUNDAY_START_HOUR : SMS_WINDOW_START_HOUR;
  return hour >= start && hour < SMS_WINDOW_END_HOUR;
}

// Is the window open in every zone of this BUSINESS's state? Used for the run summary;
// customer texts use smsWindowOpenFor(). Fails closed: if the local time can't be
// worked out, the window counts as shut.
function smsWindowOpen(state?: string | null, at: Date = new Date()): boolean {
  try {
    return smsZonesForState(state).every((tz) => smsWindowOpenIn(tz, at));
  } catch {
    return false;
  }
}

type SmsRecipient = { phone?: string | null; state?: string | null; zip?: string | null };
// by = which evidence placed the recipient: their own state, their ZIP, their phone's
// area code (intersected with the business's zones), the business alone, or nothing.
type SmsWindow = { zones: string[]; by: "state" | "zip" | "area_code" | "business" | "unknown" };

// Where the person receiving the text is, best evidence first. A text then needs the
// window open in EVERY zone listed (the intersection principle, as for a split state):
//   1. the customer's own state (all of its zones);
//   2. else the state of the customer's ZIP;
//   3. else the phone's area code — its state's zones AND the business's zones, since a
//      ported or moved number may not be where its area code says;
//   4. a non-geographic (toll-free…) or unlisted area code: the all-US window AND the
//      business's zones;
//   5. no usable phone: the business's zones (all-US when its state is unknown too).
// Pure and cheap; callers compute it once per customer and use it for every decision.
function smsRecipientWindow(r: SmsRecipient | null | undefined, bizState?: string | null): SmsWindow {
  const st = smsStateCode(r?.state);
  if (st) return { zones: SMS_STATE_ZONES[st], by: "state" };
  const zs = smsZipState(r?.zip);
  if (zs) return { zones: SMS_STATE_ZONES[zs], by: "zip" };
  if (smsPhoneTen(r?.phone)) {
    const biz = smsZonesForState(bizState);
    const ac = smsAreaCodeState(r?.phone);
    return ac
      ? { zones: smsZoneUnion(SMS_STATE_ZONES[ac], biz), by: "area_code" }
      : { zones: smsZoneUnion(SMS_ZONES_UNKNOWN, biz), by: "unknown" };
  }
  const bz = smsStateCode(bizState);
  return bz ? { zones: SMS_STATE_ZONES[bz], by: "business" } : { zones: SMS_ZONES_UNKNOWN, by: "unknown" };
}

// May a text go to this recipient right now? A missing or empty window counts as shut,
// and so does any failure to work out a local time.
function smsWindowOpenFor(win: SmsWindow | null | undefined, at: Date = new Date()): boolean {
  try {
    return !!win && Array.isArray(win.zones) && win.zones.length > 0 && win.zones.every((tz) => smsWindowOpenIn(tz, at));
  } catch {
    return false;
  }
}

// Known-answer check of the window maths in THIS runtime, reported in every run
// summary. If a runtime ever formatted dates differently the window would read as
// permanently shut (it fails closed) and quietly hold every text-eligible touch; this
// turns that into a visible "failed". 2026-06-15 is a Monday and 2026-06-14 a Sunday
// (Eastern = UTC-4); 2026-01-15 17:00Z is 9am Pacific but only 7am in Hawaii.
// Per recipient (NY business, Thursday 2026-01-15, Eastern = UTC-5): a California customer
// opens at 9am Pacific (17:00Z); a 415 number with no address needs Eastern AND Pacific,
// so it is shut at 8:30pm Eastern (01:30Z) although it is 5:30pm in San Francisco; a Texas
// customer waits for 9am in El Paso (16:00Z); a toll-free number gets the all-US window
// (Hawaii is at 7am at 17:00Z); an Arizona ZIP needs Phoenix AND Denver (open at 7:30pm
// in January, when both are UTC-7).
function smsWindowSelfCheck(): boolean {
  const ny = (iso: string) => smsWindowOpen("NY", new Date(iso));
  const to = (r: SmsRecipient, iso: string) => smsWindowOpenFor(smsRecipientWindow(r, "NY"), new Date(iso));
  const by = (r: SmsRecipient) => smsRecipientWindow(r, "NY").by;
  return !ny("2026-06-15T12:59:59Z") && ny("2026-06-15T13:00:00Z") && // Mon 08:59:59 / 09:00
    ny("2026-06-15T23:59:59Z") && !ny("2026-06-16T00:00:00Z") && // Mon 19:59:59 / 20:00
    !ny("2026-06-14T15:59:59Z") && ny("2026-06-14T16:00:00Z") && // Sun 11:59:59 / 12:00
    smsWindowOpen("CA", new Date("2026-01-15T17:00:00Z")) && !smsWindowOpen("", new Date("2026-01-15T17:00:00Z")) &&
    to({ state: "California" }, "2026-01-15T17:00:00Z") && !to({ state: "ca" }, "2026-01-15T16:59:59Z") &&
    to({ phone: "+14155550100" }, "2026-01-15T17:00:00Z") && !to({ phone: "+14155550100" }, "2026-01-16T01:30:00Z") &&
    !to({ state: "TX" }, "2026-01-15T15:59:59Z") && to({ state: "TX" }, "2026-01-15T16:00:00Z") &&
    !to({ phone: "(800) 555-0100" }, "2026-01-15T17:00:00Z") && to({ phone: "(800) 555-0100" }, "2026-01-15T19:00:00Z") &&
    to({ zip: "85004" }, "2026-01-16T02:30:00Z") && !to({ zip: "85004" }, "2026-01-16T03:00:00Z") &&
    by({ state: "N.Y.", zip: "94103", phone: "+14155550100" }) === "state" && by({ zip: "94103-1234" }) === "zip" &&
    by({ phone: "+14155550100" }) === "area_code" && by({ phone: "+18885550100" }) === "unknown" &&
    by({ phone: "" }) === "business";
}

// Per-business A2P routing (ISV model): customer texts go out ONLY through the
// sending business's own approved Twilio registration. There is no shared
// fallback: Clicktide's own campaign is registered as first-party (texts to
// business owners) and carriers suspend campaigns that carry another brand's
// customer messages. Populated once per run from a2p_registrations.
const msidByUser = new Map<string, string>();

// Clicktide's own Messaging Services may NEVER carry a customer text, even if a
// mislabeled business row holds one of their SIDs. The deny list is the known
// platform SID, the env override, and every SID on a reg_type='platform' row.
const platformMsids = new Set(
  ["MG4c1badf5712739590510f936bbd0bc1a", Deno.env.get("TWILIO_MESSAGING_SERVICE_SID") || ""].filter(Boolean),
);

// Can this customer get a MARKETING text (every campaign text) — their business has its
// own registration, they have marketing consent (and haven't opted out), and the
// number is usable? Plan limits and the send window are checked separately by the callers.
// Consent is sms_consent=true only: a check-in's pending double-opt-in request lives in
// sms_consent_requests and counts for nothing until the customer's YES flips sms_consent.
// The SMS send branch below tests the same fields, so the hold and the send agree.
function canText(customer: Customer): boolean {
  return msidByUser.has(String(customer.user_id || "")) && !!customer.sms_consent &&
    !customer.sms_unsubscribed_at && !!normalizePhone(customer.phone);
}

// Account/service texts (asking for a gift's mailing address) are also covered by the
// separate "account & service texts" box. STOP still ends both kinds.
function canTextService(customer: Customer): boolean {
  return msidByUser.has(String(customer.user_id || "")) && (!!customer.sms_consent || !!customer.sms_service_consent) &&
    !customer.sms_unsubscribed_at && !!normalizePhone(customer.phone);
}

// Opt-out language on a business's first text to a customer and again after a quiet month
// (CTIA); the owner's own copy may already carry it ("Stop by soon!" does not count).
function withOptOut(body: string) {
  return /\b(reply|text|send)\s+["'“]?stop\b/i.test(body) ? body : `${body.trim()} Reply STOP to opt out.`;
}

async function sendSms(campaign: Campaign, customer: Customer, body: string, win: SmsWindow | null) {
  const msid = msidByUser.get(String(customer.user_id || "")) || "";
  if (!msid || platformMsids.has(msid)) return { ok: false, detail: "sms_not_registered" };
  // Last line of defence: whatever the caller checked, no text leaves outside the
  // recipient's send window (a missing window counts as shut, never as open).
  if (!smsWindowOpenFor(win)) return { ok: false, detail: "sms_quiet_hours" };
  if (!twilioSid || !twilioToken) {
    return { ok: false, detail: "Twilio is not configured" };
  }
  const toPhone = normalizePhone(customer.phone);
  if (!toPhone) return { ok: false, detail: "Invalid phone" };

  const form = new URLSearchParams({ To: toPhone, Body: body.slice(0, 1500), MessagingServiceSid: msid });
  let response;
  try {
    response = await fetchT(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${twilioSid}:${twilioToken}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
  } catch (e) {
    // A Twilio timeout or network error ends THIS text (recorded, so the cooldown stops
    // an hourly re-send) instead of aborting the whole run. Twilio may still have taken
    // it, so the outcome is unknown ("ambiguous"): never refunded, never retried.
    const why = e instanceof Error && e.name === "AbortError" ? "timeout" : "network error";
    await rest("/rest/v1/sms_messages", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: customer.user_id, campaign_id: campaign.id, customer_id: customer.id,
        to_phone: toPhone, body: body.slice(0, 1500), status: "failed", provider: "twilio",
        error: `Twilio request failed (${why}); delivery unknown`,
      }),
    }).catch(() => {});
    return { ok: false, ambiguous: true, detail: `Twilio request failed: ${why}; delivery unknown` };
  }
  const data = await response.json().catch(() => ({}));

  await rest("/rest/v1/sms_messages", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: customer.user_id,
      campaign_id: campaign.id,
      customer_id: customer.id,
      to_phone: toPhone,
      body: body.slice(0, 1500),
      status: response.ok ? "sent" : "failed",
      provider: "twilio",
      provider_message_id: data.sid || null,
      error: response.ok ? null : (data.message || "Twilio SMS failed"),
      sent_at: response.ok ? new Date().toISOString() : null,
    }),
  }).catch(() => {});

  return { ok: response.ok, detail: response.ok ? String(data.sid || "") : String(data.message || "Twilio failed") };
}

function postcardFront(businessName: string, brandColor = "#0B62D6", logoUrl = "", design = "bold") {
  const logo = logoUrl ? `<img src="${escapeHtml(logoUrl)}" style="max-height:0.9in;max-width:2.4in;display:block;margin:0 auto 14px"/>` : "";
  const name = `<div style="font-size:32px;font-weight:bold;letter-spacing:1px">${escapeHtml(businessName)}</div>`;
  const tag = `<div style="font-size:15px;margin-top:10px;opacity:.85">A little something, just for you</div>`;
  if (design === "minimal") {
    return `<div style="width:6.25in;height:4.25in;background:#fff;display:flex;align-items:center;justify-content:center;font-family:Helvetica,Arial,sans-serif"><div style="text-align:center;color:${brandColor};border:3px solid ${brandColor};padding:0.4in 0.55in">${logo}${name}${tag}</div></div>`;
  }
  if (design === "banner") {
    return `<div style="width:6.25in;height:4.25in;background:#fff;font-family:Helvetica,Arial,sans-serif"><div style="background:${brandColor};height:1.5in;display:flex;align-items:center;justify-content:center;color:#fff">${name}</div><div style="height:2.75in;display:flex;align-items:center;justify-content:center;text-align:center;color:#333"><div>${logo}<div style="font-size:16px">A little something, just for you</div></div></div></div>`;
  }
  if (design === "framed") {
    return `<div style="width:6.25in;height:4.25in;background:${brandColor};padding:0.3in;box-sizing:border-box;font-family:Helvetica,Arial,sans-serif"><div style="background:#fff;height:100%;display:flex;align-items:center;justify-content:center;text-align:center;color:${brandColor}"><div>${logo}${name}${tag}</div></div></div>`;
  }
  return `<div style="width:6.25in;height:4.25in;background:${brandColor};display:flex;align-items:center;justify-content:center;font-family:Helvetica,Arial,sans-serif"><div style="text-align:center;color:#fff">${logo}${name}${tag}</div></div>`;
}

function postcardBack(message: string, businessName: string, whiteLabel: boolean) {
  return `<div style="width:6.25in;height:4.25in;padding:0.35in;font-family:Helvetica,Arial,sans-serif;box-sizing:border-box">
    <div style="width:2.9in;font-size:12px;line-height:1.6;color:#111">${escapeHtml(message).replaceAll("\n", "<br>")}
    <div style="margin-top:14px;font-weight:bold">— ${escapeHtml(businessName)}</div>
    ${whiteLabel ? "" : '<div style="font-size:7px;color:#999;margin-top:16px">Sent via Clicktide</div>'}</div></div>`;
}

// `idemKey` is Lob's Idempotency-Key: a repeat with the same key within 24h returns the
// postcard already created instead of mailing another. `ambiguous` = Lob may have made it.
async function sendPostcard(customer: Customer, businessName: string, message: string, whiteLabel: boolean, brandColor = "#0B62D6", logoUrl = "", design = "bold", idemKey = "") {
  if (!lobKey) return { ok: false, detail: "LOB_API_KEY is not configured" };
  const firstName = (customer.name || "there").trim().split(/\s+/)[0];
  const form = new URLSearchParams({
    description: `Clicktide postcard for ${businessName}`,
    size: "4x6",
    use_type: "marketing",
    "to[name]": (customer.name || "Customer").slice(0, 40),
    "to[address_line1]": String(customer.address || ""),
    "to[address_city]": String(customer.city || ""),
    "to[address_state]": String(customer.state || ""),
    "to[address_zip]": String(customer.zip || ""),
    front: lobFrontTpl || postcardFront(businessName, brandColor, logoUrl, design),
    back: lobBackTpl || postcardBack(message, businessName, whiteLabel),
  });
  if (lobFrontTpl || lobBackTpl) {
    form.set("merge_variables[message]", message);
    form.set("merge_variables[business_name]", businessName);
    form.set("merge_variables[first_name]", firstName);
  }
  let r;
  try {
    r = await fetchT("https://api.lob.com/v1/postcards", {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(lobKey + ":"),
        "Content-Type": "application/x-www-form-urlencoded",
        ...(idemKey ? { "Idempotency-Key": idemKey } : {}),
      },
      body: form,
    }, 20000);
  } catch (e) {
    const why = e instanceof Error && e.name === "AbortError" ? "timeout" : "network error";
    return { ok: false, ambiguous: true, detail: `Lob request failed: ${why}; outcome unknown` };
  }
  const d = await r.json().catch(() => ({}));
  if (r.ok) return { ok: true, ambiguous: false, detail: String(d.id || "") };
  return { ok: false, ambiguous: r.status >= 500, detail: String(d?.error?.message || `Lob request failed (${r.status})`) };
}

// Today's text attempt for this pair from the message log: "" = none, else its status
// ("sent", "failed", …); null = the log couldn't be read.
async function smsAttemptToday(campaign: Campaign, customer: Customer): Promise<string | null> {
  try {
    const rows = await rest(
      `/rest/v1/sms_messages?user_id=eq.${encodeURIComponent(String(campaign.user_id))}&campaign_id=eq.${campaign.id}&customer_id=eq.${customer.id}&created_at=gte.${encodeURIComponent(utcDayStart())}&select=status&order=created_at.desc&limit=1`,
    );
    return Array.isArray(rows) && rows[0] ? String(rows[0].status || "failed") : "";
  } catch {
    return null;
  }
}

// One retry: a row lost after the provider accepted the touch would drop it from the
// next run's cooldown map and the customer would get it again.
async function recordSend(campaign: Campaign, customer: Customer, channel: string, status: string, detail: string) {
  const write = () => rest("/rest/v1/campaign_sends", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: campaign.user_id,
      campaign_id: campaign.id,
      customer_id: customer.id,
      channel,
      status,
      detail: detail.slice(0, 500),
    }),
  });
  try {
    await write();
  } catch {
    await write().catch((e) => {
      globalThis.console?.error(`campaign_sends write failed (${campaign.id}:${customer.id}:${channel}): ${e instanceof Error ? e.message : e}`);
    });
  }
}

async function queuePhysicalGiftAlert(campaign: Campaign, customer: Customer, hasAddress: boolean, asked = true) {
  const addressNote = hasAddress
    ? "Their mailing address is on file — review and send from the dashboard."
    : asked
    ? "No mailing address yet — Clicktide has asked them for it directly; it will appear on their profile once they reply."
    : "No mailing address on file, and Clicktide couldn't reach them to ask for one. Add their address on their profile to send the gift.";
  await rest("/rest/v1/alerts", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: campaign.user_id,
      customer_id: customer.id,
      type: "physical_gift_queued",
      message: plainText(`Campaign "${campaign.name || campaign.trigger}" matched ${customer.name || "a customer"} for a physical gift (${campaign.gift_name || "gift"}). ${addressNote}`),
      resolved: false,
    }),
  }).catch(() => {});
}

async function queueUnconfirmedGiftAlert(campaign: Campaign, customer: Customer) {
  await rest("/rest/v1/alerts", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: campaign.user_id,
      customer_id: customer.id,
      type: "gift_unconfirmed",
      message: plainText(`Campaign "${campaign.name || campaign.trigger}" tried to send ${customer.name || "a customer"} a ${campaign.gift_name || "gift"} automatically, but the order couldn't be confirmed. Check Shipments and your wallet before sending it again.`),
      resolved: false,
    }),
  }).catch(() => {});
}

// Auto-send a physical gift through printify-fulfill-gift (internal call).
// "sent" = order placed; "failed" = refused, fall back to review; "unconfirmed" = no
// clear answer (timeout, 5xx), so the order may exist and must not be re-sent blindly.
// The ONE gift_catalog row this campaign's gift is: the campaign's own gift_catalog_id, else
// its Printify product (+ the exact variant when that pair is listed). Several rows can share
// a product, so the pick is deterministic (active first, then lowest id), and that row's id
// goes to the fulfiller, so the provider chosen here and the row it prices and ships agree.
// null = no such row; throws when the catalog can't be read.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function giftCatalogRow(campaign: Campaign): Promise<{ id: string; gelato_uid?: string | null; customcat_sku?: string | null } | null> {
  const pick = async (filter: string) => {
    const rows = await rest(`/rest/v1/gift_catalog?${filter}&select=id,gelato_uid,customcat_sku&order=is_active.desc,id.asc&limit=1`);
    return Array.isArray(rows) && rows[0]?.id ? rows[0] : null;
  };
  const catalogId = String(campaign.gift_catalog_id || "");
  if (UUID_RE.test(catalogId)) return await pick(`id=eq.${catalogId}`);
  const product = String(campaign.printify_product_id || "");
  if (!product) return null;
  const variant = Number(campaign.printify_variant_id || 0);
  if (Number.isSafeInteger(variant) && variant > 0) {
    const exact = await pick(`printify_product_id=eq.${encodeURIComponent(product)}&printify_variant_id=eq.${variant}`);
    if (exact) return exact;
  }
  return await pick(`printify_product_id=eq.${encodeURIComponent(product)}`);
}

async function autoSendGift(campaign: Campaign, customer: Customer, internalKey: string) {
  // Route to the provider of this gift's catalog row (Gelato / CustomCat), else Printify.
  // No row, or the catalog unreadable: nothing is ordered and the gift goes to owner review.
  let row;
  try {
    row = await giftCatalogRow(campaign);
  } catch (_) {
    await recordSend(campaign, customer, "gift", "failed", "auto-send: gift catalog unavailable; nothing ordered");
    return "failed";
  }
  if (!row) {
    await recordSend(campaign, customer, "gift", "failed", "auto-send: gift not found in the catalog; nothing ordered");
    return "failed";
  }
  const endpoint = row.gelato_uid ? "gelato-fulfill-gift" : row.customcat_sku ? "customcat-fulfill-gift" : "printify-fulfill-gift";
  let r;
  try {
    r = await fetchT(`${supabaseUrl}/functions/v1/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-clicktide-cron-key": internalKey },
      body: JSON.stringify({
        user_id: campaign.user_id,
        customer_id: customer.id,
        customer_name: customer.name || "Customer",
        customer_email: customer.email || "",
        gift_name: campaign.gift_name || "Gift",
        gift_cost: Number(campaign.gift_cost) || 0,
        campaign_id: String(campaign.id),
        gift_catalog_id: String(row.id),
        printify_product_id: campaign.printify_product_id,
        printify_variant_id: campaign.printify_variant_id,
        address: { address1: customer.address, city: customer.city, region: customer.state, zip: customer.zip, country: "US" },
        idempotency_key: sendKey(campaign, customer, "gift"),
      }),
    }, GIFT_CALL_MS);
  } catch (e) {
    const why = e instanceof Error && e.name === "AbortError" ? "timed out" : "network error";
    await recordSend(campaign, customer, "gift", "unconfirmed", `auto-send ${why}; order status unknown`);
    return "unconfirmed";
  }
  const d = await r.json().catch(() => ({}));
  if (r.ok) {
    await recordSend(campaign, customer, "gift", "sent", `auto-sent: ${String(d.printify_order_id || d.gelato_order_id || d.customcat_order_id || "")}`);
    return "sent";
  }
  // A 5xx is "may have ordered" unless the fulfiller says it never started: the
  // machine-readable code:'not_started' first; the "nothing was charged" wording is only a
  // fallback for a fulfiller build that doesn't send the code yet.
  // 409 = an order for this gift is already placed or in flight.
  const notStarted = d?.code === "not_started" ||
    (d?.code === undefined && /nothing was charged/i.test(String(d?.error || "")));
  if (r.status === 409 || (r.status >= 500 && !notStarted)) {
    await recordSend(campaign, customer, "gift", "unconfirmed", `auto-send ${r.status}: ${String(d?.error || "server error")}`);
    return "unconfirmed";
  }
  await recordSend(campaign, customer, "gift", "failed", `auto-send: ${String(d?.error || "failed")}`);
  return "failed";
}

// Why an address request can't go to this customer right now ("" = it can): they were
// asked within the last ADDRESS_ASK_COOLDOWN_DAYS, or there is no link token on file.
function addressAskBlocked(customer: Customer): string {
  const lastAsk = customer.address_requested_at ? Date.parse(customer.address_requested_at) : 0;
  if (lastAsk && Date.now() - lastAsk < ADDRESS_ASK_COOLDOWN_DAYS * 86400000) return "recently_asked";
  if (!customer.address_request_token) return "no_token";
  return "";
}

// An address request is due and would go out as a text, but the customer's send
// window is closed. Callers hold the whole touch until the window opens. Pure (no
// I/O), so a dry run reports exactly the decision a live run makes. winOf is the
// business's per-customer window cache (computed once per customer).
type WinOf = { (c: Customer): SmsWindow };
function addressAskHeld(customer: Customer, winOf: WinOf): boolean {
  return !addressAskBlocked(customer) && canTextService(customer) && !smsWindowOpenFor(winOf(customer));
}

// Ask the customer directly for their mailing address (tokenized link), at most
// once every ADDRESS_ASK_COOLDOWN_DAYS. Texts first (with marketing or service
// consent), else a branded email with the business logo + an explicit
// no-payment-details note.
async function maybeRequestAddress(campaign: Campaign, customer: Customer, businessName: string, whiteLabel: boolean, logoUrl: string, brandColor: string, lastVisitText: string, winOf: WinOf, optOut = true) {
  const blocked = addressAskBlocked(customer);
  if (blocked) return { asked: false, reason: blocked };
  const userId = String(customer.user_id || campaign.user_id || "");
  const token = String(customer.address_request_token || "");
  const link = `${ADDRESS_FORM_URL}?t=${token}`;
  const first = (customer.name || "there").trim().split(/\s+/)[0];
  let sent = false;
  let channel = "";

  if (canTextService(customer)) {
    // Quiet hours: hold the ask — it goes out as a text on the first run inside the
    // customer's window — rather than downgrade it to an email now.
    const win = winOf(customer);
    if (!smsWindowOpenFor(win)) return { asked: false, reason: "sms_quiet_hours" };
    const smsBody = `Hey ${first}! ${businessName} has a little something they want to MAIL you \u{1F381} Tell us where to send it: ${link}`;
    const r = await sendSms(campaign, customer, optOut ? withOptOut(smsBody) : smsBody, win);
    if (r.ok) { sent = true; channel = "sms"; }
  }
  // A customer who unsubscribed from email gets no address-request email either (the ask
  // is on behalf of a marketing postcard/gift, so the opt-out covers it).
  if (!sent && customer.email && !customer.email_unsubscribed_at && postalFor(userId, businessName)) {
    if (emailBackoff()) return { asked: false, reason: "email_deferred" };
    if ((await emailSuppressed(userId, customer.email)) === false) {
      const visitLine = lastVisitText
        ? `<p style="margin:0 0 18px;font-size:12px;color:#9CA3AF">\u{1F4CD} Your last visit: ${escapeHtml(lastVisitText)}</p>`
        : "";
      const inner = `<p style="margin:0 0 14px">Hi ${escapeHtml(first)},</p>
      <p style="margin:0 0 10px">${escapeHtml(businessName)} has a little something they want to <b>mail you</b> \u{1F381} — a real piece of mail, the good kind. We just need to know where to send it.</p>
      ${visitLine}
      <div style="text-align:center;margin:22px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:${escapeHtml(brandColor)};color:#FFFFFF;font-weight:bold;font-size:15px;text-decoration:none;padding:13px 32px;border-radius:10px">Tell us where to send it →</a></div>
      <p style="margin:0;font-size:12px;color:#6B7280;line-height:1.7">Takes 20 seconds and only asks for a mailing address — never payment details. The secure form lives at goclicktide.com, the service ${escapeHtml(businessName)} uses to send customer gifts.</p>`;
      const html = brandedShell(businessName, inner, whiteLabel, logoUrl, brandColor, await unsubUrlFor(userId, customer.email), postalFor(userId, businessName));
      const r = await sendEmail(customer.email, `${businessName} wants to mail you something \u{1F381}`, "", businessName, customer.name || "there", html, whiteLabel, "", "#0B62D6", "", "", userId, sendKey(campaign, customer, "address_request"));
      if (r.ok) { sent = true; channel = "email"; }
      else if (r.retry) return { asked: false, reason: "email_deferred" };
    }
  }
  if (!sent) return { asked: false, reason: "no_reachable_channel" };

  await rest(`/rest/v1/customers?id=eq.${customer.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ address_requested_at: new Date().toISOString() }),
  }).catch(() => {});
  customer.address_requested_at = new Date().toISOString();
  // The link itself is a bearer token for the customer's address form: keep it out of the log.
  await recordSend(campaign, customer, "address_request", "sent", `${channel}: address form link sent`);
  return { asked: true, reason: channel };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey) return json({ error: "Server secrets are not configured" }, 500);

  const providedKey = req.headers.get("x-clicktide-cron-key") || "";
  const internalKey = await expectedCronKey();
  const validKey = safeEqual(providedKey, internalKey);
  if (!validKey && !(await isStaffAdmin(req))) {
    return json({ error: "Not authorized to run campaigns" }, 401);
  }

  const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";
  // Stop cleanly before the ~150s edge-function wall-clock limit so the run never 504s.
  // Anything not reached this hour is picked up first by the next hourly run.
  const RUN_DEADLINE = Date.now() + 110000;

  const summary = {
    ok: true,
    dry_run: dryRun,
    run_id: 0,
    timed_out: false,
    resume_from: "", // set when timed out: the business the next run starts with
    businesses: 0,
    campaigns: 0,
    evaluated: 0,
    sent: 0,
    queued_physical: 0,
    gifts_auto_sent: 0,
    gifts_unconfirmed: 0,
    unconfirmed: 0, // postcard or text whose provider gave no clear answer: recorded, not refunded, not retried
    address_requests: 0,
    failed: 0,
    deferred: 0, // email hit a Resend 429/5xx: recorded as 'deferred', retried next hour (for up to a day)
    wallet_refund_failed: 0,
    business_errors: 0,
    last_error: "",
    pos_check_errors: 0,
    // Businesses with active campaigns, by whether the window is open in the BUSINESS's
    // own zones right now (state_unknown = no usable state on file). Customer texts follow
    // each recipient's window: recipients = customers a text decision was made for, by
    // what placed them (resolved once per customer per run); held_by = touches held for
    // quiet hours, by the same source. self_check = the window maths verified against
    // known answers in this runtime.
    sms_window: {
      open: 0, closed: 0, state_unknown: 0, self_check: smsWindowSelfCheck() ? "ok" : "failed",
      recipients: { state: 0, zip: 0, area_code: 0, business: 0, unknown: 0 },
      held_by: { state: 0, zip: 0, area_code: 0, business: 0, unknown: 0 },
    },
    // How many businesses can text (active registration linked to their account);
    // the error flag means the registry read failed and the last snapshot was kept.
    sms_registered_businesses: 0,
    sms_unlinked_registrations: 0,
    sms_registry_error: false,
    skipped: {
      offer_not_verified: 0, // code offer held: the owner hasn't passed the counter/website test yet
      offer_code_unavailable: 0, // code offer held: no code could be issued (website codes ran out / RPC down)
      billing_inactive: 0,
      cooldown: 0,
      no_match: 0,
      unsupported_trigger: 0,
      unhappy_customer: 0,
      missing_contact: 0,
      email_unsubscribed: 0, // the customer row's flag, or this business's suppression list
      email_suppression_unavailable: 0,
      email_no_postal_address: 0, // held: no business address and no CLICKTIDE_POSTAL_ADDRESS
      email_backoff: 0, // touch held: Resend is throttling this run
      no_sms_consent: 0,
      sms_not_in_plan: 0,
      sms_not_registered: 0,
      sms_quiet_hours: 0, // touch held: a text is due but the send window is closed
      sms_budget: 0,
      postcard_no_address: 0,
      postcard_wallet: 0,
      wallet_unavailable: 0, // the ledger couldn't be reached: nothing paid, nothing sent
      duplicate_send: 0, // the ledger already holds today's charge for this touch
      send_cap: 0,
      warmup: 0,
      pos_sync_stale: 0,
      winback_max: 0,
      winback_spacing: 0,
      state_unavailable: 0,
    },
  };

  // One live run at a time: overlapping runs would each build the cooldown map before
  // the other's sends land, and touch the same customers twice. Dry runs send nothing,
  // so they neither wait for nor block a live run.
  let holder = "";
  let runId = 0;
  if (!dryRun) {
    const me = crypto.randomUUID();
    try {
      if (!(await leaseAcquire(me))) {
        return json({ ...summary, lease_held: true, message: "Another campaign run is in progress; this one did nothing." });
      }
    } catch (e) {
      globalThis.console?.error("campaign-runner lease error:", e);
      return json({ error: "The campaign-run lock is unavailable, so nothing was sent." }, 500);
    }
    holder = me;
    runId = await runStart();
    summary.run_id = runId;
  }

  let runOk = false;
  let runError = "";
  suppressionCache.clear(); // opt-outs since the last run must count
  try {
    const campaigns = await restAll("/rest/v1/campaigns?status=eq.active&select=*&order=id.asc") as Campaign[];
    if (!campaigns.length) {
      runOk = true;
      return json({ ...summary, message: "No active campaigns." });
    }
    summary.campaigns = campaigns.length;

    const campaignsByUser = new Map<string, Campaign[]>();
    for (const c of campaigns) {
      if (!c.user_id) continue;
      const list = campaignsByUser.get(c.user_id);
      if (list) list.push(c);
      else campaignsByUser.set(c.user_id, [c]);
    }
    const userIds = [...campaignsByUser.keys()].sort();
    // Start where an over-time run stopped, so the same tail of businesses never starves.
    const resumeFrom = await resumePoint();
    const startAt = resumeFrom ? userIds.findIndex((u) => u >= resumeFrom) : -1;
    const order = startAt > 0 ? [...userIds.slice(startAt), ...userIds.slice(0, startAt)] : userIds;

    // In chunks: a single user_id=in.(...) list of every business outgrows the URL limit.
    const bizByUser = new Map<string, Business>();
    for (let i = 0; i < userIds.length; i += 100) {
      const rows = await restAll(
        `/rest/v1/clicktide?user_id=in.(${userIds.slice(i, i + 100).join(",")})&select=id,user_id,email,business_name,churn_days,stripe_subscription_status,plan,logo_url,state,gift_auto_send,winback_include_estimated,address,city,zip,offers_store_verified_at,offers_web_verified_at&order=id.asc`,
      ) as Business[];
      for (const b of rows) if (b.user_id && !bizByUser.has(b.user_id)) bizByUser.set(b.user_id, b);
    }
    summary.businesses = userIds.length;
    const freshPostal = new Map<string, string>();
    for (const b of bizByUser.values()) {
      if (smsWindowOpen(b.state)) summary.sms_window.open++;
      else summary.sms_window.closed++;
      if (smsZonesForState(b.state) === SMS_ZONES_UNKNOWN) summary.sms_window.state_unknown++;
      const line = postalLine(b, b.business_name || "your favorite local business");
      if (line) freshPostal.set(b.user_id, line);
    }
    postalByUser.clear();
    for (const [k, v] of freshPostal) postalByUser.set(k, v);

    // Per-business A2P routing: load approved registrations once per run.
    // A registration belongs to a business only through user_id, which staff set
    // at activation. Never match on email: owners can edit their own email, so an
    // email match would let one account send through another business's number.
    try {
      // The platform rows' SIDs join the deny list (any status — Clicktide's own
      // services never carry customer texts, active or not). Best-effort: the
      // static deny list above covers the known service even if this read fails.
      try {
        const platRows = await rest(
          "/rest/v1/a2p_registrations?reg_type=eq.platform&messaging_service_sid=not.is.null&select=messaging_service_sid",
        ) as Array<{ messaging_service_sid?: string }>;
        for (const p of (Array.isArray(platRows) ? platRows : [])) {
          if (p.messaging_service_sid) platformMsids.add(String(p.messaging_service_sid));
        }
      } catch { /* static deny list still applies */ }
      // An active business row with no user_id is a staff mistake: it looks live
      // in the table while every text is skipped. Make it loud.
      try {
        const unlinkedRows = await rest(
          "/rest/v1/a2p_registrations?sms_status=eq.active&reg_type=neq.platform&user_id=is.null&select=id&limit=100",
        );
        const unlinked = Array.isArray(unlinkedRows) ? unlinkedRows.length : 0;
        if (unlinked) {
          summary.sms_unlinked_registrations = unlinked;
          globalThis.console?.warn(`${unlinked} active a2p registration(s) have no user_id — their businesses cannot text until it is set`);
        }
      } catch { /* informational only */ }
      const regs = await restAll(
        "/rest/v1/a2p_registrations?sms_status=eq.active&messaging_service_sid=not.is.null&reg_type=neq.platform&user_id=not.is.null&select=user_id,messaging_service_sid&order=id.asc",
      ) as Array<{ user_id?: string; messaging_service_sid?: string }>;
      const fresh = new Map<string, string>();
      for (const reg of (Array.isArray(regs) ? regs : [])) {
        const sid = String(reg.messaging_service_sid || "");
        if (!reg.user_id || !sid) continue;
        if (platformMsids.has(sid)) { globalThis.console?.error(`a2p row for ${reg.user_id} holds a platform service SID — skipped`); continue; }
        fresh.set(String(reg.user_id), sid);
      }
      // Swap contents with no await in between, so a concurrent run never sees a
      // half-empty map; a failed read keeps the previous run's snapshot instead.
      msidByUser.clear();
      for (const [k, v] of fresh) msidByUser.set(k, v);
      summary.sms_registered_businesses = fresh.size;
    } catch {
      // Lookup failed: keep the last good snapshot (empty on a cold start, which
      // fails closed to sms_not_registered) and say so in the summary.
      summary.sms_registry_error = true;
      summary.sms_registered_businesses = msidByUser.size;
    }

    for (const userId of order) {
      if (Date.now() > RUN_DEADLINE) { summary.timed_out = true; summary.resume_from = userId; break; }
      let outOfTime = false;
      try {
        const biz = bizByUser.get(userId);
        const status = String(biz?.stripe_subscription_status || "").toLowerCase();
        const userCampaigns = campaignsByUser.get(userId) || [];

        if (!["active", "trialing"].includes(status)) {
          summary.skipped.billing_inactive += userCampaigns.length;
          continue;
        }

        // Warm-up: for 48h after a business's FIRST register connection, no campaign
        // fires at all — the import settles, the owner looks around, nothing blasts.
        let posStale = false;
        try {
          const conns = await rest(
            `/rest/v1/platform_connections?user_id=eq.${encodeURIComponent(userId)}&select=connected_at,last_synced_at,is_active,platform&order=connected_at.asc&limit=100`,
          ) as Array<{ connected_at?: string; last_synced_at?: string | null; is_active?: boolean; platform?: string }>;
          const conn = Array.isArray(conns) ? conns : [];
          const connAt = conn[0]?.connected_at ? Date.parse(conn[0].connected_at) : 0;
          if (connAt && Date.now() - connAt < 48 * 3600000) {
            summary.skipped.warmup += userCampaigns.length;
            continue;
          }
          // Frozen = a synced platform's connection that has imported visits before and then
          // stopped. One that never synced fed no visit data, so there is nothing to freeze.
          posStale = conn.some((c) => !!c.is_active && SYNCED_PLATFORMS.includes(String(c.platform || "").toLowerCase()) &&
            !!c.last_synced_at && Date.now() - (Date.parse(String(c.last_synced_at)) || 0) > POS_STALE_HOURS * 3600000);
        } catch (_) {
          summary.pos_check_errors++; // manual mode keeps working; the warm-up can't be checked this hour
        }

        const customers = await restAll(
          `/rest/v1/customers?user_id=eq.${encodeURIComponent(userId)}&select=*&order=id.asc`,
        ) as Customer[];
        if (!customers.length) continue;

        // Shared retention engine: refresh this business's statuses, then read them
        // (paged, so customers past the 1,000th keep their status).
        const rhythm = new Map<number, Rhythm>();
        try {
          await rest("/rest/v1/rpc/clicktide_refresh_rhythm", { method: "POST", body: JSON.stringify({ p_user: userId }) });
          const rows = await restAll(
            `/rest/v1/customer_rhythm?user_id=eq.${encodeURIComponent(userId)}&select=customer_id,status,status_since,episode_started_at,confidence,drift_after_days&order=customer_id.asc`,
          ) as Array<Rhythm & { customer_id: number }>;
          for (const r of rows || []) rhythm.set(Number(r.customer_id), r);
        } catch (e) {
          rhythm.clear(); // a partial read must not mix the two rules within one business
          globalThis.console?.error("retention engine unavailable; using previous rule", e);
        }

        let emailTpl: EmailTemplate | null = null;
        try {
          const tplRows = await rest(
            `/rest/v1/email_templates?user_id=eq.${encodeURIComponent(userId)}&name=eq.Default&limit=1`,
          );
          if (Array.isArray(tplRows) && tplRows[0]) emailTpl = tplRows[0] as EmailTemplate;
        } catch (_) { /* default wrapper */ }

        // No cooldown map means no protection from re-sends: skip the business this hour.
        const state = await campaignState(userId).catch((e) => {
          summary.last_error = `${userId}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
          return null;
        });
        if (!state) {
          summary.skipped.state_unavailable += userCampaigns.length;
          summary.business_errors++;
          continue;
        }
        const lastSend = new Map<string, number>();
        for (const [k, v] of Object.entries(state.last || {})) lastSend.set(k, Number(v));
        // Win-back touches each customer has had since their last visit, and the newest one.
        const wbCount = new Map<number, number>();
        const wbLast = new Map<number, number>();
        for (const t of state.touches || []) {
          if (triggerReason(state.triggers?.[String(t[1])] ?? "") !== "inactive") continue;
          const id = Number(t[0]);
          wbCount.set(id, (wbCount.get(id) || 0) + (Number(t[2]) || 0));
          wbLast.set(id, Math.max(wbLast.get(id) || 0, Number(t[3]) || 0));
        }
        const textedRecently = new Set((state.texted_recently || []).map((x) => Number(x)));
        let smsUsed = Number(state.sms_used) || 0;

        let bizSends = 0;
        const churnDays = biz?.churn_days || 60;
        const businessName = biz?.business_name || "your favorite local business";
        const logoUrl = String(biz?.logo_url || "");
        const brandColor = String(emailTpl?.brand?.color || "#0B62D6");
        const bizState = String(biz?.state || "");
        const giftAutoSend = !!biz?.gift_auto_send;
        const plan = String(biz?.plan || "").toLowerCase();
        const smsLimit = PLAN_SMS_LIMITS[plan] ?? 0;
        const whiteLabel = plan === "scale";
        const postal = postalFor(userId, businessName);
        // Each customer's send window, resolved ONCE (customer state > ZIP > area code ∩
        // business > business) and reused by every text decision for them this run: the
        // whole-touch hold, the SMS branch, sendSms, addressAskHeld and maybeRequestAddress.
        const smsWins = new Map<number, SmsWindow>();
        const winOf: WinOf = (c) => {
          let w = smsWins.get(Number(c.id));
          if (!w) {
            w = smsRecipientWindow(c, bizState);
            smsWins.set(Number(c.id), w);
            summary.sms_window.recipients[w.by]++;
          }
          return w;
        };
        const heldForQuietHours = (c: Customer) => {
          summary.skipped.sms_quiet_hours++;
          summary.sms_window.held_by[winOf(c).by]++;
        };

        for (const campaign of userCampaigns) {
          if (Date.now() > RUN_DEADLINE) { outOfTime = true; break; }
          for (const customer of customers) {
            if (Date.now() > RUN_DEADLINE) { outOfTime = true; break; }
            if (bizSends >= MAX_SENDS_PER_BUSINESS) {
              summary.skipped.send_cap++;
              continue;
            }
            summary.evaluated++;

            const rh = rhythm.get(Number(customer.id));
            const { match, reason } = matchesTrigger(campaign.trigger || "", customer, churnDays, campaign.created_at, rh, !!biz?.winback_include_estimated);
            if (reason === "unsupported") {
              summary.skipped.unsupported_trigger++;
              continue;
            }
            if (!match) {
              summary.skipped.no_match++;
              continue;
            }
            if (posStale && (reason === "inactive" || reason === "second_visit")) {
              summary.skipped.pos_sync_stale++;
              continue;
            }

            const sat = customer.satisfaction_score || 0;
            if (sat > 0 && sat <= 2 && campaign.campaign_type !== "message_only") {
              summary.skipped.unhappy_customer++;
              continue;
            }

            if ((campaign.min_spend || 0) > 0 && (customer.total_spent || 0) < (campaign.min_spend || 0)) {
              summary.skipped.no_match++;
              continue;
            }

            const cooldownDays = campaign.cooldown_days || 30;
            const key = `${campaign.id}:${customer.id}`;
            const last = lastSend.get(key);
            if (last && Date.now() - last < cooldownDays * 86400000) {
              summary.skipped.cooldown++;
              continue;
            }
            // One touch per drift episode: if this campaign already reached them since
            // they started drifting, don't send it again until they come back and drift anew.
            if (reason === "inactive" && rh && last && last >= Date.parse(rh.episode_started_at || rh.status_since)) {
              summary.skipped.cooldown++;
              continue;
            }

            const winback = reason === "inactive";
            if (winback) {
              if ((wbCount.get(customer.id) || 0) >= WINBACK_MAX_TOUCHES) {
                summary.skipped.winback_max++;
                continue;
              }
              const lastWb = wbLast.get(customer.id) || 0;
              if (lastWb && Date.now() - lastWb < WINBACK_MIN_GAP_DAYS * 86400000) {
                summary.skipped.winback_spacing++;
                continue;
              }
            }
            const touched = () => {
              lastSend.set(key, Date.now());
              if (!winback) return;
              wbCount.set(customer.id, (wbCount.get(customer.id) || 0) + 1);
              wbLast.set(customer.id, Date.now());
            };

            const hasAddress = !!(customer.address && customer.city && customer.state && customer.zip);
            const lastVisitText = fmtLastVisit(customer.last_visit_at || customer.last_order_at, bizState);
            const optOut = !textedRecently.has(customer.id);

            if (campaign.campaign_type === "physical_gift") {
              // Quiet hours: no address yet, and the request for it would go out as a text
              // while the send window is closed — hold the whole gift touch. Queuing the
              // owner alert now would start this campaign's cooldown and the customer
              // would never be asked.
              if (!hasAddress && addressAskHeld(customer, winOf)) {
                heldForQuietHours(customer);
                continue;
              }
              // The gift is named by its catalog row, or (older campaigns) by Printify product + variant.
              const giftNamed = UUID_RE.test(String(campaign.gift_catalog_id || "")) || (!!campaign.printify_product_id && !!campaign.printify_variant_id);
              const canAuto = giftAutoSend && hasAddress && giftNamed && (Number(campaign.gift_cost) || 0) > 0;
              if (!dryRun) {
                if (canAuto) {
                  // Not enough time left to wait out a slow order: leave it for the next run.
                  if (RUN_DEADLINE - Date.now() < GIFT_CALL_MS + 5000) { outOfTime = true; break; }
                  const outcome = await autoSendGift(campaign, customer, internalKey);
                  if (outcome === "sent") {
                    touched();
                    summary.gifts_auto_sent++;
                    summary.sent++;
                    bizSends++;
                    continue;
                  }
                  if (outcome === "unconfirmed") {
                    await queueUnconfirmedGiftAlert(campaign, customer);
                    touched();
                    summary.gifts_unconfirmed++;
                    bizSends++;
                    continue;
                  }
                }
                let asked = true;
                if (!hasAddress) {
                  const ask = await maybeRequestAddress(campaign, customer, businessName, whiteLabel, logoUrl, brandColor, lastVisitText, winOf, optOut);
                  if (ask.asked) {
                    summary.address_requests++;
                    if (ask.reason === "sms") textedRecently.add(customer.id);
                  } else if (ask.reason === "sms_quiet_hours") {
                    // The window shut between the check above and the ask — still hold.
                    heldForQuietHours(customer);
                    continue;
                  } else if (ask.reason === "email_deferred") {
                    summary.skipped.email_backoff++;
                    continue;
                  } else if (ask.reason !== "recently_asked") {
                    asked = false; // the owner alert must not claim the customer was asked
                  }
                }
                await queuePhysicalGiftAlert(campaign, customer, hasAddress, asked);
                await recordSend(campaign, customer, "alert", "queued_review", "Physical gift queued for manual review");
              }
              touched();
              summary.queued_physical++;
              bizSends++;
              continue;
            }

            if (campaign.campaign_type === "postcard") {
              if (!hasAddress) {
                summary.skipped.postcard_no_address++;
                if (addressAskHeld(customer, winOf)) {
                  // Quiet hours: the address request waits and goes out as a text once the
                  // customer's send window opens (nothing is recorded, so the next run retries it).
                  heldForQuietHours(customer);
                } else if (!dryRun) {
                  const ask = await maybeRequestAddress(campaign, customer, businessName, whiteLabel, logoUrl, brandColor, lastVisitText, winOf, optOut);
                  if (ask.asked) {
                    summary.address_requests++;
                    if (ask.reason === "sms") textedRecently.add(customer.id);
                  }
                }
                continue;
              }
              if (!dryRun) {
                // Pay first, mail second: the ledger refuses an overdraft atomically, and a
                // refused mailing is refunded. The key means a repeat today never charges again.
                const payKey = sendKey(campaign, customer, "postcard");
                const label = plainText(campaign.name || campaign.trigger || "campaign");
                const debit = await walletApplySafe(userId, -POSTCARD_PRICE, "postcard_debit", `Postcard: ${label}`, String(campaign.id), payKey);
                if (!debit) {
                  summary.skipped.wallet_unavailable++;
                  continue;
                }
                if (!debit.ok) {
                  summary.skipped.postcard_wallet++;
                  continue;
                }
                let replay = false;
                if (debit.duplicate) {
                  // Today's charge for this card is already on the ledger: an earlier attempt
                  // was refunded (Lob refused), or it mailed / never reached Lob and lost its
                  // record. Only the refunded case stops here; otherwise the same Lob key
                  // returns the card already made or makes the one already paid for.
                  const refunded = await ledgerHas(`${payKey}:refund`);
                  if (refunded !== false) {
                    summary.skipped.duplicate_send++;
                    if (refunded) {
                      await recordSend(campaign, customer, "postcard", "failed", "already attempted and refunded today");
                      touched();
                    }
                    continue;
                  }
                  replay = true;
                }
                const pcMessage = fillTemplate(campaign.message || "We miss you, {{first_name}}! Come see us at {{business_name}} soon.", customer, businessName);
                const result = await sendPostcard(customer, businessName, pcMessage, whiteLabel, brandColor, logoUrl, String(campaign.postcard_design || "bold"), payKey);
                await recordSend(campaign, customer, "postcard", result.ok ? "sent" : result.ambiguous ? "unconfirmed" : "failed", result.detail);
                let shipped = false;
                if (result.ok && replay) {
                  const prior = await rest(
                    `/rest/v1/shipments?user_id=eq.${encodeURIComponent(userId)}&customer_id=eq.${customer.id}&campaign=eq.${encodeURIComponent(String(campaign.id))}&gift_type=eq.postcard&created_at=gte.${encodeURIComponent(utcDayStart())}&select=id&limit=1`,
                  ).catch(() => []);
                  shipped = Array.isArray(prior) && prior.length > 0;
                }
                if (result.ok && shipped) {
                  touched();
                  summary.skipped.duplicate_send++;
                } else if (result.ok) {
                  await rest("/rest/v1/shipments", {
                    method: "POST",
                    headers: { Prefer: "return=minimal" },
                    body: JSON.stringify({
                      user_id: userId,
                      merchant_id: userId,
                      customer_name: plainText(customer.name || "Customer"),
                      customer_id: customer.id,
                      gift: "Mailed Postcard",
                      campaign: String(campaign.id),
                      status: "mailed",
                      platform: "lob",
                      gift_type: "postcard",
                    }),
                  }).catch(() => {});
                  touched();
                  summary.sent++;
                  bizSends++;
                } else if (result.ambiguous) {
                  // Lob may have accepted it: keep the charge, start the cooldown, and leave
                  // it for ops (the row is listed under failed sends as 'unconfirmed').
                  touched();
                  summary.unconfirmed++;
                  bizSends++;
                } else {
                  const refund = await walletApplySafe(userId, POSTCARD_PRICE, "postcard_refund", `Refund: postcard not mailed (${label})`, String(campaign.id), `${payKey}:refund`);
                  if (!refund?.ok) {
                    summary.wallet_refund_failed++;
                    globalThis.console?.error(`postcard refund failed for ${payKey}`);
                  }
                  summary.failed++;
                }
              } else {
                touched();
                summary.sent++;
              }
              continue;
            }

            const channel = campaign.delivery_channel || "email";
            // Quiet hours: this customer is due a text but their send window is
            // closed, so hold the WHOLE touch. Sending the email now would record the send
            // and the per-campaign cooldown would then swallow the text for good; held, the
            // email and the text go out together on the first run inside the window.
            // Customers who can't be texted anyway (plan, registration, consent, phone)
            // fall through and get their email right away. Applies to dry runs too.
            if (channel.includes("sms") && smsLimit > 0 && canText(customer) && !smsWindowOpenFor(winOf(customer))) {
              heldForQuietHours(customer);
              continue;
            }
            // Same idea while Resend is throttling this run: the touch waits for next hour.
            if (channel.includes("email") && !dryRun && emailBackoff() && customer.email && !customer.email_unsubscribed_at) {
              summary.skipped.email_backoff++;
              continue;
            }
            const template = campaign.message || "Thanks for being a customer of {{business_name}}!";
            const message = fillTemplate(template, customer, businessName);
            // One-time code offers wait until the owner's counter / website test has passed, and
            // until each needed code is in hand (no cooldown starts, so the next run retries).
            let offerCodes: OfferCodes | null = null;
            if (campaign.reward_unique && (campaign.reward_offer || "").trim()) {
              const where = campaign.reward_where || "store";
              const needStore = where !== "web";
              const needWeb = where !== "store";
              if ((needStore && !biz?.offers_store_verified_at) || (needWeb && !biz?.offers_web_verified_at)) {
                summary.skipped.offer_not_verified++;
                continue;
              }
              if (!dryRun) {
                offerCodes = await offerCodesFor(userId, campaign, customer, needStore, needWeb);
                if (!offerCodes) {
                  summary.skipped.offer_code_unavailable++;
                  continue;
                }
              }
            }
            const reward = rewardBlocks(campaign, offerCodes);
            let sentSomething = false;
            let closed = false; // recorded without a confirmed send (unknown outcome / already done today)
            let failure = "";

            if (channel.includes("email")) {
              if (!customer.email) {
                summary.skipped.missing_contact++;
              } else if (customer.email_unsubscribed_at) {
                summary.skipped.email_unsubscribed++;
              } else {
                const list = await suppressionsFor(userId);
                const suppressed = list ? list.has(customer.email.trim().toLowerCase()) : null;
                if (suppressed === null) {
                  summary.skipped.email_suppression_unavailable++;
                } else if (suppressed) {
                  summary.skipped.email_unsubscribed++;
                } else if (!postal) {
                  summary.skipped.email_no_postal_address++;
                } else if (!dryRun) {
                  const firstName = (customer.name || "there").trim().split(/\s+/)[0];
                  const subject = emailTpl?.subject
                    ? emailTpl.subject.replaceAll("{{first_name}}", firstName).replaceAll("{{business_name}}", businessName)
                    : `A message from ${businessName}`;
                  const override = (emailTpl?.html && emailTpl.html.trim())
                    ? renderUnlayer(emailTpl.html, message, businessName, firstName)
                    : emailTpl?.blocks?.length
                    ? renderTemplate(emailTpl, message, businessName, firstName, whiteLabel)
                    : undefined;
                  const result = await sendEmail(
                    customer.email,
                    subject,
                    message,
                    businessName,
                    customer.name || "there",
                    override,
                    whiteLabel,
                    logoUrl,
                    brandColor,
                    lastVisitText,
                    reward.html,
                    userId,
                    sendKey(campaign, customer, "email"),
                  );
                  await recordSend(campaign, customer, "email", result.ok ? "sent" : result.retry ? "deferred" : "failed", result.detail);
                  if (result.retry) {
                    // Resend throttled or failed on its side: the text waits too, and the
                    // whole touch is retried next hour (a 'deferred' row starts no cooldown).
                    summary.deferred++;
                    continue;
                  }
                  if (result.ok) sentSomething = true;
                  else failure = result.detail;
                } else {
                  sentSomething = true;
                }
              }
            }

            if (channel.includes("sms")) {
              if (smsLimit <= 0) {
                summary.skipped.sms_not_in_plan++;
              } else if (!msidByUser.has(String(userId))) {
                summary.skipped.sms_not_registered++;
              } else if (!customer.sms_consent || customer.sms_unsubscribed_at) {
                summary.skipped.no_sms_consent++;
              } else if (!normalizePhone(customer.phone)) {
                summary.skipped.missing_contact++;
              } else if (!smsWindowOpenFor(winOf(customer))) {
                // Only reachable when the window shut mid-touch (the hold above covers the
                // normal case): the email already went, the text still never leaves late.
                heldForQuietHours(customer);
              } else if (dryRun) {
                if (smsUsed >= smsLimit && (await walletBalance(userId)) < SMS_OVERAGE_PRICE) summary.skipped.sms_budget++;
                else sentSomething = true;
              } else {
                // Past the plan's allowance each text is paid for BEFORE it goes out.
                const smsOverage = smsUsed >= smsLimit;
                const payKey = sendKey(campaign, customer, "sms");
                let paid = true;
                if (smsOverage) {
                  const debit = await walletApplySafe(userId, -SMS_OVERAGE_PRICE, "sms_overage", "SMS overage (plan limit reached)", String(campaign.id), payKey);
                  if (!debit) { summary.skipped.wallet_unavailable++; paid = false; }
                  else if (!debit.ok) { summary.skipped.sms_budget++; paid = false; }
                  else if (debit.duplicate) {
                    // Today's charge for this text is already on the ledger. Send only if no
                    // attempt was made (the charging call timed out after it committed);
                    // otherwise close the pair with what happened, so it isn't paid again.
                    const refunded = await ledgerHas(`${payKey}:refund`);
                    const tried = refunded === false ? await smsAttemptToday(campaign, customer) : null;
                    if (tried !== "") {
                      summary.skipped.duplicate_send++;
                      paid = false;
                      if (refunded || tried) {
                        await recordSend(campaign, customer, "sms", tried === "sent" ? "sent" : "failed", "already attempted today (duplicate charge key)");
                        closed = true;
                      }
                    }
                  }
                }
                if (paid) {
                  const smsBody = fillTemplate(campaign.sms_message || template, customer, businessName) + reward.sms;
                  const result = await sendSms(campaign, customer, optOut ? withOptOut(smsBody) : smsBody, winOf(customer));
                  if (result.ok) {
                    sentSomething = true;
                    smsUsed++;
                    textedRecently.add(customer.id);
                  } else if (result.ambiguous) {
                    // Twilio may have sent it: no refund and no retry (the record starts the cooldown).
                    summary.unconfirmed++;
                    closed = true;
                  } else {
                    failure = result.detail;
                    if (smsOverage) {
                      const refund = await walletApplySafe(userId, SMS_OVERAGE_PRICE, "sms_overage_refund", "Refund: SMS overage (text not sent)", String(campaign.id), `${payKey}:refund`);
                      if (!refund?.ok) {
                        summary.wallet_refund_failed++;
                        globalThis.console?.error(`sms overage refund failed for ${payKey}`);
                      }
                    }
                  }
                  await recordSend(campaign, customer, "sms", result.ok ? "sent" : result.ambiguous ? "unconfirmed" : "failed", result.detail);
                }
              }
            }

            if (sentSomething) {
              touched();
              summary.sent++;
              bizSends++;
            } else if (closed) {
              touched();
              bizSends++;
            } else if (failure) {
              summary.failed++;
            }
          }
          if (outOfTime) break;
        }
      } catch (e) {
        summary.business_errors++;
        summary.last_error = `${userId}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
        globalThis.console?.error("campaign-runner business error:", userId, e);
      }
      if (outOfTime) { summary.timed_out = true; summary.resume_from = userId; break; }
    }

    runOk = true;
    return json(summary);
  } catch (error) {
    runError = error instanceof Error ? error.message : "Campaign run failed";
    globalThis.console?.error("campaign-runner error:", error);
    return json({ error: runError }, 500);
  } finally {
    if (runId) await runFinish(runId, runOk, runOk ? summary : { ...summary, ok: false, error: runError });
    if (holder) await leaseRelease(holder);
  }
});
