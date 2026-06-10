// Nightly platform sync: pulls new orders from each business's connected
// platform (Square, Shopify, Clover, Stripe) using the stored tokens and
// updates customers' visits / total_spent / last_visit_at — this is what
// makes "your customers flow in automatically" true.
// Runs at 06:00 UTC via pg_cron; cron-key or staff-admin gated.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const stripePlatformKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-clicktide-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Conn = {
  id: string; user_id: string; platform: string; merchant_id: string;
  shop_domain?: string; access_token: string; last_synced_at?: string;
};
type Order = { email?: string; phone?: string; name?: string; amount: number; at: string };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
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

async function expectedCronKey() {
  try { return String(await rest("/rest/v1/rpc/clicktide_internal_key", { method: "POST", body: "{}" }) || ""); }
  catch { return ""; }
}

function normalizePhone(v?: string | null) {
  const s = (v || "").trim();
  if (s.startsWith("+")) return s;
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return "";
}

// ---- per-platform order fetchers (orders since `since`) ----

async function squareOrders(c: Conn, since: string): Promise<Order[]> {
  const h = { Authorization: `Bearer ${c.access_token}`, "Square-Version": "2024-01-18", "Content-Type": "application/json" };
  const locRes = await fetch("https://connect.squareup.com/v2/locations", { headers: h });
  if (!locRes.ok) throw new Error(`square locations ${locRes.status}`);
  const locIds = ((await locRes.json()).locations || []).map((l: { id: string }) => l.id).slice(0, 10);
  if (!locIds.length) return [];
  const oRes = await fetch("https://connect.squareup.com/v2/orders/search", {
    method: "POST", headers: h,
    body: JSON.stringify({
      location_ids: locIds, limit: 100,
      query: { filter: { date_time_filter: { closed_at: { start_at: since } }, state_filter: { states: ["COMPLETED"] } }, sort: { sort_field: "CLOSED_AT" } },
    }),
  });
  if (!oRes.ok) throw new Error(`square orders ${oRes.status}`);
  const orders = (await oRes.json()).orders || [];
  const out: Order[] = [];
  const custCache: Record<string, { email?: string; phone?: string; name?: string }> = {};
  for (const o of orders.slice(0, 100)) {
    let who: { email?: string; phone?: string; name?: string } = {};
    if (o.customer_id) {
      if (!custCache[o.customer_id]) {
        try {
          const cr = await fetch(`https://connect.squareup.com/v2/customers/${o.customer_id}`, { headers: h });
          if (cr.ok) {
            const cu = (await cr.json()).customer || {};
            custCache[o.customer_id] = { email: cu.email_address, phone: cu.phone_number, name: [cu.given_name, cu.family_name].filter(Boolean).join(" ") };
          } else custCache[o.customer_id] = {};
        } catch { custCache[o.customer_id] = {}; }
      }
      who = custCache[o.customer_id];
    }
    if (!who.email && !who.phone) continue;
    out.push({ ...who, amount: (o.total_money?.amount || 0) / 100, at: o.closed_at || o.created_at });
  }
  return out;
}

async function shopifyOrders(c: Conn, since: string): Promise<Order[]> {
  const domain = c.shop_domain || c.merchant_id;
  const r = await fetch(`https://${domain}/admin/api/2024-01/orders.json?status=any&limit=100&created_at_min=${encodeURIComponent(since)}`, {
    headers: { "X-Shopify-Access-Token": c.access_token },
  });
  if (!r.ok) throw new Error(`shopify orders ${r.status}`);
  const orders = (await r.json()).orders || [];
  return orders.map((o: Record<string, never>) => {
    const cu = (o.customer || {}) as Record<string, string>;
    return {
      email: cu.email || (o as Record<string, string>).email,
      phone: cu.phone,
      name: [cu.first_name, cu.last_name].filter(Boolean).join(" "),
      amount: Number((o as Record<string, string>).total_price) || 0,
      at: (o as Record<string, string>).created_at,
    };
  }).filter((x: Order) => x.email || x.phone);
}

