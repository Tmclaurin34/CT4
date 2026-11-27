// One-off email from a business owner to ONE of their own customers.
// It goes out under the business's stored name from Clicktide's verified domain, so
// the caller can't pick the From name or the recipient, the business needs an active
// or trialing subscription, sends are capped per day, and the footer can't be left
// off: the business's postal address and its own unsubscribe link are always added.
// Owner-designed HTML (Email Studio) is rebuilt from an allowlist before sending.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type EmailBody = {
  to?: string; // ignored: the recipient is always the customer's stored email
  subject?: string;
  message?: string;
  html?: string;
  customer_name?: string;
  business_name?: string; // ignored: the From name is the business's stored name
  customer_id?: string | number;
};

type CustomerRow = {
  id: string;
  user_id: string;
  email?: string | null;
  name?: string | null;
  email_unsubscribed_at?: string | null;
};

type BusinessRow = {
  business_name?: string | null;
  plan?: string | null;
  stripe_subscription_status?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
};

type Postal = { text: string; onBehalf: boolean };

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://hmihfncvahsdlmefyxyg.supabase.co";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_FROM_DOMAIN = "support@goclicktide.com"; // verified Resend sender; display name is the business
const EMAIL_UNSUB_SECRET = Deno.env.get("EMAIL_UNSUB_SECRET") || serviceRoleKey;
// Clicktide's own mailing address, used only for a business with no complete address.
const CLICKTIDE_POSTAL_ADDRESS = (Deno.env.get("CLICKTIDE_POSTAL_ADDRESS") ?? "").replace(/\s+/g, " ").trim();

const HOURLY_CAP = 30;
const DAILY_CAP: Record<string, number> = { active: 100, trialing: 25 };
const PER_RECIPIENT_DAILY_CAP = 3;
const MAX_HTML_CHARS = 300000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UNSUBSCRIBED = "This customer has unsubscribed from emails and can't be emailed.";

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

