const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
const printifyToken = Deno.env.get("PRINTIFY_API_TOKEN") || "";
const printifyShopId = Deno.env.get("PRINTIFY_SHOP_ID") || "";

// Tags printify-design-proof puts on per-business proof products. Those products live in
// the same Printify shop but must never become shared catalog rows.
const PROOF_TAG = "ct-proof";
const OWNER_TAG_PREFIX = "ct-user-";
// printify-create-starter-products tags shared catalog products. A product only becomes a
// NEW catalog row with this tag; an untagged shop product can only refresh a row that is
// already in gift_catalog. Untagged legacy proofs that no brand_products row points at any
// more (a regenerated or abandoned proof) therefore never reach the shared catalog.
const CATALOG_TAG = "ct-catalog";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-clicktide-cron-key",
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

function parseJson(text: string) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function dollarsFromCents(value: unknown) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round((amount / 100) * 100) / 100;
}

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
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
  const data = parseJson(await response.text());
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

// Staff check through clicktide_is_staff with the CALLER's own token, so the database's
// staff rules (including any MFA requirement) decide, not this function.
async function isStaff(req: Request, roles: string[]) {
  const authorization = req.headers.get("authorization") || "";
  if (!/^bearer\s+\S+/i.test(authorization)) return false;
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_is_staff`, {
      method: "POST",
      headers: { apikey: anonKey || serviceRoleKey, Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ required_roles: roles }),
    });
    if (!response.ok) return false;
    return (await response.json()) === true;
  } catch {
    return false;
  }
}

// Cron key (scripts, pg_cron) or an admin/support staff session.
async function requireCatalogManager(req: Request) {
  const cronKey = req.headers.get("x-clicktide-cron-key") || "";
  if (cronKey && safeEqual(cronKey, await expectedCronKey())) return "cron";
  const authorization = req.headers.get("authorization") || "";
  if (!/^bearer\s+\S+/i.test(authorization)) throw new AppError("Login is required", 401);
  if (await isStaff(req, ["admin", "support"])) return "staff";
  const session = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceRoleKey, Authorization: authorization },
  }).catch(() => null);
  if (!session || !session.ok) throw new AppError("Login is required", 401);
  throw new AppError("Only Clicktide admins and support can sync the gift catalog", 403);
}

async function printify(path: string) {
  const response = await fetch(`https://api.printify.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${printifyToken}`,
      "Content-Type": "application/json",
    },
  });
  const data = parseJson(await response.text());
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

function isTaggedCatalog(product: PrintifyProduct) {
  return Array.isArray(product.tags) && product.tags.some((tag) => String(tag) === CATALOG_TAG);
}

// Printify product ids that already have a gift_catalog row (curated by staff).
async function listedProductIds() {
  const rows = await supabaseFetch("/rest/v1/gift_catalog?printify_product_id=not.is.null&select=printify_product_id");
  return new Set((Array.isArray(rows) ? rows : []).map((row: Record<string, unknown>) => String(row.printify_product_id)));
}

function isTaggedProof(product: PrintifyProduct) {
  const tags = Array.isArray(product.tags) ? product.tags.map((tag) => String(tag)) : [];
  return tags.includes(PROOF_TAG) || tags.some((tag) => tag.startsWith(OWNER_TAG_PREFIX));
}

// Per-business proofs: tagged ones, plus older untagged ones a business references in brand_products.
async function proofProductIds(products: PrintifyProduct[]) {
  const ids = products.map((product) => String(product.id || "")).filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id));
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = await supabaseFetch(
      `/rest/v1/brand_products?printify_product_id=in.(${chunk.join(",")})&select=printify_product_id`,
    );
    for (const row of Array.isArray(rows) ? rows : []) found.add(String(row.printify_product_id));
  }
  for (const product of products) if (isTaggedProof(product)) found.add(String(product.id || ""));
  return found;
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
    await supabaseFetch(`/rest/v1/gift_catalog?id=eq.${encodeURIComponent(String(existing[0].id))}`, {
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

    const caller = await requireCatalogManager(req);
    const params = new URL(req.url).searchParams;
    const dryRun = params.get("dry_run") === "1";

    const response = await printify(`/shops/${printifyShopId}/products.json`);
    const products = (Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : []) as PrintifyProduct[];
    const proofs = await proofProductIds(products);
    const listed = await listedProductIds();
    const notProofs = products.filter((product) => !proofs.has(String(product.id || "")));
    const catalogProducts = notProofs.filter((product) => isTaggedCatalog(product) || listed.has(String(product.id || "")));
    const skippedUntagged = notProofs.length - catalogProducts.length;
    const rows = catalogRows(catalogProducts);

    let created = 0;
    let updated = 0;
    if (!dryRun) {
      for (const row of rows) {
        const result = await upsertCatalogRow(row);
        if (result === "created") created += 1;
        else updated += 1;
      }
    }

    const payload: Record<string, unknown> = {
      ok: true,
      imported: dryRun ? 0 : rows.length,
      created,
      updated,
      skipped_business_proofs: proofs.size,
      skipped_untagged: skippedUntagged,
      message: rows.length
        ? (dryRun ? "Dry run: nothing was written." : "Gift catalog synced from Printify.")
        : `No catalog products were found in the Printify shop. New shop products are imported only when tagged "${CATALOG_TAG}".`,
    };
    if (dryRun) {
      payload.dry_run = true;
      payload.would_import = rows.map((row) => ({
        printify_product_id: row.printify_product_id,
        printify_variant_id: row.printify_variant_id,
        name: row.name,
        estimated_cost: row.estimated_cost,
      }));
    }

    if (caller === "cron" && params.get("debug") === "1") {
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
