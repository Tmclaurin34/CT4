// Ops alerts for the Clicktide owner. Hourly via pg_cron (x-clicktide-cron-key).
// Emails ONE digest to support@goclicktide.com when anything happened since the
// last run: engine problems (a background job with no successful run in its expected
// interval, and failed / unfinished / over-time runs, all from engine_runs), POS
// connections that stopped syncing, new signups, billing status changes (trial
// started, active, past_due, unpaid, canceled), and failed sends (email / text /
// postcard / gift). Sends nothing when there is nothing to report. ?dry_run=1 returns
// the digest without emailing or advancing the cursor.
// The digest goes out through the same Resend account it would be reporting on, so a
// successful run also pings OPS_HEARTBEAT_URL (an outside dead-man's switch such as
// healthchecks.io) when that is set: if this job stops, the outside monitor notices.

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL") || "Clicktide <support@goclicktide.com>";
const ALERT_TO = Deno.env.get("OPS_ALERT_EMAIL") || "support@goclicktide.com";
const HEARTBEAT_URL = Deno.env.get("OPS_HEARTBEAT_URL") || "";
const BAD_STATUSES = ["past_due", "unpaid", "canceled", "incomplete_expired"];
const PAGE_SIZE = 1000; // PostgREST max-rows here: a bigger page silently comes back cut to this

// Jobs that log to engine_runs, and how old their last good run may get before the
// digest says so. platform-sync runs hourly once WP3's schedule is applied (then set
// OPS_PLATFORM_SYNC_MAX_AGE_HOURS=3); the default fits the old nightly schedule too.
const envHours = (k: string, d: number) => {
  const n = Number(Deno.env.get(k) || "");
  return Number.isFinite(n) && n > 0 ? n : d;
};
const ENGINE_JOBS = [
  { job: "campaign-runner", label: "Campaign engine (hourly)", maxAgeHours: 2.5 },
  { job: "platform-sync", label: "POS sync", maxAgeHours: envHours("OPS_PLATFORM_SYNC_MAX_AGE_HOURS", 27) },
  { job: "ai-suggest-campaigns", label: "AI campaign suggestions (weekly)", maxAgeHours: 7 * 24 + 6 },
];
const STUCK_RUN_MINUTES = 15; // a run with no finish this long after its start was killed or crashed
const POS_STALE_HOURS = 36; // campaign-runner pauses win-backs for a connection at 48h
const SYNCED_PLATFORMS = ["square", "shopify", "clover", "stripe"]; // what platform-sync imports from

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fetchT(url: string, init: RequestInit = {}, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetchT(`${supabaseUrl}${path}`, {
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

// Every row a read matches (a single response stops at 1,000 rows without saying so).
// `path` must carry an order= so the pages are stable.
async function restAll(path: string): Promise<Array<Record<string, any>>> {
  const all: Array<Record<string, any>> = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let offset = 0, pages = 0; pages < 200; pages++) {
    const r = await fetchT(`${supabaseUrl}${path}${sep}limit=${PAGE_SIZE}&offset=${offset}`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, Prefer: "count=exact" },
    });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) throw new Error(data?.message || data?.error || r.statusText);
    const rows = Array.isArray(data) ? data : [];
    const m = /\/(\d+)\s*$/.exec(r.headers.get("content-range") || "");
    all.push(...rows);
    offset += rows.length;
    if (!rows.length || (m ? offset >= Number(m[1]) : rows.length < PAGE_SIZE)) break;
  }
  return all;
}

