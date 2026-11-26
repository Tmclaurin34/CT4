// create-portal-session — opens the Stripe Customer Portal so a logged-in owner
// can change plan, update payment method, or cancel. No card data touches us.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function allowedRedirect(url: string) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const localDev = (host === "localhost" || host === "127.0.0.1");
    if (u.protocol !== "https:" && !(u.protocol === "http:" && localDev)) return false;
    if (host === "goclicktide.com" || host === "www.goclicktide.com") return true;
    if (host === "clicktide-app.pages.dev" || host.endsWith(".clicktide-app.pages.dev")) return true;
    return localDev;
  } catch { return false; }
}
function safeUrl(v: unknown) { return typeof v === "string" && allowedRedirect(v) ? v : ""; }
async function authedUserId(req: Request) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const authorization = req.headers.get("authorization") || "";
  if (!serviceRoleKey || !authorization.toLowerCase().startsWith("bearer ")) return "";
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: serviceRoleKey, Authorization: authorization } });
  if (!response.ok) return "";
  const user = await response.json();
  return String(user?.id || "");
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeSecretKey) return json({ error: "Stripe secret key is not configured" }, 500);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  let body: { return_url?: string } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  const userId = await authedUserId(req);
  if (!userId) return json({ error: "Login is required to manage billing" }, 401);
  const rawOrigin = req.headers.get("origin") || "";
  const origin = allowedRedirect(rawOrigin + "/") ? rawOrigin : "https://goclicktide.com";
  const returnUrl = safeUrl(body.return_url) || `${origin}/?billing=updated`;
  const q = await fetch(`${supabaseUrl}/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}&select=stripe_customer_id&limit=1`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  const rows = await q.json().catch(() => []);
  const customerId = Array.isArray(rows) && rows[0] ? rows[0].stripe_customer_id : "";
  if (!customerId) return json({ error: "No subscription found on this account yet. Start a plan first, then you can manage it here." }, 404);
  const form = new URLSearchParams();
  form.set("customer", String(customerId));
  form.set("return_url", returnUrl);
  const r = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${stripeSecretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const d = await r.json();
  if (!r.ok) return json({ error: d?.error?.message || "Could not open the billing portal" }, r.status);
  return json({ url: d.url });
});
