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

// US numbers only, returned as +1XXXXXXXXXX. The result is built from digits alone,
// so nothing the visitor typed can reach a database filter.
function normalizePhone(value: string) {
  const digits = String(value || "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : "";
}

function clientIp(req: Request) {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

// Fails open: check-in at the counter must keep working if the limiter is unreachable.
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

// The page inserts first_name into HTML, so only plain characters go back.
function safeFirstName(name: string) {
  return String(name || "").trim().split(/\s+/)[0].replace(/[<>&"'`\\]/g, "").slice(0, 40);
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
    // Owner-editable and shown on public pages that use innerHTML: never let it form a tag.
    name: String(rows[0].business_name || "this business").replace(/[<>]/g, ""),
    whiteLabel: String(rows[0].plan || "").toLowerCase() === "scale",
  };
}

// Retention engine visit history: a counted check-in is a visit (same-day check-ins
// merge into one). Never blocks the check-in itself.
async function recordCheckinVisit(userId: string, customerId: unknown, at: string) {
  try {
    await rest("/rest/v1/rpc/clicktide_record_visit", {
      method: "POST",
      body: JSON.stringify({ p_user: userId, p_customer: Number(customerId), p_at: at, p_amount: 0, p_source: "checkin", p_txn_id: null }),
    });
  } catch (e) {
    console.error("record_visit (checkin) failed", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!serviceRoleKey) return json({ error: "Server is not configured" }, 500);

  const url = new URL(req.url);

  const ip = clientIp(req);

  if (req.method === "GET") {
    const b = url.searchParams.get("b") || "";
    if (!UUID.test(b)) return json({ error: "Invalid link" }, 400);
    if (!(await underLimit(`checkin:get:ip:${ip}`, 3600, 120))) return json({ error: "Too many requests — please try again shortly." }, 429);
    const info = await businessInfo(b);
    if (!info) return json({ error: "Business not found" }, 404);
    return json({ business_name: info.name, white_label: info.whiteLabel });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { b?: string; name?: string; phone?: string; consent?: boolean; consent_marketing?: boolean; consent_transactional?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }

  const b = String(body.b || "");
  if (!UUID.test(b)) return json({ error: "Invalid link" }, 400);
  // One visitor can't flood a business's list; one business can't be flooded by many.
  if (!(await underLimit(`checkin:post:ip:${ip}`, 3600, 30)) || !(await underLimit(`checkin:post:biz:${b}`, 3600, 400))) {
    return json({ error: "Too many check-ins right now — please try again shortly." }, 429);
  }
  const info = await businessInfo(b);
  if (!info) return json({ error: "Business not found" }, 404);
  const bizName = info.name;

  const phone = normalizePhone(String(body.phone || ""));
  if (!phone || isJunkPhone(phone)) return json({ error: "Please enter a valid phone number" }, 400);
  // Names typed on this public page end up in the owner's dashboard; angle brackets
  // are never part of a real name and would only carry HTML.
  const name = String(body.name || "").replace(/[<>]/g, "").trim().slice(0, 80);
  // Marketing texts need the marketing box. Older pages only send `consent`.
  const marketing = typeof body.consent_marketing === "boolean" ? body.consent_marketing : body.consent === true;
  const service = body.consent_transactional === true;
  const digits = phone.slice(-10); // exactly 10 digits, validated above
  // Only echo back what the visitor typed — never the stored name, so a phone
  // number can't be used to look up who a business's customers are.
  const firstName = safeFirstName(name);
  const now = new Date().toISOString();

  try {
    const rows = await rest(
      `/rest/v1/customers?user_id=eq.${b}&or=(phone.eq.%2B1${digits},phone.like.*${digits})&select=id,visits,last_visit_at,sms_consent,sms_service_consent&limit=1`,
    );
    const existing = Array.isArray(rows) ? rows[0] : null;

    if (existing) {
      // Double-scan guard: one visit per 2 hours.
      const last = existing.last_visit_at ? Date.parse(existing.last_visit_at) : 0;
      if (last && Date.now() - last < 2 * 60 * 60 * 1000) {
        return json({ ok: true, already: true, first_name: firstName, business_name: bizName });
      }
      const fields: Record<string, unknown> = {
        visits: (Number(existing.visits) || 0) + 1,
        last_visit_at: now,
      };
      if (marketing && !existing.sms_consent) {
        fields.sms_consent = true;
        fields.sms_consent_at = now;
      }
      if (service && !existing.sms_service_consent) {
        fields.sms_service_consent = true;
        fields.sms_service_consent_at = now;
      }
      await rest(`/rest/v1/customers?id=eq.${encodeURIComponent(String(existing.id))}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(fields),
      });
      await recordCheckinVisit(b, existing.id, now);
      return json({ ok: true, first_name: firstName, business_name: bizName });
    }

    if (!name) return json({ error: "first_visit_needs_name" }, 422);
    const created = await rest("/rest/v1/customers?select=id", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: b,
        name,
        phone,
        visits: 1,
        total_spent: 0,
        status: "active",
        last_visit_at: now,
        sms_consent: marketing,
        sms_consent_at: marketing ? now : null,
        sms_service_consent: service,
        sms_service_consent_at: service ? now : null,
      }),
    });
    const newId = Array.isArray(created) ? created[0]?.id : null;
    if (newId) await recordCheckinVisit(b, newId, now);
    return json({ ok: true, created: true, first_name: firstName, business_name: bizName });
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
