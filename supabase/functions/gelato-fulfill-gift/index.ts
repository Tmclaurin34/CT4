// Clicktide → Gelato gift fulfillment. Mirrors customcat-fulfill-gift / printify-fulfill-gift
// (same custom auth, address validation, server-derived wallet debit, refund-on-failure,
// shipment record) but routes the order to Gelato's API. The DESIGN that prints is the
// business's logo_url (a public PNG from the Design Studio) sent as the item file url; the
// product is gift_catalog.gelato_uid. Defaults to a DRAFT order (created but NOT produced or
// charged) unless GELATO_LIVE=true, so nothing real ships until you flip it on.
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const gelatoKey = Deno.env.get("GELATO_API_KEY") || "";
const gelatoLive = (Deno.env.get("GELATO_LIVE") || "").toLowerCase() === "true";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-clicktide-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Address = {
  first_name?: string; last_name?: string; email?: string; phone?: string;
  country?: string; region?: string; address1?: string; address2?: string; city?: string; zip?: string;
};

class AppError extends Error {
  status: number;
  constructor(message: string, status = 500) { super(message); this.status = status; }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function dollars(value: unknown) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

function normalizeAddress(raw: unknown, customerName: string, customerEmail: string): Address {
  const a = (raw || {}) as Record<string, unknown>;
  const parts = customerName.trim().split(/\s+/);
  return {
    first_name: String(a.first_name || a.firstName || parts[0] || "Customer"),
    last_name: String(a.last_name || a.lastName || parts.slice(1).join(" ") || "Gift"),
    email: String(a.email || customerEmail || "support@goclicktide.com"),
    phone: String(a.phone || ""),
    country: String(a.country || "US"),
    region: String(a.region || a.state || ""),
    address1: String(a.address1 || a.line1 || a.street || ""),
    address2: String(a.address2 || a.line2 || ""),
    city: String(a.city || ""),
    zip: String(a.zip || a.postal_code || a.postalCode || ""),
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
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
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
      address1: String(n.address1 || address.address1 || "").trim(),
      city: String(n.city || address.city || "").trim(),
      region: String(n.region || address.region || "").trim(),
      zip: String(n.zip || address.zip || "").trim(),
      country: String(n.country || address.country || "US").trim() || "US",
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

async function walletBalance(userId: string) {
  const data = await supabaseFetch("/rest/v1/rpc/clicktide_wallet_balance", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: userId }),
  });
  return Number(data || 0);
}

async function debitWallet(userId: string, amount: number, description: string, reference: string | null) {
  const data = await supabaseFetch("/rest/v1/rpc/clicktide_debit_gift_wallet_server", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: userId, debit_amount: amount, description, reference }),
  });
  return Number(data || 0);
}

async function creditWallet(userId: string, amount: number, note: string) {
  const balance = await walletBalance(userId);
  await supabaseFetch("/rest/v1/wallet", {
    method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ user_id: userId, desc: "Gift wallet reversal", amount, balance: balance + amount, transaction_type: "reversal", status: "posted", note }),
  });
}

