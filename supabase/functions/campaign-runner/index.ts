// Clicktide campaign engine. v42 — win-back runs on the shared retention engine: before each business is evaluated its customers' statuses are refreshed (clicktide_refresh_rhythm) and "inactive/win-back" fires on status drifting/at_risk (a campaign naming "at risk" or "drifting" targets just that status; an explicit day count still overrides). One-visit customers (no personal rhythm) are skipped unless the owner opts in (clicktide.winback_include_estimated). A customer gets a given win-back campaign at most once per drift episode. v26 — reliability: every external call (Resend/Twilio/Lob/Printify/Supabase) now has a hard timeout (fetchT), and the run stops cleanly at a 110s deadline (timed_out flag) so it can never hit the ~150s gateway 504; unreached businesses are picked up next hour (cooldown prevents double-sends). v25 — adds the New-Customer Welcome Journey: "welcome" / "second-visit nudge (day N)" / "win the second visit (day N)" triggers, keyed on first-visit recency + visit count, staged so a brand-new customer is walked through their first weeks (and the journey self-pauses the moment they return). v24 — win-back trigger is cadence-aware: "inactive/win-back" fires on each customer's OWN learned visit rhythm (effChurn), not a flat owner-set timer. Mirrors effChurn() in index.html so dashboard drift flags and actual sends agree. (v20 — backfill-safe: event triggers gated by campaign.created_at; 48h warm-up after first POS connection)
// SMS quiet hours (2026-11): customer texts leave only inside the business's local send
// window — 9:00–20:00, Sundays 12:00–20:00 (see smsWindowOpen). A customer who is due a
// text while the window is closed has the WHOLE touch held, so the email and the text go
// out together on the first hourly run inside the window instead of the email's
// cooldown swallowing the text.
// Hourly via pg_cron (or staff admin). Customer-facing emails ship in a branded
// shell and cite the customer's real last visit. Physical gifts respect the
// business's gift_auto_send toggle: ON = order placed automatically through
// printify-fulfill-gift (internal cron-key call, wallet-funded); OFF (default)
// = queued as an alert for owner review. Auto-send failures fall back to the
// review queue so no gift is ever silently lost.

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL") || "Clicktide <support@goclicktide.com>";
const EMAIL_FROM_DOMAIN = "support@goclicktide.com"; // verified Resend sender; the display name is the business
const EMAIL_UNSUB_SECRET = Deno.env.get("EMAIL_UNSUB_SECRET") || serviceRoleKey; // signs one-click unsubscribe links
const EMAIL_FOOTER_ADDR = "Glen Cove, NY 11542"; // interim — replace with the PO Box / business address (CAN-SPAM physical address)
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
  reward_offer?: string;
  reward_code?: string;
  reward_link?: string;
  reward_expires?: string;
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
// which every caller already treats as a normal failure (and falls back / records it).
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

async function walletBalance(userId: string) {
  try {
    const data = await rest("/rest/v1/rpc/clicktide_wallet_balance", { method: "POST", body: JSON.stringify({ client_id: userId }) });
    return Number(data || 0);
  } catch {
    return 0;
  }
}

async function debitWallet(userId: string, amount: number, description: string, reference: string | null) {
  await rest("/rest/v1/rpc/clicktide_debit_gift_wallet_server", {
    method: "POST",
    body: JSON.stringify({ client_id: userId, debit_amount: amount, description, reference }),
  });
}

async function expectedCronKey() {
  try {
    const data = await rest("/rest/v1/rpc/clicktide_internal_key", { method: "POST", body: "{}" });
    return String(data || "");
  } catch {
    return "";
  }
}

async function isStaffAdmin(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return false;
  const response = await fetchT(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceRoleKey, Authorization: authorization },
  });
  if (!response.ok) return false;
  const user = await response.json();
  if (!user?.id) return false;
  const rows = await rest(
    `/rest/v1/clicktide_staff?select=role&user_id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&role=in.(admin,support)`,
  );
  return Array.isArray(rows) && rows.length > 0;
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

