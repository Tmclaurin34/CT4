// Shopify OAuth callback. Three ways in:
//  - oauth-start state (new site): token parked in oauth_pending for oauth-confirm.
//  - legacy browser state (old site): saved directly to the signed-in business.
//  - shopify-app state (install started inside Shopify, review rule 2.3.2): no Clicktide
//    user yet, so the connection is saved unclaimed with a one-time claim token; the
//    merchant signs in / signs up and shopify-claim attaches it to their business.
import { freshTimestamp, SHOPIFY_API_VERSION, tokenFields } from "../_shared/shopify.js";
import { BILLING_ENABLED, provisionForClaim, reconcileBilling, signInUrlFor } from "../_shared/shopify_server.ts";

const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://goclicktide.com";
// Secret SHOPIFY_AUTO_ACCOUNTS=true turns on account-per-store sign-in (needs the matching
// goclicktide.com release). Off: the old claim link (log in / sign up, then confirm).
const AUTO_ACCOUNTS = (Deno.env.get("SHOPIFY_AUTO_ACCOUNTS") ?? "") === "true";

const SUPA = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// States written by today's live site (no server_created flag) keep the old direct-save
// behaviour until the new website ships. Set the secret OAUTH_ALLOW_LEGACY_STATES=false
// to accept only states made by oauth-start.
const ALLOW_LEGACY_STATES = !["false", "0", "no", "off"].includes(
  (Deno.env.get("OAUTH_ALLOW_LEGACY_STATES") ?? "true").trim().toLowerCase(),
);
const STATE_MAX_AGE_MS = 15 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const EXPIRED = "This connection link expired or was already used, or you weren't signed in. Sign in to Clicktide, then start the connection again.";

async function srest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPA}${path}`, { ...init, headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  const t = await r.text();
  let data: unknown = null;
  try { data = t ? JSON.parse(t) : null; } catch { data = null; }
  return { ok: r.ok, data };
}

function clientIp(req: Request) {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

// Fails open: a merchant finishing a connection must not be blocked by the limiter.
async function underLimit(bucket: string, windowSeconds: number, max: number) {
  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/clicktide_rate_limit_hit`, {
      method: "POST",
      headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
    });
    if (!r.ok) return true;
    return (await r.json()) === true;
  } catch {
    return true;
  }
}

type OAuthState = { userId: string; serverCreated: boolean; flow: string; shopDomain: string; install?: boolean };

// Single use: the state row is deleted as it is read, before any code is exchanged, so a
// state can't be replayed and an unknown or expired one never reaches the provider.
async function takeState(state: string, platform: string): Promise<OAuthState | null> {
  if (!SRK || !/^[0-9a-f]{32,128}$/i.test(state)) return null;
  const now = Date.now();
  const { ok, data } = await srest(
    `/rest/v1/oauth_states?state=eq.${state}&platform=eq.${platform}` +
      `&expires_at=gt.${encodeURIComponent(new Date(now).toISOString())}` +
      `&created_at=gt.${encodeURIComponent(new Date(now - STATE_MAX_AGE_MS).toISOString())}` +
      `&created_at=lte.${encodeURIComponent(new Date(now + 60_000).toISOString())}&select=user_id,metadata,created_at,expires_at`,
    { method: "DELETE", headers: { Prefer: "return=representation" } },
  );
  const row = ok && Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (!row) return null;
  // Rows planted before the browser guard existed could carry any created_at/expires_at;
  // a real state never lives longer than STATE_MAX_AGE_MS. The row is consumed either way.
  const life = Date.parse(String(row.expires_at)) - Date.parse(String(row.created_at));
  if (!(life > 0 && life <= STATE_MAX_AGE_MS)) return null;
  const meta = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, unknown>;
  if (!row.user_id) {
    // Only shopify-app mints user-less states, always for one specific shop.
    if (platform !== "shopify" || meta.initiated !== "shopify" || !meta.shop) return null;
    return { userId: "", serverCreated: false, flow: "install", shopDomain: String(meta.shop).toLowerCase(), install: true };
  }
  const serverCreated = meta.server_created === true;
  return {
    userId: String(row.user_id),
    serverCreated,
    flow: serverCreated && meta.flow === "audit" ? "audit" : "app",
    shopDomain: String(meta.shop_domain || "").toLowerCase(),
  };
}

