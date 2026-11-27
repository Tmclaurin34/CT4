// Owner text alerts: Clicktide texting its OWN users (business owners) who opted
// in under Settings > Owner text alerts. This is the ONLY traffic allowed on
// Clicktide's platform A2P campaign, which is registered as first-party. A
// business's customer texts never come through here (see campaign-runner).
//
// POST {action:"optin_confirm", user_id}  the registered opt-in confirmation; fired
//        by the clicktide_owner_sms_optin DB trigger when an owner saves consent
//        (sent immediately — the owner just pressed Save).
// POST {action:"tick"}                    every 10 minutes via pg_cron:
//        1. reconcile  - ask Twilio what really happened to recent texts
//        2. confirm    - (re)send any opt-in confirmation that has not gone through
//        3. results    - at most one "campaign results" text per owner per day
//        Tick sends only 9am-8pm owner-local time.
// ?dry_run=1 returns what would happen without texting or writing.
// Auth: x-clicktide-cron-key only (deployed with verify_jwt=false).
//
// Every send is CLAIMED first through the clicktide_owner_sms_claim RPC: it
// atomically reserves a row in owner_sms_log (unique per user+kind+key among
// live rows) and enforces the per-account, per-destination and platform-wide
// daily ceilings, so overlapping calls can never double-text or race the caps.
//
// Kill switch: sending requires an a2p_registrations row with reg_type='platform'
// and sms_status='active'. Set sms_status to anything else to stop all owner texts.

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const twilioToken = Deno.env.get("TWILIO_AUTH_TOKEN") || "";

// Wording registered with the carriers for this campaign. Do not reword without
// updating the campaign in Twilio.
const OPTIN_MESSAGE =
  "Clicktide: You're now receiving account and service alerts. Msg frequency varies, msg & data rates may apply. Reply HELP for help, STOP to opt out.";
const FOOTER = "See results: goclicktide.com. Reply STOP to opt out, HELP for help.";

const OPTIN_USER_PER_DAY = 5; // distinct consent events one account can confirm (room for a typo fix or re-opt-in)
const OPTIN_GLOBAL_PER_DAY = 100; // across all accounts (SMS-pumping guard)
const RESULTS_GLOBAL_PER_DAY = 500;
const DEST_PER_DAY = 4; // texts to one phone number per day, across ALL accounts
const SEND_HOUR_START = 9; // owner-local, inclusive
const SEND_HOUR_END = 20; // exclusive
const RETRY_GAP_MS = 55 * 60000; // wait this long after a failed attempt
const RETRY_WINDOW_MS = 7 * 86400000; // stop retrying a text after a week
const MAX_RECIPIENT_FAILURES = 3;
// Codes that are about the RECIPIENT (bad/unreachable number, opted out). Only
// these count toward giving up; anything else (21703/21704 sender not ready,
// 30034 number still registering, throttles, 5xx) is OUR side and keeps retrying
// inside the window — that is exactly the state right after go-live.
const RECIPIENT_CODES = new Set([21211, 21214, 21408, 21610, 21614, 30003, 30004, 30005, 30006]);
const TWILIO_OPTED_OUT = 21610;

type Owner = {
  user_id: string;
  business_name?: string | null;
  state?: string | null;
  owner_mobile?: string | null;
  owner_sms_consent?: boolean | null;
  owner_sms_consent_at?: string | null;
  stripe_subscription_status?: string | null;
};
type LogRow = { id: number; status: string; error_code?: number | null; created_at: string; provider_message_id?: string | null; user_id?: string };

// A tick must end well inside pg_cron's 60s call timeout. Owners not reached are picked
// up by later ticks: each tick starts at a different place in the list.
const TICK_BUDGET_MS = 45000;
const RECONCILE_BUDGET_MS = 15000;
const PAGE_SIZE = 1000; // PostgREST max-rows here: a bigger page silently comes back cut to this

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fetchT(url: string, init: RequestInit = {}, ms = 10000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// Writes that reserve or settle a text (the owner_sms_log claim and its outcome) get
// WRITE_MS: a claim that commits but answers late would otherwise be left in 'sending'
// and hold its dedupe slot until reconcile frees it.
const WRITE_MS = 25000;

async function rest(path: string, init: RequestInit = {}, ms = 10000) {
  const r = await fetchT(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  }, ms);
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.message || data?.error || r.statusText);
  return data;
}

