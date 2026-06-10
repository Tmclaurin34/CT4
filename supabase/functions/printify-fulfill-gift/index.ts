const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const printifyToken = Deno.env.get("PRINTIFY_API_TOKEN") || "";
const printifyShopId = Deno.env.get("PRINTIFY_SHOP_ID") || "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

async function createPrintifyOrder(body: Record<string, unknown>, address: Address) {
  if (!printifyToken || !printifyShopId) {
    throw new Error("Printify is not configured");
  }

  const productId = String(body.printify_product_id || "");
  const variantId = Number(body.printify_variant_id || 0);
  if (!productId || !variantId) throw new Error("Printify product and variant are required");

  return printify(`/shops/${printifyShopId}/orders.json`, {
    method: "POST",
    body: JSON.stringify({
      external_id: String(body.campaign_id || crypto.randomUUID()),
      label: String(body.gift_name || "Clicktide gift"),
      line_items: [{
        product_id: productId,
        variant_id: variantId,
        quantity: 1,
      }],
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
    const authUserId = await authedUserId(req);
    const userId = String(body.user_id || body.merchant_id || authUserId || "");
    if (!userId) throw new AppError("Business user id is required", 400);
    if (!authUserId) throw new AppError("Login is required to fulfill gifts", 401);
    if (authUserId !== userId) throw new AppError("Not allowed to fulfill gifts for this business", 403);

    const customerName = String(body.customer_name || "Customer");
    const customerEmail = String(body.customer_email || "");
    const giftName = String(body.gift_name || "Gift");
    const campaignId = body.campaign_id ? String(body.campaign_id) : null;
    const address = normalizeAddress(body.address, customerName, customerEmail);
    const giftCost = dollars(body.gift_cost);

    if (giftCost <= 0) throw new AppError("Gift cost is required", 400);
    const startingBalance = await walletBalance(userId);
    if (startingBalance < giftCost) throw new AppError("Insufficient gift wallet balance", 402);

    const newBalance = await debitWallet(userId, giftCost, `Gift sent: ${giftName}`, campaignId);
    let order: Record<string, unknown>;
    try {
      order = await createPrintifyOrder(body, address);
    } catch (error) {
      await creditWallet(userId, giftCost, error instanceof Error ? error.message : "Printify order failed");
      throw error;
    }

    const shipment = await recordShipment({
      user_id: userId,
      merchant_id: userId,
      customer_name: customerName,
      customer_email: customerEmail || null,
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
      status: "processing",
    });
  } catch (error) {
    console.error("fulfill-gift error:", error);
    const status = error instanceof AppError ? error.status : 500;
    return json({ error: error instanceof Error ? error.message : "Gift fulfillment failed" }, status);
  }
});
