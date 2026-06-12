# CI setup

The active GitHub Actions workflow lives at `.github/workflows/checks.yml`.
It runs the launch-hardening checks: secret scan, HTML inline-script parse, and
SECURITY DEFINER revoke coverage.

Keep `ci/github-workflow-checks.yml` as a parked copy/reference. Run the same
checks locally before any deploy with `bash scripts/preflight.sh`.
