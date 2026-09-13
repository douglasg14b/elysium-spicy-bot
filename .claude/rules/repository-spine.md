---
description: Minimal always-on context — where to look before structural or cross-cutting work
alwaysApply: true
---

# Repository spine

- Skim **root `AGENTS.md`** before changing layout, features, persistence, or bootstrap flow.
- **Dependencies**: add with `pnpm` only — see `.cursor/rules/package-json-deps.mdc` (no hand-edited versions in `package.json`).
- **Env**: new variables go through `src/environment.ts` (`env-var`); never commit `.env*` or paste tokens/secrets into code, chats, or logs.
- **Tests**: colocate under `__tests__` — `.cursor/rules/test-placement.mdc`.
- **User-facing tone**: adults-only / NSFW-appropriate bot persona — `.cursor/rules/product-persona-and-audience.mdc` (do not sanitize copy in reviews or implementation).
- This file is intentionally thin; domain rules live in scoped `.mdc` files and attach via globs.
