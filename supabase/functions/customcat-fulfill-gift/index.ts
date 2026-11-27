// Clicktide → CustomCat gift fulfillment. Mirrors printify-fulfill-gift (same auth,
// address validation, idempotent claim, C1 wallet debit, refund-on-failure, shipment
// record) but routes the order to CustomCat's API. The product (customcat_sku) and the
// price come only from the gift_catalog row; the DESIGN that prints is only the
// business's saved logo_url. Defaults to SANDBOX unless env CUSTOMCAT_LIVE=true, so
// nothing real ships until you flip it on.
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const customcatKey = Deno.env.get("CUSTOMCAT_API_KEY") || "";
const customcatBase = "https://customcat-beta.mylocker.net/api/v1";
const customcatLive = (Deno.env.get("CUSTOMCAT_LIVE") || "").toLowerCase() === "true";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-clicktide-cron-key, idempotency-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_RE = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/;
const CATALOG_FIELDS = "id,name,estimated_cost,is_active,printify_product_id,printify_variant_id,customcat_sku,gelato_uid";
const SENDS_PER_USER_PER_HOUR = 120;

type Address = {
  first_name?: string; last_name?: string; email?: string; phone?: string;
  country?: string; region?: string; address1?: string; address2?: string; city?: string; zip?: string;
};
type CatalogRow = {
  id: string; name?: string | null; estimated_cost?: number | string | null; is_active?: boolean | null;
  printify_product_id?: string | null; printify_variant_id?: number | null; customcat_sku?: string | null; gelato_uid?: string | null;
};
type Customer = { id: number; name?: string | null; email?: string | null };
type Claim = { claimed: boolean; attempt?: number; state?: string; provider?: string | null; shipment_id?: number | null; provider_order_id?: string | null };
type WalletResult = { ok: boolean; balance?: number; duplicate?: boolean; reason?: string };

// code: "not_started" = nothing was charged and no order was started, so the caller may
// treat the send as not done. null = never add a code. undefined = decided by the handler
// (not_started while no wallet debit has been attempted).
const NOT_STARTED = "not_started";

class AppError extends Error {
  status: number;
  code: string | null | undefined;
  constructor(message: string, status = 500, code?: string | null) { super(message); this.status = status; this.code = code; }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function parseJson(text: string) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function dollars(value: unknown) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

// Text that lands in the dashboard and on shipping labels: no markup, no control characters.
function cleanText(value: unknown, max: number) {
  return String(value ?? "").replace(/[<>]/g, "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

function cleanEmail(value: unknown) {
  const email = String(value ?? "").trim().slice(0, 254);
  return EMAIL_RE.test(email) ? email : "";
}

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error || "error")).slice(0, 300);
}

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function normalizeAddress(raw: unknown, customerName: string, customerEmail: string): Address {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const parts = customerName.trim().split(/\s+/);
  return {
    first_name: cleanText(a.first_name || a.firstName || parts[0], 60) || "Customer",
    last_name: cleanText(a.last_name || a.lastName || parts.slice(1).join(" "), 60) || "Gift",
    email: cleanEmail(a.email) || customerEmail || "no-email@customcat.com",
    phone: cleanText(a.phone, 30) || "555-555-5555",
    country: cleanText(a.country, 3).toUpperCase() || "US",
    region: cleanText(a.region || a.state, 40),
    address1: cleanText(a.address1 || a.line1 || a.street, 120),
    address2: cleanText(a.address2 || a.line2, 120),
    city: cleanText(a.city, 60),
    zip: cleanText(a.zip || a.postal_code || a.postalCode, 12),
  };
}

function addressComplete(address: Address) {
  return !!(String(address.address1 || "").trim() &&
    String(address.city || "").trim() &&
    String(address.region || "").trim() &&
    /^[0-9]{5}(-[0-9]{4})?$/.test(String(address.zip || "").trim()));
}

async function supabaseFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, ...(init.headers || {}) },
  });
  const data = parseJson(await response.text());
  if (!response.ok) throw new AppError(data?.message || data?.error || response.statusText, response.status);
  return data;
}

