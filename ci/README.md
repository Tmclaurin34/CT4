# CI setup (one manual step)

`github-workflow-checks.yml` is a ready GitHub Actions workflow for the
launch-hardening checks: secret scan, HTML inline-script parse, and SECURITY
DEFINER revoke coverage.

The current deploy token does not have GitHub's `workflow` scope, so pushes that
create or update `.github/workflows/checks.yml` are rejected. Activate CI one of
two ways:

1. GitHub web UI -> Add file -> `.github/workflows/checks.yml` -> paste this file's contents, or
2. Regenerate the PAT with the `workflow` scope and move `ci/github-workflow-checks.yml` to `.github/workflows/checks.yml`.

Until then, run the same checks locally before any deploy with
`bash scripts/preflight.sh`.