// Every row a read matches (a single response stops at 1,000 rows without saying so).
// `path` must carry an order= so the pages are stable.
async function restAll(path: string): Promise<any[]> {
  const all: any[] = [];
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

const enc = encodeURIComponent;
const twilioAuth = () => `Basic ${btoa(`${twilioSid}:${twilioToken}`)}`;

// US mobile numbers only: keeps owner alerts domestic and closes international
// toll-fraud routes.
function usPhone(value?: string | null) {
  const digits = String(value || "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : "";
}

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Owner-local send window (9:00–19:59 every day) ──────────────────────────
// Same approach as campaign-runner's quiet hours: every zone a state touches
// must be inside the window, full names and stray punctuation accepted, and an
// unknown or blank state uses the window that is daytime in EVERY US zone.
const ZONE_GROUPS: Array<[string, string[]]> = [
  ["CT DE DC GA ME MD MA NH NJ NY NC OH PA RI SC VT VA WV", ["America/New_York"]],
  ["FL IN KY MI TN", ["America/New_York", "America/Chicago"]],
  ["AL AR IL IA LA MN MS MO OK WI", ["America/Chicago"]],
  ["KS NE ND SD TX", ["America/Chicago", "America/Denver"]],
  ["CO MT NM UT WY", ["America/Denver"]],
  ["ID NV OR", ["America/Denver", "America/Los_Angeles"]],
  ["CA WA", ["America/Los_Angeles"]],
  ["AZ", ["America/Phoenix", "America/Denver"]],
  ["AK", ["America/Anchorage", "America/Adak"]],
  ["HI", ["Pacific/Honolulu"]],
  ["PR VI", ["America/Puerto_Rico"]],
  ["GU MP", ["Pacific/Guam"]],
  ["AS", ["Pacific/Pago_Pago"]],
];
const STATE_ZONES: Record<string, string[]> = {};
for (const [codes, zones] of ZONE_GROUPS) for (const c of codes.split(" ")) STATE_ZONES[c] = zones;
const STATE_NAMES: Record<string, string> = {
  "ALABAMA": "AL", "ALASKA": "AK", "ARIZONA": "AZ", "ARKANSAS": "AR", "CALIFORNIA": "CA", "COLORADO": "CO",
  "CONNECTICUT": "CT", "DELAWARE": "DE", "DISTRICT OF COLUMBIA": "DC", "WASHINGTON DC": "DC", "FLORIDA": "FL",
  "GEORGIA": "GA", "HAWAII": "HI", "IDAHO": "ID", "ILLINOIS": "IL", "INDIANA": "IN", "IOWA": "IA", "KANSAS": "KS",
  "KENTUCKY": "KY", "LOUISIANA": "LA", "MAINE": "ME", "MARYLAND": "MD", "MASSACHUSETTS": "MA", "MICHIGAN": "MI",
  "MINNESOTA": "MN", "MISSISSIPPI": "MS", "MISSOURI": "MO", "MONTANA": "MT", "NEBRASKA": "NE", "NEVADA": "NV",
  "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC",
  "NORTH DAKOTA": "ND", "OHIO": "OH", "OKLAHOMA": "OK", "OREGON": "OR", "PENNSYLVANIA": "PA", "PUERTO RICO": "PR",
  "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", "TENNESSEE": "TN", "TEXAS": "TX", "UTAH": "UT",
  "VERMONT": "VT", "VIRGINIA": "VA", "WASHINGTON": "WA", "WEST VIRGINIA": "WV", "WISCONSIN": "WI", "WYOMING": "WY",
};
const ZONES_UNKNOWN = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];

function zonesForState(state?: string | null): string[] {
  const raw = String(state || "").toUpperCase().replace(/\./g, "").replace(/[^A-Z]+/g, " ").trim();
  const code = STATE_NAMES[raw] || raw.replace(/ /g, "");
  return STATE_ZONES[code] || ZONES_UNKNOWN;
}

const clockFmt = new Map<string, Intl.DateTimeFormat>();
function localClock(tz: string, at = new Date()) {
  let fmt = clockFmt.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    clockFmt.set(tz, fmt);
  }
  const parts = fmt.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

// Fails closed: if a local hour can't be worked out, the window counts as shut.
function sendWindowOpen(state?: string | null, at = new Date()): boolean {
  try {
    return zonesForState(state).every((tz) => {
      const h = localClock(tz, at).hour;
      return Number.isInteger(h) && h >= SEND_HOUR_START && h < SEND_HOUR_END;
    });
  } catch {
    return false;
  }
}

// The owner-local calendar date, for the one-results-text-per-day key (first
// zone of their state is fine for a date).
function localDate(state?: string | null) {
  try {
    return localClock(zonesForState(state)[0]).date;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// Plain GSM-7 text only, so an alert stays one 160-character segment.
function plain(value: string, max: number) {
  return String(value || "").replace(/[^\x20-\x7E]/g, "").replace(/["`\\]/g, "").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

async function platformMessagingService() {
  const rows = await rest(
    "/rest/v1/a2p_registrations?reg_type=eq.platform&sms_status=eq.active&messaging_service_sid=not.is.null&select=messaging_service_sid&limit=1",
  );
  return Array.isArray(rows) && rows[0]?.messaging_service_sid ? String(rows[0].messaging_service_sid) : "";
}

async function sendText(msid: string, to: string, body: string) {
  const form = new URLSearchParams({ To: to, MessagingServiceSid: msid, Body: body });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: twilioAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, sid: String(data?.sid || ""), code: Number(data?.code || 0), error: r.ok ? "" : String(data?.message || `Twilio ${r.status}`) };
}

// The recipient replied STOP, so Twilio will refuse every further send. Mirror
// that in Settings so the checkbox tells the truth and we stop attempting.
async function markOptedOut(userId: string) {
  await rest(`/rest/v1/clicktide?user_id=eq.${enc(userId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ owner_sms_consent: false }),
  }).catch(() => {});
}

async function patchLog(id: number, fields: Record<string, unknown>) {
  const doPatch = () => rest(`/rest/v1/owner_sms_log?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(fields),
  }, WRITE_MS);
  try {
    await doPatch();
    return true;
  } catch {
    try {
      await doPatch(); // one retry; reconcile cleans up stale rows beyond that
      return true;
    } catch (e) {
      globalThis.console?.error(`owner_sms_log ${id} outcome write failed: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }
}

// Twilio accepts a text before it knows whether it can be delivered. Ask what
// actually happened, and fail any claim that never got an outcome (a crash
// between claim and send) so it stops blocking the dedupe slot.
async function reconcile(dryRun: boolean) {
  const out = { checked: 0, delivered: 0, failed: 0, still_pending: 0, stale_claims: 0 };
  const since = new Date(Date.now() - 2 * 86400000).toISOString();
  const pending = await rest(
    `/rest/v1/owner_sms_log?status=eq.accepted&provider_message_id=not.is.null&created_at=gte.${enc(since)}&select=id,user_id,status,provider_message_id,created_at&order=created_at.asc&limit=200`,
  ) as LogRow[];
  const stopAt = Date.now() + RECONCILE_BUDGET_MS;
  for (const row of (Array.isArray(pending) ? pending : [])) {
    if (Date.now() > stopAt) break; // the rest are checked next tick
    out.checked++;
    let m = null;
    try {
      const r = await fetchT(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages/${row.provider_message_id}.json`, {
        headers: { Authorization: twilioAuth() },
      });
      m = await r.json().catch(() => null);
    } catch { /* still pending; asked again next tick */ }
    const status = String(m?.status || "");
    let next = "";
    if (status === "delivered" || status === "sent") next = "delivered";
    else if (status === "failed" || status === "undelivered" || status === "canceled") next = "failed";
    if (!next) { out.still_pending++; continue; }
    if (next === "delivered") out.delivered++; else out.failed++;
    if (dryRun) continue;
    const code = Number(m?.error_code || 0);
    await patchLog(row.id, {
      status: next,
      error_code: next === "failed" ? (code || null) : null,
      error: next === "failed" ? String(m?.error_message || `Twilio status ${status}`) : null,
    });
    if (next === "failed" && code === TWILIO_OPTED_OUT && row.user_id) await markOptedOut(row.user_id);
  }
  if (!dryRun) {
    // 'sending' rows older than 20 minutes never got an outcome: free the slot.
    const stale = new Date(Date.now() - 20 * 60000).toISOString();
    try {
      const rows = await rest(
        `/rest/v1/owner_sms_log?status=eq.sending&created_at=lt.${enc(stale)}&select=id&limit=100`,
      ) as Array<{ id: number }>;
      for (const row of (Array.isArray(rows) ? rows : [])) {
        out.stale_claims++;
        await patchLog(row.id, { status: "failed", error: "stale claim (no outcome recorded)" });
      }
    } catch { /* next tick */ }
  }
  return out;
}

// Where this text stands, from its failed attempts (live rows are handled by the
// claim's unique index): "" = try now, else the reason to wait or stop.
async function retryState(userId: string, kind: string, key: string) {
  const rows = await rest(
    `/rest/v1/owner_sms_log?user_id=eq.${enc(userId)}&kind=eq.${kind}&dedupe_key=eq.${enc(key)}&status=eq.failed&select=id,status,error_code,created_at&order=created_at.desc&limit=50`,
  ) as LogRow[];
  const failed = Array.isArray(rows) ? rows : [];
  if (!failed.length) return "";
  if (Date.now() - Date.parse(failed[0].created_at) < RETRY_GAP_MS) return "retry_later";
  if (failed.filter((r) => RECIPIENT_CODES.has(Number(r.error_code))).length >= MAX_RECIPIENT_FAILURES) return "gave_up";
  if (Date.now() - Date.parse(failed[failed.length - 1].created_at) > RETRY_WINDOW_MS) return "gave_up";
  return "";
}

async function deliver(
  msid: string, owner: Owner, kind: string, dedupeKey: string, to: string, body: string,
  dryRun: boolean, caps: { user: number; global: number },
) {
  if (dryRun) return { user_id: owner.user_id, kind, would_send: true, to_last4: to.slice(-4), body, length: body.length };

  // Reserve the send atomically; the RPC refuses duplicates and enforces caps.
  let claim: { claimed?: boolean; reason?: string; id?: number } | null = null;
  try {
    claim = await rest("/rest/v1/rpc/clicktide_owner_sms_claim", {
      method: "POST",
      body: JSON.stringify({
        p_user_id: owner.user_id, p_kind: kind, p_dedupe_key: dedupeKey,
        p_to_hash: await sha256Hex(to), p_to_last4: to.slice(-4), p_body: body,
        p_user_daily_cap: caps.user, p_dest_daily_cap: DEST_PER_DAY, p_kind_daily_cap: caps.global,
      }),
    }, WRITE_MS);
  } catch (e) {
    return { user_id: owner.user_id, kind, skipped: "claim_error", error: e instanceof Error ? e.message : "claim failed" };
  }
  if (!claim?.claimed || !claim.id) return { user_id: owner.user_id, kind, skipped: claim?.reason || "not_claimed" };

  let result;
  try {
    result = await sendText(msid, to, body);
  } catch (e) {
    await patchLog(claim.id, { status: "failed", error: `Twilio request failed: ${e instanceof Error ? e.message : "network error"}` });
    return { user_id: owner.user_id, kind, accepted: false, error: "twilio_unreachable" };
  }
  await patchLog(claim.id, {
    status: result.ok ? "accepted" : "failed",
    provider_message_id: result.sid || null,
    error_code: result.ok ? null : (result.code || null),
    error: result.error || null,
  });
  if (!result.ok && result.code === TWILIO_OPTED_OUT) await markOptedOut(owner.user_id);
  return { user_id: owner.user_id, kind, accepted: result.ok, to_last4: to.slice(-4), sid: result.sid || undefined, error: result.error || undefined };
}

// Returns confirmed:true once this consent event's confirmation has gone out.
async function optinConfirm(msid: string, owner: Owner | null, dryRun: boolean, fromTick = false): Promise<Record<string, unknown>> {
  if (!owner) return { skipped: "no_business" };
  const userId = owner.user_id;
  if (!owner.owner_sms_consent) return { user_id: userId, skipped: "no_consent" };
  const to = usPhone(owner.owner_mobile);
  if (!to) return { user_id: userId, skipped: "invalid_phone" };

  // One confirmation per consent event. The consent timestamp is server-owned
  // (DB trigger), so re-saving the same settings keeps the same key.
  const dedupeKey = `${to}|${owner.owner_sms_consent_at || ""}`;
  const confirmed = await rest(
    `/rest/v1/owner_sms_log?user_id=eq.${enc(userId)}&kind=eq.optin_confirm&dedupe_key=eq.${enc(dedupeKey)}&status=in.(sending,accepted,delivered)&select=id&limit=1`,
  );
  if (Array.isArray(confirmed) && confirmed.length) return { user_id: userId, skipped: "already_confirmed", confirmed: true };

  const retry = await retryState(userId, "optin_confirm", dedupeKey);
  if (retry) return { user_id: userId, skipped: retry };
  // The trigger-fired send goes out right away (the owner just pressed Save);
  // backfills and retries from the tick wait for daytime.
  if (fromTick && !sendWindowOpen(owner.state)) return { user_id: userId, skipped: "outside_hours" };
  return await deliver(msid, owner, "optin_confirm", dedupeKey, to, OPTIN_MESSAGE, dryRun, { user: OPTIN_USER_PER_DAY, global: OPTIN_GLOBAL_PER_DAY });
}

function resultsBody(sends: Array<{ channel: string; customer_id: number; campaign_id: number; sent_at: string }>, campaignName: string) {
  const customers = new Set(sends.map((s) => s.customer_id)).size;
  const people = `${customers} customer${customers === 1 ? "" : "s"}`;
  const fresh = sends.some((s) => Date.now() - Date.parse(s.sent_at) < 3 * 3600000);
  const verb = fresh ? "just reached" : "reached";
  if (campaignName) return `Clicktide: Your ${campaignName} campaign ${verb} ${people}. ${FOOTER}`;

  const count = (channel: string) => sends.filter((s) => s.channel === channel).length;
  const bits = [
    [count("email"), "email"], [count("sms"), "text"], [count("postcard"), "postcard"], [count("gift"), "gift"],
  ].filter(([n]) => (n as number) > 0).map(([n, label]) => `${n} ${label}${n === 1 ? "" : "s"}`);
  const detailed = `Clicktide: Your campaigns ${verb} ${people} (${bits.join(", ")}). ${FOOTER}`;
  return detailed.length <= 160 ? detailed : `Clicktide: Your campaigns ${verb} ${people}. ${FOOTER}`;
}

async function resultsDigest(msid: string, owner: Owner, dryRun: boolean) {
  const to = usPhone(owner.owner_mobile);
  if (!to) return { user_id: owner.user_id, skipped: "invalid_phone" };
  // Results go only to accounts in good standing (the campaigns they report on
  // only run for those anyway).
  if (!["active", "trialing"].includes(String(owner.stripe_subscription_status || "").toLowerCase())) {
    return { user_id: owner.user_id, skipped: "billing_inactive" };
  }
  if (!sendWindowOpen(owner.state)) return { user_id: owner.user_id, skipped: "outside_hours" };

  const dayKey = localDate(owner.state);
  const already = await rest(
    `/rest/v1/owner_sms_log?user_id=eq.${enc(owner.user_id)}&kind=eq.results&dedupe_key=eq.${enc(dayKey)}&status=in.(sending,accepted,delivered)&select=id&limit=1`,
  );
  if (Array.isArray(already) && already.length) return { user_id: owner.user_id, skipped: "already_sent_today" };
  const retry = await retryState(owner.user_id, "results", dayKey);
  if (retry) return { user_id: owner.user_id, skipped: retry };

  // Report everything since the last results text (or the past day the first time).
  const prev = await rest(
    `/rest/v1/owner_sms_log?user_id=eq.${enc(owner.user_id)}&kind=eq.results&status=in.(accepted,delivered)&select=created_at&order=created_at.desc&limit=1`,
  );
  const since = (Array.isArray(prev) && prev[0]?.created_at) || new Date(Date.now() - 86400000).toISOString();
  const sends = await rest(
    `/rest/v1/campaign_sends?user_id=eq.${enc(owner.user_id)}&status=eq.sent&channel=in.(email,sms,postcard,gift)&sent_at=gt.${enc(since)}&select=channel,customer_id,campaign_id,sent_at&limit=2000`,
  ) as Array<{ channel: string; customer_id: number; campaign_id: number; sent_at: string }>;
  if (!Array.isArray(sends) || !sends.length) return { user_id: owner.user_id, skipped: "nothing_to_report" };

  let campaignName = "";
  const campaignIds = [...new Set(sends.map((s) => s.campaign_id))];
  if (campaignIds.length === 1) {
    const c = await rest(`/rest/v1/campaigns?id=eq.${campaignIds[0]}&select=name&limit=1`).catch(() => null);
    campaignName = plain(Array.isArray(c) ? String(c[0]?.name || "") : "", 30);
  }
  return await deliver(msid, owner, "results", dayKey, to, resultsBody(sends, campaignName), dryRun, { user: 2, global: RESULTS_GLOBAL_PER_DAY });
}

const OWNER_COLS = "user_id,business_name,state,owner_mobile,owner_sms_consent,owner_sms_consent_at,stripe_subscription_status";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey || !twilioSid || !twilioToken) return json({ error: "Server secrets are not configured" }, 500);

  const provided = req.headers.get("x-clicktide-cron-key") || "";
  let expected = "";
  try { expected = String(await rest("/rest/v1/rpc/clicktide_internal_key", { method: "POST", body: "{}" }) || ""); } catch { /* treated as unauthorized */ }
  if (!expected || provided !== expected) return json({ error: "Unauthorized" }, 401);

  const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || "");

  try {
    const msid = await platformMessagingService();
    if (!msid) return json({ ok: false, reason: "platform_sms_inactive" });

    if (action === "optin_confirm") {
      const userId = String(body?.user_id || "");
      if (!/^[0-9a-f-]{36}$/i.test(userId)) return json({ error: "user_id is required" }, 400);
      const rows = await rest(`/rest/v1/clicktide?user_id=eq.${enc(userId)}&select=${OWNER_COLS}&limit=1`) as Owner[];
      return json({ ok: true, dry_run: dryRun, result: await optinConfirm(msid, Array.isArray(rows) ? rows[0] || null : null, dryRun) });
    }

    if (action === "tick") {
      const tickEnd = Date.now() + TICK_BUDGET_MS;
      const reconciled = await reconcile(dryRun).catch((e) => ({ error: e instanceof Error ? e.message : "reconcile failed" }));
      const owners = await restAll(
        `/rest/v1/clicktide?owner_sms_consent=is.true&owner_mobile=not.is.null&user_id=not.is.null&select=${OWNER_COLS}&order=user_id.asc`,
      ) as Owner[];
      // A different starting owner each tick, so a list too long for one tick is still
      // covered over a few ticks instead of the same tail always waiting.
      const start = owners.length ? Math.floor(Math.random() * owners.length) : 0;
      const rotated = [...owners.slice(start), ...owners.slice(0, start)];
      const results = [];
      let deferred = 0;
      for (const owner of rotated) {
        if (Date.now() > tickEnd) { deferred = rotated.length - results.length; break; }
        try {
          const confirm = await optinConfirm(msid, owner, dryRun, true);
          // The confirmation is always the first text an owner gets.
          if (confirm.confirmed) results.push(await resultsDigest(msid, owner, dryRun));
          else results.push(confirm);
        } catch (e) {
          results.push({ user_id: owner.user_id, error: e instanceof Error ? e.message : "failed" });
        }
      }
      return json({ ok: true, dry_run: dryRun, reconciled, owners: results.length, deferred_owners: deferred, results });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "owner-alerts failed" }, 500);
  }
});
