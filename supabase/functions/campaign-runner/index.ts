// Clicktide campaign engine.
// Runs hourly via pg_cron (or manually by a staff admin). Scans every business's
// active campaigns, matches customers to triggers, applies guards, then sends
// email/SMS. Customer-facing emails ship in a branded shell (business logo or
// brand-colored wordmark) so they never read as anonymous/phishy. Physical gifts
// queue alerts; postcards mail via Lob. When a matched customer has no mailing
// address, the engine asks THEM for it (tokenized /gift-address link), max every 14d.
//
// NOTE: deployed as v14 on 2026-06-11. This file mirrors the deployed source;
// the brandedShell/sendEmail/maybeRequestAddress sections are the v14 changes.

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL") || "Clicktide <support@goclicktide.com>";
const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const twilioToken = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
const twilioFrom = Deno.env.get("TWILIO_FROM_NUMBER") || "";
const lobKey = Deno.env.get("LOB_API_KEY") || "";
const POSTCARD_PRICE = 1.5; // debited from the gift wallet per mailed postcard
const ADDRESS_FORM_URL = "https://goclicktide.com/gift-address";
const ADDRESS_ASK_COOLDOWN_DAYS = 14;
const lobFrontTpl = Deno.env.get("LOB_FRONT_TEMPLATE") || "";
const lobBackTpl = Deno.env.get("LOB_BACK_TEMPLATE") || "";

const MAX_SENDS_PER_BUSINESS = 25;
const PLAN_SMS_LIMITS: Record<string, number> = { local: 200, growth: 1000, scale: 5000 };
const SMS_OVERAGE_PRICE = 0.05;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-clicktide-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Campaign = {
  id: number;
  user_id: string;
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
  sms_consent?: boolean;
  sms_unsubscribed_at?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  address_request_token?: string;
  address_requested_at?: string;
};

