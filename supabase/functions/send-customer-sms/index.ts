const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Same allowance and price as campaign-runner — change both together.
const PLAN_SMS_LIMITS: Record<string, number> = { local: 0, growth: 1500, scale: 5000 };
const SMS_OVERAGE_PRICE = 0.05;
const MAX_SEGMENTS = 6; // Twilio bills every segment; overage is charged per text
const MANUAL_PER_BUSINESS_PER_DAY = 200;
const MANUAL_PER_CUSTOMER_PER_DAY = 10;

type SmsBody = {
  message?: string;
  customer_id?: string;
  campaign_id?: string;
  user_id?: string;
};

type CustomerRow = {
  id: string;
  user_id: string;
  phone?: string | null;
  sms_consent?: boolean | null;
  sms_unsubscribed_at?: string | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

// US numbers only: a business's carrier registration covers domestic texting.
function normalizePhone(value?: string | null) {
  const digits = String(value || "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : "";
}

// ── SMS send window (quiet hours) ───────────────────────────────────────────
// Customer texts go out only 9:00–20:00 in the business's local time, and only
// 12:00–20:00 on Sundays: inside the federal TCPA window and the stricter state
// windows. Copied verbatim from campaign-runner so a text an owner sends by hand
// follows the same rule as the automatic ones — change both together.
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

// GSM-7 texts take 160 characters (153 per part once split); one character outside the
// GSM set turns the whole text into UCS-2: 70 UTF-16 units, 67 per part.
const GSM7 = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "^{}\\[~]|€\f";
function smsSegments(text: string) {
  let units = 0;
  for (const ch of text) {
    if (GSM7.includes(ch)) units += 1;
    else if (GSM7_EXT.includes(ch)) units += 2;
    else return text.length <= 70 ? 1 : Math.ceil(text.length / 67);
  }
  return units <= 160 ? 1 : Math.ceil(units / 153);
}

function fetchT(url: string, init: RequestInit = {}, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// The shared limiter (as in checkin), but failing CLOSED: every text costs money.
// "unavailable" (the limiter itself can't answer) is told apart from a real refusal.
async function underLimit(supabaseUrl: string, serviceRoleKey: string, bucket: string, windowSeconds: number, max: number): Promise<"ok" | "limited" | "unavailable"> {
  try {
    const r = await fetchT(`${supabaseUrl}/rest/v1/rpc/clicktide_rate_limit_hit`, {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
    });
    if (!r.ok) return "unavailable";
    const v = await r.json();
    return v === true ? "ok" : v === false ? "limited" : "unavailable";
  } catch {
    return "unavailable";
  }
}

// The ledger's atomic entry point (contract C1): locks the wallet, refuses an overdraft.
async function walletApply(supabaseUrl: string, serviceRoleKey: string, userId: string, delta: number, kind: string, description: string, key: string) {
  const data = await supabaseRest(supabaseUrl, serviceRoleKey, "/rest/v1/rpc/clicktide_wallet_apply", {
    method: "POST",
    body: JSON.stringify({
      p_user: userId, p_delta: delta, p_kind: kind, p_description: description,
      p_reference: "manual", p_idempotency_key: key,
    }),
  });
  return (data && typeof data === "object" ? data : {}) as { ok?: boolean; duplicate?: boolean; reason?: string };
}

async function getUser(supabaseUrl: string, serviceRoleKey: string, authHeader: string) {
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: authHeader,
    },
  });
  if (!response.ok) return null;
  return await response.json();
}

async function supabaseRest(supabaseUrl: string, serviceRoleKey: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message || data?.error || "Supabase request failed");
  return data;
}

async function getCustomer(supabaseUrl: string, serviceRoleKey: string, id: string) {
  const rows = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/rest/v1/customers?id=eq.${encodeURIComponent(id)}&select=id,user_id,phone,sms_consent,sms_unsubscribed_at&limit=1`,
  ) as CustomerRow[];
  return Array.isArray(rows) ? rows[0] : null;
}

// Customer texts go out ONLY through the sending business's own approved A2P
// registration. Clicktide's own campaign is first-party (texts to business
// owners) and must never carry another business's customer messages.
// A registration belongs to a business only through user_id (set by staff at
// activation). Never match on email: owners can edit their own email, so an
// email match would let one account send through another business's number.
async function businessMessagingService(supabaseUrl: string, serviceRoleKey: string, userId: string) {
  const rows = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/rest/v1/a2p_registrations?sms_status=eq.active&messaging_service_sid=not.is.null&reg_type=neq.platform&user_id=eq.${encodeURIComponent(userId)}&select=messaging_service_sid&limit=1`,
  ) as Array<{ messaging_service_sid?: string }>;
  return Array.isArray(rows) && rows[0]?.messaging_service_sid ? String(rows[0].messaging_service_sid) : "";
}

