// Printify webhook: keeps shipments in sync AND turns tracking events into
// touchpoints — "shipped" emails the customer a branded gift-on-the-way note
// with the tracking link; "delivered" alerts the owner to follow up personally;
// "canceled" returns the gift's cost to the business's gift wallet.
//
// Every event must carry a valid X-Pfy-Signature. A shipment only ever moves
// forward (processing -> in_production -> shipped -> delivered, or -> canceled), and
// emails, alerts and refunds happen only on the transition itself, so redelivered
// or late events are harmless.

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const webhookSecret = Deno.env.get("PRINTIFY_WEBHOOK_SECRET") || "";
const printifyShopId = Deno.env.get("PRINTIFY_SHOP_ID") || "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
const unsubSecret = Deno.env.get("EMAIL_UNSUB_SECRET") || "";
const EMAIL_FROM_DOMAIN = "support@goclicktide.com"; // verified Resend sender; display name is the business
// Clicktide's own postal address, shown when the business has no complete address on file.
// No hardcoded fallback: when it is unset too, the address line is left out (a shipping
// notice is transactional, so it is still sent).
const CLICKTIDE_POSTAL_ADDRESS = (Deno.env.get("CLICKTIDE_POSTAL_ADDRESS") || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
const EMAIL_RE = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/;
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Events older than this still update state and refunds, but no longer email or alert anyone.
const TOUCH_MAX_AGE_MS = 7 * 86400000;

// Customer-facing "From" shows the BUSINESS name (recipients recognize their shop, not "Clicktide").
function bizFrom(name: string): string {
  const clean = (name || "Clicktide").replace(/[<>"\r\n,;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Clicktide";
  return `${clean} <${EMAIL_FROM_DOMAIN}>`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseJson(text: string) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const data = parseJson(await r.text());
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

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

// Printify signs webhooks with HMAC SHA-256: header "X-Pfy-Signature: sha256=<hex>"
async function validSignature(rawBody: string, header: string) {
  const signature = header.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!signature) return false;
  return safeEqual(await hmacHex(webhookSecret, rawBody), signature);
}

const EVENT_STATUS: Record<string, string> = {
  "order:sent-to-production": "in_production",
  "order:shipment:created": "shipped",
  "order:shipment:delivered": "delivered",
  "order:canceled": "canceled",
};
// order:updated carries the new order status in data.status.
const UPDATED_STATUS: Record<string, string> = {
  "canceled": "canceled",
  "cancelled": "canceled",
  "in-production": "in_production",
};
// The statuses a shipment may move FROM to reach each target.
const EARLIER: Record<string, string[]> = {
  in_production: ["processing"],
  shipped: ["processing", "in_production"],
  delivered: ["processing", "in_production", "shipped"],
  canceled: ["processing", "in_production"],
};

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function plain(value: unknown, max: number) {
  return String(value ?? "").replace(/[<>]/g, "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

function dollars(value: unknown) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

function trackingUrl(carrier: string, num: string) {
  const c = carrier.toLowerCase();
  if (c.includes("usps")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(num)}`;
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${encodeURIComponent(num)}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(num)}`;
  if (c.includes("dhl")) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${encodeURIComponent(num)}`;
  return "";
}

// Printify sends the carrier either as an object {code, tracking_number, tracking_url}
// or as flat fields; accept both.
function trackingFrom(data: Record<string, unknown>) {
  const raw = data.carrier;
  const obj: Record<string, unknown> = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const carrier = plain(typeof raw === "string" ? raw : (obj.code || obj.name || ""), 40);
  const number = plain(obj.tracking_number || obj.number || data.tracking_number || data.number || "", 80);
  const link = String(obj.tracking_url || obj.url || data.tracking_url || "");
  const url = trackingUrl(carrier, number) || (/^https:\/\/[^\s"'<>]+$/.test(link) ? link : "");
  return { carrier, number, url };
}

type Biz = {
  business_name?: string | null;
  logo_url?: string | null;
  plan?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
};

// CAN-SPAM postal address: the business's own when complete, otherwise Clicktide's,
// worded so it is not presented as the business's address; "" when neither is known.
function footerAddress(businessName: string, biz: Biz | null) {
  const street = plain(biz?.address, 120);
  const city = plain(biz?.city, 60);
  const state = plain(biz?.state, 20);
  const zip = plain(biz?.zip, 12);
  if (street && city && state && zip) return `${escapeHtml(businessName)}, ${escapeHtml(`${street}, ${city}, ${state} ${zip}`)}`;
  if (CLICKTIDE_POSTAL_ADDRESS) return `Sent on behalf of ${escapeHtml(businessName)} by Clicktide, ${escapeHtml(CLICKTIDE_POSTAL_ADDRESS)}`;
  console.warn("printify-webhook: no complete business address and CLICKTIDE_POSTAL_ADDRESS is not set; the gift-on-the-way notice goes out without a postal address line");
  return "";
}

function brandedShell(businessName: string, inner: string, whiteLabel: boolean, footer: string, unsubUrl: string, logoUrl = "", brandColor = "#0B62D6") {
  const header = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="" width="56" style="max-height:56px;display:inline-block;vertical-align:middle"/><div style="font-size:15px;font-weight:bold;color:#111827;margin-top:6px">${escapeHtml(businessName)}</div>`
    : `<div style="font-size:23px;font-weight:bold;color:${escapeHtml(brandColor)}">${escapeHtml(businessName)}</div>`;
  const unsub = `<a href="${escapeHtml(unsubUrl)}" style="color:#9CA3AF;text-decoration:underline">Unsubscribe</a>`;
  return `<div style="background:#F4F5F7;padding:26px 12px;font-family:Arial,Helvetica,sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border-radius:14px;border:1px solid #E9EBEF">
      <tr><td align="center" style="padding:26px 30px 20px;border-bottom:1px solid #F0F1F4">${header}</td></tr>
      <tr><td style="padding:26px 30px;color:#1F2937;font-size:15px;line-height:1.7">${inner}</td></tr>
      <tr><td align="center" style="padding:16px 30px 22px;border-top:1px solid #F0F1F4;font-size:11px;color:#9CA3AF;line-height:1.7">You're receiving this because ${escapeHtml(businessName)} sent you a gift.<br>${[unsub, whiteLabel ? "" : "Sent via Clicktide", footer].filter(Boolean).join(" &middot; ")}</td></tr>
    </table></td></tr></table></div>`;
}

type ShipRow = {
  id: number;
  user_id?: string;
  customer_id?: number;
  customer_name?: string;
  customer_email?: string;
  gift?: string;
  campaign?: string | null;
  wallet_debit_key?: string | null;
  wallet_debit_amount?: number | string | null;
};

function shipmentsFor(orderId: string) {
  return `/rest/v1/shipments?platform=eq.printify&printify_order_id=eq.${encodeURIComponent(orderId)}&user_id=not.is.null`;
}

// Moves this order's shipment to `target` only from an earlier status; returns the rows
// that actually changed (none for a repeated or out-of-order event).
async function transition(orderId: string, target: string, fields: Record<string, unknown>) {
  const from = EARLIER[target] || [];
  const rows = await rest(`${shipmentsFor(orderId)}&or=(status.is.null,status.in.(${from.join(",")}))`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ ...fields, status: target }),
  });
  return Array.isArray(rows) ? rows as ShipRow[] : [];
}

async function bizFor(userId: string): Promise<Biz | null> {
  try {
    const rows = await rest(`/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}&select=business_name,logo_url,plan,address,city,state,zip&limit=1`);
    return Array.isArray(rows) && rows[0] ? rows[0] as Biz : null;
  } catch {
    return null;
  }
}

// C1: one locked, idempotent ledger write per money movement.
async function walletApply(userId: string, delta: number, kind: string, description: string, reference: string | null, idempotencyKey: string) {
  const data = await rest("/rest/v1/rpc/clicktide_wallet_apply", {
    method: "POST",
    body: JSON.stringify({
      p_user: userId,
      p_delta: delta,
      p_kind: kind,
      p_description: description,
      p_reference: reference,
      p_idempotency_key: idempotencyKey,
    }),
  });
  if (!data || typeof data.ok !== "boolean") throw new Error("Unexpected wallet response");
  return data as { ok: boolean; balance?: number; duplicate?: boolean; reason?: string };
}

// C2 link: per business, signed over "<user_id>|<lowercased email>".
async function unsubUrlFor(userId: string, email: string) {
  const lower = email.trim().toLowerCase();
  const sig = await hmacHex(unsubSecret, `${userId}|${lower}`);
  return `${supabaseUrl}/functions/v1/email-unsubscribe?b=${encodeURIComponent(userId)}&e=${encodeURIComponent(lower)}&s=${sig}`;
}

// The address to email for this shipment, or "" when the customer can't be emailed:
// opted out of this business (suppression list or email_unsubscribed_at), or no valid
// address. Prefers the business's current customer record over the copy on the shipment.
async function recipientFor(ship: ShipRow) {
  const userId = String(ship.user_id || "");
  let email = "";
  if (ship.customer_id) {
    const rows = await rest(
      `/rest/v1/customers?id=eq.${Number(ship.customer_id)}&user_id=eq.${encodeURIComponent(userId)}&select=email,email_unsubscribed_at&limit=1`,
    );
    const customer = Array.isArray(rows) ? rows[0] : null;
    if (customer?.email_unsubscribed_at) return "";
    email = String(customer?.email || "");
  }
  email = (email || String(ship.customer_email || "")).trim();
  if (!EMAIL_RE.test(email) || email.length > 254) return "";
  const lower = email.toLowerCase();
  const [suppressed, optedOut] = await Promise.all([
    rest(`/rest/v1/email_suppressions?user_id=eq.${encodeURIComponent(userId)}&email_lower=eq.${encodeURIComponent(lower)}&select=user_id&limit=1`),
    rest(`/rest/v1/customers?user_id=eq.${encodeURIComponent(userId)}&email=in.${encodeURIComponent(`("${email}","${lower}")`)}&email_unsubscribed_at=not.is.null&select=id&limit=1`),
  ]);
  if ((Array.isArray(suppressed) && suppressed.length) || (Array.isArray(optedOut) && optedOut.length)) return "";
  return email;
}

async function sendGiftOnTheWay(ship: ShipRow, carrier: string, num: string, url: string) {
  if (!resendApiKey || !ship.user_id) return;
  if (!unsubSecret) {
    console.error("printify-webhook: EMAIL_UNSUB_SECRET is not set; the gift-on-the-way email was not sent");
    return;
  }
  let to = "";
  try {
    to = await recipientFor(ship);
  } catch (error) {
    // Fail closed: if opt-outs can't be checked, the email is not sent.
    console.error(`printify-webhook: opt-out check failed for shipment ${ship.id}; email not sent:`, error);
    return;
  }
  if (!to) return;
  const biz = await bizFor(ship.user_id);
  const businessName = plain(biz?.business_name, 80) || "A business you visit";
  const whiteLabel = String(biz?.plan || "").toLowerCase() === "scale";
  const first = escapeHtml((plain(ship.customer_name, 80) || "there").split(/\s+/)[0]);
  const unsubUrl = await unsubUrlFor(ship.user_id, to);
  const trackBlock = url
    ? `<div style="text-align:center;margin:22px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#0B62D6;color:#FFFFFF;font-weight:bold;font-size:15px;text-decoration:none;padding:13px 32px;border-radius:10px">Track your gift →</a></div><p style="margin:0;font-size:12px;color:#6B7280;text-align:center">${escapeHtml(carrier)} · ${escapeHtml(num)}</p>`
    : `<p style="margin:14px 0 0;font-size:13px;color:#374151;text-align:center"><b>Tracking:</b> ${escapeHtml(carrier ? carrier + " · " : "")}${escapeHtml(num)}</p>`;
  const inner = `<p style="margin:0 0 14px">Hi ${first},</p>
    <p style="margin:0 0 6px">Good news — your gift from ${escapeHtml(businessName)} is <b>on its way</b> \u{1F381}</p>
    <p style="margin:0;color:#6B7280;font-size:14px">${escapeHtml(plain(ship.gift, 120) || "A little something")}, headed to your mailbox.</p>
    ${trackBlock}`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: bizFrom(businessName),
      to: [to],
      subject: `Your gift from ${businessName} is on the way \u{1F381}`,
      html: brandedShell(businessName, inner, whiteLabel, footerAddress(businessName, biz), unsubUrl, String(biz?.logo_url || "")),
      headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }),
  }).catch((error) => console.error(`printify-webhook: gift-on-the-way email failed for shipment ${ship.id}:`, error));
}