// Bidi override characters (U+202A-202E, U+2066-2069) disguise text and link labels.
function stripBidi(value: string): string {
  return value.replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

function oneLine(value: unknown, max = 200) {
  return stripBidi(String(value ?? "")).replace(/\s+/g, " ").trim().slice(0, max);
}

// Customer-facing "From" shows the BUSINESS name, sent from the one verified domain.
function fromName(name: unknown) {
  return oneLine(name, 200).replace(/[<>"\r\n,;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Per-business signed unsubscribe link (contract C2), verified by email-unsubscribe.
async function unsubUrlFor(userId: string, email: string): Promise<string> {
  const biz = userId.trim().toLowerCase();
  const addr = email.trim().toLowerCase();
  if (!biz || !addr || !EMAIL_UNSUB_SECRET) return "";
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(EMAIL_UNSUB_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${biz}|${addr}`));
    const s = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${supabaseUrl}/functions/v1/email-unsubscribe?b=${encodeURIComponent(biz)}&e=${encodeURIComponent(addr)}&s=${s}`;
  } catch {
    return "";
  }
}

// Fails closed: these sends go out on the shared Resend account and domain.
async function underLimit(bucket: string, windowSeconds: number, max: number) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/clicktide_rate_limit_hit`, {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
    });
    if (!r.ok) return false;
    return (await r.json()) === true;
  } catch {
    return false;
  }
}

// CAN-SPAM: every marketing email carries a valid postal address. That is the
// business's own street address when its profile has a complete one; otherwise
// Clicktide's, worded as sent on the business's behalf. Neither means no send.
function postalFor(biz: BusinessRow): Postal | null {
  const street = oneLine(biz.address);
  const city = oneLine(biz.city, 80);
  const state = oneLine(biz.state, 40);
  const zip = oneLine(biz.zip, 20);
  if (street && city && state && zip) return { text: `${street}, ${city}, ${state} ${zip}`, onBehalf: false };
  if (CLICKTIDE_POSTAL_ADDRESS) return { text: CLICKTIDE_POSTAL_ADDRESS, onBehalf: true };
  return null;
}

function footerInner(business: string, unsubUrl: string, postal: Postal, whiteLabel: boolean) {
  const biz = escapeHtml(business);
  const linkStyle = "color:#9CA3AF;text-decoration:underline";
  const unsub = `<a href="${escapeHtml(unsubUrl)}" style="${linkStyle}">Unsubscribe</a>`;
  const sender = postal.onBehalf
    ? `Sent on behalf of ${biz} by Clicktide &middot; ${escapeHtml(postal.text)}`
    : `${whiteLabel ? "" : `Sent via <a href="https://goclicktide.com" style="${linkStyle}">Clicktide</a> &middot; `}${biz} &middot; ${escapeHtml(postal.text)}`;
  return `You're receiving this because you're a customer of ${biz}.<br>${unsub} &middot; ${sender}`;
}

function messageHtml(business: string, customerName: string, message: string, footer: string) {
  const biz = escapeHtml(business);
  const customer = escapeHtml(customerName || "there");
  const text = escapeHtml(message || "Thanks for being a customer.").replaceAll("\n", "<br>");
  return `<div style="background:#F4F5F7;padding:26px 12px;font-family:Arial,Helvetica,sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border-radius:14px;border:1px solid #E9EBEF">
      <tr><td align="center" style="padding:26px 30px 18px;border-bottom:1px solid #F0F1F4"><div style="font-size:21px;font-weight:bold;color:#111827">${biz}</div></td></tr>
      <tr><td style="padding:24px 30px;color:#1F2937;font-size:15px;line-height:1.7"><p style="margin:0 0 14px">Hi ${customer},</p><p style="margin:0">${text}</p></td></tr>
      <tr><td align="center" style="padding:16px 30px 22px;border-top:1px solid #F0F1F4;font-size:11px;color:#9CA3AF;line-height:1.7">${footer}</td></tr>
    </table></td></tr></table></div>`;
}

// The template sits in its own container that clips whatever overflows it (its own
// formatting context, so child margins can't reach past it), and the footer comes
// after it as a positioned box, which paints above any non-positioned template content.
// The container's trailing !important declarations win over the template's body style.
function templateHtml(clean: { html: string; bodyStyle: string }, footer: string) {
  const bodyStyle = clean.bodyStyle ? `${clean.bodyStyle};` : "";
  const contain = "overflow:hidden!important;display:block!important;display:flow-root!important;float:none!important;position:static!important";
  return `<div style="${escapeHtml(bodyStyle + contain)}">${clean.html}</div>` +
    `<div style="position:relative;clear:both;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#9CA3AF;padding:14px 12px;line-height:1.7;background:#FFFFFF">${footer}</div>`;
}

// ── Owner-designed HTML ─────────────────────────────────────────────────────
// Rebuilt, not filtered: only the tags below survive, every attribute is re-parsed,
// checked and re-quoted, and text can't carry markup. Scripts, <style>, forms,
// frames, embeds, media, comments and <head> are dropped. Links must be absolute
// http(s)/mailto/tel on an ordinary hostname (no IP, no user@host, no punycode, no
// odd port); images must be https.
const KEEP_TAGS = new Set([
  "a", "abbr", "article", "b", "big", "blockquote", "br", "caption", "center", "cite", "code", "col",
  "colgroup", "dd", "del", "div", "dl", "dt", "em", "figcaption", "figure", "font", "footer", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "li", "main", "mark", "ol", "p", "pre", "q",
  "s", "section", "small", "span", "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "u", "ul", "wbr",
]);
const VOID_TAGS = new Set(["br", "col", "hr", "img", "wbr"]);
const DROP_WITH_CONTENT = new Set([
  "applet", "audio", "button", "canvas", "frameset", "head", "iframe", "map", "math", "noembed", "noframes",
  "noscript", "object", "plaintext", "script", "select", "style", "svg", "template", "textarea", "title",
  "video", "xmp",
]);
const ATTR_RULES = new Map<string, RegExp>([
  ["align", /^(left|right|center|justify|top|middle|bottom)$/i],
  ["valign", /^(top|middle|bottom|baseline)$/i],
  ["width", /^\d{1,4}(\.\d{1,2})?(%|px)?$/i],
  ["height", /^\d{1,4}(\.\d{1,2})?(%|px)?$/i],
  ["border", /^\d{1,2}$/],
  ["cellpadding", /^\d{1,3}$/],
  ["cellspacing", /^\d{1,3}$/],
  ["colspan", /^\d{1,3}$/],
  ["rowspan", /^\d{1,3}$/],
  ["bgcolor", /^#?[0-9a-z]{1,20}$/i],
  ["color", /^#?[0-9a-z]{1,20}$/i],
  ["size", /^[+-]?\d{1,2}$/],
  ["face", /^[\w ,'"-]{1,100}$/],
  ["dir", /^(ltr|rtl|auto)$/i],
  ["lang", /^[a-z]{1,8}(-[a-z0-9]{1,8})*$/i],
  ["role", /^[a-z]{1,20}$/i],
]);
const TEXT_ATTRS = new Set(["alt", "title"]);
// Inline CSS that could move, cover or paint over content (the footer), or load/run
// something. Matched after any vendor prefix is removed, so -webkit-transform counts.
const CSS_DROP_PROPS = new Set([
  "position", "top", "right", "bottom", "left", "z-index", "translate", "rotate", "scale", "behavior",
  "binding", "content", "clip", "clip-path", "filter", "backdrop-filter", "cursor", "pointer-events",
  "opacity", "mix-blend-mode", "isolation", "will-change", "contain", "content-visibility",
  "view-transition-name", "box-reflect", "overflow-scrolling",
]);
const CSS_DROP_PREFIX = /^(animation|transition|mask|transform|perspective|inset|outline|offset|border-image)/;
const NAMED_ENTITIES = new Map<string, string>([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["nbsp", "\u00a0"],
  ["colon", ":"], ["tab", "\t"], ["newline", "\n"], ["lpar", "("], ["rpar", ")"],
]);

// Attribute values are decoded before they are checked and fully re-escaped on output,
// so the value a mail client sees is exactly the value that was checked.
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});?/gi, (match: string, entity: string) => {
    const key = entity.toLowerCase();
    if (key.startsWith("#")) {
      const code = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED_ENTITIES.get(key) ?? match;
  });
}

function escAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escText(value: string): string {
  return stripBidi(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function safeUrl(raw: string, kind: string): string {
  const value = decodeEntities(raw).replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
  if (!value) return "";
  if (kind === "href" && /^#[\w-]*$/.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (kind === "href" && (url.protocol === "mailto:" || url.protocol === "tel:")) return url.href;
  if (url.protocol !== "https:" && !(kind === "href" && url.protocol === "http:")) return "";
  const host = url.hostname.toLowerCase();
  if (url.username || url.password || url.port) return "";
  if (!host.includes(".") || host.includes("xn--") || host.startsWith("[") || /^[\d.]+$/.test(host)) return "";
  return url.href;
}

function safeCss(raw: string): string {
  const out: string[] = [];
  for (const decl of decodeEntities(raw).split(";")) {
    const colon = decl.indexOf(":");
    if (colon < 1) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (!/^-?[a-z][a-z-]{0,39}$/.test(prop) || !value || value.length > 300) continue;
    const base = prop.replace(/^-(webkit|moz|ms|o)-/, "");
    if (CSS_DROP_PROPS.has(base) || CSS_DROP_PREFIX.test(base)) continue;
    if (/[\\<>{}`]|\/\*|url\s*\(|image-set\s*\(|expression\s*\(|@import|javascript:|vbscript:/i.test(value)) continue;
    // Any minus sign or function (calc, min, var, ...) could make a margin negative.
    if (base.includes("margin") && /[-(]/.test(value)) continue;
    out.push(`${prop}:${value}`);
  }
  return out.join(";").slice(0, 2000);
}

function parseAttrs(src: string, start: number): { attrs: Array<[string, string]>; end: number; selfClosing: boolean } {
  const attrs: Array<[string, string]> = [];
  const n = src.length;
  let i = start;
  while (i < n) {
    while (i < n && (src[i] === "/" || /\s/.test(src[i]))) i++;
    if (i >= n) break;
    if (src[i] === ">") return { attrs, end: i + 1, selfClosing: src[i - 1] === "/" };
    let name = "";
    while (i < n && !/[\s/>=]/.test(src[i])) name += src[i++];
    if (!name) name = src[i++];
    while (i < n && /\s/.test(src[i])) i++;
    let value = "";
    if (src[i] === "=") {
      i++;
      while (i < n && /\s/.test(src[i])) i++;
      const quote = src[i];
      if (quote === '"' || quote === "'") {
        const close = src.indexOf(quote, i + 1);
        value = close === -1 ? src.slice(i + 1) : src.slice(i + 1, close);
        i = close === -1 ? n : close + 1;
      } else {
        while (i < n && !/[\s>]/.test(src[i])) value += src[i++];
      }
    }
    attrs.push([name.toLowerCase(), value]);
  }
  return { attrs, end: n, selfClosing: false };
}

function buildTag(name: string, attrs: Array<[string, string]>): string {
  const out: string[] = [];
  const seen = new Set<string>();
  let href = "";
  for (const [key, raw] of attrs) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === "style") {
      const css = safeCss(raw);
      if (css) out.push(`style="${escAttr(css)}"`);
    } else if (key === "href") {
      if (name === "a") href = safeUrl(raw, "href");
    } else if (key === "src") {
      const src = name === "img" ? safeUrl(raw, "src") : "";
      if (src) out.push(`src="${escAttr(src)}"`);
    } else if (TEXT_ATTRS.has(key)) {
      out.push(`${key}="${escAttr(stripBidi(decodeEntities(raw)).slice(0, 300))}"`);
    } else {
      const rule = ATTR_RULES.get(key);
      const value = decodeEntities(raw).trim();
      if (rule && rule.test(value)) out.push(`${key}="${escAttr(value)}"`);
    }
  }
  if (name === "img" && !out.some((a) => a.startsWith("src="))) return "";
  if (href) {
    out.unshift(`href="${escAttr(href)}"`);
    if (!href.startsWith("#")) out.push(`target="_blank"`, `rel="noopener noreferrer"`);
  }
  return `<${name}${out.length ? " " + out.join(" ") : ""}>`;
}

function sanitizeEmailHtml(input: string): { html: string; bodyStyle: string } {
  let src = String(input || "")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, "")
    .replace(/<![^>]*>?/g, "")
    .replace(/<\?[^>]*>?/g, "");

  let bodyStyle = "";
  const bodyOpen = /<body\b([^>]*)>/i.exec(src);
  if (bodyOpen) {
    const css: string[] = [];
    for (const [key, raw] of parseAttrs(`${bodyOpen[1]}>`, 0).attrs) {
      if (key === "style") css.push(safeCss(raw));
      if (key === "bgcolor" && /^#?[0-9a-z]{1,20}$/i.test(decodeEntities(raw).trim())) css.push(`background-color:${decodeEntities(raw).trim()}`);
    }
    bodyStyle = css.filter(Boolean).join(";");
    src = src.slice(bodyOpen.index + bodyOpen[0].length);
    const bodyClose = src.search(/<\/body\s*>/i);
    if (bodyClose !== -1) src = src.slice(0, bodyClose);
  }

  const out: string[] = [];
  const stack: string[] = [];
  const tagStart = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/y;
  const n = src.length;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      out.push(escText(src.slice(i)));
      break;
    }
    if (lt > i) out.push(escText(src.slice(i, lt)));
    tagStart.lastIndex = lt;
    const m = tagStart.exec(src);
    if (!m) {
      out.push("&lt;");
      i = lt + 1;
      continue;
    }
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    const parsed = parseAttrs(src, lt + m[0].length);
    i = parsed.end;

    if (closing) {
      const at = stack.lastIndexOf(name);
      if (at !== -1) while (stack.length > at) out.push(`</${stack.pop()}>`);
      continue;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      if (!parsed.selfClosing) {
        const closeTag = new RegExp(`</${name}[\\s/>]`, "gi");
        closeTag.lastIndex = i;
        const cm = closeTag.exec(src);
        const gt = cm ? src.indexOf(">", cm.index) : -1;
        i = gt === -1 ? n : gt + 1;
      }
      continue;
    }
    if (!KEEP_TAGS.has(name)) continue;
    const tag = buildTag(name, parsed.attrs);
    if (!tag) continue;
    out.push(tag);
    if (!VOID_TAGS.has(name)) stack.push(name);
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  return { html: out.join(""), bodyStyle };
}

async function getUser(authHeader: string) {
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: authHeader,
    },
  });
  if (!response.ok) return null;
  return await response.json();
}