type Business = {
  user_id: string;
  business_name?: string;
  churn_days?: number;
  stripe_subscription_status?: string;
  plan?: string;
  logo_url?: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function rest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
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
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
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

function matchesTrigger(trigger: string, c: Customer, churnDays: number) {
  const t = (trigger || "").toLowerCase();
  const numMatch = t.match(/(\d+)/);
  const num = numMatch ? parseInt(numMatch[1], 10) : null;
  const visits = c.visits || c.order_count || 0;
  const since = daysSince(c.last_visit_at || c.last_order_at);

  if (/inactive|win[- ]?back|churn/.test(t)) {
    const threshold = num || churnDays || 60;
    return { match: since !== null && since >= threshold, reason: "inactive" };
  }
  if (/first (purchase|visit|order|class|payment)|new customer|welcome/.test(t)) {
    return { match: visits >= 1, reason: "first" };
  }
  if (num && /(visit|order|class|milestone)/.test(t)) {
    return { match: visits >= num, reason: "milestone" };
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

function normalizePhone(value?: string | null) {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Branded shell for every customer-facing email the engine sends by default:
// business logo (or brand-colored wordmark) on top, white card, clear footer.
// This is what keeps a win-back text from reading like a phishing attempt.
function brandedShell(businessName: string, inner: string, whiteLabel: boolean, logoUrl = "", brandColor = "#0B62D6") {
  const header = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(businessName)}" style="max-height:56px;max-width:220px;display:block;margin:0 auto 6px"/><div style="font-size:15px;font-weight:bold;color:#111827;text-align:center">${escapeHtml(businessName)}</div>`
    : `<div style="font-size:23px;font-weight:bold;color:${escapeHtml(brandColor)};text-align:center">${escapeHtml(businessName)}</div>`;
  return `<div style="background:#F4F5F7;padding:26px 12px;font-family:Arial,Helvetica,sans-serif">
    <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border-radius:14px;overflow:hidden;border:1px solid #E9EBEF">
      <div style="padding:26px 30px 20px;border-bottom:1px solid #F0F1F4">${header}</div>
      <div style="padding:26px 30px;color:#1F2937;font-size:15px;line-height:1.7">${inner}</div>
      <div style="padding:16px 30px 22px;border-top:1px solid #F0F1F4;font-size:11px;color:#9CA3AF;text-align:center">${whiteLabel ? escapeHtml(businessName) : `Sent by Clicktide on behalf of ${escapeHtml(businessName)} · goclicktide.com`}</div>
    </div></div>`;
}

type EmailTemplate = {
  subject?: string;
  blocks?: Array<{ t: string; v?: string; s?: string; url?: string }>;
  brand?: { color?: string; btn?: string; font?: string; logo?: string };
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

async function sendEmail(to: string, subject: string, message: string, businessName: string, customerName: string, htmlOverride?: string, whiteLabel = false, logoUrl = "", brandColor = "#0B62D6") {
  if (!resendApiKey) return { ok: false, detail: "RESEND_API_KEY is not configured" };
  const first = escapeHtml(customerName.split(/\s+/)[0] || "there");
  const inner = `<p style="margin:0 0 14px">Hi ${first},</p><p style="margin:0">${escapeHtml(message).replaceAll("\n", "<br>")}</p>`;
  const html = htmlOverride || brandedShell(businessName, inner, whiteLabel, logoUrl, brandColor);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: resendFrom, to: [to], subject, html }),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, detail: response.ok ? String(data.id || "") : String(data?.message || "Resend failed") };
}

async function sendSms(campaign: Campaign, customer: Customer, body: string) {
  if (!twilioSid || !twilioToken || !twilioFrom) {
    return { ok: false, detail: "Twilio is not configured" };
  }
  const toPhone = normalizePhone(customer.phone);
  if (!toPhone) return { ok: false, detail: "Invalid phone" };

  const form = new URLSearchParams({ To: toPhone, From: twilioFrom, Body: body.slice(0, 1500) });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${twilioSid}:${twilioToken}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
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
  const r = await fetch("https://api.lob.com/v1/postcards", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(lobKey + ":"), "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
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

async function queuePhysicalGiftAlert(campaign: Campaign, customer: Customer, hasAddress: boolean) {
  const addressNote = hasAddress
    ? "Their mailing address is on file — review and send from the dashboard."
    : "No mailing address yet — Clicktide has asked them for it directly; it will appear on their profile once they reply.";
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
async function maybeRequestAddress(campaign: Campaign, customer: Customer, businessName: string, whiteLabel: boolean, logoUrl = "", brandColor = "#0B62D6") {
  const lastAsk = customer.address_requested_at ? Date.parse(customer.address_requested_at) : 0;
  if (lastAsk && Date.now() - lastAsk < ADDRESS_ASK_COOLDOWN_DAYS * 86400000) return { asked: false, reason: "recently_asked" };
  const token = String(customer.address_request_token || "");
  if (!token) return { asked: false, reason: "no_token" };
  const link = `${ADDRESS_FORM_URL}?t=${token}`;
  const first = (customer.name || "there").trim().split(/\s+/)[0];
  let sent = false;
  let channel = "";

  if (customer.sms_consent && !customer.sms_unsubscribed_at && normalizePhone(customer.phone)) {
    const smsBody = `Hey ${first}! ${businessName} has a little something they want to MAIL you \u{1F381} Tell us where to send it: ${link}`;
    const r = await sendSms(campaign, customer, smsBody);
    if (r.ok) { sent = true; channel = "sms"; }
  }
  if (!sent && customer.email) {
    const inner = `<p style="margin:0 0 14px">Hi ${escapeHtml(first)},</p>
      <p style="margin:0 0 18px">${escapeHtml(businessName)} has a little something they want to <b>mail you</b> \u{1F381} — a real piece of mail, the good kind. We just need to know where to send it.</p>
      <div style="text-align:center;margin:22px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:${escapeHtml(brandColor)};color:#FFFFFF;font-weight:bold;font-size:15px;text-decoration:none;padding:13px 32px;border-radius:10px">Tell us where to send it →</a></div>
      <p style="margin:0;font-size:12px;color:#6B7280;line-height:1.7">Takes 20 seconds and only asks for a mailing address — never payment details. The secure form lives at goclicktide.com, the service ${escapeHtml(businessName)} uses to send customer gifts.</p>`;
    const html = brandedShell(businessName, inner, whiteLabel, logoUrl, brandColor);
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
  const validKey = providedKey && providedKey === await expectedCronKey();
  if (!validKey && !(await isStaffAdmin(req))) {
    return json({ error: "Not authorized to run campaigns" }, 401);
  }

  const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";

  const summary = {
    ok: true,
    dry_run: dryRun,
    businesses: 0,
    campaigns: 0,
    evaluated: 0,
    sent: 0,
    queued_physical: 0,
    address_requests: 0,
    failed: 0,
    skipped: {
      billing_inactive: 0,
      cooldown: 0,
      no_match: 0,
      unsupported_trigger: 0,
      unhappy_customer: 0,
      missing_contact: 0,
      no_sms_consent: 0,
      sms_budget: 0,
      postcard_no_address: 0,
      postcard_wallet: 0,
      send_cap: 0,
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
      `/rest/v1/clicktide?user_id=in.(${userIds.join(",")})&select=user_id,business_name,churn_days,stripe_subscription_status,plan,logo_url`,
    ) as Business[];
    const bizByUser = new Map(businesses.map((b) => [b.user_id, b]));
    summary.businesses = userIds.length;

    for (const userId of userIds) {
      const biz = bizByUser.get(userId);
      const status = String(biz?.stripe_subscription_status || "").toLowerCase();
      const userCampaigns = campaigns.filter((c) => c.user_id === userId);

      if (!["active", "trialing"].includes(status)) {
        summary.skipped.billing_inactive += userCampaigns.length;
        continue;
      }

      const customers = await rest(
        `/rest/v1/customers?user_id=eq.${encodeURIComponent(userId)}&select=*`,
      ) as Customer[];
      if (!customers.length) continue;

      let emailTpl: EmailTemplate | null = null;
      try {
        const tplRows = await rest(
          `/rest/v1/email_templates?user_id=eq.${encodeURIComponent(userId)}&name=eq.Default&limit=1`,
        );
        if (Array.isArray(tplRows) && tplRows[0]) emailTpl = tplRows[0] as EmailTemplate;
      } catch (_) { /* default wrapper */ }

      const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString();
      const sends = await rest(
        `/rest/v1/campaign_sends?user_id=eq.${encodeURIComponent(userId)}&sent_at=gte.${yearAgo}&select=campaign_id,customer_id,sent_at`,
      ) as Array<{ campaign_id: number; customer_id: number; sent_at: string }>;
      const lastSend = new Map<string, number>();
      for (const s of sends) {
        const key = `${s.campaign_id}:${s.customer_id}`;
        const t = Date.parse(s.sent_at);
        if (!lastSend.has(key) || t > (lastSend.get(key) || 0)) lastSend.set(key, t);
      }

      let bizSends = 0;
      const churnDays = biz?.churn_days || 60;
      const businessName = biz?.business_name || "your favorite local business";
      const logoUrl = String(biz?.logo_url || "");
      const brandColor = String(emailTpl?.brand?.color || "#0B62D6");
      const plan = String(biz?.plan || "").toLowerCase();
      const smsLimit = PLAN_SMS_LIMITS[plan] ?? 200;
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
        for (const customer of customers) {
          if (bizSends >= MAX_SENDS_PER_BUSINESS) {
            summary.skipped.send_cap++;
            continue;
          }
          summary.evaluated++;

          const { match, reason } = matchesTrigger(campaign.trigger || "", customer, churnDays);
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

          const hasAddress = !!(customer.address && customer.city && customer.state && customer.zip);

          if (campaign.campaign_type === "physical_gift") {
            if (!dryRun) {
              if (!hasAddress) {
                const ask = await maybeRequestAddress(campaign, customer, businessName, whiteLabel, logoUrl, brandColor);
                if (ask.asked) summary.address_requests++;
              }
              await queuePhysicalGiftAlert(campaign, customer, hasAddress);
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
              if (!dryRun) {
                const ask = await maybeRequestAddress(campaign, customer, businessName, whiteLabel, logoUrl, brandColor);
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
          const template = campaign.message || "Thanks for being a customer of {{business_name}}!";
          const message = fillTemplate(template, customer, businessName);
          let sentSomething = false;
          let failure = "";

          if (channel.includes("email")) {
            if (!customer.email) {
              summary.skipped.missing_contact++;
            } else if (!dryRun) {
              const firstName = (customer.name || "there").trim().split(/\s+/)[0];
              const subject = emailTpl?.subject
                ? emailTpl.subject.replaceAll("{{first_name}}", firstName).replaceAll("{{business_name}}", businessName)
                : `A message from ${businessName}`;
              const override = emailTpl?.blocks?.length
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
              );
              if (result.ok) sentSomething = true;
              else failure = result.detail;
              await recordSend(campaign, customer, "email", result.ok ? "sent" : "failed", result.detail);
            } else {
              sentSomething = true;
            }
          }

          if (channel.includes("sms")) {
            if (!customer.sms_consent || customer.sms_unsubscribed_at) {
              summary.skipped.no_sms_consent++;
            } else if (!normalizePhone(customer.phone)) {
              summary.skipped.missing_contact++;
            } else if (smsUsed >= smsLimit && (await walletBalance(userId)) < SMS_OVERAGE_PRICE) {
              summary.skipped.sms_budget++;
            } else if (!dryRun) {
              const smsOverage = smsUsed >= smsLimit;
              const smsBody = fillTemplate(campaign.sms_message || template, customer, businessName);
              const result = await sendSms(campaign, customer, smsBody);
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
