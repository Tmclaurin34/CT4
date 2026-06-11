// Weekly drift report — every Monday each business gets an email showing which
// customers started drifting in the past week, before they're gone for good.
// Runs via pg_cron (cron key) Mondays, or on demand by a business (their JWT).

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL") || "Clicktide <support@goclicktide.com>";

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

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

type Biz = { user_id: string; business_name?: string; email?: string; business_email?: string; churn_days?: number; contact_name?: string };
type Cust = { name?: string; email?: string; total_spent?: number; visits?: number; last_visit_at?: string };

function reportHtml(biz: Biz, fresh: Cust[], atRisk: Cust[], hasPlaybook: boolean) {
  const first = (biz.contact_name || "there").trim().split(/\s+/)[0];
  const bn = biz.business_name || "your business";
  const row = (c: Cust) => {
    const d = daysSince(c.last_visit_at);
    return `<tr><td style="padding:9px 12px;border-bottom:1px solid #F3F4F6;font-size:14px;color:#111827">${escapeHtml(c.name || "A customer")}</td><td style="padding:9px 12px;border-bottom:1px solid #F3F4F6;font-size:13px;color:#6B7280">${d} days ago</td><td style="padding:9px 12px;border-bottom:1px solid #F3F4F6;font-size:13px;color:#6B7280;text-align:right">$${Math.round(Number(c.total_spent) || 0)} lifetime</td></tr>`;
  };
  const freshRows = fresh.slice(0, 8).map(row).join("");
  const riskLine = atRisk.length
    ? `<p style=\"margin:18px 0 0;font-size:13px;color:#6B7280\">Also on the radar: <strong>${atRisk.length}</strong> customer${atRisk.length === 1 ? "" : "s"} who drifted earlier and still haven&#039;t been back.</p>`
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey || !resendApiKey) return json({ error: "Server is not configured" }, 500);

  const cronKey = req.headers.get("x-clicktide-cron-key") || "";
  const isCron = cronKey && cronKey === await expectedCronKey();
  const userId = isCron ? "" : await authedUserId(req);
  if (!isCron && !userId) return json({ error: "Not authorized" }, 401);
  const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";

  let filter = "user_id=not.is.null";
  if (userId) filter += `&user_id=eq.${encodeURIComponent(userId)}`;
  const businesses = await rest(
    `/rest/v1/clicktide?${filter}&select=user_id,business_name,email,business_email,churn_days,contact_name&limit=500`,
  ) as Biz[];

  const results: Record<string, unknown>[] = [];
  for (const biz of businesses) {
    try {
      const to = String(biz.business_email || biz.email || "").trim();
      if (!to) { results.push({ business: biz.business_name, skipped: "no email" }); continue; }
      const customers = await rest(
        `/rest/v1/customers?user_id=eq.${encodeURIComponent(biz.user_id)}&select=name,email,total_spent,visits,last_visit_at&limit=2000`,
      ) as Cust[];
      if (!customers.length) { results.push({ business: biz.business_name, skipped: "no customers" }); continue; }

      // "Started drifting last week" = crossed the 14-day line within the past 7 days.
      const fresh = customers.filter((c) => { const d = daysSince(c.last_visit_at); return d !== null && d >= 14 && d < 21; })
        .sort((a, b) => (Number(b.total_spent) || 0) - (Number(a.total_spent) || 0));
      const churn = Number(biz.churn_days) || 60;
      const atRisk = customers.filter((c) => { const d = daysSince(c.last_visit_at); return d !== null && d >= 21 && d < churn + 30; });
      if (!fresh.length) { results.push({ business: biz.business_name, skipped: "all quiet", at_risk: atRisk.length }); continue; }

      let hasPlaybook = false;
      try {
        const pb = await rest(`/rest/v1/campaigns?user_id=eq.${encodeURIComponent(biz.user_id)}&status=eq.active&name=like.Playbook*&select=id&limit=1`);
        hasPlaybook = Array.isArray(pb) && pb.length > 0;
      } catch (_) { /* tip defaults to suggesting the playbook */ }

      if (dryRun) { results.push({ business: biz.business_name, would_email: to, fresh: fresh.length, at_risk: atRisk.length }); continue; }

      const subject = `${fresh.length} customer${fresh.length === 1 ? "" : "s"} started drifting at ${biz.business_name || "your business"} last week`;
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: resendFrom, to: [to], subject, html: reportHtml(biz, fresh, atRisk, hasPlaybook) }),
      });
      const data = await r.json().catch(() => ({}));
      results.push({ business: biz.business_name, emailed: r.ok ? to : false, fresh: fresh.length, at_risk: atRisk.length, detail: r.ok ? String(data.id || "") : String(data?.message || "Resend failed") });
    } catch (e) {
      results.push({ business: biz.business_name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return json({ ok: true, dry_run: dryRun, businesses: businesses.length, results });
});
