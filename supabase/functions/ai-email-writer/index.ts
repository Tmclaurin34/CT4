// ai-email-writer (2026-11-28): Email Studio's "Write with AI".
// The owner picks 1-25 of THEIR customers + a goal; Claude drafts one personal email per
// customer from that customer's real history (first name, visits, how long since the last
// visit vs. their usual rhythm). It only DRAFTS — nothing is sent here. The owner edits
// every draft in the studio and sends through send-customer-email (which re-checks
// ownership, plan, limits, unsubscribes and adds the legal footer).
//
// Guards: signed-in owner (two-step session if the owner uses two-step), active or trialing
// subscription, customers must belong to the caller, unsubscribed / no-email customers are
// skipped, 40 AI batches per business per day. The prompt forbids invented offers, review
// requests, and quoting exact spend.
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MAX_CUSTOMERS = 25;
const PER_DAY = 40;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

function fetchT(url: string, init: RequestInit = {}, ms = 20000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...init, signal: c.signal }).finally(() => clearTimeout(t));
}
async function rest(path: string, init: RequestInit = {}) {
  const r = await fetchT(`${supabaseUrl}${path}`, {
    ...init,
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const t = await r.text();
  const d = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(d?.message || d?.error || r.statusText);
  return d;
}
async function underLimit(bucket: string, win: number, max: number) {
  try { return (await rest("/rest/v1/rpc/clicktide_rate_limit_hit", { method: "POST", body: JSON.stringify({ p_bucket: bucket, p_window_seconds: win, p_max: max }) })) === true; }
  catch { return false; }
}
function claims(token: string): Record<string, unknown> {
  try { const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"); return JSON.parse(atob(p + "=".repeat((4 - p.length % 4) % 4))); } catch { return {}; }
}
const clip = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n);
const daysSince = (v?: string | null) => { if (!v) return null; const t = Date.parse(v); return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000); };
const firstName = (n?: string | null) => { const f = String(n || "").trim().split(/\s+/)[0] || ""; return /^[A-Za-z][A-Za-z'.-]{0,30}$/.test(f) ? f : ""; };

const GOALS: Record<string, string> = {
  winback: "Win back a customer who hasn't been in for longer than usual. Warm, no guilt, give one easy reason to come back.",
  checkin: "A friendly check-in. No selling; show you noticed and care.",
  thanks: "Say thank you for being a loyal customer. Make them feel valued and specific to their history.",
  welcome: "Welcome a newer customer and invite them back for a second/next visit.",
  offer: "Share the owner's offer (given below) in a personal way and invite them in to use it.",
  custom: "Follow the owner's own instructions (given below).",
};
const TONES: Record<string, string> = { warm: "warm and personal", upbeat: "upbeat and energetic", professional: "polished and professional", short: "very short and casual (under 60 words)" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey || !anthropicKey) return json({ error: "Server is not configured" }, 500);

  // 1. owner
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Please log in again." }, 401);
  const ur = await fetchT(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${token}` } });
  if (!ur.ok) return json({ error: "Please log in again." }, 401);
  const user = await ur.json();
  const uid = String(user?.id || "");
  const twoStep = (Array.isArray(user?.factors) ? user.factors : []).some((f: { status?: string }) => f?.status === "verified");
  if (twoStep && claims(token).aal !== "aal2") return json({ error: "Please finish two-step login first." }, 403);

  // 2. input
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* */ }
  const ids = (Array.isArray(body.customer_ids) ? body.customer_ids : []).map((x) => Number(x)).filter((x) => Number.isSafeInteger(x) && x > 0);
  const uniq = [...new Set(ids)].slice(0, MAX_CUSTOMERS);
  if (!uniq.length) return json({ error: "Pick at least one customer." }, 400);
  const goal = GOALS[String(body.goal)] ? String(body.goal) : "winback";
  const tone = TONES[String(body.tone)] ? String(body.tone) : "warm";
  const offer = clip(body.offer, 200);
  const notes = clip(body.notes, 600);
  if (goal === "offer" && !offer) return json({ error: "Type the offer you want to share." }, 400);
  if (goal === "custom" && !notes) return json({ error: "Tell the AI what the email should say." }, 400);

  // 3. business
  const bizRows = await rest(`/rest/v1/clicktide?user_id=eq.${uid}&select=business_name,business_type,city,stripe_subscription_status&order=id.asc&limit=1`);
  const biz = Array.isArray(bizRows) ? bizRows[0] : null;
  if (!biz) return json({ error: "Finish setting up your business first." }, 400);
  if (!["active", "trialing"].includes(String(biz.stripe_subscription_status || "").toLowerCase())) {
    return json({ error: "Writing emails needs an active plan or free trial." }, 402);
  }
  if (!(await underLimit(`ai-email:user:${uid}`, 86400, PER_DAY))) return json({ error: "You've used today's AI writing limit. Try again tomorrow." }, 429);

  // 4. customers (must be the caller's)
  const cs = await rest(`/rest/v1/customers?user_id=eq.${uid}&id=in.(${uniq.join(",")})&select=id,name,email,visits,order_count,last_visit_at,last_order_at,first_order_at,email_unsubscribed_at`) as Array<Record<string, any>>;
  const rh = await rest(`/rest/v1/customer_rhythm?user_id=eq.${uid}&customer_id=in.(${uniq.join(",")})&select=customer_id,expected_interval,days_since,status`).catch(() => []) as Array<Record<string, any>>;
  const rhythm = new Map(rh.map((r) => [Number(r.customer_id), r]));
  const skipped: Array<{ customer_id: number; reason: string }> = [];
  const usable = cs.filter((c) => {
    if (!c.email) { skipped.push({ customer_id: c.id, reason: "No email address on file" }); return false; }
    if (c.email_unsubscribed_at) { skipped.push({ customer_id: c.id, reason: "Unsubscribed from your emails" }); return false; }
    return true;
  });
  for (const id of uniq) if (!cs.some((c) => Number(c.id) === id)) skipped.push({ customer_id: id, reason: "Not found" });
  if (!usable.length) return json({ drafts: [], skipped });

  const lines = usable.map((c) => {
    const r = rhythm.get(Number(c.id));
    const last = daysSince(c.last_visit_at || c.last_order_at);
    const first = daysSince(c.first_order_at);
    const visits = Number(c.visits || c.order_count || 0);
    return `- id ${c.id}: first name "${firstName(c.name) || "(unknown — greet with 'Hi there')"}"; visits ${visits}; ` +
      `last visit ${last === null ? "unknown" : last + " days ago"}; ` +
      `${r?.expected_interval ? `usually visits every ${Math.round(Number(r.expected_interval))} days; rhythm status ${r.status}` : "no regular rhythm yet"}; ` +
      `customer for ${first === null ? "unknown time" : first + " days"}`;
  }).join("\n");

  const prompt = `You write short, personal emails from a small local business to one of its own customers.
BUSINESS: "${clip(biz.business_name, 80)}" (${clip(biz.business_type, 60) || "local business"}${biz.city ? ", " + clip(biz.city, 60) : ""}).
GOAL: ${GOALS[goal]}
TONE: ${TONES[tone]}.
${offer ? `OWNER'S OFFER (use exactly this, don't change or add to it): ${offer}` : "NO OFFER: do not mention any discount, deal, coupon, free item or promotion."}
${notes ? `OWNER'S NOTES (follow these): ${notes}` : ""}

CUSTOMERS (write ONE email for EACH):
${lines}

RULES:
- Write as the business ("we"), sign off with the business name. Greet with "Hi <first name>," (or "Hi there,").
- 50-110 words for the body. Plain text, short paragraphs separated by a blank line. No markdown, no emojis, no hashtags.
- Make each email feel personal using that customer's own pattern (e.g. a regular who hasn't been in for a while vs. a newer customer) — but never quote dollar amounts, exact visit counts or say you are "tracking" them. Nothing creepy.
- Never invent facts about the business (hours, products, staff, events, prices) and never promise anything not given above.
- Never ask for a review or rating.
- Subject: under 55 characters, natural, no ALL CAPS, no spammy words like FREE!!!.
- button_text: 2-4 words for a call-to-action button (e.g. "Book a visit", "Come see us"), or "" if none fits.

Reply with ONLY a JSON array, one object per customer, in the same order:
[{"customer_id":123,"subject":"...","body":"...","button_text":"..."}]`;

  let drafts: Array<Record<string, unknown>> = [];
  try {
    const r = await fetchT("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      // Haiku 5.5 thinks first and thinking counts toward max_tokens: leave room.
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 16000, messages: [{ role: "user", content: prompt }] }),
    }, 90000);
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || "AI request failed");
    const text = (Array.isArray(data?.content) ? data.content : []).filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => String(b.text || "")).join("\n");
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error("The AI reply was empty. Try again.");
    const parsed = JSON.parse(m[0]);
    if (!Array.isArray(parsed)) throw new Error("The AI reply was not a list. Try again.");
    const byId = new Map(usable.map((c) => [Number(c.id), c]));
    drafts = parsed.map((d: Record<string, unknown>) => {
      const c = byId.get(Number(d.customer_id));
      if (!c) return null;
      byId.delete(Number(d.customer_id));
      return {
        customer_id: c.id, name: c.name || "", email: c.email,
        subject: clip(d.subject, 120) || `A note from ${clip(biz.business_name, 60)}`,
        body: String(d.body ?? "").replace(/\r/g, "").trim().slice(0, 3000),
        button_text: clip(d.button_text, 40),
      };
    }).filter(Boolean) as Array<Record<string, unknown>>;
    for (const c of byId.values()) skipped.push({ customer_id: c.id, reason: "The AI skipped this one — try writing it again" });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "AI writing failed" }, 502);
  }
  return json({ drafts, skipped });
});
