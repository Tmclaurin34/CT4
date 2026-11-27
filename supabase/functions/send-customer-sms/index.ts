const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Same allowance and price as campaign-runner — change both together.
const PLAN_SMS_LIMITS: Record<string, number> = { local: 0, growth: 1500, scale: 5000 };
const SMS_OVERAGE_PRICE = 0.05;
const MAX_SEGMENTS = 6; // Twilio bills every segment; overage is charged per text
const MANUAL_PER_BUSINESS_PER_DAY = 200;
const MANUAL_PER_CUSTOMER_PER_DAY = 10;

type SmsBody = {
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
  state?: string | null;
  zip?: string | null;
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

// US numbers only: a business's carrier registration covers domestic texting.
function normalizePhone(value?: string | null) {
  const digits = String(value || "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : "";
}

// ── SMS send window (quiet hours) ───────────────────────────────────────────
// Customer texts go out only 9:00–20:00 in the RECIPIENT's local time, and only
// 12:00–20:00 on Sundays. That sits inside the federal TCPA window (8am–9pm
// recipient-local) and the stricter state windows (e.g. FL/OK 8am–8pm; TX 9am–9pm
// Mon–Sat, noon–9pm Sunday). The cron fires every hour around the clock, so this
// gate — not the schedule — is what keeps texts out of quiet hours.
// SHARED BLOCK: campaign-runner and send-customer-sms carry this block byte for byte
// (from this banner to the end of smsWindowOpenFor) — change both together.
const SMS_WINDOW_START_HOUR = 9; // Monday–Saturday
const SMS_WINDOW_SUNDAY_START_HOUR = 12;
const SMS_WINDOW_END_HOUR = 20; // exclusive: the last text can leave at 19:59

const TZ_EASTERN = "America/New_York";
const TZ_CENTRAL = "America/Chicago";
const TZ_MOUNTAIN = "America/Denver";
const TZ_PACIFIC = "America/Los_Angeles";
const TZ_ALASKA = "America/Anchorage";
const TZ_HAWAII = "Pacific/Honolulu";

// Every time zone a state's territory touches. A text needs the window open in ALL
// of them, so a state split by a time-zone line (FL panhandle, El Paso TX, east TN…)
// is never texted early or late on its far side — it just gets a slightly shorter day.
// (campaign-runner's tzForState() is display-only: it guesses Eastern for anything it
// doesn't list — AK, HI, a blank state… — fine for a "last visit" line, unsafe for this.)
const SMS_ZONE_GROUPS: Array<[string, string[]]> = [
  ["CT DE DC GA ME MD MA NH NJ NY NC OH PA RI SC VT VA WV", [TZ_EASTERN]],
  ["FL IN KY MI TN", [TZ_EASTERN, TZ_CENTRAL]],
  ["AL AR IL IA LA MN MS MO OK WI", [TZ_CENTRAL]],
  ["KS NE ND SD TX", [TZ_CENTRAL, TZ_MOUNTAIN]],
  ["CO MT NM UT WY", [TZ_MOUNTAIN]],
  ["ID NV OR", [TZ_MOUNTAIN, TZ_PACIFIC]],
  ["CA WA", [TZ_PACIFIC]],
  ["AZ", ["America/Phoenix", TZ_MOUNTAIN]],
  ["AK", [TZ_ALASKA, "America/Adak"]],
  ["HI", [TZ_HAWAII]],
  ["PR VI", ["America/Puerto_Rico"]],
  ["GU MP", ["Pacific/Guam"]],
  ["AS", ["Pacific/Pago_Pago"]],
];
const SMS_STATE_ZONES: Record<string, string[]> = {};
for (const [codes, zones] of SMS_ZONE_GROUPS) {
  for (const code of codes.split(" ")) SMS_STATE_ZONES[code] = zones;
}

// The signup form takes the state as free text, so "ny", "N.Y." and "New York" all count.
const SMS_STATE_NAMES: Record<string, string> = {
  "ALABAMA": "AL", "ALASKA": "AK", "ARIZONA": "AZ", "ARKANSAS": "AR", "CALIFORNIA": "CA", "COLORADO": "CO",
  "CONNECTICUT": "CT", "DELAWARE": "DE", "DISTRICT OF COLUMBIA": "DC", "WASHINGTON DC": "DC", "FLORIDA": "FL",
  "GEORGIA": "GA", "HAWAII": "HI", "IDAHO": "ID", "ILLINOIS": "IL", "INDIANA": "IN", "IOWA": "IA", "KANSAS": "KS",
  "KENTUCKY": "KY", "LOUISIANA": "LA", "MAINE": "ME", "MARYLAND": "MD", "MASSACHUSETTS": "MA", "MICHIGAN": "MI",
  "MINNESOTA": "MN", "MISSISSIPPI": "MS", "MISSOURI": "MO", "MONTANA": "MT", "NEBRASKA": "NE", "NEVADA": "NV",
  "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC",
  "NORTH DAKOTA": "ND", "OHIO": "OH", "OKLAHOMA": "OK", "OREGON": "OR", "PENNSYLVANIA": "PA", "PUERTO RICO": "PR",
  "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", "TENNESSEE": "TN", "TEXAS": "TX", "UTAH": "UT",
  "VERMONT": "VT", "VIRGINIA": "VA", "WASHINGTON": "WA", "WEST VIRGINIA": "WV", "WISCONSIN": "WI", "WYOMING": "WY",
};

// No usable location: text only while the window is open everywhere from the East
// Coast to Hawaii (roughly 2–8pm Eastern).
const SMS_ZONES_UNKNOWN = [TZ_EASTERN, TZ_CENTRAL, TZ_MOUNTAIN, TZ_PACIFIC, TZ_ALASKA, TZ_HAWAII];

const smsHas = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// A recognised state / territory code for free-text input ("ny", "N.Y.", "New York",
// "Washington, D.C."), or "".
function smsStateCode(state?: string | null): string {
  const raw = String(state || "").toUpperCase().replace(/\./g, "").replace(/[^A-Z]+/g, " ").trim();
  const code = (smsHas(SMS_STATE_NAMES, raw) ? SMS_STATE_NAMES[raw] : "") || raw.replace(/ /g, "");
  return smsHas(SMS_STATE_ZONES, code) ? code : "";
}

function smsZonesForState(state?: string | null): string[] {
  const code = smsStateCode(state);
  return code ? SMS_STATE_ZONES[code] : SMS_ZONES_UNKNOWN;
}

// ZIP → state by its first three digits (USPS prefix allocation). Military (AA/AE/AP),
// unassigned prefixes, Wake Island and the freely associated states fall through to the
// next source.
const SMS_ZIP3: Array<[number, number, string]> = [
  [5, 5, "NY"], [6, 7, "PR"], [8, 8, "VI"], [9, 9, "PR"], [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"],
  [39, 49, "ME"], [50, 54, "VT"], [55, 55, "MA"], [56, 59, "VT"], [60, 69, "CT"], [70, 89, "NJ"],
  [100, 149, "NY"], [150, 196, "PA"], [197, 199, "DE"], [200, 200, "DC"], [201, 201, "VA"], [202, 205, "DC"],
  [206, 219, "MD"], [220, 246, "VA"], [247, 268, "WV"], [270, 289, "NC"], [290, 299, "SC"], [300, 319, "GA"],
  [320, 339, "FL"], [341, 342, "FL"], [344, 344, "FL"], [346, 347, "FL"], [349, 349, "FL"], [350, 369, "AL"],
  [370, 385, "TN"], [386, 397, "MS"], [398, 399, "GA"], [400, 427, "KY"], [430, 459, "OH"], [460, 479, "IN"],
  [480, 499, "MI"], [500, 528, "IA"], [530, 549, "WI"], [550, 567, "MN"], [569, 569, "DC"], [570, 577, "SD"],
  [580, 588, "ND"], [590, 599, "MT"], [600, 629, "IL"], [630, 658, "MO"], [660, 679, "KS"], [680, 693, "NE"],
  [700, 714, "LA"], [716, 729, "AR"], [730, 731, "OK"], [733, 733, "TX"], [734, 749, "OK"], [750, 799, "TX"],
  [800, 816, "CO"], [820, 831, "WY"], [832, 838, "ID"], [840, 847, "UT"], [850, 865, "AZ"], [870, 884, "NM"],
  [885, 885, "TX"], [889, 898, "NV"], [900, 961, "CA"], [967, 968, "HI"], [970, 979, "OR"], [980, 994, "WA"],
  [995, 999, "AK"],
];

function smsZipState(zip?: string | null): string {
  const m = /^(\d{5})(?:-?\d{4})?$/.exec(String(zip ?? "").trim());
  if (!m) return "";
  const z5 = Number(m[1]);
  if (z5 === 96799) return "AS"; // American Samoa shares Hawaii's 967 prefix
  if (z5 === 96898) return ""; // Wake Island (UTC+12) shares Hawaii's 968 prefix
  if (z5 >= 96910 && z5 <= 96932) return "GU";
  if (z5 >= 96950 && z5 <= 96952) return "MP";
  const z3 = Math.floor(z5 / 100);
  for (const [lo, hi, st] of SMS_ZIP3) if (z3 >= lo && z3 <= hi) return st;
  return "";
}

// NANP area code → the US state or territory it serves (NANPA assignments in service
// or announced as of 2026-11, checked against a public reference list). A number's
// area code says where it was issued, not where its owner is today (ported and moved
// numbers), so callers intersect it with the business's zones.
const SMS_AREA_CODE_GROUPS: Array<[string, string]> = [
  ["AL", "205 251 256 334 483 659 938"],
  ["AK", "907"],
  ["AZ", "480 520 602 623 928"],
  ["AR", "327 479 501 870"],
  ["CA", "209 213 279 310 323 341 350 357 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 738 747 760 805 818 820 831 837 840 858 909 916 925 949 951"],
  ["CO", "303 719 720 748 970 983"],
  ["CT", "203 475 860 959"],
  ["DE", "302"],
  ["DC", "202 771"],
  ["FL", "239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 850 863 904 941 954"],
  ["GA", "229 404 470 478 678 706 762 770 912 943"],
  ["HI", "808"],
  ["ID", "208 986"],
  ["IL", "217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872"],
  ["IN", "219 260 317 463 574 765 812 930"],
  ["IA", "319 515 563 641 712"],
  ["KS", "316 620 785 913"],
  ["KY", "270 364 502 606 859"],
  ["LA", "225 318 337 457 504 985"],
  ["ME", "207"],
  ["MD", "227 240 301 410 443 667"],
  ["MA", "339 351 413 508 617 774 781 857 978"],
  ["MI", "231 248 269 313 517 586 616 679 734 810 906 947 989"],
  ["MN", "218 320 507 612 651 763 924 952"],
  ["MS", "228 471 601 662 769"],
  ["MO", "235 314 417 557 573 636 660 816 975"],
  ["MT", "406"],
  ["NE", "308 402 531"],
  ["NV", "702 725 775"],
  ["NH", "603"],
  ["NJ", "201 551 609 640 732 848 856 862 908 973"],
  ["NM", "505 575"],
  ["NY", "212 315 329 332 347 363 465 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934"],
  ["NC", "252 336 472 704 743 828 910 919 980 984"],
  ["ND", "701"],
  ["OH", "216 220 234 283 326 330 380 419 440 513 567 614 740 937"],
  ["OK", "405 539 572 580 918"],
  ["OR", "458 503 541 971"],
  ["PA", "215 223 267 272 412 445 484 570 582 610 717 724 814 835 878"],
  ["RI", "401"],
  ["SC", "803 821 839 843 854 864"],
  ["SD", "605"],
  ["TN", "423 615 629 729 731 865 901 931"],
  ["TX", "210 214 254 281 325 346 361 409 430 432 469 512 621 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979"],
  ["UT", "385 435 801"],
  ["VT", "802"],
  ["VA", "276 434 540 571 686 703 757 804 826 948"],
  ["WA", "206 253 360 425 509 564"],
  ["WV", "304 681"],
  ["WI", "262 274 353 414 534 608 715 920"],
  ["WY", "307"],
  ["PR", "787 939"],
  ["VI", "340"],
  ["GU", "671"],
  ["MP", "670"],
  ["AS", "684"],
];
const SMS_AREA_CODE_STATE: Record<string, string> = {};
for (const [st, codes] of SMS_AREA_CODE_GROUPS) {
  for (const code of codes.split(" ")) SMS_AREA_CODE_STATE[code] = st;
}
// Non-geographic area codes: toll-free, personal communications (5XX), Canadian
// non-geographic (6XX), carrier / government (7XX) and premium (900). They say nothing
// about where the phone is, so they get the all-US window — as does any code not listed
// above (Canada, the Caribbean, unassigned).
const SMS_NON_GEOGRAPHIC = new Set(
  ("800 833 844 855 866 877 888 822 880 881 882 883 884 885 886 887 889 " +
    "500 521 522 523 524 525 526 527 528 529 532 533 544 566 577 588 600 622 633 700 710 900").split(" "),
);

// The 10 digits of a US-format number, or "".
function smsPhoneTen(phone?: string | null): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? ten : "";
}

// The state a phone number's area code belongs to, or "" (non-geographic / unlisted).
function smsAreaCodeState(phone?: string | null): string {
  const npa = smsPhoneTen(phone).slice(0, 3);
  if (!npa || SMS_NON_GEOGRAPHIC.has(npa) || !smsHas(SMS_AREA_CODE_STATE, npa)) return "";
  return SMS_AREA_CODE_STATE[npa];
}

function smsZoneUnion(a: string[], b: string[]): string[] {
  const out = a.slice();
  for (const z of b) if (!out.includes(z)) out.push(z);
  return out;
}

const SMS_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const smsHourFmt = new Map<string, Intl.DateTimeFormat>();

function smsWindowOpenIn(tz: string, at: Date): boolean {
  let fmt = smsHourFmt.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23" });
    smsHourFmt.set(tz, fmt);
  }
  const parts = fmt.formatToParts(at);
  // An AM/PM part would mean the runtime ignored the 24-hour cycle (9pm reads as "9").
  if (parts.some((p) => p.type === "dayPeriod")) return false;
  const weekday = parts.find((p) => p.type === "weekday")?.value || "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  if (!SMS_WEEKDAYS.includes(weekday) || !Number.isInteger(hour) || hour < 0 || hour > 23) return false;
  const start = weekday === "Sun" ? SMS_WINDOW_SUNDAY_START_HOUR : SMS_WINDOW_START_HOUR;
  return hour >= start && hour < SMS_WINDOW_END_HOUR;
}

// Is the window open in every zone of this BUSINESS's state? Used for the run summary;
// customer texts use smsWindowOpenFor(). Fails closed: if the local time can't be
// worked out, the window counts as shut.
function smsWindowOpen(state?: string | null, at: Date = new Date()): boolean {
  try {
    return smsZonesForState(state).every((tz) => smsWindowOpenIn(tz, at));
  } catch {
    return false;
  }
}

type SmsRecipient = { phone?: string | null; state?: string | null; zip?: string | null };
// by = which evidence placed the recipient: their own state, their ZIP, their phone's
// area code (intersected with the business's zones), the business alone, or nothing.
type SmsWindow = { zones: string[]; by: "state" | "zip" | "area_code" | "business" | "unknown" };

// Where the person receiving the text is, best evidence first. A text then needs the
// window open in EVERY zone listed (the intersection principle, as for a split state):
//   1. the customer's own state (all of its zones);
//   2. else the state of the customer's ZIP;
//   3. else the phone's area code — its state's zones AND the business's zones, since a
//      ported or moved number may not be where its area code says;
//   4. a non-geographic (toll-free…) or unlisted area code: the all-US window AND the
//      business's zones;
//   5. no usable phone: the business's zones (all-US when its state is unknown too).
// Pure and cheap; callers compute it once per customer and use it for every decision.
function smsRecipientWindow(r: SmsRecipient | null | undefined, bizState?: string | null): SmsWindow {
  const st = smsStateCode(r?.state);
  if (st) return { zones: SMS_STATE_ZONES[st], by: "state" };
  const zs = smsZipState(r?.zip);
  if (zs) return { zones: SMS_STATE_ZONES[zs], by: "zip" };
  if (smsPhoneTen(r?.phone)) {
    const biz = smsZonesForState(bizState);
    const ac = smsAreaCodeState(r?.phone);
    return ac
      ? { zones: smsZoneUnion(SMS_STATE_ZONES[ac], biz), by: "area_code" }
      : { zones: smsZoneUnion(SMS_ZONES_UNKNOWN, biz), by: "unknown" };
  }
  const bz = smsStateCode(bizState);
  return bz ? { zones: SMS_STATE_ZONES[bz], by: "business" } : { zones: SMS_ZONES_UNKNOWN, by: "unknown" };
}

// May a text go to this recipient right now? A missing or empty window counts as shut,
// and so does any failure to work out a local time.
function smsWindowOpenFor(win: SmsWindow | null | undefined, at: Date = new Date()): boolean {
  try {
    return !!win && Array.isArray(win.zones) && win.zones.length > 0 && win.zones.every((tz) => smsWindowOpenIn(tz, at));
  } catch {
    return false;
  }
}

// GSM-7 texts take 160 characters (153 per part once split); one character outside the
// GSM set turns the whole text into UCS-2: 70 UTF-16 units, 67 per part.
const GSM7 = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "^{}\\[~]|€\f";
function smsSegments(text: string) {
  let units = 0;
  for (const ch of text) {
    if (GSM7.includes(ch)) units += 1;
    else if (GSM7_EXT.includes(ch)) units += 2;
    else return text.length <= 70 ? 1 : Math.ceil(text.length / 67);
  }
  return units <= 160 ? 1 : Math.ceil(units / 153);
}

function fetchT(url: string, init: RequestInit = {}, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// The shared limiter (as in checkin), but failing CLOSED: every text costs money.
// "unavailable" (the limiter itself can't answer) is told apart from a real refusal.
async function underLimit(supabaseUrl: string, serviceRoleKey: string, bucket: string, windowSeconds: number, max: number): Promise<"ok" | "limited" | "unavailable"> {
  try {
    const r = await fetchT(`${supabaseUrl}/rest/v1/rpc/clicktide_rate_limit_hit`, {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds, p_max: max }),
    });
    if (!r.ok) return "unavailable";
    const v = await r.json();
    return v === true ? "ok" : v === false ? "limited" : "unavailable";
  } catch {
    return "unavailable";
  }
}

