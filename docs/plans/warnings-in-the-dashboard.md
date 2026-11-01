# Warnings — list, issue, edit and release from the dashboard

> **Status**: Steps 1–3 built 2026-10-29, uncommitted. Not yet run on Postgres or a real server.
> **Owner**: Douglas
> **Written**: 2026-10-23; revised 2026-10-29 on `feat/web-ui-warnings` (worktree `.claude/worktrees/warnings-dashboard`) off `feat/web-ui-flow-engine` @ `b3fc518`
> **Precedent**: [5C1-tickets-configurable-types-and-dashboard.md](5C1-tickets-configurable-types-and-dashboard.md) Step B — the tickets list, its routes, and its action hook are the shape this copies.

## The problem

Warnings exist end to end in Discord and nowhere else.

- **Discord has three actions.** `/warn` opens a modal (`components/warnModal.ts`) that calls `issueGuildWarning` (`logic/issueGuildWarning.ts:25`) and posts the mod-log notice (`notifyWarningIssued`, `logic/warningIssuedNotice.ts:65`). `/warn-clear <slug>` soft-clears through `clearGuildWarning` (`logic/clearGuildWarning.ts:9`). `/warnings [user]` renders a PNG card of the **active** ones only, capped at 10 rows (`commands/warningsCommand.ts`, `ACTIVE_WARNINGS_CARD_ROW_LIMIT`).
- **The dashboard has one dropdown.** `web/src/pages/WarningsPage.tsx` is the mod-log channel picker and a stale "Meet Flows — coming soon" card. The only routes are `getWarningsConfig` / `updateWarningsConfig` (`src/web/api/guildRoutes.ts`).
- **There is no way to see history.** Every read in `WarningsRepo` (`data/warningsRepo.ts`) filters to `clearedAt is null and expiresAt >= asOf`. A released or expired warning is in the table and unreadable by any surface. That is the "real record" the dashboard is for.
- **Rows carry ids, not names.** `warnings` stores `userId`, `issuerId`, `clearedById` as snowflakes. A list that shows who was warned would have to resolve every one through Discord — the cost the tickets plan removed with name snapshots (5C1 problem 3).
- **Releasing records nothing about why, and posts nothing.** Issuing posts a notice; clearing is silent. Nothing can edit a warning at all.

## What "done" means

| Done when |
|---|
| From `/warnings` an Administrator sees every warning in the server — active, expired and released — filtered by status, by member and by a text search; issues a warning to a member they find by name; edits a warning's rule, description or drop-off date; and releases one (active or expired) with a reason, after confirming. Issue, edit and release each post a mod-log notice, or the page says plainly that it did not. The Discord commands keep working and write the same rows; `/warn-clear` now asks for a reason and posts the same release notice. |

One step. Ban, timeout and opening the dashboard to moderators come next and are only sketched at the end.

## Decisions (2026-10-29)

| Question | Answer |
|---|---|
| Picking the member | Search by name (§2.4) |
| On release | Record a reason; post a mod-log notice; expired warnings can be released too |
| Editing | In this step: rule, description and drop-off date |
| Where | New branch `feat/web-ui-warnings` in `.claude/worktrees/warnings-dashboard` |

Choices made in the plan, not asked:

- **The release reason is required, on both surfaces.** "Keep it on record" means every release has one; `/warn-clear` gains a required `reason` option. Old rows have none.
- **Editing is dashboard-only.** No `/warn-edit` command.
- **A released warning cannot be edited.** It is the record of a closed matter. Editing an expired one is allowed — pushing its drop-off date into the future makes it active again, which is how a mod extends one.
- **The issued date cannot be edited.** It is when the thing happened; the date rules (`resolveWarningDates`) all hang off it.
- **Edits keep only "last edited by / when"**, not a full history. The mod-log notice for each edit names the before and after, so the channel holds the full trail.

## Who can do this

Unchanged for this step: the dashboard is owner-or-Administrator (`mayAccessGuild`, `src/web/api/guildAccess.ts:40`), and Administrator already outranks the Moderate Members gate the slash commands use (`warningPermissions.ts`). No new permission check. **Written down deliberately**, because it stops being true the moment moderators can sign in — see "What comes next".

The actor is always the session (`c.get('user')`), never the request body — the tickets rule (`ticketRoutes.ts`).

---

## 1. Data

### 1.1 New nullable columns

Migration `2026-10-29-Warnings_Dashboard_Record.ts`, both dialect arms, all nullable:

