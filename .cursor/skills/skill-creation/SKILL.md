---
name: skill-creation
description: >
  Use when creating, editing, migrating, or validating an Agent Skill (SKILL.md).
  Handles open-spec frontmatter, progressive disclosure, and procedural skill bodies.
  Do NOT use for general coding, MCP-only setup, or AGENTS.md unless the user wants a new skill.
---

# Skill creation (open `SKILL.md` spec)

Follow this procedure when creating or refactoring an Agent Skill. A skill is **procedural knowledge** (how the team does a task), not a README and not a substitute for live tool connectivity (see MCP vs skills below).

## Critical rules

1. **`name` must match the parent directory** (e.g. `skill-creation/` → `name: skill-creation`). Lowercase letters, digits, hyphens only; 1–64 characters. A mismatch can prevent loading on some platforms.
2. **`description` is a discovery trigger**, not the workflow. If the description already explains step-by-step *how* to do the task, the agent may skip loading the body (progressive disclosure failure).
3. **Body = executable procedure** (ordered steps, commands, verification). Avoid “about our stack” documentation unless it directly drives a step.

## Progressive disclosure (three phases)

| Phase | What loads | Cost model |
| ----- | ---------- | ----------- |
| 1 | Frontmatter `name` + `description` only | ~100 tokens per skill at session start |
| 2 | Full `SKILL.md` body | When the agent judges the skill relevant |
| 3 | Linked files under `scripts/`, `references/`, `assets/` | Only when a step points the agent at them |

Design implication: put **short** essentials in the body; move long reference material to `references/` and cite by relative path (keep nesting shallow—prefer one level under the skill root).

## Frontmatter (portable fields)

**Required (all platforms):**

- `name` — matches directory; see Critical rules.
- `description` — 1–1024 characters; third person; trigger-oriented.

**Optional (portable):**

- `license` — short standard name or pointer to bundled license file.
- `compatibility` — only if the skill has real environment constraints beyond “has an agent + filesystem”.

**Limited support (use only when the target product documents it):**

- `allowed-tools` — read-only or restricted tool sets (e.g. Claude Code; often ignored elsewhere).

**Convention-only (catalogs/tooling; agents typically ignore):** `tags`, `triggers`, `metadata`.

## Writing `description` (activation without procedure leak)

**Intent:** Tell the agent **when** to activate and **what class of capabilities** exist, without spelling the full workflow.

**Do:**

- Use **third person** declarative voice (“Use when…”, “Handles…”).
- Include **concrete keywords** users actually type (product names, file extensions, CLI tools), plus **synonyms** where phrasing varies.
- Add **negative triggers** if the skill is being pulled into adjacent tasks (“Do NOT use for …”).

**Do not:**

- Paste the checklist or multi-pass workflow into `description`.
- Use first/second person (“I can…”, “You should…”).

**Quick self-test:** Ask the agent (in a fresh session): “When would you use the `<name>` skill?” Adjust `description` until the answer matches the intended scope.

## Recommended directory layout

```text
<skill-name>/
  SKILL.md
  scripts/        # optional; invoke or read only when a step requires it
  references/     # optional; long policy / style / API notes
  assets/         # optional; templates, snippets, fixtures
```

In the body, reference supporting files with **relative paths** from the skill root (e.g. `references/style.md`).

## Authoring workflow

### 1. Define success before writing

- **Problem-first:** user outcome (“ship migration safely”) → procedure coordinates tools and checks.
- **Tool-first:** connection exists (e.g. Jira MCP) → procedure encodes *team conventions* for using it.

Pick one primary category to shape structure: **document/asset creation**, **workflow automation**, or **MCP enhancement** (procedural layer on top of tools).

### 2. Choose storage location

- **Project:** `.cursor/skills/<name>/` (Cursor), `.github/skills/<name>/` (VS Code / Copilot), `.claude/skills/<name>/`, `.agents/skills/<name>/` (Codex / cross-platform), etc. Prefer **project** for team-shared procedures.
- **Personal:** user-level skills directories for non-repo-specific habits.
- Precedence (typical): project overrides personal overrides extension-bundled skills.

### 3. Draft frontmatter

- Set `name` to the directory name.
- Write `description` using the rules above; stay under ~1 KB; aim for 2–4 tight sentences.

### 4. Write the body as a procedure

Start with a **Workflow** section: numbered steps, explicit **verification** after fragile steps (build, test, lint, dry-run). Add **Rules** for global constraints (safety, naming, “never without confirmation”).

Use **conditional branches** where behavior diverges (public API change vs internal refactor; destructive DB ops vs additive).

Prefer **one default** tool/library per task; add escape hatches only when needed.

### 5. Split heavy content

If the body would exceed ~500 lines or bury critical steps: move depth to `references/` and keep “Critical” / “Workflow” at the top of `SKILL.md`.

### 6. Validate and test

- When available, run frontmatter validation (e.g. community tooling such as `skills-ref validate` on `SKILL.md`).
- **Triggering tests:** 10–20 prompts that should / should not activate; tune keywords and negative triggers.
- **Functional tests:** same task 3–5 runs; fix ambiguous branches or missing verification.
- **Worth-it check:** compare token use and outcome quality vs a one-off prompt; drop or merge skills that rarely help.

## Anti-patterns (from production failures)

- **Workflow summary in `description`** → body never loaded; shallow behavior.
- **README-style body** → no actionable ordering; agent improvises.
- **Monolithic mega-skill** → broad triggers, high token cost; split by task.
- **Critical rules only in the middle** → missed; elevate non-negotiables to a top **Critical** section or a script.
- **External fetch / clone as a prerequisite** → fragile; vendor what you can under the skill.
- **Bare command lists** → no failure handling or verification; add gates.

## Skills vs adjacent mechanisms

| Mechanism | Role |
| --------- | ---- |
| User / project rules | Always-on baseline preferences |
| `AGENTS.md` | What the project *is* (architecture, layout, stack) |
| Skills | On-demand *how* for a specific workflow |
| MCP servers | Live **access** to external systems (APIs, DBs, tickets) |
| Prompt / slash commands | Often user-invoked templates |

**MCP is not replaced by skills:** MCP supplies connectivity and auth’d side effects; skills teach *disciplined use* and team procedure. Prefer **both** when integrating external systems.

## Token budget guidance

- **`description`:** paid on every session for every installed skill—keep it lean.
- **Body:** keep frequently activated skills shorter; large bodies cost every activation.
- **Supporting files:** loaded only when referenced—prefer this over giant inline appendices.

## Optional quality checklist

- [ ] `name` matches directory; characters comply with spec.
- [ ] `description` triggers without leaking the full procedure; third person; concrete keywords; negative triggers if needed.
- [ ] Body is procedural with verification steps and clear branching.
- [ ] Long material moved to `references/` (or `assets/`); links are shallow.
- [ ] Tested for under- and over-triggering; outputs stable across repeats.
