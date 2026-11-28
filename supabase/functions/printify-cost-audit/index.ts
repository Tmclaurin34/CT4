// Gift price audit. For each ACTIVE gift_catalog item, compare the listed price
// (estimated_cost = what the business pays, by wallet or Shopify usage) to the real
// Printify product cost + US first-item shipping.
//
// POST {}                      report only (no data changed), same as before
// POST {mode:"apply"}          also moves prices to the pricing rule (nightly cron)
// POST {mode:"apply", dry_run:true}  shows what "apply" would change, changes nothing
//
// Pricing rule (public.gift_price_rules, one row):
//   cost basis = landed x (1 + (tax_pct + fee_pct)/100)
//   target     = cost basis + max(min_margin_usd, landed x min_margin_pct/100), rounded UP to .99
//   raise when the price is below target; lower only when it is more than
//   lower_if_above_usd above target; moves bigger than max_auto_change_pct are reported,
//   not applied. Gifts routed to Gelato or CustomCat are reported but never repriced from
//   Printify's cost. gift_costs.price_locked = report only for that gift.
// Costs are kept in server-only tables (gift_costs, gift_price_changes): gift_catalog is
// publicly readable and businesses must not see Clicktide's margins.
// Changes, blocked moves and errors are emailed to support@goclicktide.com.
// Auth: cron key or an admin/support staff session.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const printifyToken = Deno.env.get("PRINTIFY_API_TOKEN") ?? "";
const printifyShopId = Deno.env.get("PRINTIFY_SHOP_ID") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL") ?? "Clicktide <support@goclicktide.com>";
const ALERT_TO = "support@goclicktide.com";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function parseJson(text: string) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const data = parseJson(await r.text());
  if (!r.ok) throw new Error(data?.message || data?.error || r.statusText);
  return data;
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
  } catch { return ""; }
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
  return await isStaff(req, ["admin", "support"]);
}

async function printify(path: string) {
  const r = await fetch(`https://api.printify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${printifyToken}`, "Content-Type": "application/json" },
  });
  const data = parseJson(await r.text());
  if (!r.ok) throw new Error(`${path}: ${data?.errors?.reason || data?.message || r.statusText}`);
  return data;
}


const round2 = (n: number) => Math.round(n * 100) / 100;
const up99 = (n: number) => round2(Math.ceil(round2(n) + 0.01) - 0.01);

type Rules = {
  tax_pct: number; fee_pct: number; min_margin_usd: number; min_margin_pct: number;
  lower_if_above_usd: number; max_auto_change_pct: number; auto_apply: boolean;
};
const DEFAULT_RULES: Rules = {
  tax_pct: 7, fee_pct: 3, min_margin_usd: 1, min_margin_pct: 10,
  lower_if_above_usd: 2, max_auto_change_pct: 150, auto_apply: true,
};

function targetPrice(landed: number, r: Rules) {
  const basis = landed * (1 + (Number(r.tax_pct) + Number(r.fee_pct)) / 100);
  const margin = Math.max(Number(r.min_margin_usd), landed * Number(r.min_margin_pct) / 100);
  return up99(basis + margin);
}

function esc(v: unknown) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

async function emailSummary(subject: string, lines: string[]) {
  if (!resendApiKey || !lines.length) return { sent: false };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: resendFrom,
        to: [ALERT_TO],
        subject,
        text: lines.join("\n") + "\n\nSent by the nightly gift price audit (printify-cost-audit). Rules: table gift_price_rules. History: table gift_price_changes.",
        html: `<p>${lines.map(esc).join("<br>")}</p><p style="color:#666;font-size:12px">Sent by the nightly gift price audit (printify-cost-audit). Rules: table gift_price_rules. History: table gift_price_changes.</p>`,
      }),
    });
    return { sent: r.ok, status: r.status };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e) };
  }
}

