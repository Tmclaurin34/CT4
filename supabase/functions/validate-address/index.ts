// US address validation via the Census Bureau geocoder (free, no API key).
// POST {address, city, state, zip} -> {valid, matched}
// Used by signup to catch typos before an account is created.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const street = String(body.address || "").trim();
  const city = String(body.city || "").trim();
  const state = String(body.state || "").trim();
  const zip = String(body.zip || "").trim();
  if (!street) return json({ error: "address is required" }, 400);

  const params = new URLSearchParams({
    street,
    benchmark: "Public_AR_Current",
    format: "json",
  });
  if (city) params.set("city", city);
  if (state) params.set("state", state);
  if (zip) params.set("zip", zip);

  try {
    const res = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/address?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return json({ valid: null, error: "Validator unavailable" }, 200);
    const data = await res.json();
    const matches = data?.result?.addressMatches || [];
    return json({
      valid: matches.length > 0,
      matched: matches[0]?.matchedAddress || null,
    });
  } catch {
    // Validator down or slow — report unknown, never block signups on our infra.
    return json({ valid: null, error: "Validator unavailable" }, 200);
  }
});
