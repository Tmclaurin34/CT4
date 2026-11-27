// Public customer check-in (QR code flow) for businesses without a POS.
// GET  ?b=<user_id>            -> { business_name }   (for the check-in page header)
// POST { b, name, phone, consent } -> logs a visit, creating the customer if new.
// A 2-hour cooldown per customer prevents double scans from double-counting.
//
// SMS double opt-in (2026-11): the marketing box no longer sets sms_consent. It records
// a PENDING request with its evidence (IP, user agent, form version, time) through
// clicktide_sms_optin_request, and — when the business has an active texting
// registration of its own — sends ONE confirmation: "<Business>: Reply YES to get
// occasional texts from us. Msg & data rates may apply. Reply STOP to opt out." (at most
// one per phone per business per 24 hours). survey-response turns a YES within 7 days
// into sms_consent=true. The confirmation goes out immediately, whatever the hour: it
// answers the customer's own tap seconds earlier and carries no marketing (the same
// choice as owner-alerts' opt-in confirmation). Service-text consent is unchanged.
// The response keeps every field the live checkin.html reads; sms_confirmation is new
// and optional ("sent" | "not_sent", only when the marketing box was ticked).

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const twilioToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";

// Clicktide's own Messaging Services never carry a business's customer texts (same
// deny list as campaign-runner / survey-response; platform rows are added at send time).
const PLATFORM_MSIDS = ["MG4c1badf5712739590510f936bbd0bc1a", Deno.env.get("TWILIO_MESSAGING_SERVICE_SID") ?? ""].filter(Boolean);
// Public endpoint that can make a text go out: cap it per visitor and per business (on
// top of the per-phone 24-hour rule in the database). These caps fail CLOSED.
const OPTIN_PER_IP_PER_DAY = 10;
const OPTIN_PER_BUSINESS_PER_DAY = 300;
// Legacy pages send no form_version: the evidence says so instead of guessing.
const LEGACY_FORM_VERSION = "checkin.html:unversioned";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.message || data?.error || r.statusText);
  return data;
}

// US numbers only, returned as +1XXXXXXXXXX. The result is built from digits alone,
// so nothing the visitor typed can reach a database filter.
function normalizePhone(value: string) {
  const digits = String(value || "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : "";
}

function clientIp(req: Request) {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

// Fails open: check-in at the counter must keep working if the limiter is unreachable.
async function underLimit(bucket: string, windowSeconds: number, max: number) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_rate_limit_hit`, {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
    });
    if (!r.ok) return true;
    return (await r.json()) === true;
  } catch {
    return true;
  }
}

// The same limiter, failing CLOSED: used only to decide whether a text may go out.
async function underLimitStrict(bucket: string, windowSeconds: number, max: number) {
  try {
    const r = await fetchT(`${supabaseUrl}/rest/v1/rpc/clicktide_rate_limit_hit`, {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
    }, 5000);
    if (!r.ok) return false;
    return (await r.json()) === true;
  } catch {
    return false;
  }
}

function fetchT(url: string, init: RequestInit = {}, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// The page inserts first_name into HTML, so only plain characters go back.
function safeFirstName(name: string) {
  return String(name || "").trim().split(/\s+/)[0].replace(/[<>&"'`\\]/g, "").slice(0, 40);
}