| Column | Written by |
|---|---|
| `user_name` | issue — the warned member's display name at the time |
| `issuer_name` | issue — the issuer's |
| `cleared_by_name` | release — the releaser's |
| `clear_reason` | release |
| `edited_at`, `edited_by_id`, `edited_by_name` | edit |

**Old rows stay null** — no backfill. The UI shows the id for a null name (the tickets `participantLabel` fallback). A live lookup to fill old rows would put the list in the Discord rate-limit budget for a cosmetic gain on rows that age out in six months anyway.

Both callers can supply names without a fetch: the modal has `selectedUser` and `interaction.member`; the dashboard has the member it checked (§2.3) and the session's `username`.

`issueGuildWarning`'s input grows `userName` and `issuerName`; `clearGuildWarning` takes `clearedBy: { id, name }` and `reason`. Both stay the one write path for Discord and the dashboard. New `editGuildWarning` in `logic/` is the only edit path.

### 1.2 Status is derived, in one place

Never stored:

```ts
// src/features/warnings/logic/warningStatus.ts
export type WarningStatus = 'active' | 'expired' | 'released';
```

- `released` — `clearedAt` set (wins over expiry)
- `expired` — not released, drop-off before today (Pacific calendar, `getActiveAsOfUtcMidnight`)
- `active` — otherwise

`isWarningActive` (`warningDates.ts:156`) becomes `warningStatus(w) === 'active'` rather than a second copy of the rule.

### 1.3 Repo

- `listByGuild(guildId, asOf, filter)` — `filter = { status?: WarningStatus; userId?: string; search?: string }`, newest issued first, reads `WARNING_LIST_CAP + 1` (200 + 1) rows so the route can report `truncated` (the tickets/leveling pattern). Each status is one predicate, written once.
- `search` is a prefix match on `slug`, `rule`, `user_name`, `issuer_name` — `lower(col) like :q || '%' escape '\'`, copied from `ticketsRepo.searchByGuild` including its escaping.
- `countsByGuild(guildId, asOf)` → `{ active, expired, released }` for the count tiles.
- `softClear` writes the name and reason too.
- `updateEditable(guildId, slug, fields, editedBy, editedAtIso)` — conditional on `clearedAt is null`, returns whether a row changed, so a release that lands between a mod opening the edit dialog and saving it refuses the edit rather than editing a released warning.

`listActive`, `countActive` and the summary queries stay as they are — `/warnings` and the issued notice still use them.

### 1.4 Mod-log notices

`notifyWarningIssued` keeps its embed; its channel-resolving, posting and status half moves into one `postWarningNotice(guild, embed)` returning `'sent' | 'unconfigured' | 'skipped' | 'failed'`. Two new embeds beside it, same colour and footer:

- **Warning released** — member, released by, rule, slug, reason.
- **Warning edited** — member, edited by, slug, and one field per changed value as `before → after`.

Both Discord and the dashboard post through these, so the channel reads the same whichever surface acted.

---

## 2. API — `src/web/api/warningRoutes.ts` + `warningBody.ts`

Its own `apiRouter`, mounted at `/api/guilds` beside `ticketRoutes`. Every route uses `GUILD_SCOPED_ERRORS` / `GUILD_SCOPED_BODY_ERRORS`, explicit `operationId`s and named components.

| Route | operationId | Budget |
|---|---|---|
| `GET /{guildId}/warnings` | `listWarnings` | general |
| `POST /{guildId}/warnings` | `issueWarning` | discord (member check + notice) |
| `PUT /{guildId}/warnings/{slug}` | `updateWarning` | discord (notice) |
| `POST /{guildId}/warnings/{slug}/release` | `releaseWarning` | discord (notice) |
| `GET /{guildId}/members/search` | `searchGuildMembers` | discord — added to `DISCORD_READS` |

All five go into `rateLimitClassification.test.ts`'s `EXPECTED_BUDGET`, which fails until they do.

### 2.1 Wire shapes

```ts
WarningPerson  = { id: string; name: string | null }
Warning = {
    slug, rule, description,
    member: WarningPerson, issuedBy: WarningPerson,
    issuedOn: 'YYYY-MM-DD', dropsOffOn: 'YYYY-MM-DD',
    status: WarningStatus,
    edited:   z.union([{ by: WarningPerson; at: ISO string }, z.null()]),
    released: z.union([{ by: WarningPerson; at: ISO string; reason: string | null }, z.null()]),
}
WarningList   = { warnings: Warning[]; counts: { active; expired; released }; truncated: boolean }
WarningResult = Warning & { notice: 'sent' | 'unconfigured' | 'skipped' | 'failed' }
```

