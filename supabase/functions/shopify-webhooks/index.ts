// Shopify webhooks for the public app: the three mandatory privacy (compliance)
// topics, app/uninstalled, and app_subscriptions/update (Shopify billing).
//
// Every request is verified with X-Shopify-Hmac-Sha256 (HMAC of the raw body with
// the app's client secret) before anything is read. Each webhook id is recorded
// once (Shopify retries reuse it), so a retry never runs a deletion twice.
// The database work lives in service-role-only functions from migration
// 20261128090000_shopify_public_app.sql; this file only routes.
//
// Deploy with verify_jwt = false (Shopify doesn't send a Supabase JWT); the HMAC
// check is the authentication.
import {
  compliancePayload, entitlementFromSubscriptions, HANDLED_TOPICS, isShopDomain,
  SHOPIFY_API_VERSION, SUBSCRIPTION_QUERY, verifyWebhookHmac,
} from "../_shared/shopify.js";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const clientSecret = Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "";
const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") ?? "Clicktide <support@goclicktide.com>";
const SUPPORT_EMAIL = "support@goclicktide.com";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

function reply(status: number, body: Record<string, unknown> = { ok: status < 300 }) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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
const rpc = (fn: string, args: Record<string, unknown>) => rest(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

async function notifySupport(subject: string, text: string) {
  if (!resendKey) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: fromEmail, to: [SUPPORT_EMAIL], subject, text }),
  }).catch(() => {});
}

// Reads the shop's current app subscription with its stored token and applies it.
async function syncBilling(shop: string) {
  const conns = await rest(`/rest/v1/platform_connections?platform=eq.shopify&shop_domain=ilike.${encodeURIComponent(shop)}&is_active=eq.true&access_token=neq.&select=access_token&limit=1`);
  const token = Array.isArray(conns) && conns[0]?.access_token;
  if (!token) return { skipped: "no active connection" };
  const r = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: SUBSCRIPTION_QUERY }),
  });
  if (!r.ok) throw new Error(`shopify billing query ${r.status}`);
  const d = await r.json();
  const subs = d?.data?.currentAppInstallation?.activeSubscriptions || [];
  const devStore = !!d?.data?.shop?.plan?.partnerDevelopment;
  const e = entitlementFromSubscriptions(subs, { devStore });
  return await rpc("clicktide_shopify_apply_entitlement", {
    p_shop: shop, p_plan: e.plan, p_status: e.status, p_period_end: e.period_end, p_sub_id: e.sub_id, p_raw_status: e.raw_status,
  });
}

async function process(eventId: number, topic: string, shop: string, body: Record<string, unknown>) {
  let result: unknown = null;
  let status = "processed";
  try {
    const p = compliancePayload(topic, body);
    if (topic === "customers/redact") {
      result = await rpc("clicktide_shopify_redact_customer", {
        p_shop: shop, p_email: p.customer?.email ?? null, p_phone: p.customer?.phone ?? null, p_order_ids: p.orders ?? [],
      });
    } else if (topic === "shop/redact") {
      result = await rpc("clicktide_shopify_redact_shop", { p_shop: shop });
    } else if (topic === "customers/data_request") {
      const data = await rpc("clicktide_shopify_customer_data", { p_shop: shop, p_email: p.customer?.email ?? null, p_phone: p.customer?.phone ?? null });
      const n = Array.isArray(data) ? data.length : 0;
      result = { records_found: n };
      // The data itself stays in the database (never emailed); support sends it to the merchant.
      await notifySupport(
        `Shopify data request from ${shop} (event ${eventId})`,
        `Shopify forwarded a customer data request for ${shop}.\n` +
        `Matching Clicktide customer records: ${n}.\n` +
        `Shopify data request id: ${p.data_request_id ?? "n/a"}.\n\n` +
        `Export with: select public.clicktide_shopify_customer_data('${shop}', <email>, <phone>);\n` +
        `then send it to the merchant within 30 days. Event row: shopify_webhook_events.id = ${eventId}.`,
      );
    } else if (topic === "app/uninstalled") {
      await rest(`/rest/v1/platform_connections?platform=eq.shopify&shop_domain=ilike.${encodeURIComponent(shop)}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ is_active: false, access_token: "", updated_at: new Date().toISOString() }),
      });
      result = { deactivated: true };
    } else if (topic === "app_subscriptions/update") {
      result = await syncBilling(shop);
    } else {
      status = "ignored";
    }
  } catch (e) {
    status = "failed";
    result = { error: e instanceof Error ? e.message : String(e) };
    console.error("shopify webhook failed", topic, shop, e);
  }
  // Redact topics: once handled, the copy of the shopper's identifiers is removed.
  const scrub = status === "processed" && (topic === "customers/redact" || topic === "shop/redact");
  await rest(`/rest/v1/shopify_webhook_events?id=eq.${eventId}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status, result, processed_at: new Date().toISOString(), ...(scrub ? { payload: null } : {}) }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
  if (!clientSecret || !serviceRoleKey) return reply(500, { error: "Server is not configured" });

  const raw = new Uint8Array(await req.arrayBuffer());
  const ok = await verifyWebhookHmac(raw, req.headers.get("x-shopify-hmac-sha256"), clientSecret, crypto.subtle);
  if (!ok) return reply(401, { error: "Invalid signature" });

  const topic = String(req.headers.get("x-shopify-topic") || "");
  const shop = String(req.headers.get("x-shopify-shop-domain") || "").toLowerCase();
  const webhookId = String(req.headers.get("x-shopify-webhook-id") || "") || null;
  if (!isShopDomain(shop)) return reply(400, { error: "Bad shop domain" });
  if (!HANDLED_TOPICS.includes(topic)) return reply(200, { ok: true, ignored: topic });

  let body: Record<string, unknown> = {};
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return reply(400, { error: "Bad JSON" }); }

  // Record once. A retry of a webhook we already took returns 200 without re-running it.
  let eventId: number | null = null;
  try {
    const rows = await rest("/rest/v1/shopify_webhook_events?on_conflict=webhook_id", {
      method: "POST", headers: { Prefer: "return=representation,resolution=ignore-duplicates" },
      body: JSON.stringify({ webhook_id: webhookId, topic, shop_domain: shop, payload: compliancePayload(topic, body), attempts: 1 }),
    });
    eventId = Array.isArray(rows) && rows[0]?.id ? Number(rows[0].id) : null;
  } catch (e) {
    console.error("could not record webhook", e);
    return reply(500, { error: "Could not record webhook" }); // Shopify will retry
  }
  if (!eventId) return reply(200, { ok: true, duplicate: true });

  // Acknowledge fast (Shopify expects a quick 2xx); do the work in the background.
  const job = process(eventId, topic, shop, body);
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(job);
  else await job;
  return reply(200, { ok: true });
});
