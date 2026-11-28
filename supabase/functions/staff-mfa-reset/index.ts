// staff-mfa-reset (2026-11-28): lets a Clicktide ADMIN remove a locked-out business owner's
// two-step login (TOTP) after verifying who they are, so the owner can log in with their
// password and set two-step up again.
//
// Guards (all must pass):
//   - caller is signed in with two-step (aal2) and is an ACTIVE staff row with role 'admin'
//     (support and partner staff cannot do this);
//   - the target is not a staff account (staff can't reset each other's two-step here);
//   - confirm_email must equal the target's login email (stops resetting the wrong account);
//   - reason must say how identity was verified (at least 15 characters);
//   - at most 1 reset per account per 24h and 5 per admin per 24h.
// Every reset is written to clicktide_admin_audit_log, and the owner is emailed at their
// login address right away ("if this wasn't you, reply now"), so a social-engineered reset
// cannot happen quietly. Passwords are never touched.
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL") || "Clicktide <support@goclicktide.com>";

const ALLOWED_ORIGINS = new Set([
  "https://goclicktide.com",
  "https://www.goclicktide.com",
  "https://clicktide-app.pages.dev",
  "https://preview.clicktide-app.pages.dev",
]);

function corsFor(req: Request) {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(o) ? o : "https://goclicktide.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function svc(extra: Record<string, string> = {}) {
  return { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json", ...extra };
}

function jwtClaims(token: string): Record<string, unknown> {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "=".repeat((4 - (p.length % 4)) % 4)));
  } catch {
    return {};
  }
}

async function underLimit(bucket: string, windowSeconds: number, max: number) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_rate_limit_hit`, {
      method: "POST",
      headers: svc(),
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
    });
    if (!r.ok) return false;
    return (await r.json()) === true;
  } catch {
    return false; // fail closed
  }
}

function esc(v: unknown) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c] as string));
}

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey) return json({ error: "Not configured" }, 503);

  // 1. Who is calling? (GoTrue validates the token; only then are its claims trusted.)
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Unauthorized" }, 401);
  const meR = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${token}` } });
  if (!meR.ok) return json({ error: "Unauthorized" }, 401);
  const me = await meR.json();
  if (jwtClaims(token).aal !== "aal2") return json({ error: "Two-step login required for this action" }, 403);
  const staffR = await fetch(
    `${supabaseUrl}/rest/v1/clicktide_staff?user_id=eq.${encodeURIComponent(me.id)}&is_active=eq.true&role=eq.admin&select=user_id`,
    { headers: svc() },
  );
  const staffRows = staffR.ok ? await staffR.json() : [];
  if (!Array.isArray(staffRows) || !staffRows.length) return json({ error: "Only an admin can reset two-step login" }, 403);

  // 2. Input
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* */ }
  const clientId = String(body.client_user_id || "");
  const reason = String(body.reason || "").trim();
  const confirmEmail = String(body.confirm_email || "").trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return json({ error: "Pick a client first" }, 400);
  if (reason.length < 15) return json({ error: "Write how you verified it's really the owner (at least 15 characters)" }, 400);
  if (clientId === me.id) return json({ error: "You can't reset your own two-step login here" }, 400);

  // 3. Target checks
  const anyStaff = await fetch(`${supabaseUrl}/rest/v1/clicktide_staff?user_id=eq.${clientId}&select=user_id`, { headers: svc() });
  const anyStaffRows = anyStaff.ok ? await anyStaff.json() : [{}];
  if (!Array.isArray(anyStaffRows) || anyStaffRows.length) return json({ error: "That is a staff account; this tool is for business owners only" }, 403);
  const tR = await fetch(`${supabaseUrl}/auth/v1/admin/users/${clientId}`, { headers: svc() });
  if (!tR.ok) return json({ error: "Account not found" }, 404);
  const target = await tR.json();
  const targetEmail = String(target.email || "").toLowerCase();
  if (!targetEmail || confirmEmail !== targetEmail) return json({ error: "The email you typed doesn't match this account's login email" }, 400);
  const factors = (Array.isArray(target.factors) ? target.factors : []) as Array<{ id: string; factor_type?: string; status?: string }>;
  if (!factors.length) return json({ ok: true, removed: 0, message: "This account has no two-step login set up; nothing to reset." });

  // 4. Limits (checked only for a real reset)
  if (!(await underLimit(`mfa_reset:client:${clientId}`, 86400, 1))) return json({ error: "This account's two-step login was already reset in the last 24 hours" }, 429);
  if (!(await underLimit(`mfa_reset:actor:${me.id}`, 86400, 5))) return json({ error: "Daily limit for two-step resets reached" }, 429);

  // 5. Remove factors
  let removed = 0;
  const failed: string[] = [];
  for (const f of factors) {
    const d = await fetch(`${supabaseUrl}/auth/v1/admin/users/${clientId}/factors/${f.id}`, { method: "DELETE", headers: svc() });
    if (d.ok) removed++; else failed.push(`${f.factor_type || "factor"}:${d.status}`);
  }

  // 6. Audit (always) + notify the owner
  await fetch(`${supabaseUrl}/rest/v1/clicktide_admin_audit_log`, {
    method: "POST",
    headers: svc({ Prefer: "return=minimal" }),
    body: JSON.stringify({
      actor_user_id: me.id, client_user_id: clientId, action: "mfa_reset", target_table: "auth.mfa_factors",
      details: { removed, failed, reason: reason.slice(0, 500), factor_types: factors.map((f) => f.factor_type || "") },
    }),
  }).catch(() => {});

  let emailed = false;
  if (removed > 0 && resendApiKey) {
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111827;max-width:560px;line-height:1.55">
      <p>Hi,</p>
      <p>At your request, Clicktide support turned off <b>two-step login</b> on your account (${esc(targetEmail)}). Your password did not change.</p>
      <p>Next time you log in you'll only need your password. We recommend turning two-step login back on right away in <b>Dashboard &rarr; Settings &rarr; Security</b>.</p>
      <p style="color:#991B1B"><b>Didn't ask for this?</b> Reply to this email or write to support@goclicktide.com immediately, and change your password.</p>
      <p style="color:#6B7280;font-size:12px;margin-top:22px">Clicktide &middot; P.O. Box 304, Glen Cove, NY 11542</p></div>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: resendFrom, to: [targetEmail], reply_to: "support@goclicktide.com", subject: "Your Clicktide two-step login was reset", html }),
    }).catch(() => null);
    emailed = !!r && r.ok;
  }

  if (failed.length && !removed) return json({ error: "Couldn't remove two-step login", failed }, 502);
  return json({ ok: true, removed, failed, emailed });
});
