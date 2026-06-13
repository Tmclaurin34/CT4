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
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.message || data?.error || r.statusText);
  return data;
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
    throw new Error(data?.error || "We could not verify that shipping address. Please double-check it.");
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

  try {
    if (req.method === "GET") {
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
      const body = await req.json().catch(() => ({}));
      const token = String(body.t || "");
      const c = await customerByToken(token);
      if (!c) return json({ error: "This link is not valid." }, 404);
      const address = String(body.address || "").trim().slice(0, 120);
      const city = String(body.city || "").trim().slice(0, 60);
      const state = String(body.state || "").trim().slice(0, 20);
      const zip = String(body.zip || "").trim().slice(0, 12);
      if (!address || !city || !state || !zip) return json({ error: "Please fill in every field." }, 400);
      if (!/^[0-9]{5}(-[0-9]{4})?$/.test(zip)) return json({ error: "That ZIP code doesn't look right." }, 400);
      const verified = await verifyAddress(address, city, state, zip);
      await rest(`/rest/v1/customers?id=eq.${c.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          address: String(verified.address1 || address),
          city: String(verified.city || city),
          state: String(verified.region || state),
          zip: String(verified.zip || zip),
          address_confirmed_at: new Date().toISOString(),
        }),
      });
      return json({ ok: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Something went wrong" }, 500);
  }
});
