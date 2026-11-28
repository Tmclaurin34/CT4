// Each business's OWN branded Printify product per gift (2026-11-28).
// Ordering a gift "on the fly" (blueprint + print_areas.front = logo URL) lets Printify place
// the logo at full width, centered, which crops it on totes and ignores the owner's placement.
// Instead, every business gets its own Printify product for each gift, built from the EXACT
// catalog blueprint / provider / variant being ordered, with the owner's saved placement (or a
// sensible default per product), and orders reference that product, so what the owner saw is
// what prints. The product is rebuilt when the logo or the catalog item changes.

export type CatalogLike = {
  id?: string;
  name?: string | null;
  printify_blueprint_id?: string | number | null;
  print_provider_id?: string | number | null;
  printify_variant_id?: string | number | null;
};
type Rest = (path: string, init?: RequestInit) => Promise<any>;
type Printify = (path: string, init?: RequestInit) => Promise<any>;
type Placement = { x: number; y: number; scale: number; angle: number };

export function targetKeyOf(name: unknown): string {
  const n = String(name || "").toLowerCase();
  if (/mug/.test(n)) return "mug";
  if (/tumbler/.test(n)) return "tumbler";
  if (/water bottle|bottle/.test(n)) return "bottle";
  if (/tote|bag/.test(n)) return "tote";
  if (/candle/.test(n)) return "candle";
  if (/notebook/.test(n)) return "notebook";
  if (/sticker/.test(n)) return "stickers";
  if (/sock/.test(n)) return "socks";
  if (/magnet/.test(n)) return "magnet";
  return "";
}

// Done-for-you starting placement (x/y = center of the logo inside the print area, scale =
// logo width as a share of the print area width). Owners can move/resize it in Design Studio.
export const DEFAULT_PLACEMENT: Record<string, Placement> = {
  tote: { x: 0.5, y: 0.25, scale: 0.4, angle: 0 }, // this tote's print area runs below the visible face: y .5 sits on the bottom edge (draft-order test 2026-11-28)
  candle: { x: 0.5, y: 0.5, scale: 0.6, angle: 0 },
  stickers: { x: 0.5, y: 0.5, scale: 1, angle: 0 },
  magnet: { x: 0.5, y: 0.5, scale: 1, angle: 0 },
  mug: { x: 0.5, y: 0.5, scale: 0.35, angle: 0 },
  notebook: { x: 0.5, y: 0.45, scale: 0.5, angle: 0 },
  socks: { x: 0.5, y: 0.4, scale: 0.4, angle: 0 },
  bottle: { x: 0.5, y: 0.5, scale: 0.45, angle: 0 },
  tumbler: { x: 0.5, y: 0.5, scale: 0.45, angle: 0 },
};

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clamp = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

export async function ensureBrandProduct(o: {
  userId: string; row: CatalogLike; logoUrl: string; shopId: string; rest: Rest; printify: Printify; title?: string;
}): Promise<{ productId: string; variantId: number; built: boolean; targetKey: string } | null> {
  const key = targetKeyOf(o.row.name);
  const bp = num(o.row.printify_blueprint_id), pp = num(o.row.print_provider_id), vid = num(o.row.printify_variant_id);
  if (!key || !o.logoUrl || !bp || !pp || !vid) return null;

  const rows = await o.rest(`/rest/v1/brand_products?user_id=eq.${encodeURIComponent(o.userId)}&target_key=eq.${encodeURIComponent(key)}&select=*&limit=1`);
  const cur = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (cur && cur.printify_product_id && cur.logo_url === o.logoUrl && num(cur.blueprint_id) === bp && num(cur.print_provider_id) === pp && num(cur.variant_id) === vid) {
    return { productId: String(cur.printify_product_id), variantId: vid, built: false, targetKey: key };
  }

  const d = DEFAULT_PLACEMENT[key] || { x: 0.5, y: 0.5, scale: 0.5, angle: 0 };
  // Keep the owner's own placement when they set one (rows from Design Studio carry x/y/scale).
  const place: Placement = cur && cur.x != null && cur.scale != null
    ? { x: clamp(cur.x, 0, 1, d.x), y: clamp(cur.y, 0, 1, d.y), scale: clamp(cur.scale, 0.05, 1, d.scale), angle: clamp(cur.angle, -180, 180, 0) }
    : d;

  const upload = await o.printify("/uploads/images.json", { method: "POST", body: JSON.stringify({ file_name: "logo.png", url: o.logoUrl }) });
  const imageId = String(upload?.id || "");
  if (!imageId) throw new Error("Printify did not accept the logo image");

  const vdata = await o.printify(`/catalog/blueprints/${bp}/print_providers/${pp}/variants.json`);
  const variants = (Array.isArray(vdata?.variants) ? vdata.variants : []) as Array<{ id: number; placeholders?: Array<{ position: string }> }>;
  const chosen = variants.find((v) => v.id === vid);
  if (!chosen) throw new Error("This gift's size/color is no longer offered by the printer");
  const positions = (chosen.placeholders || []).map((p) => p.position);
  const position = positions.includes("front") ? "front" : (positions[0] || "front");

  const payload = {
    title: o.title || String(o.row.name || "Branded gift"),
    description: "Branded gift made by Clicktide for this business.",
    tags: ["ct-brand", `ct-user-${o.userId}`],
    blueprint_id: bp,
    print_provider_id: pp,
    variants: [{ id: vid, price: 2999, is_enabled: true }],
    print_areas: [{ variant_ids: [vid], placeholders: [{ position, images: [{ id: imageId, ...place }] }] }],
  };

  let productId = "";
  const canUpdate = cur && cur.printify_product_id && num(cur.blueprint_id) === bp && num(cur.print_provider_id) === pp;
  if (canUpdate) {
    try {
      await o.printify(`/shops/${o.shopId}/products/${encodeURIComponent(String(cur.printify_product_id))}.json`, { method: "PUT", body: JSON.stringify(payload) });
      productId = String(cur.printify_product_id);
    } catch { productId = ""; }
  }
  if (!productId) {
    const p = await o.printify(`/shops/${o.shopId}/products.json`, { method: "POST", body: JSON.stringify(payload) });
    productId = String(p?.id || "");
    if (!productId) throw new Error("Printify did not create the branded product");
  }

  await o.rest("/rest/v1/brand_products", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      user_id: o.userId, target_key: key, printify_product_id: productId, x: place.x, y: place.y, scale: place.scale, angle: place.angle,
      logo_url: o.logoUrl, blueprint_id: bp, print_provider_id: pp, variant_id: vid, mockup_url: "", updated_at: new Date().toISOString(),
    }),
  });
  return { productId, variantId: vid, built: true, targetKey: key };
}
