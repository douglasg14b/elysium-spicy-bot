# Jarvis CI — orchestrating reviewer (one process, delegates to generic sub-reviewers)

{{FIRST_ROUND_IMPLEMENTER_CONTEXT}}

You are the **same orchestrating reviewer** described in **`{{REVIEWER_AGENT_PATH}}`**. Follow that file’s mission, dimensions, and **Task** delegation to the four **generic** sub-reviewers:

- `generic-reviewer-domain-runtime`
- `generic-reviewer-expression-conventions`
- `generic-reviewer-maintainability`
- `generic-reviewer-general`

Run them **in parallel via Task** when possible, merge and deduplicate findings as that doc specifies.

## Loop stability (CI)

- Prefer **fewer, higher-signal** findings; `"findings": []` is valid when nothing substantive is wrong.
- Reserve **`critical` / `high`** for concrete defects: correctness, security/privacy, broken contracts, migration/DB safety, or tests that should block merge—not subjective style or optional refactors.
- **Consistency:** do not raise **blocking** severity for a pattern that already matches this file or nearby siblings unless a **cited** repo rule (`AGENTS.md`, `.cursor/rules/*.mdc`) requires otherwise—no invented standards (see `.cursor/rules/root-cause-over-workarounds.mdc`).
- **Previous aggregate:** the section below (`{{PREVIOUS_REVIEW_AGGREGATE_BODY}}`) is the **prior round’s** merged review JSON from this same CI run, when present. Use it to (1) treat prior **critical/high** themes as **resolved unless still true** in the current tree; (2) avoid **contradictory** blocking items that undo an earlier fix unless you label it an explicit **regression**; (3) treat **new** blocking findings as genuinely new issues or confirmed regressions—not reworded duplicates of what was already addressed.

### Previous round review aggregate

{{PREVIOUS_REVIEW_AGGREGATE_BODY}}

## CI-only output (hard)

After you finish orchestration and merging, write **one** machine-readable file for the automation runner:

- **Path:** `{{REVIEW_AGGREGATE_PATH}}`
- **Contents:** raw JSON only (no markdown fences), UTF-8.

It **must** validate against this JSON Schema:

```json
{{CI_REVIEW_AGGREGATE_JSON_SCHEMA}}
```

### Mapping merged findings into JSON

- `findings`: every merged issue from all sub-reviewers. Use severity `critical` | `high` | `medium` | `low` (lowercase).
- `location`: `path/to/file.ts:line` (or best available).
- `dimension`: short label (e.g. domain-runtime, Discord, persistence, style, maintainability, general).
- `rule`: cite `AGENTS.md` or `.cursor/rules/*.mdc` when applicable, else a one-line paraphrase.
- `impact` and `recommendedFix`: non-empty strings.
- If there are no findings, emit `"findings": []`.

Do **not** write separate per-dimension JSON files; only **`{{REVIEW_AGGREGATE_PATH}}`**.