function esc(v: unknown) {
  return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function et(t: number | string) {
  const d = new Date(typeof t === "number" ? t : Date.parse(t));
  return Number.isNaN(d.getTime()) ? String(t) : `${d.toLocaleString("en-US", { timeZone: "America/New_York" })} ET`;
}

// Dead-man's switch + run problems, from engine_runs (contract C5).
async function engineProblems(since: string) {
  const out: string[] = [];
  // OPS_ENGINE_WATCH_SINCE = when every job below is deployed (ISO date/time). From then on
  // a job with NO logged run at all is reported too, so a job whose run log never works
  // can't hide. Unset: such a job is not checked (it may simply not be deployed yet).
  const watchSince = Date.parse(Deno.env.get("OPS_ENGINE_WATCH_SINCE") || "");
  // A finished run that held more than this many emails for lack of a postal address is
  // reported (default 0 = any).
  const emailHoldThreshold = Math.max(0, Number(Deno.env.get("OPS_EMAIL_HOLD_THRESHOLD") || 0) || 0);
  for (const j of ENGINE_JOBS) {
    const every = j.maxAgeHours < 24 ? `${j.maxAgeHours}h` : j.maxAgeHours < 48 ? `${Math.round(j.maxAgeHours)}h` : `${Math.round(j.maxAgeHours / 24)} days`;
    const any = await rest(`/rest/v1/engine_runs?job=eq.${j.job}&order=started_at.desc&limit=1&select=id`);
    if (!Array.isArray(any) || !any.length) {
      if (!Number.isNaN(watchSince) && Date.now() - watchSince > j.maxAgeHours * 3600000) {
        out.push(`${j.label}: no run logged at all since ${et(watchSince)} (expected at least every ${every}) — not running, or its run log can't be written`);
      }
      continue;
    }
    const good = await rest(`/rest/v1/engine_runs?job=eq.${j.job}&ok=is.true&finished_at=not.is.null&order=finished_at.desc&limit=1&select=finished_at`);
    const at = Array.isArray(good) && good[0]?.finished_at ? Date.parse(good[0].finished_at) : 0;
    if (!at || Date.now() - at > j.maxAgeHours * 3600000) {
      out.push(`${j.label}: no successful run ${at ? `since ${et(at)}` : "on record"} (expected at least every ${every})`);
    }
  }
  // Each finished run is looked at once (by its finish time); a run that never finished,
  // once its STUCK_RUN_MINUTES mark falls inside this window.
  const sinceT = Date.parse(since);
  const finished = await restAll(
    `/rest/v1/engine_runs?finished_at=gt.${encodeURIComponent(since)}&select=id,job,started_at,finished_at,ok,summary&order=finished_at.asc`,
  );
  const stuck = await restAll(
    `/rest/v1/engine_runs?finished_at=is.null&started_at=gt.${encodeURIComponent(new Date(sinceT - STUCK_RUN_MINUTES * 60000).toISOString())}&started_at=lte.${encodeURIComponent(new Date(Date.now() - STUCK_RUN_MINUTES * 60000).toISOString())}&select=id,job,started_at&order=started_at.asc`,
  );
  for (const run of stuck) out.push(`${run.job} run #${run.id} (started ${et(run.started_at)}) never finished — killed or crashed`);
  for (const run of finished) {
    const s = run.summary && typeof run.summary === "object" ? run.summary : {};
    const label = `${run.job} run #${run.id} (${et(run.started_at)})`;
    if (run.ok === false) {
      const why = s.error ? String(s.error) : Number(s.attempted) > 0 ? `${Number(s.failed) || 0} of ${s.attempted} connection(s) failed` : "unknown error";
      out.push(`${label} failed: ${why.slice(0, 200)}`);
    }
    // Email held platform-wide shows up only as skip counters in an otherwise healthy run.
    const held = s.skipped && typeof s.skipped === "object" ? s.skipped : {};
    if (Number(held.email_suppression_unavailable) > 0) {
      out.push(`${label}: ${held.email_suppression_unavailable} email(s) held — the opt-out list (email_suppressions) could not be read`);
    }
    if (Number(held.email_no_postal_address) > emailHoldThreshold) {
      out.push(`${label}: ${held.email_no_postal_address} email(s) held — no postal address (set CLICKTIDE_POSTAL_ADDRESS, or the business's full address)`);
    }
    if (s.timed_out) out.push(`${label} ran out of time${s.resume_from ? `; the next run starts with ${s.resume_from}` : ""}`);
    if (Number(s.business_errors) > 0) out.push(`${label}: ${s.business_errors} business(es) skipped by errors — ${String(s.last_error || "").slice(0, 200)}`);
    if (s.sms_window?.self_check === "failed") out.push(`${label}: the SMS send-window self-check FAILED, so every text is being held`);
    if (s.sms_registry_error) out.push(`${label}: the A2P registrations could not be read`);
    if (Number(s.wallet_refund_failed) > 0) out.push(`${label}: ${s.wallet_refund_failed} wallet refund(s) failed — check the ledger`);
  }
  return out;
}

// Active connections to a platform platform-sync imports from that crossed
// POS_STALE_HOURS without a sync since the last digest (reported once, when they cross).
async function stalePosConnections(since: string, nameOf: Map<string, string>) {
  const conns = await restAll(
    `/rest/v1/platform_connections?is_active=eq.true&user_id=not.is.null&platform=in.(${SYNCED_PLATFORMS.join(",")})&select=id,user_id,platform,last_synced_at,connected_at&order=id.asc`,
  );
  const sinceT = Date.parse(since);
  const out: string[] = [];
  for (const c of conns) {
    const ref = Date.parse(String(c.last_synced_at || c.connected_at || ""));
    if (Number.isNaN(ref)) continue;
    const staleAt = ref + POS_STALE_HOURS * 3600000;
    if (staleAt <= Date.now() && staleAt > sinceT) {
      out.push(`${nameOf.get(String(c.user_id)) || c.user_id}: ${c.platform} ${c.last_synced_at
        ? `hasn't synced since ${et(ref)} (expired or revoked token?) — its win-backs pause at 48h`
        : "has never synced (incomplete connection or failing first import?) — no visits imported from it"}`);
    }
  }
  return out;
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
    const bizRows = await restAll("/rest/v1/clicktide?select=id,user_id,business_name,email,plan,stripe_subscription_status,created_at&order=id.asc") as Array<Record<string, string>>;
    const nameOf = new Map<string, string>();
    for (const b of bizRows) if (b.user_id && !nameOf.has(b.user_id)) nameOf.set(b.user_id, b.business_name || b.email || b.user_id);

    const signups = bizRows.filter((b) => b.created_at && b.created_at > since);

    const prevRows = await restAll("/rest/v1/ops_alert_status?select=user_id,last_status&order=user_id.asc") as Array<{ user_id: string; last_status: string | null }>;
    const prev = new Map(prevRows.map((r) => [r.user_id, r.last_status || ""]));
    const billing: Array<{ name: string; from: string; to: string; plan: string; bad: boolean }> = [];
    // One status per business: two rows for one user_id in a single upsert would make
    // Postgres reject the whole statement, and the cursor would never move on.
    const upserts = new Map<string, { user_id: string; last_status: string }>();
    for (const b of bizRows) {
      if (!b.user_id || upserts.has(b.user_id)) continue;
      const cur = String(b.stripe_subscription_status || "");
      const old = prev.has(b.user_id) ? prev.get(b.user_id) ?? "" : null;
      if (old === null || old !== cur) upserts.set(b.user_id, { user_id: b.user_id, last_status: cur });
      if (old !== null && old !== cur && cur) {
        billing.push({ name: nameOf.get(b.user_id) || "", from: old || "none", to: cur, plan: b.plan || "", bad: BAD_STATUSES.includes(cur) });
      }
    }

    const failedSends = await rest(
      `/rest/v1/campaign_sends?status=in.(failed,deferred,unconfirmed)&sent_at=gt.${sinceQ}&select=user_id,channel,status,detail,sent_at&order=sent_at.desc&limit=200`,
    ) as Array<Record<string, string>>;
    const failedSms = await rest(
      `/rest/v1/sms_messages?status=eq.failed&created_at=gt.${sinceQ}&campaign_id=is.null&select=user_id,error,created_at&order=created_at.desc&limit=100`,
    ) as Array<Record<string, string>>;

    const failures = [
      ...failedSends.map((f) => ({ name: nameOf.get(f.user_id) || "", channel: f.status && f.status !== "failed" ? `${f.channel} (${f.status})` : f.channel, why: f.detail })),
      ...failedSms.map((f) => ({ name: nameOf.get(f.user_id) || "", channel: "sms (manual)", why: f.error })),
    ];

    let engine: string[];
    try {
      engine = await engineProblems(since);
    } catch (e) {
      engine = [`The engine run log (engine_runs) could not be read: ${e instanceof Error ? e.message : String(e)}`];
    }
    let stalePos: string[];
    try {
      stalePos = await stalePosConnections(since, nameOf);
    } catch (e) {
      stalePos = [`POS connections could not be read: ${e instanceof Error ? e.message : String(e)}`];
    }

    const badBilling = billing.filter((b) => b.bad);
    const total = engine.length + stalePos.length + signups.length + billing.length + failures.length;
    const summary = {
      since, engine_problems: engine.length, stale_pos_connections: stalePos.length, signups: signups.length,
      billing_changes: billing.length, billing_problems: badBilling.length, failed_sends: failures.length,
    };

    if (total > 0 && !dryRun) {
      const section = (title: string, rows: string[]) =>
        rows.length ? `<h3 style="font-size:15px;margin:22px 0 8px">${title}</h3><ul style="padding-left:18px;margin:0">${rows.join("")}</ul>` : "";
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;max-width:600px">
        <p style="margin:0 0 6px"><b>Clicktide activity</b> since ${esc(new Date(since).toLocaleString("en-US", { timeZone: "America/New_York" }))} ET</p>
        ${section(`Engine problems (${engine.length})`, engine.map((m) => `<li style="color:#991B1B">${esc(m)}</li>`))}
        ${section(`Billing problems (${badBilling.length})`, badBilling.map((b) => `<li style="color:#991B1B">${esc(b.name)}: ${esc(b.from)} &rarr; <b>${esc(b.to)}</b> (${esc(b.plan)})</li>`))}
        ${section(`POS connections not syncing (${stalePos.length})`, stalePos.map((m) => `<li style="color:#991B1B">${esc(m)}</li>`))}
        ${section(`Failed sends (${failures.length})`, failures.slice(0, 40).map((f) => `<li>${esc(f.name)} &middot; ${esc(f.channel)} &middot; ${esc(String(f.why || "").slice(0, 140))}</li>`))}
        ${section(`New signups (${signups.length})`, signups.map((s) => `<li>${esc(s.business_name || "(no name yet)")} &middot; ${esc(s.email)}</li>`))}
        ${section(`Billing changes (${billing.length - badBilling.length})`, billing.filter((b) => !b.bad).map((b) => `<li>${esc(b.name)}: ${esc(b.from)} &rarr; ${esc(b.to)} (${esc(b.plan)})</li>`))}
        <p style="font-size:12px;color:#6B7280;margin-top:24px">Sent hourly only when something happened. Details: goclicktide.com/backoffice</p></div>`;
      const subjectBits = [
        engine.length ? `${engine.length} engine problem${engine.length > 1 ? "s" : ""}` : "",
        badBilling.length ? `${badBilling.length} billing problem${badBilling.length > 1 ? "s" : ""}` : "",
        stalePos.length ? `${stalePos.length} POS sync problem${stalePos.length > 1 ? "s" : ""}` : "",
        failures.length ? `${failures.length} failed send${failures.length > 1 ? "s" : ""}` : "",
        signups.length ? `${signups.length} new signup${signups.length > 1 ? "s" : ""}` : "",
        (billing.length - badBilling.length) ? `${billing.length - badBilling.length} billing change${billing.length - badBilling.length > 1 ? "s" : ""}` : "",
      ].filter(Boolean);
      const r = await fetchT("https://api.resend.com/emails", {
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
      if (upserts.size) {
        await rest("/rest/v1/ops_alert_status?on_conflict=user_id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify([...upserts.values()].map((u) => ({ ...u, updated_at: now }))),
        });
      }
      await rest("/rest/v1/ops_alert_runs?on_conflict=id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ id: 1, last_run_at: now }),
      });
      if (HEARTBEAT_URL) await fetchT(HEARTBEAT_URL, { method: "GET" }, 5000).catch(() => {});
    }

    return json({ ok: true, dry_run: dryRun, emailed: total > 0 && !dryRun, ...summary });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "ops-alerts failed" }, 500);
  }
});
