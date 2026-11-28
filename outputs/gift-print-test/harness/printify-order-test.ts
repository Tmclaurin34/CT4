// TEMPORARY (2026-11-28) admin-only test harness for gift printing. Cron/internal key only.
// Creates Printify orders as DRAFTS and NEVER calls send_to_production, so nothing is printed,
// shipped or billed (Printify bills API orders only after send_to_production). Every test order
// is labeled "CLICKTIDE TEST" and can be cancelled with action "cancel".
// Actions: draft_onthefly {blueprint_id, print_provider_id, variant_id, image_url}
//          draft_product  {product_id, variant_id}
//          get {order_id} | cancel {order_id} | product {product_id}
// To be replaced by a 410 stub after the test.
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const printifyToken = Deno.env.get("PRINTIFY_API_TOKEN") || "";
const shop = Deno.env.get("PRINTIFY_SHOP_ID") || "";
import { ensureBrandProduct } from "../_shared/brand_product.ts";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { "Content-Type": "application/json" } });

async function expectedKey() {
  const r = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_internal_key`, {
    method: "POST", headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" }, body: "{}",
  });
  return r.ok ? String(await r.json() || "") : "";
}
async function pf(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://api.printify.com/v1${path}`, { ...init, headers: { Authorization: `Bearer ${printifyToken}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  const t = await r.text();
  let d: unknown = t;
  try { d = JSON.parse(t); } catch { /* */ }
  return { ok: r.ok, status: r.status, data: d };
}
const ADDRESS = { first_name: "Clicktide", last_name: "Test", email: "support@goclicktide.com", phone: "", country: "US", region: "NY", address1: "P.O. Box 304", address2: "", city: "Glen Cove", zip: "11542" };

Deno.serve(async (req) => {
  const key = req.headers.get("x-clicktide-cron-key") || "";
  const exp = await expectedKey();
  if (!exp || key !== exp) return json({ error: "Unauthorized" }, 401);
  if (!printifyToken || !shop) return json({ error: "Printify not configured" }, 503);
  let b: Record<string, any> = {};
  try { b = await req.json(); } catch { /* */ }
  const a = String(b.action || "");
  const ext = `ct-test-${Date.now()}`;
  if (a === "draft_onthefly") {
    const order = { external_id: ext, label: "CLICKTIDE TEST - DO NOT PRODUCE", shipping_method: 1, send_shipping_notification: false, address_to: ADDRESS,
      line_items: [{ blueprint_id: Number(b.blueprint_id), print_provider_id: Number(b.print_provider_id), variant_id: Number(b.variant_id), quantity: 1, print_areas: { front: String(b.image_url) } }] };
    return json(await pf(`/shops/${shop}/orders.json`, { method: "POST", body: JSON.stringify(order) }));
  }
  if (a === "draft_product") {
    const order = { external_id: ext, label: "CLICKTIDE TEST - DO NOT PRODUCE", shipping_method: 1, send_shipping_notification: false, address_to: ADDRESS,
      line_items: [{ product_id: String(b.product_id), variant_id: Number(b.variant_id), quantity: 1 }] };
    return json(await pf(`/shops/${shop}/orders.json`, { method: "POST", body: JSON.stringify(order) }));
  }
  if (a === "get") return json(await pf(`/shops/${shop}/orders/${encodeURIComponent(String(b.order_id))}.json`));
  if (a === "cancel") return json(await pf(`/shops/${shop}/orders/${encodeURIComponent(String(b.order_id))}/cancel.json`, { method: "POST" }));
  if (a === "product") {
    const r = await pf(`/shops/${shop}/products/${encodeURIComponent(String(b.product_id))}.json`);
    const d = r.data as Record<string, any>;
    if (!r.ok) return json(r);
    return json({ id: d.id, title: d.title, blueprint_id: d.blueprint_id, print_provider_id: d.print_provider_id,
      enabled_variants: (d.variants || []).filter((v: any) => v.is_enabled).map((v: any) => ({ id: v.id, title: v.title, cost: v.cost })),
      print_areas: (d.print_areas || []).map((p: any) => ({ variant_ids: (p.variant_ids || []).length, placeholders: (p.placeholders || []).map((ph: any) => ({ position: ph.position, images: (ph.images || []).map((im: any) => ({ src: String(im.src || "").slice(0, 90), x: im.x, y: im.y, scale: im.scale, angle: im.angle })) })) })),
      images: (d.images || []).slice(0, 2).map((i: any) => i.src) });
  }
  if (a === "ensure_test") {
    // Runs the SAME shared code the gift sender uses, for a throwaway test user id, then drafts
    // (never produces) an order of the resulting product and returns Printify's mockups.
    const rest = async (path: string, init: RequestInit = {}) => {
      const r = await fetch(`${supabaseUrl}${path}`, { ...init, headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json", ...(init.headers || {}) } });
      const t = await r.text(); const d = t ? JSON.parse(t) : null; if (!r.ok) throw new Error(d?.message || r.statusText); return d;
    };
    const printify = async (path: string, init: RequestInit = {}) => { const r = await pf(path, init); if (!r.ok) throw new Error(JSON.stringify(r.data).slice(0, 300)); return r.data as any; };
    const rows = await rest(`/rest/v1/gift_catalog?id=eq.${encodeURIComponent(String(b.catalog_id))}&select=id,name,printify_blueprint_id,print_provider_id,printify_variant_id&limit=1`);
    const row = rows?.[0];
    if (!row) return json({ error: "no catalog row" }, 404);
    try {
      const res = await ensureBrandProduct({ userId: String(b.user_id), row, logoUrl: String(b.logo_url), shopId: shop, rest, printify, title: `CLICKTIDE TEST ${row.name}` });
      if (!res) return json({ error: "ensure returned null" });
      let images: string[] = [];
      for (let i = 0; i < 8 && !images.length; i++) {
        const p = await printify(`/shops/${shop}/products/${res.productId}.json`);
        images = (p.images || []).filter((x: any) => x.is_default || /front/.test(x.position || "")).map((x: any) => x.src).slice(0, 2);
        if (!images.length) await new Promise((r) => setTimeout(r, 2000));
      }
      let orderId = "";
      if (b.draft) {
        const o = await pf(`/shops/${shop}/orders.json`, { method: "POST", body: JSON.stringify({ external_id: ext, label: "CLICKTIDE TEST - DO NOT PRODUCE", shipping_method: 1, send_shipping_notification: false, address_to: ADDRESS, line_items: [{ product_id: res.productId, variant_id: res.variantId, quantity: 1 }] }) });
        orderId = (o.data as any)?.id || JSON.stringify(o.data).slice(0, 200);
      }
      return json({ ...res, images, orderId });
    } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 500); }
  }
  if (a === "delete_product") return json(await pf(`/shops/${shop}/products/${encodeURIComponent(String(b.product_id))}.json`, { method: "DELETE" }));
  return json({ error: "unknown action" }, 400);
});
