// Per-business product proof. A logged-in business places its logo on a Printify
// product at a chosen x/y/scale/angle; we create (or update) one branded product
// per business+product and return the REAL Printify mockup. JWT-gated.
//
// POST { target_key, x, y, scale, angle, image_base64? | logo_url? }
//   -> { ok, mockup_url, product_id, target_key }

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const printifyToken = Deno.env.get("PRINTIFY_API_TOKEN") ?? "";
const printifyShopId = Deno.env.get("PRINTIFY_SHOP_ID") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

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

async function authedUserId(req: Request): Promise<string> {
  const authorization = req.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return "";
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: serviceRoleKey, Authorization: authorization } });
  if (!r.ok) return "";
  const user = await r.json();
  return String(user?.id || "");
}

async function printify(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://api.printify.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${printifyToken}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`${path}: ${data?.errors?.reason || data?.message || data?.error || r.statusText}`);
  return data;
}

type Target = { title: string; desc: string; match: RegExp; avoid?: RegExp; prefer?: RegExp; price: number };
const TARGETS: Record<string, Target> = {
  mug: { title: "Branded Mug 11oz", desc: "Ceramic mug with your logo.", match: /mug/i, avoid: /enamel|travel|magic|color/i, prefer: /11\s*oz|white/i, price: 1299 },
  tote: { title: "Branded Tote Bag", desc: "Cotton tote with your logo.", match: /tote/i, avoid: /aop|drawstring/i, price: 1899 },
  bottle: { title: "Branded Water Bottle", desc: "Water bottle with your logo.", match: /water bottle|sports bottle/i, avoid: /kids|aop/i, price: 2399 },
  tumbler: { title: "Branded Tumbler 20oz", desc: "Stainless tumbler with your logo.", match: /tumbler/i, avoid: /kids|wine|aop|12oz/i, prefer: /20\s*oz|skinny/i, price: 2299 },
  candle: { title: "Branded Scented Candle", desc: "Soy candle with your logo label.", match: /candle/i, avoid: /tin|holder/i, prefer: /soy|9oz/i, price: 1999 },
  notebook: { title: "Branded Spiral Notebook", desc: "Spiral notebook with your logo.", match: /spiral notebook|notebook/i, avoid: /hardcover/i, price: 999 },
  stickers: { title: "Branded Stickers", desc: "Kiss-cut stickers with your logo.", match: /kiss[- ]?cut sticker/i, avoid: /sheet|holographic|clear|transparent/i, price: 499 },
  socks: { title: "Branded Crew Socks", desc: "Crew socks with your logo.", match: /crew socks/i, avoid: /baby|toddler|kids|ankle|low/i, price: 1499 },
  magnet: { title: "Branded Magnet", desc: "Die-cut magnet with your logo.", match: /magnet/i, avoid: /car|sheet|calendar/i, prefer: /die[- ]?cut|kiss[- ]?cut|round|square/i, price: 599 },
};

