
# Implementation plan: Birthday announcements (issue #8)

## Goals

- Periodically detect guild members whose stored birthday should be **celebrated today**, using the same **local process timezone** semantics as today’s `BirthdayRepository.getTodaysBirthdays()` (`now.getMonth() + 1` / `now.getDate()`), **extended for leap-year observation** (see below).
- Post a **public** announcement in a **configured guild channel** that **mentions** the user and includes **AI-generated “bratty bot” copy**, reusing the same voice stack as `AIService` (BrattyBot system prompt + chat completions pattern in `aiService.ts`).
- **Never announce the same `(guildId, userId)` twice for the same calendar celebration day** (persist last-announce metadata on the birthday row; compare using the **same “celebration date”** logic as eligibility, including Feb 29 -> Feb 28 in common years).
- Provide a guild-level configuration path for announcement channel via slash command argument, persisted in DB, with clear user/admin warning when birthday flows are used before channel config exists.
- Avoid **duplicate schedulers** (single interval / single service instance for the process).
- Work **without** external cron: use an in-process timer started after the Discord client is ready (same lifecycle idea as `initFlashChat()` in `Events.ClientReady` in `src/bot.ts`).

## Non-goals (defer unless product asks)

- Per-guild timezone overrides (see “Time / today” below).
- Full agent graph (`runWorkflow` in `newAiReplyStuff.ts`) for birthdays—only add if you explicitly want the same multi-agent guardrail pipeline as mention/reply flows.
- Multi-channel rotation or per-role/per-user targeting for birthday announcements.

## Design decisions

### Scheduler: `setInterval` vs message-throttled tick

- Prefer **`setInterval`** (e.g. every 5-10 minutes) registered **once** from `Events.ClientReady`, behind a module-level guard (`intervalId` or `started` flag) so reloads / accidental double-init do not stack timers.
- Message-driven throttling is optional later; interval is simpler and matches the issue’s “ensure we cannot run multiple intervals” requirement.

### Leap years (feedback from discussion — explicit product rule)

- Storage remains **month + day** (Feb 29 is already allowed in `validateDate()` via 29 days for February in `src/features/birthday-tracker/utils.ts`).
- **Observed celebration day** (when we consider someone “due” for an announcement):
  - **Non-leap day birthdays:** unchanged—announce when local calendar month/day equals stored `month`/`day`.
  - **February 29:** follow the usual leapling convention: in a **non-leap year**, treat the celebration date as **February 28** (not March 1). In a **leap year**, celebrate on **February 29**.
- Implement this in **one shared helper** (e.g. `isBirthdayCelebratedToday(month, day, now: Date): boolean` or `getCelebrationMonthDayForToday(now)` + match) used by:
  - the repository / due-for-announcement query layer, and
  - dedup comparisons against `lastAnnouncedAt` (so a Feb 29 user is not announced twice across Feb 28 vs Mar 1).
- Document the rule briefly in `birthday-tracker/readme.md` and in a short code comment on the helper.

### “Today” definition / timezones

- **Baseline:** “today” and leap/non-leap logic use **`Date` in the Node process timezone** (consistent with current `getTodaysBirthdays()`). Document for operators that **celebration day follows server TZ**.
- Optional follow-up: `Intl` / per-guild TZ column—out of scope for first ship unless required.

### Birthday announcement channel configuration command

- Add an admin slash command in birthday-tracker (recommended shape: `/birthday-config channel:<channel>`).
- Restrict usage with `ManageGuild` permissions and guild-only guard.
- Validate the selected channel is text-based and the bot has `ViewChannel` + `SendMessages`.
- Persist `announcementChannelId` by guild via birthday config repo upsert.
- Respond ephemerally with explicit success/failure copy.

### Where to send announcements

- Source of truth is persisted guild config (`birthday_config.announcement_channel_id`).
- Resolver (e.g. `resolveBirthdayAnnouncementChannel(client, guildId)`) loads config, resolves channel from guild cache/API, and re-validates bot permissions before send.
- If config is missing or invalid (deleted channel, missing perms), log at `warn`, skip that guild, and do not mark birthdays announced.
- Do not fallback to `Guild.systemChannel` or `BOT_CONFIG.channelsToMonitor` for birthday announcements.

### AI integration

- **Do not** fake a `MessageCreate` event.
- Add a dedicated method on `AIService` (e.g. `generateBirthdayAnnouncement({ displayName, username })`) that:
  - Reuses **`BRATTY_BOT_SYSTEM_PROMPT`** (and optionally a short slice of `FEW_SHOT_EXAMPLES` or 1-2 birthday-specific few-shots) from `aiService.ts`.
  - Uses the same `openai.chat.completions.create` shape as `generateReply` (model `AI_MODEL`, similar `max_completion_tokens`).
  - Uses a **tight user prompt**: one short birthday shout-out for a member; **no** deep personalization beyond display name; length cap (e.g. <= 35-80 words) aligned with existing tone rules.
