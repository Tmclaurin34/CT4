// Gift address collection. A customer follows a tokenized link from a text or
// email ("{{business}} has a gift to mail you") and submits their mailing
// address once. The token is a per-customer random uuid — it IS the auth.
// GET  ?t=TOKEN          -> { ok, first_name, business_name, has_address }
// POST { t, address, city, state, zip } -> saves to the customer row

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

class UserError extends Error {}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = parseJson(await r.text());
  if (!r.ok) throw new Error(data?.message || data?.error || r.statusText);
  return data;
}

function parseJson(text: string) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function clientIp(req: Request) {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

// Fails open: a customer confirming their own address must not be turned away because
// the limiter is unreachable.
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

// Address text is shown in the owner's dashboard and printed on labels; it never
// legitimately contains markup or control characters.
function field(value: unknown, max: number) {
  return String(value ?? "").replace(/[<>]/g, "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

async function verifyAddress(address: string, city: string, state: string, zip: string) {
  const response = await fetch(`${supabaseUrl}/functions/v1/validate-address`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address, city, state, zip }),
  });
  const data = await response.json().catch(() => ({}));
  // Only a definite mismatch rejects the customer. A validator outage must not
  // turn away a customer who is confirming their own address — save it as
  // typed; fulfillment re-checks at ship time anyway.
  if (response.ok && data?.valid === false) {
    throw new UserError("We could not verify that shipping address. Please double-check it.");
  }
  if (!response.ok || data?.valid !== true) return { address1: address, city, region: state, zip, country: "US" };
  return data?.normalized || { address1: address, city, region: state, zip, country: "US" };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function customerByToken(token: string) {
  if (!UUID_RE.test(token)) return null;
  const rows = await rest(
    `/rest/v1/customers?address_request_token=eq.${encodeURIComponent(token)}&select=id,name,user_id,address,city,state,zip,address_confirmed_at&limit=1`,
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!serviceRoleKey) return json({ error: "Server is not configured" }, 500);

  const ip = clientIp(req);
  try {
    if (req.method === "GET") {
      if (!(await underLimit(`gift-address:get:ip:${ip}`, 3600, 60))) {
        return json({ error: "Too many requests — please try again in a few minutes." }, 429);
      }
      const token = new URL(req.url).searchParams.get("t") || "";
      const c = await customerByToken(token);
      if (!c) return json({ error: "This link is not valid." }, 404);
      let businessName = "a business you visit";
      try {
        const biz = await rest(`/rest/v1/clicktide?user_id=eq.${encodeURIComponent(c.user_id)}&select=business_name&limit=1`);
        if (Array.isArray(biz) && biz[0]?.business_name) businessName = String(biz[0].business_name);
      } catch (_) { /* generic name */ }
      const first = String(c.name || "").trim().split(/\s+/)[0] || "there";
      // "All set" only when the customer themselves confirmed the address —
      // a POS-imported address may be the one failing at ship time, and this
      // form is the customer's only way to correct it.
      return json({ ok: true, first_name: first, business_name: businessName, has_address: !!(c.address && c.city && c.state && c.zip && c.address_confirmed_at) });
    }

    if (req.method === "POST") {
      if (!(await underLimit(`gift-address:post:ip:${ip}`, 3600, 20))) {
        return json({ error: "Too many attempts — please try again in a few minutes." }, 429);
      }
      const body = await req.json().catch(() => ({}));
      const token = String(body?.t || "");
      const c = await customerByToken(token);
      if (!c) return json({ error: "This link is not valid." }, 404);
      // Each save may run a paid address check; one link gets a handful a day.
      if (!(await underLimit(`gift-address:post:token:${token.toLowerCase()}`, 86400, 10))) {
        return json({ error: "Too many attempts — please try again tomorrow, or reply to the message." }, 429);
      }
      const address = field(body.address, 120);
      const city = field(body.city, 60);
      const state = field(body.state, 20);
      const zip = field(body.zip, 12);
      if (!address || !city || !state || !zip) return json({ error: "Please fill in every field." }, 400);
      if (!/^[0-9]{5}(-[0-9]{4})?$/.test(zip)) return json({ error: "That ZIP code doesn't look right." }, 400);
      const verified = await verifyAddress(address, city, state, zip);
      await rest(`/rest/v1/customers?id=eq.${encodeURIComponent(String(c.id))}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          address: field(verified.address1 || address, 120),
          city: field(verified.city || city, 60),
          state: field(verified.region || state, 20),
          zip: field(verified.zip || zip, 12),
          address_confirmed_at: new Date().toISOString(),
        }),
      });
      return json({ ok: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    if (e instanceof UserError) return json({ error: e.message }, 400);
    console.error("gift-address error:", e);
    return json({ error: "Something went wrong — please try again." }, 500);
  }
});
