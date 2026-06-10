const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type MindbodyBody = {
  site_id?: string | number;
  siteId?: string | number;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function env(name: string) {
  return Deno.env.get(name) || "";
}

async function authedUser(req: Request) {
  const supabaseUrl = env("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = req.headers.get("authorization") || "";
  if (!serviceRoleKey || !authorization.toLowerCase().startsWith("bearer ")) return null;

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: authorization,
    },
  });
  if (!response.ok) return null;
  return await response.json();
}

function activationCodeFrom(data: Record<string, unknown>) {
  const candidates = [
    data.ActivationCode,
    data.activationCode,
    data.activation_code,
    data.Code,
    data.code,
    (data.Site as Record<string, unknown> | undefined)?.ActivationCode,
    (data.site as Record<string, unknown> | undefined)?.activationCode,
  ];
  return String(candidates.find((value) => value != null && String(value).trim()) || "").trim();
}

async function requestActivationCode(siteId: string) {
  const apiKey = env("MINDBODY_API_KEY");
  const sourceName = env("MINDBODY_SOURCE_NAME");
  const sourcePassword = env("MINDBODY_SOURCE_PASSWORD");
  if (!apiKey || !sourceName || !sourcePassword) {
    throw new Error("Mindbody secrets are not configured");
  }

  const baseUrl = "https://api.mindbodyonline.com/public/v6/site/activationcode";
  const headers = {
    "Api-Key": apiKey,
    SiteId: siteId,
    SourceName: sourceName,
    SourcePassword: sourcePassword,
  };

  let lastError = "";
  for (const url of [baseUrl, `${baseUrl}?siteId=${encodeURIComponent(siteId)}`]) {
    const response = await fetch(url, { method: "GET", headers });
    const text = await response.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (response.ok) {
      const activationCode = activationCodeFrom(data);
      if (!activationCode) throw new Error("Mindbody did not return an activation code");
      return { activationCode, raw: data };
    }

    lastError = String(
      (data.Error as { Message?: string } | undefined)?.Message ||
        data.Message ||
        data.message ||
        `Mindbody request failed (${response.status})`,
    );
  }

  throw new Error(lastError || "Mindbody request failed");
}

async function saveConnection(userId: string, siteId: string, activationCode: string, raw: Record<string, unknown>) {
  const supabaseUrl = env("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) throw new Error("Supabase service role key is not configured");

  const row = {
    user_id: userId,
    platform: "mindbody",
    merchant_id: siteId,
    merchant_name: `Mindbody Site ${siteId}`,
    access_token: activationCode,
    raw_response: {
      provider: "mindbody",
      site_id: siteId,
      activation_code: activationCode,
      activation_status: "code_issued",
      response: raw,
    },
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_active: true,
  };

  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  const filter = `user_id=eq.${encodeURIComponent(userId)}&platform=eq.mindbody`;
  const updateResponse = await fetch(`${supabaseUrl}/rest/v1/platform_connections?${filter}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  const updated = await updateResponse.json().catch(() => []);
  if (updateResponse.ok && Array.isArray(updated) && updated.length) return updated[0];

  const insertResponse = await fetch(`${supabaseUrl}/rest/v1/platform_connections`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  const inserted = await insertResponse.json().catch(() => null);
  if (!insertResponse.ok) {
    const error = inserted?.message || inserted?.error || "Could not save Mindbody connection";
    throw new Error(error);
  }
  return Array.isArray(inserted) ? inserted[0] : inserted;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const user = await authedUser(req);
  if (!user?.id) return json({ error: "Login is required to connect Mindbody" }, 401);

  let body: MindbodyBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const siteId = String(body.site_id || body.siteId || "").trim();
  if (!/^\d{2,12}$/.test(siteId)) {
    return json({ error: "Enter a valid numeric Mindbody SiteID" }, 400);
  }

  try {
    const { activationCode, raw } = await requestActivationCode(siteId);
    await saveConnection(user.id, siteId, activationCode, raw);
    return json({
      ok: true,
      platform: "mindbody",
      site_id: siteId,
      merchant_name: `Mindbody Site ${siteId}`,
      activation_code: activationCode,
      instructions: "Give this activation code to the business owner so they can approve Clicktide in Mindbody.",
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Mindbody activation failed" }, 500);
  }
});
