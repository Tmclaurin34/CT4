// Clicktide A2P / SMS registration intake. A business submits its texting details during
// onboarding; we store the request (in a2p_registrations, RLS-locked) and email the owner
// to complete the per-business carrier registration in Twilio. We deliberately DO NOT
// auto-fire paid/irreversible Twilio brand+campaign registrations from here, and we never
// put the EIN in the notification email (it stays in the locked table). verify_jwt = false.
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
const clip = (v: unknown, n = 200) => String(v ?? "").trim().slice(0, n);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }

  const business_name = clip(b.business_name, 160);
  if (!business_name) return json({ error: "Business legal name is required" }, 400);

  const reg_type = clip(b.reg_type, 10) === "byo" ? "byo" : "new";
  const row = {
    reg_type,
    business_email: clip(b.business_email, 200),
    business_name,
    ein: clip(b.ein, 40),
    is_sole_prop: !!b.is_sole_prop,
    address: clip(b.address, 200), city: clip(b.city, 80), state: clip(b.state, 40), zip: clip(b.zip, 20),
    business_type: clip(b.business_type, 80),
    industry: clip(b.industry, 80),
    website: clip(b.website, 200),
    current_provider: clip(b.current_provider, 80),
    current_number: clip(b.current_number, 40),
    already_registered: b.already_registered == null ? null : !!b.already_registered,
    contact_name: clip(b.contact_name, 120), contact_email: clip(b.contact_email, 200), contact_phone: clip(b.contact_phone, 40),
    status: "submitted",
  };

  let stored = false;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/a2p_registrations`, {
      method: "POST",
      headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(row),
    });
    stored = r.ok;
  } catch (_) { /* fall through */ }

  // notify the owner — WITHOUT the EIN (sensitive; it stays in the locked table)
  if (RESEND) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Clicktide <support@goclicktide.com>",
          to: [NOTIFY_TO],
          subject: `New texting request (${reg_type === "byo" ? "connect existing #" : "new registration"}): ${business_name}`,
          text: reg_type === "byo"
            ? `A business wants to send through their EXISTING texting number (BYO) — connect it.\n\n` +
              `Business: ${business_name}\nProvider: ${row.current_provider}\nNumber: ${row.current_number}\n` +
              `Already A2P-registered: ${row.already_registered ? "yes" : "no / unknown"}\n` +
              `Contact: ${row.contact_name} ${row.contact_email} ${row.contact_phone}\nAccount: ${row.business_email}`
            : `A business asked to turn on texting (new registration). Complete the Twilio per-business registration.\n\n` +
              `Business: ${business_name}\nType: ${row.business_type}${row.is_sole_prop ? " (Sole Proprietor)" : ""}\n` +
              `Contact: ${row.contact_name} ${row.contact_email} ${row.contact_phone}\n` +
              `Website: ${row.website}\nAccount: ${row.business_email}\n\n` +
              `EIN + full details are in the a2p_registrations table (kept out of this email on purpose).`,
        }),
      });
    } catch (_) { /* best-effort */ }
  }

  return json({ ok: true, stored, status: "submitted" });
});
