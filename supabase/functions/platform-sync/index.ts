// Platform sync: pulls orders from each business's connected platform
// (Square, Shopify, Clover, Stripe) and updates customers' visits /
// total_spent / last_visit_at — and now mailing addresses too, when the
// platform has them (Shopify shipping address, Square customer address,
// Stripe billing/shipping, Clover customer addresses). Imported addresses
// never overwrite one a customer confirmed themselves via /gift-address.
// Runs nightly via pg_cron (cron key), or on demand by a logged-in business
// for their own connections (JWT). First sync backfills 365 days, paginated.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const stripePlatformKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

const FIRST_SYNC_DAYS = 365;
const MAX_PAGES = 10; // per connection per run; caps runtime on huge merchants

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-clicktide-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Conn = {
  id: string; user_id: string; platform: string; merchant_id: string;
  shop_domain?: string; access_token: string; last_synced_at?: string;
};
type Addr = { address?: string; city?: string; state?: string; zip?: string };
type Order = { email?: string; phone?: string; name?: string; amount: number; at: string; addr?: Addr };

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

async function authedUserId(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return "";
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceRoleKey, Authorization: authorization },
  });
  if (!r.ok) return "";
  const user = await r.json();
  return String(user?.id || "");
}

function normalizePhone(v?: string | null) {
  const s = (v || "").trim();
  if (s.startsWith("+")) return s;
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return "";
}

// Build a usable US mailing address or nothing — partial addresses can't be mailed.
function cleanAddr(line1?: string, line2?: string, city?: string, state?: string, zip?: string, country?: string): Addr | undefined {
  const c = String(country || "").trim().toUpperCase();
  if (c && !["US", "USA", "UNITED STATES"].includes(c)) return undefined;
  const address = [String(line1 || "").trim(), String(line2 || "").trim()].filter(Boolean).join(", ").slice(0, 120);
  const cityV = String(city || "").trim().slice(0, 60);
  const stateV = String(state || "").trim().slice(0, 20);
  const zipV = String(zip || "").trim().slice(0, 12);
  if (!address || !cityV || !stateV || !/^[0-9]{5}(-[0-9]{4})?$/.test(zipV)) return undefined;
  return { address, city: cityV, state: stateV, zip: zipV };
}

// ---- per-platform order fetchers (orders since `since`, paginated) ----

async function squareOrders(c: Conn, since: string): Promise<Order[]> {
  const h = { Authorization: `Bearer ${c.access_token}`, "Square-Version": "2024-01-18", "Content-Type": "application/json" };
  const locRes = await fetch("https://connect.squareup.com/v2/locations", { headers: h });
  if (!locRes.ok) throw new Error(`square locations ${locRes.status}`);
  const locIds = ((await locRes.json()).locations || []).map((l: { id: string }) => l.id).slice(0, 10);
  if (!locIds.length) return [];
  const raw: Record<string, unknown>[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const body: Record<string, unknown> = {
      location_ids: locIds, limit: 100,
      query: { filter: { date_time_filter: { closed_at: { start_at: since } }, state_filter: { states: ["COMPLETED"] } }, sort: { sort_field: "CLOSED_AT" } },
    };
    if (cursor) body.cursor = cursor;
    const oRes = await fetch("https://connect.squareup.com/v2/orders/search", { method: "POST", headers: h, body: JSON.stringify(body) });
    if (!oRes.ok) throw new Error(`square orders ${oRes.status}`);
    const data = await oRes.json();
    raw.push(...(data.orders || []));
    cursor = String(data.cursor || "");
    if (!cursor) break;
  }
  const out: Order[] = [];
  const custCache: Record<string, { email?: string; phone?: string; name?: string; addr?: Addr }> = {};
  for (const o of raw as Record<string, never>[]) {
    let who: { email?: string; phone?: string; name?: string; addr?: Addr } = {};
    const cid = (o as Record<string, string>).customer_id;
    if (cid) {
      if (!custCache[cid]) {
        try {
          const cr = await fetch(`https://connect.squareup.com/v2/customers/${cid}`, { headers: h });
          if (cr.ok) {
            const cu = (await cr.json()).customer || {};
            const a = cu.address || {};
            custCache[cid] = {
              email: cu.email_address, phone: cu.phone_number,
              name: [cu.given_name, cu.family_name].filter(Boolean).join(" "),
              addr: cleanAddr(a.address_line_1, a.address_line_2, a.locality, a.administrative_district_level_1, a.postal_code, a.country),
            };
          } else custCache[cid] = {};
        } catch { custCache[cid] = {}; }
      }
      who = custCache[cid];
    }
    if (!who.email && !who.phone) continue;
    const om = o as Record<string, never>;
    out.push({ email: who.email, phone: who.phone, name: who.name, addr: who.addr, amount: (((om.total_money as Record<string, number>)?.amount) || 0) / 100, at: (om.closed_at as string) || (om.created_at as string) });
  }
  return out;
}

