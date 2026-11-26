// Clicktide email unsubscribe endpoint. Reached from a signed link (e=email, t=token)
// in every customer email footer. GET shows a confirmation page and opts the address
// out; POST is the RFC-8058 one-click handler (List-Unsubscribe-Post). Sets
// customers.email_unsubscribed_at for every customer row carrying that email. The
// signing secret is EMAIL_UNSUB_SECRET, falling back to the service-role key so it
// matches campaign-runner without any extra secret to manage. verify_jwt = false.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SECRET = Deno.env.get("EMAIL_UNSUB_SECRET") || SRK;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c] as string));
}

async function expected(email: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email));
  return [...new Uint8Array(sig)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function setUnsub(email: string, on: boolean): Promise<boolean> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/customers?email=ilike.${encodeURIComponent(email)}`, {
      method: "PATCH",
      headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ email_unsubscribed_at: on ? new Date().toISOString() : null }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function page(title: string, body: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#F4F5F7;color:#111827;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;max-width:440px;width:100%;border:1px solid #E9EBEF;border-radius:16px;padding:34px 30px;text-align:center}
h1{font-size:20px;margin:0 0 10px}p{font-size:14px;line-height:1.6;color:#374151;margin:0 0 8px}a{color:#0B62D6}
.mark{width:42px;height:42px;margin:0 auto 14px;display:block}</style></head>
<body><div class="card"><img class="mark" src="https://goclicktide.com/clicktide-logo-transparent.png" alt=""/>${body}
<p style="margin-top:18px;font-size:11px;color:#9CA3AF">Clicktide &middot; goclicktide.com</p></div></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const email = (url.searchParams.get("e") || "").trim().toLowerCase();
  const token = url.searchParams.get("t") || "";
  const action = url.searchParams.get("action") || "";
  const valid = !!email && !!token && token === (await expected(email));

  // One-click (RFC 8058): the mail client POSTs here. Unsubscribe, return 200, no page.
  if (req.method === "POST") {
    if (valid) { await setUnsub(email, true); return new Response("ok", { status: 200 }); }
    return new Response("invalid", { status: 400 });
  }
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });

  if (!valid) {
    return page("Unsubscribe", `<h1>Link not valid</h1><p>This unsubscribe link is missing or invalid. You can reply STOP to a text, or contact the business directly.</p>`);
  }

  if (action === "resubscribe") {
    const ok = await setUnsub(email, false);
    return page("Re-subscribed", ok
      ? `<h1>You're back in &#10003;</h1><p><b>${esc(email)}</b> will receive emails again. You can unsubscribe at any time.</p>`
      : `<h1>Something went wrong</h1><p>We couldn't update your preferences just now. Please try again shortly.</p>`);
  }

  const ok = await setUnsub(email, true);
  const resub = `${SUPABASE_URL}/functions/v1/email-unsubscribe?e=${encodeURIComponent(email)}&t=${token}&action=resubscribe`;
  return page("Unsubscribed", ok
    ? `<h1>You're unsubscribed</h1><p><b>${esc(email)}</b> won't receive any more marketing emails.</p><p style="margin-top:14px">Changed your mind? <a href="${esc(resub)}">Re-subscribe</a>.</p>`
    : `<h1>Something went wrong</h1><p>We couldn't update your preferences just now. Please try again, or contact the business directly.</p>`);
});
