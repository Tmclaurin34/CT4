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

const SQUARE_TOKEN_URL = "https://connect.squareup.com/oauth2/token";
const SQUARE_ME_URL = "https://connect.squareup.com/v2/merchants/me";

function redirect(base: string, params: Record<string,string>): Response {
  const url = new URL(base);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
  return Response.redirect(url.toString(), 302);
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");

  if (oauthError) return redirect(APP_BASE_URL, {ct_error: `Square denied: ${oauthError}`});
  if (!code) return redirect(APP_BASE_URL, {ct_error: "Missing code from Square."});

  const tokenRes = await fetch(SQUARE_TOKEN_URL, {
    method: "POST",
    headers: {"Content-Type":"application/json","Square-Version":"2024-01-18",Accept:"application/json"},
    body: JSON.stringify({
      client_id: Deno.env.get("SQUARE_APP_ID"),
      client_secret: Deno.env.get("SQUARE_APP_SECRET"),
      code,
      grant_type: "authorization_code",
      redirect_uri: `${Deno.env.get("SUPABASE_URL")}/functions/v1/square-oauth-callback`,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error("Square token exchange failed:", err);
    return redirect(APP_BASE_URL, {ct_error: "Failed to exchange Square code."});
  }

  const tokenData = await tokenRes.json();
  const merchantId: string = tokenData.merchant_id;

  let merchantName = "Square Merchant";
  try {
    const meRes = await fetch(SQUARE_ME_URL, {
      headers: {Authorization: `Bearer ${tokenData.access_token}`, "Square-Version": "2024-01-18"},
    });
    if (meRes.ok) {
      const me = await meRes.json();
      merchantName = me.merchant?.business_name ?? merchantName;
    }
  } catch (_) {}

  await persistConnection(url.searchParams.get("state") || "", "square", {
    merchant_id: merchantId,
    merchant_name: merchantName,
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || null,
    token_expires_at: tokenData.expires_at || null,
    raw_response: { merchant_id: tokenData.merchant_id, expires_at: tokenData.expires_at },
  });

  return redirect(APP_BASE_URL, {
    ct_platform: "square",
    ct_merchant: merchantId,
    ct_name: encodeURIComponent(merchantName),
  });
});
