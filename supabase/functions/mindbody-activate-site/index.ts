const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type MindbodyBody = {
  site_id?: string | number;
  siteId?: string | number;
};

const IN_USE = "This Mindbody SiteID is already connected to another Clicktide account. If it's your business, contact support@goclicktide.com.";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function env(name: string) {
  return Deno.env.get(name) || "";
}

function supabaseUrl() {
  return env("SUPABASE_URL") || "https://hmihfncvahsdlmefyxyg.supabase.co";
}

function serviceHeaders() {
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

async function authedUser(req: Request) {
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = req.headers.get("authorization") || "";
  if (!serviceRoleKey || !authorization.toLowerCase().startsWith("bearer ")) return null;

  const response = await fetch(`${supabaseUrl()}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: authorization,
    },
  });
  if (!response.ok) return null;
  return await response.json();
}

// Fails open: activation is an owner-facing flow; the limiter only stops someone
// hammering Mindbody with Clicktide's source credentials.
async function underLimit(bucket: string, windowSeconds: number, max: number) {
  try {
    const r = await fetch(`${supabaseUrl()}/rest/v1/rpc/clicktide_rate_limit_hit`, {
      method: "POST",
      headers: serviceHeaders(),
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
    });
    if (!r.ok) return true;
    return (await r.json()) === true;
  } catch {
    return true;
  }
}

// A SiteID is read with Clicktide's own Mindbody source credentials, so whichever
// account holds it would see that studio's data. One SiteID, one active account.
async function claimedByAnotherAccount(userId: string, siteId: string) {
  const response = await fetch(
    `${supabaseUrl()}/rest/v1/platform_connections?platform=eq.mindbody&merchant_id=eq.${encodeURIComponent(siteId)}&is_active=eq.true&user_id=neq.${encodeURIComponent(userId)}&select=id&limit=1`,
    { headers: serviceHeaders() },
  );
  if (!response.ok) throw new Error("Could not check the Mindbody SiteID");
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
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

// Saved through the same RPC as the POS callbacks, so the one-account-per-SiteID rule
// holds even if two accounts submit the same SiteID at once.
async function saveConnection(userId: string, siteId: string, activationCode: string, raw: Record<string, unknown>) {
  if (!env("SUPABASE_SERVICE_ROLE_KEY")) throw new Error("Supabase service role key is not configured");

  const fields = {
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
  };

  const response = await fetch(`${supabaseUrl()}/rest/v1/rpc/clicktide_platform_connection_save`, {
    method: "POST",
    headers: serviceHeaders(),
    body: JSON.stringify({ p_user: userId, p_platform: "mindbody", p_fields: fields }),
  });
  const result = await response.json().catch(() => null);
  if (response.ok && result?.ok === true) return result;
  if (result?.reason === "merchant_in_use") return { ok: false, inUse: true };
  throw new Error(result?.message || result?.error || "Could not save Mindbody connection");
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

  if (!(await underLimit(`mindbody-activate:user:${user.id}`, 3600, 10))) {
    return json({ error: "Too many activation requests — try again in an hour." }, 429);
  }

  try {
    if (await claimedByAnotherAccount(String(user.id), siteId)) return json({ error: IN_USE }, 409);
    const { activationCode, raw } = await requestActivationCode(siteId);
    const saved = await saveConnection(String(user.id), siteId, activationCode, raw);
    if (!saved.ok) return json({ error: IN_USE }, 409);
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
