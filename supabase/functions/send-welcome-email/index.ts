// Welcome + onboarding email for newly activated businesses (Square-style layout).
// Idempotent (clicktide.welcome_email_sent). Called by the app right after
// email confirmation; the cron key + user_id path exists for admin testing.

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL") ?? "Clicktide <support@goclicktide.com>";
const LOGO = "https://goclicktide.com/clicktide-logo-transparent.png";

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

function step(n: string, title: string, desc: string) {
  return `<tr><td style="padding:11px 0;vertical-align:top;width:42px"><div style="width:28px;height:28px;border-radius:50%;border:2px solid #0B0F19;color:#0B0F19;font-weight:bold;font-size:14px;text-align:center;line-height:28px">${n}</div></td>
      <td style="padding:11px 0 11px 12px"><div style="font-size:16px;font-weight:bold;color:#0B0F19">${title}</div><div style="font-size:14px;color:#6B7280;line-height:1.6;margin-top:3px">${desc}</div></td></tr>`;
}

function welcomeHtml(contactName: string, businessName: string) {
  const first = esc((contactName || "there").trim().split(/\s+/)[0]);
  const biz = esc(businessName || "Your business");
  return `<div style="background:#F6F7F9;padding:36px 14px;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#FFFFFF;border-radius:16px;overflow:hidden">
    <div style="padding:36px 40px 0">
      <table style="border-collapse:collapse"><tr>
        <td style="vertical-align:middle;padding-right:10px"><img src="${LOGO}" width="34" height="34" alt="" style="display:block;border:0"/></td>
        <td style="vertical-align:middle;font-size:17px;font-weight:bold;color:#080D18;letter-spacing:1px">CLICK<span style="color:#2D7FF9">TIDE</span></td>
      </tr></table>
      <div style="font-size:34px;line-height:1.2;font-weight:bold;color:#0B0F19;margin:34px 0 14px">Your customers are about to start coming back.</div>
      <p style="font-size:16px;color:#374151;line-height:1.65;margin:0 0 22px">Hi ${first} — ${biz} now has a retention engine. Clicktide watches your customers' rhythms and wins back the ones who quietly drift, automatically.</p>
      <img src="https://goclicktide.com/drift-reveal-preview.png" width="520" alt="The Drift Reveal — see how many customers have quietly drifted" style="width:100%;max-width:520px;border-radius:14px;display:block;margin:0 0 8px"/>
      <div style="font-size:12px;color:#9CA3AF;margin:0 0 24px">Your Drift Reveal — what you'll see the moment your customer data connects.</div>
      <table style="width:100%;border-collapse:collapse">
        ${step("1", "Connect your point of sale", "Square, Shopify, Clover, or Stripe — read-only and secure. Up to a year of customers and visits imports itself in about a minute.")}
        ${step("2", "Meet your Drift Reveal", "See exactly how many customers have quietly stopped coming back — and what they're worth. Most owners are surprised.")}
        ${step("3", "Install the Win-Back Playbook", "One click arms your full protection: a friendly text at day 14, a real postcard at day 30, a branded gift at day 45. It pauses the moment they return.")}
        ${step("4", "Make it yours", "Upload your logo in Brand Studio — every text, postcard, and gift ships in your brand, not ours.")}
      </table>
      <div style="margin:28px 0 6px"><a href="https://goclicktide.com" style="display:inline-block;background:#E9B949;color:#080D18;font-size:16px;font-weight:bold;text-decoration:none;padding:15px 38px;border-radius:100px">Open your dashboard</a></div>
      <div style="font-size:14px;color:#2D7FF9;font-weight:bold;margin:14px 0 30px"><a href="https://goclicktide.com/win-back-lost-customers" style="color:#2D7FF9;text-decoration:none">Read the win-back playbook guide →</a></div>
      <div style="background:#F6F7F9;border-radius:14px;padding:22px 24px;margin-bottom:34px">
        <div style="font-size:16px;font-weight:bold;color:#0B0F19;margin-bottom:6px">\u{1F4EC} Every Monday: your Drift Report.</div>
        <div style="font-size:14px;color:#4B5563;line-height:1.65">Once you're connected, Clicktide emails you each Monday with exactly which customers started drifting last week — names, days absent, and what they're worth — so nobody slips away unnoticed.</div>
      </div>
      <div style="font-size:15px;color:#374151;line-height:1.65;margin-bottom:34px"><strong>Have a question or need a hand?</strong><br/>Just reply to this email — it reaches a human — or use the chat bubble on the site. Free setup help is part of your trial.</div>
    </div>
    <div style="border-top:1px solid #EEF0F3;padding:26px 40px 30px">
      <table style="border-collapse:collapse"><tr>
        <td style="vertical-align:middle;padding-right:8px"><img src="${LOGO}" width="24" height="24" alt="" style="display:block;border:0"/></td>
        <td style="vertical-align:middle;font-size:13px;font-weight:bold;color:#0B0F19">Clicktide</td>
      </tr></table>
      <div style="font-size:12px;color:#9CA3AF;line-height:1.7;margin-top:10px">A service of Six Seasons Partners LLC<br/>goclicktide.com · support@goclicktide.com<br/>You're receiving this one-time email because you created a Clicktide account.</div>
    </div>
  </div>
</div>`;
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
        subject: `Welcome to Clicktide — ${String(biz.business_name || "your business")}'s customers are about to start coming back`,
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
