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

// ---- Cloudflare Turnstile (package "turnstile", 2026-11-27) -----------------------------
// DORMANT until the owner sets the TURNSTILE_SECRET_KEY edge secret: with no secret the check
// is skipped (logged once per instance), so nothing changes before then. With a secret, the
// request needs a token (body field turnstile_token) that Cloudflare's siteverify accepts,
// solved on one of Clicktide's own hostnames, for this form's action. Single-use: siteverify
// refuses a replayed token (timeout-or-duplicate).
// "unavailable" = siteverify could not give an answer (network error, timeout, non-JSON
// reply, or Cloudflare says our secret is missing/invalid or it had an internal error). Each
// function decides what that means (see TURNSTILE_FAIL_OPEN below).
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_HOSTS = ["goclicktide.com", "www.goclicktide.com", "clicktide-app.pages.dev"];
const TURNSTILE_REFUSED = { ok: false, error: "Please complete the check", code: "turnstile_failed" };
const TURNSTILE_DOWN = { ok: false, error: "The security check is unavailable right now. Please try again in a minute.", code: "turnstile_unavailable" };
let turnstileOffLogged = false;

function turnstileHostOk(host: unknown) {
  const h = String(host || "").toLowerCase();
  // the Pages project's own preview aliases (preview.clicktide-app.pages.dev, <hash>.…)
  return TURNSTILE_HOSTS.includes(h) || h.endsWith(".clicktide-app.pages.dev");
}

async function turnstileCheck(req: Request, token: unknown, action: string): Promise<"ok" | "skipped" | "rejected" | "unavailable"> {
  const secret = (Deno.env.get("TURNSTILE_SECRET_KEY") ?? "").trim();
  if (!secret) {
    if (!turnstileOffLogged) { turnstileOffLogged = true; console.log("turnstile: TURNSTILE_SECRET_KEY is not set; check skipped"); }
    return "skipped";
  }
  const t = typeof token === "string" ? token.trim() : "";
  if (!t || t.length > 2048) return "rejected";
  const form = new URLSearchParams({ secret, response: t });
  const ip = (req.headers.get("cf-connecting-ip") || "").trim();
  if (ip) form.set("remoteip", ip);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  let d: { success?: unknown; hostname?: unknown; action?: unknown; "error-codes"?: unknown } | null = null;
  try {
    const r = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: ctrl.signal,
    });
    d = await r.json();
  } catch (e) {
    console.error("turnstile: siteverify unreachable", e instanceof Error ? e.name : String(e));
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
  if (!d || typeof d !== "object" || typeof d.success !== "boolean") return "unavailable";
  const codes = Array.isArray(d["error-codes"]) ? (d["error-codes"] as unknown[]).map(String) : [];
  if (d.success !== true) {
    // A missing or wrong secret is a configuration error, not an outage: refuse the request so
    // the owner sees it at once (a fail-open function would otherwise run with no bot check).
    if (codes.some((c) => c === "missing-input-secret" || c === "invalid-input-secret")) {
      console.error("turnstile: secret misconfigured:", codes.join(","));
      return "rejected";
    }
    if (codes.some((c) => c === "internal-error")) {
      console.error("turnstile: siteverify internal error:", codes.join(","));
      return "unavailable";
    }
    return "rejected";
  }
  if (!turnstileHostOk(d.hostname)) { console.warn("turnstile: token from an unexpected hostname"); return "rejected"; }
  if (action && d.action !== action) { console.warn("turnstile: token for a different action"); return "rejected"; }
  return "ok";
}
// launch-inquiry fails CLOSED when siteverify can't answer (it stores and emails what it gets).
const TURNSTILE_ACTION = "launch_inquiry";

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
  let body: { email?: string; source?: string; turnstile_token?: unknown };
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  // After the per-IP limit and before anything is read, stored or emailed.
  const ts = await turnstileCheck(req, body?.turnstile_token, TURNSTILE_ACTION);
  if (ts === "rejected") return json(TURNSTILE_REFUSED, 400);
  if (ts === "unavailable") return json(TURNSTILE_DOWN, 503);
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