- **Safety:** Optionally run the generated string through existing Discord sanitization. **Refactor:** extract `validateAndCleanReply` (or rename to neutral `sanitizeBotOutboundText`) from `aiReplyHandler.ts` into a shared module under `ai-reply` and import it from the birthday announcer so `@everyone` / `@here` zero-width fixes and length limits stay consistent.
- **Moderation:** First version can rely on system prompt + short output; if stakeholders want parity with user-facing AI paths, add a thin call to `runAndApplyGuardrails` **on the fixed birthday prompt string** only when needed.

## Data model

1. **Migration** (new file under `src/features-system/data-persistence/migrations/`, both sqlite + postgres branches like `2026-01-06-Create_Birthday_Table.ts`):
   - Add nullable **`last_announced_at`** (`timestamptz` / sqlite `text` ISO) on `birthdays`.
2. **`BirthdayTable`** in `birthdaySchema.ts`: `lastAnnouncedAt: Date | null` (use `ColumnType` consistent with other timestamps).
3. **`database.ts`**: extend `SqlDatePlugin` entry for `birthdays` to include `lastAnnouncedAt`.
4. **Birthday config table** (new migration + new schema file, recommended `birthdayConfigSchema.ts`):
   - Table: `birthday_config` keyed by `guild_id` (unique).
   - Columns: `guild_id`, `announcement_channel_id`, `created_at`, `updated_at`, `config_version`.
   - Register table on `Database` interface in `src/features-system/data-persistence/database.ts`.
   - Register `createdAt` and `updatedAt` in `SqlDatePlugin`.

## Repository API

In `birthdayRepo.ts`:

- **`findDueForAnnouncementToday()`** (name flexible): return rows whose stored `(month, day)` matches **today’s celebration calendar** per the **leap-year helper** (not only raw SQL `month = ? AND day = ?` if that misses Feb 29 on Feb 28 in common years). Practical approaches:
  - **Query broader set + filter in app:** select candidates where `(month, day)` equals local today’s `(m,d)` **or** `(month, day) = (2, 29)` when local today is Feb 28 in a non-leap year, then apply shared helper; or
  - **Pure in-app filter** after a conservative query—keep performance acceptable for table size.
- **Dedup:** include row only if `lastAnnouncedAt` is null **or** local calendar date of `lastAnnouncedAt` is not equal to today’s celebration date key (e.g. `YYYY-MM-DD` in local time).
- **`markAnnounced(guildId, userId, at = new Date())`**: sets `lastAnnouncedAt` and `updatedAt`.
- Ensure **upsert** paths in `upsert()` do not wipe `lastAnnouncedAt` unless intentional (month/day-change reset handled by explicit rule below).
- Align `getTodaysBirthdays()` with the same celebration helper (preferred) to avoid Feb 29 inconsistencies between listing and announcer behavior.

In new `birthdayConfigRepo.ts`:

- **`getByGuildId(guildId)`**: returns config row or null.
- **`upsertAnnouncementChannel(guildId, announcementChannelId)`**: creates/updates config with `updatedAt`.
- Optional helper: **`isConfigured(guildId)`** for command/service branching.

## Service layer (`birthday-tracker`)

Add something like `birthdayAnnouncementService.ts` (or `BirthdayAnnouncementScheduler.ts`) that:

1. Exposes **`startBirthdayAnnouncementScheduler(client: Client): void`** — idempotent.
2. On each tick:
   - If `client.user` missing, return.
   - `const due = await birthdayRepository.findDueForAnnouncementToday()` (or equivalent).
   - Group by `guildId` (optional batching).
   - For each row:
     - Resolve configured channel via `birthdayConfigRepo`; if missing/invalid, skip guild row and log warning.
     - **Fetch member** (`guild.members.fetch(userId)`); on failure, still announce using mention string `<@userId>`.
     - `const text = await aiService.generateBirthdayAnnouncement(...)` then sanitize.
     - Send message: content shape like `${mention}\n${text}` (plain text first iteration).
     - **`await birthdayRepository.markAnnounced(...)` only after successful send** (if send fails, log and do not mark, so later tick retries).
3. **Concurrency:** sequential `for` loop first to avoid OpenAI burst and simplify failure handling.
4. **Logging:** info per successful announce, warn on skip reasons (missing config, invalid channel, missing permissions).

Birthday command UX update:

- In `handleBirthdayCommand`, read guild birthday config before current set/view flow.
- If config missing, show an ephemeral warning message that birthday announcements are not configured and include admin action (`/birthday-config channel:<...>`).
- Continue with normal birthday create/view/update/delete interaction; warning is informative, not blocking.