async function shopifyOrders(c: Conn, since: string): Promise<Order[]> {
  const domain = c.shop_domain || c.merchant_id;
  const raw: Record<string, never>[] = [];
  let sinceId = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://${domain}/admin/api/2024-01/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(since)}${sinceId ? `&since_id=${sinceId}` : ""}`;
    const r = await fetch(url, { headers: { "X-Shopify-Access-Token": c.access_token } });
    if (!r.ok) throw new Error(`shopify orders ${r.status}`);
    const orders = (await r.json()).orders || [];
    if (!orders.length) break;
    raw.push(...orders);
    sinceId = String(orders[orders.length - 1].id || "");
    if (orders.length < 250 || !sinceId) break;
  }
  return raw.map((o) => {
    const cu = (o.customer || {}) as Record<string, never>;
    const sa = ((o as Record<string, never>).shipping_address || (cu.default_address as Record<string, string>) || {}) as Record<string, string>;
    return {
      email: (cu as Record<string, string>).email || (o as Record<string, string>).email,
      phone: (cu as Record<string, string>).phone,
      name: [(cu as Record<string, string>).first_name, (cu as Record<string, string>).last_name].filter(Boolean).join(" "),
      addr: cleanAddr(sa.address1, sa.address2, sa.city, sa.province_code || sa.province, sa.zip, sa.country_code || sa.country),
      amount: Number((o as Record<string, string>).total_price) || 0,
      at: (o as Record<string, string>).created_at,
    };
  }).filter((x: Order) => x.email || x.phone);
}

