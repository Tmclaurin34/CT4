const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type SmsBody = {
  to?: string;
  message?: string;
  customer_id?: string;
  campaign_id?: string;
  user_id?: string;
};

type CustomerRow = {
  id: string;
  user_id: string;
  phone?: string | null;
  sms_consent?: boolean | null;
  sms_unsubscribed_at?: string | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function normalizePhone(value?: string | null) {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
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
    `/rest/v1/customers?id=eq.${encodeURIComponent(id)}&select=id,user_id,phone,sms_consent,sms_unsubscribed_at&limit=1`,
  ) as CustomerRow[];
  return Array.isArray(rows) ? rows[0] : null;
}

async function recordSms(
  supabaseUrl: string,
  serviceRoleKey: string,
  fields: Record<string, unknown>,
) {
  await supabaseRest(supabaseUrl, serviceRoleKey, "/rest/v1/sms_messages", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(fields),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: SmsBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.message || !body.message.trim()) {
    return json({ error: "SMS message is required" }, 400);
  }
  if (!body.customer_id) {
    return json({ error: "customer_id is required so SMS consent can be verified" }, 400);
  }

  try {
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const accountSid = requiredEnv("TWILIO_ACCOUNT_SID");
    const authToken = requiredEnv("TWILIO_AUTH_TOKEN");
    const fromNumber = requiredEnv("TWILIO_FROM_NUMBER");

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing authorization" }, 401);

    const user = await getUser(supabaseUrl, serviceRoleKey, authHeader);
    if (!user?.id) return json({ error: "Invalid authorization" }, 401);

    const customer = await getCustomer(supabaseUrl, serviceRoleKey, body.customer_id);
    if (!customer) return json({ error: "Customer not found" }, 404);
    if (customer.user_id !== user.id) return json({ error: "Customer does not belong to this account" }, 403);
    if (!customer.sms_consent || customer.sms_unsubscribed_at) {
      return json({ error: "Customer has not opted in to SMS" }, 403);
    }

    const toPhone = normalizePhone(body.to || customer.phone);
    if (!toPhone) return json({ error: "Customer phone number is missing or invalid" }, 400);

    const message = body.message.trim().slice(0, 1500);
    const form = new URLSearchParams({
      To: toPhone,
      From: fromNumber,
      Body: message,
    });

    const twilioResponse = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });

    const twilioData = await twilioResponse.json().catch(() => ({}));
    const logFields = {
      user_id: user.id,
      campaign_id: body.campaign_id || null,
      customer_id: customer.id,
      to_phone: toPhone,
      body: message,
      status: twilioResponse.ok ? "sent" : "failed",
      provider: "twilio",
      provider_message_id: twilioData.sid || null,
      error: twilioResponse.ok ? null : (twilioData.message || "Twilio SMS failed"),
      sent_at: twilioResponse.ok ? new Date().toISOString() : null,
    };
    await recordSms(supabaseUrl, serviceRoleKey, logFields);

    if (!twilioResponse.ok) {
      return json({ error: twilioData.message || "Twilio SMS failed", details: twilioData }, twilioResponse.status);
    }

    return json({ ok: true, id: twilioData.sid, status: twilioData.status || "sent" });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "SMS send failed" }, 500);
  }
});
