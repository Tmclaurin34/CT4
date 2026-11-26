// AI campaign suggestions (Scale plan feature).
// v11: learns from each campaign's real results (reached / returned after / $ back / cost),
// gift guard (gift <= half a high-value visit, enforced server-side), model -> claude-haiku-5-5.
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

type Cust = {
  id: number; visits?: number; order_count?: number; total_spent?: number;
  last_visit_at?: string; last_order_at?: string; last_order_amount?: number; satisfaction_score?: number;
};
const RESULT_WINDOW_DAYS = 30;   // a return within 30 days of the last touch counts (same rule as the Overview win-back card)
const LOOKBACK_DAYS = 180;

function visitValue(c: Cust) {
  const vis = Number(c.visits ?? c.order_count) || 0;
  const last = Number(c.last_order_amount) || 0;
  if (last > 0) return last;
  return vis > 0 ? (Number(c.total_spent) || 0) / vis : 0;
}

type CampResult = { name: string; trigger: string; type: string; status: string; reached: number; returned: number; rate: number; back: number; cost: number; young: boolean };

// v11: what each campaign actually did - reached, returned after, $ back, approx cost.
async function campaignResults(uid: string, customers: Cust[]): Promise<CampResult[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const camps = await rest(`/rest/v1/campaigns?user_id=eq.${encodeURIComponent(uid)}&select=id,name,trigger,campaign_type,gift_cost,status&limit=100`) as
    Array<{ id: number; name: string; trigger: string; campaign_type?: string; gift_cost?: number; status?: string }>;
  const sends = await rest(`/rest/v1/campaign_sends?user_id=eq.${encodeURIComponent(uid)}&status=eq.sent&customer_id=not.is.null&sent_at=gte.${encodeURIComponent(since)}&select=campaign_id,customer_id,channel,sent_at&order=sent_at.desc&limit=10000`) as
    Array<{ campaign_id: number; customer_id: number; channel?: string; sent_at: string }>;
  const byId = new Map(customers.map((c) => [c.id, c]));
  const out: CampResult[] = [];
  for (const camp of camps) {
    const mine = sends.filter((x) => x.campaign_id === camp.id);
    if (!mine.length) continue;
    const per = new Map<number, { first: number; last: number }>();
    let postcards = 0;
    for (const x of mine) {
      const t = Date.parse(x.sent_at);
      const cur = per.get(x.customer_id);
      if (!cur) per.set(x.customer_id, { first: t, last: t });
      else { cur.first = Math.min(cur.first, t); cur.last = Math.max(cur.last, t); }
      if (String(x.channel || "").toLowerCase().includes("postcard")) postcards++;
    }
    let returned = 0, back = 0, newest = 0;
    for (const [cid, w] of per) {
      newest = Math.max(newest, w.first);
      const c = byId.get(cid);
      const lv = Date.parse(String(c?.last_visit_at || c?.last_order_at || ""));
      if (c && !Number.isNaN(lv) && lv > w.first && lv <= w.last + RESULT_WINDOW_DAYS * 86400000) {
        returned++; back += visitValue(c);
      }
    }
    const reached = per.size;
    const giftCost = camp.campaign_type === "physical_gift" ? (Number(camp.gift_cost) || 0) * reached : 0;
    out.push({
      name: camp.name, trigger: camp.trigger, type: camp.campaign_type || "message_only", status: camp.status || "",
      reached, returned, rate: Math.round((100 * returned) / reached), back: Math.round(back),
      cost: Math.round(giftCost + postcards * 1.5),
      young: Date.now() - newest < RESULT_WINDOW_DAYS * 86400000 && returned === 0,
    });
  }
  return out.sort((x, y) => y.reached - x.reached).slice(0, 12);
}

