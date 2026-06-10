// Resend webhook receiver — powers the ROI story.
// Receives email.sent/delivered/opened/clicked/bounced/complained events,
// verifies the Svix signature, attributes each event to the business,
// campaign, and customer via campaign_sends (which stores the Resend
// email id in `detail`), and records it in message_events.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const webhookSecret = Deno.env.get("RESEND_WEBHOOK_SECRET") ?? "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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
  return { ok: response.ok, status: response.status, data: text ? JSON.parse(text) : null };
}

// Svix signature: HMAC-SHA256 over `${id}.${timestamp}.${body}` keyed with
// the base64-decoded secret (whsec_ prefix stripped), compared in base64.
async function validSignature(req: Request, rawBody: string) {
  const id = req.headers.get("svix-id") || "";
  const timestamp = req.headers.get("svix-timestamp") || "";
  const signatures = req.headers.get("svix-signature") || "";
  if (!id || !timestamp || !signatures || !webhookSecret) return false;

  // Reject stale deliveries (5 minute tolerance).
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const secretB64 = webhookSecret.replace(/^whsec_/, "");
  const secretBytes = Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));

  return signatures.split(" ").some((part) => {
    const sig = part.includes(",") ? part.split(",")[1] : part;
    if (!sig || sig.length !== expected.length) return false;
    let mismatch = 0;
    for (let i = 0; i < sig.length; i++) mismatch |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return mismatch === 0;
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey) return json({ error: "Server secrets are not configured" }, 500);
  if (!webhookSecret) return json({ error: "RESEND_WEBHOOK_SECRET is not configured" }, 500);

  const rawBody = await req.text();
  if (!(await validSignature(req, rawBody))) return json({ error: "Invalid signature" }, 401);

  let event: { type?: string; created_at?: string; data?: { email_id?: string } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const type = String(event.type || "");
  const emailId = String(event.data?.email_id || "");
  if (!type.startsWith("email.") || !emailId) return json({ received: true, ignored: true });

  // Attribute to business/campaign/customer via the send record.
  const { data: sends } = await rest(
    `/rest/v1/campaign_sends?channel=eq.email&detail=eq.${encodeURIComponent(emailId)}&select=user_id,campaign_id,customer_id&limit=1`,
  );
  const send = Array.isArray(sends) ? sends[0] : null;
  if (!send) return json({ received: true, unattributed: true });

  const insert = await rest("/rest/v1/message_events?on_conflict=provider_message_id,event_type", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({
      provider: "resend",
      provider_message_id: emailId,
      event_type: type,
      user_id: send.user_id,
      campaign_id: send.campaign_id,
      customer_id: send.customer_id,
      occurred_at: event.created_at || new Date().toISOString(),
      raw: event,
    }),
  });

  if (!insert.ok && insert.status !== 409) {
    console.error("message_events insert failed:", insert.status, JSON.stringify(insert.data));
    return json({ error: "Could not record event" }, 500);
  }
  return json({ received: true });
});
