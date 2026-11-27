const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://goclicktide.com";

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

type OAuthState = { userId: string; serverCreated: boolean; flow: string; shopDomain: string };

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
  if (!row?.user_id) return null;
  // Rows planted before the browser guard existed could carry any created_at/expires_at;
  // a real state never lives longer than STATE_MAX_AGE_MS. The row is consumed either way.
  const life = Date.parse(String(row.expires_at)) - Date.parse(String(row.created_at));
  if (!(life > 0 && life <= STATE_MAX_AGE_MS)) return null;
  const meta = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, unknown>;
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

const CLOVER_BASE = "https://www.clover.com"; // OAuth only
const CLOVER_API = "https://api.clover.com"; // REST (North America, as platform-sync)

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const merchantId = url.searchParams.get("merchant_id") || "";
  const oauthError = url.searchParams.get("error");

  if (!(await underLimit(`oauth-callback:ip:${clientIp(req)}`, 600, 60))) {
    return redirect(APP_BASE_URL, {ct_error: "Too many connection attempts — wait a few minutes and try again."});
  }
  const st = await takeState(url.searchParams.get("state") || "", "clover");

  if (oauthError) return fail(st, `Clover denied: ${cleanText(oauthError)}`);
  if (!code || !merchantId) return fail(st, "Missing code or merchant_id from Clover.");
  if (!/^[A-Za-z0-9]{6,32}$/.test(merchantId)) return fail(st, "Invalid merchant id from Clover.");
  if (!st || (!st.serverCreated && !ALLOW_LEGACY_STATES)) return fail(null, EXPIRED);

  const tokenUrl = new URL(`${CLOVER_BASE}/oauth/token`);
  tokenUrl.searchParams.set("client_id", Deno.env.get("CLOVER_APP_ID") ?? "");
  tokenUrl.searchParams.set("client_secret", Deno.env.get("CLOVER_APP_SECRET") ?? "");
  tokenUrl.searchParams.set("code", code);

  const tokenRes = await fetch(tokenUrl.toString(), {
    headers: {Accept: "application/json"},
  });

  if (!tokenRes.ok) return fail(st, "Failed to exchange Clover code.");

  const tokenData = await tokenRes.json().catch(() => ({}));
  const accessToken: string = String(tokenData.access_token || "");
  if (!accessToken) return fail(st, "Clover did not return an access token.");

  // merchant_id arrives in the redirect URL, so it only counts once the new token can
  // actually read that merchant (otherwise anyone could claim another store's id and lock
  // it out under the one-business-per-merchant rule). Same REST host platform-sync reads.
  let merchantName = "Clover Merchant";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const mRes = await fetch(`${CLOVER_API}/v3/merchants/${merchantId}`, {
      headers: {Authorization: `Bearer ${accessToken}`, Accept: "application/json"},
      signal: ac.signal,
    });
    if (!mRes.ok) {
      console.error("clover-oauth-callback: merchant check", mRes.status);
      return fail(st, mRes.status === 401 || mRes.status === 403 || mRes.status === 404
        ? "Clover didn't confirm access to that merchant account. Please start the connection again."
        : "Clover had a temporary problem confirming your merchant account. Please try again in a few minutes.");
    }
    const m = await mRes.json();
    merchantName = m.name ?? merchantName;
  } catch (e) {
    console.error("clover-oauth-callback: merchant check failed", e instanceof Error ? e.name : e);
    return fail(st, "Clover had a temporary problem confirming your merchant account. Please try again in a few minutes.");
  } finally {
    clearTimeout(timer);
  }
  merchantName = cleanName(merchantName, "Clover Merchant");

  return await finish(st, "clover", "Clover", {
    merchant_id: merchantId,
    merchant_name: merchantName,
    access_token: accessToken,
    refresh_token: tokenData.refresh_token || null,
    raw_response: {},
  }, {
    ct_platform: "clover",
    ct_merchant: merchantId,
    ct_name: encodeURIComponent(merchantName),
  });
});
