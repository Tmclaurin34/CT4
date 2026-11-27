// Shopify "App URL" (application_url in the app version). Shopify sends the
// merchant here on install and every time they open Clicktide from their admin:
//   GET ?shop=…&hmac=…&timestamp=…&host=…
// Review rules this satisfies: OAuth starts immediately (2.3.2) and again on
// reinstall (2.3.4); the merchant never types their shop domain (2.3.1); after
// approval they land in the app UI (2.3.3, see shopify-oauth-callback).
// Deploy with verify_jwt = false.
import { freshTimestamp, isShopDomain, planSelectionUrl, SHOPIFY_SCOPES, verifyQueryHmac } from "../_shared/shopify.js";
import { APP_HANDLE, BILLING_ENABLED, reconcileBilling, rest, rpc, ssoUrlFor, SUPA } from "../_shared/shopify_server.ts";

const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://goclicktide.com";
const SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "";
const CLIENT_ID = Deno.env.get("SHOPIFY_CLIENT_ID") ?? "";
// See shopify-oauth-callback: account-per-store sign-in, off until goclicktide.com supports it.
const AUTO_ACCOUNTS = (Deno.env.get("SHOPIFY_AUTO_ACCOUNTS") ?? "") === "true";
const LAUNCH_MAX_AGE_S = 10 * 60;

function go(url: string) { return Response.redirect(url, 302); }
function app(params: Record<string, string>) {
  const u = new URL(APP_BASE_URL);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return go(u.toString());
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const shop = (url.searchParams.get("shop") || "").toLowerCase();
  if (!isShopDomain(shop)) return app({ ct_error: "Open Clicktide from your Shopify admin." });
  if (!(await verifyQueryHmac(url.searchParams, SECRET, crypto.subtle)) || !freshTimestamp(url.searchParams.get("timestamp"))) {
    return new Response("Invalid Shopify signature", { status: 401 });
  }

  // Installed, claimed and still holding a token? Then this is "open app".
  const conns = await rest(`/rest/v1/platform_connections?platform=eq.shopify&shop_domain=ilike.${encodeURIComponent(shop)}&is_active=eq.true&access_token=neq.&user_id=not.is.null&select=id,user_id&order=updated_at.desc&limit=1`);
  if (Array.isArray(conns) && conns[0]) {
    if (BILLING_ENABLED) {
      try {
        const b = await reconcileBilling(shop);
        if (!["active", "trialing", "past_due"].includes(String(b.entitlement?.status))) return go(planSelectionUrl(shop, APP_HANDLE));
      } catch (e) { console.error("billing check on open failed", shop, e); }
    }
    // Sign the store's own Clicktide account in: only from a fresh, never-before-used signed
    // launch, and only for an account Clicktide created for this store (never a website
    // account an owner linked by hand).
    if (AUTO_ACCOUNTS) {
      const ts = Number(url.searchParams.get("timestamp"));
      const fresh = Number.isFinite(ts) && Math.abs(Date.now() / 1000 - ts) < LAUNCH_MAX_AGE_S;
      try {
        if (fresh && await rpc("clicktide_shopify_launch_once", { p_hmac: String(url.searchParams.get("hmac") || ""), p_shop: shop }) === true) {
          const signIn = await ssoUrlFor(String(conns[0].user_id), shop);
          if (signIn) return go(signIn);
        }
      } catch (e) { console.error("shopify launch sign-in failed", shop, e); }
    }
    return app({ ct_platform: "shopify", ct_shop: shop });
  }

  // New install or reinstall: start OAuth right away. The state has no user
  // yet; the callback stores the connection unclaimed and hands back a claim link.
  const state = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  await rest("/rest/v1/oauth_states", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ state, user_id: null, platform: "shopify", metadata: { shop, initiated: "shopify" }, expires_at: new Date(Date.now() + 10 * 60000).toISOString() }),
  });
  const auth = new URL(`https://${shop}/admin/oauth/authorize`);
  auth.searchParams.set("client_id", CLIENT_ID);
  auth.searchParams.set("scope", SHOPIFY_SCOPES);
  auth.searchParams.set("redirect_uri", `${SUPA}/functions/v1/shopify-oauth-callback`);
  auth.searchParams.set("state", state);
  return go(auth.toString());
});
