// Shipping address validation. Uses Google Address Validation when configured,
// then falls back to the Census Bureau geocoder (free, no API key).
// POST {address, city, state, zip} -> {valid, matched, normalized, source}

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Internal calls (gift-address, printify-fulfill-gift) authenticate with the
// service role; the dashboard sends the owner's JWT. Anonymous use is refused —
// once a Google key is configured this would otherwise be a free public proxy.
async function isAuthorized(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return false;
  if (serviceRoleKey && auth === `Bearer ${serviceRoleKey}`) return true;
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: serviceRoleKey, Authorization: auth } });
  return r.ok;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

type NormalizedAddress = {
  address1: string;
  city: string;
  region: string;
  zip: string;
  country: string;
};

function cleanZip(zip: string) {
  return zip.trim().slice(0, 12);
}

function complete(street: string, city: string, state: string, zip: string) {
  if (!street || !city || !state || !zip) return "street, city, state, and ZIP are required";
  if (!/^[0-9]{5}(-[0-9]{4})?$/.test(zip)) return "ZIP code must be 5 digits, optionally plus 4";
  return "";
}

function googleKey() {
  return Deno.env.get("GOOGLE_ADDRESS_VALIDATION_API_KEY") ||
    Deno.env.get("GOOGLE_MAPS_API_KEY") ||
    "";
}

function googleNormalized(data: Record<string, unknown>, fallback: NormalizedAddress) {
  const result = (data.result || {}) as Record<string, unknown>;
  const address = (result.address || {}) as Record<string, unknown>;
  const postal = (address.postalAddress || {}) as Record<string, unknown>;
  const usps = (result.uspsData || {}) as Record<string, unknown>;
  const uspsStd = (usps.standardizedAddress || {}) as Record<string, unknown>;
  const lines = Array.isArray(postal.addressLines) ? postal.addressLines.map(String).filter(Boolean) : [];
  const uspsLine = [uspsStd.firstAddressLine, uspsStd.secondAddressLine].map((x) => String(x || "").trim()).filter(Boolean).join(", ");
  return {
    address1: uspsLine || lines.join(", ") || fallback.address1,
    city: String(uspsStd.city || postal.locality || fallback.city).trim(),
    region: String(uspsStd.state || postal.administrativeArea || fallback.region).trim(),
    zip: String(uspsStd.zipCode || postal.postalCode || fallback.zip).trim(),
    country: String(postal.regionCode || fallback.country || "US").trim() || "US",
  };
}

async function validateWithGoogle(street: string, city: string, state: string, zip: string) {
  const key = googleKey();
  if (!key) return null;
  const fallback = { address1: street, city, region: state, zip, country: "US" };
  const res = await fetch(`https://addressvalidation.googleapis.com/v1:validateAddress?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify({
      address: {
        regionCode: "US",
        locality: city,
        administrativeArea: state,
        postalCode: zip,
        addressLines: [street],
      },
      enableUspsCass: true,
    }),
  });
  if (!res.ok) throw new Error("Google validator unavailable");
  const data = await res.json();
  const verdict = data?.result?.verdict || {};
  const normalized = googleNormalized(data, fallback);
  const complete = !!verdict.addressComplete;
  const unconfirmed = !!verdict.hasUnconfirmedComponents;
  const missing = !!verdict.hasMissingComponents;
  const valid = complete && !unconfirmed && !missing;
  return {
    valid,
    matched: data?.result?.address?.formattedAddress || [normalized.address1, normalized.city, normalized.region, normalized.zip].filter(Boolean).join(", "),
    normalized,
    source: "google",
    details: {
      addressComplete: complete,
      hasUnconfirmedComponents: unconfirmed,
      hasMissingComponents: missing,
      validationGranularity: verdict.validationGranularity || null,
      geocodeGranularity: verdict.geocodeGranularity || null,
    },
  };
}

async function validateWithCensus(street: string, city: string, state: string, zip: string) {
  const params = new URLSearchParams({
    street,
    benchmark: "Public_AR_Current",
    format: "json",
  });
  if (city) params.set("city", city);
  if (state) params.set("state", state);
  if (zip) params.set("zip", zip);

  const res = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/address?${params}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return { valid: null, error: "Validator unavailable", source: "census" };
  const data = await res.json();
  const matches = data?.result?.addressMatches || [];
  return {
    valid: matches.length > 0,
    matched: matches[0]?.matchedAddress || null,
    normalized: { address1: street, city, region: state, zip, country: "US" },
    source: "census",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!await isAuthorized(req)) return json({ error: "Not authorized" }, 401);

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const street = String(body.address || "").trim();
  const city = String(body.city || "").trim();
  const state = String(body.state || "").trim();
  const zip = cleanZip(String(body.zip || ""));
  const missing = complete(street, city, state, zip);
  if (missing) return json({ error: missing }, 400);

  try {
    try {
      const google = await validateWithGoogle(street, city, state, zip);
      if (google) return json(google);
    } catch (_) {
      // Fall through to Census if Google is not available or not configured.
    }
    return json(await validateWithCensus(street, city, state, zip));
  } catch {
    return json({ valid: null, error: "Validator unavailable", source: googleKey() ? "google+census" : "census" }, 200);
  }
});
