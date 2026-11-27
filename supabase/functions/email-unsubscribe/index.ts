// Clicktide email unsubscribe endpoint (verify_jwt = false). Two signed link formats:
//   per business: ?b=<business user_id>&e=<email>&s=<hex HMAC-SHA256(secret, "<b>|<email>")>
//     Opts the address out of THAT business only; the page offers an undo for that
//     business only, as a POST button.
//   legacy (links already in inboxes): ?e=<email>&t=<first 12 bytes of HMAC(secret, email)>
//     The token never named a business, so it opts the address out of EVERY business
//     that has it and never offers re-subscribe.
// GET opts out straight away, so the link works even where the page can't render.
// A POST without the page's own form fields is the RFC 8058 one-click handler and can
// only ever opt out. Opt-outs go through service-role RPCs that record the address in
// email_suppressions and flag the matching customers by exact address (never LIKE).
// The signing secret is EMAIL_UNSUB_SECRET, falling back to the service-role key, the
// same as every sender.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SECRET = Deno.env.get("EMAIL_UNSUB_SECRET") || SRK;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Link =
  | { kind: "business"; biz: string; email: string; sig: string; signedEmail: string; signedBiz: string }
  | { kind: "legacy"; email: string };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c] as string));
}

async function hmacHex(message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameHex(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readLink(url: URL): Promise<Link | null> {
  const raw = (url.searchParams.get("e") || "").toLowerCase();
  const email = raw.trim();
  if (!email || email.length > 320 || !SECRET) return null;
  const rawBiz = (url.searchParams.get("b") || "").trim();
  const biz = rawBiz.toLowerCase();
  const sig = (url.searchParams.get("s") || "").trim().toLowerCase();
  try {
    if (biz || sig) {
      if (!UUID.test(biz) || !/^[0-9a-f]{64}$/.test(sig)) return null;
      // Signed over lower(email); a sender that didn't trim the stored address, or
      // didn't lower-case the business id, still verifies. The opt-out always uses the
      // lower-cased id and the trimmed address.
      for (const signedBiz of rawBiz === biz ? [biz] : [biz, rawBiz]) {
        if (sameHex(sig, await hmacHex(`${signedBiz}|${email}`))) return { kind: "business", biz, email, sig, signedEmail: email, signedBiz };
        if (raw !== email && sameHex(sig, await hmacHex(`${signedBiz}|${raw}`))) return { kind: "business", biz, email, sig, signedEmail: raw, signedBiz };
      }
      return null;
    }
    const token = (url.searchParams.get("t") || "").trim().toLowerCase();
    if (!/^[0-9a-f]{24}$/.test(token)) return null;
    return sameHex(token, (await hmacHex(email)).slice(0, 24)) ? { kind: "legacy", email } : null;
  } catch {
    return null;
  }
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${name} failed: ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function optOut(link: Link): Promise<boolean> {
  try {
    if (link.kind === "business") {
      await rpc("clicktide_email_optout", { p_user: link.biz, p_email: link.email, p_reason: "unsubscribe" });
    } else {
      await rpc("clicktide_email_optout_everywhere", { p_email: link.email, p_reason: "legacy_unsubscribe" });
    }
    return true;
  } catch (e) {
    console.error("email-unsubscribe opt-out failed:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

// true = re-subscribed, false = opted out some other way, null = error.
async function resubscribe(biz: string, email: string): Promise<boolean | null> {
  try {
    return (await rpc("clicktide_email_resubscribe", { p_user: biz, p_email: email })) === true;
  } catch (e) {
    console.error("email-unsubscribe re-subscribe failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function businessName(biz: string): Promise<string> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/clicktide?user_id=eq.${encodeURIComponent(biz)}&select=business_name&limit=1`, {
      headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
    });
    if (!r.ok) return "";
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? String(rows[0].business_name || "").replace(/\s+/g, " ").trim().slice(0, 80) : "";
  } catch {
    return "";
  }
}

function page(title: string, body: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#F4F5F7;color:#111827;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;max-width:440px;width:100%;border:1px solid #E9EBEF;border-radius:16px;padding:34px 30px;text-align:center}
h1{font-size:20px;margin:0 0 10px}p{font-size:14px;line-height:1.6;color:#374151;margin:0 0 8px}a{color:#0B62D6}
button{font:inherit;font-size:14px;background:#0B62D6;color:#fff;border:0;border-radius:10px;padding:11px 22px;cursor:pointer}
.mark{width:42px;height:42px;margin:0 auto 14px;display:block}</style></head>
<body><div class="card"><img class="mark" src="https://goclicktide.com/clicktide-logo-transparent.png" alt=""/>${body}
<p style="margin-top:18px;font-size:11px;color:#9CA3AF">Clicktide &middot; goclicktide.com</p></div></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; img-src https://goclicktide.com; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

// Posts back to this same URL; the hidden fields mark it as a click on this page.
function button(link: { sig: string; signedEmail: string; signedBiz: string }, action: string, label: string): string {
  const q = `?b=${encodeURIComponent(link.signedBiz)}&e=${encodeURIComponent(link.signedEmail)}&s=${link.sig}`;
  return `<form method="post" action="${esc(q)}" style="margin:14px 0 0"><input type="hidden" name="ui" value="1"/><input type="hidden" name="action" value="${esc(action)}"/><button type="submit">${esc(label)}</button></form>`;
}

const INVALID = `<h1>Link not valid</h1><p>This unsubscribe link is missing or invalid. You can reply STOP to a text, or contact the business directly.</p>`;
const FAILED = `<h1>Something went wrong</h1><p>We couldn't update your preferences just now. Please try again, or contact the business directly.</p>`;

async function unsubscribedPage(link: Link, ok: boolean): Promise<Response> {
  if (!ok) return page("Unsubscribe", FAILED);
  if (link.kind === "legacy") {
    return page("Unsubscribed", `<h1>You're unsubscribed</h1><p><b>${esc(link.email)}</b> won't receive any more marketing emails from the businesses that email you through Clicktide.</p><p style="margin-top:14px">To hear from a business again, contact it directly.</p>`);
  }
  const name = await businessName(link.biz);
  const from = name ? ` from <b>${esc(name)}</b>` : "";
  return page("Unsubscribed", `<h1>You're unsubscribed</h1><p><b>${esc(link.email)}</b> won't receive any more marketing emails${from}.</p><p style="margin-top:14px">Changed your mind?</p>${button(link, "resubscribe", "Re-subscribe")}`);
}

async function resubscribeConfirmPage(link: Link): Promise<Response> {
  if (link.kind === "legacy") {
    return page("Re-subscribe", `<h1>This link can't turn emails back on</h1><p>To hear from a business again, contact it directly.</p>`);
  }
  const name = await businessName(link.biz);
  return page("Re-subscribe", `<h1>Re-subscribe?</h1><p>Start getting emails${name ? ` from <b>${esc(name)}</b>` : ""} again at <b>${esc(link.email)}</b>?</p>${button(link, "resubscribe", "Yes, re-subscribe")}`);
}

async function resubscribedPage(link: Link): Promise<Response> {
  if (link.kind === "legacy") return resubscribeConfirmPage(link);
  const done = await resubscribe(link.biz, link.email);
  if (done === null) return page("Re-subscribe", FAILED);
  const name = await businessName(link.biz);
  const biz = name ? `<b>${esc(name)}</b>` : "this business";
  return page("Re-subscribe", done
    ? `<h1>You're back in &#10003;</h1><p><b>${esc(link.email)}</b> will receive emails from ${biz} again. You can unsubscribe at any time.</p>`
    : `<h1>We couldn't re-subscribe you here</h1><p>This address was opted out another way (for example a spam report, a bounce, or by the business itself). Contact ${biz} directly to start getting emails again.</p>`);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const link = await readLink(url);

  if (req.method === "POST") {
    const form = new URLSearchParams(await req.text().catch(() => ""));
    if (form.get("ui") !== "1") {
      // One-click (RFC 8058): the mail client POSTs here. Opt out, return 200, no page.
      if (!link) return new Response("invalid", { status: 400 });
      return (await optOut(link)) ? new Response("ok", { status: 200 }) : new Response("error", { status: 500 });
    }
    if (!link) return page("Unsubscribe", INVALID);
    if (form.get("action") === "resubscribe") return resubscribedPage(link);
    return unsubscribedPage(link, await optOut(link));
  }
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });

  if (!link) return page("Unsubscribe", INVALID);
  if (url.searchParams.get("action") === "resubscribe") return resubscribeConfirmPage(link);
  return unsubscribedPage(link, await optOut(link));
});