async function cloverOrders(c: Conn, since: string): Promise<Order[]> {
  const ts = Date.parse(since);
  const r = await fetch(`https://api.clover.com/v3/merchants/${c.merchant_id}/orders?filter=createdTime>=${ts}&expand=customers&limit=100`, {
    headers: { Authorization: `Bearer ${c.access_token}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`clover orders ${r.status}`);
  const orders = (await r.json()).elements || [];
  const out: Order[] = [];
  for (const o of orders) {
    const cu = o.customers?.elements?.[0];
    if (!cu) continue;
    const email = cu.emailAddresses?.elements?.[0]?.emailAddress;
    const phone = cu.phoneNumbers?.elements?.[0]?.phoneNumber;
    if (!email && !phone) continue;
    out.push({ email, phone, name: [cu.firstName, cu.lastName].filter(Boolean).join(" "), amount: (o.total || 0) / 100, at: new Date(o.createdTime).toISOString() });
  }
  return out;
}

async function stripeOrders(c: Conn, since: string): Promise<Order[]> {
  if (!stripePlatformKey) return [];
  const ts = Math.floor(Date.parse(since) / 1000);
  const r = await fetch(`https://api.stripe.com/v1/charges?limit=100&created[gte]=${ts}`, {
    headers: { Authorization: `Bearer ${stripePlatformKey}`, "Stripe-Account": c.merchant_id },
  });
  if (!r.ok) throw new Error(`stripe charges ${r.status}`);
  const charges = (await r.json()).data || [];
  return charges
    .filter((ch: Record<string, unknown>) => ch.paid && !ch.refunded)
    .map((ch: Record<string, never>) => {
      const bd = (ch.billing_details || {}) as Record<string, string>;
      return { email: bd.email, phone: bd.phone, name: bd.name, amount: ((ch as Record<string, number>).amount || 0) / 100, at: new Date(((ch as Record<string, number>).created || 0) * 1000).toISOString() };
    })
    .filter((x: Order) => x.email || x.phone);
}

// ---- upsert one customer's new activity ----
async function applyOrder(userId: string, o: Order): Promise<"updated" | "created" | "skipped"> {
  const email = (o.email || "").trim().toLowerCase();
  const phone = normalizePhone(o.phone);
  if (!email && !phone) return "skipped";
  const ors: string[] = [];
  if (email) ors.push(`email.ilike.${encodeURIComponent(email)}`);
  if (phone) ors.push(`phone.eq.${encodeURIComponent(phone)}`, `phone.like.*${phone.replace(/\D/g, "").slice(-10)}`);
  const rows = await rest(`/rest/v1/customers?user_id=eq.${userId}&or=(${ors.join(",")})&select=id,visits,total_spent,last_visit_at&limit=1`);
  const ex = Array.isArray(rows) ? rows[0] : null;
  if (ex) {
    const newer = !ex.last_visit_at || Date.parse(o.at) > Date.parse(ex.last_visit_at);
    await rest(`/rest/v1/customers?id=eq.${ex.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        visits: (Number(ex.visits) || 0) + 1,
        total_spent: Math.round(((Number(ex.total_spent) || 0) + o.amount) * 100) / 100,
        ...(newer ? { last_visit_at: o.at, last_order_at: o.at } : {}),
      }),
    });
    return "updated";
  }
  await rest("/rest/v1/customers", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: userId, name: o.name || email || "Customer", email: email || null, phone: phone || null,
      visits: 1, total_spent: o.amount, status: "active", last_visit_at: o.at, last_order_at: o.at, sms_consent: false,
    }),
  });
  return "created";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey) return json({ error: "Server is not configured" }, 500);

  const key = req.headers.get("x-clicktide-cron-key") || "";
  if (!key || key !== await expectedCronKey()) return json({ error: "Not authorized" }, 401);

  const fetchers: Record<string, (c: Conn, s: string) => Promise<Order[]>> = {
    square: squareOrders, shopify: shopifyOrders, clover: cloverOrders, stripe: stripeOrders,
  };

  const conns = await rest(
    "/rest/v1/platform_connections?is_active=eq.true&user_id=not.is.null&select=id,user_id,platform,merchant_id,shop_domain,access_token,last_synced_at&limit=500",
  ) as Conn[];

  const results: Record<string, unknown>[] = [];
  for (const c of conns) {
    const fetcher = fetchers[c.platform];
    if (!fetcher || !c.access_token) { results.push({ platform: c.platform, skipped: "no fetcher or token" }); continue; }
    const since = c.last_synced_at || new Date(Date.now() - 30 * 86400000).toISOString();
    try {
      const orders = await fetcher(c, since);
      let updated = 0, created = 0, capped = 0;
      for (const o of orders) {
        try {
          const res = await applyOrder(c.user_id, o);
          if (res === "updated") updated++;
          if (res === "created") created++;
        } catch (e) {
          if (String(e).includes("PLAN_CUSTOMER_LIMIT_REACHED")) capped++;
        }
      }
      await rest(`/rest/v1/platform_connections?id=eq.${c.id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ last_synced_at: new Date().toISOString() }),
      });
      if (capped) {
        rest("/rest/v1/alerts", {
          method: "POST", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: c.user_id, type: "plan_limit", message: `${capped} new customers from your ${c.platform} sync couldn't be added — your plan's customer limit is reached. Upgrade to keep syncing.`, resolved: false }),
        }).catch(() => {});
      }
      results.push({ platform: c.platform, orders: orders.length, updated, created, capped });
    } catch (e) {
      results.push({ platform: c.platform, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return json({ ok: true, connections: conns.length, results });
});
