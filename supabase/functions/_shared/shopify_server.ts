// Server-side Shopify helpers shared by shopify-webhooks, shopify-app and
// shopify-oauth-callback. Pure logic lives in ./shopify.js (unit-tested).
import { entitlementFromSubscriptions, SHOPIFY_API_VERSION, SUBSCRIPTION_QUERY } from "./shopify.js";

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
  const conns = await rest(`/rest/v1/platform_connections?platform=eq.shopify&shop_domain=ilike.${encodeURIComponent(shop)}&is_active=eq.true&access_token=neq.&select=access_token&limit=1`);
  const token = Array.isArray(conns) && conns[0]?.access_token;
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
