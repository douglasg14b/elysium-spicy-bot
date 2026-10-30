# Member names — who an id was, even after they left

> **Status**: Step 1 built 2026-10-30. Migration and repo checked on a throwaway Postgres 16 (the down migration was not); not yet run on a live guild.
> **Owner**: Douglas
> **Written**: 2026-10-30 on `feat/member-names` (worktree `.claude/worktrees/member-names`) off `feat/web-ui-flow-engine` @ `611445b`

## The problem

The dashboard shows snowflakes where it should show people.

- **Warnings** read names only from the row's own snapshot columns (`warningView`, `src/web/api/warningRoutes.ts`), added 2026-10-29 with no backfill. Every older row — member, issuer, releaser — shows a raw id, and the page never looks anyone up.
- **The leaderboard** resolves members live (`fetchMemberSnapshotsById`); anyone who has left comes back `member: null` and shows as an id (`web/src/leveling/levelingMember.ts`).
- **Nothing remembers anyone.** Each feature snapshots a name at the moment it writes (warnings, tickets, birthdays, drafts, audit logs). There is no one place that knows who an id is, and nothing at all records a server nickname once a member leaves.

## What "done" means

| Done when |
|---|
| The bot keeps one record per member per server — their Discord username, global display name, current server nickname, every server nickname it has seen them use, and whether (and when) they left. The dashboard asks it for names by id. The warnings page and the leveling leaderboard show the name a person goes by **now** wherever they show an id, including people who left before the bot started remembering — their Discord name, at least. |

## Decisions (2026-10-30)

| Question | Answer |
|---|---|
| Which name wins | The name they go by now. The cache is its own thing, not part of warnings: the dashboard fills in any id it shows by asking it. |
| What the list keeps | Server nicknames only; the current Discord name has its own columns |
| Leavers | Record that they left, and when, if we saw it happen |
| Names already saved elsewhere | Later, as its own step |
| First pages | Warnings and the leveling leaderboard |

Choices made in the plan, not asked:

- **Ids nobody has seen are looked up from Discord when asked.** The startup sweep only finds current members. For anyone else the endpoint asks Discord for the account (`client.users.fetch`), which answers for any user — member or not — with username and global name, never a server nickname. What it learns is written to the cache, so each person is looked up once. At most 25 lookups per request; the rest come back unknown and fill in on the next load.
- **Bots are kept.** The bot itself is the actor of every flow block's ticket change.
- **Unlisted servers are skipped** (`isGuildAllowed`), as the dashboard skips them.
- **"Left" when we did not see it**: a member missing from a startup sweep, or someone only ever looked up, is marked as not in the server with no date. `left_at` is set only by a `GuildMemberRemove` the bot saw.
- **Search is unchanged.** Warnings search still matches the row snapshots; feeding it from the cache comes with the seeding step.

---

## 1. Data

New table `member_names`, migration `2026-10-30-Create_Member_Names.ts`, both dialect arms written out.

| Column | Type (pg / sqlite) | Notes |
|---|---|---|
| `id` | serial / integer autoincrement | |
| `guild_id`, `user_id` | text | unique index `member_names_guild_user_unique_idx` |
| `username` | text not null | Discord handle |
| `global_name` | text null | Discord display name |
| `nickname` | text null | current server nickname; null when none |
| `nicknames` | jsonb `'[]'` / text `'[]'` | every server nickname seen, distinct, most recent first, at most 25 |
| `is_bot` | boolean | |
| `in_server` | boolean | |
| `left_at` | timestamptz / text null | only when a leave was seen |
| `first_seen_at`, `updated_at` | timestamptz / text | |

Registered in `database.ts`: the `Database` interface, `SqlDatePlugin` (dates), `SqliteJsonPlugin` (`nicknames`), `SqliteBindingPlugin` (booleans).

Repo `src/features-system/member-names/data/memberNamesRepo.ts`. Merging a nickname into the list is done in JS (read, merge, write), never with a dialect's JSON operators. A pure `mergeNicknames(list, nickname)` holds the rule.

## 2. Keeping it current — `src/features-system/member-names/`

`initMemberNames()`, called from `bot.ts`. A features-system module: imports no feature.

| Event | Write |
|---|---|
| `ClientReady` | per allowed guild, in the background, one guild at a time: `guild.members.fetch()`, upsert everyone in batches; anyone recorded as in the server but not in the fetch → `in_server = false` |
| `GuildMemberAdd` | upsert, `in_server = true`, `left_at = null` |
| `GuildMemberUpdate` | upsert from `newMember` only (the old one may be partial) |
| `GuildMemberRemove` | `in_server = false`, `left_at = now` (the member may be partial — update by id, keep stored names) |
| `UserUpdate` | `username`, `global_name`, `is_bot` on every row for that user id |

Writes for one guild go through one in-process queue, so the sweep and live events cannot interleave a read-merge-write.

## 3. Asking for names — `GET /api/guilds/{guildId}/member-names?ids=…`

`apiRouter` in `src/web/api/memberNameRoutes.ts`, wire schemas in `memberNameBody.ts`.

- Query `ids`: comma-separated snowflakes, 1–100.
- Answers `{ members: MemberName[] }`, one entry per id it knows. `MemberName = { userId, username, globalName, nickname, nicknames, isBot, inServer, leftAt }`.
- Misses are looked up through `client.users.fetch` (≤ 25 per request), written to the cache (`in_server = false`, unless the guild's member cache holds them), and answered. An id Discord does not know is left out.
- Rate-limit: listed in `DISCORD_READS` — it can call Discord.
- `pnpm sdk:generate` after.

## 4. The dashboard

- `web/src/members/`: `useMemberNames(guildId, ids)` — one query for the ids a view shows — and `memberNameLabel(name)`: nickname, else global name, else username.
- **Warnings**: every person shown (list, drawer, release and edit dialogs, the "Only …" chip) is the cache's label, else the row's snapshot, else the id.
- **Leveling** leaderboard and user page: a `member: null` row (left) shows the cache's label instead of the id.

## 5. Tests

Repo against sqlite (merge, upsert, mark-left, user update across guilds); the sweep and listeners with the TestDiscord harness; the route (hits, misses looked up and stored, unknown left out, cap); `rateLimitClassification`; the web label and the warnings list showing a cached name over a snapshot.

## What comes next

- **Seed from saved names** — warnings, tickets, birthdays and audit logs already hold names for people who have left; copy them into the cache (needs a Postgres run).
- **Tickets, flow drafts, uploads** read the cache too.
- **Warnings search** matches cached names.
- **Discord cards** (`/warnings`' "Left server (xxxx)", the rankings card's `Member 1234`) read the cache.
- **Telling a stranger from a leaver.** `in_server = false, left_at = null` means "not in the server, and the bot did not see them go", which covers both somebody missing from a startup sweep (a member who left while the bot was down) **and** an account only ever looked up by id, who may never have been a member. Any step that shows "left" must tell the two apart first (for example by recording whether a row was ever seen as a member), not read `in_server = false` as "left".
