Leveling awards XP for messages, reactions, image uploads, and time in voice/video channels using a MEE6-style curve.

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

Reaction XP, photo bonus, message XP ranges, cooldowns, and voice XP rates are tuned in [`constants.ts`](constants.ts) (applied at runtime via code defaults).

- Message XP: keyframed log curve — **8 XP @ 5 chars**, **25 XP @ 300 chars**, **50 XP cap @ 3,000 chars**; 20s cooldown
- Reaction XP: 1–2 (random), 180s cooldown
- Photo bonus: 10–20 extra XP on image uploads (when enabled)
- Voice XP: **12 XP per full eligible minute** in a voice/video channel with at least one other non-bot; 60s minimum eligible time; 60s cooldown between session grants. Mute, deafen, and AFK channels do not change eligibility.

Tune anchors in `MESSAGE_XP_KEYFRAMES` in [`constants.ts`](constants.ts). Empty text still uses the configured min (15 XP) for attachment-only posts. Photo bonus stacks on top of message XP.

Multi-level jumps announce once per level reached (e.g. a large XP grant from level 1 to 3 posts separate level 2 and level 3 messages).

## Voice sessions

Voice XP uses a small state machine reconciled against live Discord voice state:

- **Transient** `leveling_voice_sessions` rows exist only while a member is in VC. They are deleted when the session ends. Eligibility accrues while the channel has ≥2 non-bots.
- **Permanent** `leveling_activity_events` rows record each completed session (`voice_eligible_seconds`, start/end, channel, eligibility rule) so XP can be recalculated later if the formula changes.
- `leveling_progress` counters (`voice_session_count`, `total_voice_seconds`) are derived and can be rebuilt from events.

A `VoiceStateUpdate` handler is the primary input. On ready, and every 5 minutes, the bot reconciles open rows against the gateway voice-state cache (`GuildVoiceStates` intent) and confirms each open-session user with a per-user fetch. discord.js cannot bulk-fetch guild voice states; a no-arg `voiceStates.fetch()` would call `/voice-states/null` and Discord would reject it. Missed leave events cannot leave a session stuck accruing forever.

Bot restarts preserve in-flight eligible time via the transient table; Discord remains the source of truth for who is actually connected.

Voice XP is isolated from the rest of leveling. A failure in the voice coordinator, session table, sweep, or voice grant is logged and contained — message and reaction XP keep writing. Voice session rows are only deleted after a successful session-end grant so a failed grant can retry on the next leave/reconcile.

## Activity history

Each successful XP grant appends one row to `leveling_activity_events`:

- `activityType` — `message`, `reaction`, or `voice`
- `xpAmount` — XP granted for that event (`0` when cooldown blocked the grant, or when a voice session was under the minimum eligible time)
- `messageLength` — stored for messages (supports retroactive formula changes)
- `photoBonus` — whether an image bonus was included
- `voiceEligibleSeconds` / `voiceSessionStartedAt` / `voiceSessionEndedAt` / `voiceChannelId` / `voiceEligibilityRule` — stored for voice sessions (supports retroactive formula changes)
- `occurredAt` — full timestamp

Eligible messages, reactions, and completed voice sessions are **always** logged, even on cooldown. Cooldown only gates XP, level progress, and (for messages/reactions) lifetime counters — not activity history. Voice session count still increments when cooldown blocks XP.

Query via `levelingActivityEventRepo.getUserEvents()` or `getUserActivityTotals()`. Use `aggregateEventsByDate()` or `fillActivityDateRange()` when you need day-level histograms.

Members can inspect progress with `/level` (optional `user` target). Shows level, XP progress, recent activity (last 7 days), and lifetime activity counts from `leveling_activity_events`.

Staff with Manage Server can run `/level-report` with a `level` and/or `xp` bar. Default scope is current members (people with no XP count as level 1 / 0 XP); `tracked` limits the list to members who already have a progress row. The reply is an ephemeral card of the 10 closest plus a CSV of the full list. Current-member reports are capped at 5,000 members — use tracked scope on larger servers.

## Deferred

Role rewards are planned for a later phase.
