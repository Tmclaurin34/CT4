// Clicktide outreach engagement tracker. A postcard QR or a tracked email/DM link
// points here with ?b=<business-slug>&c=<channel>. We log the tap, then 302-redirect
// to goclicktide.com so the owner sees EXACTLY which businesses engaged, by channel.
//   tap:    GET /pc?b=<slug>&v=<vertical>&c=<qr|email|dm>  -> logs a row, redirects
//   report: GET /pc?report=1 with header x-clicktide-cron-key, or an admin/support
//           staff session (Authorization: Bearer <JWT>)   -> HTML table of engagement
// verify_jwt = false (public endpoint; taps are rate-limited per visitor and per slug).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const DEST = "https://goclicktide.com/";
const TAPS_PER_IP_PER_HOUR = 30;
const TAPS_PER_SLUG_PER_DAY = 300;

async function rest(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

function esc(s: string) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function clientIp(req: Request) {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

// Fails open: a tap must always redirect, and a lost log row is harmless.
async function underLimit(bucket: string, windowSeconds: number, max: number) {
  try {
    const r = await rest("/rest/v1/rpc/clicktide_rate_limit_hit", {
      method: "POST",
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
    });
    if (!r.ok) return true;
    return (await r.json()) === true;
  } catch {
    return true;
  }
}

async function expectedCronKey() {
  try {
    const r = await rest("/rest/v1/rpc/clicktide_internal_key", { method: "POST", body: "{}" });
    return r.ok ? String(await r.json()) : "";
  } catch {
    return "";
  }
}

// Staff check through clicktide_is_staff with the CALLER's own token, so the database's
// staff rules (including any MFA requirement) decide.
async function isStaff(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!/^bearer\s+\S+/i.test(authorization)) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/clicktide_is_staff`, {
      method: "POST",
      headers: { apikey: ANON || SRK, Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ required_roles: ["admin", "support"] }),
    });
    if (!r.ok) return false;
    return (await r.json()) === true;
  } catch {
    return false;
  }
}

async function canReadReport(req: Request) {
  const key = req.headers.get("x-clicktide-cron-key") || "";
  if (key && safeEqual(key, await expectedCronKey())) return true;
  return await isStaff(req);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // ---- report mode (gated) ----
  if (url.searchParams.has("report")) {
    if (!SRK || !(await canReadReport(req))) return new Response("Not found", { status: 404 });
    const rows = await rest(
      "/rest/v1/postcard_scans?select=slug,business_name,vertical,channel,scanned_at&order=scanned_at.desc&limit=5000",
    ).then((r) => r.json()).catch(() => []);
    const agg: Record<string, { name: string; vertical: string; count: number; last: string; channels: Set<string> }> = {};
    const chan: Record<string, number> = {};
    for (const x of (Array.isArray(rows) ? rows : []) as any[]) {
      const k = x.slug;
      if (!agg[k]) agg[k] = { name: x.business_name || k, vertical: x.vertical || "", count: 0, last: x.scanned_at, channels: new Set() };
      agg[k].count++;
      agg[k].channels.add(x.channel || "qr");
      chan[x.channel || "qr"] = (chan[x.channel || "qr"] || 0) + 1;
    }
    const list = Object.values(agg).sort((a, b) => b.count - a.count);
    const chanLine = Object.entries(chan).map(([c, n]) => `${n} ${esc(c)}`).join(" &middot; ");
    const total = Array.isArray(rows) ? rows.length : 0;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clicktide outreach engagement</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#0B1426}
h1{font-size:20px}.sub{color:#6B7280;font-size:14px;margin-bottom:18px}table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:9px 10px;border-bottom:1px solid #EEF1F5;text-align:left}th{color:#6B7280;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
td.n{text-align:right;font-weight:700}.empty{color:#6B7280;padding:24px 0}</style></head><body>
<h1>Who engaged with your outreach</h1><div class="sub">${total} total taps from ${list.length} businesses${chanLine ? ` &nbsp;(${chanLine})` : ""}</div>
${list.length ? `<table><tr><th>Business</th><th>Vertical</th><th>Via</th><th class="n">Taps</th><th>Last</th></tr>
${list.map((v) => `<tr><td>${esc(v.name)}</td><td>${esc(v.vertical)}</td><td>${esc([...v.channels].join(", "))}</td><td class="n">${v.count}</td><td>${esc(new Date(v.last).toLocaleString())}</td></tr>`).join("")}</table>`
        : `<div class="empty">No taps yet. A business shows up here the moment it scans a postcard QR or clicks a tracked email/DM link.</div>`}
</body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  // ---- tap mode ----
  const slug = (url.searchParams.get("b") || "").slice(0, 60);
  const channel = (url.searchParams.get("c") || "qr").slice(0, 16);
  if (slug && SRK) {
    try {
      const ip = clientIp(req);
      const logIt = (await underLimit(`pc:tap:ip:${ip}`, 3600, TAPS_PER_IP_PER_HOUR)) &&
        (await underLimit(`pc:tap:slug:${slug}`, 86400, TAPS_PER_SLUG_PER_DAY));
      if (logIt) {
        await rest("/rest/v1/postcard_scans", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            slug,
            business_name: (url.searchParams.get("n") || "").slice(0, 160),
            vertical: (url.searchParams.get("v") || "").slice(0, 60),
            channel,
            user_agent: (req.headers.get("user-agent") || "").slice(0, 300),
            referer: (req.headers.get("referer") || "").slice(0, 300),
          }),
        });
      }
    } catch (_) { /* never block the redirect on a logging error */ }
  }
  return Response.redirect(`${DEST}?utm_source=clicktide&utm_medium=${encodeURIComponent(channel)}&utm_content=${encodeURIComponent(slug)}`, 302);
});
