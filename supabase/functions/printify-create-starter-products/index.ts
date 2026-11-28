// One-shot admin tool: create starter products in the Printify shop.
// Guarded by the internal cron key or an admin staff session. Uploads the provided
// logo, finds blueprints for a mug / water bottle / tote / notebook, picks the first
// print provider, and creates each product with the logo centered. Products are tagged
// "ct-catalog" so sync-printify-catalog and printify-design-proof can tell shared
// catalog products from per-business proofs.
//
// Two narrower modes (added 2026-11-28 for swapping one catalog gift):
//   {action:"lookup", blueprint_id, design_from_product_id?}
//     read-only: the blueprint's providers, their variants and US first-item shipping,
//     plus the design image ids used by an existing shop product.
//   {action:"create_one", blueprint_id, provider_id, variant_ids:[..], title, description, image_id}
//     creates ONE ct-catalog product with an image already in the Printify library.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const printifyToken = Deno.env.get("PRINTIFY_API_TOKEN") ?? "";
const printifyShopId = Deno.env.get("PRINTIFY_SHOP_ID") ?? "";

const CATALOG_TAG = "ct-catalog";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function expectedKey() {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_internal_key`, {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: "{}",
    });
    return r.ok ? String(await r.json()) : "";
  } catch {
    return "";
  }
}

// Staff check through clicktide_is_staff with the CALLER's own token, so the database's
// staff rules (including any MFA requirement) decide.
async function isStaff(req: Request, roles: string[]) {
  const authorization = req.headers.get("authorization") || "";
  if (!/^bearer\s+\S+/i.test(authorization)) return false;
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_is_staff`, {
      method: "POST",
      headers: { apikey: anonKey || serviceRoleKey, Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ required_roles: roles }),
    });
    if (!r.ok) return false;
    return (await r.json()) === true;
  } catch {
    return false;
  }
}

async function authorized(req: Request) {
  const provided = req.headers.get("x-clicktide-cron-key") || "";
  if (provided && safeEqual(provided, await expectedKey())) return true;
  return await isStaff(req, ["admin"]);
}

async function printify(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://api.printify.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${printifyToken}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const data = parseJson(await r.text());
  if (!r.ok) throw new Error(`${path}: ${data?.errors?.reason || data?.message || data?.error || r.statusText}`);
  return data;
}

function parseJson(text: string) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

type Target = { key: string; title: string; desc: string; match: RegExp; avoid?: RegExp; prefer?: RegExp; price: number };

