// Clicktide pre-launch inquiry capture. The site is gated to "email-only" until launch;
// the inquiry form POSTs here. We store the email in launch_inquiries and (best-effort)
// email the owner so inquiries arrive live. verify_jwt = false (public form endpoint).
// Throttled per caller IP; an address already on the list isn't stored or announced
// again, and the owner notifications share an hourly ceiling so a flood can't drain
// the Resend account every tenant's customer email depends on.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND = Deno.env.get("RESEND_API_KEY") ?? "";
const NOTIFY_TO = "clicktidebusiness@gmail.com";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
}

function clientIp(req: Request) {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

// failOpen for the visitor-facing gate (a limiter outage mustn't lose leads); closed
// for the notification email.
async function underLimit(bucket: string, windowSeconds: number, max: number, failOpen: boolean) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/clicktide_rate_limit_hit`, {
      method: "POST",
      headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
    });
    if (!r.ok) return failOpen;
    return (await r.json()) === true;
  } catch {
    return failOpen;
  }
}

async function alreadyListed(email: string) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/launch_inquiries?email=eq.${encodeURIComponent(email)}&select=id&limit=1`, {
      headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
    });
    if (!r.ok) return false;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!(await underLimit(`launch:ip:${clientIp(req)}`, 3600, 10, true))) {
    return json({ error: "Too many requests — please try again in a little while." }, 429);
  }
  let body: { email?: string; source?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const email = String(body.email || "").trim().slice(0, 200);
  const source = String(body.source || "").slice(0, 200);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "A valid email is required" }, 400);

  if (await alreadyListed(email)) return json({ ok: true });

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/launch_inquiries`, {
      method: "POST",
      headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ email, source, user_agent: (req.headers.get("user-agent") || "").slice(0, 300) }),
    });
  } catch (_) { /* don't fail the user on a storage hiccup */ }

  if (RESEND && (await underLimit("launch:notify", 3600, 20, false))) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Clicktide <support@goclicktide.com>",
          to: [NOTIFY_TO],
          subject: `New launch inquiry: ${email}`,
          text: `New pre-launch inquiry\n\nEmail: ${email}\nFrom: ${source}\n`,
        }),
      });
    } catch (_) { /* best-effort */ }
  }
  return json({ ok: true });
});
