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
async function persistConnection(state: string, platform: string, fields: Record<string, unknown>) {
  try {
    if (!state || !SRK) return;
    const { ok, data } = await srest(`/rest/v1/oauth_states?state=eq.${encodeURIComponent(state)}&platform=eq.${platform}&expires_at=gt.${new Date().toISOString()}&select=user_id&limit=1`);
    const userId = ok && Array.isArray(data) && data[0]?.user_id;
    if (!userId) return;
    srest(`/rest/v1/oauth_states?state=eq.${encodeURIComponent(state)}`, { method: "DELETE" }).catch(() => {});
    const row = { user_id: userId, platform, is_active: true, updated_at: new Date().toISOString(), ...fields };
    const ex = await srest(`/rest/v1/platform_connections?user_id=eq.${userId}&platform=eq.${platform}&select=id&limit=1`);
    if (ex.ok && Array.isArray(ex.data) && ex.data[0]?.id) {
      await srest(`/rest/v1/platform_connections?id=eq.${ex.data[0].id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
    } else {
      await srest("/rest/v1/platform_connections", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ...row, connected_at: new Date().toISOString() }) });
    }
  } catch (e) { console.error("persist connection failed:", e); }
}


function redirect(base: string, params: Record<string,string>): Response {
  const url = new URL(base);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
  return Response.redirect(url.toString(), 302);
}

async function verifyHmac(query: URLSearchParams, secret: string): Promise<boolean> {
  const hmac = query.get("hmac");
  if (!hmac) return false;
  const params: string[] = [];
  query.forEach((value, key) => {
    if (key !== "hmac") params.push(`${key}=${value}`);
  });
  params.sort();
  const message = params.join("&");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  const hex = Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,"0")).join("");
  return hex === hmac;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const shop = url.searchParams.get("shop");
  const oauthError = url.searchParams.get("error");

  if (oauthError) return redirect(APP_BASE_URL, {ct_error: `Shopify denied: ${oauthError}`});
  if (!code || !shop) return redirect(APP_BASE_URL, {ct_error: "Missing parameters from Shopify."});
  if (!/^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/.test(shop)) return redirect(APP_BASE_URL, {ct_error: "Invalid shop domain."});

  const secret = Deno.env.get("SHOPIFY_CLIENT_SECRET")!;
  const valid = await verifyHmac(url.searchParams, secret);
  if (!valid) return redirect(APP_BASE_URL, {ct_error: "Invalid Shopify signature."});

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
    const shopRes = await fetch(`https://${shop}/admin/api/2024-01/shop.json`, {
      headers: {"X-Shopify-Access-Token": access_token},
    });
    if (shopRes.ok) {
      const json = await shopRes.json();
      shopName = json.shop?.name ?? shop;
      shopId = String(json.shop?.id ?? shop);
    }
  } catch (_) {}

  await persistConnection(url.searchParams.get("state") || "", "shopify", {
    merchant_id: shopId,
    merchant_name: shopName,
    shop_domain: shop,
    access_token,
    scope: tokenJson.scope || null,
    raw_response: { shop },
  });

  return redirect(APP_BASE_URL, {
    ct_platform: "shopify",
    ct_merchant: shopId,
    ct_name: encodeURIComponent(shopName),
  });
});
