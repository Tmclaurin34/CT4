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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "Clicktide <support@goclicktide.com>";

  if (!resendApiKey) return json({ error: "RESEND_API_KEY is not configured" }, 500);

  let body: EmailBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.to || !body.subject) {
    return json({ error: "Email recipient and subject are required" }, 400);
  }

  const resendResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [body.to],
      subject: body.subject,
      html: wrapMessage(body),
    }),
  });

  const data = await resendResponse.json().catch(() => ({}));
  if (!resendResponse.ok) {
    return json({ error: data?.message || "Resend email failed", details: data }, resendResponse.status);
  }

  return json({ ok: true, id: data.id });
});
