
# Implementation plan: Birthday announcements (issue #8)

## Goals

- Periodically detect guild members whose stored birthday should be **celebrated today**, using the same **local process timezone** semantics as today’s `BirthdayRepository.getTodaysBirthdays()` (`now.getMonth() + 1` / `now.getDate()`), **extended for leap-year observation** (see below).
- Post a **public** announcement that **mentions** the user and includes **AI-generated “bratty bot” copy**, reusing the same voice stack as `AIService` (BrattyBot system prompt + chat completions pattern in `aiService.ts`).
- **Never announce the same `(guildId, userId)` twice for the same calendar celebration day** (persist last-announce metadata on the birthday row; compare using the **same “celebration date”** logic as eligibility, including Feb 29 → Feb 28 in common years).
- Avoid **duplicate schedulers** (single interval / single service instance for the process).
- Work **without** external cron: use an in-process timer started after the Discord client is ready (same lifecycle idea as `initFlashChat()` in `Events.ClientReady` in `src/bot.ts`).

## Non-goals (defer unless product asks)

- Per-guild timezone overrides (see “Time / today” below).
- Full agent graph (`runWorkflow` in `newAiReplyStuff.ts`) for birthdays—only add if you explicitly want the same multi-agent guardrail pipeline as mention/reply flows.
- Admin UI to pick announcement channel (can be a follow-up).

## Design decisions

### Scheduler: `setInterval` vs message-throttled tick

- Prefer **`setInterval`** (e.g. every 5–10 minutes) registered **once** from `Events.ClientReady`, behind a module-level guard (`intervalId` or `started` flag) so reloads / accidental double-init do not stack timers.
- Message-driven throttling is optional later; interval is simpler and matches the issue’s “ensure we cannot run multiple intervals” requirement.

### Leap years (feedback from discussion — explicit product rule)

- Storage remains **month + day** (Feb 29 is already allowed in `validateDate()` via 29 days for February in `src/features/birthday-tracker/utils.ts`).
- **Observed celebration day** (when we consider someone “due” for an announcement):
  - **Non–leap day birthdays:** unchanged—announce when local calendar month/day equals stored `month`/`day`.
  - **February 29:** follow the usual **“leapling”** convention used in many locales: in a **non–leap year**, treat the celebration date as **February 28** (not March 1). In a **leap year**, celebrate on **February 29**.
- Implement this in **one shared helper** (e.g. `isBirthdayCelebratedToday(month, day, now: Date): boolean` or `getCelebrationMonthDayForToday(now)` + match) used by:
  - the repository / “due for announcement” query layer, and  
  - dedup comparisons against `lastAnnouncedAt` (so a Feb 29 user is not announced twice across Feb 28 vs Mar 1).
- Document the rule briefly in `birthday-tracker/readme.md` (operator-facing) and in a short code comment on the helper.

### “Today” definition / timezones

- **Baseline:** “today” and leap/non-leap logic use **`Date` in the Node process timezone** (consistent with current `getTodaysBirthdays()`). Document for operators that **celebration day follows server TZ**.
- Optional follow-up: `Intl` / per-guild TZ column—out of scope for first ship unless required.

### Where to send announcements

- Implement a small resolver (e.g. `resolveBirthdayAnnouncementChannel(client, guildId)` in `birthday-tracker`):
  1. **Preferred:** `Guild.systemChannel` if present and the bot has `SendMessages` (and `ViewChannel`).
  2. **Fallback:** any channel ID in `BOT_CONFIG.channelsToMonitor` (`src/botConfig.ts`) that belongs to that guild and is text-based with send permission.
  3. If none: log at `warn`, skip that guild (no throw).
- If multi-guild behavior is insufficient, add **optional env** in `src/environment.ts` (e.g. `BIRTHDAY_ANNOUNCE_CHANNEL_ID` or a small map) as later hardening—keep as optional in this plan.

### AI integration

- **Do not** fake a `MessageCreate` event.
- Add a dedicated method on `AIService` (e.g. `generateBirthdayAnnouncement({ displayName, username })`) that:
  - Reuses **`BRATTY_BOT_SYSTEM_PROMPT`** (and optionally a short slice of `FEW_SHOT_EXAMPLES` or 1–2 birthday-specific few-shots) from `aiService.ts`.
  - Uses the same `openai.chat.completions.create` shape as `generateReply` (model `AI_MODEL`, similar `max_completion_tokens`).
  - Uses a **tight user prompt**: one short birthday shout-out for a member; **no** deep personalization beyond display name; length cap (e.g. ≤ 35–80 words) aligned with existing tone rules.
- **Safety:** Optionally run the generated string through existing Discord sanitization. **Refactor:** extract `validateAndCleanReply` (or rename to neutral `sanitizeBotOutboundText`) from `aiReplyHandler.ts` into a small shared module under `ai-reply` and import it from the birthday announcer so `@everyone` / `@here` zero-width fixes and length limits stay consistent.
- **Moderation:** First version can rely on system prompt + short output; if stakeholders want parity with user-facing AI paths, add a thin call to `runAndApplyGuardrails` **on the fixed birthday prompt string** only when needed (avoid threading synthetic content through the full on-topic agent graph unless tested).

## Data model

1. **Migration** (new file under `src/features-system/data-persistence/migrations/`, both sqlite + postgres branches like `2026-01-06-Create_Birthday_Table.ts`):
   - Add nullable **`last_announced_at`** (`timestamptz` / sqlite `text` ISO) on `birthdays`.
