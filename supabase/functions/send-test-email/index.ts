// Admin-only test sender: previews outreach/lifecycle emails to our own inboxes.
// Cron key or an admin/support staff session. Always sent from RESEND_FROM_EMAIL, and
// only to Clicktide's own inboxes: active admin/support staff accounts, or an address
// on a domain listed in TEST_EMAIL_ALLOWED_DOMAINS (comma-separated; default
// goclicktide.com).
// Body: { to: string|string[], subject: string, text?: string, html?: string }

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL") ?? "Clicktide <support@goclicktide.com>";
const allowedDomains = (Deno.env.get("TEST_EMAIL_ALLOWED_DOMAINS") ?? "goclicktide.com")
  .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);

const MAX_RECIPIENTS = 5;
const SENDS_PER_DAY = 50;
const EMAIL_RE = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function expectedCronKey() {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_internal_key`, {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: "{}",
    });
    return r.ok ? String(await r.json()) : "";
  } catch {
    return "";
  }
}

// Staff check through clicktide_is_staff with the CALLER's own token, so the database's
// staff rules (including any MFA requirement) decide.
async function isStaff(req: Request, roles: string[]) {
  const authorization = req.headers.get("authorization") || "";
  if (!/^bearer\s+\S+/i.test(authorization)) return false;
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_is_staff`, {
      method: "POST",
      headers: { apikey: anonKey || serviceRoleKey, Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ required_roles: roles }),
    });
    if (!r.ok) return false;
    return (await r.json()) === true;
  } catch {
    return false;
  }
}

// Fails closed: this sends email.
async function underLimit(bucket: string, windowSeconds: number, max: number) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_rate_limit_hit`, {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
    });
    if (!r.ok) return false;
    return (await r.json()) === true;
  } catch {
    return false;
  }
}

// Login emails of active admin/support staff.
async function staffEmails() {
  const emails = new Set<string>();
  const r = await fetch(`${supabaseUrl}/rest/v1/clicktide_staff?is_active=eq.true&role=in.(admin,support)&select=user_id`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!r.ok) return emails;
  const rows = await r.json().catch(() => []);
  for (const row of Array.isArray(rows) ? rows.slice(0, 50) : []) {
    const u = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(String(row.user_id || ""))}`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });
    if (!u.ok) continue;
    const user = await u.json().catch(() => null);
    if (user?.email) emails.add(String(user.email).toLowerCase());
  }
  return emails;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey || !resendApiKey) return json({ error: "Not configured" }, 500);
  const key = req.headers.get("x-clicktide-cron-key") || "";
  const allowed = (key && safeEqual(key, await expectedCronKey())) || await isStaff(req, ["admin", "support"]);
  if (!allowed) return json({ error: "Not authorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const to = (Array.isArray(body?.to) ? body.to : [body?.to]).map((t: unknown) => String(t || "").trim()).filter(Boolean);
  if (!to.length) return json({ error: "to is required" }, 400);
  if (to.length > MAX_RECIPIENTS) return json({ error: `At most ${MAX_RECIPIENTS} recipients` }, 400);
  if (to.some((t: string) => !EMAIL_RE.test(t))) return json({ error: "Every recipient must be a plain email address" }, 400);

  const staff = await staffEmails();
  const notAllowed = to.filter((t: string) => {
    const lower = t.toLowerCase();
    return !staff.has(lower) && !allowedDomains.includes(lower.split("@").pop() || "");
  });
  if (notAllowed.length) {
    return json({ error: "Test emails only go to Clicktide staff inboxes or allowed test domains", rejected: notAllowed }, 400);
  }
  if (!(await underLimit("test-email:global", 86400, SENDS_PER_DAY))) {
    return json({ error: "Daily test-email limit reached" }, 429);
  }

  const payload: Record<string, unknown> = { from: resendFrom, to, subject: String(body?.subject || "(test)").slice(0, 200) };
  if (body?.html) payload.html = String(body.html);
  else payload.text = String(body?.text || "");

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  return json({ ok: r.ok, id: data.id || null, error: r.ok ? null : (data.message || "send failed") }, r.ok ? 200 : 500);
});
