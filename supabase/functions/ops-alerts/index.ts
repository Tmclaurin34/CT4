// Ops alerts for the Clicktide owner. Hourly via pg_cron (x-clicktide-cron-key).
// Emails ONE digest to support@goclicktide.com when anything happened since the
// last run: new signups, billing status changes (trial started, active, past_due,
// unpaid, canceled), and failed sends (email / text / postcard / gift).
// Sends nothing when there is nothing to report. ?dry_run=1 returns the digest
// without emailing or advancing the cursor.

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL") || "Clicktide <support@goclicktide.com>";
const ALERT_TO = Deno.env.get("OPS_ALERT_EMAIL") || "support@goclicktide.com";
const BAD_STATUSES = ["past_due", "unpaid", "canceled", "incomplete_expired"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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

function esc(v: unknown) {
  return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const provided = req.headers.get("x-clicktide-cron-key") || "";
  let expected = "";
  try { expected = String(await rest("/rest/v1/rpc/clicktide_internal_key", { method: "POST", body: "{}" }) || ""); } catch { /* */ }
  if (!expected || provided !== expected) return json({ error: "Unauthorized" }, 401);

  const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";
  const now = new Date().toISOString();

  try {
    const runRows = await rest("/rest/v1/ops_alert_runs?id=eq.1&select=last_run_at&limit=1");
    const since = (Array.isArray(runRows) && runRows[0]?.last_run_at) || new Date(Date.now() - 3600000).toISOString();
    const sinceQ = encodeURIComponent(since);

    // Businesses (one read serves signups, names and billing changes).
    const bizRows = await rest("/rest/v1/clicktide?select=user_id,business_name,email,plan,stripe_subscription_status,created_at") as Array<Record<string, string>>;
    const nameOf = new Map(bizRows.map((b) => [b.user_id, b.business_name || b.email || b.user_id]));

    const signups = bizRows.filter((b) => b.created_at && b.created_at > since);

    const prevRows = await rest("/rest/v1/ops_alert_status?select=user_id,last_status") as Array<{ user_id: string; last_status: string | null }>;
    const prev = new Map(prevRows.map((r) => [r.user_id, r.last_status || ""]));
    const billing: Array<{ name: string; from: string; to: string; plan: string; bad: boolean }> = [];
    const upserts: Array<{ user_id: string; last_status: string }> = [];
    for (const b of bizRows) {
      if (!b.user_id) continue;
      const cur = String(b.stripe_subscription_status || "");
      const old = prev.has(b.user_id) ? prev.get(b.user_id)! : null;
      if (old === null || old !== cur) upserts.push({ user_id: b.user_id, last_status: cur });
      if (old !== null && old !== cur && cur) {
        billing.push({ name: nameOf.get(b.user_id) || "", from: old || "none", to: cur, plan: b.plan || "", bad: BAD_STATUSES.includes(cur) });
      }
    }

    const failedSends = await rest(
      `/rest/v1/campaign_sends?status=eq.failed&sent_at=gt.${sinceQ}&select=user_id,channel,detail,sent_at&order=sent_at.desc&limit=200`,
    ) as Array<Record<string, string>>;
    const failedSms = await rest(
      `/rest/v1/sms_messages?status=eq.failed&created_at=gt.${sinceQ}&campaign_id=is.null&select=user_id,error,created_at&order=created_at.desc&limit=100`,
    ) as Array<Record<string, string>>;

    const failures = [
      ...failedSends.map((f) => ({ name: nameOf.get(f.user_id) || "", channel: f.channel, why: f.detail })),
      ...failedSms.map((f) => ({ name: nameOf.get(f.user_id) || "", channel: "sms (manual)", why: f.error })),
    ];

    const badBilling = billing.filter((b) => b.bad);
    const total = signups.length + billing.length + failures.length;
    const summary = { since, signups: signups.length, billing_changes: billing.length, billing_problems: badBilling.length, failed_sends: failures.length };

    if (total > 0 && !dryRun) {
      const section = (title: string, rows: string[]) =>
        rows.length ? `<h3 style="font-size:15px;margin:22px 0 8px">${title}</h3><ul style="padding-left:18px;margin:0">${rows.join("")}</ul>` : "";
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;max-width:600px">
        <p style="margin:0 0 6px"><b>Clicktide activity</b> since ${esc(new Date(since).toLocaleString("en-US", { timeZone: "America/New_York" }))} ET</p>
        ${section(`Billing problems (${badBilling.length})`, badBilling.map((b) => `<li style="color:#991B1B">${esc(b.name)}: ${esc(b.from)} &rarr; <b>${esc(b.to)}</b> (${esc(b.plan)})</li>`))}
        ${section(`Failed sends (${failures.length})`, failures.slice(0, 40).map((f) => `<li>${esc(f.name)} &middot; ${esc(f.channel)} &middot; ${esc(String(f.why || "").slice(0, 140))}</li>`))}
        ${section(`New signups (${signups.length})`, signups.map((s) => `<li>${esc(s.business_name || "(no name yet)")} &middot; ${esc(s.email)}</li>`))}
        ${section(`Billing changes (${billing.length - badBilling.length})`, billing.filter((b) => !b.bad).map((b) => `<li>${esc(b.name)}: ${esc(b.from)} &rarr; ${esc(b.to)} (${esc(b.plan)})</li>`))}
        <p style="font-size:12px;color:#6B7280;margin-top:24px">Sent hourly only when something happened. Details: goclicktide.com/backoffice</p></div>`;
      const subjectBits = [
        badBilling.length ? `${badBilling.length} billing problem${badBilling.length > 1 ? "s" : ""}` : "",
        failures.length ? `${failures.length} failed send${failures.length > 1 ? "s" : ""}` : "",
        signups.length ? `${signups.length} new signup${signups.length > 1 ? "s" : ""}` : "",
        (billing.length - badBilling.length) ? `${billing.length - badBilling.length} billing change${billing.length - badBilling.length > 1 ? "s" : ""}` : "",
      ].filter(Boolean);
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: resendFrom, to: [ALERT_TO], subject: `Clicktide: ${subjectBits.join(", ")}`, html }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(`Alert email failed: ${d?.message || r.status}`);
      }
    }

    if (!dryRun) {
      if (upserts.length) {
        await rest("/rest/v1/ops_alert_status?on_conflict=user_id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(upserts.map((u) => ({ ...u, updated_at: now }))),
        });
      }
      await rest("/rest/v1/ops_alert_runs?on_conflict=id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ id: 1, last_run_at: now }),
      });
    }

    return json({ ok: true, dry_run: dryRun, emailed: total > 0 && !dryRun, ...summary });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "ops-alerts failed" }, 500);
  }
});