function pickMockup(images: Array<{ src?: string; is_default?: boolean; position?: string }>): string {
  if (!Array.isArray(images) || !images.length) return "";
  const front = images.find((i) => i.is_default) || images.find((i) => /front/i.test(i.position || "")) || images[0];
  return front?.src || "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey) return json({ error: "Server is not configured" }, 500);
  if (!printifyToken || !printifyShopId) return json({ error: "Printify is not configured" }, 500);

  const userId = await authedUserId(req);
  if (!userId) return json({ error: "Not authorized" }, 401);

  let body: { target_key?: string; x?: number; y?: number; scale?: number; angle?: number; image_base64?: string; logo_url?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const target = body.target_key ? TARGETS[body.target_key] : null;
  if (!target) return json({ error: "Unknown product" }, 400);
  if (!body.image_base64 && !body.logo_url) return json({ error: "A logo (image_base64 or logo_url) is required" }, 400);

  const x = clamp(body.x, 0, 1, 0.5);
  const y = clamp(body.y, 0, 1, 0.5);
  const scale = clamp(body.scale, 0.05, 1, 0.8);
  const angle = clamp(body.angle, -180, 180, 0);

  try {
    // 1. Upload the logo to Printify (by URL or base64).
    const upload = await printify("/uploads/images.json", {
      method: "POST",
      body: JSON.stringify(
        body.image_base64
          ? { file_name: "logo.png", contents: body.image_base64 }
          : { file_name: "logo.png", url: body.logo_url },
      ),
    });
    const imageId = upload.id;

    // 2. Resolve a blueprint / print provider / variants for this product.
    const blueprints = await printify("/catalog/blueprints.json") as Array<{ id: number; title: string }>;
    const candidates = blueprints.filter((b) => target.match.test(b.title) && !(target.avoid && target.avoid.test(b.title)));
    if (!candidates.length) return json({ error: "No Printify blueprint matched this product" }, 502);
    const blueprint = (target.prefer && candidates.find((b) => target.prefer!.test(b.title))) || candidates[0];

    const providers = await printify(`/catalog/blueprints/${blueprint.id}/print_providers.json`) as Array<{ id: number; title: string }>;
    if (!providers.length) return json({ error: "No print provider available" }, 502);
    const provider = providers[0];

    const variantData = await printify(`/catalog/blueprints/${blueprint.id}/print_providers/${provider.id}/variants.json`) as {
      variants: Array<{ id: number; title: string; placeholders: Array<{ position: string; width: number; height: number }> }>;
    };
    const variants = variantData.variants || [];
    if (!variants.length) return json({ error: "No variants available" }, 502);
    const position = variants[0].placeholders?.[0]?.position || "front";
    const enabledIds = variants.slice(0, 2).map((v) => v.id);

    const payload = {
      title: target.title,
      description: target.desc,
      blueprint_id: blueprint.id,
      print_provider_id: provider.id,
      variants: variants.map((v) => ({ id: v.id, price: target.price, is_enabled: enabledIds.includes(v.id) })),
      print_areas: [{
        variant_ids: variants.map((v) => v.id),
        placeholders: [{ position, images: [{ id: imageId, x, y, scale, angle }] }],
      }],
    };

    // 3. Reuse one product per business+product: update if it exists, else create.
    const existingRows = await rest(
      `/rest/v1/brand_products?user_id=eq.${encodeURIComponent(userId)}&target_key=eq.${encodeURIComponent(body.target_key!)}&select=printify_product_id&limit=1`,
    );
    const existingId = Array.isArray(existingRows) && existingRows[0] ? existingRows[0].printify_product_id : null;

    let productId: string;
    if (existingId) {
      await printify(`/shops/${printifyShopId}/products/${existingId}.json`, { method: "PUT", body: JSON.stringify(payload) });
      productId = String(existingId);
    } else {
      const product = await printify(`/shops/${printifyShopId}/products.json`, { method: "POST", body: JSON.stringify(payload) });
      productId = String(product.id);
    }

    // 4. Printify renders mockups async — poll the product a few times for them.
    let mockupUrl = "";
    for (let i = 0; i < 5; i++) {
      const p = await printify(`/shops/${printifyShopId}/products/${productId}.json`) as { images?: Array<{ src?: string; is_default?: boolean; position?: string }> };
      mockupUrl = pickMockup(p.images || []);
      if (mockupUrl) break;
      await sleep(1500);
    }

    // 5. Persist the placement + product + mockup for this business.
    await rest("/rest/v1/brand_products", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ user_id: userId, target_key: body.target_key, printify_product_id: productId, x, y, scale, angle, mockup_url: mockupUrl, updated_at: new Date().toISOString() }),
    });

    return json({ ok: true, mockup_url: mockupUrl, product_id: productId, target_key: body.target_key, generating: !mockupUrl });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Proof generation failed" }, 500);
  }
});