// Obviously-fake / placeholder numbers that must never identify a customer
// (0000000000, 5555555555, 1234567890, area code 555, etc.). Without this guard
// every junk entry collapses into one fake "customer".
function isJunkPhone(phone: string) {
  const last10 = (phone || "").replace(/\D/g, "").slice(-10);
  if (last10.length < 10) return true;
  if (/^(\d)\1{9}$/.test(last10)) return true;
  if (last10 === "1234567890" || last10 === "0123456789" || last10 === "1234567891") return true;
  if (/^555/.test(last10)) return true;
  return false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function businessInfo(userId: string) {
  const rows = await rest(
    `/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}&select=business_name,plan,stripe_subscription_status&limit=1`,
  );
  if (!Array.isArray(rows) || !rows[0]) return null;
  return {
    // Owner-editable and shown on public pages that use innerHTML: never let it form a tag.
    name: String(rows[0].business_name || "this business").replace(/[<>]/g, ""),
    whiteLabel: String(rows[0].plan || "").toLowerCase() === "scale",
    // Customer texting is a Growth/Scale feature on an active subscription (as in
    // send-customer-sms and campaign-runner).
    canText: ["growth", "scale"].includes(String(rows[0].plan || "").toLowerCase()) &&
      ["active", "trialing"].includes(String(rows[0].stripe_subscription_status || "").toLowerCase()),
  };
}

// The business's OWN active texting registration, chosen exactly as send-customer-sms
// and campaign-runner choose it (user_id match, active, has a Messaging Service, never a
// reg_type='platform' row and never one of Clicktide's own service SIDs), or "".
async function ownMessagingService(userId: string): Promise<string> {
  const rows = await rest(
    `/rest/v1/a2p_registrations?sms_status=eq.active&messaging_service_sid=not.is.null&reg_type=neq.platform&user_id=eq.${encodeURIComponent(userId)}&select=messaging_service_sid&order=id.asc&limit=1`,
  ) as Array<{ messaging_service_sid?: string }>;
  const sid = Array.isArray(rows) && rows[0]?.messaging_service_sid ? String(rows[0].messaging_service_sid) : "";
  if (!/^MG[0-9a-f]{32}$/i.test(sid) || PLATFORM_MSIDS.includes(sid)) return "";
  const plat = await rest(
    "/rest/v1/a2p_registrations?reg_type=eq.platform&messaging_service_sid=not.is.null&select=messaging_service_sid&limit=20",
  ) as Array<{ messaging_service_sid?: string }>;
  if ((Array.isArray(plat) ? plat : []).some((p) => String(p.messaging_service_sid || "") === sid)) return "";
  return sid;
}

type OptInEvidence = { ip: string; user_agent: string; form_version: string; at: string; origin: string; fields: Record<string, unknown> };

// Double opt-in: record the pending request (always) and send the one confirmation text
// when allowed. Never throws, never blocks the check-in. "sent" also covers a phone
// already asked within the last 24 hours (the text it got still works).
async function requestMarketingOptIn(userId: string, info: { name: string; canText: boolean }, customerId: unknown, phone: string, ip: string, evidence: OptInEvidence): Promise<"sent" | "not_sent"> {
  try {
    let msid = "";
    if (info.canText && twilioSid && twilioToken) {
      msid = await ownMessagingService(userId).catch(() => "");
      if (msid && !((await underLimitStrict(`checkin:optin:ip:${ip}`, 86400, OPTIN_PER_IP_PER_DAY)) &&
        (await underLimitStrict(`checkin:optin:biz:${userId}`, 86400, OPTIN_PER_BUSINESS_PER_DAY)))) {
        msid = "";
        evidence.fields.capped = true;
      }
    }
    const decision = await rest("/rest/v1/rpc/clicktide_sms_optin_request", {
      method: "POST",
      body: JSON.stringify({ p_user: userId, p_customer: Number(customerId), p_phone: phone, p_evidence: evidence, p_can_send: !!msid }),
    }) as { ok?: boolean; send?: boolean; reason?: string; request_id?: number };
    if (!decision?.ok) return "not_sent";
    if (!decision.send) return decision.reason === "recently_asked" ? "sent" : "not_sent";

    const name = info.name.replace(/\s+/g, " ").trim().slice(0, 60) || "This business";
    const body = `${name}: Reply YES to get occasional texts from us. Msg & data rates may apply. Reply STOP to opt out.`;
    let status: "sent" | "failed" | "unconfirmed" = "failed";
    let sid = "";
    let error = "";
    try {
      const r = await fetchT(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${twilioSid}:${twilioToken}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: phone, MessagingServiceSid: msid, Body: body }),
      }, 10000);
      const d = await r.json().catch(() => ({}));
      if (r.ok && d?.sid) { status = "sent"; sid = String(d.sid); }
      else error = String(d?.message || `Twilio failed (${r.status})`).slice(0, 300);
    } catch (e) {
      // No answer: Twilio may still have sent it. Not retried (the 24-hour claim stands),
      // and a YES can still confirm it.
      status = "unconfirmed";
      error = `Twilio request failed (${e instanceof Error && e.name === "AbortError" ? "timeout" : "network error"}); delivery unknown`;
    }
    const at = new Date().toISOString();
    // The log row ties the customer's reply to this business (survey-response) and counts
    // toward the plan's included texts. Best-effort: the text has already gone.
    await rest("/rest/v1/sms_messages", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: userId, campaign_id: null, customer_id: Number(customerId), to_phone: phone, body,
        status: status === "sent" ? "sent" : "failed", provider: "twilio", provider_message_id: sid || null,
        error: status === "sent" ? null : error, sent_at: status === "sent" ? at : null,
      }),
    }).catch((e) => console.error("optin sms log failed", e));
    if (decision.request_id) {
      await rest(`/rest/v1/sms_consent_requests?id=eq.${Number(decision.request_id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ confirm_status: status, confirm_sid: sid || null, confirm_sent_at: status === "sent" ? at : null, confirm_error: error || null }),
      }).catch((e) => console.error("optin request update failed", e));
    }
    return status === "failed" ? "not_sent" : "sent";
  } catch (e) {
    console.error("optin request failed", e);
    return "not_sent";
  }
}

// Retention engine visit history: a counted check-in is a visit (same-day check-ins
// merge into one). Never blocks the check-in itself.
async function recordCheckinVisit(userId: string, customerId: unknown, at: string) {
  try {
    await rest("/rest/v1/rpc/clicktide_record_visit", {
      method: "POST",
      body: JSON.stringify({ p_user: userId, p_customer: Number(customerId), p_at: at, p_amount: 0, p_source: "checkin", p_txn_id: null }),
    });
  } catch (e) {
    console.error("record_visit (checkin) failed", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!serviceRoleKey) return json({ error: "Server is not configured" }, 500);

  const url = new URL(req.url);

  const ip = clientIp(req);

  if (req.method === "GET") {
    const b = url.searchParams.get("b") || "";
    if (!UUID.test(b)) return json({ error: "Invalid link" }, 400);
    if (!(await underLimit(`checkin:get:ip:${ip}`, 3600, 120))) return json({ error: "Too many requests — please try again shortly." }, 429);
    const info = await businessInfo(b);
    if (!info) return json({ error: "Business not found" }, 404);
    return json({ business_name: info.name, white_label: info.whiteLabel });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { b?: string; name?: string; phone?: string; consent?: boolean; consent_marketing?: boolean; consent_transactional?: boolean; form_version?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }

  const b = String(body.b || "");
  if (!UUID.test(b)) return json({ error: "Invalid link" }, 400);
  // One visitor can't flood a business's list; one business can't be flooded by many.
  if (!(await underLimit(`checkin:post:ip:${ip}`, 3600, 30)) || !(await underLimit(`checkin:post:biz:${b}`, 3600, 400))) {
    return json({ error: "Too many check-ins right now — please try again shortly." }, 429);
  }
  const info = await businessInfo(b);
  if (!info) return json({ error: "Business not found" }, 404);
  const bizName = info.name;

  const phone = normalizePhone(String(body.phone || ""));
  if (!phone || isJunkPhone(phone)) return json({ error: "Please enter a valid phone number" }, 400);
  // Names typed on this public page end up in the owner's dashboard; angle brackets
  // are never part of a real name and would only carry HTML.
  const name = String(body.name || "").replace(/[<>]/g, "").trim().slice(0, 80);
  // Marketing texts need the marketing box. Older pages only send `consent`.
  const marketing = typeof body.consent_marketing === "boolean" ? body.consent_marketing : body.consent === true;
  const service = body.consent_transactional === true;
  const digits = phone.slice(-10); // exactly 10 digits, validated above
  // Only echo back what the visitor typed — never the stored name, so a phone
  // number can't be used to look up who a business's customers are.
  const firstName = safeFirstName(name);
  const now = new Date().toISOString();
  // Evidence of the marketing opt-in request (what was submitted, from where, on which form).
  const formVersion = typeof body.form_version === "string" && /^[A-Za-z0-9._:\-]{1,60}$/.test(body.form_version)
    ? body.form_version : LEGACY_FORM_VERSION;
  function evidence(): OptInEvidence {
    return {
      ip,
      user_agent: String(req.headers.get("user-agent") || "").slice(0, 300),
      form_version: formVersion,
      at: now,
      origin: String(req.headers.get("origin") || req.headers.get("referer") || "").slice(0, 200),
      fields: {
        consent_marketing: typeof body.consent_marketing === "boolean" ? body.consent_marketing : null,
        consent: typeof body.consent === "boolean" ? body.consent : null,
        consent_transactional: body.consent_transactional === true,
      },
    };
  }

  try {
    const rows = await rest(
      `/rest/v1/customers?user_id=eq.${b}&or=(phone.eq.%2B1${digits},phone.like.*${digits})&select=id,visits,last_visit_at,sms_consent,sms_service_consent&limit=1`,
    );
    const existing = Array.isArray(rows) ? rows[0] : null;

    if (existing) {
      // Double-scan guard: one visit per 2 hours.
      const last = existing.last_visit_at ? Date.parse(existing.last_visit_at) : 0;
      if (last && Date.now() - last < 2 * 60 * 60 * 1000) {
        return json({ ok: true, already: true, first_name: firstName, business_name: bizName });
      }
      const fields: Record<string, unknown> = {
        visits: (Number(existing.visits) || 0) + 1,
        last_visit_at: now,
      };
      // Marketing consent is NOT set here (double opt-in): see requestMarketingOptIn.
      const askOptIn = marketing && !existing.sms_consent;
      if (service && !existing.sms_service_consent) {
        fields.sms_service_consent = true;
        fields.sms_service_consent_at = now;
      }
      await rest(`/rest/v1/customers?id=eq.${encodeURIComponent(String(existing.id))}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(fields),
      });
      await recordCheckinVisit(b, existing.id, now);
      if (askOptIn) {
        const sms_confirmation = await requestMarketingOptIn(b, info, existing.id, phone, ip, evidence());
        return json({ ok: true, first_name: firstName, business_name: bizName, sms_confirmation });
      }
      return json({ ok: true, first_name: firstName, business_name: bizName });
    }

    if (!name) return json({ error: "first_visit_needs_name" }, 422);
    const created = await rest("/rest/v1/customers?select=id", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: b,
        name,
        phone,
        visits: 1,
        total_spent: 0,
        status: "active",
        last_visit_at: now,
        sms_consent: false, // double opt-in: only a YES reply sets it
        sms_consent_at: null,
        sms_service_consent: service,
        sms_service_consent_at: service ? now : null,
      }),
    });
    const newId = Array.isArray(created) ? created[0]?.id : null;
    if (newId) await recordCheckinVisit(b, newId, now);
    if (marketing && newId) {
      const sms_confirmation = await requestMarketingOptIn(b, info, newId, phone, ip, evidence());
      return json({ ok: true, created: true, first_name: firstName, business_name: bizName, sms_confirmation });
    }
    return json({ ok: true, created: true, first_name: firstName, business_name: bizName });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("PLAN_CUSTOMER_LIMIT_REACHED")) {
      rest("/rest/v1/alerts", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          user_id: b,
          type: "plan_limit",
          message: "A new customer tried to check in, but your plan's customer limit is reached. Upgrade to keep growing your list.",
          resolved: false,
        }),
      }).catch(() => {});
      return json({ error: "This business's customer list is full right now — let them know you stopped by!" }, 403);
    }
    console.error("checkin error:", e);
    return json({ error: "Check-in failed — please try again" }, 500);
  }
});
