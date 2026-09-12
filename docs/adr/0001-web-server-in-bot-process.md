# ADR 0001 — Web server runs in the same process as the bot

- **Status**: Accepted (2026-09-11)
- **Context**: Adding a web dashboard (Discord-OAuth login) + a flow engine to `discord-spicy-bot`.

## Decision

The HTTP server (Hono) that serves the web dashboard and its JSON API runs **inside the
existing bot process** (`src/bot.ts`), sharing the live `discord.js` client and the single
Kysely `database` instance directly — no IPC, no separate service.

The web server is **optional at runtime**: if the web-specific environment variables are not
set, the bot logs a notice and simply does not start the HTTP listener. Existing bot-only
deployments keep working with no new required config.

## Why

- **Avoids DB write contention.** The bot is a single long-lived process. With SQLite
  (`better-sqlite3`, the default `DB_TYPE`), multiple processes writing the same file is a
  known source of `SQLITE_BUSY`/locking pain. One process = one writer = no contention.
- **No IPC.** Flow actions (assign role, send message) and live config reloads need the
  discord.js client. In-process, the API handlers call the client and repos directly instead
  of marshalling commands to the bot over a queue/socket.
- **Simplest thing that works** for a single-tenant, few-admins deployment on Coolify (one
  container, one image, one healthcheck).

## Known reservation (why this feels off)

Co-locating an HTTP server with a gateway bot couples two concerns with different scaling and
failure profiles: a burst of web traffic, a slow request, or an unhandled error in an HTTP
handler can affect the bot's event loop, and vice-versa. This is a deliberate, accepted
trade-off for now, **not** an endorsement of the pattern at scale.

## Exit path (how we split later, if needed)

The design keeps the split cheap:

- **All DB access goes through repos** (`src/features/*/data/*Repo.ts`) — never raw queries in
  HTTP handlers. Repos are the only DB touchpoint, so a future separate web process swaps the
  data layer without touching handler logic.
- **Move to Postgres** (already supported via `DB_TYPE=postgres`) to remove the single-writer
  constraint, then run the web server as its own process/container against the same DB.
- **Live bot actions** (role assignment, sending messages) would then move behind a small
  message channel (e.g. a DB-backed job table the bot polls, or a lightweight queue) instead
  of a direct client call. That is the one piece that becomes non-trivial when splitting.

Until any of those pressures appear, in-process wins on simplicity and correctness.
