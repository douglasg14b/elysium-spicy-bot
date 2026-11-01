# Member names — who an id was, even after they left

> **Status**: Step 1 built 2026-10-30; step 2 (avatars) built 2026-10-31, uncommitted, including the refresh of departed rows (`avatar_checked_at`, `users.fetch`, once per row per process) and the 1 MiB download cap. Each step's migration and repo checked on a throwaway Postgres 16 — step 2's refresh selection, checked-at writes and a refresh through `resolveMemberNames` too (neither down migration was); neither run on a live guild.
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

---

## Step 2 — avatars (planned 2026-10-31)

Step 1 is merged into `feat/web-ui-flow-engine` (`c563ab8`).

### The problem

The leaderboard shows each member's avatar from a live Discord CDN link (`cardAvatarUrlFromUser(user, 128)`, `fetchMemberSnapshots.ts`). Someone who has left comes back `member: null`, so the page has no picture for them, and a saved link can stop working anyway once they change their avatar.

### Decisions (2026-10-31)

| Question | Answer |
|---|---|
| How avatars are kept | The picture itself, not a link, so it never breaks |
| What "cache" means | Whatever the bot reads from Discord refreshes it. Once a person can no longer be read (they left), what we hold is kept for good |

Choices made in the plan, not asked:

- **The account avatar, not a server avatar.** It is what the leaderboard shows today. So it is one picture per person, stored once and shared by every server that has a `member_names` row for them.
- **Only the current picture is kept.** A new avatar replaces the old one. Someone who left keeps the last one we saw, because nothing tells us about their changes after that.
- **No avatar set** (Discord's default) stores nothing, and the dashboard shows what it shows today.
- **Downloads never hold up a write.** The name write happens first. Downloading the picture is queued in the background, a few at a time across the bot, and only when the avatar changed or we hold none. The first startup sweep therefore fetches every member's picture once. Later sweeps fetch only changed ones.

### Data

- New migration `2026-10-31-Member_Avatars.ts` (step 1's migration has shipped to the deploy branch, so do not edit it):
  - `member_names.avatar_hash`: text, nullable. The hash Discord last reported.
  - `member_names.avatar_checked_at`: timestamptz / text, nullable. When that hash was read; null means never.
  - New table `member_avatars`: `user_id` unique, `avatar_hash`, `content_type`, `bytes` (`bytea` / `blob`, as `guild_uploads` does), `fetched_at`.
- The type is sniffed from the bytes, reusing the uploads sniffer.
- Download at 128 px, static (an animated avatar is stored as its still frame).

### Keeping it current

- Every place step 1 records a person (sweep, member add and update, `UserUpdate`, the route's lookups through the member cache or `users.fetch`) also records `avatar_hash`. When the hash differs from `member_avatars`, it queues a download.
- A failed download is logged and retried the next time that person is seen. It is never retried in a loop.
- **Somebody who has left is pulled, since nothing else sees them again** (added 2026-10-31; Douglas's rule: "pull refreshes the cache; once it can't be pulled, keep it for good"). `member_names.avatar_checked_at` records when `avatar_hash` was last read from Discord; null means never, which tells "never checked" (every row from before this step) from "no avatar". The names route refreshes a departed row through `users.fetch` when it was never checked, or names an avatar whose picture is not held: it takes their current names and hash and queues the picture. A deleted account (10013) is marked checked with no avatar, its names kept. Refreshes share the 25-a-request lookup cap, ids nobody has seen first, and each departed row is refreshed at most once per process — a restart is the retry, so a failing download is never asked about on every load, and since the refresh reads the current hash, a stale CDN hash is not fetched again. **The answer that refreshes somebody may come without their picture**; a later load has it.
- Downloads are capped at 1 MiB: one declaring more is refused unread, and what arrives is measured again before it is sniffed.

### Reading

- `MemberName` gains `avatarUrl`: `/api/guilds/{guildId}/member-names/{userId}/avatar?v=<hash>`, or null when nothing is stored.
- A new route serves those bytes only when that guild has a `member_names` row for the user, so another server cannot read them. The cache header is `private, max-age=31536000, immutable`, as uploads use; the `v` changes with the picture.
- The route only reads the database, so it sits in the general rate-limit budget. Add it to the classification test.
- The dashboard shows it with `<img src>` (as `uploadImageUrl.ts` does), with a path test holding the URL to the spec.

### Dashboard

The leaderboard and member page use the cached avatar for a `member: null` row (someone who left), beside the cached name. Current members keep the live link.

### Tests

- Repo: store, replace on a new hash, keep for a leaver.
- The download queue: only on a change, failure logged with no loop.
- Route: the bytes served, another guild refused (404), the cache header.
- Leveling: a leaver shows the cached picture.
- Refresh: a departed row never checked is refreshed and its picture kept; one whose download failed is refreshed once a process; 10013 marks it checked; unseen ids take the cap first.

---

## What comes next

- **Seed from saved names** — warnings, tickets, birthdays and audit logs already hold names for people who have left; copy them into the cache (needs a Postgres run).
- **Tickets, flow drafts, uploads** read the cache too.
- **Warnings search** matches cached names.
- **Discord cards** (`/warnings`' "Left server (xxxx)", the rankings card's `Member 1234`) read the cache.
- **Telling a stranger from a leaver.** `in_server = false, left_at = null` means "not in the server, and the bot did not see them go", which covers both somebody missing from a startup sweep (a member who left while the bot was down) **and** an account only ever looked up by id, who may never have been a member. Any step that shows "left" must tell the two apart first (for example by recording whether a row was ever seen as a member), not read `in_server = false` as "left".