const TARGETS: Target[] = [
  { key: "stickers", title: "Branded Stickers", desc: "Kiss-cut stickers with your logo — the perfect micro-gift.", match: /kiss[- ]?cut sticker/i, avoid: /sheet|holographic|clear|transparent/i, price: 499 },
  { key: "postcard", title: "Branded Postcards", desc: "Printed postcards with your logo for thank-you notes.", match: /postcard/i, avoid: /aop/i, price: 399 },
  { key: "socks", title: "Branded Crew Socks", desc: "One-size crew socks with your logo — everyone's favorite gift.", match: /crew socks/i, avoid: /baby|toddler|kids|ankle|low/i, price: 1499 },
  { key: "candle", title: "Branded Scented Candle", desc: "Soy candle with your logo label.", match: /candle/i, avoid: /tin|holder/i, prefer: /soy|9oz/i, price: 1999 },
  { key: "tumbler", title: "Branded Tumbler 20oz", desc: "Stainless tumbler with your logo, printed on demand.", match: /tumbler/i, avoid: /kids|wine|aop|12oz/i, prefer: /20\s*oz|skinny/i, price: 2299 },
  { key: "magnet", title: "Branded Magnet", desc: "Die-cut fridge magnet with your logo — daily brand visibility.", match: /magnet/i, avoid: /car|sheet|calendar/i, prefer: /die[- ]?cut|kiss[- ]?cut|round|square/i, price: 599 },
];

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!printifyToken || !printifyShopId) return json({ error: "Printify is not configured" }, 500);
  if (!serviceRoleKey) return json({ error: "Server is not configured" }, 500);

  if (!(await authorized(req))) return json({ error: "Not authorized" }, 401);

  let body: {
    image_base64?: string; file_name?: string; action?: string; blueprint_id?: number; provider_id?: number;
    variant_ids?: number[]; title?: string; description?: string; image_id?: string; design_from_product_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  if (body?.action === "lookup") {
    try {
      const bp = Number(body.blueprint_id || 0);
      if (!bp) return json({ error: "blueprint_id is required" }, 400);
      const providers = await printify(`/catalog/blueprints/${bp}/print_providers.json`) as Array<{ id: number; title: string; location?: { country?: string } }>;
      const out: Record<string, unknown>[] = [];
      for (const pr of providers.slice(0, 12)) {
        const v = await printify(`/catalog/blueprints/${bp}/print_providers/${pr.id}/variants.json`) as { variants?: Array<{ id: number; title: string }> };
        let shipUS: unknown = null;
        try {
          const sh = await printify(`/catalog/blueprints/${bp}/print_providers/${pr.id}/shipping.json`) as { profiles?: Array<{ variant_ids?: number[]; countries?: string[]; first_item?: { cost?: number } }> };
          shipUS = (sh.profiles || []).filter((x) => (x.countries || []).includes("US")).map((x) => ({ variant_ids: x.variant_ids, first_item: (x.first_item?.cost || 0) / 100 }));
        } catch (e) { shipUS = e instanceof Error ? e.message : String(e); }
        out.push({ id: pr.id, title: pr.title, country: pr.location?.country || null, variants: (v.variants || []).map((x) => ({ id: x.id, title: x.title })), ship_us: shipUS });
      }
      let designImages: unknown = null;
      if (body.design_from_product_id) {
        const prod = await printify(`/shops/${printifyShopId}/products/${encodeURIComponent(body.design_from_product_id)}.json`) as { print_areas?: Array<{ placeholders?: Array<{ position: string; images?: Array<{ id: string; x: number; y: number; scale: number; angle: number }> }> }> };
        designImages = (prod.print_areas || []).flatMap((a) => (a.placeholders || []).map((p) => ({ position: p.position, images: p.images })));
      }
      return json({ ok: true, blueprint_id: bp, providers: out, design_images: designImages });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Lookup failed" }, 500);
    }
  }

  if (body?.action === "create_one") {
    try {
      const bp = Number(body.blueprint_id || 0), pid = Number(body.provider_id || 0);
      const wanted = (body.variant_ids || []).map(Number).filter((n) => n > 0);
      if (!bp || !pid || !wanted.length || !body.image_id || !body.title) {
        return json({ error: "blueprint_id, provider_id, variant_ids, image_id and title are required" }, 400);
      }
      const vd = await printify(`/catalog/blueprints/${bp}/print_providers/${pid}/variants.json`) as { variants: Array<{ id: number; title: string; placeholders: Array<{ position: string; width: number; height: number }> }> };
      const variants = (vd.variants || []).filter((v) => wanted.includes(v.id));
      if (!variants.length) return json({ error: "None of those variants exist for this provider" }, 400);
      const ph = variants[0].placeholders?.[0];
      const position = ph?.position || "front";
      const ratio = ph && ph.width > 0 ? ph.height / ph.width : 1;
      const scale = Math.min(1, ratio) * 0.8;
      const product = await printify(`/shops/${printifyShopId}/products.json`, {
        method: "POST",
        body: JSON.stringify({
          title: String(body.title).slice(0, 120),
          description: String(body.description || body.title).slice(0, 500),
          tags: [CATALOG_TAG],
          blueprint_id: bp,
          print_provider_id: pid,
          variants: variants.map((v) => ({ id: v.id, price: 999, is_enabled: true })),
          print_areas: [{ variant_ids: variants.map((v) => v.id), placeholders: [{ position, images: [{ id: body.image_id, x: 0.5, y: 0.5, scale, angle: 0 }] }] }],
        }),
      }) as { id: string; variants?: Array<{ id: number; cost?: number; title?: string; is_enabled?: boolean }> };
      return json({
        ok: true, product_id: product.id,
        variants: (product.variants || []).filter((v) => v.is_enabled).map((v) => ({ id: v.id, title: v.title, cost: (v.cost || 0) / 100 })),
      });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Create failed" }, 500);
    }
  }
  if (!body || typeof body.image_base64 !== "string" || !body.image_base64) return json({ error: "image_base64 is required" }, 400);

  const results: Record<string, unknown>[] = [];
  try {
    // 1. Upload the logo to the Printify media library.
    const upload = await printify("/uploads/images.json", {
      method: "POST",
      body: JSON.stringify({ file_name: String(body.file_name || "clicktide-logo.png").slice(0, 120), contents: body.image_base64 }),
    });
    const imageId = upload.id;

    // 2. Load the blueprint catalog once.
    const blueprints = await printify("/catalog/blueprints.json") as Array<{ id: number; title: string }>;

    for (const target of TARGETS) {
      try {
        const candidates = blueprints.filter((b) =>
          target.match.test(b.title) && !(target.avoid && target.avoid.test(b.title))
        );
        if (!candidates.length) {
          results.push({ key: target.key, error: "No blueprint matched" });
          continue;
        }
        const blueprint = (target.prefer && candidates.find((b) => target.prefer!.test(b.title))) || candidates[0];

        const providers = await printify(`/catalog/blueprints/${blueprint.id}/print_providers.json`) as Array<{ id: number; title: string }>;
        if (!providers.length) {
          results.push({ key: target.key, blueprint: blueprint.title, error: "No print providers" });
          continue;
        }
        const provider = providers[0];

        const variantData = await printify(
          `/catalog/blueprints/${blueprint.id}/print_providers/${provider.id}/variants.json`,
        ) as { variants: Array<{ id: number; title: string; placeholders: Array<{ position: string; width: number; height: number }> }> };
        const variants = variantData.variants || [];
        if (!variants.length) {
          results.push({ key: target.key, blueprint: blueprint.title, error: "No variants" });
          continue;
        }

        const enabledIds = variants.slice(0, 2).map((v) => v.id);
        const ph = variants[0].placeholders?.[0];
        const position = ph?.position || "front";
        // Square logo: scale to fit the shorter side of the print area, at 80%.
        const ratio = ph && ph.width > 0 ? ph.height / ph.width : 1;
        const scale = Math.min(1, ratio) * 0.8;

        const product = await printify(`/shops/${printifyShopId}/products.json`, {
          method: "POST",
          body: JSON.stringify({
            title: target.title,
            description: target.desc,
            tags: [CATALOG_TAG],
            blueprint_id: blueprint.id,
            print_provider_id: provider.id,
            variants: variants.map((v) => ({ id: v.id, price: target.price, is_enabled: enabledIds.includes(v.id) })),
            print_areas: [{
              variant_ids: variants.map((v) => v.id),
              placeholders: [{ position, images: [{ id: imageId, x: 0.5, y: 0.5, scale, angle: 0 }] }],
            }],
          }),
        });

        results.push({
          key: target.key,
          ok: true,
          product_id: product.id,
          blueprint: blueprint.title,
          provider: provider.title,
          enabled_variants: enabledIds.length,
        });
      } catch (e) {
        results.push({ key: target.key, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return json({ ok: true, image_id: imageId, results });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Setup failed", results }, 500);
  }
});
