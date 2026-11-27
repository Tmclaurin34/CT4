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
import { compliancePayload, HANDLED_TOPICS, isShopDomain, SHOPIFY_API_VERSION, verifyWebhookHmac } from "../_shared/shopify.js";
import { deleteAuthUser, freshShopifyToken, reconcileBilling, removeLogos, reportUsage, rest, rpc, type ShopConn, SRK } from "../_shared/shopify_server.ts";

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

// Shopify sends shop/redact 48 hours after an uninstall, and does so even when the merchant has
// reinstalled the app in the meantime. A store that is installed again right now is a current
// customer and keeps its data, so ask Shopify before deleting anything: "installed" means there
// is an active connection whose token Shopify still accepts. Anything uncertain throws, so the
// event is retried later instead of deleting (or skipping) on a guess.
async function shopInstalledNow(shop: string): Promise<boolean> {
  const conns = await rest(`/rest/v1/platform_connections?platform=eq.shopify&shop_domain=ilike.${encodeURIComponent(shop)}&is_active=eq.true&access_token=neq.&select=id,shop_domain,access_token,refresh_token,token_expires_at,raw_response&order=updated_at.desc&limit=1`);
  const conn = Array.isArray(conns) && conns[0] ? conns[0] as ShopConn : null;
  if (!conn) return false; // uninstalled and never reinstalled: no live token on file
  const fresh = await freshShopifyToken(conn);
  if (fresh === "auth") return false; // Shopify refuses to renew this install's token: it is gone
  if (fresh === "transient") throw new Error("could not reach Shopify to confirm the install; will retry");
  let r: Response;
  try {
    r = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": conn.access_token, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ shop { id } }" }),
    });
  } catch { throw new Error("could not reach Shopify to confirm the install; will retry"); }
  if (r.status === 401 || r.status === 403 || r.status === 404) return false; // token revoked or store gone
  if (r.status === 402 || r.status === 423) return true; // store frozen or locked, app still installed
  const body = await r.json().catch(() => null);
  if (r.ok && body?.data?.shop?.id) return true;
  throw new Error(`could not confirm the install with Shopify (HTTP ${r.status}); will retry`);
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
      if (await shopInstalledNow(ev.shop_domain)) {
        // Reinstalled since the uninstall this request refers to: the merchant is using the app.
        result = { skipped: "store has reinstalled the app and is active; nothing deleted" };
        console.log(`shop/redact for ${ev.shop_domain} skipped: the store is installed again`);
      } else {
        result = await rpc("clicktide_shopify_redact_shop", { p_shop: ev.shop_domain });
        // The account Clicktide made for this store (signed in from Shopify) is store data too:
        // erase its profile, customers, campaigns and shipments, then delete its login.
        // Website accounts that linked the store keep today's behaviour.
        const gone = await rpc("clicktide_shopify_redact_store_accounts", { p_shop: ev.shop_domain }) as string[];
        let deleted = 0;
        for (const id of Array.isArray(gone) ? gone : []) {
          if (!(await removeLogos(String(id)))) throw new Error(`could not remove store account ${id} logo files; will retry`);
          if (!(await deleteAuthUser(String(id)))) throw new Error(`could not delete store account ${id}; will retry`);
          deleted++;
        }
        result = { ...((result as Record<string, unknown>) || {}), store_accounts_deleted: deleted };
      }
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

// Usage billed through Shopify that is still unreported an hour later is money not yet billed:
// email support, at most once every 6 hours, so it can't quietly become free.
async function usageOverdueAlert() {
  try {
    const v = await rpc("clicktide_shopify_usage_overdue", {}) as { rows?: number; amount?: number; oldest?: string } | null;
    if (!v || !Number(v.rows)) return v;
    const send = await rpc("clicktide_rate_limit_hit", { p_bucket: "shopify-usage-overdue-alert", p_window_seconds: 21600, p_max: 1 }).catch(() => false);
    if (send === true) {
      await notifySupport(`Shopify usage not reported: ${v.rows} charge(s), $${v.amount}`,
        `${v.rows} usage charge(s) totalling $${v.amount} (oldest ${v.oldest}) have not been accepted by Shopify's App Events API.\n` +
        "Check the wallet rows where shopify_usage is true and shopify_usage_reported_at is null (shopify_usage_error says why), " +
        "and the Dev Dashboard logs. Failed rows keep retrying, backing off to once every 6 hours.");
    }
    return v;
  } catch (e) { console.error("usage overdue check failed", e); return null; }
}

