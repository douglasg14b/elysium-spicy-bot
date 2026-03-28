# Birthday Tracker Feature

A Discord bot feature that allows users to set, update, and manage their birthdays within a server, with optional **public birthday announcements** in a configured channel.

## Overview

The Birthday Tracker feature allows users to:

- Set their birthday using `/birthday` (modal) or manage an existing record (ephemeral embed + buttons)
- Update or delete their birthday
- Optionally include birth year for age display
- Store birthdays per server (guild-specific)

**Announcements:** Admins run `/birthday-config channel:<text channel>` (Manage Server) so the bot can post **once per local calendar celebration day** per user, with AI-generated bratty copy (same completion path as `AIService` elsewhere). There is **no fallback channel**—if config is missing, the scheduler skips that guild and `/birthday` surfaces an informational note.

## Timezones and “today”

Celebration eligibility uses the **Node process local timezone** (`Date` getters), consistent with historical `getTodaysBirthdays()` behavior.

**Deployment:** Set the process timezone explicitly (recommended: `TZ` to an IANA zone such as `Europe/London` or `America/New_York` in your service definition, systemd unit, or container image) so “today” matches your community. If the host default differs from that intent, announcements and same-day dedup can land on the wrong calendar date.

## Leap years (February 29)

Storage is month + day; Feb 29 is allowed in validation.

- **Leap year:** Feb 29 birthdays are celebrated on **February 29**.
- **Non–leap year:** Feb 29 birthdays are observed on **February 28** (not March 1).

Shared helpers live in `birthdayCelebration.ts` and drive both listing/announcement queries and deduplication against `last_announced_at`.

## Database

- `birthdays`: per-guild user row; includes `last_announced_at` (nullable) for one-announce-per-local-day dedup. Changing **month or day** clears `last_announced_at` so corrected dates are not suppressed.
- `birthday_config`: one row per guild (`guild_id` PK) with `announcement_channel_id` and timestamps.

## Commands

| Command            | Who        | Purpose                                              |
| ------------------ | ---------- | ---------------------------------------------------- |
| `/birthday`        | Everyone   | Set / view / update / delete own birthday            |
| `/birthday-config` | ManageGuild | Set announcement text channel (bot needs View + Send) |

## Scheduler

After `ClientReady`, `startBirthdayAnnouncementScheduler` runs a **single** `setInterval` (5 minutes) per process, with a module guard so duplicate starts do not stack. `SIGINT` clears the interval.

### Announcement send vs `last_announced_at` (cross-process idempotency)

Before posting, the scheduler calls **`claimAnnouncementIfDue`**: an optimistic `UPDATE` on `birthdays` that sets `last_announced_at` to “now” **only if** the row is still due for today (same rules as the due query). Only the winning process proceeds to `channel.send`, so **multiple bot replicas** do not double-post the same user for the same local celebration day.

If **`send` fails** after a successful claim, `revertAnnouncementClaim` restores the previous `last_announced_at` (matching the claim timestamp) so a **later tick retries** the outbound message.

**Rare edge:** a crash or `SIGKILL` after the claim `UPDATE` but before a successful Discord send can leave `last_announced_at` set for that local day with no message posted; that user would not get a retry until the next calendar celebration day unless an operator clears or adjusts the row. Monitor logs if Discord or the host is unstable.

**Alerts:** send failures are logged at `warn`; tick-level failures at `error`.

## File structure (high level)

```
birthday-tracker/
├── birthdayAnnouncementService.ts  # interval + tick orchestration
├── birthdayCelebration.ts          # leap + “today” matching helpers
├── birthdayChannelResolver.ts      # channel + bot permission check
├── birthdayMessageUtils.ts         # outbound sanitize for announcements
├── commands/
├── components/
├── data/
│   ├── birthdayRepo.ts
│   ├── birthdayConfigRepo.ts
│   └── *Schema.ts
└── initBirthdayFeature.ts
```
