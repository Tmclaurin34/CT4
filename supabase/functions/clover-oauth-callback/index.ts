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

const CLOVER_BASE = "https://www.clover.com";

function redirect(base: string, params: Record<string,string>): Response {
  const url = new URL(base);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
  return Response.redirect(url.toString(), 302);
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const merchantId = url.searchParams.get("merchant_id");
  const oauthError = url.searchParams.get("error");

  if (oauthError) return redirect(APP_BASE_URL, {ct_error: `Clover denied: ${oauthError}`});
  if (!code || !merchantId) return redirect(APP_BASE_URL, {ct_error: "Missing code or merchant_id from Clover."});

  const tokenUrl = new URL(`${CLOVER_BASE}/oauth/token`);
  tokenUrl.searchParams.set("client_id", Deno.env.get("CLOVER_APP_ID")!);
  tokenUrl.searchParams.set("client_secret", Deno.env.get("CLOVER_APP_SECRET")!);
  tokenUrl.searchParams.set("code", code);

  const tokenRes = await fetch(tokenUrl.toString(), {
    headers: {Accept: "application/json"},
  });

  if (!tokenRes.ok) return redirect(APP_BASE_URL, {ct_error: "Failed to exchange Clover code."});

  const tokenData = await tokenRes.json();
  const accessToken: string = tokenData.access_token;
  if (!accessToken) return redirect(APP_BASE_URL, {ct_error: "Clover did not return an access token."});

  let merchantName = "Clover Merchant";
  try {
    const mRes = await fetch(`${CLOVER_BASE}/v3/merchants/${merchantId}`, {
      headers: {Authorization: `Bearer ${accessToken}`, Accept: "application/json"},
    });
    if (mRes.ok) {
      const m = await mRes.json();
      merchantName = m.name ?? merchantName;
    }
  } catch (_) {}

  await persistConnection(url.searchParams.get("state") || "", "clover", {
    merchant_id: merchantId,
    merchant_name: merchantName,
    access_token: accessToken,
    refresh_token: tokenData.refresh_token || null,
    raw_response: {},
  });

  return redirect(APP_BASE_URL, {
    ct_platform: "clover",
    ct_merchant: merchantId,
    ct_name: encodeURIComponent(merchantName),
  });
});
