// Verified business-profile changes. The dashboard requests a change; we email
// or text a 6-digit code to the contact info ALREADY on file, and only apply
// the change after the owner confirms the code. Every request + outcome is
// stored in business_profile_changes so back office can see the full history.
//
// POST {action:"request", fields:{business_name,...}, channel:"email"|"sms"}
//   -> diffs against the current clicktide row, stores a pending change,
//      sends the code, returns {ok, id, channel, sent_to (masked)}
// POST {action:"confirm", id, code}
//   -> verifies (15 min expiry, 5 attempts), applies the change, returns {ok, applied}
//
// Auth: user JWT (normal path), or x-clicktide-cron-key + body.user_id for
// admin testing (echo_code:true returns the code, skip_send:true skips delivery).

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL") ?? "Clicktide <support@goclicktide.com>";

const ALLOWED_FIELDS = [
  "business_name", "contact_name", "phone", "business_type", "business_phone",
  "business_email", "website", "address", "city", "state", "zip",
];
const CODE_TTL_MIN = 15;
const MAX_ATTEMPTS = 5;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-clicktide-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}) },
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.message || data?.error || r.statusText);
  return data;
}

async function expectedCronKey() {
  try {
    return String(await rest("/rest/v1/rpc/clicktide_internal_key", { method: "POST", body: "{}" }) || "");
  } catch {
    return "";
  }
}

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function genCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}

function maskEmail(e: string) {
  const [u, d] = String(e).split("@");
  if (!d) return "your email on file";
  return `${u.slice(0, 1)}***@${d}`;
}

function maskPhone(p: string) {
  const digits = String(p).replace(/\D/g, "");
  return `(***) ***-${digits.slice(-4)}`;
}

function e164(p: string) {
  const digits = String(p).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return p.startsWith("+") ? p : `+${digits}`;
}

const FIELD_LABELS: Record<string, string> = {
  business_name: "Business name", contact_name: "Contact name", phone: "Personal phone",
  business_type: "Business type", business_phone: "Business phone", business_email: "Business email",
  website: "Website", address: "Street address", city: "City", state: "State", zip: "ZIP",
};

function changesSummaryHtml(changes: Record<string, { from: string; to: string }>) {
  const esc = (v: string) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return Object.entries(changes).map(([k, v]) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#6B7280;font-size:13px;white-space:nowrap">${FIELD_LABELS[k] || k}</td><td style="padding:6px 0;font-size:13px;color:#0B0F19"><span style="color:#9CA3AF;text-decoration:line-through">${esc(v.from || "—")}</span> &nbsp;→&nbsp; <strong>${esc(v.to)}</strong></td></tr>`
  ).join("");
}

