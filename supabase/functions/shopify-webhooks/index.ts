// Shopify webhooks: mandatory compliance topics (customers/data_request,
// customers/redact, shop/redact) plus app/uninstalled and
// app_subscriptions/update. One endpoint for all of them.
//
// - Every request's X-Shopify-Hmac-Sha256 is checked against the raw body bytes
//   with SHOPIFY_CLIENT_SECRET before anything is parsed; a bad signature gets
//   401 (what Shopify's review expects).
// - Shopify waits only 5 seconds, so the event is recorded (deduped by
//   X-Shopify-Webhook-Id) and 200 is returned; the work runs right after in the
//   background. Anything that fails is retried by the nightly cron call
//   (POST with x-clicktide-cron-key), well inside Shopify's 30-day deadline.
// - Redaction is done in SQL (clicktide_shopify_redact_customer / _shop), then
//   the stored payload is wiped so no shopper PII stays in the event log.
// - Billing writes only happen when SHOPIFY_BILLING_ENABLED=true (see
//   _shared/shopify_server.ts); until then they are dry runs.
//
// Deploy with verify_jwt = false (Shopify sends no Supabase JWT).
import { compliancePayload, HANDLED_TOPICS, isShopDomain, verifyWebhookHmac } from "../_shared/shopify.js";
import { reconcileBilling, rest, rpc, SRK } from "../_shared/shopify_server.ts";

const SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "";
const RESEND = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM = Deno.env.get("RESEND_FROM_EMAIL") ?? "Clicktide <support@goclicktide.com>";
const SUPPORT_TO = Deno.env.get("OPS_ALERT_EMAIL") ?? "support@goclicktide.com";
const MAX_ATTEMPTS = 8;

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Ev = { id: number; topic: string; shop_domain: string; payload: Record<string, unknown> | null; attempts: number; due_by?: string };

async function notifySupport(subject: string, text: string) {
  if (!RESEND) { console.warn("no RESEND_API_KEY; support not emailed:", subject); return false; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: RESEND_FROM, to: [SUPPORT_TO], subject, text }),
  }).catch(() => null);
  return !!r?.ok;
}

async function process(ev: Ev) {
  // deno-lint-ignore no-explicit-any
  const p = (ev.payload || {}) as Record<string, any>;
  // deno-lint-ignore no-explicit-any
  const cu = (p.customer || {}) as Record<string, any>;
  let result: unknown;
  let scrub = false;
  switch (ev.topic) {
    case "customers/redact":
      result = await rpc("clicktide_shopify_redact_customer", {
        p_shop: ev.shop_domain, p_email: cu.email || "", p_phone: cu.phone || "", p_order_ids: p.orders || [],
      });
      scrub = true;
      break;
    case "shop/redact":
      result = await rpc("clicktide_shopify_redact_shop", { p_shop: ev.shop_domain });
      scrub = true;
      break;
    case "customers/data_request": {
      // Shopify asks the app to give the merchant this shopper's data. The data
      // itself is never emailed: support exports it with
      // clicktide_shopify_customer_data(shop, email, phone) and sends it to the
      // merchant; the identifiers are kept in the event row until then.
      const rows = await rpc("clicktide_shopify_customer_data", { p_shop: ev.shop_domain, p_email: cu.email || "", p_phone: cu.phone || "" });
      const n = Array.isArray(rows) ? rows.length : 0;
      const sent = await notifySupport(
        `Shopify data request #${ev.id} from ${ev.shop_domain} (due ${String(ev.due_by || "").slice(0, 10)})`,
        `A Shopify merchant (${ev.shop_domain}) asked for one shopper's data (Shopify data_request ${p.data_request_id || "?"}).\n` +
          `Clicktide holds ${n} matching customer record(s).\n\n` +
          `To fulfil, in the Supabase SQL editor run\n  select payload from shopify_webhook_events where id = ${ev.id};\n` +
          `  select clicktide_shopify_customer_data('${ev.shop_domain}', '<email>', '<phone>');\n` +
          `send the result to the store owner, then run\n  update shopify_webhook_events set payload = null, result = result || '{"fulfilled":true}' where id = ${ev.id};\n` +
          `Deadline: 30 days from receipt.`,
      );
      result = { matching_records: n, support_notified: sent };
      if (!sent) throw new Error("support notification failed"); // retried by cron
      break;
    }
    case "app/uninstalled":
      // The token is dead the moment the app is uninstalled: stop syncing now.
      // Data stays until shop/redact (48h later) so a quick reinstall loses nothing.
      await rest(`/rest/v1/platform_connections?platform=eq.shopify&shop_domain=ilike.${encodeURIComponent(ev.shop_domain)}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ is_active: false, access_token: "", refresh_token: null, updated_at: new Date().toISOString() }),
      });
      result = { deactivated: true, billing: await reconcileBilling(ev.shop_domain) };
      scrub = true;
      break;
    case "app_subscriptions/update":
      result = await reconcileBilling(ev.shop_domain); // re-read the truth; never trust webhook order
      scrub = true;
      break;
  }
  await rest(`/rest/v1/shopify_webhook_events?id=eq.${ev.id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "processed", processed_at: new Date().toISOString(), attempts: ev.attempts + 1, result, ...(scrub ? { payload: null } : {}) }),
  });
}