function redirect(base: string, params: Record<string,string>): Response {
  const url = new URL(base);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
  return Response.redirect(url.toString(), 302);
}

function returnUrl(st: OAuthState | null) {
  return st?.serverCreated && st.flow === "audit" ? new URL("/free-pos-audit", APP_BASE_URL).toString() : APP_BASE_URL;
}

function fail(st: OAuthState | null, message: string) {
  return redirect(returnUrl(st), { ct_error: message });
}

function randomHex(bytes: number) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

// The dashboard shows this name; angle brackets are never part of a real one.
function cleanName(v: unknown, fallback: string) {
  const s = String(v ?? "").replace(/[<>]/g, "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return s || fallback;
}

function cleanText(v: unknown) {
  return String(v ?? "").replace(/[<>\u0000-\u001f\u007f]/g, "").slice(0, 120);
}

// New site (state from oauth-start): park the result for oauth-confirm, which activates
// it only for the signed-in user who started the flow. Legacy state: save it directly.
async function finish(st: OAuthState, platform: string, label: string, fields: Record<string, unknown>, legacyParams: Record<string, string>) {
  if (st.serverCreated) {
    const nonce = randomHex(32);
    const { ok } = await srest("/rest/v1/oauth_pending", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ nonce, user_id: st.userId, platform, payload: { flow: st.flow, fields }, expires_at: new Date(Date.now() + PENDING_TTL_MS).toISOString() }),
    });
    if (!ok) return fail(st, `Could not finish connecting ${label}. Please try again.`);
    return redirect(returnUrl(st), { ct_oauth: "pending", ct_pending: nonce, ct_platform: platform });
  }
  const { ok, data } = await srest("/rest/v1/rpc/clicktide_platform_connection_save", {
    method: "POST",
    body: JSON.stringify({ p_user: st.userId, p_platform: platform, p_fields: fields }),
  });
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  if (d.reason === "merchant_in_use") {
    return fail(st, `This ${label} account is already connected to a different Clicktide account. Disconnect it there first, or contact support@goclicktide.com.`);
  }
  if (!ok || d.ok !== true) {
    console.error(`persist ${platform} connection failed:`, JSON.stringify(data));
    return fail(st, `Could not save the ${label} connection. Please try again.`);
  }
  return redirect(APP_BASE_URL, legacyParams);
}