async function ownerAlert(ship: ShipRow, type: string, message: string) {
  if (!ship.user_id) return;
  await rest("/rest/v1/alerts", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ user_id: ship.user_id, customer_id: ship.customer_id || null, type, message, resolved: false }),
  }).catch((error) => console.error(`printify-webhook: ${type} alert failed for shipment ${ship.id}:`, error));
}

// Returns the wallet debit of every canceled, not-yet-refunded shipment of this order.
// Idempotent (the refund key is derived from the debit key), so a retried event retries
// only what is still owed. Throws so Printify redelivers when a refund can't be written.
async function refundCanceled(orderId: string) {
  const rows = await rest(
    `${shipmentsFor(orderId)}&status=eq.canceled&wallet_refunded_at=is.null&wallet_debit_key=not.is.null&select=id,user_id,gift,campaign,wallet_debit_key,wallet_debit_amount`,
  );
  let refunded = 0;
  for (const ship of (Array.isArray(rows) ? rows : []) as ShipRow[]) {
    const amount = dollars(ship.wallet_debit_amount);
    if (!ship.user_id || amount <= 0) continue;
    const result = await walletApply(
      ship.user_id,
      amount,
      "gift_refund",
      `Gift wallet refund: ${plain(ship.gift, 80) || "gift"} canceled`,
      ship.campaign || null,
      `${ship.wallet_debit_key}:refund`,
    );
    if (!result.ok) throw new Error(`refund for shipment ${ship.id} refused: ${result.reason || "unknown"}`);
    await rest(`/rest/v1/shipments?id=eq.${Number(ship.id)}&wallet_refunded_at=is.null`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ wallet_refunded_at: new Date().toISOString() }),
    });
    refunded++;
  }
  return refunded;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey) return json({ error: "Server secrets are not configured" }, 500);
  if (!webhookSecret) {
    console.error("printify-webhook: PRINTIFY_WEBHOOK_SECRET is not set. Every event is rejected until the operator sets it and registers it with Printify.");
    return json({ error: "Webhook is not configured" }, 503);
  }

  const rawBody = await req.text();
  if (!(await validSignature(rawBody, req.headers.get("x-pfy-signature") || ""))) {
    return json({ error: "Invalid Printify signature" }, 400);
  }

  let event: {
    id?: string;
    type?: string;
    created_at?: string;
    resource?: { id?: string | number; type?: string; data?: Record<string, unknown> };
  };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  try {
    const eventType = String(event?.type || "");
    const orderId = event?.resource?.id ? String(event.resource.id) : "";
    const data = (event?.resource?.data && typeof event.resource.data === "object" ? event.resource.data : {}) as Record<string, unknown>;
    const status = eventType === "order:updated"
      ? UPDATED_STATUS[String(data.status || "").toLowerCase()]
      : EVENT_STATUS[eventType];

    if (!ORDER_ID_RE.test(orderId) || !status) return json({ received: true, ignored: true });
    if (event?.resource?.type && event.resource.type !== "order") return json({ received: true, ignored: true });
    if (printifyShopId && data.shop_id != null && String(data.shop_id) !== printifyShopId) {
      console.warn(`printify-webhook: event for shop ${String(data.shop_id)} ignored (expected ${printifyShopId})`);
      return json({ received: true, ignored: true });
    }

    const createdAt = Date.parse(String(event?.created_at || "").replace(" ", "T"));
    const recent = !Number.isFinite(createdAt) || Date.now() - createdAt < TOUCH_MAX_AGE_MS;

    const fields: Record<string, unknown> = {};
    const tracking = trackingFrom(data);
    if (tracking.number) fields.tracking = tracking.carrier ? `${tracking.carrier}: ${tracking.number}` : tracking.number;

    const rows = await transition(orderId, status, fields);

    // Tracking that arrives with a later or repeated event still gets recorded once.
    if (!rows.length && fields.tracking) {
      await rest(`${shipmentsFor(orderId)}&tracking=is.null&or=(status.is.null,status.neq.canceled)`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ tracking: fields.tracking }),
      });
    }

    // Tracking events become touchpoints — only on the transition, and only while fresh.
    if (status === "shipped" && tracking.number && recent) {
      for (const ship of rows) await sendGiftOnTheWay(ship, tracking.carrier, tracking.number, tracking.url);
    }
    if (status === "delivered" && recent) {
      for (const ship of rows) {
        await ownerAlert(ship, "gift_delivered", `\u{1F381} ${plain(ship.customer_name, 80) || "A customer"}'s gift (${plain(ship.gift, 80) || "gift"}) was delivered today — a perfect moment for a quick personal text or call.`);
      }
    }

    let refunded = 0;
    if (status === "canceled") {
      for (const ship of rows) {
        const amount = dollars(ship.wallet_debit_amount);
        const refundNote = ship.wallet_debit_key && amount > 0
          ? ` The $${amount.toFixed(2)} is going back to your gift wallet.`
          : " Contact Clicktide support about the gift wallet charge.";
        if (!ship.wallet_debit_key) {
          console.warn(`printify-webhook: canceled shipment ${ship.id} has no recorded wallet debit; refund needs manual review`);
        }
        await ownerAlert(ship, "gift_canceled", `The gift for ${plain(ship.customer_name, 80) || "a customer"} (${plain(ship.gift, 80) || "gift"}) was canceled by the print provider and won't ship.${refundNote}`);
      }
      refunded = await refundCanceled(orderId);
    }

    return json({ received: true, updated: rows.length, refunded });
  } catch (error) {
    // Processing is idempotent, so a 5xx just makes Printify retry.
    console.error("printify-webhook error:", error);
    return json({ error: "Webhook processing failed" }, 500);
  }
});
