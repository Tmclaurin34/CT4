// Tests for _shared/shopify.js. HMAC vectors were computed with Python's hmac module.
var pass = 0, fail = 0, pending = 0;
function ok(c, n) { if (c) pass++; else { fail++; print("FAIL: " + n); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n + " (got " + JSON.stringify(a) + ")"); }

// --- test-only SHA-256 / HMAC so the real verify code runs under jsc (prod uses WebCrypto) ---
function sha256(bytes) {
  var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var l = bytes.length, m = new Uint8Array(((l + 9 + 63) >> 6) << 6); m.set(bytes); m[l] = 0x80;
  var bits = l * 8; for (var i = 0; i < 4; i++) m[m.length - 1 - i] = (bits >>> (8 * i)) & 255;
  var w = new Array(64);
  for (var o = 0; o < m.length; o += 64) {
    for (i = 0; i < 16; i++) w[i] = (m[o+4*i]<<24)|(m[o+4*i+1]<<16)|(m[o+4*i+2]<<8)|m[o+4*i+3];
    for (i = 16; i < 64; i++) { var a0=w[i-15], a1=w[i-2];
      var s0=((a0>>>7)|(a0<<25))^((a0>>>18)|(a0<<14))^(a0>>>3), s1=((a1>>>17)|(a1<<15))^((a1>>>19)|(a1<<13))^(a1>>>10);
      w[i]=(w[i-16]+s0+w[i-7]+s1)|0; }
    var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for (i = 0; i < 64; i++) {
      var S1=((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7)), ch=(e&f)^(~e&g), t1=(h+S1+ch+K[i]+w[i])|0;
      var S0=((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10)), mj=(a&b)^(a&c)^(b&c), t2=(S0+mj)|0;
      h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0; }
    H[0]=(H[0]+a)|0;H[1]=(H[1]+b)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;H[4]=(H[4]+e)|0;H[5]=(H[5]+f)|0;H[6]=(H[6]+g)|0;H[7]=(H[7]+h)|0;
  }
  var out = new Uint8Array(32); for (i = 0; i < 8; i++) for (var j = 0; j < 4; j++) out[4*i+j] = (H[i] >>> (24 - 8*j)) & 255;
  return out;
}
function cat(a, b) { var r = new Uint8Array(a.length + b.length); r.set(a); r.set(b, a.length); return r; }
var fakeSubtle = {
  importKey: function (_f, raw) { return Promise.resolve(raw); },
  sign: function (_a, key, msg) {
    var k = new Uint8Array(64); k.set(key.length > 64 ? sha256(key) : key);
    var ip = new Uint8Array(64), op = new Uint8Array(64);
    for (var i = 0; i < 64; i++) { ip[i] = k[i] ^ 0x36; op[i] = k[i] ^ 0x5c; }
    return Promise.resolve(sha256(cat(op, sha256(cat(ip, msg)))).buffer);
  },
};
if (typeof TextEncoder === "undefined") {
  this.TextEncoder = function () {};
  TextEncoder.prototype.encode = function (s) { s = unescape(encodeURIComponent(s)); var a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; };
}

// --- base64 / compare ---
eq([bytesToBase64(new TextEncoder().encode("a")), bytesToBase64(new TextEncoder().encode("ab")), bytesToBase64(new TextEncoder().encode("abc"))], ["YQ==", "YWI=", "YWJj"], "base64 padding");
ok(safeEqual("abc", "abc") && !safeEqual("abc", "abd") && !safeEqual("", "") && !safeEqual("ab", "abc"), "safeEqual");
ok(isShopDomain("ct-test.myshopify.com") && !isShopDomain("evil.com") && !isShopDomain("a.myshopify.com.evil.com"), "shop domain check");
ok(freshTimestamp(1795740000, 1795740000 * 1000 + 5000) && !freshTimestamp(1795740000, 1795740000 * 1000 + 2 * 86400000), "timestamp freshness");

