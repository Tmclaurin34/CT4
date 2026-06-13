const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const printifyToken = Deno.env.get("PRINTIFY_API_TOKEN") || "";
const printifyShopId = Deno.env.get("PRINTIFY_SHOP_ID") || "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-clicktide-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Address = {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  country?: string;
  region?: string;
  address1?: string;
  address2?: string;
  city?: string;
  zip?: string;
};

class AppError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
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

async function validateShipmentAddress(address: Address, skipValidator = false) {
  if (!addressComplete(address)) {
    throw new AppError("A complete shipping address is required before sending a gift", 400);
  }
  if (skipValidator) return address; // owner explicitly confirmed the address as typed
  const response = await fetch(`${supabaseUrl}/functions/v1/validate-address`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      address: address.address1,
      city: address.city,
      state: address.region,
      zip: address.zip,
    }),
  });
  const data = await response.json().catch(() => ({}));
  // Only a DEFINITE mismatch blocks shipping. A validator outage (valid:null,
  // non-OK response) must never take gift fulfillment down with it — the
  // address already passed the structural completeness check above.
  if (response.ok && data?.valid === false) {
    throw new AppError(data?.error || "Shipping address could not be verified", 400);
  }
  if (!response.ok || data?.valid !== true) return address; // validator unavailable — ship as typed
  const normalized = data?.normalized || {};
  return {
    ...address,
    address1: String(normalized.address1 || address.address1 || "").trim(),
    city: String(normalized.city || address.city || "").trim(),
    region: String(normalized.region || address.region || "").trim(),
    zip: String(normalized.zip || address.zip || "").trim(),
    country: String(normalized.country || address.country || "US").trim() || "US",
  };
}

async function supabaseFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data?.message || data?.error || response.statusText;
    throw new AppError(message, response.status);
  }
  return data;
}

async function expectedCronKey() {
  try {
    const data = await supabaseFetch("/rest/v1/rpc/clicktide_internal_key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return String(data || "");
  } catch {
    return "";
  }
}

async function authedUserId(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return "";
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: authorization,
    },
  });
  if (!response.ok) return "";
  const user = await response.json();
  return String(user?.id || "");
}

async function walletBalance(userId: string) {
  const data = await supabaseFetch("/rest/v1/rpc/clicktide_wallet_balance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: userId }),
  });
  return Number(data || 0);
}

async function debitWallet(userId: string, amount: number, description: string, reference: string | null) {
  const data = await supabaseFetch("/rest/v1/rpc/clicktide_debit_gift_wallet_server", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: userId,
      debit_amount: amount,
      description,
      reference,
    }),
  });
  return Number(data || 0);
}

async function creditWallet(userId: string, amount: number, note: string) {
  const balance = await walletBalance(userId);
  await supabaseFetch("/rest/v1/wallet", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: userId,
      desc: "Gift wallet reversal",
      amount,
      balance: balance + amount,
      transaction_type: "reversal",
      status: "posted",
      note,
    }),
  });
}

async function printify(path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.printify.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${printifyToken}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data?.errors?.reason || data?.message || data?.error || response.statusText;
    throw new AppError(message, response.status);
  }
  return data;
}

// Resolve the business's saved logo (clicktide.logo_url) when the request
// doesn't carry one.
async function businessLogoUrl(userId: string) {
  try {
    const rows = await supabaseFetch(
      `/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}&select=logo_url&limit=1`,
    );
    return Array.isArray(rows) && rows[0]?.logo_url ? String(rows[0].logo_url) : "";
  } catch {
    return "";
  }
}

