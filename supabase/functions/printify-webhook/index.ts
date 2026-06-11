// Printify webhook: keeps shipments in sync AND turns tracking events into
// touchpoints — "shipped" emails the customer a branded gift-on-the-way note
// with the tracking link; "delivered" alerts the owner to follow up personally.
// Deployed v7 2026-06-11; mirrors live source.

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const webhookSecret = Deno.env.get("PRINTIFY_WEBHOOK_SECRET") || "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL") || "Clicktide <support@goclicktide.com>";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const t = await r.text();
  const data = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(data?.message || data?.error || r.statusText);
  return data;
}

function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Printify signs webhooks with HMAC SHA-256: header "X-Pfy-Signature: sha256=<hex>"
async function verifySignature(rawBody: string, header: string) {
  if (!webhookSecret) throw new Error("PRINTIFY_WEBHOOK_SECRET is not configured");
  const signature = header.replace(/^sha256=/, "");
  if (!signature) throw new Error("Missing Printify signature");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  if (!safeEqual(hex(digest), signature)) throw new Error("Invalid Printify signature");
}

const STATUS_MAP: Record<string, string> = {
  "order:sent-to-production": "in_production",
  "order:shipment:created": "shipped",
  "order:shipment:delivered": "delivered",
  "order:canceled": "canceled",
};

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function trackingUrl(carrier: string, num: string) {
  const c = carrier.toLowerCase();
  if (c.includes("usps")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(num)}`;
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${encodeURIComponent(num)}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(num)}`;
  if (c.includes("dhl")) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${encodeURIComponent(num)}`;
  return "";
}

function brandedShell(businessName: string, inner: string, whiteLabel: boolean, logoUrl = "", brandColor = "#0B62D6") {
  const header = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="" width="56" style="max-height:56px;display:inline-block;vertical-align:middle"/><div style="font-size:15px;font-weight:bold;color:#111827;margin-top:6px">${escapeHtml(businessName)}</div>`
    : `<div style="font-size:23px;font-weight:bold;color:${escapeHtml(brandColor)}">${escapeHtml(businessName)}</div>`;
  return `<div style="background:#F4F5F7;padding:26px 12px;font-family:Arial,Helvetica,sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border-radius:14px;border:1px solid #E9EBEF">
      <tr><td align="center" style="padding:26px 30px 20px;border-bottom:1px solid #F0F1F4">${header}</td></tr>
      <tr><td style="padding:26px 30px;color:#1F2937;font-size:15px;line-height:1.7">${inner}</td></tr>
      <tr><td align="center" style="padding:16px 30px 22px;border-top:1px solid #F0F1F4;font-size:11px;color:#9CA3AF">${whiteLabel ? escapeHtml(businessName) : `Sent by Clicktide on behalf of ${escapeHtml(businessName)} · goclicktide.com`}</td></tr>
    </table></td></tr></table></div>`;
}

async function updateShipment(orderId: string, fields: Record<string, unknown>) {
  const rows = await rest(`/rest/v1/shipments?printify_order_id=eq.${encodeURIComponent(orderId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(fields),
  });
  return Array.isArray(rows) ? rows : [];
}

type ShipRow = { id: number; user_id?: string; customer_id?: number; customer_name?: string; customer_email?: string; gift?: string };

async function bizFor(userId: string) {
  try {
    const rows = await rest(`/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}&select=business_name,logo_url,plan&limit=1`);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}

async function sendGiftOnTheWay(ship: ShipRow, carrier: string, num: string) {
  if (!resendApiKey || !ship.customer_email || !ship.user_id) return;
  const biz = await bizFor(ship.user_id);
  const businessName = String(biz?.business_name || "A business you visit");
  const whiteLabel = String(biz?.plan || "").toLowerCase() === "scale";
  const first = escapeHtml((ship.customer_name || "there").trim().split(/\s+/)[0]);
  const url = trackingUrl(carrier, num);
  const trackBlock = url
    ? `<div style="text-align:center;margin:22px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#0B62D6;color:#FFFFFF;font-weight:bold;font-size:15px;text-decoration:none;padding:13px 32px;border-radius:10px">Track your gift →</a></div><p style="margin:0;font-size:12px;color:#6B7280;text-align:center">${escapeHtml(carrier)} · ${escapeHtml(num)}</p>`
    : `<p style="margin:14px 0 0;font-size:13px;color:#374151;text-align:center"><b>Tracking:</b> ${escapeHtml(carrier ? carrier + " · " : "")}${escapeHtml(num)}</p>`;
  const inner = `<p style="margin:0 0 14px">Hi ${first},</p>
    <p style="margin:0 0 6px">Good news — your gift from ${escapeHtml(businessName)} is <b>on its way</b> \u{1F381}</p>
    <p style="margin:0;color:#6B7280;font-size:14px">${escapeHtml(ship.gift || "A little something")}, headed to your mailbox.</p>
    ${trackBlock}`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: resendFrom,
      to: [ship.customer_email],
      subject: `Your gift from ${businessName} is on the way \u{1F381}`,
      html: brandedShell(businessName, inner, whiteLabel, String(biz?.logo_url || "")),
    }),
  }).catch(() => {});
}

async function alertDelivered(ship: ShipRow) {
  if (!ship.user_id) return;
  await rest("/rest/v1/alerts", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: ship.user_id,
      customer_id: ship.customer_id || null,
      type: "gift_delivered",
      message: `\u{1F381} ${ship.customer_name || "A customer"}'s gift (${ship.gift || "gift"}) was delivered today — a perfect moment for a quick personal text or call.`,
      resolved: false,
    }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey) return json({ error: "Server secrets are not configured" }, 500);

  const rawBody = await req.text();
  try {
    await verifySignature(rawBody, req.headers.get("x-pfy-signature") || "");

    const event = JSON.parse(rawBody) as {
      type?: string;
      resource?: { id?: string | number; data?: Record<string, unknown> };
    };

    const eventType = String(event.type || "");
    const orderId = event.resource?.id ? String(event.resource.id) : "";
    const status = STATUS_MAP[eventType];

    if (!orderId || !status) return json({ received: true, ignored: true });

    const fields: Record<string, unknown> = { status };
    const data = event.resource?.data || {};
    const trackingNumber = String(data.tracking_number || data.number || "");
    const carrier = String(data.carrier || "");
    if (trackingNumber) {
      fields.tracking = carrier ? `${carrier}: ${trackingNumber}` : trackingNumber;
    }

    const rows = await updateShipment(orderId, fields) as ShipRow[];

    // Tracking events become touchpoints.
    if (status === "shipped" && trackingNumber) {
      for (const ship of rows) await sendGiftOnTheWay(ship, carrier, trackingNumber);
    }
    if (status === "delivered") {
      for (const ship of rows) await alertDelivered(ship);
    }

    return json({ received: true, updated: rows.length });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Webhook failed" }, 400);
  }
});
