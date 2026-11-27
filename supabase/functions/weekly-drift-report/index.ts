// Weekly drift report — every Monday each business gets an email showing which
// (v9: driven by the shared retention engine — "started drifting" = customers whose
// status moved from healthy/recovered to drifting/at_risk in the past 7 days and who
// haven't come back; each row shows their own usual gap. Old 14/21-day lines are only
// a fallback for a business the engine hasn't evaluated yet.)
// customers started drifting in the past week, before they're gone for good.
// Runs via pg_cron (cron key) Mondays, or on demand by a business (their JWT).
// The report lists customer names and spend, so it only ever goes to the owner's
// login email (clicktide.email, which the browser can't change), never to the
// editable business_email. On-demand runs need an active or trialing subscription
// and send at most once a day; the cron run sends each business at most one a day.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL") || "Clicktide <support@goclicktide.com>";

const PAGE = 500;
const CUSTOMER_PAGE = 1000;
const RUN_BUDGET_MS = 120000;

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

// Fails closed (a pass sends an email) unless failOpen is set for a no-send preview.
async function underLimit(bucket: string, windowSeconds: number, max: number, failOpen = false) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_rate_limit_hit`, {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
    });
    if (!r.ok) return failOpen;
    return (await r.json()) === true;
  } catch {
    return failOpen;
  }
}

function daysSince(value?: string | null) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

type Biz = { id: number; user_id: string; business_name?: string; email?: string; churn_days?: number; contact_name?: string };
type Cust = { id?: number; name?: string; total_spent?: number; last_visit_at?: string; usual?: number | null };
type Rhythm = { customer_id: number; status: string; expected_interval: number | null };

function reportHtml(biz: Biz, fresh: Cust[], atRisk: number, hasPlaybook: boolean) {
  const first = (biz.contact_name || "there").trim().split(/\s+/)[0];
  const bn = biz.business_name || "your business";
  const row = (c: Cust) => {
    const d = daysSince(c.last_visit_at);
    const usual = c.usual ? `<br><span style="font-size:12px;color:#9CA3AF">usually every ${Math.round(c.usual)} day${Math.round(c.usual) === 1 ? "" : "s"}</span>` : "";
    return `<tr><td style="padding:9px 12px;border-bottom:1px solid #F3F4F6;font-size:14px;color:#111827">${escapeHtml(c.name || "A customer")}</td><td style="padding:9px 12px;border-bottom:1px solid #F3F4F6;font-size:13px;color:#6B7280">${d} days ago${usual}</td><td style="padding:9px 12px;border-bottom:1px solid #F3F4F6;font-size:13px;color:#6B7280;text-align:right">$${Math.round(Number(c.total_spent) || 0)} lifetime</td></tr>`;
  };
  const freshRows = fresh.slice(0, 8).map(row).join("");
  const riskLine = atRisk
    ? `<p style=\"margin:18px 0 0;font-size:13px;color:#6B7280\">Also on the radar: <strong>${atRisk}</strong> customer${atRisk === 1 ? "" : "s"} who drifted earlier and still haven&#039;t been back.</p>`
    : "";
  const tip = hasPlaybook
    ? "Your Win-Back Playbook is active — these customers will get a friendly text automatically. Nothing to do."
    : "Tip: open Campaigns and install the Win-Back Playbook — one click sets up the day-14 text, day-30 postcard, and day-45 gift that bring these customers back automatically.";
  return `<div style="max-width:600px;margin:0 auto;background:#FFFFFF;padding:30px 28px;font-family:Arial,sans-serif">
    <table style="border-collapse:collapse;margin-bottom:10px"><tr><td style="vertical-align:middle;padding-right:10px"><img src="https://goclicktide.com/clicktide-logo-transparent.png" width="40" height="40" alt="Clicktide" style="display:block;border:0"/></td><td style="vertical-align:middle;font-size:13px;font-weight:bold;letter-spacing:2px;color:#0B62D6;text-transform:uppercase;font-family:Arial,sans-serif">Clicktide &middot; Monday Drift Report</td></tr></table>
    <h1 style="font-size:21px;color:#111827;margin:0 0 14px">${fresh.length} customer${fresh.length === 1 ? "" : "s"} started drifting at ${escapeHtml(bn)} last week</h1>
    <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 18px">Hi ${escapeHtml(first)} — these regulars quietly broke their visit rhythm in the past week. They&#039;re not gone; they&#039;re forgetting. This is the window to bring them back.</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #F3F4F6;border-radius:8px">${freshRows}</table>
    ${riskLine}
    <p style="font-size:13px;color:#374151;line-height:1.7;background:#F8FAFC;border:1px solid #E5E7EB;border-radius:8px;padding:12px 14px;margin:18px 0">${tip}</p>
    <div style="text-align:center;margin:22px 0 6px"><a href="https://goclicktide.com/clicktide" style="display:inline-block;background:#0B62D6;color:#FFFFFF;font-size:14px;font-weight:bold;text-decoration:none;padding:12px 28px;border-radius:8px">Open your dashboard</a></div>
    <p style="font-size:11px;color:#9CA3AF;text-align:center;margin:20px 0 0">Sent by Clicktide because it watches your customers&#039; rhythms, so you don&#039;t have to.</p>
  </div>`;
}

