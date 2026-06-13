// Read-only margin audit: for each ACTIVE gift_catalog item, compare the listed
// price (estimated_cost = what the business wallet pays) to Printify's real
// product cost + US first-item shipping. Cron-key gated. No data is changed.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const printifyToken = Deno.env.get("PRINTIFY_API_TOKEN") ?? "";
const printifyShopId = Deno.env.get("PRINTIFY_SHOP_ID") ?? "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

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

async function expectedKey() {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_internal_key`, {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: "{}",
    });
    return r.ok ? String(await r.json()) : "";
  } catch { return ""; }
}

async function printify(path: string) {
  const r = await fetch(`https://api.printify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${printifyToken}`, "Content-Type": "application/json" },
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`${path}: ${data?.errors?.reason || data?.message || r.statusText}`);
  return data;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!printifyToken || !printifyShopId) return json({ error: "Printify is not configured" }, 500);
  const provided = req.headers.get("x-clicktide-cron-key") || "";
  const expected = await expectedKey();
  if (!expected || provided !== expected) return json({ error: "Not authorized" }, 401);

  const rows = await rest(
    `/rest/v1/gift_catalog?is_active=eq.true&select=printify_product_id,printify_variant_id,estimated_cost&order=estimated_cost.asc&limit=60`,
  ) as Array<{ printify_product_id: string; printify_variant_id: number; estimated_cost: string | number }>;

  const items: Record<string, unknown>[] = [];
  let totalListed = 0, totalCost = 0;

  for (const row of rows) {
    const listed = Number(row.estimated_cost) || 0;
    try {
      const prod = await printify(`/shops/${printifyShopId}/products/${row.printify_product_id}.json`) as {
        title?: string; blueprint_id?: number; print_provider_id?: number;
        variants?: Array<{ id: number; cost?: number }>;
      };
      const variant = (prod.variants || []).find((v) => v.id === Number(row.printify_variant_id)) || (prod.variants || [])[0];
      const productCost = round2((variant?.cost || 0) / 100);

      let shipUS = 0;
      try {
        const ship = await printify(`/catalog/blueprints/${prod.blueprint_id}/print_providers/${prod.print_provider_id}/shipping.json`) as {
          profiles?: Array<{ variant_ids?: number[]; countries?: string[]; first_item?: { cost?: number } }>;
        };
        const profiles = ship.profiles || [];
        const prof = profiles.find((p) => (p.countries || []).includes("US") && (!(p.variant_ids?.length) || p.variant_ids!.includes(Number(row.printify_variant_id))))
          || profiles.find((p) => (p.countries || []).includes("US"))
          || profiles[0];
        shipUS = round2((prof?.first_item?.cost || 0) / 100);
      } catch (_) { /* shipping lookup best-effort */ }

      const printifyTotal = round2(productCost + shipUS);
      const margin = round2(listed - printifyTotal);
      totalListed += listed; totalCost += printifyTotal;
      items.push({
        name: prod.title || row.printify_product_id,
        listed_price: listed,
        printify_product_cost: productCost,
        printify_us_shipping: shipUS,
        printify_total: printifyTotal,
        your_margin: margin,
        underwater: margin < 0,
      });
    } catch (e) {
      items.push({ name: row.printify_product_id, listed_price: listed, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return json({
    ok: true,
    note: "listed_price = what the business wallet pays. printify_total = Printify product cost + US first-item shipping you are billed. your_margin negative = you lose money on that gift.",
    items,
    totals: { listed: round2(totalListed), printify_cost: round2(totalCost), net_margin: round2(totalListed - totalCost) },
  });
});