async function validateShipmentAddress(address: Address, skipValidator = false) {
  if (!addressComplete(address)) throw new AppError("A complete shipping address is required before sending a gift", 400);
  if (skipValidator) return address;
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/validate-address`, {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ address: address.address1, city: address.city, state: address.region, zip: address.zip }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data?.valid === false) throw new AppError(data?.error || "Shipping address could not be verified", 400);
    if (!response.ok || data?.valid !== true) return address;
    const n = data?.normalized || {};
    return {
      ...address,
      address1: cleanText(n.address1 || address.address1, 120),
      city: cleanText(n.city || address.city, 60),
      region: cleanText(n.region || address.region, 40),
      zip: cleanText(n.zip || address.zip, 12),
      country: cleanText(n.country || address.country, 3) || "US",
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    return address;
  }
}

async function expectedCronKey() {
  try {
    const data = await supabaseFetch("/rest/v1/rpc/clicktide_internal_key", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    return String(data || "");
  } catch { return ""; }
}

async function authedUserId(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return "";
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: serviceRoleKey, Authorization: authorization } });
  if (!response.ok) return "";
  const user = await response.json();
  return String(user?.id || "");
}

// Fails closed: a gift send spends money.
async function underLimit(bucket: string, windowSeconds: number, max: number) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_rate_limit_hit`, {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
    });
    if (!r.ok) return false;
    return (await r.json()) === true;
  } catch {
    return false;
  }
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function suppliedKey(req: Request, body: Record<string, unknown>) {
  const raw = String(body.idempotency_key || req.headers.get("idempotency-key") || "").trim();
  return /^[A-Za-z0-9_.:-]{8,128}$/.test(raw) ? raw : "";
}

// The dashboard sends a fresh campaign id on every click ("manual-gift-<ms>", or
// "manual-gift-bulk-<ms>-<cart item id>" from the Gift Cart), so such an id is not part
// of the key. Only the cart item id is kept, so two cart lines stay separate sends.
const DASHBOARD_CAMPAIGN_RE = /^manual-gift-(?:bulk-)?\d+(?:-(.+))?$/;

// Same logical send -> same key. A caller-supplied key wins. Otherwise the key is
// derived from business, recipient, gift and campaign, bucketed by UTC day, or by ten
// minutes for a manual send without a real campaign id. `previous` is that send's key
// in the prior ten-minute bucket, so a retry just across a boundary is still caught.
async function sendKey(
  req: Request,
  body: Record<string, unknown>,
  p: { userId: string; isInternal: boolean; campaignId: string | null; customerId: number | null; catalogId: string; address: Address },
): Promise<{ key: string; previous: string }> {
  const supplied = suppliedKey(req, body);
  if (supplied) return { key: await sha256Hex(["gift", p.userId, "key", supplied].join("|")), previous: "" };
  const dashboard = !p.isInternal && p.campaignId ? DASHBOARD_CAMPAIGN_RE.exec(p.campaignId) : null;
  const campaign = dashboard ? "" : p.campaignId || "";
  const recipient = (p.customerId
    ? `customer:${p.customerId}`
    : `address:${String(p.address.address1 || "").toLowerCase()}|${p.address.zip || ""}`) +
    (dashboard?.[1] ? `|item:${dashboard[1]}` : "");
  const parts = (bucket: string) =>
    ["gift", p.userId, p.isInternal ? "auto" : "manual", campaign, recipient, p.catalogId, bucket].join("|");
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  if (p.isInternal || campaign) return { key: await sha256Hex(parts(day)), previous: "" };
  const slot = Math.floor(now / 600000);
  const previousDay = new Date((slot - 1) * 600000).toISOString().slice(0, 10);
  return { key: await sha256Hex(parts(`${day}/${slot}`)), previous: await sha256Hex(parts(`${previousDay}/${slot - 1}`)) };
}

