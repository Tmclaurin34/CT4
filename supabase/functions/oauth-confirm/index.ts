// Finishes a POS / Stripe connection started with oauth-start (contract C3).
// POST {pending} with Authorization: Bearer <owner JWT>
//   -> {ok:true, platform, merchant_name} | {error}
// The provider callback parked the token under the user who started the flow and sent
// the nonce only to the browser that approved it. The connection is activated only when
// that same user confirms within 10 minutes; anyone else's attempt discards the grant.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const LABEL: Record<string, string> = { square: "Square", shopify: "Shopify", clover: "Clover", stripe: "Stripe" };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const t = await r.text();
  const data = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(data?.message || data?.error || r.statusText);
  return data;
}

async function authedUserId(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return "";
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceRoleKey, Authorization: authorization },
  });
  if (!r.ok) return "";
  const user = await r.json();
  return String(user?.id || "");
}

// Fails open: confirming a connection is an owner-facing flow and costs nothing.
async function underLimit(bucket: string, windowSeconds: number, max: number) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_rate_limit_hit`, {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
    });
    if (!r.ok) return true;
    return (await r.json()) === true;
  } catch {
    return true;
  }
}

// A save that failed for a transient reason puts the grant back, with its original expiry,
// so the owner's retry works; it still dies 10 minutes after the provider redirect.
async function restore(p: Record<string, unknown>) {
  await rest("/rest/v1/oauth_pending", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ nonce: p.nonce, user_id: p.user_id, platform: p.platform, payload: p.payload, created_at: p.created_at, expires_at: p.expires_at }),
  }).catch((e) => console.error("oauth-confirm: restoring the pending grant failed", e));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey) return json({ error: "Server is not configured" }, 500);

  const userId = await authedUserId(req);
  if (!userId) return json({ error: "Please sign in first." }, 401);

  let body: { pending?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  const nonce = String(body?.pending || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(nonce)) return json({ error: "Invalid connection request." }, 400);

  if (!(await underLimit(`oauth-confirm:user:${userId}`, 600, 30))) {
    return json({ error: "Too many attempts — wait a few minutes and try again." }, 429);
  }

  // Consumed first, in one statement: a double-click or a second tab finds nothing, and a
  // wrong-account attempt has already discarded the grant.
  let p: Record<string, unknown> | null = null;
  try {
    const rows = await rest(
      `/rest/v1/oauth_pending?nonce=eq.${nonce}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}` +
        "&select=nonce,user_id,platform,payload,created_at,expires_at",
      { method: "DELETE", headers: { Prefer: "return=representation" } },
    );
    p = Array.isArray(rows) && rows[0] ? rows[0] as Record<string, unknown> : null;
  } catch (e) {
    console.error("oauth-confirm: reading the pending grant failed", e);
    return json({ error: "Could not save the connection. Please try again." }, 500);
  }
  if (!p) return json({ error: "This connection request expired or was already used. Please connect again." }, 404);
  if (String(p.user_id) !== userId) {
    // Approved for a different Clicktide account (or a forwarded link): nobody gets it.
    return json({ error: "This connection was started from a different Clicktide account. Sign in to that account, or start the connection again from this one." }, 403);
  }

  const platform = String(p.platform || "");
  const payload = (p.payload && typeof p.payload === "object" ? p.payload : {}) as Record<string, unknown>;
  const fields = (payload.fields && typeof payload.fields === "object" ? payload.fields : {}) as Record<string, unknown>;
  try {
    const saved = await rest("/rest/v1/rpc/clicktide_platform_connection_save", {
      method: "POST",
      body: JSON.stringify({ p_user: userId, p_platform: platform, p_fields: fields }),
    });
    if (saved?.ok) return json({ ok: true, platform, merchant_name: String(fields.merchant_name || "") });
    if (saved?.reason === "merchant_in_use") {
      return json({ error: `This ${LABEL[platform] || platform} account is already connected to a different Clicktide account. Disconnect it there first, or contact support@goclicktide.com.` }, 409);
    }
    console.error("oauth-confirm: save refused", saved?.reason);
  } catch (e) {
    console.error("oauth-confirm: save failed", e);
  }
  await restore(p);
  return json({ error: "Could not save the connection. Please try again." }, 500);
});
