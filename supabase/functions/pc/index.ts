// Clicktide postcard scan tracker. Each prospecting postcard's QR points here with
// ?b=<business-slug>. We log the scan, then 302-redirect to goclicktide.com so the
// owner can see EXACTLY which businesses scanned their mailer.
//   scan:   GET /pc?b=<slug>&v=<vertical>   -> logs a row, redirects to the site
//   report: GET /pc?report=<POSTCARD_REPORT_KEY> -> a simple HTML table of scans
// verify_jwt = false (public QR endpoint; report is gated by a secret key).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const REPORT_KEY = Deno.env.get("POSTCARD_REPORT_KEY") ?? "";
const DEST = "https://goclicktide.com/";

async function rest(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

function esc(s: string) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // ---- report mode (gated) ----
  const rk = url.searchParams.get("report");
  if (rk !== null) {
    if (!REPORT_KEY || rk !== REPORT_KEY) return new Response("Not found", { status: 404 });
    const rows = await rest(
      "/rest/v1/postcard_scans?select=slug,business_name,vertical,channel,scanned_at&order=scanned_at.desc&limit=5000",
    ).then((r) => r.json()).catch(() => []);
    const agg: Record<string, { name: string; vertical: string; count: number; last: string; channels: Set<string> }> = {};
    const chan: Record<string, number> = {};
    for (const x of rows as any[]) {
      const k = x.slug;
      if (!agg[k]) agg[k] = { name: x.business_name || k, vertical: x.vertical || "", count: 0, last: x.scanned_at, channels: new Set() };
      agg[k].count++;
      agg[k].channels.add(x.channel || "qr");
      chan[x.channel || "qr"] = (chan[x.channel || "qr"] || 0) + 1;
    }
    const list = Object.values(agg).sort((a, b) => b.count - a.count);
    const chanLine = Object.entries(chan).map(([c, n]) => `${n} ${esc(c)}`).join(" &middot; ");
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clicktide outreach engagement</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#0B1426}
h1{font-size:20px}.sub{color:#6B7280;font-size:14px;margin-bottom:18px}table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:9px 10px;border-bottom:1px solid #EEF1F5;text-align:left}th{color:#6B7280;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
td.n{text-align:right;font-weight:700}.empty{color:#6B7280;padding:24px 0}</style></head><body>
<h1>Who engaged with your outreach</h1><div class="sub">${(rows as any[]).length} total taps from ${list.length} businesses${chanLine ? ` &nbsp;(${chanLine})` : ""}</div>
${list.length ? `<table><tr><th>Business</th><th>Vertical</th><th>Via</th><th class="n">Taps</th><th>Last</th></tr>
${list.map((v) => `<tr><td>${esc(v.name)}</td><td>${esc(v.vertical)}</td><td>${esc([...v.channels].join(", "))}</td><td class="n">${v.count}</td><td>${esc(new Date(v.last).toLocaleString())}</td></tr>`).join("")}</table>`
        : `<div class="empty">No taps yet. A business shows up here the moment it scans a postcard QR or clicks a tracked email/DM link.</div>`}
</body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  // ---- scan mode ----
  const slug = (url.searchParams.get("b") || "").slice(0, 60);
  const channel = (url.searchParams.get("c") || "qr").slice(0, 16);
  if (slug) {
    try {
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
    } catch (_) { /* never block the redirect on a logging error */ }
  }
  return Response.redirect(`${DEST}?utm_source=clicktide&utm_medium=${encodeURIComponent(channel)}&utm_content=${encodeURIComponent(slug)}`, 302);
});