async function cloverOrders(c: Conn, since: string): Promise<Order[]> {
  const ts = Date.parse(since);
  const out: Order[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await fetch(`https://api.clover.com/v3/merchants/${c.merchant_id}/orders?filter=createdTime>=${ts}&expand=customers.addresses&limit=100&offset=${page * 100}`, {
      headers: { Authorization: `Bearer ${c.access_token}`, Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`clover orders ${r.status}`);
    const orders = (await r.json()).elements || [];
    if (!orders.length) break;
    for (const o of orders) {
      const cu = o.customers?.elements?.[0];
      if (!cu) continue;
      const email = cu.emailAddresses?.elements?.[0]?.emailAddress;
      const phone = cu.phoneNumbers?.elements?.[0]?.phoneNumber;
      if (!email && !phone) continue;
      const a = cu.addresses?.elements?.[0] || {};
      out.push({
        email, phone,
        name: [cu.firstName, cu.lastName].filter(Boolean).join(" "),
        addr: cleanAddr(a.address1, a.address2, a.city, a.state, a.zip, a.country),
        amount: (o.total || 0) / 100, at: new Date(o.createdTime).toISOString(),
      });
    }
    if (orders.length < 100) break;
  }
  return out;
}

async function stripeOrders(c: Conn, since: string): Promise<Order[]> {
  if (!stripePlatformKey) return [];
  const ts = Math.floor(Date.parse(since) / 1000);
  const out: Order[] = [];
  let after = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await fetch(`https://api.stripe.com/v1/charges?limit=100&created[gte]=${ts}${after ? `&starting_after=${after}` : ""}`, {
      headers: { Authorization: `Bearer ${stripePlatformKey}`, "Stripe-Account": c.merchant_id },
    });
    if (!r.ok) throw new Error(`stripe charges ${r.status}`);
    const data = await r.json();
    const charges = data.data || [];
    for (const ch of charges) {
      if (!ch.paid || ch.refunded) continue;
      const bd = (ch.billing_details || {}) as Record<string, never>;
      const ship = (ch.shipping || {}) as Record<string, never>;
      if (!(bd as Record<string, string>).email && !(bd as Record<string, string>).phone) continue;
      const a = ((ship.address || bd.address) || {}) as Record<string, string>;
      out.push({
        email: (bd as Record<string, string>).email, phone: (bd as Record<string, string>).phone, name: (bd as Record<string, string>).name,
        addr: cleanAddr(a.line1, a.line2, a.city, a.state, a.postal_code, a.country),
        amount: (ch.amount || 0) / 100, at: new Date((ch.created || 0) * 1000).toISOString(),
      });
    }
    if (!data.has_more || !charges.length) break;
    after = String(charges[charges.length - 1].id || "");
  }
  return out;
}

// ---- upsert one customer's new activity ----
async function applyOrder(userId: string, o: Order): Promise<{ res: "updated" | "created" | "skipped"; addrAdded: boolean }> {
  const email = (o.email || "").trim().toLowerCase();
  const phone = normalizePhone(o.phone);
  if (!email && !phone) return { res: "skipped", addrAdded: false };
  const ors: string[] = [];
  if (email) ors.push(`email.ilike.${encodeURIComponent(email)}`);
  if (phone) ors.push(`phone.eq.${encodeURIComponent(phone)}`, `phone.like.*${phone.replace(/\D/g, "").slice(-10)}`);
  const rows = await rest(`/rest/v1/customers?user_id=eq.${userId}&or=(${ors.join(",")})&select=id,visits,total_spent,last_visit_at,address,city,state,zip&limit=1`);
  const ex = Array.isArray(rows) ? rows[0] : null;
  if (ex) {
    const newer = !ex.last_visit_at || Date.parse(o.at) > Date.parse(ex.last_visit_at);
    const hasAddr = !!(ex.address && ex.city && ex.state && ex.zip);
    const addAddr = !hasAddr && o.addr ? o.addr : null;
    await rest(`/rest/v1/customers?id=eq.${ex.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        visits: (Number(ex.visits) || 0) + 1,
        total_spent: Math.round(((Number(ex.total_spent) || 0) + o.amount) * 100) / 100,
        ...(newer ? { last_visit_at: o.at, last_order_at: o.at } : {}),
        ...(addAddr ? addAddr : {}),
      }),
    });
    return { res: "updated", addrAdded: !!addAddr };
  }
  await rest("/rest/v1/customers", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: userId, name: o.name || email || "Customer", email: email || null, phone: phone || null,
      visits: 1, total_spent: o.amount, status: "active", last_visit_at: o.at, last_order_at: o.at, sms_consent: false,
      ...(o.addr ? o.addr : {}),
    }),
  });
  return { res: "created", addrAdded: !!o.addr };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey) return json({ error: "Server is not configured" }, 500);

  // Auth: cron key (nightly, all businesses) or a logged-in business (their own connections only).
  const key = req.headers.get("x-clicktide-cron-key") || "";
  const isCron = !!key && key === await expectedCronKey();
  const userId = isCron ? "" : await authedUserId(req);
  if (!isCron && !userId) return json({ error: "Not authorized" }, 401);

  const fetchers: Record<string, (c: Conn, s: string) => Promise<Order[]>> = {
    square: squareOrders, shopify: shopifyOrders, clover: cloverOrders, stripe: stripeOrders,
  };

  let connFilter = "is_active=eq.true&user_id=not.is.null";
  if (userId) connFilter += `&user_id=eq.${encodeURIComponent(userId)}`;
  const conns = await rest(
    `/rest/v1/platform_connections?${connFilter}&select=id,user_id,platform,merchant_id,shop_domain,access_token,last_synced_at&limit=500`,
  ) as Conn[];

  const results: Record<string, unknown>[] = [];
  for (const c of conns) {
    const fetcher = fetchers[c.platform];
    if (!fetcher || !c.access_token) { results.push({ platform: c.platform, skipped: "no fetcher or token" }); continue; }
    const since = c.last_synced_at || new Date(Date.now() - FIRST_SYNC_DAYS * 86400000).toISOString();
    try {
      const orders = await fetcher(c, since);
      let updated = 0, created = 0, capped = 0, addresses = 0;
      for (const o of orders) {
        try {
          const r = await applyOrder(c.user_id, o);
          if (r.res === "updated") updated++;
          if (r.res === "created") created++;
          if (r.addrAdded) addresses++;
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
      results.push({ platform: c.platform, orders: orders.length, updated, created, capped, addresses_imported: addresses });
    } catch (e) {
      results.push({ platform: c.platform, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return json({ ok: true, connections: conns.length, results });
});
