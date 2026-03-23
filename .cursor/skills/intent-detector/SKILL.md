---
name: intent-detector
description: >
    Use when classifying a short GitHub comment for automation (CLI/CI): issue thread or pull request conversation.
    Emits one JSON object: intent plan, plan_feedback, implement, or other, plus confidence and reason.
    Do NOT use for long threads, security triage, or anything requiring edits to the repository.
---

# Intent detector (CLI / CI)

Classify **one user comment** (and optional issue context) so a script can branch without fragile string matching.

## Inputs (provided by the caller)

The caller must supply text by path or inline in the prompt:

- **Comment** — the latest comment body to classify: **issue** thread or **pull request** conversation (required).
- **Discussion context** (optional) — title/body of the issue or PR the comment belongs to, for disambiguation.

In **GitHub Actions**, `pnpm github-plan classify intent` (see [src/tools/github-plan-cli/cli.ts](src/tools/github-plan-cli/cli.ts)) reads `DISCUSSION_NUMBER`, `DISCUSSION_KIND` (`issue` or `pull_request`), and `GITHUB_EVENT_PATH`. It writes `.jarvis/intent-context.md`, runs `agent` in ask/json mode with an explicit read-files prompt and `--model auto`, and writes `GITHUB_OUTPUT` keys `intent` and `run_plan`. Requires repo checkout, `agent` on `PATH`, `GITHUB_TOKEN`, and repository secret `JARVIS_API_KEY` (see `agentSubprocessEnv` in [src/tools/github-plan-cli/agentEnv.ts](src/tools/github-plan-cli/agentEnv.ts) for how it is passed to the agent process).

## Output (required)

Reply with **exactly one JSON object** and **nothing else**:

- No markdown fences (no ` ```json `).
- No prose before or after.
- One line is preferred; pretty-printed JSON is allowed if it remains a single parseable object.

### Schema

| Field        | Type   | Required | Values                                        |
| ------------ | ------ | -------- | --------------------------------------------- |
| `intent`     | string | yes      | `plan`, `plan_feedback`, `implement`, `other` |
| `confidence` | number | yes      | 0.0–1.0                                       |
| `reason`     | string | yes      | &lt;= 200 chars, plain text, no newlines      |

### Intent definitions

- **`plan`** — User wants a **new** implementation plan (first-time or replace-from-scratch): a written technical plan, roadmap, steps, or “how to build this” for the **current issue/PR**. Examples: “create a plan”, “write an implementation plan”, “make a comprehensive plan for implementing this”, “plan this issue”, “need a technical plan”, “@cursor plan this”. **Addressing the automation by name** (e.g. “Jarvis, …”) and asking for a plan is **`plan`** when the ask is for planning / design / steps—not casual chat.
- **`plan_feedback`** — User is **iterating on an already-existing plan artifact** (a plan already in the thread, on a plan branch, or clearly the subject of prior messages). Examples: “update the plan”, “revise section on testing”, “change the plan to use X”, “add migrations to the plan”. **Not** `plan_feedback` when there is no existing plan yet and they simply say “make / write / create a plan”—that is **`plan`**.
- **`implement`** — User wants **execution**: coding, shipping, applying an agreed plan. Examples: “implement this”, “go ahead and build”, “execute the plan”, “ship it”, “open a PR”. (Asking only for a **plan document** first is still **`plan`**, not `implement`.)
- **`other`** — None of the above: small talk, off-topic, empty, or **genuinely ambiguous** (no reasonable reading as plan / plan_feedback / implement).

### Rules

1. Pick the **dominant** user goal. If the comment clearly asks for a **new** plan (any phrasing: plan, roadmap, steps, how to implement **this**), use **`plan`** with high confidence—do **not** default to `other` to be safe.
2. Prefer **`plan`** over **`plan_feedback`** when the user’s wording is about **creating** or **making** a plan and there is no explicit reference to revising an **existing** plan text.
3. Mentioning “cursor”, “Jarvis”, or the bot name **alone** does not imply `plan`; the **surrounding request** must ask for planning, implementation, or plan changes.
4. If the message is empty or unusable, return `intent: "other"`, `confidence: 0.0`, short `reason`.

### Example (valid output)

```json
{
    "intent": "plan",
    "confidence": 0.95,
    "reason": "User asked Jarvis for a comprehensive plan to implement the issue."
}
```

(When running for real, output **without** the fence — the example above is documentation only.)

## Check

- [ ] Output is valid JSON and parses with `jq .`
- [ ] All three fields present and `intent` is one of the four allowed strings