async function recordSms(
  supabaseUrl: string,
  serviceRoleKey: string,
  fields: Record<string, unknown>,
) {
  await supabaseRest(supabaseUrl, serviceRoleKey, "/rest/v1/sms_messages", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(fields),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: SmsBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.message || !body.message.trim()) {
    return json({ error: "SMS message is required" }, 400);
  }
  if (!body.customer_id) {
    return json({ error: "customer_id is required so SMS consent can be verified" }, 400);
  }

  try {
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const accountSid = requiredEnv("TWILIO_ACCOUNT_SID");
    const authToken = requiredEnv("TWILIO_AUTH_TOKEN");

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing authorization" }, 401);

    const user = await getUser(supabaseUrl, serviceRoleKey, authHeader);
    if (!user?.id) return json({ error: "Invalid authorization" }, 401);

    const customer = await getCustomer(supabaseUrl, serviceRoleKey, body.customer_id);
    if (!customer) return json({ error: "Customer not found" }, 404);
    if (customer.user_id !== user.id) return json({ error: "Customer does not belong to this account" }, 403);
    if (!customer.sms_consent || customer.sms_unsubscribed_at) {
      return json({ error: "Customer has not opted in to SMS" }, 403);
    }

    // Always the number the customer gave consent on; a caller-supplied number
    // would bypass that consent.
    const toPhone = normalizePhone(customer.phone);
    if (!toPhone) return json({ error: "Customer phone number is missing or invalid" }, 400);

    const bizRows = await supabaseRest(
      supabaseUrl,
      serviceRoleKey,
      `/rest/v1/clicktide?user_id=eq.${encodeURIComponent(user.id)}&select=plan,stripe_subscription_status,state&order=id.asc&limit=1`,
    ) as Array<{ plan?: string; stripe_subscription_status?: string; state?: string }>;
    const biz = Array.isArray(bizRows) ? bizRows[0] : null;
    if (!["active", "trialing"].includes(String(biz?.stripe_subscription_status || "").toLowerCase())) {
      return json({ error: "Your subscription isn't active, so texting is paused.", code: "billing_inactive" }, 403);
    }
    if (!["growth", "scale"].includes(String(biz?.plan || "").toLowerCase())) {
      return json({ error: "Customer texting is included on the Growth and Scale plans.", code: "sms_not_in_plan" }, 403);
    }

    if (!smsWindowOpen(String(biz?.state || ""))) {
      return json({
        error: "Texts to customers can only go out between 9am and 8pm your local time (from noon on Sundays). Try again then.",
        code: "sms_quiet_hours",
      }, 409);
    }

    const messagingServiceSid = await businessMessagingService(supabaseUrl, serviceRoleKey, user.id);
    if (!messagingServiceSid) {
      return json({
        error: "Texting isn't active for your business yet. It turns on once your business's carrier registration is approved - start it in Settings > Customer texting.",
        code: "sms_not_registered",
      }, 409);
    }

    const message = body.message.trim().slice(0, 1500);
    const segments = smsSegments(message);
    if (segments > MAX_SEGMENTS) {
      return json({
        error: `That text would go out as ${segments} message parts; keep it to ${MAX_SEGMENTS} or fewer (about ${MAX_SEGMENTS * 153} plain characters, or ${MAX_SEGMENTS * 67} with emoji).`,
        code: "message_too_long",
      }, 400);
    }

    let limit = await underLimit(supabaseUrl, serviceRoleKey, `sms:manual:biz:${user.id}`, 86400, MANUAL_PER_BUSINESS_PER_DAY);
    if (limit === "ok") limit = await underLimit(supabaseUrl, serviceRoleKey, `sms:manual:cust:${customer.id}`, 86400, MANUAL_PER_CUSTOMER_PER_DAY);
    if (limit === "unavailable") {
      return json({ error: "Texting is briefly unavailable. Please try again in a few minutes.", code: "rate_limit_unavailable" }, 503);
    }
    if (limit === "limited") {
      return json({ error: "Today's texting limit is reached. Try again tomorrow.", code: "rate_limited" }, 429);
    }

    // The plan's monthly allowance, counted on the server; past it, each text is paid for
    // from the wallet BEFORE it is sent. Any doubt (counter or ledger unreachable): no text.
    const allowance = PLAN_SMS_LIMITS[String(biz?.plan || "").toLowerCase()] ?? 0;
    let used = 0;
    try {
      used = Number(await supabaseRest(supabaseUrl, serviceRoleKey, "/rest/v1/rpc/clicktide_sms_usage", {
        method: "POST",
        body: JSON.stringify({ p_user: user.id }),
      })) || 0;
    } catch {
      return json({ error: "Texting is briefly unavailable. Please try again in a few minutes.", code: "usage_unavailable" }, 503);
    }
    let overageKey = "";
    if (used >= allowance) {
      overageKey = `manual:${customer.id}:sms:${crypto.randomUUID()}`;
      const charge = () => walletApply(supabaseUrl, serviceRoleKey, user.id, -SMS_OVERAGE_PRICE, "sms_overage", "SMS overage (plan limit reached)", overageKey);
      let debit;
      try {
        // A charge that timed out may have committed: the same key again returns
        // duplicate:true (already paid) instead of charging twice.
        debit = await charge().catch(() => charge());
      } catch {
        return json({ error: "Texting is briefly unavailable. Please try again in a few minutes.", code: "wallet_unavailable" }, 503);
      }
      if (!debit.ok) {
        return json({
          error: `This month's included texts are used up. Add funds to your wallet to keep texting ($${SMS_OVERAGE_PRICE.toFixed(2)} per text).`,
          code: "sms_budget",
        }, 402);
      }
    }
    const refundOverage = async () => {
      if (!overageKey) return;
      const refund = () => walletApply(supabaseUrl, serviceRoleKey, user.id, SMS_OVERAGE_PRICE, "sms_overage_refund", "Refund: SMS overage (text not sent)", `${overageKey}:refund`);
      await refund().catch(() => refund())
        .catch(() => globalThis.console?.error(`sms overage refund failed for ${overageKey}`));
    };

    const form = new URLSearchParams({
      To: toPhone,
      MessagingServiceSid: messagingServiceSid,
      Body: message,
    });

    let twilioResponse;
    try {
      twilioResponse = await fetchT(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      });
    } catch (e) {
      // No answer from Twilio: it may still have sent the text, so the charge stands
      // (no refund) and the owner is told to check before sending again.
      const why = e instanceof Error && e.name === "AbortError" ? "timeout" : "network error";
      await recordSms(supabaseUrl, serviceRoleKey, {
        user_id: user.id, campaign_id: null, customer_id: customer.id, to_phone: toPhone, body: message,
        status: "failed", provider: "twilio", error: `Twilio request failed (${why}); delivery unknown`,
      }).catch(() => {});
      return json({
        error: "We couldn't confirm whether the text went out. Check the conversation before sending it again.",
        code: "twilio_unconfirmed",
      }, 502);
    }

    const twilioData = await twilioResponse.json().catch(() => ({}));
    const logFields = {
      user_id: user.id,
      campaign_id: /^\d+$/.test(String(body.campaign_id ?? "")) ? Number(body.campaign_id) : null,
      customer_id: customer.id,
      to_phone: toPhone,
      body: message,
      status: twilioResponse.ok ? "sent" : "failed",
      provider: "twilio",
      provider_message_id: twilioData.sid || null,
      error: twilioResponse.ok ? null : (twilioData.message || "Twilio SMS failed"),
      sent_at: twilioResponse.ok ? new Date().toISOString() : null,
    };
    // The text has already gone (or failed) at this point; a logging problem
    // must not turn a delivered text into an error.
    const logged = await recordSms(supabaseUrl, serviceRoleKey, logFields).then(() => true).catch(() => false);

    if (!twilioResponse.ok) {
      await refundOverage();
      return json({ error: twilioData.message || "Twilio SMS failed", details: twilioData }, twilioResponse.status);
    }

    return json({ ok: true, id: twilioData.sid, status: twilioData.status || "sent", logged });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "SMS send failed" }, 500);
  }
});
