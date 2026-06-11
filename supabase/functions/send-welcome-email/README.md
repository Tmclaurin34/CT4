# send-welcome-email (v6 — Square-style layout)
Deployed 2026-06-11 directly to Supabase. Canonical source = Supabase deployed version.
template-preview.html in this folder is the rendered design reference (sample data).
Key changes v5→v6: Square-style light layout (white card, 34px headline, outlined step
circles, gold pill CTA, Monday Drift Report info card, LLC footer); steps updated to the
current product (POS connect → Drift Reveal → Win-Back Playbook → Brand Studio); subject
line now "Welcome to Clicktide — {business}'s customers are about to start coming back".
Retrieve exact source: Supabase dashboard → Edge Functions → send-welcome-email, or MCP get_edge_function.