async function recordShipment(fields: Record<string, unknown>) {
  const rows = await supabaseFetch("/rest/v1/shipments", {
    method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(fields),
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function businessLogoUrl(userId: string) {
  try {
    const rows = await supabaseFetch(`/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}&select=logo_url&limit=1`);
    return Array.isArray(rows) && rows[0]?.logo_url ? String(rows[0].logo_url) : "";
  } catch { return ""; }
}

async function createGelatoOrder(externalId: string, address: Address, designUrl: string, productUid: string) {
  if (!gelatoKey) throw new AppError("Gelato is not configured (missing GELATO_API_KEY secret)", 500);
  if (!productUid) throw new AppError("This gift has no Gelato product mapped", 400);
  if (!designUrl) throw new AppError("A branded design (logo) is required to fulfill via Gelato", 400);
  const payload = {
    orderType: gelatoLive ? "order" : "draft",
    orderReferenceId: externalId,
    customerReferenceId: "clicktide",
    currency: "USD",
    items: [{
      itemReferenceId: "1",
      productUid: String(productUid),
      files: [{ type: "default", url: designUrl }],
      quantity: 1,
    }],
    shippingAddress: {
      firstName: address.first_name, lastName: address.last_name,
      addressLine1: address.address1, addressLine2: address.address2 || "",
      city: address.city, state: address.region, postCode: address.zip,
      country: address.country || "US",
      email: address.email || "support@goclicktide.com",
      phone: address.phone || "",
    },
  };
  const resp = await fetch("https://order.gelatoapis.com/v4/orders", {
    method: "POST", headers: { "X-API-KEY": gelatoKey, "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let data: Record<string, unknown> = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-json */ }
  if (!resp.ok || !data?.id) {
    const detail = Array.isArray((data as Record<string, unknown>)?.details)
      ? JSON.stringify((data as Record<string, unknown>).details) : "";
    throw new AppError(String((data as Record<string, unknown>)?.message || `Gelato order failed (${resp.status}) ${detail}`), resp.status || 500);
  }
  return data; // { id, fulfillmentStatus, orderType, ... }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey) return json({ error: "Supabase service role is not configured" }, 500);

  try {
    const body = await req.json() as Record<string, unknown>;

    const cronKey = req.headers.get("x-clicktide-cron-key") || "";
    const isInternal = !!cronKey && cronKey === await expectedCronKey();
    const authUserId = isInternal ? "" : await authedUserId(req);
    const userId = String(body.user_id || body.merchant_id || authUserId || "");
    if (!userId) throw new AppError("Business user id is required", 400);
    if (!isInternal) {
      if (!authUserId) throw new AppError("Login is required to fulfill gifts", 401);
      if (authUserId !== userId) throw new AppError("Not allowed to fulfill gifts for this business", 403);
    }

    const customerName = String(body.customer_name || "Customer");
    const customerEmail = String(body.customer_email || "");
    const giftName = String(body.gift_name || "Gift");
    const campaignId = body.campaign_id ? String(body.campaign_id) : null;
    const address = await validateShipmentAddress(
      normalizeAddress(body.address, customerName, customerEmail),
      !isInternal && body.address_override === true,
    );

    const productKey = String(body.printify_product_id || body.gift_catalog_id || "");
    if (!productKey) throw new AppError("Gift product is required", 400);
    const catRows = await supabaseFetch(
      `/rest/v1/gift_catalog?or=(printify_product_id.eq.${encodeURIComponent(productKey)},id.eq.${encodeURIComponent(productKey)})&select=estimated_cost,is_active,gelato_uid&limit=1`,
    );
    const catalogRow = Array.isArray(catRows) ? catRows[0] : null;
    if (!catalogRow) throw new AppError("Unknown gift product — choose a gift from the catalog", 400);
    if (catalogRow.is_active === false && !isInternal) throw new AppError("This gift is no longer available", 400);
    const productUid = String(body.gelato_uid || catalogRow.gelato_uid || "");
    if (!productUid) throw new AppError("This gift isn't set up for Gelato fulfillment yet", 400);
    const giftCost = Math.max(dollars(body.gift_cost), dollars(catalogRow.estimated_cost));

    if (!isInternal) {
      const bizRows = await supabaseFetch(`/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}&select=stripe_subscription_status&limit=1`);
      const subStatus = String((Array.isArray(bizRows) ? bizRows[0] : null)?.stripe_subscription_status || "").toLowerCase();
      if (subStatus !== "active" && subStatus !== "trialing") throw new AppError("An active Clicktide subscription is required before sending gifts", 402);
    }

    const designUrl = String(body.design_url || body.logo_url || "") || await businessLogoUrl(userId);
    if (!designUrl) throw new AppError("Add your logo/design in the Design Studio before sending a Gelato gift", 400);

    if (giftCost <= 0) throw new AppError("Gift cost is required", 400);
    const startingBalance = await walletBalance(userId);
    if (startingBalance < giftCost) throw new AppError("Insufficient gift wallet balance", 402);

    const externalId = `ct-${campaignId || "gift"}-${Date.now()}`;
    const newBalance = await debitWallet(userId, giftCost, `Gift sent: ${giftName}`, campaignId);
    let order: Record<string, unknown>;
    try {
      order = await createGelatoOrder(externalId, address, designUrl, productUid);
    } catch (error) {
      await creditWallet(userId, giftCost, error instanceof Error ? error.message : "Gelato order failed");
      throw error;
    }

    const shipment = await recordShipment({
      user_id: userId, merchant_id: userId,
      customer_name: customerName, customer_email: customerEmail || null,
      customer_id: body.customer_id ? Number(body.customer_id) : null,
      address, gift: giftName, campaign: campaignId,
      status: gelatoLive ? "in_production" : "processing",
      platform: "gelato",
      printify_order_id: order.id ? String(order.id) : null,
      gift_type: "physical_gift",
      reason: gelatoLive ? null : "Gelato draft — not actually fulfilled (set GELATO_LIVE=true to ship)",
    });

    return json({
      ok: true, shipment,
      gelato_order_id: order.id || null,
      external_id: externalId,
      wallet_balance: newBalance,
      draft: !gelatoLive,
      status: gelatoLive ? "in_production" : "processing",
    });
  } catch (error) {
    console.error("gelato-fulfill error:", error);
    const status = error instanceof AppError ? error.status : 500;
    return json({ error: error instanceof Error ? error.message : "Gelato fulfillment failed" }, status);
  }
});
