// Stripe Connect OAuth callback.
// Businesses land here after approving Clicktide on connect.stripe.com.
// Exchanges the code for their account id, then redirects back to the app
// with ct_platform/ct_merchant/ct_name params (same contract as Square/Clover).

const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://goclicktide.com";
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

function redirect(base: string, params: Record<string, string>): Response {
  const url = new URL(base);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return Response.redirect(url.toString(), 302);
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
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

  return redirect(APP_BASE_URL, {
    ct_platform: "stripe",
    ct_merchant: accountId,
    ct_name: encodeURIComponent(accountName),
  });
});
