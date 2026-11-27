// Attach a Shopify store installed from the Shopify side to the signed-in
// Clicktide business. The browser POSTs { claim } (the ct_shopify_claim value
// from the post-install redirect) with the user's Supabase JWT.
// Single use, 1-hour expiry; only the token's SHA-256 is stored.
// Deploy with verify_jwt = true.
import { BILLING_ENABLED, reconcileBilling, rpc, sha256Hex, SRK, SUPA } from "../_shared/shopify_server.ts";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_BASE_URL") ?? "https://goclicktide.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const authz = req.headers.get("authorization") || "";
  const u = await fetch(`${SUPA}/auth/v1/user`, { headers: { apikey: SRK, Authorization: authz } });
  const user = u.ok ? await u.json() : null;
  if (!user?.id) return json({ error: "Please sign in first." }, 401);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* */ }
  const claim = String(body.claim || "");
  if (!/^[0-9a-f]{64}$/.test(claim)) return json({ error: "Invalid link." }, 400);
  const r = await rpc("clicktide_shopify_claim", { p_token_hash: await sha256Hex(claim), p_user: user.id });
  if (!r?.ok) return json({ error: r?.error === "already_claimed" ? "This store is already linked to another Clicktide account." : "This link has expired. Open Clicktide from your Shopify admin again." }, 409);
  let billing: unknown = null;
  if (BILLING_ENABLED) { try { billing = await reconcileBilling(String(r.shop_domain)); } catch (e) { console.error("billing after claim", e); } }
  return json({ ok: true, shop: r.shop_domain, billing });
});
