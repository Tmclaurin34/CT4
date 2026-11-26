const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type EmailBody = {
  to?: string;
  subject?: string;
  message?: string;
  html?: string;
  customer_name?: string;
  business_name?: string;
  customer_id?: string;
};

type CustomerRow = {
  id: string;
  user_id: string;
  email?: string | null;
  name?: string | null;
  email_unsubscribed_at?: string | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const EMAIL_FROM_DOMAIN = "support@goclicktide.com"; // verified Resend sender; display name is the business
const EMAIL_UNSUB_SECRET = Deno.env.get("EMAIL_UNSUB_SECRET") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const EMAIL_FOOTER_ADDR = "Glen Cove, NY 11542"; // interim — replace with the PO Box / business address (CAN-SPAM physical address)

// Customer-facing "From" shows the BUSINESS name, sent from the one verified domain.
function bizFrom(name: string): string {
  const clean = (name || "Clicktide").replace(/[<>"\r\n,;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Clicktide";
  return `${clean} <${EMAIL_FROM_DOMAIN}>`;
}
// Signed one-click unsubscribe link — same algorithm + secret as campaign-runner.
async function unsubUrlFor(email: string): Promise<string> {
  const addr = (email || "").trim().toLowerCase();
  if (!addr) return "";
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(EMAIL_UNSUB_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(addr));
    const tok = [...new Uint8Array(sig)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${Deno.env.get("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co"}/functions/v1/email-unsubscribe?e=${encodeURIComponent(addr)}&t=${tok}`;
  } catch {
    return "";
  }
}

function wrapMessage(body: EmailBody, unsubUrl = "") {
  const business = escapeHtml(body.business_name || "Clicktide");
  const unsub = unsubUrl ? `<a href="${escapeHtml(unsubUrl)}" style="color:#9CA3AF;text-decoration:underline">Unsubscribe</a> &middot; ` : "";
  const footerInner = `You're receiving this because you're a customer of ${business}.<br>${unsub}Sent via <a href="https://goclicktide.com" style="color:#9CA3AF;text-decoration:underline">Clicktide</a> &middot; ${business}, ${EMAIL_FOOTER_ADDR}`;
  if (body.html) {
    return body.html.includes("email-unsubscribe")
      ? body.html
      : body.html + `<div style="text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#9CA3AF;padding:14px 12px;line-height:1.7">${footerInner}</div>`;
  }
  const customer = escapeHtml(body.customer_name || "there");
  const message = escapeHtml(body.message || "Thanks for being a customer.").replaceAll("\n", "<br>");
  return `<div style="background:#F4F5F7;padding:26px 12px;font-family:Arial,Helvetica,sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border-radius:14px;border:1px solid #E9EBEF">
      <tr><td align="center" style="padding:26px 30px 18px;border-bottom:1px solid #F0F1F4"><div style="font-size:21px;font-weight:bold;color:#111827">${business}</div></td></tr>
      <tr><td style="padding:24px 30px;color:#1F2937;font-size:15px;line-height:1.7"><p style="margin:0 0 14px">Hi ${customer},</p><p style="margin:0">${message}</p></td></tr>
      <tr><td align="center" style="padding:16px 30px 22px;border-top:1px solid #F0F1F4;font-size:11px;color:#9CA3AF;line-height:1.7">${footerInner}</td></tr>
    </table></td></tr></table></div>`;
}

async function getUser(supabaseUrl: string, serviceRoleKey: string, authHeader: string) {
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: authHeader,
    },
  });
  if (!response.ok) return null;
  return await response.json();
}

async function supabaseRest(supabaseUrl: string, serviceRoleKey: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message || data?.error || "Supabase request failed");
  return data;
}

async function getCustomer(supabaseUrl: string, serviceRoleKey: string, id: string) {
  const rows = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/rest/v1/customers?id=eq.${encodeURIComponent(id)}&select=id,user_id,email,name,email_unsubscribed_at&limit=1`,
  ) as CustomerRow[];
  return Array.isArray(rows) ? rows[0] : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const resendApiKey = Deno.env.get("RESEND_API_KEY");

    if (!supabaseUrl || !serviceRoleKey) return json({ error: "Supabase is not configured" }, 500);
    if (!resendApiKey) return json({ error: "RESEND_API_KEY is not configured" }, 500);

    let body: EmailBody;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.subject) {
      return json({ error: "Email subject is required" }, 400);
    }
    if (!body.customer_id) {
      return json({ error: "customer_id is required so ownership can be verified" }, 400);
    }

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Login is required to send customer emails" }, 401);

    const user = await getUser(supabaseUrl, serviceRoleKey, authHeader);
    if (!user?.id) return json({ error: "Invalid authorization" }, 401);

    const customer = await getCustomer(supabaseUrl, serviceRoleKey, body.customer_id);
    if (!customer) return json({ error: "Customer not found" }, 404);
    if (customer.user_id !== user.id) return json({ error: "Customer does not belong to this account" }, 403);

    const toEmail = String(customer.email || "").trim();
    if (!toEmail) return json({ error: "Customer email is missing" }, 400);
    if (customer.email_unsubscribed_at) {
      return json({ error: "This customer has unsubscribed from emails and can't be emailed." }, 409);
    }
    body.customer_name = body.customer_name || customer.name || "";
    const unsubUrl = await unsubUrlFor(toEmail);

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: bizFrom(body.business_name || ""),
        to: [toEmail],
        subject: body.subject,
        html: wrapMessage(body, unsubUrl),
        ...(unsubUrl ? { headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}),
      }),
    });

    const data = await resendResponse.json().catch(() => ({}));
    if (!resendResponse.ok) {
      return json({ error: data?.message || "Resend email failed", details: data }, resendResponse.status);
    }

    return json({ ok: true, id: data.id });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Email send failed" }, 500);
  }
});
