import { freshTimestamp, isShopDomain, SHOPIFY_API_VERSION, verifyQueryHmac } from "../_shared/shopify.js";

const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://goclicktide.com";

const SUPA = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

async function srest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPA}${path}`, { ...init, headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  const t = await r.text();
  return { ok: r.ok, data: t ? JSON.parse(t) : null };
}

// Map the OAuth state back to the user and store the connection (token included)
// so the nightly platform-sync can pull their customers and orders later.
// Returns false when the install can't be tied to a signed-in Clicktide business.
async function persistConnection(state: string, platform: string, fields: Record<string, unknown>): Promise<boolean> {
  try {
    if (!state || !SRK) return false;
    const { ok, data } = await srest(`/rest/v1/oauth_states?state=eq.${encodeURIComponent(state)}&platform=eq.${platform}&expires_at=gt.${new Date().toISOString()}&select=user_id&limit=1`);
    const userId = ok && Array.isArray(data) && data[0]?.user_id;
    if (!userId) return false;
    srest(`/rest/v1/oauth_states?state=eq.${encodeURIComponent(state)}`, { method: "DELETE" }).catch(() => {});
    const row = { user_id: userId, platform, is_active: true, updated_at: new Date().toISOString(), ...fields };
    const ex = await srest(`/rest/v1/platform_connections?user_id=eq.${userId}&platform=eq.${platform}&select=id&limit=1`);
    if (ex.ok && Array.isArray(ex.data) && ex.data[0]?.id) {
      await srest(`/rest/v1/platform_connections?id=eq.${ex.data[0].id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
    } else {
      await srest("/rest/v1/platform_connections", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ...row, connected_at: new Date().toISOString() }) });
    }
    return true;
  } catch (e) { console.error("persist connection failed:", e); return false; }
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
  // Installs must start from Clicktide (so we know which business they belong to).
  if (!saved) return redirect(APP_BASE_URL, {ct_error: "We couldn't link this Shopify store to your Clicktide account. Log in to Clicktide and click Connect Shopify from there."});

  return redirect(APP_BASE_URL, {
    ct_platform: "shopify",
    ct_merchant: shopId,
    ct_name: encodeURIComponent(shopName),
  });
});
