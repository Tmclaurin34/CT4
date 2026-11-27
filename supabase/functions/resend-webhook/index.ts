// Resend webhook receiver — powers the ROI story.
// Receives email.sent/delivered/opened/clicked/bounced/complained events,
// verifies the Svix signature, attributes each event to the business,
// campaign, and customer via campaign_sends (which stores the Resend
// email id in `detail`), and records it in message_events.
// A spam complaint or a hard bounce also puts the address on that business's
// email_suppressions list (contract C2), so no sender emails it again. One-off
// sends have no campaign_sends row; they carry a ct_biz tag naming the business.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const webhookSecret = Deno.env.get("RESEND_WEBHOOK_SECRET") ?? "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Tags = Record<string, string> | Array<{ name?: string; value?: string }>;

type ResendEvent = {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    tags?: Tags;
    bounce?: { type?: string };
  };
};

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

// Resend sends tags as {name: value}; accept the [{name, value}] form too.
function tagValue(tags: Tags | undefined, name: string): string {
  if (!tags || typeof tags !== "object") return "";
  if (Array.isArray(tags)) return String(tags.find((t) => t?.name === name)?.value || "");
  return String(tags[name] || "");
}

function recipients(to: string[] | string | undefined): string[] {
  const list = Array.isArray(to) ? to : to ? [to] : [];
  return list
    .map((a) => String(a || "").trim())
    .map((a) => (/<([^>]+)>/.exec(a)?.[1] || a).trim().toLowerCase())
    .filter((a) => a.includes("@"));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey) return json({ error: "Server secrets are not configured" }, 500);
  if (!webhookSecret) return json({ error: "RESEND_WEBHOOK_SECRET is not configured" }, 500);

  const rawBody = await req.text();
  if (!(await validSignature(req, rawBody))) return json({ error: "Invalid signature" }, 401);

  let event: ResendEvent;
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

  // Resend's email.bounced is a permanent rejection; only skip one it marks transient.
  const bounceType = String(event.data?.bounce?.type || "").toLowerCase();
  const reason = type === "email.complained"
    ? "complaint"
    : type === "email.bounced" && (bounceType === "" || bounceType === "permanent")
    ? "bounce"
    : "";
  if (reason) {
    const tagBiz = tagValue(event.data?.tags, "ct_biz");
    const business = String(send?.user_id || (UUID.test(tagBiz) ? tagBiz : ""));
    let addresses = recipients(event.data?.to);
    if (!addresses.length && send?.customer_id) {
      const { data: rows } = await rest(`/rest/v1/customers?id=eq.${encodeURIComponent(String(send.customer_id))}&select=email&limit=1`);
      addresses = recipients(Array.isArray(rows) && rows[0]?.email ? String(rows[0].email) : undefined);
    }
    if (business) {
      for (const address of addresses) {
        const r = await rest("/rest/v1/rpc/clicktide_email_optout", {
          method: "POST",
          body: JSON.stringify({ p_user: business, p_email: address, p_reason: reason }),
        });
        if (!r.ok) {
          console.error("email suppression failed:", r.status, JSON.stringify(r.data));
          return json({ error: "Could not record suppression" }, 500);
        }
      }
    } else {
      console.error(`resend-webhook: ${type} for ${emailId} could not be attributed to a business; not suppressed`);
    }
  }

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
