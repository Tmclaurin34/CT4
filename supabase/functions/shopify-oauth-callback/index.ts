import { freshTimestamp, isShopDomain, planSelectionUrl, SHOPIFY_API_VERSION, verifyQueryHmac } from "../_shared/shopify.js";
import { APP_HANDLE, BILLING_ENABLED, reconcileBilling } from "../_shared/shopify_server.ts";

const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://goclicktide.com";

const SUPA = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

async function srest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPA}${path}`, { ...init, headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  const t = await r.text();
  return { ok: r.ok, data: t ? JSON.parse(t) : null };
}

// Map the OAuth state back to its origin and store the connection (token included)
// so the nightly platform-sync can pull orders later.
//  - state created by a signed-in business (Connect Shopify in Clicktide): saved to that business.
//  - state created by shopify-app (install started from Shopify, review rule 2.3.2):
//    saved unclaimed (user_id null) with a one-time claim token; the merchant
//    signs in / signs up and shopify-claim attaches it to their business.
// Returns null when the state is unknown or expired.
type Saved = { kind: "user"; userId: string } | { kind: "claim"; claim: string };
async function persistConnection(state: string, platform: string, fields: Record<string, unknown>): Promise<Saved | null> {
  try {
    if (!state || !SRK) return null;
    const { ok, data } = await srest(`/rest/v1/oauth_states?state=eq.${encodeURIComponent(state)}&platform=eq.${platform}&expires_at=gt.${new Date().toISOString()}&select=user_id,metadata&limit=1`);
    const st = ok && Array.isArray(data) ? data[0] : null;
    if (!st) return null;
    await srest(`/rest/v1/oauth_states?state=eq.${encodeURIComponent(state)}`, { method: "DELETE" }); // single use
    const userId = st.user_id as string | null;
    if (!userId) {
      // Shopify-initiated: the state must have been minted for this very shop.
      if (st.metadata?.initiated !== "shopify" || String(st.metadata?.shop || "") !== String(fields.shop_domain || "")) return null;
      const ins = await srest("/rest/v1/platform_connections?select=id", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ user_id: null, platform, is_active: true, updated_at: new Date().toISOString(), connected_at: new Date().toISOString(), ...fields }),
      });
      const connId = ins.ok && Array.isArray(ins.data) ? ins.data[0]?.id : null;
      if (!connId) return null;
      const claim = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(claim)))).map((b) => b.toString(16).padStart(2, "0")).join("");
      const c = await srest("/rest/v1/shopify_install_claims", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ token_hash: hash, connection_id: connId, shop_domain: fields.shop_domain }) });
      return c.ok ? { kind: "claim", claim } : null;
    }
    const row = { user_id: userId, platform, is_active: true, updated_at: new Date().toISOString(), ...fields };
    const ex = await srest(`/rest/v1/platform_connections?user_id=eq.${userId}&platform=eq.${platform}&select=id&limit=1`);
    if (ex.ok && Array.isArray(ex.data) && ex.data[0]?.id) {
      await srest(`/rest/v1/platform_connections?id=eq.${ex.data[0].id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
    } else {
      await srest("/rest/v1/platform_connections", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ...row, connected_at: new Date().toISOString() }) });
    }
    return { kind: "user", userId };
  } catch (e) { console.error("persist connection failed:", e); return null; }
}


function redirect(base: string, params: Record<string,string>): Response {
  const url = new URL(base);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
  return Response.redirect(url.toString(), 302);
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const shop = url.searchParams.get("shop");
  const oauthError = url.searchParams.get("error");

  if (oauthError) return redirect(APP_BASE_URL, {ct_error: `Shopify denied: ${oauthError}`});
  if (!code || !shop) return redirect(APP_BASE_URL, {ct_error: "Missing parameters from Shopify."});
  if (!isShopDomain(shop)) return redirect(APP_BASE_URL, {ct_error: "Invalid shop domain."});

  const secret = Deno.env.get("SHOPIFY_CLIENT_SECRET")!;
  // Constant-time HMAC check, and reject replays of old install links.
  const valid = await verifyQueryHmac(url.searchParams, secret, crypto.subtle);
  if (!valid) return redirect(APP_BASE_URL, {ct_error: "Invalid Shopify signature."});
  if (!freshTimestamp(url.searchParams.get("timestamp"))) return redirect(APP_BASE_URL, {ct_error: "That Shopify link has expired. Please connect again from Clicktide."});

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
      client_id: Deno.env.get("SHOPIFY_CLIENT_ID"),
      client_secret: secret,
      code,
    }),
  });

  if (!tokenRes.ok) return redirect(APP_BASE_URL, {ct_error: "Failed to exchange Shopify code."});

  const tokenJson = await tokenRes.json();
  const access_token = tokenJson.access_token;

  let shopName = shop;
  let shopId = shop;
  try {
    const shopRes = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {"X-Shopify-Access-Token": access_token, "Content-Type": "application/json"},
      body: JSON.stringify({ query: "{ shop { id name } }" }),
    });
    if (shopRes.ok) {
      const json = await shopRes.json();
      shopName = json.data?.shop?.name ?? shop;
      // gid://shopify/Shop/123 -> 123 (same id the old REST call stored)
      shopId = String(json.data?.shop?.id ?? shop).split("/").pop() || shop;
    }
  } catch (_) {}

  const saved = await persistConnection(url.searchParams.get("state") || "", "shopify", {
    merchant_id: shopId,
    merchant_name: shopName,
    shop_domain: shop,
    access_token,
    scope: tokenJson.scope || null,
    raw_response: { shop },
  });
  if (!saved) return redirect(APP_BASE_URL, {ct_error: "That Shopify link has expired. Open Clicktide from your Shopify admin (Apps) to try again."});

  // Installed from Shopify: send the merchant to sign in / sign up, carrying the
  // one-time claim (the dashboard POSTs it to shopify-claim after login).
  if (saved.kind === "claim") {
    return redirect(APP_BASE_URL, { ct_platform: "shopify", ct_shopify_claim: saved.claim, ct_shop: shop, ct_name: encodeURIComponent(shopName) });
  }

  // Shopify billing (flag-gated): no live plan yet -> Shopify's hosted plan page.
  if (BILLING_ENABLED) {
    try {
      const b = await reconcileBilling(shop);
      if (!["active", "trialing", "past_due"].includes(String(b.entitlement?.status))) return Response.redirect(planSelectionUrl(shop, APP_HANDLE), 302);
    } catch (e) { console.error("billing check after install failed", shop, e); }
  }

  return redirect(APP_BASE_URL, {
    ct_platform: "shopify",
    ct_merchant: shopId,
    ct_name: encodeURIComponent(shopName),
  });
});
