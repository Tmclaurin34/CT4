// Welcome + onboarding email for newly activated businesses.
// Idempotent (clicktide.welcome_email_sent). Called by the app right after
// email confirmation; the cron key + user_id path exists for admin testing.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL") ?? "Clicktide <support@goclicktide.com>";
const LOGO = `${supabaseUrl}/storage/v1/object/public/logos/clicktide-logo-v2.png`;

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
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.message || data?.error || r.statusText);
  return data;
}

async function expectedCronKey() {
  try {
    return String(await rest("/rest/v1/rpc/clicktide_internal_key", { method: "POST", body: "{}" }) || "");
  } catch {
    return "";
  }
}

function esc(v: string) {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function welcomeHtml(contactName: string, businessName: string) {
  const first = (contactName || "there").trim().split(/\s+/)[0];
  const steps = [
    ["1", "Connect your platform", "Square, Shopify, Clover, or Stripe. Once connected, your customers and their visits flow in automatically — nothing to type."],
    ["2", "Your customer list builds itself", "Synced from your platform, or grown by your QR check-in code as customers scan it. (Prefer hands-on? CSV import and manual add are always there.)"],
    ["3", "Make it yours", "Upload your logo in Brand Studio and design your email in Email Studio — gifts and messages ship in your brand, not ours."],
    ["4", "Top up your gift wallet", "Prepaid funds that cover gifts and postcards. Start small — a $1.50 postcard works wonders."],
    ["5", "Launch your first campaign", "Pick a trigger like \"30-day inactive,\" choose a gift or message, and let Clicktide watch for you."],
  ].map(([n, t, d]) =>
    `<tr><td style="padding:10px 0;vertical-align:top;width:34px"><div style="width:26px;height:26px;border-radius:50%;background:#FFD166;color:#080D18;font-weight:bold;font-size:13px;text-align:center;line-height:26px;font-family:Arial">${n}</div></td>
     <td style="padding:10px 0 10px 10px"><div style="font-family:Arial;font-size:14px;font-weight:bold;color:#111827">${t}</div><div style="font-family:Arial;font-size:12px;color:#6B7280;line-height:1.6;margin-top:2px">${d}</div></td></tr>`
  ).join("");

  return `<div style="background:#F3F4F6;padding:28px 12px">
  <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border-radius:14px;overflow:hidden">
    <div style="background:#080D18;padding:26px;text-align:center">
      <img src="${LOGO}" alt="Clicktide" width="64" height="64" style="display:block;margin:0 auto 10px"/>
      <div style="font-family:Arial;font-size:20px;font-weight:bold;color:#FFFFFF;letter-spacing:2px">CLICK<span style="color:#4DA6FF">TIDE</span></div>
    </div>
    <div style="padding:30px 28px">
      <div style="font-family:Arial;font-size:21px;font-weight:bold;color:#111827;margin-bottom:10px">Welcome aboard, ${esc(first)}! 🎉</div>
      <p style="font-family:Arial;font-size:14px;color:#374151;line-height:1.7;margin:0 0 18px">
        ${esc(businessName || "Your business")} just got a retention engine. From today, Clicktide watches your customer patterns and helps you thank the loyal ones and win back the quiet ones — with real gifts, mailed postcards, emails, and texts that carry <strong>your</strong> brand.
      </p>
      <div style="font-family:Arial;font-size:12px;font-weight:bold;color:#9CA3AF;letter-spacing:1px;margin-bottom:4px">GET SET UP IN 5 STEPS</div>
      <table style="width:100%;border-collapse:collapse">${steps}</table>
      <div style="text-align:center;margin:24px 0 8px">
        <a href="https://goclicktide.com" style="display:inline-block;background:#FFD166;color:#080D18;font-family:Arial;font-size:14px;font-weight:bold;text-decoration:none;padding:13px 32px;border-radius:100px">Open your dashboard →</a>
      </div>
      <p style="font-family:Arial;font-size:12px;color:#6B7280;line-height:1.7;margin:18px 0 0;text-align:center">
        Questions? Just reply to this email or use the chat bubble on the site — a real answer either way.
      </p>
    </div>
    <div style="border-top:1px solid #F3F4F6;padding:16px;text-align:center;font-family:Arial;font-size:11px;color:#9CA3AF">
      Clicktide · goclicktide.com · support@goclicktide.com
    </div>
  </div></div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceRoleKey || !resendApiKey) return json({ error: "Server is not configured" }, 500);

  // Auth: the user themself, or the internal key with an explicit user_id (testing).
  let userId = "";
  const cronKey = req.headers.get("x-clicktide-cron-key") || "";
  if (cronKey && cronKey === await expectedCronKey()) {
    const body = await req.json().catch(() => ({}));
    userId = String(body.user_id || "");
  } else {
    const auth = req.headers.get("authorization") || "";
    if (auth.toLowerCase().startsWith("bearer ")) {
      const r = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: serviceRoleKey, Authorization: auth } });
      if (r.ok) userId = String((await r.json())?.id || "");
    }
  }
  if (!userId) return json({ error: "Not authorized" }, 401);

  try {
    const rows = await rest(
      `/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}&select=email,business_name,contact_name,welcome_email_sent&limit=1`,
    );
    const biz = Array.isArray(rows) ? rows[0] : null;
    if (!biz) return json({ error: "Business profile not found" }, 404);
    if (biz.welcome_email_sent) return json({ ok: true, already: true });
    if (!biz.email) return json({ error: "No email on the profile" }, 400);

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: resendFrom,
        to: [biz.email],
        subject: `Welcome to Clicktide, ${String(biz.business_name || "friend")}! Here's your 5-step launch plan`,
        html: welcomeHtml(String(biz.contact_name || ""), String(biz.business_name || "")),
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.message || "Resend failed");

    await rest(`/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ welcome_email_sent: true }),
    });
    return json({ ok: true, email_id: data.id || null });
  } catch (e) {
    console.error("welcome email error:", e);
    return json({ error: e instanceof Error ? e.message : "Could not send welcome email" }, 500);
  }
});
