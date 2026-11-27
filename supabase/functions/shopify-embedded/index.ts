// Backend for Clicktide's embedded page inside the Shopify admin (App Store rules 2.2.2/2.3.3).
// The page (goclicktide.com/shopify/) gets an App Bridge session token and POSTs it here as
// "Authorization: Bearer <token>". We verify it (HS256 with the client secret, audience, time,
// shop), then:
//  - store already linked to a Clicktide business: make sure its token works (refresh, or
//    token-exchange the session token after a reinstall) and return that business's summary;
//  - store not linked yet (fresh embedded install): token-exchange the session token for an
//    expiring offline token, save the connection unclaimed, and return a one-time claim link
//    the merchant opens to sign in / sign up at goclicktide.com (which asks them to confirm).
// No cookies or browser storage are involved (rule 1.1.1). Deploy with verify_jwt = false
// (the caller holds a Shopify token, not a Supabase one).
import { exchangeBody, SHOPIFY_API_VERSION, tokenFields, verifySessionToken } from "../_shared/shopify.js";
import { freshShopifyToken, legacyId, rest, rpc, sha256Hex, type ShopConn, SRK } from "../_shared/shopify_server.ts";

const SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "";
const CLIENT_ID = Deno.env.get("SHOPIFY_CLIENT_ID") ?? "";
const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://goclicktide.com";

function corsFor(req: Request) {
  const o = req.headers.get("origin") || "";
  const allowed = o === "https://goclicktide.com" || /^https:\/\/[a-z0-9-]+\.clicktide-app\.pages\.dev$/.test(o);
  return {
    "Access-Control-Allow-Origin": allowed ? o : "https://goclicktide.com",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

type Conn = ShopConn & { user_id: string | null; is_active: boolean; merchant_id?: string; merchant_name?: string; scope?: string | null };

async function exchange(shop: string, idToken: string) {
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(exchangeBody(CLIENT_ID, SECRET, idToken)),
  });
  const d = await r.json().catch(() => ({}));
  const f = tokenFields(d, Date.now());
  if (!r.ok || !f.access_token) {
    console.error("shopify token exchange failed", shop, r.status, JSON.stringify(d).slice(0, 200));
    throw new Error("token_exchange");
  }
  return { f, scope: typeof d.scope === "string" ? d.scope : null };
}

function tokenPatch(f: ReturnType<typeof tokenFields>, scope: string | null, raw: Record<string, unknown> | null | undefined, shop: string) {
  return {
    access_token: f.access_token, refresh_token: f.refresh_token, token_expires_at: f.token_expires_at,
    ...(scope ? { scope } : {}),
    raw_response: { ...(raw || {}), shop, refresh_expires_at: f.refresh_expires_at },
    is_active: true, revoked_at: null, disconnected_at: null, updated_at: new Date().toISOString(),
  };
}

async function shopInfo(shop: string, token: string) {
  try {
    const r = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST", headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ shop { id name } }" }),
    });
    const j = await r.json().catch(() => ({}));
    const s = j?.data?.shop;
    if (s?.id) return { id: legacyId(s.id), name: String(s.name || shop).replace(/[<>]/g, "").slice(0, 120) };
    console.error("embedded shop lookup failed", shop, r.status);
  } catch (e) { console.error("embedded shop lookup error", shop, e); }
  return { id: shop, name: shop };
}

function randomHex(n: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SECRET || !CLIENT_ID || !SRK) return json({ error: "Server is not configured" }, 500);

  const idToken = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const v = await verifySessionToken(idToken, SECRET, CLIENT_ID, crypto.subtle, Date.now());
  if (!v.ok) return json({ error: "Invalid Shopify session", reason: v.reason }, 401);
  const shop = v.shop as string;

  try {
    const conns = await rest(`/rest/v1/platform_connections?platform=eq.shopify&shop_domain=ilike.${encodeURIComponent(shop)}&select=id,user_id,is_active,access_token,refresh_token,token_expires_at,raw_response,merchant_id,merchant_name,shop_domain,scope&order=updated_at.desc`) as Conn[];
    const owned = (conns || []).find((c) => c.user_id && c.is_active) || (conns || []).find((c) => c.user_id);

    if (owned) {
      // Linked store. After an uninstall the token was wiped: a reinstall is proven by this
      // Shopify-signed session for the same shop, so take a fresh token and reactivate it.
      let usable = owned.is_active && !!owned.access_token;
      if (usable && await freshShopifyToken(owned) === "auth") usable = false;
      if (!usable) {
        const { f, scope } = await exchange(shop, idToken);
        await rest(`/rest/v1/platform_connections?id=eq.${owned.id}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ ...tokenPatch(f, scope, owned.raw_response, shop), sync_status: null, sync_fail_count: 0, sync_error: null, sync_error_at: null, sync_next_at: new Date().toISOString() }),
        });
      }
      const summary = await rpc("clicktide_shopify_embedded_summary", { p_user: owned.user_id });
      return json({ status: "connected", shop, store_name: owned.merchant_name || shop, summary, dashboard_url: APP_BASE_URL });
    }

    // Not linked yet: this is a fresh install opened inside the Shopify admin.
    const { f, scope } = await exchange(shop, idToken);
    const info = await shopInfo(shop, f.access_token);
    const unclaimed = (conns || []).find((c) => !c.user_id);
    let connId = unclaimed?.id || "";
    const fields = { ...tokenPatch(f, scope, unclaimed?.raw_response, shop), merchant_id: info.id, merchant_name: info.name, shop_domain: shop };
    if (connId) {
      await rest(`/rest/v1/platform_connections?id=eq.${connId}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(fields) });
    } else {
      const ins = await rest("/rest/v1/platform_connections?select=id", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ user_id: null, platform: "shopify", connected_at: new Date().toISOString(), ...fields }),
      });
      connId = Array.isArray(ins) && ins[0] ? String(ins[0].id) : "";
    }
    if (!connId) return json({ error: "Could not save the store connection." }, 500);
    // One-time claim (only its hash is stored); expired claims for this shop are cleared.
    await rest(`/rest/v1/shopify_install_claims?shop_domain=eq.${encodeURIComponent(shop)}&claimed_at=is.null&expires_at=lt.${encodeURIComponent(new Date().toISOString())}`, { method: "DELETE" }).catch(() => {});
    const claim = randomHex(32);
    await rest("/rest/v1/shopify_install_claims", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ token_hash: await sha256Hex(claim), connection_id: connId, shop_domain: shop }),
    });
    const u = new URL(APP_BASE_URL);
    u.searchParams.set("ct_platform", "shopify");
    u.searchParams.set("ct_shopify_claim", claim);
    u.searchParams.set("ct_shop", shop);
    return json({ status: "unclaimed", shop, store_name: info.name, claim_url: u.toString() });
  } catch (e) {
    console.error("shopify-embedded failed", shop, e);
    return json({ error: "Clicktide couldn't load right now. Please try again in a moment." }, 502);
  }
});