// The ledger's atomic entry point (contract C1): locks the wallet, refuses an overdraft.
async function walletApply(supabaseUrl: string, serviceRoleKey: string, userId: string, delta: number, kind: string, description: string, key: string) {
  const data = await supabaseRest(supabaseUrl, serviceRoleKey, "/rest/v1/rpc/clicktide_wallet_apply", {
    method: "POST",
    body: JSON.stringify({
      p_user: userId, p_delta: delta, p_kind: kind, p_description: description,
      p_reference: "manual", p_idempotency_key: key,
    }),
  });
  return (data && typeof data === "object" ? data : {}) as { ok?: boolean; duplicate?: boolean; reason?: string };
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
    `/rest/v1/customers?id=eq.${encodeURIComponent(id)}&select=id,user_id,phone,sms_consent,sms_unsubscribed_at,state,zip&limit=1`,
  ) as CustomerRow[];
  return Array.isArray(rows) ? rows[0] : null;
}

// Customer texts go out ONLY through the sending business's own approved A2P
// registration. Clicktide's own campaign is first-party (texts to business
// owners) and must never carry another business's customer messages.
// A registration belongs to a business only through user_id (set by staff at
// activation). Never match on email: owners can edit their own email, so an
// email match would let one account send through another business's number.
async function businessMessagingService(supabaseUrl: string, serviceRoleKey: string, userId: string) {
  const rows = await supabaseRest(
    supabaseUrl,
    serviceRoleKey,
    `/rest/v1/a2p_registrations?sms_status=eq.active&messaging_service_sid=not.is.null&reg_type=neq.platform&user_id=eq.${encodeURIComponent(userId)}&select=messaging_service_sid&limit=1`,
  ) as Array<{ messaging_service_sid?: string }>;
  return Array.isArray(rows) && rows[0]?.messaging_service_sid ? String(rows[0].messaging_service_sid) : "";
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

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing authorization" }, 401);

    const user = await getUser(supabaseUrl, serviceRoleKey, authHeader);
    if (!user?.id) return json({ error: "Invalid authorization" }, 401);

    const customer = await getCustomer(supabaseUrl, serviceRoleKey, body.customer_id);
    if (!customer) return json({ error: "Customer not found" }, 404);
    if (customer.user_id !== user.id) return json({ error: "Customer does not belong to this account" }, 403);
    // Consent is sms_consent=true only: a check-in's pending double-opt-in request
    // (sms_consent_requests, awaiting the customer's YES) is not consent.
    if (!customer.sms_consent || customer.sms_unsubscribed_at) {
      return json({ error: "Customer has not opted in to SMS" }, 403);
    }

    // Always the number the customer gave consent on; a caller-supplied number
    // would bypass that consent.
    const toPhone = normalizePhone(customer.phone);
    if (!toPhone) return json({ error: "Customer phone number is missing or invalid" }, 400);

    const bizRows = await supabaseRest(
      supabaseUrl,
      serviceRoleKey,
      `/rest/v1/clicktide?user_id=eq.${encodeURIComponent(user.id)}&select=plan,stripe_subscription_status,state&order=id.asc&limit=1`,
    ) as Array<{ plan?: string; stripe_subscription_status?: string; state?: string }>;
    const biz = Array.isArray(bizRows) ? bizRows[0] : null;
    if (!["active", "trialing"].includes(String(biz?.stripe_subscription_status || "").toLowerCase())) {
      return json({ error: "Your subscription isn't active, so texting is paused.", code: "billing_inactive" }, 403);
    }
    if (!["growth", "scale"].includes(String(biz?.plan || "").toLowerCase())) {
      return json({ error: "Customer texting is included on the Growth and Scale plans.", code: "sms_not_in_plan" }, 403);
    }

    // Owner one-off texts follow the same recipient-local window as the automatic ones
    // (the live code never exempted them): the customer's state, else ZIP, else area code
    // together with the business's zones.
    const recipientWindow = smsRecipientWindow(customer, String(biz?.state || ""));
    if (!smsWindowOpenFor(recipientWindow)) {
      return json({
        error: "Texts to customers can only go out between 9am and 8pm in the customer's local time (from noon on Sundays). Try again then.",
        code: "sms_quiet_hours",
        resolved_by: recipientWindow.by,
      }, 409);
    }

    const messagingServiceSid = await businessMessagingService(supabaseUrl, serviceRoleKey, user.id);
    if (!messagingServiceSid) {
      return json({
        error: "Texting isn't active for your business yet. It turns on once your business's carrier registration is approved - start it in Settings > Customer texting.",
        code: "sms_not_registered",
      }, 409);
    }

    const message = body.message.trim().slice(0, 1500);
    const segments = smsSegments(message);
    if (segments > MAX_SEGMENTS) {
      return json({
        error: `That text would go out as ${segments} message parts; keep it to ${MAX_SEGMENTS} or fewer (about ${MAX_SEGMENTS * 153} plain characters, or ${MAX_SEGMENTS * 67} with emoji).`,
        code: "message_too_long",
      }, 400);
    }

    let limit = await underLimit(supabaseUrl, serviceRoleKey, `sms:manual:biz:${user.id}`, 86400, MANUAL_PER_BUSINESS_PER_DAY);
    if (limit === "ok") limit = await underLimit(supabaseUrl, serviceRoleKey, `sms:manual:cust:${customer.id}`, 86400, MANUAL_PER_CUSTOMER_PER_DAY);
    if (limit === "unavailable") {
      return json({ error: "Texting is briefly unavailable. Please try again in a few minutes.", code: "rate_limit_unavailable" }, 503);
    }
    if (limit === "limited") {
      return json({ error: "Today's texting limit is reached. Try again tomorrow.", code: "rate_limited" }, 429);
    }

    // The plan's monthly allowance, counted on the server; past it, each text is paid for
    // from the wallet BEFORE it is sent. Any doubt (counter or ledger unreachable): no text.
    const allowance = PLAN_SMS_LIMITS[String(biz?.plan || "").toLowerCase()] ?? 0;
    let used = 0;
    try {
      used = Number(await supabaseRest(supabaseUrl, serviceRoleKey, "/rest/v1/rpc/clicktide_sms_usage", {
        method: "POST",
        body: JSON.stringify({ p_user: user.id }),
      })) || 0;
    } catch {
      return json({ error: "Texting is briefly unavailable. Please try again in a few minutes.", code: "usage_unavailable" }, 503);
    }
    let overageKey = "";
    if (used >= allowance) {
      overageKey = `manual:${customer.id}:sms:${crypto.randomUUID()}`;
      const charge = () => walletApply(supabaseUrl, serviceRoleKey, user.id, -SMS_OVERAGE_PRICE, "sms_overage", "SMS overage (plan limit reached)", overageKey);
      let debit;
      try {
        // A charge that timed out may have committed: the same key again returns
        // duplicate:true (already paid) instead of charging twice.
        debit = await charge().catch(() => charge());
      } catch {
        return json({ error: "Texting is briefly unavailable. Please try again in a few minutes.", code: "wallet_unavailable" }, 503);
      }
      if (!debit.ok) {
        return json({
          error: `This month's included texts are used up. Add funds to your wallet to keep texting ($${SMS_OVERAGE_PRICE.toFixed(2)} per text).`,
          code: "sms_budget",
        }, 402);
      }
    }
    const refundOverage = async () => {
      if (!overageKey) return;
      const refund = () => walletApply(supabaseUrl, serviceRoleKey, user.id, SMS_OVERAGE_PRICE, "sms_overage_refund", "Refund: SMS overage (text not sent)", `${overageKey}:refund`);
      await refund().catch(() => refund())
        .catch(() => globalThis.console?.error(`sms overage refund failed for ${overageKey}`));
    };

    const form = new URLSearchParams({
      To: toPhone,
      MessagingServiceSid: messagingServiceSid,
      Body: message,
    });

    let twilioResponse;
    try {
      twilioResponse = await fetchT(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      });
    } catch (e) {
      // No answer from Twilio: it may still have sent the text, so the charge stands
      // (no refund) and the owner is told to check before sending again.
      const why = e instanceof Error && e.name === "AbortError" ? "timeout" : "network error";
      await recordSms(supabaseUrl, serviceRoleKey, {
        user_id: user.id, campaign_id: null, customer_id: customer.id, to_phone: toPhone, body: message,
        status: "failed", provider: "twilio", error: `Twilio request failed (${why}); delivery unknown`,
      }).catch(() => {});
      return json({
        error: "We couldn't confirm whether the text went out. Check the conversation before sending it again.",
        code: "twilio_unconfirmed",
      }, 502);
    }

    const twilioData = await twilioResponse.json().catch(() => ({}));
    const logFields = {
      user_id: user.id,
      campaign_id: /^\d+$/.test(String(body.campaign_id ?? "")) ? Number(body.campaign_id) : null,
      customer_id: customer.id,
      to_phone: toPhone,
      body: message,
      status: twilioResponse.ok ? "sent" : "failed",
      provider: "twilio",
      provider_message_id: twilioData.sid || null,
      error: twilioResponse.ok ? null : (twilioData.message || "Twilio SMS failed"),
      sent_at: twilioResponse.ok ? new Date().toISOString() : null,
    };
    // The text has already gone (or failed) at this point; a logging problem
    // must not turn a delivered text into an error.
    const logged = await recordSms(supabaseUrl, serviceRoleKey, logFields).then(() => true).catch(() => false);

    if (!twilioResponse.ok) {
      await refundOverage();
      return json({ error: twilioData.message || "Twilio SMS failed", details: twilioData }, twilioResponse.status);
    }

    return json({ ok: true, id: twilioData.sid, status: twilioData.status || "sent", logged });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "SMS send failed" }, 500);
  }
});