// A manual send claimed under the previous ten-minute key in the last ten minutes is the
// same send: it is replayed instead of ordered again.
async function recentClaim(key: string, userId: string): Promise<Claim | null> {
  if (!key) return null;
  const since = new Date(Date.now() - 600000).toISOString();
  try {
    const rows = await supabaseFetch(
      `/rest/v1/gift_send_claims?idempotency_key=eq.${encodeURIComponent(key)}&user_id=eq.${encodeURIComponent(userId)}&status=in.(pending,placed,refund_pending)&created_at=gte.${encodeURIComponent(since)}&select=status,provider,shipment_id,provider_order_id&limit=1`,
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    return { claimed: false, state: row.status, provider: row.provider, shipment_id: row.shipment_id, provider_order_id: row.provider_order_id };
  } catch (error) {
    console.error("customcat-fulfill: recent claim check failed:", error);
    throw new AppError("Gift sending is unavailable right now — nothing was charged. Please try again shortly.", 503);
  }
}

async function catalogRowFor(body: Record<string, unknown>): Promise<CatalogRow | null> {
  const pick = async (filter: string) => {
    const rows = await supabaseFetch(`/rest/v1/gift_catalog?${filter}&select=${CATALOG_FIELDS}&order=is_active.desc,updated_at.desc&limit=1`);
    return Array.isArray(rows) && rows[0] ? rows[0] as CatalogRow : null;
  };
  for (const raw of [body.gift_catalog_id, body.printify_product_id]) {
    const key = String(raw || "");
    if (UUID_RE.test(key)) return await pick(`id=eq.${key}`);
  }
  const productKey = String(body.printify_product_id || "");
  if (!PRODUCT_ID_RE.test(productKey)) return null;
  const product = encodeURIComponent(productKey);
  const variantId = Number(body.printify_variant_id || 0);
  if (Number.isSafeInteger(variantId) && variantId > 0) {
    const exact = await pick(`printify_product_id=eq.${product}&printify_variant_id=eq.${variantId}`);
    if (exact) return exact;
  }
  return await pick(`printify_product_id=eq.${product}`);
}

async function customerFor(userId: string, raw: unknown): Promise<Customer | null> {
  if (raw === undefined || raw === null || raw === "") return null;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError("Unknown customer for this business", 400);
  const rows = await supabaseFetch(`/rest/v1/customers?id=eq.${id}&user_id=eq.${encodeURIComponent(userId)}&select=id,name,email&limit=1`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw new AppError("Unknown customer for this business", 400);
  return row as Customer;
}

async function businessFor(userId: string) {
  const rows = await supabaseFetch(`/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}&select=stripe_subscription_status,logo_url&limit=1`);
  return (Array.isArray(rows) && rows[0] ? rows[0] : {}) as { stripe_subscription_status?: string | null; logo_url?: string | null };
}

// Print files come only from the business's saved logo, and only from the public logos
// bucket or a fixed goclicktide.com asset (the site has no user content today, but an
// open path would let any future page or redirect there become a print file).
const SITE_LOGO_PATHS = new Set(["/clicktide-logo-transparent.png"]);
function artworkUrl(saved: unknown) {
  const raw = String(saved || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    if (url.host === new URL(supabaseUrl).host && url.pathname.startsWith("/storage/v1/object/public/logos/")) return url.href;
    if ((url.host === "goclicktide.com" || url.host === "www.goclicktide.com") && !url.search && SITE_LOGO_PATHS.has(url.pathname)) return url.href;
  } catch { /* not a URL */ }
  return "";
}

// campaign-runner gives up on a slow auto-send after a few seconds and asks the owner to
// send the gift by hand, although that order can still go through. So a manual send of
// the same catalog gift to the same customer within a day of an automatic one is refused.
async function autoSentRecently(userId: string, customerId: number, catalogId: string) {
  const since = new Date(Date.now() - 86400000).toISOString();
  try {
    const rows = await supabaseFetch(
      `/rest/v1/gift_send_claims?user_id=eq.${encodeURIComponent(userId)}&customer_id=eq.${customerId}&catalog_id=eq.${encodeURIComponent(catalogId)}&origin=eq.auto&status=in.(pending,placed)&created_at=gte.${encodeURIComponent(since)}&select=idempotency_key&limit=1`,
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch (error) {
    console.error("customcat-fulfill: recent auto-send check failed:", error);
    throw new AppError("Gift sending is unavailable right now — nothing was charged. Please try again shortly.", 503);
  }
}

async function claimSend(key: string, userId: string, provider: string, row: CatalogRow, customerId: number | null, campaignId: string | null, amount: number, origin: "auto" | "manual"): Promise<Claim> {
  const data = await supabaseFetch("/rest/v1/rpc/clicktide_gift_claim", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ p_key: key, p_user: userId, p_provider: provider, p_catalog_id: row.id, p_customer_id: customerId, p_campaign_id: campaignId, p_amount: amount, p_origin: origin }),
  }).catch((error) => {
    console.error("customcat-fulfill: gift claim failed:", error);
    return null;
  });
  if (!data || typeof data.claimed !== "boolean") {
    throw new AppError("Gift sending is unavailable right now — nothing was charged. Please try again shortly.", 503);
  }
  return data as Claim;
}

async function finishClaim(key: string, attempt: number, fields: Record<string, unknown>) {
  try {
    await supabaseFetch(`/rest/v1/gift_send_claims?idempotency_key=eq.${encodeURIComponent(key)}&attempt=eq.${attempt}`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
    });
  } catch (error) {
    console.error(`customcat-fulfill: could not update gift claim ${key}#${attempt}:`, error);
  }
}