async function sha256Hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Install from Shopify: store the connection without an owner and hand back a one-time
// claim (only its hash is stored). The dashboard POSTs it to shopify-claim after sign-in.
async function saveUnclaimed(fields: Record<string, unknown>, shop: string, shopName: string) {
  const now = new Date().toISOString();
  const ins = await srest("/rest/v1/platform_connections?select=id", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ user_id: null, platform: "shopify", is_active: true, connected_at: now, updated_at: now, ...fields }),
  });
  const connId = ins.ok && Array.isArray(ins.data) ? (ins.data[0] as Record<string, unknown> | undefined)?.id : null;
  if (!connId) { console.error("unclaimed shopify connection insert failed", JSON.stringify(ins.data)); return fail(null, "Could not finish installing Clicktide. Please open it again from your Shopify admin."); }
  const claim = randomHex(32);
  const c = await srest("/rest/v1/shopify_install_claims", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ token_hash: await sha256Hex(claim), connection_id: connId, shop_domain: shop }),
  });
  if (!c.ok) return fail(null, "Could not finish installing Clicktide. Please open it again from your Shopify admin.");
  // Non-embedded app: give the store its own Clicktide account and sign the merchant straight
  // in (no second sign-up). A store that belongs to an account made on the website falls back
  // to the claim link, which that owner finishes after logging in.
  if (AUTO_ACCOUNTS) {
    try {
      const p = await provisionForClaim(claim);
      if (p.ok) {
        if (BILLING_ENABLED) { try { await reconcileBilling(shop); } catch (e) { console.error("billing after install", shop, e); } }
        const signIn = await signInUrlFor(p.userId, shop);
        if (signIn) return Response.redirect(signIn, 302);
      } else if (p.reason !== "website_account") console.error("shopify auto account failed", shop, p.reason);
    } catch (e) { console.error("shopify auto account error", shop, e); }
  }
  return redirect(APP_BASE_URL, { ct_platform: "shopify", ct_shopify_claim: claim, ct_shop: shop, ct_name: encodeURIComponent(shopName) });
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyHmac(query: URLSearchParams, secret: string): Promise<boolean> {
  const hmac = query.get("hmac");
  if (!hmac || !secret) return false;
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
  return safeEqual(hex, hmac.toLowerCase());
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const shop = (url.searchParams.get("shop") || "").toLowerCase();
  const oauthError = url.searchParams.get("error");

  if (!(await underLimit(`oauth-callback:ip:${clientIp(req)}`, 600, 60))) {
    return redirect(APP_BASE_URL, {ct_error: "Too many connection attempts — wait a few minutes and try again."});
  }
  const st = await takeState(url.searchParams.get("state") || "", "shopify");

  if (oauthError) return fail(st, `Shopify denied: ${cleanText(oauthError)}`);
  if (!code || !shop) return fail(st, "Missing parameters from Shopify.");
  if (!/^[a-z0-9][a-z0-9\-]*\.myshopify\.com$/.test(shop)) return fail(st, "Invalid shop domain.");

  const secret = Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "";
  const valid = await verifyHmac(url.searchParams, secret);
  if (!valid) return fail(st, "Invalid Shopify signature.");
  if (!freshTimestamp(url.searchParams.get("timestamp"))) return fail(st, "That Shopify link has expired. Please start the connection again.");

  if (!st || (!st.install && !st.serverCreated && !ALLOW_LEGACY_STATES)) return fail(null, EXPIRED);
  // The store that answered must be the one the owner asked to connect.
  if (st.shopDomain && st.shopDomain !== shop) return fail(st, "That Shopify store isn't the one this connection was started for. Please try again.");

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
      client_id: Deno.env.get("SHOPIFY_CLIENT_ID"),
      client_secret: secret,
      code,
      expiring: 1, // Shopify only accepts expiring offline tokens on the Admin API now
    }),
  });

  if (!tokenRes.ok) return fail(st, "Failed to exchange Shopify code.");

  const tokenJson = await tokenRes.json().catch(() => ({}));
  const tok = tokenFields(tokenJson, Date.now());
  const access_token = tok.access_token;
  if (!access_token) return fail(st, "Shopify did not return an access token.");
  const tokenSave = { refresh_token: tok.refresh_token, token_expires_at: tok.token_expires_at };

  let shopName = shop;
  let shopId = shop;
  try {
    // GraphQL Admin API (REST is retired for public apps). gid://shopify/Shop/123 -> 123,
    // the same id the old REST call stored.
    const shopRes = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {"X-Shopify-Access-Token": access_token, "Content-Type": "application/json"},
      body: JSON.stringify({ query: "{ shop { id name } }" }),
    });
    if (shopRes.ok) {
      const json = await shopRes.json();
      shopName = json.data?.shop?.name ?? shop;
      shopId = String(json.data?.shop?.id ?? shop).split("/").pop() || shop;
      if (!json.data?.shop) console.error("shopify shop lookup returned no shop", shop, JSON.stringify(json?.errors || "").slice(0, 200));
    } else console.error("shopify shop lookup failed", shop, shopRes.status, (await shopRes.text().catch(() => "")).slice(0, 200));
  } catch (e) { console.error("shopify shop lookup error", shop, e); }
  shopName = cleanName(shopName, shop);

  if (st.install) {
    return await saveUnclaimed({ merchant_id: shopId, merchant_name: shopName, shop_domain: shop, access_token, ...tokenSave, scope: tokenJson.scope || null, raw_response: { shop, refresh_expires_at: tok.refresh_expires_at } }, shop, shopName);
  }

  return await finish(st, "shopify", "Shopify", {
    merchant_id: shopId,
    merchant_name: shopName,
    shop_domain: shop,
    access_token,
    ...tokenSave,
    scope: tokenJson.scope || null,
    raw_response: { shop, refresh_expires_at: tok.refresh_expires_at },
  }, {
    ct_platform: "shopify",
    ct_merchant: shopId,
    ct_name: encodeURIComponent(shopName),
  });
});
