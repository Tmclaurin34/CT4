// Custom password-reset: generates a Supabase recovery link with the service role
// and delivers it via Resend (support@goclicktide.com) so the email actually
// arrives — the built-in Supabase mailer was unreliable. Public endpoint; never
// reveals whether an account exists. Supabase Auth's own email limits don't apply to
// this path, so it is rate limited here: per caller IP, and per address (one a minute,
// five a day) so nobody can mail-bomb an owner or keep invalidating their reset link.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL") ?? "Clicktide <support@goclicktide.com>";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function escapeHtml(v: string) {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function clientIp(req: Request) {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

// Fails closed: every request that passes can send an email.
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

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const TOO_MANY = { ok: false, error: "Too many reset requests. Please wait a few minutes and try again." };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!(await underLimit(`pwreset:ip:${clientIp(req)}`, 3600, 20))) return json(TOO_MANY, 429);

  let email = "";
  let redirectTo = "https://goclicktide.com";
  try {
    const body = await req.json();
    email = String(body.email || "").trim().toLowerCase();
    if (body.redirect_to && /^https:\/\/(www\.)?goclicktide\.com(\/|$)/.test(String(body.redirect_to))) redirectTo = String(body.redirect_to);
  } catch { /* ignore */ }

  // Always return ok — never leak whether the account exists.
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: true });
  if (!serviceRoleKey || !resendApiKey) return json({ ok: true });

  // Counted for every address, registered or not, so the limit itself reveals nothing.
  const who = (await sha256Hex(email)).slice(0, 32);
  if (!(await underLimit(`pwreset:email:min:${who}`, 60, 1)) || !(await underLimit(`pwreset:email:day:${who}`, 86400, 5))) {
    return json(TOO_MANY, 429);
  }

  try {
    const gen = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "recovery", email, options: { redirect_to: redirectTo } }),
    });
    const data = await gen.json().catch(() => ({}));
    const link = data?.action_link || data?.properties?.action_link || "";
    if (!gen.ok || !link) return json({ ok: true }); // no such user, or error — stay silent

    const inner = `<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#FFFFFF;border-radius:14px;border:1px solid #E9EBEF">
        <tr><td align="center" style="padding:28px 30px 14px"><div style="font-size:22px;font-weight:bold;color:#0B62D6">Clicktide</div></td></tr>
        <tr><td style="padding:6px 34px 4px;color:#1F2937;font-size:16px;line-height:1.7">Reset your password</td></tr>
        <tr><td style="padding:4px 34px 0;color:#4B5563;font-size:14px;line-height:1.7">We got a request to reset your Clicktide password. Click below to choose a new one. This link expires in 1 hour.</td></tr>
        <tr><td align="center" style="padding:22px 30px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#0B62D6;color:#FFFFFF;font-weight:bold;font-size:15px;text-decoration:none;padding:13px 34px;border-radius:10px">Reset my password</a></td></tr>
        <tr><td style="padding:0 34px 24px;color:#9CA3AF;font-size:12px;line-height:1.6">Didn’t request this? You can safely ignore this email — your password won’t change.</td></tr>
      </table></td></tr></table>`;
    const shell = `<div style="background:#F4F5F7;padding:26px 12px;font-family:Arial,Helvetica,sans-serif">${inner}</div>`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: resendFrom, to: [email], subject: "Reset your Clicktide password", html: shell }),
    }).catch(() => {});
  } catch { /* stay silent */ }

  return json({ ok: true });
});
