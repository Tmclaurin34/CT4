const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
const whsec = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const supa = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function verify(body: string, header: string) {
  const bits = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (!bits.t || !bits.v1 || !whsec) throw new Error("Missing webhook signature");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(whsec), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bits.t + "." + body));
  if (!same(toHex(sig), bits.v1)) throw new Error("Invalid webhook signature");
}

async function stripeGet(path: string) {
  const r = await fetch("https://api.stripe.com/v1/" + path, { headers: { Authorization: "Bearer " + stripeKey } });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || "Stripe request failed");
  return d;
}

async function patchProfile(filter: string, fields: Record<string, unknown>) {
  const r = await fetch(supa + "/rest/v1/clicktide?" + filter, {
    method: "PATCH",
    headers: {
      apikey: serviceKey,
      Authorization: "Bearer " + serviceKey,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(fields),
  });
  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function saveSubscription(sub: Record<string, unknown>, fallback: Record<string, unknown> = {}) {
  const meta = (sub.metadata || fallback.metadata || {}) as Record<string, string>;
  const item = (sub.items as { data?: Array<{ price?: { id?: string } }> } | undefined)?.data?.[0];
  const periodEnd = sub.current_period_end as number | undefined;
  const fields = {
    plan: meta.plan || fallback.plan || "Growth",
    stripe_customer_id: sub.customer || fallback.customer || null,
    stripe_subscription_id: sub.id || fallback.subscription || null,
    stripe_subscription_status: sub.status || fallback.payment_status || null,
    stripe_price_id: item?.price?.id || null,
    stripe_current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
  };
  if (meta.user_id && await patchProfile("user_id=eq." + encodeURIComponent(meta.user_id), fields)) return;
  if (fields.stripe_customer_id && await patchProfile("stripe_customer_id=eq." + encodeURIComponent(String(fields.stripe_customer_id)), fields)) return;
  if (fallback.email) await patchProfile("email=eq." + encodeURIComponent(String(fallback.email)), fields);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!stripeKey || !serviceKey) return json({ error: "Missing server secrets" }, 500);
  const body = await req.text();
  try {
    await verify(body, req.headers.get("stripe-signature") || "");
    const event = JSON.parse(body);
    const obj = event.data.object;
    if (event.type === "checkout.session.completed") {
      const sub = obj.subscription ? await stripeGet("subscriptions/" + obj.subscription) : {};
      await saveSubscription(sub, { metadata: obj.metadata || {}, customer: obj.customer, subscription: obj.subscription, payment_status: obj.payment_status, email: obj.customer_email });
    }
    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      await saveSubscription(obj);
    }
    return json({ received: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Webhook failed" }, 400);
  }
});