## Wiring

- Add registration for birthday config slash command in `initBirthdayFeature.ts` via `interactionsRegistry.register(...)`.
- Keep birthday feature initialization before `registerCommandsWithDiscord(...)` in `src/bot.ts` so new command builder is included in global command registration.
- Add **`initBirthdayAnnouncements(client)`** (or fold into birthday init exports) called from **`DISCORD_CLIENT.once(Events.ClientReady, ...)`** in `bot.ts` **after** `flagBotReady()`.
- **Shutdown:** on `SIGINT`, `clearInterval` if stored on module—extend existing graceful shutdown block in `bot.ts`.

## Testing (`__tests__` colocated or feature tests)

- **Unit tests** for celebration-day + dedup helpers:
  - Feb 29 stored, Feb 28 non-leap year -> celebrated.
  - Feb 29 stored, Feb 29 leap year -> celebrated.
  - Feb 29 stored, Mar 1 non-leap year -> not celebrated.
  - Plain birthdays unchanged.
  - `lastAnnouncedAt` same local celebration date -> excluded.
- **Command tests:**
  - `/birthday-config` persists selected channel per guild.
  - Invalid/non-sendable channel is rejected with ephemeral error.
  - `/birthday` shows warning when config missing; does not show warning when configured.
- **Service tests:**
  - Guild with missing/invalid config is skipped; `markAnnounced` not called.
  - Successful send path marks announced exactly once.
- Optional: mock `AIService` to return fixed string and assert message shape.

## Files likely touched

| Area | Files |
|------|--------|
| Birthday schema/migration | `src/features/birthday-tracker/data/birthdaySchema.ts`, new migration for `last_announced_at` |
| Birthday config persistence | `src/features/birthday-tracker/data/birthdayConfigSchema.ts`, `src/features/birthday-tracker/data/birthdayConfigRepo.ts`, new migration for `birthday_config`, `src/features-system/data-persistence/database.ts` |
| Birthday data access | `src/features/birthday-tracker/data/birthdayRepo.ts` |
| Domain / leap logic | `src/features/birthday-tracker/utils.ts` or new `birthdayCelebration.ts` (shared helper + tests) |
| AI | `src/features/ai-reply/aiService.ts`, shared sanitize helper extracted from `aiReplyHandler.ts` |
| Commands / init | `src/features/birthday-tracker/commands/birthdayCommand.ts`, new `src/features/birthday-tracker/commands/birthdayConfigCommand.ts`, `src/features/birthday-tracker/initBirthdayFeature.ts`, `src/features/birthday-tracker/index.ts` |
| Birthday service | new `src/features/birthday-tracker/birthdayAnnouncementService.ts` (or equivalent) |
| Bootstrap | `src/bot.ts` (`ClientReady` + optional SIGINT `clearInterval`) |
| Docs | `src/features/birthday-tracker/readme.md` (TZ behavior, config requirement, leap rule) |

## Verification checklist

- `pnpm migrate:latest` / `:dev` applies cleanly on sqlite and postgres with both new migrations.
- `/birthday-config channel:<...>` stores config for guild and update path works.
- Running `/birthday` before config shows warning, while still allowing birthday CRUD flow.
- Running `/birthday` after config shows normal flow without config warning.
- Single running bot has only one announcement interval (log on scheduler start).
- User with birthday today gets **one** message; DB row shows updated `lastAnnouncedAt`; no repeat until next distinct celebration day.
- **Feb 29 user:** in a non-leap year, announcement fires on **Feb 28** once; does not fire on Mar 1; in leap year, fires on Feb 29.
- Missing permissions / deleted configured channel do not corrupt state (`markAnnounced` not written on failed send).

## Explicit product rules

### Birthday edits and `lastAnnouncedAt`

- In `upsert` / `update`, when **`month` or `day` changes**, set **`lastAnnouncedAt` to null** so announcements are not suppressed for corrected date.
- When only `displayName` / `username` / `year` changes, preserve `lastAnnouncedAt`.

### Leap-year observation (stakeholder direction)

- **February 29 birthdays:** in non-leap years, **observe on February 28**; in leap years, **on February 29**.
- Encode once and reuse for eligibility + dedup.

### Configuration and unconfigured behavior

- Source of truth for announcement destination is `birthday_config.announcement_channel_id` per guild.
- If config is absent:
  - `/birthday` shows an ephemeral warning with admin action (`/birthday-config channel:<...>`).
  - Scheduler skips announcements for that guild and logs warning.
- No automatic fallback destination for birthday announcements when config is missing.

---

Birthday announcements run automatically with persisted per-guild channel configuration, leap-year-correct celebration logic, one-send-per-day deduplication, and AI-generated bratty birthday copy delivered through the existing AI service path.
