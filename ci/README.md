# CI setup (one manual step)

`github-workflow-checks.yml` is a ready GitHub Actions workflow (secret scan,
HTML inline-script parse, SECURITY DEFINER revoke check). The deploy token used
from this machine lacks `workflow` scope, so it cannot push files under
`.github/workflows/` — activate CI one of two ways:

1. GitHub web UI → Add file → `.github/workflows/checks.yml` → paste this file's contents, or
2. Regenerate the PAT with the `workflow` scope and `git mv ci/github-workflow-checks.yml .github/workflows/checks.yml`.

Until then, run the same checks locally before any deploy: `bash scripts/preflight.sh`
