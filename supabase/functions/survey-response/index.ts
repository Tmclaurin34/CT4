// Clicktide inbound SMS handler (Twilio webhook).
// Point the Twilio phone number's "A message comes in" webhook here.
// Records survey ratings (1-5), updates customer satisfaction scores,
// alerts the business about unhappy replies, and honors STOP requests.
// A reply belongs to the business whose number / Messaging Service RECEIVED it
// (a2p_registrations), and is matched only against that business's customers —
// never across tenants. A number not linked to a business is ignored.
// SMS double opt-in (2026-11): a reply of exactly YES / Y / START confirms a pending
// check-in opt-in (clicktide_sms_optin_confirm: this business, this phone, asked within
// the last 7 days, no STOP since) and only then sets sms_consent=true, recording the
// YES's SID and time. It is never read as a survey rating and never becomes an owner
// alert; with no pending request it does nothing. Twilio's own opt-in handling answers
// the keyword, so no reply is sent from here. STOP handling is unchanged.

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const twilioAuthToken = Deno.env.get("TWILIO_AUTH_TOKEN") || "";

// Clicktide's own services (owner alerts), whatever the registry says.
const PLATFORM_MSIDS = ["MG4c1badf5712739590510f936bbd0bc1a", Deno.env.get("TWILIO_MESSAGING_SERVICE_SID") || ""].filter(Boolean);

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// TwiML response — Twilio texts `message` back to the customer when non-empty.
function twiml(message = "", status = 200) {
  const body = message ? `<Message>${escapeXml(message)}</Message>` : "";
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`,
    { status, headers: { "Content-Type": "text/xml" } },
  );
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

// Twilio signs webhooks: Base64(HMAC-SHA1(authToken, url + sortedKey1 + value1 + ...)).
async function validTwilioSignature(req: Request, params: Record<string, string>) {
  const signature = req.headers.get("x-twilio-signature") || "";
  if (!signature || !twilioAuthToken) return false;

  const incoming = new URL(req.url);
  const canonicalUrl = `${supabaseUrl}/functions/v1/survey-response${incoming.search}`;
  const payload = canonicalUrl + Object.keys(params).sort().map((k) => k + params[k]).join("");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(twilioAuthToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));

  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return mismatch === 0;
}

// The 10 digits of a US number, or "". Every filter below is built from these digits
// alone, so nothing in a webhook field can reach a query.
function usTen(value: string) {
  const digits = String(value || "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? ten : "";
}

// Dashboard text: angle brackets never belong in a reply shown to the owner.
function plainText(value: string) {
  return String(value || "").replace(/[<>]/g, "");
}

type Customer = {
  id: number;
  user_id: string;
  name?: string;
  satisfaction_score?: number;
};

// One business, or "" when no row (or more than one business) claims it: a SID or
// number shared by two businesses is a data error, and guessing would leak replies.
function soleUser(rows: Array<{ user_id?: string }>) {
  const ids = [...new Set((Array.isArray(rows) ? rows : []).map((r) => String(r.user_id || "")).filter(Boolean))];
  return ids.length === 1 ? ids[0] : "";
}

// The business that owns the Messaging Service / number the text was sent TO. Any
// registration status counts, so a STOP is still honored after a registration lapses.
async function receivingBusiness(msid: string, toTen: string) {
  if (/^MG[0-9a-f]{32}$/i.test(msid)) {
    const rows = await rest(
      `/rest/v1/a2p_registrations?messaging_service_sid=eq.${msid}&reg_type=neq.platform&user_id=not.is.null&select=user_id&limit=20`,
    ) as Array<{ user_id?: string }>;
    if (Array.isArray(rows) && rows.length) return soleUser(rows);
  }
  if (toTen) {
    // Stored numbers may be formatted ("+1 (516) 555-0100"): narrow by the last four
    // digits, then compare all ten.
    const rows = await rest(
      `/rest/v1/a2p_registrations?phone_number=like.*${toTen.slice(-4)}*&reg_type=neq.platform&user_id=not.is.null&select=user_id,phone_number&limit=200`,
    ) as Array<{ user_id?: string; phone_number?: string }>;
    return soleUser((Array.isArray(rows) ? rows : []).filter((r) => usTen(String(r.phone_number || "")) === toTen));
  }
  return "";
}

// Find who replied, inside that business only: the most recent text it sent to this
// phone (ties the reply to the campaign), else its customer with this phone.
async function findContext(userId: string, ten: string): Promise<{ customer: Customer | null; campaignId: number | null }> {
  const uid = encodeURIComponent(userId);
  const msgs = await rest(
    `/rest/v1/sms_messages?user_id=eq.${uid}&to_phone=eq.%2B1${ten}&status=eq.sent&order=created_at.desc&limit=1&select=customer_id,campaign_id`,
  ) as Array<{ customer_id?: number; campaign_id?: number }>;

  if (Array.isArray(msgs) && msgs[0]?.customer_id) {
    const rows = await rest(
      `/rest/v1/customers?id=eq.${Number(msgs[0].customer_id)}&user_id=eq.${uid}&select=id,user_id,name,satisfaction_score&limit=1`,
    ) as Customer[];
    if (rows[0]) return { customer: rows[0], campaignId: msgs[0].campaign_id || null };
  }

  const rows = await customersWithPhone(userId, ten);
  return { customer: rows[0] || null, campaignId: null };
}

// This business's customers whose phone is this number, however it was typed in
// ("(516) 555-0100", "516.555.0100", "+15165550100"): narrow by the last four digits,
// then compare all ten.
async function customersWithPhone(userId: string, ten: string): Promise<Customer[]> {
  const rows = await rest(
    `/rest/v1/customers?user_id=eq.${encodeURIComponent(userId)}&phone=like.*${ten.slice(-4)}*&select=id,user_id,name,satisfaction_score,phone&order=id.asc&limit=1000`,
  ) as Array<Customer & { phone?: string }>;
  return (Array.isArray(rows) ? rows : []).filter((c) => usTen(String(c.phone || "")) === ten);
}

// Revoking consent "by any reasonable means" (FCC): a standard keyword alone, Twilio's own
// opt-out flag, a reply that starts with STOP ("Stop texting me"), or a short reply that
// says stop/unsubscribe/opt out/revoke ("please stop"). CANCEL and END only count alone:
// "cancel my appointment" is not an opt-out.
// Opt-in keywords for the double opt-in, alone (trailing punctuation allowed): "Yes!",
// "y", "START". "Yes 5" or "yes, loved it" are not keywords (they go on to the rating).
function isOptInKeyword(body: string) {
  const t = body.trim().toLowerCase().replace(/[.!\s]+$/, "");
  return t === "yes" || t === "y" || t === "start";
}

function isOptOut(body: string, optOutType: string) {
  if (optOutType.toUpperCase() === "STOP") return true;
  const t = body.trim().toLowerCase().replace(/[.!?\s]+$/, "");
  if (/^(stop|stop all|stopall|unsubscribe|cancel|end|quit|revoke|opt[ -]?out)$/.test(t)) return true;
  // "I'll stop by Saturday" answers a win-back; it is not a request to stop texting.
  const stopWord = /\bstop\b(?!\s+(by|in|over|back)\b)/;
  if (/^stop\b/.test(t) && stopWord.test(t)) return true;
  return t.split(/\s+/).length <= 5 && (stopWord.test(t) || /\b(unsubscribe|revoke|opt[ -]?out|optout)\b/.test(t));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return twiml("", 405);
  if (!serviceRoleKey) return twiml("", 500);
  if (!twilioAuthToken) return twiml("", 500);

  let params: Record<string, string> = {};
  try {
    const form = await req.formData();
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") params[key] = value;
    }
  } catch {
    return twiml("", 400);
  }

  if (!(await validTwilioSignature(req, params))) {
    return twiml("", 403);
  }

  const fromTen = usTen(params.From || "");
  const body = (params.Body || "").trim();
  if (!fromTen || !body) return twiml();
  const fromPhone = `+1${fromTen}`;
  const toTen = usTen(params.To || "");
  const inMsid = String(params.MessagingServiceSid || "");

  // Replies on Clicktide's OWN line (the first-party owner-alerts campaign) are
  // not customer survey replies: a business owner answering "5" must never be
  // scored as some business's customer or texted a survey reply from this line.
  // STOP/HELP/START are handled by Twilio's opt-out management; stay silent here.
  if (PLATFORM_MSIDS.includes(inMsid)) return twiml();
  try {
    const plat = await rest(
      "/rest/v1/a2p_registrations?reg_type=eq.platform&select=messaging_service_sid,phone_number&limit=5",
    ) as Array<{ messaging_service_sid?: string; phone_number?: string }>;
    const isPlatformLine = (Array.isArray(plat) ? plat : []).some((p) =>
      (p.messaging_service_sid && p.messaging_service_sid === inMsid) ||
      (!!toTen && !!p.phone_number && usTen(p.phone_number) === toTen)
    );
    if (isPlatformLine) return twiml();
  } catch { /* the receiving-business lookup below never matches a platform row */ }

  try {
    const userId = await receivingBusiness(inMsid, toTen);
    if (!userId) return twiml(); // not a business's number — stay silent

    const { customer, campaignId } = await findContext(userId, fromTen);
    if (!customer) return twiml(); // not this business's customer — stay silent

    // Log the inbound message.
    await rest("/rest/v1/sms_messages", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: userId,
        campaign_id: campaignId,
        customer_id: customer.id,
        to_phone: fromPhone,
        body: body.slice(0, 1500),
        status: "received",
        provider: "twilio",
        provider_message_id: params.MessageSid || null,
        sent_at: new Date().toISOString(),
      }),
    }).catch(() => {});

    // STOP (Twilio also blocks at carrier level; we record it) ends every text from this
    // business — marketing and service — on every one of its rows for this phone.
    if (isOptOut(body, String(params.OptOutType || ""))) {
      const ids = [...new Set([customer.id, ...(await customersWithPhone(userId, fromTen)).map((c) => c.id)])];
      await rest(`/rest/v1/customers?user_id=eq.${encodeURIComponent(userId)}&id=in.(${ids.map((id) => Number(id)).join(",")})`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ sms_unsubscribed_at: new Date().toISOString(), sms_consent: false, sms_service_consent: false }),
      });
      return twiml();
    }

    // Double opt-in YES: handled here and nowhere else — never a rating, never an alert.
    if (isOptInKeyword(body)) {
      try {
        const r = await rest("/rest/v1/rpc/clicktide_sms_optin_confirm", {
          method: "POST",
          body: JSON.stringify({ p_user: userId, p_phone: fromPhone, p_yes_sid: params.MessageSid || null, p_yes_body: body.slice(0, 160) }),
        }) as { confirmed?: boolean; reason?: string };
        if (!r?.confirmed && r?.reason !== "no_pending") globalThis.console?.warn("opt-in YES not applied:", r?.reason);
      } catch (e) {
        globalThis.console?.error("opt-in confirm failed:", e);
      }
      return twiml();
    }

    // Survey rating: first standalone 1-5 in the reply.
    const ratingMatch = body.match(/\b([1-5])\b/);
    if (!ratingMatch) {
      // Plain reply — surface it to the business as an alert.
      await rest("/rest/v1/alerts", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          user_id: userId,
          customer_id: customer.id,
          type: "sms_reply",
          message: plainText(`${customer.name || "A customer"} replied: "${body.slice(0, 300)}"`),
          resolved: false,
        }),
      }).catch(() => {});
      return twiml();
    }

    const rating = parseInt(ratingMatch[1], 10);
    const previous = customer.satisfaction_score || null;

    await rest(`/rest/v1/customers?id=eq.${customer.id}&user_id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        prev_satisfaction_score: previous,
        satisfaction_score: rating,
        last_survey_at: new Date().toISOString(),
      }),
    });

    await rest("/rest/v1/survey_responses", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: userId,
        customer_id: customer.id,
        rating,
        previous_rating: previous,
      }),
    }).catch(() => {});

    if (rating <= 2) {
      await rest("/rest/v1/alerts", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          user_id: userId,
          customer_id: customer.id,
          type: "unhappy_customer",
          message: plainText(`${customer.name || "A customer"} rated their experience ${rating}/5. Gifts are paused for them — a personal follow-up works better.`),
          resolved: false,
        }),
      }).catch(() => {});
      return twiml("We're sorry we let you down. The owner will reach out to make it right.");
    }

    if (rating === 3) return twiml("Thanks for the honest feedback — we'll keep improving!");

    // Happy customer (4-5): thank them.
    return twiml("Thank you! We really appreciate you taking the time. \u{1F64F}");
  } catch (error) {
    globalThis.console?.error("survey-response error:", error);
    return twiml(); // never bounce errors back at customers
  }
});
