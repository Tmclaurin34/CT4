// Public customer check-in (QR code flow) for businesses without a POS.
// GET  ?b=<user_id>            -> { business_name }   (for the check-in page header)
// POST { b, name, phone, consent } -> logs a visit, creating the customer if new.
// A 2-hour cooldown per customer prevents double scans from double-counting.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
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

function normalizePhone(value: string) {
  const trimmed = (value || "").trim();
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

// Obviously-fake / placeholder numbers that must never identify a customer
// (0000000000, 5555555555, 1234567890, area code 555, etc.). Without this guard
// every junk entry collapses into one fake "customer".
function isJunkPhone(phone: string) {
  const last10 = (phone || "").replace(/\D/g, "").slice(-10);
  if (last10.length < 10) return true;
  if (/^(\d)\1{9}$/.test(last10)) return true;
  if (last10 === "1234567890" || last10 === "0123456789" || last10 === "1234567891") return true;
  if (/^555/.test(last10)) return true;
  return false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function businessInfo(userId: string) {
  const rows = await rest(
    `/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}&select=business_name,plan&limit=1`,
  );
  if (!Array.isArray(rows) || !rows[0]) return null;
  return {
    name: String(rows[0].business_name || "this business"),
    whiteLabel: String(rows[0].plan || "").toLowerCase() === "scale",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!serviceRoleKey) return json({ error: "Server is not configured" }, 500);

  const url = new URL(req.url);

  if (req.method === "GET") {
    const b = url.searchParams.get("b") || "";
    if (!UUID.test(b)) return json({ error: "Invalid link" }, 400);
    const info = await businessInfo(b);
    if (!info) return json({ error: "Business not found" }, 404);
    return json({ business_name: info.name, white_label: info.whiteLabel });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { b?: string; name?: string; phone?: string; consent?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }

  const b = String(body.b || "");
  if (!UUID.test(b)) return json({ error: "Invalid link" }, 400);
  const info = await businessInfo(b);
  if (!info) return json({ error: "Business not found" }, 404);
  const bizName = info.name;

  const phone = normalizePhone(String(body.phone || ""));
  if (!phone || isJunkPhone(phone)) return json({ error: "Please enter a valid phone number" }, 400);
  const name = String(body.name || "").trim().slice(0, 80);
  const consent = body.consent === true;
  const digits = phone.replace(/\D/g, "").slice(-10);

  try {
    const rows = await rest(
      `/rest/v1/customers?user_id=eq.${encodeURIComponent(b)}&or=(phone.eq.${encodeURIComponent(phone)},phone.like.*${digits})&select=id,name,visits,last_visit_at,sms_consent&limit=1`,
    );
    const existing = Array.isArray(rows) ? rows[0] : null;

    if (existing) {
      // Double-scan guard: one visit per 2 hours.
      const last = existing.last_visit_at ? Date.parse(existing.last_visit_at) : 0;
      if (last && Date.now() - last < 2 * 60 * 60 * 1000) {
        return json({ ok: true, already: true, first_name: String(existing.name || "there").split(/\s+/)[0], business_name: bizName });
      }
      const fields: Record<string, unknown> = {
        visits: (Number(existing.visits) || 0) + 1,
        last_visit_at: new Date().toISOString(),
      };
      if (consent && !existing.sms_consent) {
        fields.sms_consent = true;
        fields.sms_consent_at = new Date().toISOString();
      }
      await rest(`/rest/v1/customers?id=eq.${existing.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(fields),
      });
      return json({ ok: true, first_name: String(existing.name || "there").split(/\s+/)[0], business_name: bizName });
    }

    if (!name) return json({ error: "first_visit_needs_name" }, 422);
    await rest("/rest/v1/customers", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: b,
        name,
        phone,
        visits: 1,
        total_spent: 0,
        status: "active",
        last_visit_at: new Date().toISOString(),
        sms_consent: consent,
        sms_consent_at: consent ? new Date().toISOString() : null,
      }),
    });
    return json({ ok: true, created: true, first_name: name.split(/\s+/)[0], business_name: bizName });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("PLAN_CUSTOMER_LIMIT_REACHED")) {
      rest("/rest/v1/alerts", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          user_id: b,
          type: "plan_limit",
          message: "A new customer tried to check in, but your plan's customer limit is reached. Upgrade to keep growing your list.",
          resolved: false,
        }),
      }).catch(() => {});
      return json({ error: "This business's customer list is full right now — let them know you stopped by!" }, 403);
    }
    console.error("checkin error:", e);
    return json({ error: "Check-in failed — please try again" }, 500);
  }
});
