// Clicktide inbound SMS handler (Twilio webhook).
// Point the Twilio phone number's "A message comes in" webhook here.
// Records survey ratings (1-5), updates customer satisfaction scores,
// alerts the business about unhappy replies, and honors STOP requests.

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const twilioAuthToken = Deno.env.get("TWILIO_AUTH_TOKEN") || "";

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

function normalizePhone(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return trimmed;
}

type Customer = {
  id: number;
  user_id: string;
  name?: string;
  satisfaction_score?: number;
};

// Find who replied: prefer the most recent outbound SMS to this phone (ties the
// reply to the right business and campaign), fall back to a phone match.
async function findContext(phone: string): Promise<{ customer: Customer | null; campaignId: number | null }> {
  const msgs = await rest(
    `/rest/v1/sms_messages?to_phone=eq.${encodeURIComponent(phone)}&order=created_at.desc&limit=1&select=customer_id,campaign_id`,
  ) as Array<{ customer_id?: number; campaign_id?: number }>;

  if (Array.isArray(msgs) && msgs[0]?.customer_id) {
    const rows = await rest(
      `/rest/v1/customers?id=eq.${msgs[0].customer_id}&select=id,user_id,name,satisfaction_score&limit=1`,
    ) as Customer[];
    if (rows[0]) return { customer: rows[0], campaignId: msgs[0].campaign_id || null };
  }

  const digits = phone.replace(/\D/g, "").slice(-10);
  const rows = await rest(
    `/rest/v1/customers?or=(phone.eq.${encodeURIComponent(phone)},phone.like.*${digits})&select=id,user_id,name,satisfaction_score&limit=1`,
  ) as Customer[];
  return { customer: rows[0] || null, campaignId: null };
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

  const fromPhone = normalizePhone(params.From || "");
  const body = (params.Body || "").trim();
  if (!fromPhone || !body) return twiml();

  // Replies on Clicktide's OWN line (the first-party owner-alerts campaign) are
  // not customer survey replies: a business owner answering "5" must never be
  // scored as some business's customer or texted a survey reply from this line.
  // STOP/HELP/START are handled by Twilio's opt-out management; stay silent here.
  try {
    const plat = await rest(
      "/rest/v1/a2p_registrations?reg_type=eq.platform&select=messaging_service_sid,phone_number&limit=5",
    ) as Array<{ messaging_service_sid?: string; phone_number?: string }>;
    const toPhone = normalizePhone(params.To || "");
    const inMsid = String(params.MessagingServiceSid || "");
    const isPlatformLine = (Array.isArray(plat) ? plat : []).some((p) =>
      (p.messaging_service_sid && p.messaging_service_sid === inMsid) ||
      (p.phone_number && normalizePhone(p.phone_number) === toPhone)
    );
    if (isPlatformLine) return twiml();
  } catch { /* if the lookup fails, fall through — signature already verified */ }

  try {
    const { customer, campaignId } = await findContext(fromPhone);
    if (!customer) return twiml(); // unknown number — stay silent

    // Log the inbound message.
    await rest("/rest/v1/sms_messages", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: customer.user_id,
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

    // STOP handling (Twilio also blocks at carrier level; we record it).
    if (/^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i.test(body)) {
      await rest(`/rest/v1/customers?id=eq.${customer.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ sms_unsubscribed_at: new Date().toISOString(), sms_consent: false }),
      });
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
          user_id: customer.user_id,
          customer_id: customer.id,
          type: "sms_reply",
          message: `${customer.name || "A customer"} replied: "${body.slice(0, 300)}"`,
          resolved: false,
        }),
      }).catch(() => {});
      return twiml();
    }

    const rating = parseInt(ratingMatch[1], 10);
    const previous = customer.satisfaction_score || null;

    await rest(`/rest/v1/customers?id=eq.${customer.id}`, {
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
        user_id: customer.user_id,
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
          user_id: customer.user_id,
          customer_id: customer.id,
          type: "unhappy_customer",
          message: `${customer.name || "A customer"} rated their experience ${rating}/5. Gifts are paused for them — a personal follow-up works better.`,
          resolved: false,
        }),
      }).catch(() => {});
      return twiml("We're sorry we let you down. The owner will reach out to make it right.");
    }

    if (rating === 3) return twiml("Thanks for the honest feedback — we'll keep improving!");

    // Happy customer (4-5): thank them.
    return twiml("Thank you! We really appreciate you taking the time. \u{1F64F}");
  } catch (error) {
    console.error("survey-response error:", error);
    return twiml(); // never bounce errors back at customers
  }
});
