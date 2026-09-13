---
name: create-pr
description: >
  Use when the user asks to open, create, or draft a GitHub pull request with gh.
  Handles main-based PRs, issue closing lines, optional .github/pull_request_template.md, and body cleanup after create.
  Do NOT use for merge-only requests or when no PR was requested.
---

# Create GitHub PR (`gh`)

Open a PR from the **current branch** into **`main`** on `origin` using `gh`. Requires `gh auth login`.

## Workflow

1. **Context** — `git fetch origin`, then:

   ```bash
   git status --short --branch
   git log --oneline origin/main...HEAD
   git diff --stat origin/main...HEAD
   git diff origin/main...HEAD
   ```

   Infer intent, impact, risks, verification.

2. **Issues** — Link to **GitHub issues** (no Jira). Resolve issue number(s) from: user message → `#nnn` in `git log --oneline origin/main..HEAD` → optional branch-name hint; **ask** if still unclear. Never invent numbers.

3. **Body** — If `.github/pull_request_template.md` exists, fill every section (use `N/A` where it does not apply); else **What / Why / How tested**. When issues apply, add `Closes #n` / `Fixes #n` per [GitHub linking](https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue) (default `Closes`). If no issue and user confirms none, omit closing lines.

4. **Title** — Concise imperative subject from the diff; no `PROJ-123:` prefix. Optional trailing `(#n)` only if it stays readable; otherwise rely on closing lines in the body.

5. **Push** — If no upstream: `git push -u origin HEAD`.

6. **Create** — Write body to a temp file; then:

   ```bash
   gh pr create --base main --head "$(git rev-parse --abbrev-ref HEAD)" --title "<title>" --body-file "<path>"
   ```

7. **Body cleanup** — If a tool appended a footer to the PR body, `gh pr edit <N> --body-file "<same body file>"`.

8. **Reply** — End with `[PR #<n>: <title>](<url>)`.

## Check

PR opens on `main`; body matches template/structure and intended `Closes`/`Fixes` lines.