// Build the order line item. With a business logo we place an ad-hoc print
// order (blueprint + provider + variant + the logo as the print file), so the
// gift ships with the BUSINESS's branding. Without one we fall back to the
// catalog product as designed.
async function buildLineItem(body: Record<string, unknown>, logoUrl: string) {
  const productId = String(body.printify_product_id || "");
  const variantId = Number(body.printify_variant_id || 0);
  if (!productId || !variantId) throw new AppError("Printify product and variant are required", 400);

  if (logoUrl) {
    try {
      const rows = await supabaseFetch(
        `/rest/v1/gift_catalog?printify_product_id=eq.${encodeURIComponent(productId)}&select=printify_blueprint_id,print_provider_id&limit=1`,
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      const blueprintId = Number(row?.printify_blueprint_id || 0);
      const providerId = Number(row?.print_provider_id || 0);
      if (blueprintId && providerId) {
        return {
          blueprint_id: blueprintId,
          print_provider_id: providerId,
          variant_id: variantId,
          quantity: 1,
          print_areas: { front: logoUrl },
        };
      }
    } catch (_) { /* fall back to the catalog design */ }
  }

  return { product_id: productId, variant_id: variantId, quantity: 1 };
}

async function createPrintifyOrder(body: Record<string, unknown>, address: Address, logoUrl: string) {
  if (!printifyToken || !printifyShopId) {
    throw new Error("Printify is not configured");
  }
  const lineItem = await buildLineItem(body, logoUrl);

  return printify(`/shops/${printifyShopId}/orders.json`, {
    method: "POST",
    body: JSON.stringify({
      external_id: String(body.campaign_id || crypto.randomUUID()),
      label: String(body.gift_name || "Clicktide gift"),
      line_items: [lineItem],
      shipping_method: 1,
      send_shipping_notification: false,
      address_to: address,
    }),
  });
}

async function recordShipment(fields: Record<string, unknown>) {
  const rows = await supabaseFetch("/rest/v1/shipments", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(fields),
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey) return json({ error: "Supabase service role is not configured" }, 500);

  try {
    const body = await req.json() as Record<string, unknown>;

    // Auth: the business owner's JWT, or the internal cron key (campaign-runner
    // auto-send when the business has gift_auto_send enabled).
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

    // The wallet debit is derived SERVER-SIDE from the gift catalog. The
    // client-supplied gift_cost can only raise the charge, never undercut it —
    // otherwise a tampered request ships a $24.50 gift while debiting pennies.
    const productIdForCost = String(body.printify_product_id || "");
    if (!productIdForCost) throw new AppError("Printify product is required", 400);
    const catRows = await supabaseFetch(
      `/rest/v1/gift_catalog?printify_product_id=eq.${encodeURIComponent(productIdForCost)}&select=estimated_cost,is_active&limit=1`,
    );
    const catalogRow = Array.isArray(catRows) ? catRows[0] : null;
    if (!catalogRow) throw new AppError("Unknown gift product — choose a gift from the catalog", 400);
    if (catalogRow.is_active === false && !isInternal) {
      throw new AppError("This gift is no longer available — choose another from the catalog", 400);
    }
    const giftCost = Math.max(dollars(body.gift_cost), dollars(catalogRow.estimated_cost));

    // Manual sends require an active or trialing subscription — the dashboard
    // checks this too, but the server is the enforcement point.
    if (!isInternal) {
      const bizRows = await supabaseFetch(
        `/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}&select=stripe_subscription_status&limit=1`,
      );
      const subStatus = String((Array.isArray(bizRows) ? bizRows[0] : null)?.stripe_subscription_status || "").toLowerCase();
      if (subStatus !== "active" && subStatus !== "trialing") {
        throw new AppError("An active Clicktide subscription is required before sending gifts", 402);
      }
    }

    // Business branding: request logo wins, then the saved profile logo.
    const logoUrl = String(body.logo_url || "") || await businessLogoUrl(userId);

    if (giftCost <= 0) throw new AppError("Gift cost is required", 400);
    const startingBalance = await walletBalance(userId);
    if (startingBalance < giftCost) throw new AppError("Insufficient gift wallet balance", 402);

    const newBalance = await debitWallet(userId, giftCost, `Gift sent: ${giftName}`, campaignId);
    let order: Record<string, unknown>;
    try {
      order = await createPrintifyOrder(body, address, logoUrl);
    } catch (error) {
      await creditWallet(userId, giftCost, error instanceof Error ? error.message : "Printify order failed");
      throw error;
    }

    const shipment = await recordShipment({
      user_id: userId,
      merchant_id: userId,
      customer_name: customerName,
      customer_email: customerEmail || null,
      customer_id: body.customer_id ? Number(body.customer_id) : null,
      address,
      gift: giftName,
      campaign: campaignId,
      status: "processing",
      platform: "printify",
      printify_order_id: order.id ? String(order.id) : null,
      gift_type: "physical_gift",
    });

    return json({
      ok: true,
      shipment,
      printify_order_id: order.id || null,
      wallet_balance: newBalance,
      branded_with: logoUrl ? "business_logo" : "catalog_design",
      status: "processing",
    });
  } catch (error) {
    console.error("fulfill-gift error:", error);
    const status = error instanceof AppError ? error.status : 500;
    return json({ error: error instanceof Error ? error.message : "Gift fulfillment failed" }, status);
  }
});
