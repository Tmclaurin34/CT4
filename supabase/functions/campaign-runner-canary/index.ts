// Retired 2026-11-28: canary copy used to dry-run the offer-code engine change before it went live.
Deno.serve(() => new Response(JSON.stringify({ error: "Gone" }), { status: 410, headers: { "Content-Type": "application/json" } }));