async function runOne(ev: Ev) {
  try { await process(ev); }
  catch (e) {
    console.error("shopify webhook processing failed", ev.id, ev.topic, e);
    await rest(`/rest/v1/shopify_webhook_events?id=eq.${ev.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "failed", attempts: ev.attempts + 1, result: { error: e instanceof Error ? e.message : String(e) } }),
    }).catch(() => {});
  }
}

// Nightly (pg_cron, x-clicktide-cron-key): retry unfinished events, then
// re-read every installed shop's subscription (App Pricing sends no webhooks).
async function cronRun() {
  const pending = await rest(`/rest/v1/shopify_webhook_events?status=in.(received,failed)&attempts=lt.${MAX_ATTEMPTS}&received_at=lt.${new Date(Date.now() - 5 * 60000).toISOString()}&select=id,topic,shop_domain,payload,attempts,due_by&order=id&limit=100`) as Ev[];
  for (const ev of pending || []) await runOne(ev);
  const shops = await rest(`/rest/v1/platform_connections?platform=eq.shopify&is_active=eq.true&user_id=not.is.null&select=shop_domain&limit=1000`) as { shop_domain: string }[];
  const billing: unknown[] = [];
  for (const s of [...new Set((shops || []).map((x) => x.shop_domain).filter(Boolean))]) {
    try { billing.push({ shop: s, ...(await reconcileBilling(s)) }); }
    catch (e) { billing.push({ shop: s, error: e instanceof Error ? e.message : String(e) }); }
  }
  return { retried: (pending || []).length, billing };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SECRET || !SRK) return json({ error: "Server is not configured" }, 500);

  const cronKey = req.headers.get("x-clicktide-cron-key") || "";
  if (cronKey) {
    let expected = "";
    try { expected = String(await rpc("clicktide_internal_key", {}) || ""); } catch { /* */ }
    if (!expected || cronKey !== expected) return json({ error: "Not authorized" }, 401);
    return json({ ok: true, ...(await cronRun()) });
  }

  const raw = new Uint8Array(await req.arrayBuffer());
  const valid = await verifyWebhookHmac(raw, req.headers.get("x-shopify-hmac-sha256") || "", SECRET, crypto.subtle);
  if (!valid) return json({ error: "invalid hmac" }, 401);

  const topic = (req.headers.get("x-shopify-topic") || "").toLowerCase();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(new TextDecoder().decode(raw) || "{}"); } catch { return json({ error: "bad json" }, 400); }
  const shop = String(req.headers.get("x-shopify-shop-domain") || body.shop_domain || "").toLowerCase();
  if (!isShopDomain(shop)) return json({ error: "bad shop" }, 400);
  if (!HANDLED_TOPICS.includes(topic)) return json({ ok: true, ignored: topic });

  const isCompliance = topic.startsWith("customers/") || topic === "shop/redact";
  let ev: Ev | null = null;
  try {
    const rows = await rest("/rest/v1/shopify_webhook_events?on_conflict=webhook_id", {
      method: "POST", headers: { Prefer: "return=representation,resolution=ignore-duplicates" },
      body: JSON.stringify({
        webhook_id: req.headers.get("x-shopify-webhook-id") || null, topic, shop_domain: shop,
        payload: isCompliance ? compliancePayload(topic, body) : null,
      }),
    });
    ev = Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (e) {
    console.error("could not record shopify webhook", topic, shop, e);
    return json({ error: "temporarily unavailable" }, 500); // Shopify retries
  }
  if (!ev) return json({ ok: true, duplicate: true });

  const job = runOne(ev);
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(job);
  else await job;
  return json({ ok: true });
});
