
# Implementation plan: Birthday announcements (issue #8)

## Goals

- Periodically detect guild members whose stored birthday is **today** (same semantics as existing `getTodaysBirthdays()`).
- Post a **public** announcement that **mentions** the user and includes **AI-generated “bratty bot” copy**, reusing the same voice stack as `AIService` (BrattyBot system prompt + chat completions pattern in `aiService.ts`).
- **Never announce the same `(guildId, userId)` twice for the same calendar day** (persist last-announce metadata on the birthday row).
- Avoid **duplicate schedulers** (single interval / single service instance for the process).
- Work **without** external cron: use an in-process timer started after the Discord client is ready (same lifecycle idea as `initFlashChat()` in `ClientReady`).

## Non-goals (defer unless product asks)

- Per-guild timezone overrides (see “Time / today” below).
- Full agent graph (`runWorkflow` in `newAiReplyStuff.ts`) for birthdays—only add if you explicitly want the same multi-agent guardrail pipeline as mention/reply flows.
- Admin UI to pick announcement channel (can be a follow-up).

## Design decisions

### Scheduler: `setInterval` vs message-throttled tick

- Prefer **`setInterval`** (e.g. every 5–10 minutes) registered **once** from `Events.ClientReady`, behind a module-level guard (`intervalId` or `started` flag) so reloads / accidental double-init do not stack timers.
- Message-driven throttling is optional later; interval is simpler and matches the issue’s “ensure we cannot run multiple intervals” requirement.

### “Today” definition / timezones

- Existing `BirthdayRepository.getTodaysBirthdays()` uses `new Date()` in the **Node process timezone**. Document that **“today” follows the server’s TZ**; note in code comment / feature readme for operators.
- Optional follow-up: `Intl` / per-guild TZ column—out of scope for first ship unless required.

### Where to send announcements

- Implement a small resolver (e.g. `resolveBirthdayAnnouncementChannel(client, guildId)` in `birthday-tracker`):
  1. **Preferred:** `Guild.systemChannel` if present and the bot has `SendMessages` (and `ViewChannel`).
  2. **Fallback:** any channel ID in `BOT_CONFIG.channelsToMonitor` that belongs to that guild and is text-based with send permission.
  3. If none: log at `warn`, skip that guild (no throw).
- If multi-guild behavior is insufficient, add **optional env** in `src/environment.ts` (e.g. `BIRTHDAY_ANNOUNCE_CHANNEL_ID` or a small map) as a later incremental change—call out in plan as optional hardening.

### AI integration

- **Do not** fake a `MessageCreate` event.
- Add a dedicated method on `AIService` (e.g. `generateBirthdayAnnouncement({ displayName, username })`) that:
  - Reuses **`BRATTY_BOT_SYSTEM_PROMPT`** (and optionally a short slice of `FEW_SHOT_EXAMPLES` or 1–2 birthday-specific few-shots) from `aiService.ts`.
  - Uses the same `openai.chat.completions.create` shape as `generateReply` (model `AI_MODEL`, similar `max_completion_tokens`).
  - Uses a **tight user prompt**: task = one short birthday shout-out for a member; **no** deep personalization beyond display name; length cap (e.g. ≤ 35–80 words) aligned with existing tone rules.
- **Safety:** Optionally run the generated string through existing Discord sanitization. **Refactor:** extract `validateAndCleanReply` (or rename to neutral `sanitizeBotOutboundText`) from `aiReplyHandler.ts` into a small shared module under `ai-reply` and import it from the birthday announcer so `@everyone` / `@here` zero-width fixes and length limits stay consistent.
- **Moderation:** First version can rely on system prompt + short output; if stakeholders want parity with user-facing AI paths, add a thin call to `runAndApplyGuardrails` **on the fixed birthday prompt string** only when needed (avoid threading synthetic content through the full on-topic agent graph unless tested).

## Data model

1. **Migration** (new file under `src/features-system/data-persistence/migrations/`, both sqlite + postgres branches like existing birthday migration):
   - Add nullable **`last_announced_at`** (`timestamptz` / sqlite `text` ISO) on `birthdays`.
2. **`BirthdayTable`** in `birthdaySchema.ts`: `lastAnnouncedAt: Date | null` (use `ColumnType` consistent with other timestamps).
3. **`database.ts`**: extend `SqlDatePlugin` entry for `birthdays` to include `lastAnnouncedAt` if the plugin lists explicit date columns (mirror `createdAt` / `updatedAt`).

## Repository API

In `birthdayRepo.ts`:

- **`findDueForAnnouncementToday()`** (name flexible): query rows where `month`/`day` match today **and** (`lastAnnouncedAt` is null **or** calendar date of `lastAnnouncedAt` ≠ today’s calendar date in the same TZ logic you use for “today”—simplest: compare **UTC date parts** or **local date string** `YYYY-MM-DD` consistently with `getTodaysBirthdays`).
  - Easiest robust approach: compute `todayKey = formatLocalDate(new Date())` and store either:
    - **Option A:** `lastAnnouncedAt` only—compare `toDateString` / local Y-M-D of `lastAnnouncedAt` vs `todayKey`, or  
    - **Option B:** add `lastAnnouncedOn` `text` `YYYY-MM-DD` for explicit dedup (clearer, one extra column). **Recommendation:** single `lastAnnouncedAt` timestamp + compare local date parts in application code to avoid duplicate columns.
- **`markAnnounced(guildId, userId, at = new Date())`**: sets `lastAnnouncedAt` and `updatedAt`.

Ensure **upsert** paths in `upsert()` do not wipe `lastAnnouncedAt` unless intentional (merge updates so existing `lastAnnouncedAt` is preserved when user edits month/day).

## Service layer (`birthday-tracker`)

Add something like `birthdayAnnouncementService.ts` (or `BirthdayAnnouncementScheduler.ts`) that:

1. Exposes **`startBirthdayAnnouncementScheduler(client: Client): void`** — idempotent.
2. On each tick:
   - If `client.user` missing, return.
   - `const due = await birthdayRepository.findDueForAnnouncementToday()` (or equivalent).
   - Group by `guildId` (optional batching).
   - For each row:
     - Resolve channel; skip if unresolved.
     - **Fetch member** (`guild.members.fetch(userId)`); on failure, still announce using stored `displayName` / mention string `<@userId>` (mention works even if not cached).
     - `const text = await aiService.generateBirthdayAnnouncement(...)` then sanitize.
     - Send message: content shape like `${mention}\n${text}` (or embed + content—keep first version plain text unless design wants embed).
     - **`await birthdayRepository.markAnnounced(...)` only after successful send** (if send fails, log and do not mark, so a later tick retries).
3. **Concurrency:** sequential `for` loop or small concurrency with cap to avoid OpenAI burst; start with **sequential** for simplicity.
4. **Logging:** info per successful announce, warn on skip reasons (no channel, missing permissions).

## Wiring

- Add **`initBirthdayAnnouncements(client)`** (or fold into `initBirthdayFeature` with a second export) called from **`DISCORD_CLIENT.once(Events.ClientReady, ...)`** in `bot.ts` **after** `flagBotReady()` (and alongside `initFlashChat()` ordering as you prefer—announcements do not need flash chat).
- **Shutdown:** on `SIGINT`, `clearInterval` if stored on module—mirror commented timer cleanup pattern in `bot.ts`.

## Testing (`__tests__` colocated or feature tests)

- **Unit tests** for date/dedup helper: given `lastAnnouncedAt` and “now”, correctly includes/excludes rows.
- **Repository test** (if project has DB test harness) or mocked Kysely—only if existing patterns support it; otherwise keep logic in pure functions and test those.
- Optional: mock `AIService` to return fixed string and assert message shape.

## Files likely touched

| Area | Files |
|------|--------|
| Schema / migration | `birthdaySchema.ts`, new migration, `database.ts` (`SqlDatePlugin`) |
| Data access | `birthdayRepo.ts` |
| AI | `aiService.ts`, shared sanitize extracted from `aiReplyHandler.ts` |
| Feature | new `birthdayAnnouncementService.ts` (or similar), `initBirthdayFeature.ts` or new `initBirthdayAnnouncements.ts`, `index.ts` barrel |
| Bootstrap | `bot.ts` (`ClientReady` + optional SIGINT clearInterval) |
| Docs | `birthday-tracker/readme.md` (operator notes: TZ, channel resolution)—only if you want brief operational note |

## Verification checklist

- `pnpm migrate:latest` / `:dev` applies cleanly on sqlite and postgres.
- Single running bot: only **one** interval (log on start; no duplicate logs after hot-restart scenarios if applicable).
- User with birthday today gets **one** message; DB row shows updated `lastAnnouncedAt`; no repeat until next calendar year’s same date.
- User changes birthday after announcement: dedup still behaves (editing month/day should not incorrectly block if your rules say “announce new date”—specify: **reset `lastAnnouncedAt` when month/day changes** in `upsert`/`update` so a corrected birthday can fire same year—include in implementation).
- Permissions failures do not corrupt state (no `markAnnounced` without send).

## Explicit product rule: birthday edits and `lastAnnouncedAt`

- In `upsert` / `update`, when **`month` or `day` changes**, set **`lastAnnouncedAt = null`** (or clear) so announcements are not suppressed for a corrected date. When only display name / username / year changes, preserve `lastAnnouncedAt`.

---

This plan implements issue #8 with persisted dedup, a single safe scheduler, channel resolution aligned with current config, and AI copy wired through the existing BrattyBot completion path in `AIService`.
