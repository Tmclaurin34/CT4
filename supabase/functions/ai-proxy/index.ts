// AI writing helper for the dashboard ("Write with AI") and onboarding hints.
// Onboarding runs before sign-in, so anonymous calls are still allowed — but only in a
// small, separate pool: the Origin header can be faked outside a browser, so it is not
// treated as proof of anything. Two tiers:
//  - Signed-in owners (a valid Supabase JWT): per-account limits and their own daily
//    ceiling, so anonymous traffic can never use up the AI budget paying tenants rely on.
//  - Anonymous: tight per-IP limits, a small platform-wide daily pool, short answers and a
//    fixed system prompt, which makes the endpoint useless as a general-purpose relay.
// Only short plain-text prompts are accepted, the model and output size are fixed here,
// and every limiter fails closed, which bounds the worst-case Anthropic bill.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_MESSAGES = 4;
const MAX_MESSAGE_CHARS = 4000;
const MAX_SYSTEM_CHARS = 2000;

// Signed-in owners.
const USER_MAX_OUTPUT_TOKENS = 600;
const USER_MAX_TOTAL_CHARS = 8000;
const PER_USER_PER_HOUR = 60;
const PER_USER_PER_DAY = 300;
const USER_GLOBAL_PER_DAY = 3000;

// Anonymous (onboarding hints, demo).
const ANON_MAX_OUTPUT_TOKENS = 300;
const ANON_MAX_TOTAL_CHARS = 2500;
const PER_IP_PER_HOUR = 10;
const PER_IP_PER_DAY = 30;
const ANON_GLOBAL_PER_DAY = 400;
const ANON_SYSTEM = "You are Clicktide's writing assistant for local small businesses (customer retention, " +
  "win-back messages, gifts and onboarding tips). Be concise, friendly and specific. Only help with " +
  "Clicktide-related small-business marketing copy; politely decline anything else.";

function allowedOrigin(origin: string) {
  return /^https:\/\/(www\.)?goclicktide\.com$/.test(origin) ||
    /^https:\/\/([a-z0-9-]+\.)?clicktide-app\.pages\.dev$/.test(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsFor(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...(origin ? corsFor(origin) : {}), "Content-Type": "application/json" },
  });
}

function clientIp(req: Request) {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

// Fails closed: if the limiter can't be reached, the AI call is refused.
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

// The signed-in user's id, or "" when there is no valid login. A token that is present but
// invalid is treated as anonymous (the anonymous tier is the stricter one).
async function signedInUser(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const m = /^Bearer\s+([A-Za-z0-9._-]{20,4096})$/.exec(auth.trim());
  if (!m) return "";
  // The public anon key is a JWT too; only a real user session has a `sub`.
  try {
    const payload = JSON.parse(atob(m[1].split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (!payload || payload.role !== "authenticated" || !payload.sub) return "";
  } catch {
    return "";
  }
  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${m[1]}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return "";
    const u = await r.json();
    return u?.id ? String(u.id) : "";
  } catch {
    return "";
  }
}

type Msg = { role: "user" | "assistant"; content: string };

// Only plain-text conversations are accepted; anything else (tools, images,
// documents, other parameters) is dropped or refused.
function validRequest(body: Record<string, unknown>, maxTotal: number, maxOut: number):
  { messages: Msg[]; system?: string; maxTokens: number; temperature?: number } | null {
  const raw = body.messages;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_MESSAGES) return null;
  const messages: Msg[] = [];
  let total = 0;
  for (const m of raw) {
    if (!m || typeof m !== "object") return null;
    const role = (m as Record<string, unknown>).role;
    const content = (m as Record<string, unknown>).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    if (!content.trim() || content.length > MAX_MESSAGE_CHARS) return null;
    total += content.length;
    messages.push({ role, content });
  }
  if (messages[0].role !== "user" || total > maxTotal) return null;

  let system: string | undefined;
  if (body.system !== undefined) {
    if (typeof body.system !== "string" || body.system.length > MAX_SYSTEM_CHARS) return null;
    system = body.system;
  }
  const askedTokens = Number(body.max_tokens);
  const maxTokens = Number.isFinite(askedTokens) && askedTokens > 0 ? Math.min(Math.floor(askedTokens), maxOut) : maxOut;
  let temperature: number | undefined;
  if (body.temperature !== undefined) {
    const t = Number(body.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 1) return null;
    temperature = t;
  }
  return { messages, system, maxTokens, temperature };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  const okOrigin = allowedOrigin(origin);

  if (req.method === "OPTIONS") {
    return okOrigin ? new Response("ok", { headers: corsFor(origin) }) : new Response("forbidden", { status: 403 });
  }
  if (!okOrigin) return json({ error: "Forbidden" }, 403, "");
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
  if (!ANTHROPIC_API_KEY || !serviceRoleKey) return json({ error: "AI is not configured" }, 500, origin);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400, origin);
  }

  const userId = await signedInUser(req);
  const ask = userId
    ? validRequest(body || {}, USER_MAX_TOTAL_CHARS, USER_MAX_OUTPUT_TOKENS)
    : validRequest(body || {}, ANON_MAX_TOTAL_CHARS, ANON_MAX_OUTPUT_TOKENS);
  if (!ask) return json({ error: "Invalid request" }, 400, origin);

  const allowed = userId
    ? (await underLimit(`ai:user:h:${userId}`, 3600, PER_USER_PER_HOUR)) &&
      (await underLimit(`ai:user:d:${userId}`, 86400, PER_USER_PER_DAY)) &&
      (await underLimit("ai:global:user:d", 86400, USER_GLOBAL_PER_DAY))
    : (await underLimit(`ai:ip:h:${clientIp(req)}`, 3600, PER_IP_PER_HOUR)) &&
      (await underLimit(`ai:ip:d:${clientIp(req)}`, 86400, PER_IP_PER_DAY)) &&
      (await underLimit("ai:global:anon:d", 86400, ANON_GLOBAL_PER_DAY));
  if (!allowed) {
    return json({ error: "The AI helper is busy right now. Please try again a little later." }, 429, origin);
  }

  try {
    const payload: Record<string, unknown> = { model: MODEL, max_tokens: ask.maxTokens, messages: ask.messages };
    // Anonymous callers can't steer the model with their own system prompt.
    const system = userId ? ask.system : ANON_SYSTEM;
    if (system) payload.system = system;
    if (ask.temperature !== undefined) payload.temperature = ask.temperature;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return json({ error: "The AI helper couldn't answer. Please try again." }, 502, origin);
    return json(data, 200, origin);
  } catch {
    return json({ error: "The AI helper couldn't answer. Please try again." }, 502, origin);
  }
});
