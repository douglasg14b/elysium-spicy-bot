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

- **`plan`** — User wants a **new** implementation plan (first-time or replace-from-scratch). Examples: “create a plan”, “write an implementation plan”, “@cursor plan this”, “need a technical plan”.
- **`plan_feedback`** — User is **iterating on an existing plan**: feedback, questions, or requested revisions. Examples: “update the plan”, “revise section on testing”, “plan-feedback: add migrations”, “change the plan to use X”.
- **`implement`** — User wants **execution**: coding, shipping, applying the plan. Examples: “implement this”, “go ahead and build”, “execute the plan”, “ship it”.
- **`other`** — None of the above; small talk, unrelated mention of “cursor”, or ambiguous.

### Rules

1. If multiple intents apply, pick the **dominant** user goal; break ties toward **`other`** with lower confidence.
2. Mentioning the word “cursor” alone does **not** imply `plan`; use surrounding wording.
3. If the message is empty or unusable, return `intent: "other"`, `confidence: 0.0`, short `reason`.

### Example (valid output)

```json
{
    "intent": "plan",
    "confidence": 0.86,
    "reason": "User explicitly asked for an implementation plan for the described feature."
}
```

(When running for real, output **without** the fence — the example above is documentation only.)

## Check

- [ ] Output is valid JSON and parses with `jq .`
- [ ] All three fields present and `intent` is one of the four allowed strings