function codeEmailHtml(businessName: string, code: string, changes: Record<string, { from: string; to: string }>) {
  return `<div style="background:#F6F7F9;padding:36px 14px;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border-radius:16px;padding:34px 38px">
    <div style="font-size:17px;font-weight:bold;color:#080D18;letter-spacing:1px;margin-bottom:24px">CLICK<span style="color:#2D7FF9">TIDE</span></div>
    <div style="font-size:24px;font-weight:bold;color:#0B0F19;margin-bottom:12px">Confirm your business info change</div>
    <p style="font-size:14px;color:#374151;line-height:1.65;margin:0 0 18px">Someone (hopefully you) asked to update the profile for <strong>${businessName}</strong>:</p>
    <table style="border-collapse:collapse;margin-bottom:22px">${changesSummaryHtml(changes)}</table>
    <div style="background:#F4F6FA;border-radius:12px;padding:18px;text-align:center;margin-bottom:22px">
      <div style="font-size:11px;font-weight:bold;letter-spacing:2px;color:#6B7280;margin-bottom:6px">YOUR CONFIRMATION CODE</div>
      <div style="font-size:34px;font-weight:bold;letter-spacing:8px;color:#0B0F19">${code}</div>
    </div>
    <p style="font-size:13px;color:#6B7280;line-height:1.6;margin:0">This code expires in ${CODE_TTL_MIN} minutes. If you didn't request this change, you can ignore this email — nothing will change without the code — or reply to reach a human.</p>
  </div></div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = await req.json().catch(() => ({}));
  let userId = "";
  let isCron = false;

  const cronKey = req.headers.get("x-clicktide-cron-key") || "";
  if (cronKey && cronKey === await expectedCronKey()) {
    isCron = true;
    userId = String(body.user_id || "");
  } else {
    const auth = req.headers.get("authorization") || "";
    if (auth.toLowerCase().startsWith("bearer ")) {
      const r = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: serviceRoleKey, Authorization: auth } });
      if (r.ok) userId = String((await r.json())?.id || "");
    }
  }
  if (!userId) return json({ error: "Not authorized" }, 401);

  try {
    const action = String(body.action || "");

    if (action === "request") {
      const channel = body.channel === "sms" ? "sms" : "email";
      const requested = body.fields && typeof body.fields === "object" ? body.fields : {};

      const rows = await rest(`/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}&select=email,phone,business_name,${ALLOWED_FIELDS.join(",")}&limit=1`);
      const biz = Array.isArray(rows) ? rows[0] : null;
      if (!biz) return json({ error: "Business profile not found" }, 404);

      const changes: Record<string, { from: string; to: string }> = {};
      for (const k of ALLOWED_FIELDS) {
        if (!(k in requested)) continue;
        const to = String(requested[k] ?? "").trim();
        const from = String(biz[k] ?? "").trim();
        if (to !== from) changes[k] = { from, to };
      }
      if (!Object.keys(changes).length) return json({ error: "Nothing changed — the profile already matches." }, 400);
      if (changes.business_name && !changes.business_name.to) return json({ error: "Business name can't be empty." }, 400);

      // Codes go to the contact info already on file, never the new values.
      const destEmail = String(biz.email || "");
      const destPhone = String(biz.phone || "");
      if (channel === "email" && !destEmail) return json({ error: "No email on file to send the code to." }, 400);
      if (channel === "sms" && !destPhone) return json({ error: "No phone on file — use email instead." }, 400);

      const code = genCode();
      const codeHash = await sha256Hex(`${userId}:${code}`);
      const sentTo = channel === "sms" ? maskPhone(destPhone) : maskEmail(destEmail);

      // One pending change at a time — supersede older ones.
      await rest(`/rest/v1/business_profile_changes?user_id=eq.${encodeURIComponent(userId)}&status=eq.pending`, {
        method: "PATCH", body: JSON.stringify({ status: "cancelled" }),
      });
      const ins = await rest("/rest/v1/business_profile_changes", {
        method: "POST",
        body: JSON.stringify({ user_id: userId, changes, channel, sent_to: sentTo, code_hash: codeHash }),
      });
      const changeId = Array.isArray(ins) ? ins[0]?.id : ins?.id;

      if (!(isCron && body.skip_send === true)) {
        if (channel === "email") {
          const r = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: resendFrom,
              to: [destEmail],
              subject: `${code} is your Clicktide confirmation code`,
              html: codeEmailHtml(String(biz.business_name || "your business"), code, changes),
            }),
          });
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            throw new Error(d?.message || "Could not send the confirmation email");
          }
        } else {
          const sid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
          const tok = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
          const from = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
          if (!sid || !tok || !from) return json({ error: "Texting isn't available right now — use email instead." }, 503);
          const form = new URLSearchParams({ From: from, To: e164(destPhone), Body: `Clicktide: ${code} is your confirmation code for updating your business info. Expires in ${CODE_TTL_MIN} minutes.` });
          const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
            method: "POST",
            headers: { Authorization: `Basic ${btoa(`${sid}:${tok}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: form,
          });
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            return json({ error: d?.message || "Could not text the code — use email instead." }, 502);
          }
        }
      }

      const resp: Record<string, unknown> = { ok: true, id: changeId, channel, sent_to: sentTo };
      if (isCron && body.echo_code === true) resp.code = code;
      return json(resp);
    }

    if (action === "confirm") {
      const id = Number(body.id || 0);
      const code = String(body.code || "").trim();
      if (!id || !/^\d{6}$/.test(code)) return json({ error: "Enter the 6-digit code." }, 400);

      const rows = await rest(`/rest/v1/business_profile_changes?id=eq.${id}&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row || row.status !== "pending") return json({ error: "This code is no longer valid — request the change again." }, 400);

      const ageMin = (Date.now() - new Date(row.created_at).getTime()) / 60000;
      if (ageMin > CODE_TTL_MIN) {
        await rest(`/rest/v1/business_profile_changes?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "expired" }) });
        return json({ error: "That code expired — request the change again." }, 400);
      }

      const hash = await sha256Hex(`${userId}:${code}`);
      if (hash !== row.code_hash) {
        const attempts = Number(row.attempts || 0) + 1;
        const dead = attempts >= MAX_ATTEMPTS;
        await rest(`/rest/v1/business_profile_changes?id=eq.${id}`, {
          method: "PATCH", body: JSON.stringify({ attempts, ...(dead ? { status: "expired" } : {}) }),
        });
        return json({ error: dead ? "Too many wrong codes — request the change again." : `Wrong code — ${MAX_ATTEMPTS - attempts} tries left.` }, 400);
      }

      const applied: Record<string, string> = {};
      for (const [k, v] of Object.entries(row.changes as Record<string, { to: string }>)) {
        if (ALLOWED_FIELDS.includes(k)) applied[k] = v.to;
      }
      await rest(`/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}`, {
        method: "PATCH", body: JSON.stringify(applied),
      });
      await rest(`/rest/v1/business_profile_changes?id=eq.${id}`, {
        method: "PATCH", body: JSON.stringify({ status: "confirmed", confirmed_at: new Date().toISOString() }),
      });
      return json({ ok: true, applied });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || "Something went wrong" }, 500);
  }
});
