---
description: Prefer fixing root causes over silent hacks, fallbacks, and symptom patches
alwaysApply: true
---

# Root cause over workarounds

When something is wrong in the environment, data, repo layout, CI, or configuration, **fix that thing**—or surface it clearly—not a **local hack** in application code that hides it.

## What to avoid

- **Silent alternates**: extra branches, default values, or secondary code paths that mask missing prerequisites (files, prompts, secrets, services, schema) instead of failing or fixing upstream.
- **Swallowed errors**: broad `catch`, empty handlers, or vague logging that lets execution continue in an undefined or misleading state.
- **Encoding deployment/repo problems in product code**: “if file X missing, use Y” when X is supposed to be versioned; “if CI env weird, guess cwd” instead of a correct, documented contract.
- **One-off special cases** that only exist to avoid touching the real owner (workflow, migration, `.gitattributes`, docs, the other module): they rot and multiply.

## What to do instead

- **Make invalid states impossible or loud**: clear errors, typed failures, assertions on invariants, CI checks that prove artifacts exist.
- **Fix the owner**: add the file, fix the workflow, correct path resolution if broken, document required setup, add a migration—whatever actually owns the problem.
- **Genuine optionality** is fine when the **product** defines it (documented optional integration, feature flag, graceful degradation with explicit UX). That is a designed contract, not a hidden recovery path.

If a short-term bridge is unavoidable, it must be **explicit** (obvious in code, logged, tracked to remove)—not indistinguishable from the real design.
