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

function wrapMessage(body: EmailBody) {
  if (body.html) return body.html;

  const customer = escapeHtml(body.customer_name || "there");
  const business = escapeHtml(body.business_name || "Clicktide");
  const message = escapeHtml(body.message || "Thanks for being a customer.").replaceAll("\n", "<br>");

  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:28px;color:#111827;line-height:1.6">
      <h1 style="font-size:22px;margin:0 0 14px;color:#111827">${business}</h1>
      <p style="margin:0 0 18px">Hi ${customer},</p>
      <p style="margin:0 0 22px">${message}</p>
      <p style="font-size:12px;color:#6B7280;margin:28px 0 0">Sent by Clicktide on behalf of ${business}.</p>
    </div>
  `;
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
    `/rest/v1/customers?id=eq.${encodeURIComponent(id)}&select=id,user_id,email,name&limit=1`,
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
    const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "Clicktide <support@goclicktide.com>";

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
    body.customer_name = body.customer_name || customer.name || "";

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: body.subject,
        html: wrapMessage(body),
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
