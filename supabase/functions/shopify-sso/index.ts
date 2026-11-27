// Swap a one-time Shopify sign-in code (goclicktide.com/#ct_sso=…, minted by shopify-app or
// shopify-oauth-callback for a store's own Clicktide account) for a session. The browser POSTs
// { code }; the code is single use, 60 seconds, bound to account + shop, and refused for staff or
// without an active store connection (clicktide_shopify_sso_take). The page still shows its
// sign-in confirmation, and two-step accounts are still asked for their code (the session is aal1).
// Deploy with verify_jwt = false.
import { rpc, sessionForSsoCode } from "../_shared/shopify_server.ts";

const ORIGIN = Deno.env.get("APP_BASE_URL") ?? "https://goclicktide.com";
const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function clientIp(req: Request) {
  return (req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0] || "unknown").trim();
}

const EXPIRED = "This sign-in link expired. Open Clicktide from your Shopify admin again.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    if (await rpc("clicktide_rate_limit_hit", { p_bucket: `shopify-sso:ip:${clientIp(req)}`, p_window_seconds: 600, p_max: 30 }) !== true) {
      return json({ error: "Too many attempts. Wait a few minutes and open Clicktide from your Shopify admin again." }, 429);
    }
  } catch { return json({ error: "Clicktide couldn't sign you in right now. Please try again." }, 503); }
  let code = "";
  try { code = String((await req.json())?.code || ""); } catch { /* */ }
  if (!/^[0-9a-f]{64}$/.test(code)) return json({ error: EXPIRED }, 400);
  try {
    const s = await sessionForSsoCode(code);
    if (!s) return json({ error: EXPIRED }, 401);
    return json(s);
  } catch (e) {
    console.error("shopify-sso failed", e);
    return json({ error: "Clicktide couldn't sign you in right now. Please try again." }, 502);
  }
});