async function supabaseRest(path: string, init: RequestInit = {}) {
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

async function getCustomer(id: string) {
  const rows = await supabaseRest(
    `/rest/v1/customers?id=eq.${encodeURIComponent(id)}&select=id,user_id,email,name,email_unsubscribed_at&limit=1`,
  ) as CustomerRow[];
  return Array.isArray(rows) ? rows[0] : null;
}

// Only a business with a live subscription; clicktide.user_id isn't unique, so the
// filter picks the subscribed row if there is more than one.
async function getSubscribedBusiness(userId: string) {
  const rows = await supabaseRest(
    `/rest/v1/clicktide?user_id=eq.${encodeURIComponent(userId)}&stripe_subscription_status=in.(active,trialing)&select=business_name,plan,stripe_subscription_status,address,city,state,zip&order=id.asc&limit=1`,
  ) as BusinessRow[];
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// "" when this business may email the address, else why not: a suppression for this
// business, or any of its customer rows with this address flagged (C2). Throws, so the
// send fails closed, when the check can't run.
async function sendBlock(userId: string, email: string) {
  const reason = await supabaseRest("/rest/v1/rpc/clicktide_email_send_block", {
    method: "POST",
    body: JSON.stringify({ p_user: userId, p_email: email }),
  });
  return reason ? String(reason) : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    if (!supabaseUrl || !serviceRoleKey) return json({ error: "Supabase is not configured" }, 500);
    if (!resendApiKey) return json({ error: "RESEND_API_KEY is not configured" }, 500);

    let body: EmailBody;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    if (!body || typeof body !== "object") return json({ error: "Invalid JSON body" }, 400);

    const subject = oneLine(body.subject, 200);
    if (!subject) {
      return json({ error: "Email subject is required" }, 400);
    }
    const customerId = String(body.customer_id ?? "").trim();
    if (!customerId) {
      return json({ error: "customer_id is required so ownership can be verified" }, 400);
    }
    if (!/^\d{1,19}$/.test(customerId)) return json({ error: "Customer not found" }, 404);
    const html = typeof body.html === "string" ? body.html : "";
    if (html.length > MAX_HTML_CHARS) return json({ error: "This email design is too large to send." }, 413);

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Login is required to send customer emails" }, 401);

    const user = await getUser(authHeader);
    if (!user?.id) return json({ error: "Invalid authorization" }, 401);
    const userId = String(user.id);

    const template = html.trim() ? sanitizeEmailHtml(html) : null;
    if (template && !/<img\b/.test(template.html) && !template.html.replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "")) {
      return json({ error: "Nothing in this email design can be sent (scripts, forms and embedded content are removed)." }, 400);
    }

    const customer = await getCustomer(customerId);
    if (!customer) return json({ error: "Customer not found" }, 404);
    if (customer.user_id !== userId) return json({ error: "Customer does not belong to this account" }, 403);

    const toEmail = String(customer.email || "").trim();
    if (!toEmail) return json({ error: "Customer email is missing" }, 400);
    if (!EMAIL_RE.test(toEmail)) return json({ error: "Customer email doesn't look like a valid address" }, 400);
    if (customer.email_unsubscribed_at) return json({ error: UNSUBSCRIBED, code: "unsubscribed" }, 409);

    const biz = await getSubscribedBusiness(userId);
    if (!biz) {
      return json({ error: "Your subscription isn't active, so customer emails are paused.", code: "billing_inactive" }, 403);
    }
    const senderName = fromName(biz.business_name);
    const businessName = oneLine(biz.business_name, 100);
    if (!senderName) {
      return json({ error: "Add your business name in Settings before emailing customers.", code: "business_name_missing" }, 409);
    }

    const suppressed = await sendBlock(userId, toEmail);
    if (suppressed === "bounce") {
      return json({ error: "Email to this address bounced, so it can't be sent. Update the customer's email first.", code: "bounced" }, 409);
    }
    if (suppressed) return json({ error: UNSUBSCRIBED, code: "unsubscribed" }, 409);

    const postal = postalFor(biz);
    if (!postal) {
      console.error(`send-customer-email: business ${userId} has no complete mailing address and CLICKTIDE_POSTAL_ADDRESS is unset; marketing email blocked`);
      return json({
        error: "Add your business mailing address (street, city, state, ZIP) in Settings before emailing customers. US law (CAN-SPAM) requires one in every marketing email.",
        code: "postal_address_missing",
      }, 409);
    }

    const unsubUrl = await unsubUrlFor(userId, toEmail);
    if (!unsubUrl) return json({ error: "Email sending isn't available right now." }, 500);

    // Caps after every other check, tightest first. Each check counts a hit before the
    // next runs, so a request refused by a later cap (or failed by Resend) still counts.
    const status = String(biz.stripe_subscription_status || "").toLowerCase();
    const recipient = (await sha256Hex(toEmail.toLowerCase())).slice(0, 32);
    if (
      !(await underLimit(`email:manual:to:${userId}:${recipient}`, 86400, PER_RECIPIENT_DAILY_CAP)) ||
      !(await underLimit(`email:manual:day:${userId}`, 86400, DAILY_CAP[status] ?? DAILY_CAP.trialing)) ||
      !(await underLimit(`email:manual:hour:${userId}`, 3600, HOURLY_CAP))
    ) {
      return json({ error: "You've reached the limit for one-off customer emails for now. Try again later, or use a campaign.", code: "rate_limited" }, 429);
    }

    const whiteLabel = String(biz.plan || "").toLowerCase() === "scale";
    const footer = footerInner(businessName, unsubUrl, postal, whiteLabel);
    const customerName = oneLine(body.customer_name, 80) || oneLine(customer.name, 80);
    const content = template
      ? templateHtml(template, footer)
      : messageHtml(businessName, customerName, String(body.message ?? ""), footer);

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${senderName} <${EMAIL_FROM_DOMAIN}>`,
        to: [toEmail],
        subject,
        html: content,
        headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        // resend-webhook uses these to attribute complaints and bounces to the business.
        tags: [{ name: "ct_biz", value: userId }, { name: "ct_kind", value: "manual" }],
      }),
    });

    const data = await resendResponse.json().catch(() => ({}));
    if (!resendResponse.ok) {
      return json({ error: data?.message || "Resend email failed", details: data }, resendResponse.status);
    }

    console.log(`send-customer-email: business ${userId} customer ${customer.id} resend ${String(data.id || "")}`);
    return json({ ok: true, id: data.id });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Email send failed" }, 500);
  }
});
