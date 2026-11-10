---
description: Never open .env.local; load it into a process with dotenvx instead
alwaysApply: true
---

# Never open `.env.local`

`.env.local` at the repo root holds real secrets (Discord token, `OPENROUTER_API_KEY`, database credentials). Agents **never** read, print, search, copy, diff, or otherwise open it — with any tool.

## Forbidden

- `Read`, `Edit`, `Write` on `.env.local` (or any `.env*` other than a committed example).
- Shell that exposes contents: `cat`, `head`, `tail`, `less`, `grep`/`rg` over it, `sed`, `awk`, `source .env.local && echo …`, `printenv`/`env` after loading it, `dotenvx get`, `git diff`/`git show` of it.
- Logging, echoing, or asserting a secret's value in code, tests, or output.

## Allowed

- **Loading it into a process without seeing it**, which is how it is meant to be used:
  `pnpm exec dotenvx run --env-file=.env.local -- <command>` (as `pnpm dev`, `migrate:latest:dev` and the `test:*-live` scripts already do).
- Checking it exists: `test -e .env.local`.
- Telling the user which variable name a command needs, so they add it themselves.

If a command fails because a variable is missing or wrong, say which **name** is missing and ask the user to fix it — do not open the file to check.