type CatalogRow = {
  id: string; name: string; printify_product_id: string; printify_variant_id: number;
  estimated_cost: string | number; customcat_sku?: string | null; gelato_uid?: string | null;
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!printifyToken || !printifyShopId) return json({ error: "Printify is not configured" }, 500);
  if (!serviceRoleKey) return json({ error: "Server is not configured" }, 500);
  if (!(await authorized(req))) return json({ error: "Not authorized" }, 401);

  let input: { mode?: string; dry_run?: boolean } = {};
  try { input = (await req.json()) || {}; } catch (_) { input = {}; }
  const apply = input.mode === "apply";
  const dryRun = apply && input.dry_run === true;

  let rules: Rules = DEFAULT_RULES;
  try {
    const rr = await rest(`/rest/v1/gift_price_rules?id=eq.1&select=*`) as Rules[];
    if (rr?.[0]) rules = { ...DEFAULT_RULES, ...rr[0] };
  } catch (_) { /* defaults */ }
  const writing = apply && !dryRun && rules.auto_apply !== false;

  const rows = await rest(
    `/rest/v1/gift_catalog?is_active=eq.true&printify_product_id=not.is.null&select=id,name,printify_product_id,printify_variant_id,estimated_cost,customcat_sku,gelato_uid&order=estimated_cost.asc&limit=60`,
  ) as CatalogRow[];

  let locks = new Map<string, boolean>();
  try {
    const lk = await rest(`/rest/v1/gift_costs?select=gift_catalog_id,price_locked`) as Array<{ gift_catalog_id: string; price_locked: boolean }>;
    locks = new Map(lk.map((x) => [x.gift_catalog_id, !!x.price_locked]));
  } catch (_) { /* no locks */ }

  const items: Record<string, unknown>[] = [];
  const mail: string[] = [];
  let totalListed = 0, totalCost = 0;
  const now = new Date().toISOString();

  for (const row of rows) {
    const listed = Number(row.estimated_cost) || 0;
    const provider = row.gelato_uid ? "gelato" : row.customcat_sku ? "customcat" : "printify";
    try {
      const prod = await printify(`/shops/${printifyShopId}/products/${encodeURIComponent(row.printify_product_id)}.json`) as {
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
      const item: Record<string, unknown> = {
        name: row.name || prod.title || row.printify_product_id,
        listed_price: listed,
        printify_product_cost: productCost,
        printify_us_shipping: shipUS,
        printify_total: printifyTotal,
        your_margin: margin,
        underwater: margin < 0,
      };

      if (apply) {
        const complete = productCost > 0 && shipUS > 0;
        const target = complete ? targetPrice(printifyTotal, rules) : 0;
        item.provider = provider;
        item.target_price = target || null;
        let action = "keep";
        let reason = "";
        if (!complete) { action = "skip"; reason = "Printify cost or shipping missing"; }
        else if (provider !== "printify") { action = "report"; reason = `sent through ${provider}, so Printify's cost isn't its real cost`; }
        else if (locks.get(row.id)) { action = "report"; reason = "price is locked"; }
        else if (listed < target) { action = "raise"; reason = `cost $${printifyTotal} (product $${productCost} + shipping $${shipUS}) needs $${target}`; }
        else if (listed > round2(target + Number(rules.lower_if_above_usd))) { action = "lower"; reason = `cost fell to $${printifyTotal}; $${target} still covers it`; }
        if ((action === "raise" || action === "lower") && listed > 0) {
          const pct = Math.abs(target - listed) / listed * 100;
          if (pct > Number(rules.max_auto_change_pct)) { reason += ` (a ${Math.round(pct)}% move is too big to apply automatically)`; action = "blocked"; }
        }
        item.action = action;
        if (reason) item.reason = reason;

        if (writing) {
          let applied = false;
          if (action === "raise" || action === "lower") {
            // Only change it if nobody else changed it since we read it.
            const upd = await rest(`/rest/v1/gift_catalog?id=eq.${encodeURIComponent(row.id)}&estimated_cost=eq.${listed}`, {
              method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ estimated_cost: target, updated_at: now }),
            }) as unknown[];
            applied = Array.isArray(upd) && upd.length === 1;
            item.applied = applied;
            if (!applied) item.reason = `${reason}; not applied because the price changed while the audit ran`;
          }
          if (action === "raise" || action === "lower" || action === "blocked") {
            await rest(`/rest/v1/gift_price_changes`, {
              method: "POST", headers: { Prefer: "return=minimal" },
              body: JSON.stringify({ gift_catalog_id: row.id, gift_name: item.name, old_price: listed, new_price: target, landed_cost: printifyTotal, provider, reason: item.reason, applied }),
            });
          }
          await rest(`/rest/v1/gift_costs?on_conflict=gift_catalog_id`, {
            method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({
              gift_catalog_id: row.id, provider, cost_product: productCost, cost_shipping: shipUS, landed_cost: printifyTotal,
              target_price: target || null, checked_at: now, check_error: complete ? null : "cost or shipping missing",
              ...(applied ? { price_auto_at: now } : {}),
            }),
          });
          if (applied) mail.push(`${action === "raise" ? "RAISED" : "LOWERED"} ${item.name}: $${listed} -> $${target}. ${reason}.`);
        }
        if (action === "blocked") mail.push(`NOT CHANGED, needs you: ${item.name} at $${listed}, rule says $${target}. ${item.reason}.`);
        if (action === "report" && margin < 0) mail.push(`LOSING MONEY, not auto-fixed: ${item.name} at $${listed} costs $${printifyTotal} on Printify (${reason}).`);
        if (action === "skip") mail.push(`COULD NOT CHECK: ${item.name}. ${reason}.`);
      }
      items.push(item);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      items.push({ name: row.name || row.printify_product_id, listed_price: listed, error: msg });
      if (apply) {
        mail.push(`COULD NOT CHECK: ${row.name}. ${msg}`);
        if (writing) {
          try {
            await rest(`/rest/v1/gift_costs?on_conflict=gift_catalog_id`, {
              method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
              body: JSON.stringify({ gift_catalog_id: row.id, provider, checked_at: now, check_error: msg.slice(0, 500) }),
            });
          } catch (_) { /* best effort */ }
        }
      }
    }
  }

  const email = writing && mail.length
    ? await emailSummary(`Clicktide gift prices: ${mail.length} item${mail.length === 1 ? "" : "s"} to know about`, mail)
    : { sent: false };

  return json({
    ok: true,
    mode: apply ? (dryRun ? "apply (dry run, nothing changed)" : writing ? "apply" : "apply (auto_apply is off, nothing changed)") : "report",
    note: "listed_price = what the business pays for the gift. printify_total = Printify product cost + US first-item shipping you are billed. your_margin negative = you lose money on that gift.",
    rules: apply ? rules : undefined,
    items,
    totals: { listed: round2(totalListed), printify_cost: round2(totalCost), net_margin: round2(totalListed - totalCost) },
    alerts: apply ? mail : undefined,
    email,
  });
});