// C1: one locked, idempotent ledger write per money movement.
async function walletApply(userId: string, delta: number, kind: string, description: string, reference: string | null, idempotencyKey: string): Promise<WalletResult> {
  const data = await supabaseFetch("/rest/v1/rpc/clicktide_wallet_apply", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ p_user: userId, p_delta: delta, p_kind: kind, p_description: description, p_reference: reference, p_idempotency_key: idempotencyKey }),
  });
  if (!data || typeof data.ok !== "boolean") throw new Error("Unexpected wallet response");
  return data as WalletResult;
}

// Returns a failed attempt's debit exactly once (the refund key is derived from the debit
// key); if the refund can't be written the claim is parked as refund_pending.
async function refundAttempt(userId: string, amount: number, giftName: string, reference: string | null, key: string, attempt: number, debitKey: string, reason: string) {
  try {
    const result = await walletApply(userId, amount, "gift_refund", `Gift wallet refund: ${giftName}`, reference, `${debitKey}:refund`);
    if (result.ok) {
      await finishClaim(key, attempt, { status: "failed", error: reason });
      return true;
    }
    console.error(`customcat-fulfill: refund refused (${result.reason || "unknown"}) for ${debitKey}`);
  } catch (error) {
    console.error(`customcat-fulfill: refund failed for ${debitKey}:`, error);
  }
  await finishClaim(key, attempt, { status: "refund_pending", error: `${reason} | refund of ${amount.toFixed(2)} still owed` });
  return false;
}

async function recordShipment(fields: Record<string, unknown>) {
  const rows = await supabaseFetch("/rest/v1/shipments", {
    method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(fields),
  });
  return (Array.isArray(rows) ? rows[0] : rows) as Record<string, unknown> | null;
}

async function replayResponse(claim: Claim, userId: string, key: string) {
  if (claim.state === "placed") {
    let shipment: Record<string, unknown> | null = null;
    try {
      const filter = claim.shipment_id ? `id=eq.${Number(claim.shipment_id)}` : `idempotency_key=eq.${encodeURIComponent(key)}`;
      const rows = await supabaseFetch(`/rest/v1/shipments?${filter}&user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`);
      shipment = Array.isArray(rows) && rows[0] ? rows[0] : null;
    } catch (_) { /* replay without the row */ }
    return json({
      ok: true, duplicate: true, shipment,
      provider: claim.provider || "customcat",
      customcat_order_id: claim.provider_order_id || null,
      sandbox: !customcatLive,
      status: String(shipment?.status || (customcatLive ? "in_production" : "processing")),
    });
  }
  if (claim.state === "pending") return json({ error: "This gift is already being sent — check Shipments before sending it again." }, 409);
  if (claim.state === "refund_pending") return json({ error: "This gift couldn't be sent and its wallet refund is being processed. Contact support if it doesn't show up soon." }, 409);
  return json({ error: "This gift send couldn't be started. Please try again.", code: NOT_STARTED }, 409);
}

