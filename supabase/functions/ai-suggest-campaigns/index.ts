// AI campaign suggestions (Scale plan feature).
// Studies each Scale business's customer patterns and proposes up to 3
// campaigns the owner can approve with one click. Runs weekly via pg_cron
// (cron key) or on demand by the business itself (their JWT).
// The AI proposes; the owner approves — it never sends anything by itself.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-clicktide-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

async function expectedCronKey() {
  try {
    const data = await rest("/rest/v1/rpc/clicktide_internal_key", { method: "POST", body: "{}" });
    return String(data || "");
  } catch {
    return "";
  }
}

async function authedUserId(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return "";
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceRoleKey, Authorization: authorization },
  });
  if (!r.ok) return "";
  const user = await r.json();
  return String(user?.id || "");
}

function daysSince(value?: string | null) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
}

type Biz = { user_id: string; business_name?: string; business_type?: string; churn_days?: number; plan?: string };

async function statsFor(biz: Biz) {
  const churnDays = Number(biz.churn_days) || 60;
  const customers = await rest(
    `/rest/v1/customers?user_id=eq.${encodeURIComponent(biz.user_id)}&select=visits,total_spent,last_visit_at,satisfaction_score&limit=1000`,
  ) as Array<{ visits?: number; total_spent?: number; last_visit_at?: string; satisfaction_score?: number }>;
  if (!customers.length) return null;

  const n = customers.length;
  const spends = customers.map((c) => Number(c.total_spent) || 0);
  const avgSpend = Math.round(spends.reduce((a, b) => a + b, 0) / n);
  const slipping = customers.filter((c) => {
    const d = daysSince(c.last_visit_at);
    return d !== null && d >= churnDays;
  }).length;
  const active30 = customers.filter((c) => {
    const d = daysSince(c.last_visit_at);
    return d !== null && d <= 30;
  }).length;
  const highValue = customers.filter((c) => (Number(c.total_spent) || 0) >= avgSpend * 2).length;
  const unhappy = customers.filter((c) => (c.satisfaction_score || 0) > 0 && (c.satisfaction_score || 0) <= 2).length;
  const avgVisits = Math.round(customers.reduce((a, c) => a + (Number(c.visits) || 0), 0) / n * 10) / 10;

  const gifts = await rest("/rest/v1/gift_catalog?is_active=eq.true&select=name,estimated_cost&limit=10") as Array<{ name: string; estimated_cost: number }>;
  const campaigns = await rest(
    `/rest/v1/campaigns?user_id=eq.${encodeURIComponent(biz.user_id)}&status=eq.active&select=name,trigger&limit=20`,
  ) as Array<{ name: string; trigger: string }>;

  return { n, avgSpend, avgVisits, slipping, active30, highValue, unhappy, churnDays, gifts, campaigns };
}

async function suggestFor(biz: Biz): Promise<number> {
  const s = await statsFor(biz);
  if (!s) return 0;

  const prompt = `You are a customer-retention strategist for a local business. Analyze the data and propose up to 3 retention campaigns.

BUSINESS: ${biz.business_name || "a local business"} (type: ${biz.business_type || "other"})
CUSTOMER DATA: ${s.n} customers total; ${s.active30} visited in the last 30 days; ${s.slipping} have not visited in ${s.churnDays}+ days (slipping); ${s.highValue} are high-value (2x+ average spend); ${s.unhappy} recently rated 1-2 stars; average lifetime spend $${s.avgSpend}; average ${s.avgVisits} visits.
AVAILABLE GIFTS: ${s.gifts.map((g) => `${g.name} ($${g.estimated_cost})`).join(", ") || "none"}
ACTIVE CAMPAIGNS ALREADY RUNNING (do not duplicate): ${s.campaigns.map((c) => `${c.name} [${c.trigger}]`).join("; ") || "none"}

RULES:
- trigger_text MUST be exactly one of: "30-day inactive", "Win-back", "5th visit", "10th visit", "New customer", "VIP"
- campaign_type MUST be one of: "message_only", "digital_gift", "physical_gift"
- physical_gift campaigns must use a gift from AVAILABLE GIFTS with its cost; message_only uses gift_name "Message Only" and cost 0
- message: 2-3 warm sentences, may use {{first_name}} and {{business_name}} placeholders, no emojis
- rationale: 1-2 sentences citing the specific numbers above
- projected: one short line, e.g. "Break-even if 1 of 9 customers returns once"
- Only suggest campaigns the data supports. If a segment is empty, skip it.

Respond with ONLY a JSON array, no other text:
[{"title":"...","campaign_type":"...","trigger_text":"...","gift_name":"...","gift_cost":0,"message":"...","rationale":"...","projected":"..."}]`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || "AI request failed");

  const textOut = String(data?.content?.[0]?.text || "");
  const match = textOut.match(/\[[\s\S]*\]/);
  if (!match) return 0;
  let suggestions: Array<Record<string, unknown>>;
  try {
    suggestions = JSON.parse(match[0]);
  } catch {
    return 0;
  }
  if (!Array.isArray(suggestions) || !suggestions.length) return 0;

  // Replace prior unactioned suggestions with the fresh batch.
  await rest(`/rest/v1/ai_suggestions?user_id=eq.${encodeURIComponent(biz.user_id)}&status=eq.suggested`, {
    method: "DELETE",
  }).catch(() => {});

  const VALID_TRIGGERS = ["30-day inactive", "Win-back", "5th visit", "10th visit", "New customer", "VIP"];
  const rows = suggestions.slice(0, 3)
    .filter((x) => VALID_TRIGGERS.includes(String(x.trigger_text)))
    .map((x) => ({
      user_id: biz.user_id,
      title: String(x.title || "Suggested campaign").slice(0, 120),
      campaign_type: ["message_only", "digital_gift", "physical_gift"].includes(String(x.campaign_type)) ? String(x.campaign_type) : "message_only",
      trigger_text: String(x.trigger_text),
      gift_name: String(x.gift_name || "Message Only").slice(0, 120),
      gift_cost: Number(x.gift_cost) || 0,
      message: String(x.message || "").slice(0, 1000),
      rationale: String(x.rationale || "").slice(0, 500),
      projected: String(x.projected || "").slice(0, 200),
      status: "suggested",
    }));
  if (!rows.length) return 0;

  await rest("/rest/v1/ai_suggestions", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
  return rows.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey || !anthropicKey) return json({ error: "Server is not configured" }, 500);

  const cronKey = req.headers.get("x-clicktide-cron-key") || "";
  const isCron = cronKey && cronKey === await expectedCronKey();
  const userId = isCron ? "" : await authedUserId(req);
  if (!isCron && !userId) return json({ error: "Not authorized" }, 401);

  // Scale businesses only — this is the Scale plan's AI feature.
  let filter = "plan=ilike.scale&user_id=not.is.null";
  if (userId) filter += `&user_id=eq.${encodeURIComponent(userId)}`;
  const businesses = await rest(
    `/rest/v1/clicktide?${filter}&select=user_id,business_name,business_type,churn_days,plan&limit=200`,
  ) as Biz[];

  if (!businesses.length) {
    return json(userId ? { error: "AI campaign suggestions are a Scale plan feature." } : { ok: true, businesses: 0 }, userId ? 403 : 200);
  }

  const results: Record<string, unknown>[] = [];
  for (const biz of businesses) {
    try {
      const count = await suggestFor(biz);
      results.push({ business: biz.business_name, suggestions: count });
    } catch (e) {
      results.push({ business: biz.business_name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return json({ ok: true, businesses: businesses.length, results });
});