// The customer-facing "From" shows the BUSINESS name — recipients recognize their own
// salon/shop, not "Clicktide" — sent from the one verified, authenticated domain.
function bizFrom(name: string): string {
  const clean = (name || "Clicktide").replace(/[<>"\r\n,;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Clicktide";
  return `${clean} <${EMAIL_FROM_DOMAIN}>`;
}

// One-click unsubscribe link, signed (HMAC) so it can't be forged. Keyed on the email
// so sendEmail — which only has the address — can build it without a DB lookup.
async function unsubUrlFor(email: string): Promise<string> {
  const addr = (email || "").trim().toLowerCase();
  if (!addr) return "";
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(EMAIL_UNSUB_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(addr));
    const tok = [...new Uint8Array(sig)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${supabaseUrl}/functions/v1/email-unsubscribe?e=${encodeURIComponent(addr)}&t=${tok}`;
  } catch {
    return "";
  }
}

// Branded shell for customer-facing emails. Header centering uses a table cell
// with align=center — the only method every mail client respects. The footer carries
// the CAN-SPAM essentials: why-you're-getting-this, a working unsubscribe, and a
// physical mailing address.
function brandedShell(businessName: string, inner: string, whiteLabel: boolean, logoUrl = "", brandColor = "#0B62D6", unsubUrl = "") {
  const header = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="" width="56" style="max-height:56px;display:inline-block;vertical-align:middle"/><div style="font-size:15px;font-weight:bold;color:#111827;margin-top:6px">${escapeHtml(businessName)}</div>`
    : `<div style="font-size:23px;font-weight:bold;color:${escapeHtml(brandColor)}">${escapeHtml(businessName)}</div>`;
  const unsub = unsubUrl ? `<a href="${escapeHtml(unsubUrl)}" style="color:#9CA3AF;text-decoration:underline">Unsubscribe</a> · ` : "";
  const powered = whiteLabel ? "" : `Sent via <a href="https://goclicktide.com" style="color:#9CA3AF;text-decoration:underline">Clicktide</a> · `;
  const footer = `You're receiving this because you're a customer of ${escapeHtml(businessName)}.<br>${unsub}${powered}${escapeHtml(businessName)}, ${EMAIL_FOOTER_ADDR}`;
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
// Build the digital-reward block (promo code / offer / online link) for email + SMS.
function rewardBlocks(campaign: Campaign): { html: string; sms: string } {
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

async function sendEmail(to: string, subject: string, message: string, businessName: string, customerName: string, htmlOverride?: string, whiteLabel = false, logoUrl = "", brandColor = "#0B62D6", lastVisitText = "", rewardHtml = "") {
  if (!resendApiKey) return { ok: false, detail: "RESEND_API_KEY is not configured" };
  const first = escapeHtml(customerName.split(/\s+/)[0] || "there");
  const visitLine = lastVisitText
    ? `<p style="margin:18px 0 0;font-size:12px;color:#9CA3AF">\u{1F4CD} Your last visit to ${escapeHtml(businessName)}: ${escapeHtml(lastVisitText)}</p>`
    : "";
  const inner = `<p style="margin:0 0 14px">Hi ${first},</p><p style="margin:0">${escapeHtml(message).replaceAll("\n", "<br>")}</p>${visitLine}${rewardHtml}`;
  const unsubUrl = await unsubUrlFor(to);
  let html = htmlOverride ? (htmlOverride + rewardHtml) : brandedShell(businessName, inner, whiteLabel, logoUrl, brandColor, unsubUrl);
  // Every email needs a visible unsubscribe + mailing address (CAN-SPAM). The branded
  // shell already includes them; a custom/Unlayer template may not, so append once.
  if (htmlOverride && unsubUrl && !html.includes("email-unsubscribe")) {
    html += `<div style="text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#9CA3AF;padding:14px 12px;line-height:1.7">${escapeHtml(businessName)}, ${EMAIL_FOOTER_ADDR}<br><a href="${escapeHtml(unsubUrl)}" style="color:#9CA3AF;text-decoration:underline">Unsubscribe</a></div>`;
  }
  const listUnsub = unsubUrl
    ? { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    : {};
  const response = await fetchT("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: bizFrom(businessName), to: [to], subject, html, headers: listUnsub }),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, detail: response.ok ? String(data.id || "") : String(data?.message || "Resend failed") };
}

// ── SMS send window (quiet hours) ───────────────────────────────────────────
// Customer texts go out only 9:00–20:00 in the business's local time, and only
// 12:00–20:00 on Sundays. That sits inside the federal TCPA window (8am–9pm
// recipient-local) and the stricter state windows (e.g. FL/OK 8am–8pm; TX 9am–9pm
// Mon–Sat, noon–9pm Sunday). The cron fires every hour around the clock, so this
// gate — not the schedule — is what keeps texts out of quiet hours.
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
// (tzForState() above is display-only: it guesses Eastern for anything it doesn't
// list — AK, HI, a blank state… — fine for a "last visit" line, unsafe for this.)
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

// No usable state on file: text only while the window is open everywhere from the
// East Coast to Hawaii (roughly 2–8pm Eastern) until the business's state is filled in.
const SMS_ZONES_UNKNOWN = [TZ_EASTERN, TZ_CENTRAL, TZ_MOUNTAIN, TZ_PACIFIC, TZ_ALASKA, TZ_HAWAII];

function smsZonesForState(state?: string): string[] {
  const raw = String(state || "").toUpperCase().replace(/\./g, "").replace(/[^A-Z]+/g, " ").trim();
  const code = SMS_STATE_NAMES[raw] || raw.replace(/ /g, "");
  return SMS_STATE_ZONES[code] || SMS_ZONES_UNKNOWN;
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

// May a customer text go out right now for a business in this state? Fails closed:
// if the local time can't be worked out, the window counts as shut.
function smsWindowOpen(state?: string, at: Date = new Date()): boolean {
  try {
    return smsZonesForState(state).every((tz) => smsWindowOpenIn(tz, at));
  } catch {
    return false;
  }
}

// Known-answer check of the window maths in THIS runtime, reported in every run
// summary. If a runtime ever formatted dates differently the window would read as
// permanently shut (it fails closed) and quietly hold every text-eligible touch; this
// turns that into a visible "failed". 2026-06-15 is a Monday and 2026-06-14 a Sunday
// (Eastern = UTC-4); 2026-01-15 17:00Z is 9am Pacific but only 7am in Hawaii.
function smsWindowSelfCheck(): boolean {
  const ny = (iso: string) => smsWindowOpen("NY", new Date(iso));
  return !ny("2026-06-15T12:59:59Z") && ny("2026-06-15T13:00:00Z") && // Mon 08:59:59 / 09:00
    ny("2026-06-15T23:59:59Z") && !ny("2026-06-16T00:00:00Z") && // Mon 19:59:59 / 20:00
    !ny("2026-06-14T15:59:59Z") && ny("2026-06-14T16:00:00Z") && // Sun 11:59:59 / 12:00
    smsWindowOpen("CA", new Date("2026-01-15T17:00:00Z")) && !smsWindowOpen("", new Date("2026-01-15T17:00:00Z"));
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

// Can this customer be texted at all — their business has its own registration, they
// opted in (and haven't opted out), and the number is usable? Plan limits and the
// send window are checked separately by the callers.
function canText(customer: Customer): boolean {
  return msidByUser.has(String(customer.user_id || "")) && !!customer.sms_consent &&
    !customer.sms_unsubscribed_at && !!normalizePhone(customer.phone);
}

async function sendSms(campaign: Campaign, customer: Customer, body: string, bizState = "") {
  const msid = msidByUser.get(String(customer.user_id || "")) || "";
  if (!msid || platformMsids.has(msid)) return { ok: false, detail: "sms_not_registered" };
  // Last line of defence: whatever the caller checked, no text leaves outside the
  // send window (an omitted state gets the narrowest window, never an open one).
  if (!smsWindowOpen(bizState)) return { ok: false, detail: "sms_quiet_hours" };
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
    // A Twilio timeout or network error fails THIS text (recorded, so the cooldown
    // stops an hourly re-send) instead of aborting the whole run.
    const why = e instanceof Error && e.name === "AbortError" ? "timeout" : "network error";
    await rest("/rest/v1/sms_messages", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: customer.user_id, campaign_id: campaign.id, customer_id: customer.id,
        to_phone: toPhone, body: body.slice(0, 1500), status: "failed", provider: "twilio",
        error: `Twilio request failed: ${why}`,
      }),
    }).catch(() => {});
    return { ok: false, detail: `Twilio request failed: ${why}` };
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

async function sendPostcard(customer: Customer, businessName: string, message: string, whiteLabel: boolean, brandColor = "#0B62D6", logoUrl = "", design = "bold") {
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
  const r = await fetchT("https://api.lob.com/v1/postcards", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(lobKey + ":"), "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  }, 20000);
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, detail: r.ok ? String(d.id || "") : String(d?.error?.message || "Lob request failed") };
}

async function recordSend(campaign: Campaign, customer: Customer, channel: string, status: string, detail: string) {
  await rest("/rest/v1/campaign_sends", {
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
  }).catch(() => {});
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
      message: `Campaign "${campaign.name || campaign.trigger}" matched ${customer.name || "a customer"} for a physical gift (${campaign.gift_name || "gift"}). ${addressNote}`,
      resolved: false,
    }),
  }).catch(() => {});
}

// Ask the customer directly for their mailing address (tokenized link), at most
// once every ADDRESS_ASK_COOLDOWN_DAYS. Texts first (with consent), else a
// branded email with the business logo + an explicit no-payment-details note.
// Auto-send a physical gift through printify-fulfill-gift (internal call).
// Returns true when the order was placed; false means fall back to review.
async function autoSendGift(campaign: Campaign, customer: Customer, internalKey: string) {
  try {
    // Route to the provider mapped for this gift (Gelato / CustomCat), else Printify.
    let endpoint = "printify-fulfill-gift";
    try {
      const cat = await rest(`/rest/v1/gift_catalog?printify_product_id=eq.${encodeURIComponent(String(campaign.printify_product_id || ""))}&select=gelato_uid,customcat_sku&limit=1`);
      const crow = Array.isArray(cat) ? cat[0] : null;
      if (crow?.gelato_uid) endpoint = "gelato-fulfill-gift";
      else if (crow?.customcat_sku) endpoint = "customcat-fulfill-gift";
    } catch (_) { /* default to Printify */ }
    const r = await fetchT(`${supabaseUrl}/functions/v1/${endpoint}`, {
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
        printify_product_id: campaign.printify_product_id,
        printify_variant_id: campaign.printify_variant_id,
        address: { address1: customer.address, city: customer.city, region: customer.state, zip: customer.zip, country: "US" },
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      await recordSend(campaign, customer, "gift", "sent", `auto-sent: ${String(d.printify_order_id || d.gelato_order_id || d.customcat_order_id || "")}`);
      return true;
    }
    await recordSend(campaign, customer, "gift", "failed", `auto-send: ${String(d?.error || "failed")}`);
    return false;
  } catch {
    return false;
  }
}

// Why an address request can't go to this customer right now ("" = it can): they were
// asked within the last ADDRESS_ASK_COOLDOWN_DAYS, or there is no link token on file.
function addressAskBlocked(customer: Customer): string {
  const lastAsk = customer.address_requested_at ? Date.parse(customer.address_requested_at) : 0;
  if (lastAsk && Date.now() - lastAsk < ADDRESS_ASK_COOLDOWN_DAYS * 86400000) return "recently_asked";
  if (!customer.address_request_token) return "no_token";
  return "";
}

// An address request is due and would go out as a text, but the business's send
// window is closed. Callers hold the whole touch until the window opens. Pure (no
// I/O), so a dry run reports exactly the decision a live run makes.
function addressAskHeld(customer: Customer, bizState: string): boolean {
  return !addressAskBlocked(customer) && canText(customer) && !smsWindowOpen(bizState);
}

async function maybeRequestAddress(campaign: Campaign, customer: Customer, businessName: string, whiteLabel: boolean, logoUrl = "", brandColor = "#0B62D6", lastVisitText = "", bizState = "") {
  const blocked = addressAskBlocked(customer);
  if (blocked) return { asked: false, reason: blocked };
  const token = String(customer.address_request_token || "");
  const link = `${ADDRESS_FORM_URL}?t=${token}`;
  const first = (customer.name || "there").trim().split(/\s+/)[0];
  let sent = false;
  let channel = "";

  if (canText(customer)) {
    // Quiet hours: hold the ask — it goes out as a text on the first run inside the
    // window — rather than downgrade it to an email now.
    if (!smsWindowOpen(bizState)) return { asked: false, reason: "sms_quiet_hours" };
    const smsBody = `Hey ${first}! ${businessName} has a little something they want to MAIL you \u{1F381} Tell us where to send it: ${link}`;
    const r = await sendSms(campaign, customer, smsBody, bizState);
    if (r.ok) { sent = true; channel = "sms"; }
  }
  // A customer who unsubscribed from email gets no address-request email either (the ask
  // is on behalf of a marketing postcard/gift, so the opt-out covers it).
  if (!sent && customer.email && !customer.email_unsubscribed_at) {
    const visitLine = lastVisitText
      ? `<p style="margin:0 0 18px;font-size:12px;color:#9CA3AF">\u{1F4CD} Your last visit: ${escapeHtml(lastVisitText)}</p>`
      : "";
    const inner = `<p style="margin:0 0 14px">Hi ${escapeHtml(first)},</p>
      <p style="margin:0 0 10px">${escapeHtml(businessName)} has a little something they want to <b>mail you</b> \u{1F381} — a real piece of mail, the good kind. We just need to know where to send it.</p>
      ${visitLine}
      <div style="text-align:center;margin:22px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:${escapeHtml(brandColor)};color:#FFFFFF;font-weight:bold;font-size:15px;text-decoration:none;padding:13px 32px;border-radius:10px">Tell us where to send it →</a></div>
      <p style="margin:0;font-size:12px;color:#6B7280;line-height:1.7">Takes 20 seconds and only asks for a mailing address — never payment details. The secure form lives at goclicktide.com, the service ${escapeHtml(businessName)} uses to send customer gifts.</p>`;
    const html = brandedShell(businessName, inner, whiteLabel, logoUrl, brandColor, await unsubUrlFor(customer.email || ""));
    const r = await sendEmail(customer.email, `${businessName} wants to mail you something \u{1F381}`, "", businessName, customer.name || "there", html, whiteLabel);
    if (r.ok) { sent = true; channel = "email"; }
  }
  if (!sent) return { asked: false, reason: "no_reachable_channel" };

  await rest(`/rest/v1/customers?id=eq.${customer.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ address_requested_at: new Date().toISOString() }),
  }).catch(() => {});
  customer.address_requested_at = new Date().toISOString();
  await recordSend(campaign, customer, "address_request", "sent", `${channel}: ${link}`);
  return { asked: true, reason: channel };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey) return json({ error: "Server secrets are not configured" }, 500);

  const providedKey = req.headers.get("x-clicktide-cron-key") || "";
  const internalKey = await expectedCronKey();
  const validKey = !!providedKey && providedKey === internalKey;
  if (!validKey && !(await isStaffAdmin(req))) {
    return json({ error: "Not authorized to run campaigns" }, 401);
  }

  const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";
  // Stop cleanly before the ~150s edge-function wall-clock limit so the run never 504s.
  // Anything not reached this hour is picked up by the next hourly cron (cooldown/no-dup
  // logic means nothing double-sends). Lets the run scale without a hard timeout.
  const RUN_DEADLINE = Date.now() + 110000;

  const summary = {
    ok: true,
    dry_run: dryRun,
    timed_out: false,
    businesses: 0,
    campaigns: 0,
    evaluated: 0,
    sent: 0,
    queued_physical: 0,
    gifts_auto_sent: 0,
    address_requests: 0,
    failed: 0,
    // Businesses with active campaigns, by whether customer texts may go out right now.
    // state_unknown = no usable state on file, so the narrowest (all-US) window applies.
    // self_check = the window maths verified against known answers in this runtime.
    sms_window: { open: 0, closed: 0, state_unknown: 0, self_check: smsWindowSelfCheck() ? "ok" : "failed" },
    // How many businesses can text (active registration linked to their account);
    // the error flag means the registry read failed and the last snapshot was kept.
    sms_registered_businesses: 0,
    sms_unlinked_registrations: 0,
    sms_registry_error: false,
    skipped: {
      billing_inactive: 0,
      cooldown: 0,
      no_match: 0,
      unsupported_trigger: 0,
      unhappy_customer: 0,
      missing_contact: 0,
      email_unsubscribed: 0,
      no_sms_consent: 0,
      sms_not_in_plan: 0,
      sms_not_registered: 0,
      sms_quiet_hours: 0, // touch held: a text is due but the send window is closed
      sms_budget: 0,
      postcard_no_address: 0,
      postcard_wallet: 0,
      send_cap: 0,
      warmup: 0,
    },
  };

  try {
    const campaigns = await rest("/rest/v1/campaigns?status=eq.active&select=*") as Campaign[];
    if (!Array.isArray(campaigns) || !campaigns.length) {
      return json({ ...summary, message: "No active campaigns." });
    }
    summary.campaigns = campaigns.length;

    const userIds = [...new Set(campaigns.map((c) => c.user_id).filter(Boolean))];
    const businesses = await rest(
      `/rest/v1/clicktide?user_id=in.(${userIds.join(",")})&select=user_id,email,business_name,churn_days,stripe_subscription_status,plan,logo_url,state,gift_auto_send,winback_include_estimated`,
    ) as Business[];
    const bizByUser = new Map(businesses.map((b) => [b.user_id, b]));
    summary.businesses = userIds.length;
    for (const b of businesses) {
      if (smsWindowOpen(b.state)) summary.sms_window.open++;
      else summary.sms_window.closed++;
      if (smsZonesForState(b.state) === SMS_ZONES_UNKNOWN) summary.sms_window.state_unknown++;
    }

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
      const regs = await rest(
        "/rest/v1/a2p_registrations?sms_status=eq.active&messaging_service_sid=not.is.null&reg_type=neq.platform&user_id=not.is.null&select=user_id,messaging_service_sid",
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

    for (const userId of userIds) {
      if (Date.now() > RUN_DEADLINE) { summary.timed_out = true; break; }
      const biz = bizByUser.get(userId);
      const status = String(biz?.stripe_subscription_status || "").toLowerCase();
      const userCampaigns = campaigns.filter((c) => c.user_id === userId);

      if (!["active", "trialing"].includes(status)) {
        summary.skipped.billing_inactive += userCampaigns.length;
        continue;
      }

      // Warm-up: for 48h after a business's FIRST register connection, no campaign
      // fires at all — the import settles, the owner looks around, nothing blasts.
      try {
        const firstConn = await rest(
          `/rest/v1/platform_connections?user_id=eq.${encodeURIComponent(userId)}&select=created_at&order=created_at.asc&limit=1`,
        );
        const connAt = Array.isArray(firstConn) && firstConn[0]?.created_at ? Date.parse(firstConn[0].created_at) : 0;
        if (connAt && Date.now() - connAt < 48 * 3600000) {
          summary.skipped.warmup += userCampaigns.length;
          continue;
        }
      } catch (_) { /* no connections — manual mode, no import flood risk */ }

      const customers = await rest(
        `/rest/v1/customers?user_id=eq.${encodeURIComponent(userId)}&select=*`,
      ) as Customer[];
      if (!customers.length) continue;

      // Shared retention engine: refresh this business's statuses, then read them.
      const rhythm = new Map<number, Rhythm>();
      try {
        await rest("/rest/v1/rpc/clicktide_refresh_rhythm", { method: "POST", body: JSON.stringify({ p_user: userId }) });
        const rows = await rest(
          `/rest/v1/customer_rhythm?user_id=eq.${encodeURIComponent(userId)}&select=customer_id,status,status_since,episode_started_at,confidence,drift_after_days`,
        ) as Array<Rhythm & { customer_id: number }>;
        for (const r of rows || []) rhythm.set(Number(r.customer_id), r);
      } catch (e) {
        console.error("retention engine unavailable; using previous rule", e);
      }

      let emailTpl: EmailTemplate | null = null;
      try {
        const tplRows = await rest(
          `/rest/v1/email_templates?user_id=eq.${encodeURIComponent(userId)}&name=eq.Default&limit=1`,
        );
        if (Array.isArray(tplRows) && tplRows[0]) emailTpl = tplRows[0] as EmailTemplate;
      } catch (_) { /* default wrapper */ }

      const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString();
      const sends = await rest(
        `/rest/v1/campaign_sends?user_id=eq.${encodeURIComponent(userId)}&sent_at=gte.${yearAgo}&select=campaign_id,customer_id,sent_at,channel`,
      ) as Array<{ campaign_id: number; customer_id: number; sent_at: string; channel?: string }>;
      const lastSend = new Map<string, number>();
      for (const s of sends) {
        // Asking a customer for their mailing address is not the touch itself: it must
        // not start the campaign's cooldown, or a postcard would still wait out the full
        // cooldown after the address arrives. Re-asking is already limited by the
        // customer's own 14-day address_requested_at timer.
        if (s.channel === "address_request") continue;
        const key = `${s.campaign_id}:${s.customer_id}`;
        const t = Date.parse(s.sent_at);
        if (!lastSend.has(key) || t > (lastSend.get(key) || 0)) lastSend.set(key, t);
      }

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
      let smsUsed = 0;
      try {
        const monthStart = new Date();
        monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
        const used = await rest(
          `/rest/v1/sms_messages?user_id=eq.${encodeURIComponent(userId)}&status=eq.sent&sent_at=gte.${monthStart.toISOString()}&select=id&limit=10000`,
        );
        smsUsed = Array.isArray(used) ? used.length : 0;
      } catch (_) { /* fail open on the counter */ }

      for (const campaign of userCampaigns) {
        if (Date.now() > RUN_DEADLINE) { summary.timed_out = true; break; }
        for (const customer of customers) {
          if (Date.now() > RUN_DEADLINE) { summary.timed_out = true; break; }
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

          const hasAddress = !!(customer.address && customer.city && customer.state && customer.zip);
          const lastVisitText = fmtLastVisit(customer.last_visit_at || customer.last_order_at, bizState);

          if (campaign.campaign_type === "physical_gift") {
            // Quiet hours: no address yet, and the request for it would go out as a text
            // while the send window is closed — hold the whole gift touch. Queuing the
            // owner alert now would start this campaign's cooldown and the customer
            // would never be asked.
            if (!hasAddress && addressAskHeld(customer, bizState)) {
              summary.skipped.sms_quiet_hours++;
              continue;
            }
            const canAuto = giftAutoSend && hasAddress && !!campaign.printify_product_id && !!campaign.printify_variant_id && (Number(campaign.gift_cost) || 0) > 0;
            if (!dryRun) {
              if (canAuto && await autoSendGift(campaign, customer, internalKey)) {
                lastSend.set(key, Date.now());
                summary.gifts_auto_sent++;
                summary.sent++;
                bizSends++;
                continue;
              }
              let asked = true;
              if (!hasAddress) {
                const ask = await maybeRequestAddress(campaign, customer, businessName, whiteLabel, logoUrl, brandColor, lastVisitText, bizState);
                if (ask.asked) summary.address_requests++;
                else if (ask.reason === "sms_quiet_hours") {
                  // The window shut between the check above and the ask — still hold.
                  summary.skipped.sms_quiet_hours++;
                  continue;
                } else if (ask.reason !== "recently_asked") {
                  asked = false; // the owner alert must not claim the customer was asked
                }
              }
              await queuePhysicalGiftAlert(campaign, customer, hasAddress, asked);
              await recordSend(campaign, customer, "alert", "queued_review", "Physical gift queued for manual review");
            }
            lastSend.set(key, Date.now());
            summary.queued_physical++;
            bizSends++;
            continue;
          }

          if (campaign.campaign_type === "postcard") {
            if (!hasAddress) {
              summary.skipped.postcard_no_address++;
              if (addressAskHeld(customer, bizState)) {
                // Quiet hours: the address request waits and goes out as a text once the
                // send window opens (nothing is recorded, so the next run retries it).
                summary.skipped.sms_quiet_hours++;
              } else if (!dryRun) {
                const ask = await maybeRequestAddress(campaign, customer, businessName, whiteLabel, logoUrl, brandColor, lastVisitText, bizState);
                if (ask.asked) summary.address_requests++;
              }
              continue;
            }
            if (!dryRun) {
              if ((await walletBalance(userId)) < POSTCARD_PRICE) {
                summary.skipped.postcard_wallet++;
                continue;
              }
              const pcMessage = fillTemplate(campaign.message || "We miss you, {{first_name}}! Come see us at {{business_name}} soon.", customer, businessName);
              const result = await sendPostcard(customer, businessName, pcMessage, whiteLabel, brandColor, logoUrl, String(campaign.postcard_design || "bold"));
              await recordSend(campaign, customer, "postcard", result.ok ? "sent" : "failed", result.detail);
              if (result.ok) {
                await debitWallet(userId, POSTCARD_PRICE, `Postcard: ${campaign.name || campaign.trigger}`, String(campaign.id)).catch(() => {});
                await rest("/rest/v1/shipments", {
                  method: "POST",
                  headers: { Prefer: "return=minimal" },
                  body: JSON.stringify({
                    user_id: userId,
                    merchant_id: userId,
                    customer_name: customer.name || "Customer",
                    customer_id: customer.id,
                    gift: "Mailed Postcard",
                    campaign: String(campaign.id),
                    status: "mailed",
                    platform: "lob",
                    gift_type: "postcard",
                  }),
                }).catch(() => {});
                lastSend.set(key, Date.now());
                summary.sent++;
                bizSends++;
              } else {
                summary.failed++;
              }
            } else {
              summary.sent++;
            }
            continue;
          }

          const channel = campaign.delivery_channel || "email";
          // Quiet hours: this customer is due a text but the business's send window is
          // closed, so hold the WHOLE touch. Sending the email now would record the send
          // and the per-campaign cooldown would then swallow the text for good; held, the
          // email and the text go out together on the first run inside the window.
          // Customers who can't be texted anyway (plan, registration, consent, phone)
          // fall through and get their email right away. Applies to dry runs too.
          if (channel.includes("sms") && smsLimit > 0 && canText(customer) && !smsWindowOpen(bizState)) {
            summary.skipped.sms_quiet_hours++;
            continue;
          }
          const template = campaign.message || "Thanks for being a customer of {{business_name}}!";
          const message = fillTemplate(template, customer, businessName);
          const reward = rewardBlocks(campaign);
          let sentSomething = false;
          let failure = "";

          if (channel.includes("email")) {
            if (!customer.email) {
              summary.skipped.missing_contact++;
            } else if (customer.email_unsubscribed_at) {
              summary.skipped.email_unsubscribed++;
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
              );
              if (result.ok) sentSomething = true;
              else failure = result.detail;
              await recordSend(campaign, customer, "email", result.ok ? "sent" : "failed", result.detail);
            } else {
              sentSomething = true;
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
            } else if (!smsWindowOpen(bizState)) {
              // Only reachable when the window shut mid-touch (the hold above covers the
              // normal case): the email already went, the text still never leaves late.
              summary.skipped.sms_quiet_hours++;
            } else if (smsUsed >= smsLimit && (await walletBalance(userId)) < SMS_OVERAGE_PRICE) {
              summary.skipped.sms_budget++;
            } else if (!dryRun) {
              const smsOverage = smsUsed >= smsLimit;
              const smsBody = fillTemplate(campaign.sms_message || template, customer, businessName) + reward.sms;
              const result = await sendSms(campaign, customer, smsBody, bizState);
              if (result.ok) {
                sentSomething = true;
                smsUsed++;
                if (smsOverage) {
                  await debitWallet(userId, SMS_OVERAGE_PRICE, "SMS overage (plan limit reached)", String(campaign.id)).catch(() => {});
                }
              } else failure = result.detail;
              await recordSend(campaign, customer, "sms", result.ok ? "sent" : "failed", result.detail);
            } else {
              sentSomething = true;
            }
          }

          if (sentSomething) {
            lastSend.set(key, Date.now());
            summary.sent++;
            bizSends++;
          } else if (failure) {
            summary.failed++;
          }
        }
      }
    }

    return json(summary);
  } catch (error) {
    console.error("campaign-runner error:", error);
    return json({ error: error instanceof Error ? error.message : "Campaign run failed" }, 500);
  }
});