// Only customers whose last visit falls in the report window (14 days up to the
// at-risk horizon), paged past the API's 1,000-row cap.
async function windowCustomers(userId: string, horizonDays: number) {
  const now = Date.now();
  const newest = new Date(now - 14 * 86400000).toISOString();
  const oldest = new Date(now - horizonDays * 86400000).toISOString();
  const all: Cust[] = [];
  for (let offset = 0; offset < 50000; offset += CUSTOMER_PAGE) {
    const page = await rest(
      `/rest/v1/customers?user_id=eq.${encodeURIComponent(userId)}&last_visit_at=lte.${encodeURIComponent(newest)}&last_visit_at=gt.${encodeURIComponent(oldest)}&select=id,name,total_spent,last_visit_at&order=id.asc&limit=${CUSTOMER_PAGE}&offset=${offset}`,
    ) as Cust[];
    if (!Array.isArray(page)) break;
    all.push(...page);
    if (page.length < CUSTOMER_PAGE) break;
  }
  return all;
}

// Pages a PostgREST read past the API's 1,000-row cap. `path` must carry an order.
async function pageRows<T>(path: string, cap = 50000): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; offset < cap; offset += CUSTOMER_PAGE) {
    const page = await rest(`${path}&limit=${CUSTOMER_PAGE}&offset=${offset}`) as T[];
    if (!Array.isArray(page)) break;
    all.push(...page);
    if (page.length < CUSTOMER_PAGE) break;
  }
  return all;
}

