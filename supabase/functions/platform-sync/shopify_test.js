// Fixture tests: GraphQL Order node -> the same Order shape the REST mapper produced.
var sp = 0, sf = 0;
function sok(c, n) { if (c) sp++; else { sf++; print("FAIL: " + n); } }
function seq(a, b, n) { sok(JSON.stringify(a) === JSON.stringify(b), n + " (got " + JSON.stringify(a) + ")"); }
function cleanAddr(l1, l2, city, st, zip, c) {
  c = String(c || "").toUpperCase();
  if (c && ["US", "USA", "UNITED STATES"].indexOf(c) < 0) return undefined;
  var a = [l1, l2].filter(Boolean).join(", ");
  if (!a || !city || !st || !/^[0-9]{5}(-[0-9]{4})?$/.test(zip || "")) return undefined;
  return { address: a, city: city, state: st, zip: zip };
}
var full = { legacyResourceId: "5001", createdAt: "2026-10-01T15:00:00Z", cancelledAt: null, displayFinancialStatus: "PAID", email: "order@example.com",
  totalPriceSet: { shopMoney: { amount: "42.50" } },
  shippingAddress: { address1: "1 Main St", address2: "Apt 2", city: "Brooklyn", provinceCode: "NY", zip: "11201", countryCodeV2: "US" },
  customer: { firstName: "Ann", lastName: "Lee", defaultEmailAddress: { emailAddress: "ann@example.com" }, defaultPhoneNumber: { phoneNumber: "+13472223344" }, defaultAddress: null } };
seq(mapShopifyOrder(full, cleanAddr), { email: "ann@example.com", phone: "+13472223344", name: "Ann Lee",
  addr: { address: "1 Main St, Apt 2", city: "Brooklyn", state: "NY", zip: "11201" }, amount: 42.5, at: "2026-10-01T15:00:00Z", id: "5001", void: false }, "full order maps like REST");
var guest = mapShopifyOrder({ legacyResourceId: "5002", createdAt: "2026-10-02T00:00:00Z", email: "guest@example.com", totalPriceSet: { shopMoney: { amount: "10" } }, customer: null, shippingAddress: null }, cleanAddr);
seq([guest.email, guest.phone, guest.name, guest.addr, guest.amount], ["guest@example.com", undefined, "", undefined, 10], "guest checkout falls back to order email");
var fb = mapShopifyOrder({ legacyResourceId: "5003", createdAt: "x", customer: { firstName: "Bo", defaultAddress: { address1: "9 Elm", city: "Austin", province: "Texas", zip: "73301", country: "United States" } } }, cleanAddr);
seq(fb.addr, { address: "9 Elm", city: "Austin", state: "Texas", zip: "73301" }, "no shipping address -> customer default address");
seq(mapShopifyOrder({ legacyResourceId: "1", cancelledAt: "2026-01-01T00:00:00Z" }, cleanAddr).void, true, "cancelled is void");
seq(mapShopifyOrder({ legacyResourceId: "1", displayFinancialStatus: "REFUNDED" }, cleanAddr).void, true, "refunded is void");
seq(mapShopifyOrder({ legacyResourceId: "1", displayFinancialStatus: "VOIDED" }, cleanAddr).void, true, "voided is void");
seq(mapShopifyOrder({ legacyResourceId: "1", displayFinancialStatus: "PARTIALLY_REFUNDED" }, cleanAddr).void, false, "partial refund still a visit");
seq(mapShopifyOrder({ shippingAddress: { address1: "1 Rd", city: "Toronto", provinceCode: "ON", zip: "11111", countryCodeV2: "CA" } }, cleanAddr).addr, undefined, "non-US address dropped");
seq(mapShopifyOrder({ customer: { defaultEmailAddress: null, defaultPhoneNumber: null } }, cleanAddr).email, undefined, "redacted (unapproved) fields -> no identity");
seq(ordersSearch("2026-01-01T00:00:00Z"), "created_at:>='2026-01-01T00:00:00.000Z'", "search window");
seq(readOrdersResponse(200, { data: { orders: { nodes: [full], pageInfo: { hasNextPage: true, endCursor: "c1" } } } }).cursor, "c1", "cursor read");
seq(readOrdersResponse(200, { errors: [{ extensions: { code: "THROTTLED" } }] }).throttled, true, "throttled");
seq(readOrdersResponse(401, {}).error, "shopify orders 401", "http error keeps REST-style message");
seq(readOrdersResponse(200, { errors: [{ extensions: { code: "ACCESS_DENIED" } }], data: null }).error, "shopify orders 403 ACCESS_DENIED", "access denied -> 403");
seq(readOrdersResponse(200, { errors: [{ message: "not approved to use the phoneNumber field" }], data: { orders: { nodes: [], pageInfo: {} } } }).fieldErrors, 1, "partial field errors tolerated");
seq(throttleWaitMs({ cost: { throttleStatus: { currentlyAvailable: 200, restoreRate: 100 } } }, 1000), 8000, "throttle wait");
seq(throttleWaitMs({ cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 100 } } }, 500), 0, "no wait when bucket full");
print("SHOPIFY MAPPING TESTS: " + sp + " passed, " + sf + " failed");