// A website-first business that switched to Shopify billing whose Stripe subscription still
// isn't confirmed stopped after 5 tries could be paying twice: email support (once a day).
async function stripeSwitchAlert(usage: unknown) {
  const stuck = (usage as { stripeSwitch?: { stuck?: unknown[] } } | null)?.stripeSwitch?.stuck || [];
  if (!stuck.length) return 0;
  const send = await rpc("clicktide_rate_limit_hit", { p_bucket: "shopify-stripe-switch-alert", p_window_seconds: 86400, p_max: 1 }).catch(() => false);
  if (send === true) {
    await notifySupport(`Stripe subscription not stopped after switching to Shopify billing (${stuck.length})`,
      "These businesses now pay through Shopify, but Stripe hasn't confirmed their old subscription will end. " +
      "Cancel each at period end in the Stripe dashboard (check the right Stripe account), then set done_at in shopify_stripe_switch:\n" +
      JSON.stringify(stuck, null, 2));
  }
  return stuck.length;
}

// Where Shopify tells us what it billed (legacy AppUsagePricing balanceUsed), compare it with
// what we reported this cycle. App Pricing exposes no such figure to the Admin API, so for
// App Pricing stores this is the manual monthly check in docs/shopify-usage-billing.md.
async function usageMismatchAlert() {
  try {
    const m = await rpc("clicktide_shopify_usage_mismatches", {}) as unknown[];
    if (!Array.isArray(m) || !m.length) return [];
    const send = await rpc("clicktide_rate_limit_hit", { p_bucket: "shopify-usage-mismatch-alert", p_window_seconds: 86400, p_max: 1 }).catch(() => false);
    if (send === true) {
      await notifySupport(`Shopify usage mismatch on ${m.length} store(s)`,
        "What Shopify reports as billed this cycle differs from what Clicktide reported:\n" + JSON.stringify(m, null, 2));
    }
    return m;
  } catch (e) { console.error("usage mismatch check failed", e); return null; }
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
  let usage: unknown;
  try { usage = await reportUsage(); } catch (e) { usage = { error: e instanceof Error ? e.message : String(e) }; }
  const overdue = await usageOverdueAlert();
  const mismatches = await usageMismatchAlert();
  const stripeStuck = await stripeSwitchAlert(usage);
  return { retried: (pending || []).length, billing, usage, overdue, mismatches, stripeStuck };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SECRET || !SRK) return json({ error: "Server is not configured" }, 500);

  const cronKey = req.headers.get("x-clicktide-cron-key") || "";
  if (cronKey) {
    let expected = "";
    try { expected = String(await rpc("clicktide_internal_key", {}) || ""); } catch { /* */ }
    if (!expected || cronKey !== expected) return json({ error: "Not authorized" }, 401);
    // {"job":"usage"}: the 10-minute run that only reports usage billing to Shopify.
    let job = "", jobShop = "";
    try {
      const b = await req.clone().json();
      job = String(b?.job || ""); jobShop = String(b?.shop || "").toLowerCase();
    } catch { /* empty body */ }
    // {"job":"installed","shop":"x.myshopify.com"}: ops check of the shop/redact guard. Reads only.
    if (job === "installed") {
      if (!isShopDomain(jobShop)) return json({ error: "bad shop" }, 400);
      try { return json({ ok: true, shop: jobShop, installed: await shopInstalledNow(jobShop) }); }
      catch (e) { return json({ ok: false, shop: jobShop, error: e instanceof Error ? e.message : String(e) }, 502); }
    }
    if (job === "usage") {
      let usage: unknown, err = "";
      try { usage = await reportUsage(); } catch (e) { err = e instanceof Error ? e.message : String(e); }
      const overdue = await usageOverdueAlert();
      const mismatches = await usageMismatchAlert();
      const stripeStuck = await stripeSwitchAlert(usage);
      return json({ ok: !err, usage, overdue, mismatches, stripeStuck, ...(err ? { error: err } : {}) }, err ? 502 : 200);
    }
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
