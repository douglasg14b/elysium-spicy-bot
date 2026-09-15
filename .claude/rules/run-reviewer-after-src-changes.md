---
description: Run the orchestrating reviewer subagent after completing src TypeScript changes
alwaysApply: false
---

# Run reviewer after `src/` TypeScript changes

When the active agent has finished a **substantial** change to application TypeScript under `src/`, before considering the task done:

1. **Invoke the `reviewer` subagent** via the Task/subagent mechanism (`subagent_type: reviewer`). Provide the list of changed files or a short description of what changed so the review can stay scoped.
2. That orchestrator audits changes across **Discord interactions & events**, **correctness & runtime**, **data persistence**, **AI & safety**, **architecture**, **style & conventions**, **security & privacy**, and **tests & docs** (it delegates to four focused sub-reviewers and merges one report).
3. Fix any **Critical or High** findings. Medium and Low are at your discretion or left for the user.

## Budget: this is expensive, spend it where it pays

A review pass costs roughly 90–190k tokens. That is worth it for a change where a mistake is hard to see, and is not worth it for a small one you have already verified.

- **At most two serial passes per change, and prefer one.** A second pass is for confirming that specific Critical/High findings were genuinely resolved — not for finding new Mediums. After the second pass, report what remains and move on; do not loop.
- **"Substantial" means**: new engine or persistence behaviour, a contract other code is written against, concurrency or state transitions, anything touching Discord interaction acknowledgement, or a change spanning several files.
- **Skip review for**: single-file fixes, comment and copy edits, test-only changes, and changes whose guard you have already **sabotage-verified** (revert the fix, watch a named test fail, restore it). Say in your summary that you skipped it and why.
- Sabotage verification is the cheap substitute and is often the stronger evidence. Prefer it first; reach for the reviewer when the risk is something a test would not think to ask about.

## Generated artifacts & secrets exclusion (mandatory)

Reviewers must **not** treat generated/build output or secret-bearing paths as normal review scope. When you pass changed-file lists, **omit** these patterns. For any spot-check reads, **do not open**:

- `**/dist/**`, `**/build/**`, `**/coverage/**`
- `**/node_modules/**`, `**/.cache/**`, `**/.turbo/**`, `**/.pnpm-store/**`
- `**/*.log`
- Secret or credential material: `.env*`, `**/*token*`, `**/*secret*`, `**/*.pem`, `**/*.key`, `**/credentials*.json`

Using the dedicated **`reviewer`** orchestrator keeps convention and correctness checks consistent and separates review output from implementation work.
