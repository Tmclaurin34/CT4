// Shopify order import over the GraphQL Admin API.
//
// Shopify retired REST for new public apps (App Store requirement 2.2.4: GraphQL
// Admin API only since 2025-04-01), so platform-sync no longer calls
// /admin/api/2024-01/orders.json. This file turns GraphQL Order nodes into the
// exact same Order shape the REST mapper produced, so applyOrder(), the visit
// ledger (pos_transactions_seen.source_txn_id) and the free POS audit behave the
// same:
//   - id      = Order.legacyResourceId (the numeric id REST returned), so orders
//               imported before the switch are recognised as already counted
//   - email   = customer's default email, else the order's contact email
//   - phone   = customer's default phone (REST used customer.phone only)
//   - addr    = shipping address, else the customer's default address
//   - amount  = totalPriceSet.shopMoney.amount (REST total_price, shop currency)
//   - at      = processedAt (the sale date; = createdAt except for imported/backdated orders)
//   - void    = cancelled, or financial status REFUNDED / VOIDED
//   - emailOptOut = the customer's email marketing state is UNSUBSCRIBED / REDACTED
//
// Plain JavaScript so Deno imports it and the jsc test rig can load it
// (see shopify_test.js / run_audit_tests.sh).

export const SHOPIFY_API_VERSION = "2026-10";

// One logical "page" is still 250 orders (the REST page size), so maxPages and
// the truncation counters mean what they meant before. A single GraphQL request
// asks for at most 100 orders: each order node selects 8 objects, and a query
// may not request more than 1,000 cost points.
export const LOGICAL_PAGE = 250;
export const GQL_PAGE = 100;

export const ORDERS_QUERY = `query ClicktideOrders($first: Int!, $after: String, $q: String!) {
  orders(first: $first, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      legacyResourceId
      createdAt
      processedAt
      cancelledAt
      displayFinancialStatus
      email
      totalPriceSet { shopMoney { amount } }
      shippingAddress { address1 address2 city province provinceCode zip country countryCodeV2 }
      customer {
        firstName
        lastName
        defaultEmailAddress { emailAddress marketingState }
        defaultPhoneNumber { phoneNumber }
        defaultAddress { address1 address2 city province provinceCode zip country countryCodeV2 }
      }
    }
  }
}`;

// Orders created at or after `since` (ISO), oldest first — the same window and
// order the REST call (created_at_min + since_id ascending) used.
export function ordersSearch(since) {
  const t = Date.parse(since);
  const iso = Number.isFinite(t) ? new Date(t).toISOString() : new Date(0).toISOString();
  return `created_at:>='${iso}'`;
}

// One time slice [start, end) of the resumable nightly sync (oldest first inside it).
export function ordersRangeSearch(startMs, endMs) {
  return `created_at:>='${new Date(startMs).toISOString()}' created_at:<'${new Date(endMs).toISOString()}'`;
}

// Shopify email marketing states that mean "don't email this shopper".
export const SHOPIFY_EMAIL_OPTED_OUT = ["UNSUBSCRIBED", "REDACTED"];

// node: one GraphQL Order node. cleanAddr: index.ts's US-address cleaner.
export function mapShopifyOrder(node, cleanAddr) {
  const o = node || {};
  const cu = o.customer || {};
  const sa = o.shippingAddress || cu.defaultAddress || {};
  const status = String(o.displayFinancialStatus || "").toUpperCase();
  const name = [cu.firstName, cu.lastName].filter(Boolean).join(" ");
  return {
    email: (cu.defaultEmailAddress && cu.defaultEmailAddress.emailAddress) || o.email || undefined,
    phone: (cu.defaultPhoneNumber && cu.defaultPhoneNumber.phoneNumber) || undefined,
    name,
    addr: cleanAddr(sa.address1, sa.address2, sa.city, sa.provinceCode || sa.province, sa.zip, sa.countryCodeV2 || sa.country),
    amount: Number(o.totalPriceSet && o.totalPriceSet.shopMoney && o.totalPriceSet.shopMoney.amount) || 0,
    // processedAt is when the sale happened; it differs from createdAt only for orders
    // imported with a past date (store migrations, backfills). The search stays on
    // created_at so the nightly sync still catches a backdated order the day it's added.
    at: o.processedAt || o.createdAt,
    id: String(o.legacyResourceId || "") || undefined,
    // The shopper unsubscribed from the store's email marketing: Clicktide won't email them.
    emailOptOut: SHOPIFY_EMAIL_OPTED_OUT.includes(String((cu.defaultEmailAddress && cu.defaultEmailAddress.marketingState) || "").toUpperCase()),
    // Cancelled / refunded orders aren't visits (kept out of the visit history).
    void: !!o.cancelledAt || status === "REFUNDED" || status === "VOIDED",
  };
}

// How long to wait (ms) before the next request, from the response's cost
// extension, so we never trip Shopify's leaky-bucket throttle.
export function throttleWaitMs(extensions, nextCost) {
  const ts = extensions && extensions.cost && extensions.cost.throttleStatus;
  if (!ts) return 0;
  const avail = Number(ts.currentlyAvailable), rate = Number(ts.restoreRate);
  const need = Number(nextCost) || 0;
  if (!Number.isFinite(avail) || !Number.isFinite(rate) || rate <= 0 || avail >= need) return 0;
  return Math.ceil(((need - avail) / rate) * 1000);
}

// Classify a GraphQL response: { orders } on success (partial field errors are
// tolerated — fields without Protected Customer Data approval come back null),
// { throttled: true } to retry, or { error } to fail the sync like a REST 4xx/5xx.
export function readOrdersResponse(status, body) {
  const errs = (body && body.errors) || [];
  const codes = (Array.isArray(errs) ? errs : []).map((e) => String((e && e.extensions && e.extensions.code) || ""));
  if (status === 429 || codes.includes("THROTTLED")) return { throttled: true };
  if (status < 200 || status >= 300) return { error: `shopify orders ${status}` };
  const conn = body && body.data && body.data.orders;
  if (!conn) {
    const code = codes.find(Boolean) || "no data";
    return { error: `shopify orders ${code === "ACCESS_DENIED" ? 403 : 500} ${code}` };
  }
  return {
    orders: conn.nodes || [],
    hasNext: !!(conn.pageInfo && conn.pageInfo.hasNextPage),
    cursor: (conn.pageInfo && conn.pageInfo.endCursor) || "",
    fieldErrors: Array.isArray(errs) ? errs.length : 0,
  };
}

// Which order window Shopify will actually return. read_orders alone covers
// the last 60 days; read_all_orders (needs Shopify's approval) covers all.
export const SHOPIFY_DEFAULT_ORDER_DAYS = 60;
export function shopifyOrderWindow(since, scope, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const all = String(scope || "").split(",").map((x) => x.trim()).includes("read_all_orders");
  if (all) return { since, limited: false, days: null };
  const floor = t - SHOPIFY_DEFAULT_ORDER_DAYS * 86400000;
  const s = Date.parse(since);
  if (Number.isFinite(s) && s >= floor) return { since, limited: false, days: null };
  return { since: new Date(floor).toISOString(), limited: true, days: SHOPIFY_DEFAULT_ORDER_DAYS };
}
