// support-notify (2026-11-28): emails the other side when a support message is written.
// Called only by the support_messages AFTER INSERT trigger (pg_net, x-clicktide-cron-key).
//   customer wrote -> email support@goclicktide.com (reply-to = the owner), "open the back office"
//   staff wrote    -> email the owner's login address with the reply, "answer in Dashboard -> Support"
// A burst of messages from the same side within 3 minutes sends one email, not one per message.
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL") || "Clicktide <support@goclicktide.com>";
const SUPPORT_TO = Deno.env.get("OPS_ALERT_EMAIL") || "support@goclicktide.com";
const SITE = "https://goclicktide.com";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const t = await r.text();
  const d = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(d?.message || d?.error || r.statusText);
  return d;
}
function esc(v: unknown) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c] as string));
}
const para = (t: string) => esc(t).replace(/\n/g, "<br>");

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let expected = "";
  try { expected = String(await rest("/rest/v1/rpc/clicktide_internal_key", { method: "POST", body: "{}" }) || ""); } catch { /* */ }
  if (!expected || (req.headers.get("x-clicktide-cron-key") || "") !== expected) return json({ error: "Unauthorized" }, 401);

  let id = 0;
  try { id = Number((await req.json())?.message_id) || 0; } catch { /* */ }
  if (!id) return json({ error: "message_id required" }, 400);

  try {
    const rows = await rest(`/rest/v1/support_messages?id=eq.${id}&select=id,user_id,author,body,created_at`);
    const m = Array.isArray(rows) ? rows[0] : null;
    if (!m) return json({ error: "not found" }, 404);

    // Debounce: an earlier message from the same side in the last 3 minutes already emailed.
    const since = new Date(Date.parse(m.created_at) - 3 * 60000).toISOString();
    const burst = await rest(
      `/rest/v1/support_messages?user_id=eq.${m.user_id}&author=eq.${m.author}&id=lt.${m.id}&created_at=gt.${encodeURIComponent(since)}&select=id&limit=1`,
    );
    if (Array.isArray(burst) && burst.length) return json({ ok: true, skipped: "burst" });

    const biz = await rest(`/rest/v1/clicktide?user_id=eq.${m.user_id}&select=business_name,email&order=id.asc&limit=1`);
    const b = Array.isArray(biz) ? biz[0] || {} : {};
    let loginEmail = "";
    try {
      const u = await fetch(`${supabaseUrl}/auth/v1/admin/users/${m.user_id}`, { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } });
      if (u.ok) loginEmail = String((await u.json())?.email || "");
    } catch { /* */ }
    const ownerEmail = loginEmail || String(b.email || "");
    const bizName = String(b.business_name || ownerEmail || "A Clicktide customer");
    if (!resendApiKey) return json({ ok: true, skipped: "no email key" });

    let payload: Record<string, unknown>;
    if (m.author === "customer") {
      payload = {
        from: resendFrom, to: [SUPPORT_TO], ...(ownerEmail ? { reply_to: ownerEmail } : {}),
        subject: `Support message from ${bizName}`,
        html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111827;max-width:600px;line-height:1.55">
          <p style="margin:0 0 4px"><b>${esc(bizName)}</b> ${ownerEmail ? `&middot; ${esc(ownerEmail)}` : ""}</p>
          <div style="margin:12px 0;padding:14px 16px;background:#F3F4F6;border-radius:10px">${para(m.body)}</div>
          <p>Answer in the back office &rarr; <b>Support inbox &rarr; Messages</b> so it shows up in their dashboard:<br>
          <a href="${SITE}/backoffice">${SITE}/backoffice</a></p></div>`,
      };
    } else {
      if (!ownerEmail) return json({ ok: true, skipped: "no owner email" });
      payload = {
        from: resendFrom, to: [ownerEmail], reply_to: SUPPORT_TO,
        subject: "New message from Clicktide Support",
        html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111827;max-width:560px;line-height:1.55">
          <p>Hi${b.business_name ? ` ${esc(b.business_name)}` : ""},</p>
          <p>Clicktide Support replied to your message:</p>
          <div style="margin:12px 0;padding:14px 16px;background:#F3F4F6;border-radius:10px">${para(m.body)}</div>
          <p><a href="${SITE}/?support=1" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:11px 18px;border-radius:999px;font-weight:bold">Open Support in your dashboard</a></p>
          <p style="color:#6B7280;font-size:13px">You can also just reply to this email.</p>
          <p style="color:#6B7280;font-size:12px;margin-top:22px">Clicktide &middot; P.O. Box 304, Glen Cove, NY 11542</p></div>`,
      };
    }
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      return json({ error: `email failed: ${d?.message || r.status}` }, 502);
    }
    return json({ ok: true, emailed: m.author === "customer" ? "support" : "owner" });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "support-notify failed" }, 500);
  }
});
