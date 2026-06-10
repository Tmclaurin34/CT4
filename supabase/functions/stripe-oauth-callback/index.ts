// Stripe Connect OAuth callback.
// Businesses land here after approving Clicktide on connect.stripe.com.
// Exchanges the code for their account id, persists the connection to
// platform_connections (when the state maps to a logged-in user), then
// redirects back to the app with ct_platform/ct_merchant/ct_name params.

const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://goclicktide.com";
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

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
  return { ok: response.ok, data: text ? JSON.parse(text) : null };
}

// Map the OAuth state back to the user who started the connect flow.
async function userIdForState(state: string): Promise<string> {
  if (!state || !SERVICE_ROLE_KEY) return "";
  const { ok, data } = await rest(
    `/rest/v1/oauth_states?state=eq.${encodeURIComponent(state)}&platform=eq.stripe&expires_at=gt.${new Date().toISOString()}&select=user_id&limit=1`,
  );
  if (!ok || !Array.isArray(data) || !data[0]?.user_id) return "";
  rest(`/rest/v1/oauth_states?state=eq.${encodeURIComponent(state)}`, { method: "DELETE" }).catch(() => {});
  return String(data[0].user_id);
}

async function saveConnection(userId: string, tokenData: Record<string, unknown>, merchantName: string) {
  const fields = {
    user_id: userId,
    platform: "stripe",
    merchant_id: String(tokenData.stripe_user_id || ""),
    merchant_name: merchantName,
    access_token: String(tokenData.access_token || ""),
    refresh_token: tokenData.refresh_token ? String(tokenData.refresh_token) : null,
    scope: tokenData.scope ? String(tokenData.scope) : null,
    raw_response: tokenData,
    is_active: true,
    updated_at: new Date().toISOString(),
  };
  const { ok, data } = await rest(
    `/rest/v1/platform_connections?user_id=eq.${encodeURIComponent(userId)}&platform=eq.stripe&select=id&limit=1`,
  );
  if (ok && Array.isArray(data) && data[0]?.id) {
    await rest(`/rest/v1/platform_connections?id=eq.${data[0].id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(fields),
    });
  } else {
    await rest("/rest/v1/platform_connections", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ ...fields, connected_at: new Date().toISOString() }),
    });
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    const description = url.searchParams.get("error_description") || oauthError;
    return redirect(APP_BASE_URL, { ct_error: `Stripe denied: ${description}` });
  }
  if (!code) return redirect(APP_BASE_URL, { ct_error: "Missing code from Stripe." });
  if (!STRIPE_SECRET_KEY) return redirect(APP_BASE_URL, { ct_error: "Stripe is not configured on the server." });

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
  if (!tokenRes.ok || !tokenData.stripe_user_id) {
    console.error("Stripe token exchange failed:", JSON.stringify(tokenData));
    return redirect(APP_BASE_URL, { ct_error: "Failed to exchange Stripe code." });
  }

  const accountId: string = tokenData.stripe_user_id;

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

  try {
    const userId = await userIdForState(state);
    if (userId) await saveConnection(userId, tokenData, accountName);
  } catch (e) {
    console.error("Could not persist Stripe connection:", e);
  }

  return redirect(APP_BASE_URL, {
    ct_platform: "stripe",
    ct_merchant: accountId,
    ct_name: encodeURIComponent(accountName),
  });
});
