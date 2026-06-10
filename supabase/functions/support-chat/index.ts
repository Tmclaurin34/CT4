// Clicktide support chat. Recorded (support_chats table) so the team learns
// what businesses ask for — including services we don't offer yet.
// AI answers from a strict knowledge base; account-specific issues route to email.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM = `You are the friendly support assistant for Clicktide (goclicktide.com), a customer-retention platform for local businesses and freelancers.

WHAT CLICKTIDE DOES: automatically thanks and wins back customers with branded physical gifts, mailed postcards, emails, and texts, triggered by customer behavior (first visit, milestones, going quiet, birthdays).

PLANS (monthly): Local $29 — up to 200 customers, 200 texts/mo. Growth $99 — 1,000 customers, 1,000 texts/mo, all integrations, retention analytics. Scale $299 — unlimited customers, 5,000 texts/mo, AI campaign suggestions, white-label (no Clicktide branding on messages). Email sending is included on all plans. Extra texts cost 5 cents from the gift wallet. Mailed postcards are $1.50 each from the gift wallet.

GIFTS: branded with the business's own logo, printed and shipped on demand — stickers (~$1.58), mug, notebook, postcards pack, crew socks, scented candle, magnet, tote bag, water bottle, tumbler (~$24.50). Gift costs come from a prepaid gift wallet the business tops up.

HOW DATA GETS IN: connect Square, Shopify, Clover, or Stripe (Toast and Mindbody coming); OR no POS needed — businesses taking Zelle/Cash App/cash can log visits manually or give customers a QR check-in code.

OTHER FEATURES: Email Studio (design branded emails), Brand Studio (design gift artwork), open/click tracking on campaigns, satisfaction surveys by text (reply 1-5), AI-written campaign messages.

RULES: Be warm and concise — 2 to 4 sentences. Never invent features, prices, or promises not listed above. If asked about something Clicktide doesn't offer, say so honestly and add that you've noted their interest for the team. For account-specific or billing issues, direct them to support@goclicktide.com. Don't give legal, medical, or financial advice.`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
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

async function maybeUserId(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: serviceRoleKey, Authorization: auth } });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.id || null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey || !anthropicKey) return json({ error: "Server is not configured" }, 500);

  let body: { session_id?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  const sessionId = String(body.session_id || "").slice(0, 64);
  const message = String(body.message || "").trim().slice(0, 1000);
  if (!sessionId || !message) return json({ error: "session_id and message are required" }, 400);

  const userId = await maybeUserId(req);

  try {
    // conversation context: last 12 turns of this session
    const prior = await rest(
      `/rest/v1/support_chats?session_id=eq.${encodeURIComponent(sessionId)}&select=role,content&order=created_at.asc&limit=12`,
    ) as Array<{ role: string; content: string }>;

    await rest("/rest/v1/support_chats", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ session_id: sessionId, user_id: userId, role: "user", content: message }),
    });

    const messages = [...prior.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: message }];
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, system: SYSTEM, messages }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || "AI unavailable");
    const reply = String(data?.content?.[0]?.text || "I'm not sure — email support@goclicktide.com and a human will help!").trim();

    await rest("/rest/v1/support_chats", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ session_id: sessionId, user_id: userId, role: "assistant", content: reply }),
    });

    return json({ reply });
  } catch (e) {
    console.error("support-chat error:", e);
    return json({ reply: "I'm having trouble right now — email support@goclicktide.com and a human will get back to you." });
  }
});