async function statsFor(biz: Biz) {
  const churnDays = Number(biz.churn_days) || 60;
  const customers = await rest(
    `/rest/v1/customers?user_id=eq.${encodeURIComponent(biz.user_id)}&select=id,visits,order_count,total_spent,last_visit_at,last_order_at,last_order_amount,satisfaction_score&limit=5000`,
  ) as Cust[];
  if (!customers.length) return null;

  const n = customers.length;
  const spends = customers.map((c) => Number(c.total_spent) || 0);
  const avgSpend = Math.round(spends.reduce((a, b) => a + b, 0) / n);
  const lastSeen = (c: Cust) => daysSince(c.last_visit_at || c.last_order_at);
  const slipping = customers.filter((c) => {
    const d = lastSeen(c);
    return d !== null && d >= churnDays;
  }).length;
  const active30 = customers.filter((c) => {
    const d = lastSeen(c);
    return d !== null && d <= 30;
  }).length;
  const hv = customers.filter((c) => (Number(c.total_spent) || 0) >= avgSpend * 2);
  const highValue = hv.length;
  const unhappy = customers.filter((c) => (c.satisfaction_score || 0) > 0 && (c.satisfaction_score || 0) <= 2).length;
  const avgVisits = Math.round(customers.reduce((a, c) => a + (Number(c.visits ?? c.order_count) || 0), 0) / n * 10) / 10;

  const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const avgVisitValue = Math.round(avg(customers.map(visitValue).filter((v) => v > 0)));
  const hvVisitValue = Math.round(avg(hv.map(visitValue).filter((v) => v > 0))) || avgVisitValue;

  // v11 gift guard: a physical gift should cost no more than half of ONE return visit
  // from the best customers. A $15 mug for a $6-coffee regular never pays back.
  const giftCap = Math.max(3, Math.round(hvVisitValue * 0.5));
  const allGifts = await rest("/rest/v1/gift_catalog?is_active=eq.true&select=name,estimated_cost&order=estimated_cost.asc&limit=20") as Array<{ name: string; estimated_cost: number }>;
  const gifts = allGifts.filter((g) => (Number(g.estimated_cost) || 0) <= giftCap).slice(0, 10);

  const campaigns = await rest(
    `/rest/v1/campaigns?user_id=eq.${encodeURIComponent(biz.user_id)}&status=eq.active&select=name,trigger&limit=20`,
  ) as Array<{ name: string; trigger: string }>;
  const results = await campaignResults(biz.user_id, customers).catch(() => [] as CampResult[]);

  return { n, avgSpend, avgVisits, slipping, active30, highValue, unhappy, churnDays, gifts, giftCap, avgVisitValue, hvVisitValue, campaigns, results };
}

type Outcome = { suggestions: number; proposed?: number; note?: string };

