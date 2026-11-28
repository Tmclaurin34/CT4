// One-time offer codes: the customer's claim view and the staff redeem / undo actions.
// Deployed 2026-11-28 (owner approved offer codes). Needs migration
// 20261128050000_offer_codes.sql. Deploy with verify_jwt=false: the page calling it is public
// (goclicktide.com/o?c=CODE) and the staff device proves itself with its device token.
//
// POST { action: "view",   code }                -> the offer, business and customer FIRST name
// POST { action: "redeem", code, device_token }  -> one step: marks the code used (or says why not)
// POST { action: "undo",   code, device_token }  -> within 2 minutes of the scan
//
// Rate limits per IP (clicktide_rate_limit_hit): 60 views / 10 min, 120 redeem+undo / 10 min,
// so codes can't be guessed by brute force (they're ~6.6e11 combinations anyway).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGINS = ["https://goclicktide.com", "https://www.goclicktide.com"];

function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  const ok = ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+\.clicktide-app\.pages\.dev$/.test(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function clientIp(req: Request) {
  return (req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0] || "unknown").trim();
}

async function rpc(name: string, args: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return text ? JSON.parse(text) : null;
}

async function underLimit(bucket: string, windowSeconds: number, max: number) {
  try {
    return (await rpc("clicktide_rate_limit_hit", { p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max })) === true;
  } catch {
    return false; // fail closed: a limiter outage must not open the door to guessing
  }
}

const CODE_RE = /^[A-Z]{1,4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
  if (!SRK) return json(req, { error: "Server is not configured" }, 500);

  let body: { action?: string; code?: string; device_token?: string };
  try { body = await req.json(); } catch { return json(req, { error: "Invalid JSON" }, 400); }
  const action = String(body?.action || "");
  const code = String(body?.code || "").trim().toUpperCase();
  if (!CODE_RE.test(code)) return json(req, { result: "not_found" });
  const ip = clientIp(req);

  try {
    if (action === "view") {
      if (!(await underLimit(`offer_view:${ip}`, 600, 60))) return json(req, { error: "Too many requests" }, 429);
      const view = await rpc("clicktide_offer_code_public", { p_code: code });
      return json(req, view && view.found ? view : { result: "not_found" });
    }
    if (action === "redeem" || action === "undo") {
      if (!(await underLimit(`offer_staff:${ip}`, 600, 120))) return json(req, { error: "Too many requests" }, 429);
      const token = String(body?.device_token || "");
      if (token.length < 32) return json(req, { result: "not_a_staff_device" });
      const out = await rpc(action === "redeem" ? "clicktide_offer_code_redeem" : "clicktide_offer_code_undo",
        { p_device_token: token, p_code: code });
      return json(req, out || { result: "error" });
    }
    return json(req, { error: "Unknown action" }, 400);
  } catch (e) {
    console.error("offer-redeem", action, e instanceof Error ? e.message : e);
    return json(req, { error: "Something went wrong. Try again." }, 500);
  }
});
