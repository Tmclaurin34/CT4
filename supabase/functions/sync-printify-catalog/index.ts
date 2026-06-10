const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const printifyToken = Deno.env.get("PRINTIFY_API_TOKEN") || "";
const printifyShopId = Deno.env.get("PRINTIFY_SHOP_ID") || "";
const syncSecret = Deno.env.get("SYNC_PRINTIFY_CATALOG_KEY") || "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

class AppError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

type PrintifyVariant = {
  id?: number;
  title?: string;
  price?: number;
  cost?: number;
  is_enabled?: boolean;
  is_available?: boolean;
};

type PrintifyProduct = {
  id?: string;
  title?: string;
  description?: string;
  tags?: string[];
  images?: Array<{ src?: string; is_default?: boolean }>;
  variants?: PrintifyVariant[];
  blueprint_id?: number | string;
  print_provider_id?: number | string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function dollarsFromCents(value: unknown) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round((amount / 100) * 100) / 100;
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

async function authedUser(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return null;
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: authorization,
    },
  });
  if (!response.ok) return null;
  return await response.json();
}

async function requireCatalogManager(req: Request) {
  const user = await authedUser(req);
  if (!user?.id) throw new AppError("Login is required", 401);
  const rows = await supabaseFetch(
    `/rest/v1/clicktide_staff?select=role,is_active&user_id=eq.${encodeURIComponent(user.id)}&is_active=eq.true&role=in.(admin,support)`,
  );
  if (!Array.isArray(rows) || !rows.length) {
    throw new AppError("Only Clicktide admins and support can sync the gift catalog", 403);
  }
  return user;
}

async function printify(path: string) {
  const response = await fetch(`https://api.printify.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${printifyToken}`,
      "Content-Type": "application/json",
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

function categoryFor(product: PrintifyProduct) {
  const raw = `${product.title || ""} ${(product.tags || []).join(" ")}`.toLowerCase();
  if (/(shirt|hoodie|sweatshirt|tank|apparel)/.test(raw)) return "apparel";
  if (/(mug|tumbler|bottle|drink)/.test(raw)) return "drinkware";
  if (/(tote|bag|backpack)/.test(raw)) return "bags";
  if (/(hat|cap|beanie)/.test(raw)) return "accessories";
  if (/(notebook|journal|pen|stationery)/.test(raw)) return "stationery";
  return "general";
}

function imageFor(product: PrintifyProduct) {
  const images = product.images || [];
  return images.find((image) => image.is_default)?.src || images[0]?.src || "";
}

function catalogRows(products: PrintifyProduct[]) {
  const rows: Record<string, unknown>[] = [];
  for (const product of products) {
    const variants = (product.variants || []).filter((variant) => variant.id && variant.is_enabled !== false);
    const preferred = variants.find((variant) => variant.is_available !== false) || variants[0];
    if (!product.id || !preferred?.id) continue;

    rows.push({
      name: product.title || "Printify gift",
      subtitle: preferred.title || product.description || "Print-on-demand gift",
      category: categoryFor(product),
      image_url: imageFor(product) || null,
      estimated_cost: dollarsFromCents(preferred.cost || preferred.price),
      currency: "USD",
      printify_product_id: product.id,
      printify_variant_id: preferred.id,
      printify_blueprint_id: product.blueprint_id ? String(product.blueprint_id) : null,
      print_provider_id: product.print_provider_id ? String(product.print_provider_id) : null,
      is_active: true,
      source: "printify",
      raw: product,
    });
  }
  return rows;
}

async function upsertCatalogRow(row: Record<string, unknown>) {
  const productId = encodeURIComponent(String(row.printify_product_id));
  const variantId = encodeURIComponent(String(row.printify_variant_id));
  const existing = await supabaseFetch(
    `/rest/v1/gift_catalog?select=id&printify_product_id=eq.${productId}&printify_variant_id=eq.${variantId}&limit=1`,
  );

  if (Array.isArray(existing) && existing[0]?.id) {
    await supabaseFetch(`/rest/v1/gift_catalog?id=eq.${existing[0].id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
    });
    return "updated";
  }

  await supabaseFetch("/rest/v1/gift_catalog", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  return "created";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    if (!serviceRoleKey) throw new AppError("Supabase service role is not configured", 500);
    if (!printifyToken || !printifyShopId) throw new AppError("Printify is not configured", 500);

    const providedSyncSecret = req.headers.get("x-clicktide-sync-key") || "";
    const hasSyncSecret = Boolean(syncSecret && providedSyncSecret === syncSecret);
    if (!hasSyncSecret) await requireCatalogManager(req);

    const response = await printify(`/shops/${printifyShopId}/products.json`);
    const products = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
    const rows = catalogRows(products);

    let created = 0;
    let updated = 0;
    for (const row of rows) {
      const result = await upsertCatalogRow(row);
      if (result === "created") created += 1;
      else updated += 1;
    }

    const payload: Record<string, unknown> = {
      ok: true,
      imported: rows.length,
      created,
      updated,
      message: rows.length
        ? "Gift catalog synced from Printify."
        : "No active Printify shop products were found. Add products in Printify, then sync again.",
    };

    if (hasSyncSecret && new URL(req.url).searchParams.get("debug") === "1") {
      const shops = await printify("/shops.json");
      payload.debug = {
        configured_shop_id: printifyShopId,
        product_count: products.length,
        raw_product_titles: products.slice(0, 10).map((product: PrintifyProduct) => product.title || product.id),
        available_shops: (Array.isArray(shops) ? shops : []).map((shop: Record<string, unknown>) => ({
          id: shop.id,
          title: shop.title,
          sales_channel: shop.sales_channel,
        })),
      };
    }

    return json(payload);
  } catch (error) {
    console.error("sync-printify-catalog error:", error);
    const status = error instanceof AppError ? error.status : 500;
    return json({ error: error instanceof Error ? error.message : "Could not sync gift catalog" }, status);
  }
});