2. **`BirthdayTable`** in `birthdaySchema.ts`: `lastAnnouncedAt: Date | null` (use `ColumnType` consistent with other timestamps).
3. **`database.ts`**: extend `SqlDatePlugin` entry for `birthdays` to include `lastAnnouncedAt` if the plugin lists explicit date columns (mirror `createdAt` / `updatedAt`).

## Repository API

In `birthdayRepo.ts`:

- **`findDueForAnnouncementToday()`** (name flexible): return rows whose stored `(month, day)` matches **today’s celebration calendar** per the **leap-year helper** (not only raw SQL `month = ? AND day = ?` if that misses Feb 29 on Feb 28 in common years). Practical approaches:
  - **Query broader set + filter in app:** e.g. select candidates where `(month, day)` equals local today’s `(m,d)` **or** `(month, day) = (2, 29)` when local today is Feb 28 in a non–leap year, then apply the shared helper to confirm each row; or  
  - **Pure in-app filter** after a conservative query—keep performance acceptable given table size.
- **Dedup:** include a row only if `lastAnnouncedAt` is null **or** the **local calendar date** of `lastAnnouncedAt` (using the same TZ as “today”) is **not** equal to today’s **celebration date key** (e.g. `YYYY-MM-DD` in local time). This ensures one announce per celebration day, including leap observation.
- **`markAnnounced(guildId, userId, at = new Date())`**: sets `lastAnnouncedAt` and `updatedAt`.

Ensure **upsert** paths in `upsert()` do not wipe `lastAnnouncedAt` unless intentional (merge updates so existing `lastAnnouncedAt` is preserved when user edits month/day—except when month/day change triggers explicit reset; see product rule below).

**Alignment with existing `getTodaysBirthdays()`:** Either refactor it to use the same celebration-day helper (so slash/upcoming views stay consistent) or document that it remains “literal month/day only” and announcements use the richer rule—**prefer unifying** on one helper to avoid Feb 29 users seeing inconsistent behavior between “today” listings and announcements.

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
- **Shutdown:** on `SIGINT`, `clearInterval` if stored on module—extend the existing graceful shutdown block in `bot.ts` (currently commented timer cleanup pattern).

## Testing (`__tests__` colocated or feature tests)

- **Unit tests** for **celebration-day + dedup** helpers:  
  - Feb 29 stored, Feb 28 non–leap year → celebrated.  
  - Feb 29 stored, Feb 29 leap year → celebrated.  
  - Feb 29 stored, Mar 1 non–leap year → not celebrated (given Feb 28 rule).  
  - Plain birthdays unchanged.  
  - `lastAnnouncedAt` on same local celebration date → excluded; next local day → eligible again next year via calendar rollover (and month/day change rules below).
- **Repository test** (if project has DB test harness) or mocked Kysely—only if existing patterns support it; otherwise keep logic in pure functions and test those.
- Optional: mock `AIService` to return fixed string and assert message shape.

## Files likely touched

| Area | Files |
|------|--------|
| Schema / migration | `birthdaySchema.ts`, new migration, `database.ts` (`SqlDatePlugin`) |
| Data access | `birthdayRepo.ts` |
| Domain / leap logic | `birthday-tracker/utils.ts` or new `birthdayCelebration.ts` (shared helper + tests) |
| AI | `aiService.ts`, shared sanitize extracted from `aiReplyHandler.ts` |
| Feature | new `birthdayAnnouncementService.ts` (or similar), `initBirthdayFeature.ts` or new `initBirthdayAnnouncements.ts`, `index.ts` barrel |
| Bootstrap | `bot.ts` (`ClientReady` + optional SIGINT `clearInterval`) |
| Docs | `birthday-tracker/readme.md` (TZ, channel resolution, **Feb 29 observed on Feb 28 in common years**) |

## Verification checklist

- `pnpm migrate:latest` / `:dev` applies cleanly on sqlite and postgres.
- Single running bot: only **one** interval (log on start; no duplicate logs after hot-restart scenarios if applicable).
- User with birthday today gets **one** message; DB row shows updated `lastAnnouncedAt`; no repeat until the next **distinct** celebration day (next calendar year for same month/day, subject to leap observation).
- **Feb 29 user:** in a non–leap year, announcement fires on **Feb 28** once; does not fire again on Mar 1; in a leap year, fires on Feb 29.
- User changes birthday after announcement: dedup still behaves (see product rule below).
- Permissions failures do not corrupt state (no `markAnnounced` without send).

## Explicit product rules

### Birthday edits and `lastAnnouncedAt`

- In `upsert` / `update`, when **`month` or `day` changes**, set **`lastAnnouncedAt` to null** (clear) so announcements are not suppressed for a corrected date. When only display name / username / year changes, preserve `lastAnnouncedAt`.

### Leap-year observation (stakeholder direction)

- **February 29 birthdays:** in non–leap years, **observe on February 28**; in leap years, **on February 29**. Encode once, reuse for eligibility and dedup, and document for operators.

---

This plan implements issue #8 with persisted dedup, leap-year-aware “today,” a single safe scheduler, channel resolution aligned with `Guild.systemChannel` and `BOT_CONFIG.channelsToMonitor`, and AI copy wired through the existing BrattyBot completion path in `AIService`.
