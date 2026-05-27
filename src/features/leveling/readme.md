Leveling awards XP for messages, reactions, and image uploads using a MEE6-style curve.

## Setup

1. Run migrations: `pnpm migrate:latest:dev`
2. Enable per guild with `/leveling-config enabled:true` (Manage Server required).
3. Optionally set a notification channel: `/leveling-config channel:#your-channel`.

Run `/leveling-config` with no options to see the current status.

### Tuning the curve locally

Edit `TUNING_SCENARIO` in `src/features/leveling/__tests__/levelCurvePreview.introspect.test.ts`, then run:

```
pnpm test levelCurvePreview.introspect
```

Prints a per-level table (messages / reactions / photo msgs) and cumulative totals to the terminal.

XP is not granted until the guild has saved config with leveling **enabled** via `/leveling-config enabled:true`. A notification channel is optional — without one, XP and `/level` still work; level-up announcements are just skipped.

Reaction XP, photo bonus, message XP ranges, and cooldowns are tuned in [`constants.ts`](constants.ts) (applied at runtime via code defaults).

- Message XP: keyframed log curve — **8 XP @ 5 chars**, **25 XP @ 300 chars**, **50 XP cap @ 3,000 chars**; 20s cooldown
- Reaction XP: 1–2 (random), 180s cooldown
- Photo bonus: 10–20 extra XP on image uploads (when enabled)

Tune anchors in `MESSAGE_XP_KEYFRAMES` in [`constants.ts`](constants.ts). Empty text still uses the configured min (15 XP) for attachment-only posts. Photo bonus stacks on top of message XP.

Multi-level jumps announce once per level reached (e.g. a large XP grant from level 1 to 3 posts separate level 2 and level 3 messages).

## Activity history

Each successful XP grant appends one row to `leveling_activity_events`:

- `activityType` — `message` or `reaction`
- `xpAmount` — XP granted for that event (`0` when cooldown blocked the grant)
- `messageLength` — stored for messages (supports retroactive formula changes)
- `photoBonus` — whether an image bonus was included
- `occurredAt` — full timestamp

Eligible messages and reactions are **always** logged, even on cooldown. Cooldown only gates XP, level progress, and lifetime counters — not activity history.

Query via `levelingActivityEventRepo.getUserEvents()` or `getUserActivityTotals()`. Use `aggregateEventsByDate()` or `fillActivityDateRange()` when you need day-level histograms.

Members can inspect progress with `/level` (optional `user` target). Shows level, XP progress, recent activity (last 7 days), and lifetime activity counts from `leveling_activity_events`.

## Deferred

Voice XP, role rewards, and leaderboards are planned for a later phase.
