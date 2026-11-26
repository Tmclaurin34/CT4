// Clicktide pre-launch inquiry capture. The site is gated to "email-only" until launch;
// the inquiry form POSTs here. We store the email in launch_inquiries and (best-effort)
// email the owner so inquiries arrive live. verify_jwt = false (public form endpoint).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND = Deno.env.get("RESEND_API_KEY") ?? "";
const NOTIFY_TO = "clicktidebusiness@gmail.com";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body: { email?: string; source?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const email = String(body.email || "").trim().slice(0, 200);
  const source = String(body.source || "").slice(0, 200);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "A valid email is required" }, 400);

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/launch_inquiries`, {
      method: "POST",
      headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ email, source, user_agent: (req.headers.get("user-agent") || "").slice(0, 300) }),
    });
  } catch (_) { /* don't fail the user on a storage hiccup */ }

  if (RESEND) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Clicktide <support@goclicktide.com>",
          to: [NOTIFY_TO],
          subject: `New launch inquiry: ${email}`,
          text: `New pre-launch inquiry\n\nEmail: ${email}\nFrom: ${source}\n`,
        }),
      });
    } catch (_) { /* best-effort */ }
  }
  return json({ ok: true });
});
