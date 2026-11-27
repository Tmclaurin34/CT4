// Server-side Shopify helpers shared by shopify-webhooks, shopify-app and
// shopify-oauth-callback. Pure logic lives in ./shopify.js (unit-tested).
import { entitlementFromSubscriptions, migrateBody, refreshBody, SHOPIFY_API_VERSION, SUBSCRIPTION_QUERY, tokenAction, tokenFields } from "./shopify.js";

export const SUPA = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
export const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Shopify billing stays OFF until the owner flips it (Supabase secret
// SHOPIFY_BILLING_ENABLED=true). While off, Clicktide reads the subscription
// and logs what it would do, but never writes an entitlement.
export const BILLING_ENABLED = (Deno.env.get("SHOPIFY_BILLING_ENABLED") ?? "") === "true";
export const APP_HANDLE = Deno.env.get("SHOPIFY_APP_HANDLE") ?? "clicktide-3";

export async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPA}${path}`, {
    ...init,
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const t = await r.text();
  const data = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(data?.message || data?.error || r.statusText);
  return data;
}

export async function rpc(name: string, args: Record<string, unknown>) {
  return await rest(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
}

const CLIENT_ID = Deno.env.get("SHOPIFY_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "";

export type ShopConn = { id: string; shop_domain?: string | null; access_token: string; refresh_token?: string | null; token_expires_at?: string | null; raw_response?: Record<string, unknown> | null };

// Keep a Shopify connection's offline token usable (expiring tokens, see shopify.js).
// Mutates conn and saves the new token. "auth" = the store must reinstall/reconnect.
export async function freshShopifyToken(conn: ShopConn, force = false): Promise<"ok" | "auth" | "transient"> {
  const action = tokenAction(conn, Date.now(), force);
  if (action === "ok") return "ok";
  const shop = String(conn.shop_domain || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !CLIENT_ID || !CLIENT_SECRET) return "auth";
  const body = action === "migrate" ? migrateBody(CLIENT_ID, CLIENT_SECRET, conn) : refreshBody(CLIENT_ID, CLIENT_SECRET, conn);
  let r: Response;
  try {
    r = await fetch(`https://${shop}/admin/oauth/access_token`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
  } catch { return "transient"; }
  const d = await r.json().catch(() => ({}));
  const f = tokenFields(d, Date.now());
  if (!r.ok || !f.access_token) {
    console.error(`shopify token ${action} failed`, shop, r.status, JSON.stringify(d).slice(0, 200));
    return r.status >= 400 && r.status < 500 ? "auth" : "transient";
  }
  conn.access_token = f.access_token;
  conn.refresh_token = f.refresh_token || conn.refresh_token || null;
  conn.token_expires_at = f.token_expires_at;
  const raw = { ...(conn.raw_response || {}), refresh_expires_at: f.refresh_expires_at };
  conn.raw_response = raw;
  try {
    await rest(`/rest/v1/platform_connections?id=eq.${conn.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ access_token: conn.access_token, refresh_token: conn.refresh_token, token_expires_at: conn.token_expires_at, raw_response: raw, updated_at: new Date().toISOString() }),
    });
  } catch (e) { console.error("saving refreshed shopify token failed", conn.id, e); }
  return "ok";
}

export async function adminGraphql(shop: string, token: string, query: string, variables: Record<string, unknown> = {}) {
  const r = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body?.data) throw new Error(`shopify graphql ${r.status} ${JSON.stringify(body?.errors || "").slice(0, 200)}`);
  return body.data;
}

export async function sha256Hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function legacyId(gid: unknown) {
  const m = String(gid || "").match(/(\d+)$/);
  return m ? m[1] : String(gid || "");
}

// Read the shop's current App Pricing subscription and (when billing is on)
// apply it as the business's entitlement. Shopify App Pricing sends no
// subscription webhooks (since 2026-04-28), so this runs on app open, after
// install, after plan selection, and nightly.
export async function reconcileBilling(shop: string) {
  const conns = await rest(`/rest/v1/platform_connections?platform=eq.shopify&shop_domain=ilike.${encodeURIComponent(shop)}&is_active=eq.true&access_token=neq.&select=id,shop_domain,access_token,refresh_token,token_expires_at,raw_response&order=updated_at.desc&limit=1`);
  const conn = Array.isArray(conns) && conns[0] ? conns[0] as ShopConn : null;
  if (conn && await freshShopifyToken(conn) === "auth") throw new Error(`shopify token for ${shop} needs reinstall`);
  const token = conn?.access_token;
  let ent;
  if (!token) ent = { status: "canceled", raw_status: "UNINSTALLED", plan: null, period_end: null, sub_id: null };
  else {
    const data = await adminGraphql(shop, token, SUBSCRIPTION_QUERY);
    ent = entitlementFromSubscriptions(data?.currentAppInstallation?.activeSubscriptions || [], {
      devStore: !!data?.shop?.plan?.partnerDevelopment,
    });
  }
  if (!BILLING_ENABLED) {
    console.log(`shopify billing (dry run, flag off) ${shop}: ${JSON.stringify(ent)}`);
    return { dry_run: true, entitlement: ent };
  }
  const applied = await rpc("clicktide_shopify_apply_entitlement", {
    p_shop: shop, p_plan: ent.plan, p_status: ent.status, p_period_end: ent.period_end, p_sub_id: ent.sub_id, p_raw_status: ent.raw_status,
  });
  return { dry_run: false, entitlement: ent, applied };
}