Dates are calendar dates, not instants — the warning model is Pacific calendar days stored as UTC midnight (`warningDates.ts`), so sending them as `YYYY-MM-DD` keeps the browser from re-zoning them. The list carries full rows (description included): at 200 rows of ≤1000 characters it is small, and the detail drawer then needs no second route.

### 2.2 `listWarnings`

Query: `status` (`active | expired | released`, absent = all — a plain bounded string checked in the handler, as `TicketListQuerySchema` does, so the refusal can name the value; the SDK types it as `string`), `userId` (snowflake, `resolveUserId`'s bounds from `levelingRoutes.ts`), `search` (trimmed, `.max(100)`). The page defaults to `active`.

### 2.3 `issueWarning`

Body `{ userId, rule, description, issuedOn?, dropsOffOn? }`. The schema carries what it can — lengths from `constants.ts` (`WARN_RULE_MAX_LENGTH`, `WARN_DESCRIPTION_MAX_LENGTH`) and the `^\d{4}-\d{2}-\d{2}$` shape — so the browser checks them from the generated zod. The date rules that need "today" or both fields stay in `resolveWarningDates` and come back as a handler refusal: a `Readonly<Record<kind, 400>>` plus one sentence each, **moved** out of `warnModal.ts`'s `warningDateErrorCopy` into `logic/warningRefusals.ts` so the modal and the routes say the same thing.

The handler fetches the member (the search result is only a hint; not in the server → 400), snapshots their display name, calls `issueGuildWarning`, then `notifyWarningIssued`. Response `WarningResult`, 201.

### 2.4 `searchGuildMembers`

Query `q` (1–32 chars). `guild.members.search({ query, limit: 10 })` — Discord's name-prefix search, one request, no full-guild fetch. Returns `{ id, displayName, username, avatarUrl }[]` via `toMemberSnapshot` from `leveling/logic/fetchMemberSnapshots.ts` rather than a second shaping; bots filtered out. Generic name and route: the ban/timeout picker reuses it.

### 2.5 `updateWarning`

Body `{ rule, description, dropsOffOn, baseEditedAt }` — all four, always; the dialog sends the whole form, so there is no "at least one" rule the spec cannot carry. `baseEditedAt` is the `edited.at` the browser loaded (null if never edited), the journeys `baseUpdatedAt` precedent.

- **A drop-off that moves** is judged by `resolveWarningDates` against the stored issued date, so the two date refusals apply (`expires-not-after-issued`, `expires-already-passed`, the latter worded for the edit — there is no "leave it blank" here). **A drop-off left as it was is not re-judged**, or a typo fix on an expired warning would be refused for its past date. An expired warning comes back to life only by moving its drop-off forward.
- **An edit that changes nothing** → 400 `unchanged`, no write, no notice.
- **Somebody else edited it first** → 409 `stale` ("reload"): the row's `editedAt` no longer matches `baseEditedAt`, or — for the race inside one request — the conditional write finds the rule, description or drop-off no longer what was read. Either way nothing is written, so the edited notice's "before" is always true.
- Not found / other guild → 404; released → 409 "Released warnings are part of the record — they don't get edited."

Posts the edited notice (rule and drop-off as `before → after`; the description as separate before and after fields, since two 1000-character halves do not fit one embed field). Response `WarningResult`.

### 2.6 `releaseWarning`

Body `{ reason }` (1–500 chars). Slug lower-cased as `clearGuildWarning` does. `not-found` → 404, `already-cleared` → 409 with the existing sentence. Posts the released notice, built from the saved row (`clearedById`, `clearReason`) so the channel and the record cannot disagree. Response `WarningResult`.

Member search shares the 30-a-minute Discord budget with every write, so the picker waits for 2 characters and debounces (§4.4).

Then `pnpm sdk:generate`; `openApiSpec.test.ts` and `generatedSdkIsCurrent.test.ts` gate it.

---

## 3. Discord side

- `warnModal.ts` passes `userName` (selected member's display name) and `issuerName` (`interaction.member` display name); its date copy moves to `logic/warningRefusals.ts`.
- `/warn-clear` gains a required `reason` string option (max 500), passes `clearedBy` with the interaction member's display name, and posts the released notice; its reply reports the notice the way `/warn`'s does.

---

## 4. Dashboard

### 4.1 Routes and nav

- `/warnings` — the list (new `WarningsListPage`).
- `/warnings/config` — today's channel picker, moved out of `WarningsPage` into `WarningsConfigPage`, reached by a "Warning settings" button on the list (the `/tickets/config` arrangement and its "Ticket settings" label). The "Meet Flows" card is deleted and a breadcrumb back to the list added; otherwise unchanged.
- Nav entry unchanged.

### 4.2 List page — mirrors `TicketsListPage`

- Count tiles: Active / Expired / Released; clicking one sets the status filter.
- Filter card: status `SegmentedControl` (Active · Expired · Released · All), debounced search, and a member chip when filtered to one person (set by clicking a member's name in a row; cleared with ×).
- Table: Member · Rule · Issued · Drops off · Issued by, plus Status **only under All** — filtered to one status every row would carry the same badge, and the drawer always shows it. A row (or, by keyboard, the button on its rule) opens a detail drawer; any filter change closes it, so a warning a write moved out of view never reopens by itself.
- Date refusals are placed under their field by how the server's sentence begins, since a 400 body carries only `{ error }`. `warningBrowserMirrorDrift.test.ts` runs every server date sentence, the time zone and the six-month default through the browser's copies. A `field` member on the 400 body would retire the prefix match.
- Empty states tell "nothing here" apart from "your filters hide everything"; `truncated` shows "Showing the newest 200 — narrow the search".
- Pure logic in `web/src/warnings/*.ts` (`warningFilters.ts`, `warningPresentation.ts`) for unit tests.

### 4.3 Detail drawer

Full description, the issued / edited / released record (who, when, reason), and the actions: **Edit** (not on released) and **Release** (not on released).

### 4.4 Issue and edit dialogs

One form component, two modes. Issue: member search (`Select` fed by `searchGuildMembers` once 2 characters are typed, debounced ≥300 ms, avatar + display name + @username; a 429 shows its sentence without losing the form), Rule, Description, Issued (defaults today), Drops off (defaults six months — the rule from `warnModal.ts`). Edit: same fields minus member and issued date, prefilled, sending the `baseEditedAt` it loaded; Save disabled while nothing differs. Fields checked by the generated zod; the server's date sentence shown under the drop-off field on refusal; a `stale` 409 says to reload and refetches the row. On success: a notification naming the slug, plus a persistent red one when `notice` is not `sent`, then invalidate the list (the `useTicketAction` pattern).

### 4.5 Release confirm

Confirm modal (the `TicketsConfigPage` delete-confirm precedent) naming the member and the rule, with a required reason field — release has no undo.

---

## 5. Tests

- Repo: each status predicate, the expired/released boundary on the Pacific calendar day, search escaping, counts, the conditional edit refusing a released row.
- Migration: up/down on both arms; **one Postgres run in Docker before merge**.
- `warningStatus`, `editGuildWarning`, notice embeds.
- Routes (`warningRoutes.test.ts`, like `ticketRoutes.test.ts`): list filters; issue happy path, each date refusal, member not in server; edit happy path, released 409, date refusals; release happy path, 404, 409; notice status passed through; another server's slug is 404; the actor comes from the session, not the body.
- `/warn-clear` with a reason.
- Web: list page filters and empty states; issue/edit dialog validation; release confirm. One `renderDashboard` round-trip: issue → appears in Active → edit → release → appears in Released.
- Live run on the test server before calling it done: issue, edit and release from the dashboard and see each mod-log notice; `/warnings` in Discord agrees; `/warn-clear` with a reason posts the same notice.

## Build order

1. Data: migration, schema, repo, `warningStatus`, `editGuildWarning`, notices, `clearGuildWarning`/`issueGuildWarning` signature changes, Discord callers updated.
2. API: routes, bodies, rate-limit classification, `pnpm sdk:generate`.
3. Dashboard: config page split, list, drawer, dialogs.

---

## What comes next (not planned here)

Ban and timeout from the dashboard, with a record of each. It is more than two buttons:

- **Moderators have to be able to sign in.** Today only owners and Administrators can (`mayAccessGuild`). "Tied to the role of the person doing it" means the dashboard admits people with Moderate Members / Ban Members, and every route then checks the *signed-in person's* permission for what it does — nothing in the codebase computes that today (`verifyGuildPermission` returns a boolean and drops the member). That also reopens which existing pages a moderator may see (flows, tickets config, settings).
- **A `moderation_actions` table** (who, whom, what, why, until when, undone by) — `command_audit_logs` assumes a Discord channel and does not fit.
- **The bot's own permission and role position** checked before acting, the way `actionKickMember` checks Kick Members.
- Warnings would likely show beside bans and timeouts in one member history — a reason to keep the member search (§2.4) generic now.