// --- async HMAC checks ---
var body = '{"shop_domain":"ct-test.myshopify.com","shop_id":1}';
pending++;
verifyWebhookHmac(body, "nrY65dcAR+4l5/OL6qSBoP8eRXANHNB1LtDoJnCMe+4=", "shhh-secret", fakeSubtle).then(function (v) { ok(v, "webhook HMAC accepts valid signature"); return verifyWebhookHmac(body + " ", "nrY65dcAR+4l5/OL6qSBoP8eRXANHNB1LtDoJnCMe+4=", "shhh-secret", fakeSubtle); })
  .then(function (v) { ok(!v, "webhook HMAC rejects tampered body"); return verifyWebhookHmac(body, "nrY65dcAR+4l5/OL6qSBoP8eRXANHNB1LtDoJnCMe+4=", "other", fakeSubtle); })
  .then(function (v) { ok(!v, "webhook HMAC rejects wrong secret"); return verifyWebhookHmac(body, "", "shhh-secret", fakeSubtle); })
  .then(function (v) { ok(!v, "missing header rejected");
    var q = [["shop", "ct-test.myshopify.com"], ["code", "abc"], ["hmac", "8bf284738ad3ac8d4795ec05c1059325111b675cf73845d86761dc1d2951d1a7"], ["timestamp", "1795740000"], ["state", "s1"]];
    return verifyQueryHmac(q, "shhh-secret", fakeSubtle); })
  .then(function (v) { ok(v, "OAuth query HMAC (sorted, hmac excluded)");
    return verifyQueryHmac([["shop", "x.myshopify.com"], ["hmac", "8bf284738ad3ac8d4795ec05c1059325111b675cf73845d86761dc1d2951d1a7"]], "shhh-secret", fakeSubtle); })
  .then(function (v) { ok(!v, "OAuth query HMAC rejects altered params"); pending--; }, function (e) { fail++; print("FAIL: async " + e); pending--; });

// --- billing mapping ---
var now = Date.parse("2026-11-26T12:00:00Z");
function sub(o) { var s = { id: "gid://shopify/AppSubscription/1", name: "Growth", status: "ACTIVE", test: false, trialDays: 30, createdAt: "2026-11-20T00:00:00Z", currentPeriodEnd: "2026-12-20T00:00:00Z", lineItems: [] }; for (var k in o) s[k] = o[k]; return s; }
eq(entitlementFromSubscriptions([sub({})], { now: now }).status, "trialing", "active inside 30-day trial = trialing");
eq(entitlementFromSubscriptions([sub({ createdAt: "2026-09-01T00:00:00Z" })], { now: now }).status, "active", "after trial = active");
eq(entitlementFromSubscriptions([sub({})], { now: now }).plan, "Growth", "plan from name");
eq(planFromSubscription({ name: "Pro monthly", lineItems: [{ plan: { pricingDetails: { price: { amount: "449.0" } } } }] }), "Scale", "plan from price");
eq(entitlementFromSubscriptions([sub({ status: "FROZEN" })], { now: now }).status, "unpaid", "frozen = paywalled");
eq(entitlementFromSubscriptions([sub({ status: "CANCELLED" })], { now: now }).status, "canceled", "cancelled");
eq(entitlementFromSubscriptions([], { now: now }).status, "canceled", "no subscription = no access");
eq(entitlementFromSubscriptions([sub({ test: true })], { now: now }).status, "canceled", "test charge on a real store gives no access");
eq(entitlementFromSubscriptions([sub({ test: true })], { now: now, devStore: true }).status, "trialing", "test charge on a dev store (app review) works");
eq(entitlementFromSubscriptions([sub({ name: "Mystery", lineItems: [] })], { now: now }).status, "incomplete", "unknown plan never unlocks");
eq(entitlementFromSubscriptions([sub({ status: "CANCELLED", id: "old" }), sub({ id: "new", name: "Scale" })], { now: now }).sub_id, "new", "picks the active one");
eq(planSelectionUrl("ct-test.myshopify.com", "clicktide-3"), "https://admin.shopify.com/store/ct-test/charges/clicktide-3/pricing_plans", "plan page url");
eq(compliancePayload("customers/redact", { shop_domain: "s", customer: { id: 1, email: "a@b.c", phone: "1", extra: "x" }, orders_to_redact: [10, 11], junk: 1 }),
   { shop_id: null, shop_domain: "s", customer: { id: 1, email: "a@b.c", phone: "1" }, orders: ["10", "11"], data_request_id: null }, "payload minimised");

drainMicrotasks && drainMicrotasks();
if (pending) print("FAIL: async tests did not finish");
print("SHARED SHOPIFY TESTS: " + pass + " passed, " + (fail + pending) + " failed");