// Shared retention engine (v9): refresh, then read statuses and last week's status
// changes. "Started drifting" = moved from healthy/recovered to drifting/at_risk in
// the past 7 days and still drifting/at_risk; "on the radar" = at_risk and not moved.
// Returns null when the engine is unavailable or hasn't evaluated this business yet,
// so the caller falls back to the old day lines. Only drifting/at_risk rows are read
// (paged), and customer details only for the "started drifting" ids.
async function engineReport(userId: string): Promise<{ fresh: Cust[]; atRisk: number } | null> {
  const u = encodeURIComponent(userId);
  let rhythm: Rhythm[] = [];
  let moved = new Set<number>();
  try {
    await rest("/rest/v1/rpc/clicktide_refresh_rhythm", { method: "POST", body: JSON.stringify({ p_user: userId }) });
    const evaluated = await rest(`/rest/v1/customer_rhythm?user_id=eq.${u}&select=customer_id&limit=1`);
    if (!Array.isArray(evaluated) || !evaluated.length) return null;
    rhythm = await pageRows<Rhythm>(
      `/rest/v1/customer_rhythm?user_id=eq.${u}&status=in.(drifting,at_risk)&select=customer_id,status,expected_interval&order=customer_id.asc`,
    );
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const ev = await pageRows<{ customer_id: number }>(
      `/rest/v1/customer_status_events?user_id=eq.${u}&occurred_at=gte.${encodeURIComponent(weekAgo)}&to_status=in.(drifting,at_risk)&from_status=in.(healthy,recovered)&select=customer_id&order=id.asc`,
    );
    moved = new Set(ev.map((e) => Number(e.customer_id)));
  } catch (e) {
    console.error("retention engine unavailable; using day lines", e);
    return null;
  }
  const byId = new Map(rhythm.map((r) => [Number(r.customer_id), r]));
  const freshIds = [...byId.keys()].filter((id) => moved.has(id));
  const atRisk = rhythm.filter((r) => !moved.has(Number(r.customer_id)) && r.status === "at_risk").length;
  const fresh: Cust[] = [];
  for (let i = 0; i < freshIds.length; i += 150) {
    const chunk = freshIds.slice(i, i + 150).filter((id) => Number.isSafeInteger(id));
    if (!chunk.length) continue;
    const rows = await rest(
      `/rest/v1/customers?user_id=eq.${u}&id=in.(${chunk.join(",")})&select=id,name,total_spent,last_visit_at`,
    ) as Cust[];
    for (const c of rows || []) fresh.push({ ...c, usual: byId.get(Number(c.id))?.expected_interval ?? null });
  }
  fresh.sort((a, b) => (Number(b.total_spent) || 0) - (Number(a.total_spent) || 0));
  return { fresh, atRisk };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey || !resendApiKey) return json({ error: "Server is not configured" }, 500);

  const cronKey = req.headers.get("x-clicktide-cron-key") || "";
  const isCron = cronKey && cronKey === await expectedCronKey();
  const userId = isCron ? "" : await authedUserId(req);
  if (!isCron && !userId) return json({ error: "Not authorized" }, 401);
  const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";

  if (!isCron) {
    const own = await rest(
      `/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}&stripe_subscription_status=in.(active,trialing)&select=id&limit=1`,
    ).catch(() => null);
    if (!Array.isArray(own) || !own.length) {
      return json({ error: "Your subscription isn't active, so on-demand drift reports are paused.", code: "billing_inactive" }, 403);
    }
    if (!(await underLimit(`drift:preview:${userId}`, 3600, 20, true))) {
      return json({ error: "Too many drift report requests — try again in a little while.", code: "rate_limited" }, 429);
    }
  }

  const deadline = Date.now() + RUN_BUDGET_MS;
  let filter = "user_id=not.is.null";
  if (userId) filter += `&user_id=eq.${encodeURIComponent(userId)}`;

  const results: Record<string, unknown>[] = [];
  let seen = 0;
  let timedOut = false;
  let afterId = 0;
  pages: for (;;) {
    const businesses = await rest(
      `/rest/v1/clicktide?${filter}&id=gt.${afterId}&order=id.asc&select=id,user_id,business_name,email,churn_days,contact_name&limit=${PAGE}`,
    ) as Biz[];
    if (!Array.isArray(businesses) || !businesses.length) break;
    for (const biz of businesses) {
      if (Date.now() > deadline) {
        timedOut = true;
        break pages;
      }
      afterId = Number(biz.id) || afterId;
      seen++;
      try {
        const to = String(biz.email || "").trim();
        if (!to) { results.push({ business: biz.business_name, skipped: "no email" }); continue; }

        let fresh: Cust[];
        let atRiskCount: number;
        const engine = await engineReport(biz.user_id);
        if (engine) {
          fresh = engine.fresh;
          atRiskCount = engine.atRisk;
        } else {
          // Fallback for a business the engine hasn't evaluated: previous fixed day lines.
          const churn = Number(biz.churn_days) || 60;
          const customers = await windowCustomers(biz.user_id, Math.max(21, churn + 30));
          fresh = customers.filter((c) => { const d = daysSince(c.last_visit_at); return d !== null && d >= 14 && d < 21; })
            .sort((a, b) => (Number(b.total_spent) || 0) - (Number(a.total_spent) || 0));
          atRiskCount = customers.filter((c) => { const d = daysSince(c.last_visit_at); return d !== null && d >= 21 && d < churn + 30; }).length;
        }
        if (!fresh.length) { results.push({ business: biz.business_name, skipped: "all quiet", at_risk: atRiskCount }); continue; }

        let hasPlaybook = false;
        try {
          const pb = await rest(`/rest/v1/campaigns?user_id=eq.${encodeURIComponent(biz.user_id)}&status=eq.active&name=like.Playbook*&select=id&limit=1`);
          hasPlaybook = Array.isArray(pb) && pb.length > 0;
        } catch (_) { /* tip defaults to suggesting the playbook */ }

        if (dryRun) { results.push({ business: biz.business_name, would_email: to, fresh: fresh.length, at_risk: atRiskCount }); continue; }

        // On demand: one real report a day. Cron: a re-run or overlapping run the same
        // day doesn't send a second one. (Daily windows: the limiter purges windows
        // that started more than 2 days ago.)
        if (!isCron && !(await underLimit(`drift:ondemand:${userId}`, 86400, 1))) {
          return json({ error: "You can request one drift report a day. Your next one arrives Monday.", code: "rate_limited" }, 429);
        }
        if (isCron && !(await underLimit(`drift:cron:${biz.user_id}`, 86400, 1))) {
          results.push({ business: biz.business_name, skipped: "already sent today" });
          continue;
        }

        const subject = `${fresh.length} customer${fresh.length === 1 ? "" : "s"} started drifting at ${String(biz.business_name || "your business").replace(/\s+/g, " ").trim()} last week`;
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: resendFrom, to: [to], subject, html: reportHtml(biz, fresh, atRiskCount, hasPlaybook) }),
        });
        const data = await r.json().catch(() => ({}));
        results.push({ business: biz.business_name, emailed: r.ok ? to : false, fresh: fresh.length, at_risk: atRiskCount, detail: r.ok ? String(data.id || "") : String(data?.message || "Resend failed") });
      } catch (e) {
        results.push({ business: biz.business_name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (businesses.length < PAGE) break;
  }
  if (timedOut) console.error(`weekly-drift-report: stopped at the ${RUN_BUDGET_MS / 1000}s budget after business id ${afterId}`);
  return json({ ok: true, dry_run: dryRun, businesses: seen, timed_out: timedOut, results });
});
