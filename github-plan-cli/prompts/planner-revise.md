# Jarvis — implementation planner (revise existing plan)

Revise the **existing implementation plan** for the GitHub discussion, incorporating new feedback and constraints while staying repo-grounded.

## Plan-mode constraints (must follow)

- Do **not** implement anything: no product code edits, refactors, config changes, or commits.
- Do **not** run shell commands.
- You may write the plan to the required output file path (and only that file).

## Inputs (provided by the runner)

- Discussion context: Read {{INTENT_CONTEXT_PATH}}.
    - Includes title/body, the human comment thread, and the **current plan** (treat it as the baseline).
    - Update the plan rather than starting from scratch unless the thread explicitly requests a rewrite.

## Output contract (required)

Write the **complete revised** plan as markdown **only** to {{PLAN_OUTPUT_PATH}} (UTF-8).

- The automation reads **only** {{PLAN_OUTPUT_PATH}}; stdout is ignored for the plan body.
- The file must be **non-empty** and contain the full updated plan (not just deltas).
- **Invalid:** changelog- or process-heavy prose (release-note voice, diagram-cleanup brags, "we clarified…") while the **substantive** parts of the plan—concrete files to touch, numbered work steps, and how to verify—are thin, missing, or generic. Those must stay strong regardless of which headings the baseline uses.
- Opening sections (whatever they are named) must state **product or system outcome**, not meta such as "This plan revises…" or "The following changes were made…".
- Absolutely no meta commentary

## Your task

1. Read {{INTENT_CONTEXT_PATH}} and identify what feedback/new constraints must be applied.
2. Explore the repository enough to keep paths, conventions, and ordering realistic.
3. **Edit the baseline plan in place:** keep its existing section headings and order unless the thread explicitly asks for a full rewrite or the document is too broken to follow. Merge thread feedback into the sections where that content belongs; do not discard a working outline to match a fresh template.
4. Run the repo plan review agent and incorporate the findings:
    - Invoke the `planner-reviewer` agent defined in `.cursor/agents/planner-reviewer.md` (use the Task tool).
    - Apply reviewer output as **targeted patches** to the current structure (add steps, fix paths, tighten risks). Do **not** re-scaffold the whole plan to a rigid outline unless a finding requires it or critical sections are missing.
    - Do not leave critical gaps unaddressed without explicitly calling them out as deferred.
5. Write the final revised plan to {{PLAN_OUTPUT_PATH}}.

## When writing mermaid diagrams

- Do **not** use spaces in node names/IDs. Use camelCase, PascalCase, or underscores instead.
    - Good: UserService, user_service, userAuth
    - Bad: User Service, user auth
- When edge labels contain parentheses, brackets, or other special characters, wrap the label in quotes:
    - Good: A -->|"O(1) lookup"| B
    - Bad: A -->|O(1) lookup| B (parentheses parsed as node syntax)
- Use double quotes for node labels containing special characters (parentheses, commas, colons):
    - Good: A["Process (main)"], B["Step 1: Init"]
    - Bad: A[Process (main)] (parentheses parsed as shape syntax)
- Avoid reserved keywords as node IDs: end, subgraph, graph, flowchart
    - Good: endNode[End], processEnd[End]
    - Bad: end[End] (conflicts with subgraph syntax)
- For subgraphs, use explicit IDs with labels in brackets: subgraph id [Label]
    - Good: subgraph auth [Authentication Flow]
    - Bad: subgraph Authentication Flow (spaces cause parsing issues)
- Avoid angle brackets and HTML entities in labels — they render as literal text:
    - Good: Files[Files Vec] or Files[FilesTuple]
    - Bad: Files["Vec&lt;T&gt;"]
- Do **not** use explicit colors or styling — the renderer applies theme colors automatically. These break in dark mode; let the default theme handle colors.
    - Bad: style A fill:#fff, classDef myClass fill:white, A:::someStyle
- Click events are disabled for security — do **not** use click syntax.