async function createCustomCatOrder(externalId: string, address: Address, designUrl: string, sku: string) {
  const payload = {
    shipping_first_name: address.first_name, shipping_last_name: address.last_name,
    shipping_address1: address.address1, shipping_address2: address.address2 || "",
    shipping_city: address.city, shipping_state: address.region, shipping_zip: address.zip,
    shipping_country: address.country || "US",
    shipping_email: address.email || "no-email@customcat.com", shipping_phone: address.phone || "555-555-5555",
    shipping_method: "Economy",
    items: [{ catalog_sku: String(sku), design_url: designUrl, quantity: 1 }],
    sandbox: customcatLive ? "0" : "1",
    api_key: customcatKey,
  };
  const resp = await fetch(`${customcatBase}/order/${encodeURIComponent(externalId)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let data: Record<string, unknown> = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-json */ }
  if (!resp.ok || !data?.CUSTOMCAT_ORDER_ID) {
    throw new AppError(String(data?.MSG || data?.error || `CustomCat order failed (${resp.status})`), resp.ok ? 502 : resp.status || 502);
  }
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed", code: NOT_STARTED }, 405);
  if (!serviceRoleKey) return json({ error: "Supabase service role is not configured", code: NOT_STARTED }, 500);

  // Set just before the wallet debit: from then on only an explicit code says nothing was charged.
  let debitStarted = false;
  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("Invalid request", 400);

    const cronKey = req.headers.get("x-clicktide-cron-key") || "";
    const isInternal = !!cronKey && safeEqual(cronKey, await expectedCronKey());
    const authUserId = isInternal ? "" : await authedUserId(req);
    const userId = String(body.user_id || body.merchant_id || authUserId || "");
    if (!UUID_RE.test(userId)) throw new AppError("Business user id is required", 400);
    if (!isInternal) {
      if (!authUserId) throw new AppError("Login is required to fulfill gifts", 401);
      if (authUserId !== userId) throw new AppError("Not allowed to fulfill gifts for this business", 403);
      if (!(await underLimit(`gift:send:user:${userId}`, 3600, SENDS_PER_USER_PER_HOUR))) {
        throw new AppError("Too many gift sends right now — please wait a few minutes and try again.", 429);
      }
    }
    if (!customcatKey) throw new AppError("CustomCat is not configured (missing CUSTOMCAT_API_KEY secret)", 500);

    const row = await catalogRowFor(body);
    if (!row) throw new AppError("Unknown gift product — choose a gift from the catalog", 400);
    if (row.is_active === false && !isInternal) throw new AppError("This gift is no longer available", 400);
    const sku = cleanText(row.customcat_sku, 80);
    if (!sku) throw new AppError("This gift isn't set up for CustomCat fulfillment yet", 400);
    const giftCost = dollars(row.estimated_cost);
    if (giftCost <= 0) throw new AppError("Gift cost is required", 400);
    const giftName = cleanText(row.name, 120) || "Gift";

    const customer = await customerFor(userId, body.customer_id);
    const customerId = customer ? customer.id : null;
    const customerName = cleanText(body.customer_name || customer?.name, 120) || "Customer";
    const customerEmail = cleanEmail(body.customer_email) || cleanEmail(customer?.email);
    const campaignId = cleanText(body.campaign_id, 120) || null;

    const biz = await businessFor(userId);
    if (!isInternal) {
      const subStatus = String(biz.stripe_subscription_status || "").toLowerCase();
      if (subStatus !== "active" && subStatus !== "trialing") throw new AppError("An active Clicktide subscription is required before sending gifts", 402);
    }

    const designUrl = artworkUrl(biz.logo_url);
    if (!designUrl) throw new AppError("Add your logo in Brand Studio before sending a CustomCat gift", 400);
    const typedAddress = normalizeAddress(body.address, customerName, customerEmail);
    if (!addressComplete(typedAddress)) throw new AppError("A complete shipping address is required before sending a gift", 400);

    if (!isInternal && customerId && await autoSentRecently(userId, customerId, row.id)) {
      throw new AppError("This gift was already sent to this customer automatically in the last 24 hours — check Shipments before sending it again.", 409, null);
    }
    const { key, previous } = await sendKey(req, body, { userId, isInternal, campaignId, customerId, catalogId: row.id, address: typedAddress });
    const earlier = await recentClaim(previous, userId);
    if (earlier) return await replayResponse(earlier, userId, previous);
    const claim = await claimSend(key, userId, "customcat", row, customerId, campaignId, giftCost, isInternal ? "auto" : "manual");
    if (!claim.claimed) return await replayResponse(claim, userId, key);
    const attempt = Number(claim.attempt || 1);
    const debitKey = `gift:${key}#${attempt}`;
    const externalId = `ct-${key.slice(0, 24)}-${attempt}`;

    let address: Address;
    try {
      address = await validateShipmentAddress(typedAddress, !isInternal && body.address_override === true);
    } catch (error) {
      await finishClaim(key, attempt, { status: "failed", error: errorText(error) });
      throw error;
    }

    let debit: WalletResult;
    debitStarted = true;
    try {
      debit = await walletApply(userId, -giftCost, "gift_debit", `Gift sent: ${giftName}`, campaignId, debitKey);
    } catch (error) {
      // PostgREST answers 4xx only when the call was rejected and rolled back; after a 5xx
      // (or a gateway timeout) the debit may have committed, so the claim stays pending.
      if (error instanceof AppError && error.status < 500) {
        await finishClaim(key, attempt, { status: "failed", error: `wallet: ${errorText(error)}` });
        console.error("customcat-fulfill: wallet debit refused:", error);
        throw new AppError("The gift wallet is unavailable right now — nothing was charged. Please try again shortly.", 503, NOT_STARTED);
      }
      console.error(`customcat-fulfill: wallet debit outcome unknown for claim ${key}#${attempt}:`, error);
      await finishClaim(key, attempt, { error: `wallet outcome unknown: ${errorText(error)}` });
      throw new AppError("We couldn't confirm the wallet charge. Please don't resend this gift — check your wallet and Shipments in a few minutes.", 503);
    }
    if (!debit.ok) {
      await finishClaim(key, attempt, { status: "failed", error: `wallet: ${debit.reason || "refused"}` });
      if (debit.reason === "insufficient_funds") throw new AppError("Insufficient gift wallet balance", 402, NOT_STARTED);
      throw new AppError("Gift cost is required", 400, NOT_STARTED);
    }
    if (debit.duplicate) {
      console.error(`customcat-fulfill: debit ${debitKey} was already applied; not ordering again`);
      await finishClaim(key, attempt, { error: "debit already applied for this attempt" });
      throw new AppError("This gift is already being sent — check Shipments before sending it again.", 409);
    }

    let order: Record<string, unknown>;
    try {
      order = await createCustomCatOrder(externalId, address, designUrl, sku);
    } catch (error) {
      // A sandbox order never ships, and a 4xx answer means CustomCat refused it, so the
      // debit goes back. A live order with no clear answer may exist: hold it for review
      // rather than refund a gift that could still ship.
      const refused = error instanceof AppError && error.status >= 400 && error.status < 500;
      if (!customcatLive || refused) {
        const refunded = await refundAttempt(userId, giftCost, giftName, campaignId, key, attempt, debitKey, `customcat: ${errorText(error)}`);
        const message = errorText(error) || "CustomCat order failed";
        throw new AppError(refunded ? message : `${message} — your wallet refund is being processed`, error instanceof AppError && error.status >= 400 ? error.status : 502, refunded ? NOT_STARTED : null);
      }
      console.error(`customcat-fulfill: order outcome unknown for claim ${key}#${attempt} (external id ${externalId}):`, error);
      await finishClaim(key, attempt, { error: `customcat outcome unknown: ${errorText(error)}` });
      throw new AppError("We couldn't confirm the order with CustomCat. Please don't resend this gift — we're checking it and will refund your wallet if it didn't go through.", 502);
    }

    const orderId = String(order.CUSTOMCAT_ORDER_ID);
    await finishClaim(key, attempt, { status: "placed", provider_order_id: orderId, error: null });

    let shipment: Record<string, unknown> | null = null;
    try {
      shipment = await recordShipment({
        user_id: userId, merchant_id: userId,
        customer_name: customerName, customer_email: customerEmail || null,
        customer_id: customerId,
        address, gift: giftName, campaign: campaignId,
        status: customcatLive ? "in_production" : "processing",
        platform: "customcat",
        printify_order_id: orderId,
        gift_type: "physical_gift",
        reason: customcatLive ? null : "CustomCat sandbox — not actually fulfilled (set CUSTOMCAT_LIVE=true to ship)",
        idempotency_key: key, gift_catalog_id: row.id,
        wallet_debit_key: debitKey, wallet_debit_amount: giftCost,
      });
      if (shipment?.id) await finishClaim(key, attempt, { shipment_id: shipment.id });
    } catch (error) {
      console.error(`customcat-fulfill: order ${orderId} was placed but its shipment row was not saved (claim ${key}#${attempt}):`, error);
    }

    return json({
      ok: true, shipment,
      customcat_order_id: orderId,
      external_id: externalId,
      wallet_balance: Number(debit.balance ?? 0),
      sandbox: !customcatLive,
      status: customcatLive ? "in_production" : "processing",
    });
  } catch (error) {
    console.error("customcat-fulfill error:", error);
    const status = error instanceof AppError ? error.status : 500;
    const code = error instanceof AppError && error.code !== undefined ? error.code : (debitStarted ? null : NOT_STARTED);
    return json({ error: error instanceof Error ? error.message : "CustomCat fulfillment failed", ...(code ? { code } : {}) }, status);
  }
});
