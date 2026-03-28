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

After `ClientReady`, `startBirthdayAnnouncementScheduler` runs a **single** `setInterval` (5 minutes) per process, with a module guard so duplicate starts do not stack. `SIGINT` clears the interval. **v1 assumes one bot replica;** multiple replicas could double-post until a distributed lock exists.

### Announcement send vs `last_announced_at`

The bot posts to Discord first, then updates `last_announced_at`. If the DB write fails after a successful send, the scheduler keeps an **in-process** key `(guildId, userId)` until `markAnnounced` succeeds so **later ticks retry persistence only** and do not post a second message in the same process. **Alerts:** failures are logged at `error` (persist still failing after send, or retry-only path still failing). **Operational note:** restarting the process clears that guard; until the row is updated, a rare duplicate post is possible across restarts. Monitor logs if the database is unhealthy.

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
