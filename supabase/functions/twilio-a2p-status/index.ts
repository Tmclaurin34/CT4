// Read-only A2P 10DLC status checker (ops tool). Gated by x-clicktide-cron-key.
// Reports Twilio brand registration + per-messaging-service campaign status so we
// can see when carriers approve texting without digging through the console.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const authToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 1), { status, headers: { "Content-Type": "application/json" } });
}

async function internalKey(): Promise<string> {
  const r = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_internal_key`, {
    method: "POST",
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!r.ok) return "";
  const v = await r.json().catch(() => "");
  return typeof v === "string" ? v : "";
}

async function twilio(url: string) {
  const r = await fetch(url, { headers: { Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}` } });
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!accountSid || !authToken) return json({ error: "Twilio is not configured" }, 500);

  const provided = req.headers.get("x-clicktide-cron-key") || "";
  const expected = await internalKey();
  if (!expected || provided !== expected) return json({ error: "Unauthorized" }, 401);

  try {
    const out: Record<string, unknown> = {};

    const brands = await twilio("https://messaging.twilio.com/v1/a2p/BrandRegistrations?PageSize=20");
    out.brands = brands.ok
      ? (brands.data?.data || []).map((b: Record<string, unknown>) => ({
          sid: b.sid, status: b.status, failure_reason: b.failure_reason || null,
          brand_type: b.brand_type, identity_status: b.identity_status || null, updated: b.date_updated,
        }))
      : { error: brands.status, detail: brands.data };

    const services = await twilio("https://messaging.twilio.com/v1/Services?PageSize=20");
    const svcList = services.ok ? (services.data?.services || []) : [];
    out.services = [];
    for (const s of svcList) {
      const camp = await twilio(`https://messaging.twilio.com/v1/Services/${s.sid}/Compliance/Usa2p?PageSize=10`);
      (out.services as unknown[]).push({
        sid: s.sid, name: s.friendly_name,
        campaigns: camp.ok
          ? (camp.data?.compliance || []).map((c: Record<string, unknown>) => ({
              sid: c.sid, status: c.campaign_status, use_case: c.us_app_to_person_usecase,
              errors: c.errors || null, updated: c.date_updated,
            }))
          : { error: camp.status, detail: camp.data },
      });
    }
    if (!services.ok) out.services = { error: services.status, detail: services.data };

    return json({ ok: true, ...out });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "status check failed" }, 500);
  }
});
