// Retired 2026-11-28: the draft-order test harness for gift printing is no longer served.
// Its code is kept in outputs/gift-print-test/harness/ for a future re-test.
Deno.serve(() => new Response(JSON.stringify({ error: "Gone" }), { status: 410, headers: { "Content-Type": "application/json" } }));
