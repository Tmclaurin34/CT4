// Stripe Connect OAuth callback.
// Businesses land here after approving Clicktide on connect.stripe.com.
// The state is checked and consumed first; only then is the code exchanged for the
// account id. A state from oauth-start (new site) parks the result for oauth-confirm;
// a state the live site wrote itself (legacy, until OAUTH_ALLOW_LEGACY_STATES=false) is
// saved directly and the app gets ct_platform/ct_merchant/ct_name as before.
// No Stripe token is stored: platform-sync reads with Clicktide's platform key and the
// Stripe-Account header, and only for an account id saved here.

const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://goclicktide.com";
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const ALLOW_LEGACY_STATES = !["false", "0", "no", "off"].includes(
  (Deno.env.get("OAUTH_ALLOW_LEGACY_STATES") ?? "true").trim().toLowerCase(),
);
const STATE_MAX_AGE_MS = 15 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const EXPIRED = "This connection link expired or was already used, or you weren't signed in. Sign in to Clicktide, then start the connection again.";

function redirect(base: string, params: Record<string, string>): Response {
  const url = new URL(base);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return Response.redirect(url.toString(), 302);
}

async function rest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: response.ok, data };
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
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/clicktide_rate_limit_hit`, {
      method: "POST",
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
    });
    if (!r.ok) return true;
    return (await r.json()) === true;
  } catch {
    return true;
  }
}

type OAuthState = { userId: string; serverCreated: boolean; flow: string };

// Single use: the state row is deleted as it is read, before any code is exchanged, so a
// state can't be replayed and an unknown or expired one never reaches Stripe.
async function takeState(state: string): Promise<OAuthState | null> {
  if (!SERVICE_ROLE_KEY || !/^[0-9a-f]{32,128}$/i.test(state)) return null;
  const now = Date.now();
  const { ok, data } = await rest(
    `/rest/v1/oauth_states?state=eq.${state}&platform=eq.stripe` +
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
  return { userId: String(row.user_id), serverCreated, flow: serverCreated && meta.flow === "audit" ? "audit" : "app" };
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

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");

  if (!(await underLimit(`oauth-callback:ip:${clientIp(req)}`, 600, 60))) {
    return redirect(APP_BASE_URL, { ct_error: "Too many connection attempts — wait a few minutes and try again." });
  }
  const st = await takeState(url.searchParams.get("state") || "");

  if (oauthError) {
    const description = url.searchParams.get("error_description") || oauthError;
    return fail(st, `Stripe denied: ${cleanText(description)}`);
  }
  if (!code) return fail(st, "Missing code from Stripe.");
  if (!st || (!st.serverCreated && !ALLOW_LEGACY_STATES)) return fail(null, EXPIRED);
  if (!STRIPE_SECRET_KEY) return fail(st, "Stripe is not configured on the server.");

  const tokenRes = await fetch("https://connect.stripe.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_secret: STRIPE_SECRET_KEY,
      grant_type: "authorization_code",
      code,
    }),
  });

  const tokenData = await tokenRes.json().catch(() => ({}));
  const accountId = String(tokenData.stripe_user_id || "");
  if (!tokenRes.ok || !/^acct_[A-Za-z0-9]+$/.test(accountId)) {
    console.error("Stripe token exchange failed:", tokenRes.status, String(tokenData.error || ""));
    return fail(st, "Failed to exchange Stripe code.");
  }

  let accountName = "Stripe Account";
  try {
    const accountRes = await fetch(`https://api.stripe.com/v1/accounts/${accountId}`, {
      headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
    });
    if (accountRes.ok) {
      const account = await accountRes.json();
      accountName = account.business_profile?.name ||
        account.settings?.dashboard?.display_name ||
        account.email || accountName;
    }
  } catch (_) {}
  accountName = cleanName(accountName, "Stripe Account");

  const fields = {
    merchant_id: accountId,
    merchant_name: accountName,
    access_token: "",
    refresh_token: null,
    scope: tokenData.scope ? String(tokenData.scope) : null,
    raw_response: {
      stripe_user_id: accountId,
      scope: tokenData.scope ? String(tokenData.scope) : null,
      livemode: tokenData.livemode === true,
      token_type: tokenData.token_type ? String(tokenData.token_type) : null,
      source: "stripe-oauth-callback",
    },
  };

  if (st.serverCreated) {
    const nonce = randomHex(32);
    const { ok } = await rest("/rest/v1/oauth_pending", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ nonce, user_id: st.userId, platform: "stripe", payload: { flow: st.flow, fields }, expires_at: new Date(Date.now() + PENDING_TTL_MS).toISOString() }),
    });
    if (!ok) return fail(st, "Could not finish connecting Stripe. Please try again.");
    return redirect(returnUrl(st), { ct_oauth: "pending", ct_pending: nonce, ct_platform: "stripe" });
  }

  const { ok, data } = await rest("/rest/v1/rpc/clicktide_platform_connection_save", {
    method: "POST",
    body: JSON.stringify({ p_user: st.userId, p_platform: "stripe", p_fields: fields }),
  });
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  if (d.reason === "merchant_in_use") {
    return fail(st, "This Stripe account is already connected to a different Clicktide account. Disconnect it there first, or contact support@goclicktide.com.");
  }
  if (!ok || d.ok !== true) {
    console.error("Could not persist Stripe connection:", JSON.stringify(data));
    return fail(st, "Could not save the Stripe connection. Please try again.");
  }

  return redirect(APP_BASE_URL, {
    ct_platform: "stripe",
    ct_merchant: accountId,
    ct_name: encodeURIComponent(accountName),
  });
});