async function suggestFor(biz: Biz): Promise<Outcome> {
  const s = await statsFor(biz);
  if (!s) return { suggestions: 0, note: "no customers yet" };

  const prompt = `You are a customer-retention strategist for a local business. Analyze the data and propose up to 3 retention campaigns.

BUSINESS: ${biz.business_name || "a local business"} (type: ${biz.business_type || "other"})
CUSTOMER DATA: ${s.n} customers total; ${s.active30} visited in the last 30 days; ${s.slipping} have not visited in ${s.churnDays}+ days (slipping); ${s.highValue} are high-value (2x+ average spend); ${s.unhappy} recently rated 1-2 stars; average lifetime spend $${s.avgSpend}; average ${s.avgVisits} visits.
VISIT VALUE: an average visit is worth about $${s.avgVisitValue}; a high-value customer's visit about $${s.hvVisitValue}.
AVAILABLE GIFTS (already limited to ones costing at most $${s.giftCap}, half of a high-value visit): ${s.gifts.map((g) => `${g.name} ($${g.estimated_cost})`).join(", ") || "none - do not suggest physical gifts"}
CAMPAIGN RESULTS, last ${LOOKBACK_DAYS} days (a "return" = the customer visited within ${RESULT_WINDOW_DAYS} days of their last touch; this shows who came back AFTER a touch, not proof the touch caused it):
${s.results.map((r) => `- ${r.name} [${r.trigger}, ${r.type}${r.status && r.status !== "active" ? ", " + r.status : ""}]: reached ${r.reached}, ${r.young ? "too new to judge" : `${r.returned} returned (${r.rate}%), about $${r.back} in return visits`}, about $${r.cost} spent on gifts/postcards`).join("\n") || "- no campaign has sent yet"}
ACTIVE CAMPAIGNS ALREADY RUNNING (do not duplicate): ${s.campaigns.map((c) => `${c.name} [${c.trigger}]`).join("; ") || "none"}

RULES:
- trigger_text MUST be exactly one of: "30-day inactive", "Win-back", "5th visit", "10th visit", "New customer", "VIP"
- campaign_type MUST be one of: "message_only", "digital_gift", "physical_gift"
- physical_gift campaigns must use a gift from AVAILABLE GIFTS with its cost; message_only uses gift_name "Message Only" and cost 0
- message: 2-3 warm sentences, may use {{first_name}} and {{business_name}} placeholders, no emojis
- rationale: 1-2 sentences citing the specific numbers above
- projected: one short line, e.g. "Break-even if 1 of 9 customers returns once"
- Only suggest campaigns the data supports. If a segment is empty, skip it.
- Learn from CAMPAIGN RESULTS: lean toward the campaign types and triggers with the best return rate and the most return-visit dollars per dollar spent. If a running campaign has reached 15+ customers and clearly trails the others, you may propose a better variant of it; name the campaign it would replace in the rationale.
- Ignore results marked "too new to judge" and anything that reached fewer than 10 customers. Never call those winners or losers.
- Never say a campaign "caused" or "generated" revenue. Say customers "came back after" it.
- Prefer message_only or digital_gift unless a physical gift is clearly worth it for that segment.

Respond with ONLY a JSON array, no other text:
[{"title":"...","campaign_type":"...","trigger_text":"...","gift_name":"...","gift_cost":0,"message":"...","rationale":"...","projected":"..."}]`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-5-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || "AI request failed");

  const blocks = Array.isArray(data?.content) ? data.content : [];
  const textOut = blocks.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => String(b.text || "")).join("\n");
  const match = textOut.match(/\[[\s\S]*\]/);
  if (!match) return { suggestions: 0, note: `AI reply had no JSON list (stop: ${data?.stop_reason}, blocks: ${blocks.map((b: { type?: string }) => b?.type).join(",")}) ${textOut.slice(0, 200)}` };
  let suggestions: Array<Record<string, unknown>>;
  try {
    suggestions = JSON.parse(match[0]);
  } catch {
    return { suggestions: 0, note: "AI reply was not valid JSON" };
  }
  if (!Array.isArray(suggestions)) return { suggestions: 0, note: "AI reply was not a list" };

  // Replace prior unactioned suggestions with the fresh batch (even an empty one:
  // a stale suggestion the data no longer supports should not linger).
  await rest(`/rest/v1/ai_suggestions?user_id=eq.${encodeURIComponent(biz.user_id)}&status=eq.suggested`, {
    method: "DELETE",
  }).catch(() => {});

  const VALID_TRIGGERS = ["30-day inactive", "Win-back", "5th visit", "10th visit", "New customer", "VIP"];
  const giftCostByName = new Map(s.gifts.map((g) => [g.name.toLowerCase(), Number(g.estimated_cost) || 0]));
  const rows = suggestions.slice(0, 3)
    .filter((x) => VALID_TRIGGERS.includes(String(x.trigger_text)))
    // gift guard, enforced: a physical gift must be an allowed (affordable) catalog item, priced from the catalog
    .filter((x) => String(x.campaign_type) !== "physical_gift" || giftCostByName.has(String(x.gift_name || "").toLowerCase()))
    .map((x) => String(x.campaign_type) === "physical_gift" ? { ...x, gift_cost: giftCostByName.get(String(x.gift_name).toLowerCase()) } : x)
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
  if (!rows.length) return { suggestions: 0, proposed: suggestions.length, note: suggestions.length ? "all proposals failed the trigger/gift-budget checks" : "AI found nothing the data supports" };

  await rest("/rest/v1/ai_suggestions", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
  return { suggestions: rows.length, proposed: suggestions.length };
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
      const outcome = await suggestFor(biz);
      results.push({ business: biz.business_name, ...outcome });
    } catch (e) {
      results.push({ business: biz.business_name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return json({ ok: true, businesses: businesses.length, results });
});
