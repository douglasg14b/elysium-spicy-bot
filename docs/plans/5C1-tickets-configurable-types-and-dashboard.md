# Tickets — configurable types, and a dashboard that can drive them

> **Status**: Planned
> **Owner**: Douglas
> **Written**: 2026-09-21, on `feat/web-ui-tickets` off `feat/web-ui-flow-engine` @ `359e426`
> **Parent**: [flow-engine-v2-journeys-and-provisioning.md](../prds/flow-engine-v2-journeys-and-provisioning.md) §5.6, [flow-engine-v2-build-order.md](../prds/flow-engine-v2-build-order.md) step 4 carry-forward

## The problem

Three separate things are wrong, and they are wrong in an order.

1. **A ticket type is a compile-time constant.** `TICKET_TYPE_DEFINITIONS` (`src/features/tickets/logic/ticketTypes.ts:77-100`) is a `Readonly<Record<TicketType, TicketTypeDefinition>>` in source. §5.6 asks for *"a guild defines named ticket types"*. Today an operator cannot add one, and `TICKET_TYPES` (`data/ticketsSchema.ts:17`) is the closed union two flow blocks validate against.

2. **A phantom template system is wired end to end and discarded.** `constants.ts:1` declares `SUPPORT_TICKET_NAME_TEMPLATE = 'S{{####}}-{{user}}-{{creator}}'` — `{{user}}` and `{{creator}}` are tokens `buildTicketChannelNameForType` (`ticketTypes.ts:156-168`) does not implement; it implements `{{subject}}` and `{{opener}}`. That constant is written to `config.ticketChannelNameTemplate` at `deployTicketCommand.ts:120` and `:134` and at `ticketConfigModal.ts:214`, presented as a read-only modal field (`ticketConfigModal.ts:65-71`), read back at `:113`, echoed in the success reply at `:244`, and displayed to operators as **"Channel Template"** in the deployed panel (`createModTicketChannelEmbed.ts:36`). Nothing consumes it. PRD line 262 names exactly this defect. `TicketingConfig.ticketChannelNameTemplate` (`ticketingSchema.ts:32`) is the dead field.

3. **Every ticket surface is Discord-only, and identity is not recorded.** `/tickets` in the dashboard is a `ComingSoonPage` (`web/src/App.tsx:80-89`) while the nav entry already exists (`web/src/layout/DashboardLayout.tsx:45`). And the `tickets` table records `subjectId`/`openerId`/`claimerId` as snowflakes with no names, so any surface that is not Discord has to live-fetch members to render a row — which is the exact cost the table was built to avoid (`build-order.md`, *"the table is the decision surface, not an index into Discord"*).

There is a fourth, structural, and it is the one that actually shapes Step B.

4. **The commit-then-sync orchestration exists five times.** `ticketClaimButton.ts:44-62`, `ticketUnclaimButton.ts` (same block), `ticketCloseButton.ts`, `ticketReopenButton.ts`, and `flows/blocks/actionCloseTicket/index.ts:70-92` each do *commit the row via `ticketService`, then `syncTicketChannelToState`, then warn on sync failure*. Three of the four handlers differ **only** in the service call, the announcement string, and the wording of the sync-failure warning. A web route that claims a ticket would be the sixth copy — and the first that has no `interaction.message` to re-render, so a naive copy would leave the in-channel embed stale. This is `.claude/rules/elegance.md`'s *"repeated shaping"* and *"optimize for change surface"* pressure at two signs in one flow, which the rule says means refactor before adding behaviour.

## What "done" means, per step

| Step | Done when |
|---|---|
| **A** | An operator can add, edit and delete ticket types in `ticketing_config.config`; a delete that any existing ticket references is **refused by name**; the seeded `support` and `verification` types behave byte-identically to today after the migration; `SUPPORT_TICKET_NAME_TEMPLATE` and `ticketChannelNameTemplate` are gone; every ticket write records the subject/opener/claimer names. |
| **B** | From `/tickets` in the dashboard an operator lists and filters tickets, opens one, claims/unclaims/closes/reopens it, sees the Discord channel move and the in-channel embed update, and edits categories, moderation roles and types. Every lifecycle action goes through **one** orchestration that the four Discord buttons also call. |
| **C** | A flow author picks a ticket type from the guild's own list rather than a hardcoded two-entry dropdown, via a generic control that names no block. |

Each step leaves a working, verifiable system. A is shippable alone; B is shippable on A; C is shippable on A and is independent of B.

---

# Step A — Configurable ticket types, with identity snapshots

## A.1 — What a type declares, and what it does not

Exactly four things beyond its key, per the operator decision:

```ts
// src/features/tickets/data/ticketingSchema.ts

/**
 * One ticket type, as an operator declares it.
 *
 * Four members, and the boundary is deliberate. **Not** the category — all three
 * categories stay guild-wide (`supportTicketCategoryName`, `claimedTicketCategoryName`,
 * `closedTicketCategoryName`) and `syncTicketChannelToState` keeps routing by *status*,
 * not by type. **Not** the opening content and **not** the available controls: both are
 * §5.6 items carried forward, and both would need a second editor before they are worth
 * having. See "Carried-forward scope".
 *
 * `type` is the key and lives inside the record as well as being its map key, because
 * every consumer of a definition today reads `definition.type` — and a shape where the
 * two can disagree is a shape that will.
 */
export interface TicketTypeDefinition {
    readonly type: string;
    readonly label: string;
    /**
     * Channel name template. `{{####}}` is the zero-padded ticket number,
     * `{{subject}}` and `{{opener}}` the sanitized usernames.
     *
     * These are the only three tokens `buildTicketChannelNameForType` implements, and
     * that is now checked at save time rather than silently ignored — which is what
     * `SUPPORT_TICKET_NAME_TEMPLATE`'s `{{user}}`/`{{creator}}` did for a year.
     */
    readonly nameTemplate: string;
    readonly permissions: TicketPermissionModel;
    /** Whether opening auto-claims to the opener. */
    readonly autoClaimOnOpen: boolean;
}
```

`TicketRolePermissions` and `TicketPermissionModel` **move unchanged** from `logic/ticketTypes.ts` into `data/ticketingSchema.ts`, because they are now part of the persisted JSON shape and `logic/` must not be the owner of a column's type. `toPermissionOverwrite` stays in `logic/ticketTypes.ts` — it produces discord.js bitfields and has no business in a schema file.

`TicketingConfig` grows one member and loses two:

```ts
export interface TicketingConfig {
    modTicketsDeployed: boolean;
    modTicketsDeployedChannelId: string | null;
    modTicketsDeployedMessageId: string | null;

    supportTicketCategoryName: string;
    claimedTicketCategoryName: string;
    closedTicketCategoryName: string;

    moderationRoles: string[];

    /**
     * The guild's ticket types, keyed by `type`.
     *
     * A record rather than an array so a lookup is one index rather than a `.find()`
     * at seven call sites, and so duplicate keys are unrepresentable rather than
     * merely refused.
     *
     * **Optional on read, never on write.** A row written before this migration
     * cannot have it, and the seed backfills every row *that exists* — but `config`
     * is a JSON blob with no schema behind it, so a row that arrives without it must
     * degrade nameably rather than crash. `getTicketTypeDefinition` returns
     * `undefined`.
     *
     * **No caller has a failure path today — verified.** All six current call sites
     * destructure or dereference the return immediately and unguarded:
     * `ticketChannelOps.ts:46`, `:117`, `:228`, `ticketPresentation.ts:31`,
     * `ticketService.ts:77`, `ticketTypes.ts:162`. Making the return optional turns
     * every one into a TypeScript compile error. That is deliberate and it is the
     * point: A.3 resolves absence at the two *entry* points and passes the definition
     * down as non-optional, so there is no branch to forget at the six deep sites.
     * Do **not** silence those errors with `definition!` or `?? DEFAULT` — a default
     * here is exactly the silent fallback A.5 exists to forbid.
     */
    ticketTypes?: Record<string, TicketTypeDefinition>;
}
```

**Removed: `ticketChannelNameTemplate`** — the dead field, per verified fact 8. **Removed: `userTicketsDeployed`, `userTicketsDeployedChannelId`, `userTicketsDeployedMessageId`** — verified fact 9. **Recommendation: remove them.**

Justification for removing rather than leaving: they are initialized to `false`/`null` at `deployTicketCommand.ts:128-130` and `ticketConfigModal.ts:208-210` and read nowhere.

> **Corrected line numbers — do not trust an earlier draft's `:49-51`.** `deployTicketCommand.ts:49-51` is the *permission-denied return* for a caller without `ManageGuild`. Editing there instead of `:128-130` deletes a permission gate. Likewise `ticketConfigModal.ts:109-111` is inside that modal's permission check, not the initializers at `:208-210`. Verified against the worktree.

There is no user-tickets panel and no plan for one in §5.6 — the user-facing entry point §5.6 describes is a flow, not a second deployed panel. Keeping three fields whose only behaviour is being copied forward through every config write means Step B's config PUT must either preserve them (three lines that mean nothing) or drop them (a silent shape change made by accident rather than on purpose). `AGENTS.md`'s own recorded lesson for this feature — *"in this feature, an exported symbol is not evidence of a live path"* — is the argument for deleting them now, while the config shape is being edited anyway, rather than carrying them into a second consumer.

`isTicketingConfigConfigured` (`ticketingSchema.ts:47-73`) gains **no** `ticketTypes` requirement. A guild with zero types configured still has a working panel and working buttons on existing tickets; requiring types to consider the system configured would brick the `resolveTicketAction` gate for every guild between the migration and its first config save. Stated here because it is the tempting wrong move.

### The seed reaches existing rows only — verified, and it matters

`ticketingRepo.get` (`ticketingRepo.ts:5-12`) returns `null` when no row exists and **never inserts**; a `ticketing_config` row is created only by an explicit `upsert` (`:29-38`), which today happens on `/deploy-ticket-system` or a config-modal save. So a guild that has never deployed tickets has **no row**, and the seed migration — an `UPDATE` (A.8) — matches zero rows for it.

That is survivable, but only because of a second change, and the two must land together:

- **Existing rows** get `ticketTypes` from the seed migration.
- **Guilds with no row** get `DEFAULT_TICKET_TYPES` at their *first* config write, because `deployTicketCommand` and `ticketConfigModal` both seed it into the `NewTicketingConfigEntity` they build (A.7 lists both). Such a guild has no tickets, no panel and no buttons, so there is nothing to break in the meantime.

**What this rules out:** deleting `DEFAULT_TICKET_TYPES` along with the source-level `TICKET_TYPE_DEFINITIONS`. The constant survives the refactor — it stops being the *runtime lookup table* and becomes the *seed value*, read by the migration and by both first-write paths. A.9 tests this directly: *"a guild with no `ticketing_config` row gets `DEFAULT_TICKET_TYPES` on its first deploy"*. Without that test the blind spot is invisible, because every integration fixture in the suite creates its config row first.

## A.1.1 — The config modal destroys any member it does not name

**This is the most dangerous defect in Step A, it is pre-existing, and a green test suite will not catch it.**

`ticketConfigModal.ts:204-216` builds the new config as a **complete object literal with no spread**:

```ts
const newConfig: TicketingConfig = {
    modTicketsDeployed: existingConfig?.config?.modTicketsDeployed || false,
    // …nine more members, each named individually…
    ticketChannelNameTemplate: SUPPORT_TICKET_NAME_TEMPLATE, // Non-configurable
    moderationRoles,
};
```

Eleven members named, and **anything not named is dropped**. `deployTicketCommand.ts:113-118` does the opposite — it spreads `...existingConfig.config` — so the two writers of the same JSON blob disagree about whether unnamed members survive.

Today nothing is lost, because those eleven *are* the whole type. The moment A.1 adds `ticketTypes`, the modal becomes a **silent destructor**: the first operator who opens ⚙️ Configure and saves deletes their guild's entire type record. Every subsequent claim/close/reopen then resolves `undefined` and refuses — the "fail nameably" path from A.3, reached not by a hand-edited blob but by the supported config UI.

The re-run does not save you either. The seed is guarded on `ticketTypes is null`, which is true again after the wipe, so re-running the migration restores the two seeded types — and **silently discards any operator-authored third type**. That is exactly the outcome A.8's asymmetric `down` was written to prevent, arriving through a different door.

**The fix, and it is not optional cleanup:**

```ts
const newConfig: TicketingConfig = {
    ...existingConfig?.config,          // everything not named below survives
    supportTicketCategoryName: supportCategoryName,
    claimedTicketCategoryName: claimedCategoryName,
    closedTicketCategoryName: closedCategoryName,
    moderationRoles,
};
```

The create arm (`:227`, where `existingConfig` is null) additionally seeds `ticketTypes: DEFAULT_TICKET_TYPES` — see A.1's note that **every** path creating a `ticketing_config` row must seed, and there are two today (`deployTicketCommand.ts`, this modal) with Step B's config PUT as a third. Consider seeding inside `ticketingRepo.upsert`'s insert arm instead, so the invariant lives in one place rather than three.

A.9 tests this directly — *"a config-modal save preserves `ticketTypes` untouched"* — and A.10 sabotages it (restore the literal construction, watch that one test fail). It is a far stronger guard claim than the template-token validation, which is why that one gets no sabotage pass and this one does.

## A.2 — `TicketType` stops being a union

`data/ticketsSchema.ts`:

- `TICKET_TYPES` and `isTicketType` are **deleted**.
- `export type TicketType = string;` — with the comment that the closed union's justification (*"each value has code behind it"*) is precisely what this step invalidates: the code behind a value is now a row in `ticketing_config`, not a branch in source.
- `TicketTable.type` stays `string` and needs **no migration** (verified fact 3: plain `text NOT NULL`, no CHECK, `2026-09-17-Create_Tickets_Table.ts:35` pg / `:77` sqlite).
- `TICKET_STATUSES` / `isTicketStatus` are untouched. Status is still a closed union with code behind it.

`index.ts` drops `TICKET_TYPES` from its exports and keeps `TicketType`.

**Consequence in the flow blocks** (verified fact 6): `actionOpenTicket/index.ts:12` and `conditionHasOpenTicket/index.ts:8` both use `z.enum(TICKET_TYPES)`. Both become `z.string().min(1)`. Their hardcoded `options` lists (`:50-53`, `:44-48`) stay for Step A — a `select` with options that exist is a working control, and widening the schema to `z.string()` makes the conformance check's *"offers a value its configSchema rejects"* arm vacuously pass rather than newly fail. Replacing those lists with guild-scoped options is Step C, and that is the reason Step C exists.

**Load-bearing note for the implementer:** with the schema widened to `z.string()`, `checkFieldChoices` (`conformance.ts:486-546`) still requires **non-empty** `options` on a `select`. So the options cannot simply be deleted in Step A and filled in later — the block would fail conformance the moment the array is emptied. Keep the two-entry lists until the new control kind lands.

## A.3 — `getTicketTypeDefinition(config, type)` — synchronous

Per verified fact 1, which the plan builds on rather than re-derives: `ticketing_config.config` deserializes in one read and every real call site already holds the config entity. The signature becomes a pure lookup:

```ts
// src/features/tickets/logic/ticketTypes.ts

/**
 * A guild's declaration for one ticket type, or `undefined` when it has none.
 *
 * **Synchronous, and it stays that way.** `config` is a JSON column that arrives whole
 * in one read, and every caller already holds the entity: the four button handlers get
 * it from `resolveTicketAction`'s `TicketActionContext.config`, and both open paths
 * (`createModTicketModal.ts:95`, `actionOpenTicket/index.ts:98`) read it to create the
 * channel. Making this async would push `await` through `buildTicketEmbed` and
 * `buildTicketButtons` — two pure render functions — to fetch data the caller is
 * already holding.
 *
 * Returns `undefined` rather than throwing or substituting a default. A ticket whose
 * type was deleted out from under it must fail *nameably* at the surface that has
 * somewhere to put the message, which is what `root-cause-over-workarounds.md` means
 * by "no silent alternates". Deletion is refused while tickets reference a type, so
 * the only way to reach this is a hand-edited config blob.
 */
export function getTicketTypeDefinition(
    config: TicketingConfig,
    type: string
): TicketTypeDefinition | undefined {
    return config.ticketTypes?.[type];
}
```

`buildTicketChannelNameForType` takes the **definition**, not the type key plus a config — it needs only `nameTemplate`, and threading a whole config through it to read one string is the context-tunneling `elegance.md` names:

```ts
export function buildTicketChannelName(
    definition: TicketTypeDefinition,
    { ticketNumber, subjectName, openerName }: TicketChannelNameParams
): string
```

Body unchanged from `ticketTypes.ts:160-167`. Renamed from `buildTicketChannelNameForType` because it no longer takes a type.

### The seven call sites, and what each becomes

Every one already holds the config. No new plumbing.

| Site | Today | Becomes |
|---|---|---|
| `logic/ticketPresentation.ts:31` `buildTicketEmbed` | `getTicketTypeDefinition(ticket.type)` | `buildTicketEmbed(ticket, definition)` — takes the definition, stays sync and pure |
| `logic/ticketPresentation.ts:81` `buildTicketButtons` | no lookup | **unchanged**, reads only `status`/`claimerId` |
| `logic/ticketChannelOps.ts:46` `buildOverwrites` | `getTicketTypeDefinition(type)` | takes `definition` in its params object |
| `logic/ticketChannelOps.ts:117` `createTicketChannelForTicket` | `getTicketTypeDefinition(ticket.type)` | `getTicketTypeDefinition(config, ticket.type)` — `config` is already a param |
| `logic/ticketChannelOps.ts:228` `syncTicketChannelToState` | `getTicketTypeDefinition(ticket.type)` | same — `config` is already a param |
| `ticketService.ts:77` `openTicket` | `getTicketTypeDefinition(input.type)` | `OpenTicketInput` grows `definition: TicketTypeDefinition` |
| `components/createModTicketModal.ts` / `blocks/actionOpenTicket` | pass `type: 'support'` / `config.ticketType` | resolve the definition from config first, refuse nameably if absent |

`buildTicketEmbed(ticket, definition)` — a second positional parameter rather than reaching for the config — because the embed renders one string from it (`definition.label`) and a function that takes a whole config to read a label is the god-parameter shape. The four button handlers call it as `buildTicketEmbed(updated, definition)` where `definition` comes from the shared orchestration in Step B; in Step A they resolve it themselves from `resolved.value.config`.

**`utils/updateDeployedMessage.ts` is not affected** (verified fact 2): it builds the panel via `CreateModTicketChannelEmbedComponent`, not `buildTicketEmbed`.

`openTicket` taking the resolved definition rather than looking it up: the service must not read `ticketing_config` to answer *"does this type auto-claim"* when the caller already read it to find the category. It also keeps `ticketService.ts`'s stated rule intact — it decides, and a decision it makes from data handed to it is testable without a database.

## A.4 — Identity snapshots

### Naming, and the casing decision

Six nullable columns on `tickets`:

```ts
// src/features/tickets/data/ticketsSchema.ts — added to TicketTable

/**
 * Who these people were when the row was last written.
 *
 * Nullable because every row that predates this migration has no snapshot, and
 * because a snapshot is taken from a member the bot could resolve *at that moment* —
 * a subject who left the guild has no nickname to record. Null means "not recorded",
 * which the dashboard renders as the id; it does not mean "has no name".
 *
 * **Snapshots, not a cache.** The dashboard renders from these instead of fetching
 * members, which is the same argument the whole table rests on: a surface that has to
 * resolve a snowflake to display a row has not moved off Discord. They are re-resolved
 * on every write that touches the person they describe, so they drift only between
 * writes — and a ticket nobody has touched in six months showing the name from six
 * months ago is the correct answer to "who was this about", not a stale one.
 *
 * `*Nickname` is the guild nickname (`member.nickname` — **not** `member.displayName`,
 * which falls back to the username and would lose the distinction between "no nickname"
 * and "nickname identical to the handle"); `*Username` is the global handle
 * (`user.username`). The pair follows `birthday-tracker/data/birthdaySchema.ts:19-21`,
 * which records `displayName` and `username` for the same reason — except the names are
 * qualified here, because three people appear on one row and `displayName` alone could
 * not say whose.
 *
 * **No avatar column.** Declined: an avatar is a URL that rots independently of the
 * name, on a CDN whose hash changes when the user changes their picture, so a stored
 * one is a broken image rather than an out-of-date one.
 */
subjectUsername: string | null;
subjectNickname: string | null;
openerUsername: string | null;
openerNickname: string | null;
claimerUsername: string | null;
claimerNickname: string | null;

/**
 * The id of the in-channel message rendering this ticket's state.
 *
 * **Not an identity snapshot** — it is grouped into the same migration only because
 * one migration beats two, and it is called out separately so the "six identity
 * columns" framing does not absorb it silently.
 *
 * Step B needs it: a web caller has no `interaction.message` to re-render, so without
 * a recorded id a dashboard claim leaves the in-channel embed stale and lying. The
 * alternative rejected in B.1 was re-deriving it by scanning channel history, which is
 * the three-tier-fallback shape `resolveTicketAction.ts:30-36` records as a past
 * mistake.
 *
 * **Step A writes it** rather than leaving it null until B — a column that exists and
 * is never written is indistinguishable from one the plan forgot, and B's fallback
 * would then be dead for every ticket rather than only pre-migration ones.
 */
stateMessageId: string | null;
```

**Casing convention: `<thing>Username` / `<thing>Nickname` — camelCase in TypeScript, `subject_username` in SQL, resolved by `CamelCasePlugin`.** Chosen over the alternatives, with the reason:

- Not `subjectName`/`openerName` alone (the `commandAuditLogSchema.ts` `<thing>Id` + `<thing>Name` convention), because one name cannot be both. `commandAuditLogSchema.ts:12-16` records `channelName`, `guildName`, `userName` — one name per thing, because a channel has one. A guild member has two that differ in meaning, and the audit log's own `userName` is the global handle, so reusing `Name` for the nickname would contradict the existing precedent while appearing to follow it.
- Not `subjectDisplayName` (birthday's word for the nickname), because `displayName` in discord.js is *nickname-or-username-falling-back*, so a column named after it cannot distinguish "no nickname set" from "nickname equals username" — and that distinction is what makes the dashboard able to show `Kitten (@someuser)` rather than `someuser (@someuser)`.
- `Username` and `Nickname` are the words Discord's own UI uses, which is what the operator reading the dashboard will be comparing against.

The `commandAuditLogSchema.ts` precedent is honoured in its **structure** — `<thing>Id` beside `<thing>Name`-family columns on the same row — rather than in its literal spelling. That is the right way to follow it, and it is stated explicitly here so a reviewer does not read the deviation as an oversight.

### Where a snapshot is taken

`openTicket` — both openers resolvable at that point:

```ts
export interface OpenTicketInput {
    readonly guildId: string;
    readonly type: string;
    readonly definition: TicketTypeDefinition;
    readonly subjectId: string;
    readonly openerId: string | null;
    readonly title: string;
    readonly reason: string;
    /** Who these people were at open. Null members yield null names, never a placeholder. */
    readonly subjectIdentity: TicketIdentity | null;
    readonly openerIdentity: TicketIdentity | null;
}

/** A person's two names, as recorded on a ticket. */
export interface TicketIdentity {
    readonly username: string;
    /** The guild nickname, or null when they have not set one. */
    readonly nickname: string | null;
}
```

`claimIfUnclaimed` (verified fact 10, `ticketsRepo.ts:130`) widens to carry the claimer's identity:

```ts
async claimIfUnclaimed(
    id: number,
    claimerId: string,
    claimedAt: string,
    identity: TicketIdentity | null
): Promise<TicketEntity | null>
```

It sets `claimerUsername` and `claimerNickname` inside the same conditional `UPDATE`. That matters: the guard is the `where` clause, so writing the identity in a second statement would leave a window where the row is claimed by someone whose name is still the previous claimer's — and the losing side of a claim race would overwrite the winner's name while its own `claimerId` write was correctly refused.

`unclaimTicket` clears both claimer names alongside `claimerId` and `claimedAt`. A cleared claim keeps no name; "who handled this" survives on a *closed* ticket because close keeps the claim, and that is the rule `ticketService.ts:179-183` already states.

**Re-resolution on later writes.** A claim re-resolves the claimer. Close and reopen re-resolve nothing — they change no person. The open paths resolve subject and opener. That is the whole rule, and it is deliberately not "re-resolve everything on every write": re-resolving the subject on a close means a member fetch inside a transition that currently needs none, which is a Discord call added to a path whose whole design goal was removing them.

### Resolving an identity

One helper, in `logic/`, because it is domain glue and not persistence:

```ts
// src/features/tickets/logic/resolveTicketIdentity.ts

/**
 * The two names to record for a member of this guild.
 *
 * Returns `null` rather than throwing when the member cannot be fetched — a subject
 * who left, or an id the guild has never seen. Null is a recordable fact ("not
 * resolvable when we looked") and the dashboard renders it as the id; inventing
 * `'Unknown User'` would put a string in a column that no consumer could distinguish
 * from somebody's actual username.
 *
 * `member.nickname` rather than `member.displayName`, deliberately: `displayName`
 * falls back to the username, so storing it loses the distinction between "no
 * nickname" and "nickname that happens to match". The dashboard needs that to avoid
 * rendering `someuser (@someuser)`.
 */
export async function resolveTicketIdentity(guild: Guild, user: User): Promise<TicketIdentity>
```

**Takes a `User`, not a userId — and the return is not nullable.** The username is *always* knowable from the `User` object the caller already holds, so only the nickname depends on a fetch. Splitting it that way means a subject who has left the guild records their username with a `null` nickname, which the all-or-nothing `TicketIdentity | null` shape could not express — it would have thrown away a name we already had.

```ts
export interface TicketIdentity {
    readonly username: string;       // always available from the User
    readonly nickname: string | null; // null = no nickname, or not a member any more
}
```

This matters because the two open paths hold *different things*:

- `createModTicketModal.ts:78` resolves the subject via `DISCORD_CLIENT.users.fetch(userId)` — a **`User`**, and the handler does no member fetch at all. It needs **one** `guild.members.fetch(targetUser.id).catch(() => null)` for the nickname only.
- `actionOpenTicket/index.ts:121` has `context.subject`, which **is** a `GuildMember` — no fetch needed; pass `member.user` and read `member.nickname` directly.

Note the honest cost, which A.4's rationale otherwise glosses: *taking* the snapshot adds one member fetch on the mod path. That is a real Discord call on a path this feature's design goal was to keep off Discord — accepted because it happens once at open, not once per render, which is the trade the snapshot exists to make. The `.catch(() => null)` is scoped to the nickname alone so it cannot swallow a rate-limit into a fabricated username.

## A.5 — Deleting a type is refused, naming what blocks it

The cascade-refusal pattern is `src/features/provisioning/logic/sharedJourneyGuard.ts`, matched in structure: a query function that answers *"would this hurt something that did not ask?"*, plus a copy function that builds the refusal, both in `logic/` beside the rule rather than in `src/web/api/`. `journeyRoutes.ts:558-586` is the route that consumes it and `:571-582` is the 409 shape. (The precedent has **no unit test of its own** — it is covered indirectly through `journeyRoutes.test.ts`. A.9 tests `ticketTypeUsage` directly, which is an improvement on the precedent rather than a deviation from it; don't go looking for a `sharedJourneyGuard.test.ts` to model on.)

```ts
// src/features/tickets/logic/ticketTypeInUse.ts

/** How a ticket type is being held, for a refusal an operator has to act on. */
export interface TicketTypeUsage {
    readonly openCount: number;
    readonly closedCount: number;
    readonly deletedCount: number;
    /** Newest first, capped. Enough to recognise, not a second list view. */
    readonly examples: readonly { ticketNumber: number; status: TicketStatus }[];
}

/**
 * How many tickets of this type exist, by status.
 *
 * **`deleted` counts.** A deleted ticket keeps its row on purpose — the status enum's
 * own comment says the record survives to answer "did this member ever have a
 * verification ticket?" — and a row whose type has no definition can no longer render
 * its own label. Removing a type because the only tickets holding it are deleted would
 * make exactly the history the table exists for unreadable.
 *
 * One grouped query, not three. The refusal names three numbers and the operator sees
 * them together.
 *
 * **Takes injectable deps**, matching `sharedJourneyGuard.ts:47-51` — without them the
 * four A.9 tests below cannot be written without either hitting the real `database`
 * singleton or `vi.mock`-ing the module, and both diverge from the convention this
 * function is modelled on.
 */
export interface TicketTypeUsageDeps {
    readonly tickets?: Pick<TicketsRepo, 'countByType' | 'listByType'>;
}

export async function ticketTypeUsage(
    guildId: string,
    type: string,
    deps?: TicketTypeUsageDeps
): Promise<TicketTypeUsage>

/**
 * The refusal shown when tickets still hold a type.
 *
 * **Counts by status plus example numbers**, because unlike a journey a ticket has no
 * name — `#0042` is what an operator finds it by. Shaped after `sharedJourneyRefusal`:
 * it says what the operation would do, what is holding it, and what to do first.
 */
export function ticketTypeInUseRefusal(input: {
    readonly label: string;
    readonly type: string;
    readonly usage: TicketTypeUsage;
}): string
```

Why counts-plus-examples rather than every ticket number, which is what `sharedJourneyRefusal` does for flows: a guild has a handful of flows and can have thousands of tickets of one type. `sharedJourneyRefusal`'s own reasoning — *"a count tells an operator the size of a problem they then have to go and find; the names are what they act on"* — is honoured by giving both: the counts are the size, the examples are the handle, and the ticket list filtered by type (Step B) is where the full set lives. A refusal naming 3,000 ticket numbers is a refusal nobody reads.

**The refusal is unconditional.** There is no force flag and no confirmable override, for the same reason `5A4-unpublish-and-undeploy.md` gives for adoption: *"a confirmable override would make that promise conditional"*. A type whose definition is gone leaves `getTicketTypeDefinition` returning `undefined` for a live ticket, and there is no correct behaviour at that point.

## A.6 — The validate-and-persist logic, shared by Discord and the web

Per the `setWarningsModChannel` model (`src/features/warnings/logic/setWarningsModChannel.ts`) — a discriminated `{ ok: true; ... } | { ok: false; message }` in `logic/`, with injectable deps, so the Discord modal and the web route share one authority:

```ts
// src/features/tickets/logic/setTicketTypes.ts

export type SetTicketTypeResult =
    | { ok: true; config: TicketingConfig }
    | { ok: false; message: string };

/**
 * Add or replace one ticket type.
 *
 * Validation lives here rather than in the Zod body schema for the two rules Zod
 * cannot see: that the guild has a config row at all, and that `nameTemplate` uses
 * only tokens `buildTicketChannelName` implements. The second is the whole reason
 * `SUPPORT_TICKET_NAME_TEMPLATE` was a defect rather than a typo — an unimplemented
 * token was accepted, stored, displayed, and then silently dropped.
 */
export async function upsertTicketType(
    guildId: string,
    definition: TicketTypeDefinition,
    deps?: SetTicketTypesDeps
): Promise<SetTicketTypeResult>;

/**
 * Remove a ticket type, unless tickets still reference it.
 *
 * The refusal is this function's, not the route's: the Discord config surface must
 * refuse for the same reason and with the same words, and two copies of a refusal
 * are two things to drift.
 */
export async function deleteTicketType(
    guildId: string,
    type: string,
    deps?: SetTicketTypesDeps
): Promise<SetTicketTypeResult>;
```

Template-token validation, stated concretely because it is the collapse of defect 2: extract `/\{\{([^}]+)\}\}/g` from `nameTemplate`, reject any token outside `{'####', 'subject', 'opener'}` naming it. Also reject a template that renders to an empty string, and one that would exceed Discord's 100-character channel-name limit at its maximum expansion.

## A.7 — File-by-file change list

**Create**
| Path | What |
|---|---|
| `src/features-system/data-persistence/migrations/2026-09-23-Add_Ticket_Identity_And_Types.ts` | Six nullable columns on `tickets`; seed `ticketTypes` into every `ticketing_config.config`; drop the three dead config members |
| `src/features/tickets/logic/resolveTicketIdentity.ts` | `resolveTicketIdentity` |
| `src/features/tickets/logic/ticketTypeInUse.ts` | `ticketTypeUsage`, `ticketTypeInUseRefusal` |
| `src/features/tickets/logic/setTicketTypes.ts` | `upsertTicketType`, `deleteTicketType`, template-token validation |
| `src/features/tickets/data/defaultTicketTypes.ts` | `DEFAULT_TICKET_TYPES` plus the two permission presets — the seed value, **imported by the migration and by both first-write paths** (A.1) so the seed and the shape cannot drift. **Deliberately in `data/`, not `logic/`** — see the boundary note below; this is the difference between a migration that loads discord.js and one that does not |
| `src/features/tickets/logic/__tests__/ticketTypeInUse.test.ts` | |
| `src/features/tickets/logic/__tests__/setTicketTypes.test.ts` | |
| `src/features/tickets/logic/__tests__/ticketTypes.test.ts` | Template rendering + lookup |
| `src/features/tickets/data/__tests__/ticketIdentitySnapshots.integration.test.ts` | Real SQLite, migration's own arm — the precedent `ticketsSchema.integration.test.ts` set after the review that found `returningAll`/date-coercion untested |

**Modify**
| Path | Change |
|---|---|
| `src/features/tickets/data/ticketsSchema.ts` | `TicketType = string`; delete `TICKET_TYPES`, `isTicketType`; add the **six identity columns plus `stateMessageId`** — seven in total (see the `stateMessageId` note below) |
| `src/features/tickets/data/ticketingSchema.ts` | Move `TicketRolePermissions`/`TicketPermissionModel`/`TicketTypeDefinition` in; add `ticketTypes?`; remove `ticketChannelNameTemplate` + the three `userTicketsDeployed*` |
| `src/features/tickets/data/ticketsRepo.ts` | `claimIfUnclaimed` takes `identity`. **Two new methods** for the refusal: `countByType(guildId, type): Promise<{ status: TicketStatus; count: number }[]>` — one grouped `select status, count(*) … group by status` — and `listByType(guildId, type, limit: number)` for the capped examples (**cap: 5**, newest first). `listByGuild` gains a `type` filter for Step B's list filter **only** — do not overload it to serve the refusal: it returns every row unpaginated and has zero callers today, so giving a dead method two new jobs at once is how it ends up wrong for both |
| `src/features/tickets/logic/ticketTypes.ts` | `getTicketTypeDefinition(config, type)`; `buildTicketChannelName(definition, params)`; re-export the moved types for compatibility |
| `src/features/tickets/logic/ticketChannelOps.ts` | Three lookups take config/definition; `buildOverwrites` takes `definition` |
| `src/features/tickets/logic/ticketPresentation.ts` | `buildTicketEmbed(ticket, definition)` |
| `src/features/tickets/logic/index.ts` | Export the four new modules |
| `src/features/tickets/ticketService.ts` | `OpenTicketInput` grows `definition` + two identities; `claimTicket` takes an identity; `unclaimTicket` clears the claimer names |
| `src/features/tickets/components/createModTicketModal.ts` | Resolve definition + identities; refuse nameably when the type is undefined. `username` comes from the `User` already fetched at `:78`; add **one** `guild.members.fetch(targetUser.id).catch(() => null)` for the nickname only. Record `stateMessageId` from the message sent at `:144` |
| `src/features/flows/blocks/actionOpenTicket/index.ts` (identity half) | `context.subject` is already a `GuildMember` — no fetch. Record `stateMessageId` from the message sent at `:133` |
| `src/features/tickets/components/ticketClaimButton.ts` | Resolve claimer identity; pass definition to `buildTicketEmbed` |
| `src/features/tickets/components/ticketUnclaimButton.ts` / `ticketCloseButton.ts` / `ticketReopenButton.ts` | Pass definition to `buildTicketEmbed` |
| `src/features/tickets/components/ticketConfigModal.ts` | **⚠️ CRITICAL — rewrite the config write as a spread of `existingConfig.config` (see A.1.1 below). This is the single highest-risk edit in Step A.** Then: drop the read-only template field (`:65-71`, `:89`, `:113`, `:214`, `:244`); drop the three `userTicketsDeployed*` initializers (`:208-210`); seed `ticketTypes: DEFAULT_TICKET_TYPES` in the `else`/create arm (`:227`) |
| `src/features/tickets/components/createModTicketChannelEmbed.ts` | Replace the **"Channel Template"** line (`:36`) with a type count; drop the `SUPPORT_TICKET_NAME_TEMPLATE` import |
| `src/features/tickets/commands/deployTicketCommand.ts` | Drop `ticketChannelNameTemplate` (`:120`, `:134`) and the three `userTicketsDeployed*` (**`:128-130`** — *not* `:49-51`, which is the `ManageGuild` permission-denied return); seed `ticketTypes: DEFAULT_TICKET_TYPES` on first-time config. This file already spreads `...existingConfig.config` (`:113-118`), so unlike the modal it needs no clobber fix |
| `src/features/provisioning/logic/resourceDeclaration.ts` | The comment at `:8` cites `TICKET_TYPES` as its closed-union precedent; A.2 deletes that union and inverts the argument. Re-point it at `TICKET_STATUSES`, which A.2 keeps closed for exactly that reason |
| `src/features/tickets/index.ts` | Drop `TICKET_TYPES` |
| `src/features/tickets/readme.md` | **Fix the stale `logic/ticketState.ts` line (`:28`)** — that file no longer exists (verified fact 16). Add the types-in-config row and the identity-snapshot rule |
| `src/features/flows/blocks/actionOpenTicket/index.ts` | `z.string().min(1)`; resolve definition from the config it already reads; keep the two options |
| `src/features/flows/blocks/conditionHasOpenTicket/index.ts` | `z.string().min(1)`; keep the two options |
| `src/features/tickets/__tests__/ticketService.test.ts` | Definition passed in; identity assertions |
| `src/features/tickets/components/__tests__/ticketButtonHandlers.test.ts` | Config stub carries `ticketTypes` |
| `src/features/tickets/data/__tests__/ticketsSchema.integration.test.ts` | Row fixtures gain the identity columns; assert the new columns are nullable on rows written without them. This file builds rows directly against real SQLite, so the `TicketTable` change reaches it — it was cited as precedent elsewhere in this plan but missing from this list |

**Delete**
| Path | Why |
|---|---|
| `src/features/tickets/constants.ts` | Its only export is `SUPPORT_TICKET_NAME_TEMPLATE`, the phantom template. The whole file goes; a `constants.ts` with nothing in it is the empty stub `AGENTS.md` says not to leave |

## A.8 — Migration SQL shape, both dialects

`2026-09-23-Add_Ticket_Identity_And_Types.ts`, following the `DB_TYPE`-dispatch shape every migration here uses. From `2026-09-22-Create_Flow_Journey_Links.ts:128-129` it borrows the raw snake_case rule **only** — the migrator has no `CamelCasePlugin` — not a precedent for the JSON rewrite, which has none (see the import-boundary note below).

**postgres up**
```ts
await db.schema.alterTable('tickets')
    .addColumn('subject_username', 'text')
    .addColumn('subject_nickname', 'text')
    .addColumn('opener_username', 'text')
    .addColumn('opener_nickname', 'text')
    .addColumn('claimer_username', 'text')
    .addColumn('claimer_nickname', 'text')
    .addColumn('state_message_id', 'text')
    .execute();

await seedTicketTypes(db);
```

**sqlite up** — identical: the same seven `addColumn(…, 'text')` calls, in the same order. No default and no `notNull`: a snapshot is a fact about a write that has not happened yet for existing rows, and `''` would be a username. (`notNull` is what `birthday-tracker`'s migration uses, and it could afford to — it created a fresh table. This one alters a table with live rows, so nullable is forced.)

**The seed, both dialects, one statement:**
```ts
async function seedTicketTypes(db: Kysely<any>): Promise<void> {
    await sql`
        update ticketing_config
        set config = ${JSON.stringify(DEFAULT_TICKET_TYPES_PATCH)}
        ...
    `.execute(db);
}
```

`config` is a JSON *string* on sqlite and `jsonb` on postgres — the divergence `SqliteJsonPlugin` exists to hide (`database.ts:120`) and which the bare migrator does **not** get. So the seed cannot be one portable SQL expression, and the two arms must differ:

- **postgres**: `set config = config || ${sql.lit(typesJson)}::jsonb - 'ticketChannelNameTemplate' - 'userTicketsDeployed' - 'userTicketsDeployedChannelId' - 'userTicketsDeployedMessageId'`, guarded by `where config ? 'ticketTypes' = false` so a re-run is a no-op. `jsonb ||` merges shallowly, which is exactly right: `ticketTypes` is a new top-level key and nothing else is touched.
- **sqlite**: `json_set(config, '$.ticketTypes', json(?))` then four `json_remove` calls, guarded by `where json_extract(config, '$.ticketTypes') is null`. `better-sqlite3` ships the JSON1 extension, so `json_set`/`json_remove`/`json_extract` are available; the column stays `text` and `json_set` returns text.

**Both arms take `DEFAULT_TICKET_TYPES` from `data/defaultTicketTypes.ts`**, serialized once at the top of the migration. Importing app code into a migration is the deliberate trade: the alternative is a JSON literal in the migration that must stay identical to the TypeScript record, and two copies of the seeded permission model is precisely the drift `ticketTypes.ts:4-17` documents as the bug the type definitions were lifted to data to prevent.

**The import boundary, and why the file lives in `data/`.** No existing migration imports from `src/features/` — all 20 import only `kysely`, `better-sqlite3`, and `DB_TYPE` from `../../../environment`. This one does, so it must not drag the bot tree in behind it:

- `defaultTicketTypes.ts` imports **nothing but types**, and only from `data/ticketingSchema.ts` (which A.1 makes the owner of `TicketTypeDefinition`). Type imports are erased, so the runtime import list is empty.
- It holds the two permission presets itself. They are currently **module-private** at `ticketTypes.ts:63-75` and the seed needs them — so `logic/ticketTypes.ts` imports the presets *from* `data/defaultTicketTypes.ts`, never the reverse. Re-declaring them in the migration is the drift this whole arrangement exists to prevent.
- The migration imports it by **direct path**, never through `logic/index.ts`. That barrel re-exports `ticketTypes.ts`, whose line 1 is `import { PermissionsBitField } from 'discord.js'`; and `migrate.ts` dynamically `import()`s every file in the directory *before any migration runs*, so one bad import breaks all of them, not just this one.

That is also why the `templates/` convention in `AGENTS.md` is **not** the citation here — `templates/` describes a seeded record plus its installer script. This is plain data read by two callers, so it belongs beside the schema that owns its type.

**On precedent for the seed itself: there is none, and the plan should not imply otherwise.** `2026-09-22-Create_Flow_Journey_Links.ts:128-129` is worth citing for exactly one thing — the raw snake_case rule, because the migrator has no `CamelCasePlugin`. Its backfill (`:131-138`) is an `insert … select` into a brand-new table. **No existing migration rewrites a stored JSON value.** This seed is the first, which is why it is guarded on `ticketTypes is null` and why its `down` is asymmetric. Risk 2 says this; A.8 now agrees with it rather than contradicting it.

**down**: drop the seven columns; leave `config` alone. Stated explicitly: a `down` that stripped `ticketTypes` back out would delete operator-authored types to undo a schema change, so it does not. `2026-09-14-Add_Flow_Run_Variables.ts` sets the precedent — its comment says *"this migration only ever adds: no stored row is rewritten, so nothing here can lose a value"* — and the deviation here (it does rewrite `config`) is why the seed is guarded and the down is not symmetric.

Register nothing new on `database.ts`: no new table, and `ticketing_config: ['config']` already covers the JSON column on sqlite.

## A.9 — Tests

| File | Test |
|---|---|
`logic/__tests__/ticketTypes.test.ts` | `getTicketTypeDefinition` returns undefined for a type the guild has not declared |
| | `buildTicketChannelName` pads the number to four digits and lowercases the subject |
| | a template with no `{{opener}}` collapses the separator rather than leaving a trailing hyphen |
`logic/__tests__/setTicketTypes.test.ts` | rejects a `nameTemplate` using `{{user}}`, naming the token |
| | rejects a `nameTemplate` whose maximum expansion exceeds 100 characters |
| | rejects a `nameTemplate` that renders empty |
| | accepts `{{####}}`, `{{subject}}` and `{{opener}}` |
| | `upsertTicketType` replaces a definition without touching the guild's other types |
| | `upsertTicketType` refuses a guild with no config row |
`logic/__tests__/ticketTypeInUse.test.ts` | **refuses deleting a type while an open ticket holds it, naming the count and an example number** |
| | **refuses deleting a type held only by deleted tickets** |
| | allows deleting a type no ticket has ever used |
| | the refusal names all three status counts when the type spans statuses |
`data/__tests__/ticketIdentitySnapshots.integration.test.ts` | the migration's sqlite arm adds all seven columns nullable (`PRAGMA table_info`) |
| | **Setup, in this exact order** — this is what makes the seed sabotage meaningful rather than vacuous: set `DB_TYPE=sqlite` **before** the migration modules are imported (not in `beforeAll` — `2025-11-10-Create_Ticketing_Config.ts:4` reads it at import time); run `2025-11-10-Create_Ticketing_Config`'s `up`, then `2026-09-17-Create_Tickets_Table`'s `up`; hand-insert **two** `ticketing_config` rows — one pre-migration shape (no `ticketTypes`, all four dead members present) and one that already has `ticketTypes`; run the new migration's `up`; then assert against rows **read back from the database**, never against the fixture object |
| | opening a ticket records `stateMessageId` |
| | **the seed writes `ticketTypes` into an existing config row and removes the four dead members** |
| | **the seed is a no-op on a row that already has `ticketTypes`** |
| | `claimIfUnclaimed` writes claimer id and both names in one statement |
| | **a second claim on an already-claimed ticket leaves the winner's id *and* the winner's names intact** |
`components/__tests__/ticketButtonHandlers.test.ts` (extend) | **a config-modal save preserves `ticketTypes` untouched** (A.1.1 — the clobber guard) |
| | a config-modal save on a guild with no config row seeds `DEFAULT_TICKET_TYPES` |
`__tests__/ticketService.test.ts` (extend) | `openTicket` auto-claims to the opener when the passed definition says so, and records the opener's identity as the claimer's |
| | `unclaimTicket` clears `claimerUsername` and `claimerNickname` with the claim |
| | `closeTicket` leaves all three identities untouched |

Not tested, deliberately: that `buildTicketEmbed` renders `definition.label`. It is one string interpolation and a test for it proves the argument was passed — the "don't write tests that merely prove types pass arguments" ceiling.

## A.10 — Verification

**Commands**
```
pnpm test
pnpm build                       # typecheck; hold at the pre-existing 17, none in touched paths
pnpm migrate:latest:dev
pnpm migrate:latest:dev          # run it TWICE — the second must print "no migrations to run"
                                 # without error, which is what proves the new migration's
                                 # imports load cleanly in the migrator (no discord.js, no
                                 # second database handle). See the data/ placement note.
pnpm dev                         # live: open a support ticket, claim, close, reopen
```

The live run is not optional and step 4's own record is the reason: *"the creation modal wrote no ticket row at all while both gates passed"*. What to watch for specifically: the channel name still reads `s0043-subject-opener` (the seeded template is honoured, proving the config path replaced the constant rather than shadowing it), the embed title still says `🎫 Support Ticket #43`, and the three identity columns are populated after a claim.

**Sabotage-verify — four guards, because each has a passing test that proves nothing on its own.**

0. **The config-modal clobber (A.1.1) — do this one first, it is the highest-value sabotage in the step.** Restore the literal `newConfig` construction (drop the `...existingConfig?.config` spread). Expect *"a config-modal save preserves `ticketTypes` untouched"* to fail, and expect **every other test in the suite to stay green** — which is the whole point: the defect is invisible to all of them, and to `pnpm build`, because the literal is perfectly well-typed. Restore the spread.

1. **The delete refusal.** Remove the `usage.openCount + closedCount + deletedCount > 0` check in `deleteTicketType` so the delete is unconditional. Expect exactly these to fail: *"refuses deleting a type while an open ticket holds it, naming the count and an example number"* and *"refuses deleting a type held only by deleted tickets"*. Expect *"allows deleting a type no ticket has ever used"* to stay green — that is what proves it was never covering the refusal. Restore.

   This is the shape `5B1`'s own record names: *"the refusal because an unconditional delete also leaves a green suite"*.

2. **The migration seed.** Change the seed's `where` guard so it matches nothing (`where 1 = 0`). Expect *"the seed writes `ticketTypes` into an existing config row and removes the four dead members"* to fail. This one matters more than it looks, and `5B1` records why: *"a migration that writes zero rows looks identical to one whose assertions are vacuous. This repo has produced a false pass in exactly that second shape before."* If the assertion still passes with the guard closed, the test is reading its own fixture rather than the migrated row.

3. **The claim-identity atomicity.** Split `claimIfUnclaimed` into the guarded id update plus a second *unguarded* name update. Expect *"a second claim on an already-claimed ticket leaves the winner's id and the winner's names intact"* to fail. Restore. Without this, the claim guard's existing sabotage record (step 4: *"removing it fails exactly one named test"*) covers the id and says nothing about the name that now travels with it.

   **The assertion has to be chosen carefully, and the obvious one does not work.** A single-connection `better-sqlite3` test has no concurrency, so two sequential calls cannot actually race — the tempting test *"a losing claim race writes neither the id nor the name"* would pass under the split too, because with no interleaving nothing overwrites anything and the loser simply writes to a row it already lost. That is the "fails to fail" shape this repo has produced twice.

   What does break under the split: the second caller's guarded id update refuses, but its unguarded name update still lands — so the row ends up with **claimer A's id and claimer B's names**. So the assertion must be, after a winning claim by A and a refused claim by B, that `claimerUsername === A.username` on the re-read row, not merely that B's claim returned null. State plainly in the test's own comment that true concurrency is not simulated and that the guard under test is the `where` clause plus single-statement atomicity, not a race.

   **The new test must call `ticketsRepo.claimIfUnclaimed` itself.** The existing `it('lets only one of two racing claims win')` (`ticketsSchema.integration.test.ts:146-179`) reimplements the UPDATE **inline** (`:155-163`) rather than calling the repo, so it is structurally blind to a change in the repo method and would stay green under this sabotage. Either re-point it at the repo or accept that the new test is the sole guard. Because the repo binds the module-level `database` singleton, say explicitly how the test reaches the in-memory instance (constructor param or a `vi.mock` of `database`) — leaving that unspecified is how the sabotage ends up untestable at implementation time.

**Template-token validation gets no sabotage pass** and that is a deliberate call: it is not a guard protecting existing data, it is new validation whose whole behaviour is the three rejection tests. Removing it fails all three, which is the ordinary meaning of a test rather than the guard-shaped false-pass the rule targets.

---

# Step B — The tickets dashboard

Depends on A for the snapshot columns and for the type list the config page edits. Nothing in B is buildable first.

## B.1 — The core architectural work: one orchestration, six callers

This is the step's substance, not its plumbing. Verified fact 11, and the `elegance.md` pressure it names.

```ts
// src/features/tickets/logic/applyTicketTransition.ts

/**
 * Commit a lifecycle transition and make Discord reflect it.
 *
 * The sequence — commit the row, move and re-permission the channel, re-render the
 * message, announce in channel — existed **five times** before this: four button
 * handlers and `action.closeTicket`, differing only in which service call they made
 * and how they worded the sync-failure warning. A web route would have been the
 * sixth, and the first with no `interaction.message` to re-render, so a copy would
 * have left the in-channel embed showing a state the row no longer holds.
 *
 * `syncWarning` is per-transition because the four are genuinely different warnings,
 * and one of them is a security statement rather than an inconvenience: a close whose
 * permission write failed means **the subject can still read the channel**
 * (`ticketCloseButton.ts`). A generic "could not update the channel" would bury that.
 *
 * **Not a service method.** `ticketService.ts` must stay Discord-free — its own header
 * makes that one of two load-bearing rules — and this function takes a `Guild` and
 * edits a channel. It sits in `logic/` beside `ticketChannelOps.ts`, which is the layer
 * `readme.md` defines as "applies Discord effects for a decision already made".
 */
export interface TicketTransitionOutcome {
    readonly ticket: TicketEntity;
    /** Set when the row committed but Discord did not follow. The caller must surface it. */
    readonly syncWarning: string | null;
}

export type ApplyTicketTransitionResult =
    | { ok: true; outcome: TicketTransitionOutcome }
    | { ok: false; message: string };

export interface ApplyTicketTransitionInput {
    readonly guild: Guild;
    readonly config: ConfiguredTicketingConfig;
    readonly ticket: TicketEntity;
    readonly transition: TicketTransition;
    /** Who is doing this, for the claim identity and the in-channel announcement. */
    readonly actor: { readonly id: string; readonly mention: string };
}

export type TicketTransition = 'claim' | 'unclaim' | 'close' | 'reopen';

export async function applyTicketTransition(
    input: ApplyTicketTransitionInput
): Promise<ApplyTicketTransitionResult>;
```

What it does, in order: call the matching `ticketService` function (resolving the claimer identity first for `claim`); on refusal return `{ ok: false, message }` with the service's own copy; resolve the channel from `ticket.channelId` and sync it, capturing the warning rather than failing; re-render the pinned message **by editing the channel's own message rather than `interaction.message`**; post the announcement. Returns the updated row and the warning.

**Delete is not a transition here.** It is out of scope for the web surface by operator decision, and its Discord half is genuinely different: `ticketDeleteButton.ts` deletes the channel, so there is no channel left to sync, no message left to edit, and its failure is explicitly non-retryable (`ticketDeleteButton.ts`'s own comment). Folding it in would put a branch in every step of a four-step sequence to describe one caller.

**The message re-render is the interesting change.** Today the handlers call `interaction.message.edit(...)`, which happens to be the pinned ticket message because the button lives on it. A web caller has no interaction. So the orchestration must find the message itself, and the honest answer is that it **cannot always**: pinning is best-effort (`actionOpenTicket/index.ts`: *"pinning is a convenience now, not load-bearing"*) and no message id is stored. Options, with a recommendation:

- **(a) Store the message id.** A seventh column, `stateMessageId`, written when the opening message is sent. Correct, one more migration, and it makes the re-render deterministic from any caller.
- **(b) Fetch pins and match the bot's own message.** No migration, but it is `findTicketStateMessage`'s three-tier fallback coming back — the exact thing `resolveTicketAction.ts:30-36` records as the reason the row replaced the embed. Rejected.
- **(c) Skip the re-render from the web and let the buttons do it.** Leaves the in-channel embed stale after a web claim, which is a surface saying one thing while the row says another.

**Recommend (a).** It is one nullable `text` column in the same Step A migration (fold it in — a second migration for one column three days later is churn), and it removes the only reason the orchestration would have to know which caller it has. The Discord handlers keep passing `interaction.message` as an optimization when they already hold it; absent that, the orchestration fetches by the stored id. The input grows `message?: Message` and the fallback is a single `channel.messages.fetch(ticket.stateMessageId)`.

Doing it this way means the *only* difference between a claim from Discord and a claim from the dashboard is where the announcement's actor mention comes from — which is what "one orchestration" should mean.

## B.2 — The API

Mounted the same way every guild-scoped router is (`src/web/api/index.ts:42-47`): `app.route('/api/guilds', ticketRoutes())`, internal paths `/:guildId/...`. `requireGuildAccess` already covers `/api/guilds/:guildId/*` (`index.ts:41`) so **no new middleware**, and the single existing tier (Administrator or Manage Guild, `guildAccess.ts:verifyGuildPermission`) is the tier — no new authorization concept.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/:guildId/tickets?status=&type=` | `{ tickets: TicketSummary[] }` |
| `GET` | `/:guildId/tickets/:ticketId` | `TicketDetail` bare |
| `POST` | `/:guildId/tickets/:ticketId/claim` | `TicketDetail` bare, plus `syncWarning` |
| `POST` | `/:guildId/tickets/:ticketId/unclaim` | same |
| `POST` | `/:guildId/tickets/:ticketId/close` | same |
| `POST` | `/:guildId/tickets/:ticketId/reopen` | same |
| `GET` | `/:guildId/config/tickets` | `TicketingConfigView` bare |
| `PUT` | `/:guildId/config/tickets` | `TicketingConfigView` bare |
| `PUT` | `/:guildId/config/tickets/types/:type` | `TicketingConfigView` bare |
| `DELETE` | `/:guildId/config/tickets/types/:type` | `204`, or `409` with the refusal |

Every convention from verified fact 12, applied:

- Lists return the named key `{ tickets }`; single items return the object bare. `journeyRoutes.ts:208` vs `:221`.
- `c.get('guild')`, never `c.req.param('guildId')`.
- `400` on Zod failure with `parsed.error.issues[0]?.message`; `404` on cross-guild — **never 403**, so the response does not confirm another guild's ticket exists (`journeyRoutes.ts:440-446` states this rule); `409` on the type-in-use refusal, matching `journeyRoutes.ts:571-582`.
- Errors are `{ error: string }` and nothing else.
- Module-level Zod schemas with operator-facing messages in the product voice — `guildRoutes.ts:11` (*"Pick a channel. Warning notices do not haunt the void."*) is the register.
- Wire-shape mappers `ticketSummary()` / `ticketDetail()` / `ticketingConfigView()` at the file bottom, as `journeyRoutes.ts:135-170` does.
- Dates `.toISOString()` at the boundary.

**The claim route resolves the actor from the session, not the body.** `c.get('user').id` is who is claiming. A body-supplied claimer id would let an authorized operator claim on someone else's behalf, which is a different feature and not one that was asked for.

**Cross-guild check, explicitly:** `ticketsRepo.getById` matches on id alone, exactly as `flowsRepo.getByFlowId` does. So every single-ticket route must check `ticket.guildId !== guild.id` itself and 404. This is the route's job, stated because `journeyRoutes.ts:442-444` records it as the same trap.

```ts
// wire shapes
interface TicketSummary {
    id: number;
    ticketNumber: number;
    type: string;
    typeLabel: string | null;   // null when the type is no longer declared — shown as the raw key
    status: TicketStatus;
    title: string;
    subject: TicketParticipant;
    opener: TicketParticipant | null;
    claimer: TicketParticipant | null;
    channelId: string | null;
    openedAt: string;
    updatedAt: string;
}

/**
 * A person on a ticket, rendered from the row's snapshot.
 *
 * `username` and `nickname` are null on a row written before the snapshot columns
 * existed, and the dashboard renders the id then. Not backfilled: doing so would mean
 * fetching every historical member, which is the Discord call this shape exists to
 * avoid.
 */
interface TicketParticipant {
    id: string;
    username: string | null;
    nickname: string | null;
}
```

`typeLabel` resolved from the guild's config once per request and mapped over the list — not per row, and not by a repo join. One config read serves the whole page.

## B.3 — The UI

Three surfaces, all under `/tickets`.

`web/src/App.tsx` — replace the `ComingSoonPage` at `:80-89` with `<TicketsListPage />` at `/tickets`, plus `/tickets/:ticketId` → `TicketDetailPage` and `/tickets/config` → `TicketsConfigPage`. Nav entry already exists (`DashboardLayout.tsx:45`) — it loses nothing and gains no `isNew` flag, since it has been visible all along.

**Ordering note.** `/tickets/config` must be declared **before** `/tickets/:ticketId`, or `config` reads as a ticket id. React Router v6 ranks static over dynamic so either order in fact works, but declare `config` first because that is what a reviewer will check. Note this does *not* have a precedent in `App.tsx:101-105` — that comment is about matching **nav order** and explicitly says the paths there *"do not overlap"*. `/tickets/config` and `/tickets/:ticketId` genuinely do, so this note stands on its own.

Conventions from verified fact 13, all applied:

- **No react-query.** Hand-rolled `useEffect` + `useState` with a `cancelled` flag, plus a `refresh()` `useCallback` for after mutations. `JourneysListPage.tsx:111-143` is the shape, both halves — the effect and the separate `refresh` — and it is copied rather than improved on.
- Mantine v7. **Never `withBorder` on `Card`** and **never `centered` on `Modal`** — both are theme defaults (`theme.ts` `components`).
- `PAGE_MAX_WIDTH` on the outer `Stack`.
- The loading → error → empty → content ternary chain, `JourneysListPage.tsx:298-457`.
- `notifications.show({ color: 'brand' | 'red' })`.
- **Server error messages verbatim**: `err instanceof ApiError ? err.message : '<fallback>'`. The type-delete refusal is the server's sentence and the page shows it unaltered — `JourneysListPage.tsx:210-223` is the precedent, down to keeping the modal open on a 409 so the operator can act on what it named.

**`TicketsListPage`** — breadcrumb, title, `SegmentedControl` for status (`open` / `closed` / `deleted` / all), `Select` for type populated from the config read, and a `Table` of rows: number, type badge, title, subject, claimer, last updated. Row actions are the four lifecycle buttons, each disabled by the same predicate the embed uses (`ticketPresentation.ts:82-90`: claim needs open-and-unclaimed, unclaim open-and-claimed, close open, reopen closed).

**`TicketDetailPage`** — the row as a card: title, reason, the three participants, the four timestamps, a link to the channel when `channelId` is set, and the four actions.

**`TicketsConfigPage`** — the three category names, the moderation-role multi-select (reusing the role fetch `getGuildRoles` already provides), and the type editor: a table of types with label, template, auto-claim, and a permission-model editor. The permission model is three rows of four checkboxes; `PermissionIntentEditor.tsx` is the nearest existing shape to borrow layout from, though not the component — its intents are provisioning's vocabulary, not this one.

**Extracted pure logic**, because verified fact 14 means page logic is only testable if it is not in a `.tsx`:

| `web/src/tickets/` | What |
|---|---|
| `ticketActions.ts` | `availableActions(ticket): TicketAction[]` — the same enable/disable rule the embed applies, in one place the page and its test both read |
| `ticketFilters.ts` | `filterTickets(tickets, { status, type })`, `typeFilterOptions(config)` |
| `participantLabel.ts` | `participantLabel(p): string` — `Kitten (@someuser)`, `someuser`, or the raw id, from the three states the snapshot columns can be in |
| `ticketTypeForm.ts` | `validateTicketTypeDraft(draft)` — client-side mirror of the template-token rule, so the operator is told before the round trip. **The server stays the authority**; this is the *"disabling it means the operator is told what to do first"* rule `JourneysListPage.tsx:420-427` states for its delete button |

## B.4 — File-by-file change list

**Create — server**
| Path | What |
|---|---|
| `src/web/api/ticketRoutes.ts` | The ten routes plus three mappers |
| `src/web/api/__tests__/ticketRoutes.test.ts` | Modelled on `guildSettingsRoutes.test.ts` |
| `src/web/api/__tests__/ticketWireShapeDrift.test.ts` | Server shapes vs `web/src/api/types.ts`, modelled on `nodeDescriptorDrift.test.ts` |

**Create — client**
| Path |
|---|
| `web/src/api/tickets.ts` |
| `web/src/pages/TicketsListPage.tsx` |
| `web/src/pages/TicketDetailPage.tsx` |
| `web/src/pages/TicketsConfigPage.tsx` |
| `web/src/tickets/ticketActions.ts` + `ticketFilters.ts` + `participantLabel.ts` + `ticketTypeForm.ts` |
| `web/src/tickets/__tests__/ticketActions.test.ts` + `ticketFilters.test.ts` + `participantLabel.test.ts` + `ticketTypeForm.test.ts` |

**Create — shared**
| Path | What |
|---|---|
| `src/features/tickets/logic/applyTicketTransition.ts` | B.1 |
| `src/features/tickets/logic/__tests__/applyTicketTransition.test.ts` | |

**Modify**
| Path | Change |
|---|---|
| `src/web/api/index.ts` | `app.route('/api/guilds', ticketRoutes())` after the journey route, with a comment saying why it needs no middleware |
| `src/features/tickets/components/ticketClaimButton.ts` / `ticketUnclaimButton.ts` / `ticketCloseButton.ts` / `ticketReopenButton.ts` | Each collapses to: gate, authorize, `applyTicketTransition`, surface `syncWarning`. **`ticketUnclaimButton` keeps its own "yours, or you outrank them" check** — its comment says the service cannot carry it, and that is still true; the orchestration is not the place for an actor-permission rule either |
| `src/features/flows/blocks/actionCloseTicket/index.ts` | Sixth caller becomes the fifth: replace `:70-92` with `applyTicketTransition`. The guard that this must not import `tickets` internals does not apply — `logic/` is a public path for it already (`syncTicketChannelToState` is imported there today) |
| `web/src/App.tsx` | Three routes replacing the `ComingSoonPage`; drop the now-unused `IconTicket` import if nothing else uses it |
| `web/src/api/types.ts` | Hand-mirrored `TicketSummary`, `TicketDetail`, `TicketParticipant`, `TicketingConfigView`, `TicketTypeView`, `TICKET_STATUSES`, and the `*_KEYS` arrays the drift test compares |
| `src/features/tickets/readme.md` | Add the orchestration row to the Layers table |

Nothing is deleted in B.

## B.5 — Tests

`src/web/api/__tests__/ticketRoutes.test.ts` — repos and `applyTicketTransition` mocked with `vi.fn()`, top-level `await import('../ticketRoutes')`, fake auth via an outer Hono middleware setting `c.set('guild', guildStub())`. Exactly `guildSettingsRoutes.test.ts`.

| Test |
|---|
| `GET /tickets` returns `{ tickets }` and resolves each type's label from config |
| `GET /tickets` reports a ticket whose type is no longer declared with a null `typeLabel` rather than omitting it |
| `GET /tickets?status=open&type=support` passes both filters to the repo |
| `GET /tickets/:id` **404s a ticket belonging to another guild** |
| `POST /tickets/:id/claim` **404s a ticket belonging to another guild** |
| `POST /tickets/:id/claim` uses the session user as the claimer and ignores a body-supplied one |
| `POST /tickets/:id/close` returns 409 with the service's own refusal when the ticket is already closed |
| `POST /tickets/:id/close` returns 200 and surfaces `syncWarning` when the row committed but the channel did not move |
| `PUT /config/tickets` rejects an empty moderation-role list, in the product voice |
| `PUT /config/tickets/types/:type` rejects a `nameTemplate` with an unimplemented token, naming it |
| `DELETE /config/tickets/types/:type` **returns 409 naming the blocking counts when tickets hold the type** |
| `DELETE /config/tickets/types/:type` returns 204 for an unused type |
| `DELETE /config/tickets/types/:type` 404s a type this guild has not declared |

`logic/__tests__/applyTicketTransition.test.ts`

| Test |
|---|
| commits the row, syncs the channel, edits the message and announces, in that order |
| returns `{ ok: false }` with the service's message and **touches Discord not at all** when the transition is refused |
| returns `syncWarning` — not a failure — when the row committed and the sync did not |
| the close warning says the subject may still be able to read the channel |
| fetches the state message by `stateMessageId` when no message is supplied |
| a ticket with no `channelId` commits and reports no warning |

`web/src/tickets/__tests__/*.test.ts` — `.test.ts` only, no `.tsx`: there are zero `.test.tsx` files in the repo and no jsdom or testing-library, which is why the logic is extracted at all.

| Test |
|---|
| `availableActions` offers claim on an open unclaimed ticket and not unclaim |
| `availableActions` offers unclaim and close on an open claimed ticket |
| `availableActions` offers only reopen on a closed ticket |
| `availableActions` offers nothing on a deleted ticket |
| `participantLabel` renders `Kitten (@someuser)` when both names are present |
| `participantLabel` renders `someuser` when the nickname is null |
| `participantLabel` renders the id when both are null |
| `filterTickets` treats an absent filter as "all" rather than as "none" |
| `validateTicketTypeDraft` rejects `{{user}}` with the same token name the server uses |

`src/web/api/__tests__/ticketWireShapeDrift.test.ts` — the `nodeDescriptorDrift.test.ts` mechanism, one level simpler: the browser file exports `TICKET_SUMMARY_KEYS`, `TICKET_DETAIL_KEYS`, `TICKET_PARTICIPANT_KEYS`, `TICKETING_CONFIG_VIEW_KEYS` and `TICKET_STATUSES` as `as const` arrays that its own `tsc -b` holds to its interfaces in both directions; this test compares those arrays against the server's. The cross-workspace `import type` is what breaks `pnpm build:web`, so the mirror is mandatory and this test is the type system's stand-in.

## B.6 — Verification

```
pnpm test
pnpm build
pnpm build:web                   # the drift test's whole reason: proves no cross-workspace type import crept in
pnpm dev                         # live: claim from the dashboard, watch the Discord channel move
```

The live run is the step's proof and the specific thing to watch is the cross-surface one: **claim a ticket from the dashboard and confirm the in-channel pinned embed updates and the channel moves to the claimed category.** That is the single property the whole orchestration refactor exists to deliver, and it is the one a green suite cannot show — every test in B.5 mocks either the repo or Discord.

**Sabotage-verify — three.**

1. **Cross-guild 404.** Remove the `ticket.guildId !== guild.id` check from `GET /tickets/:ticketId`. Expect exactly *"404s a ticket belonging to another guild"* to fail. Restore, and do the same for the claim route separately — they are two checks and one test each, and a shared helper would make one sabotage fail both, which is a weaker signal about a rule that has to hold per route.

2. **The type-delete 409 through HTTP.** Make the route ignore `deleteTicketType`'s refusal and return 204. Expect *"returns 409 naming the blocking counts when tickets hold the type"* to fail and *"returns 204 for an unused type"* to stay green. Step A already sabotaged the logic; this proves the route *forwards* it, which is a different claim — a route that swallowed a refusal and reported success is exactly the shape `5B1` found in its own review, where four tests covered only the fallback arm.

3. **`syncWarning` propagation.** Make `applyTicketTransition` drop the warning and return null. Expect *"returns `syncWarning` — not a failure — when the row committed and the sync did not"* and *"`POST /close` returns 200 and surfaces `syncWarning`"* to fail. Worth sabotaging because a swallowed warning is indistinguishable from success in every other test, and the warning it swallows on close is the one that says the subject can still read the channel.

---

# Step C — A ticket-type picker in the flow builder

## Is anything left, honestly?

Yes, and it is a real slice rather than filler — but it is smaller than the user's framing suggests, because the identity work folded into A and because A does most of C's server side as a side effect.

**What genuinely remains after A and B:**

A flow author configuring `action.openTicket` or `condition.hasOpenTicket` still sees a hardcoded two-entry dropdown (`actionOpenTicket/index.ts:50-53`, `conditionHasOpenTicket/index.ts:44-48`). After Step A the *schema* accepts any string, so a guild that adds an `appeal` type has a type the ticket system honours and the flow builder cannot offer. That is a live gap between two shipped surfaces, not a hypothetical.

**Nothing else remains.** Worth saying plainly rather than padding: PRD §5.6's other open items are all explicitly carried forward below (per-type category, opening content, available controls, categories-by-id), and §5.7's *"subsystem configuration is a declarable resource"* — a journey declaring a ticket type — is provisioning work that belongs to a 5B slice, not here. Ticket triggers are named in the build order as carried into step 5 and are a separate, larger piece with its own design question (the service must stay flows-free, so it cannot call the dispatcher).

## Why C is separated from A rather than folded in

A reasoned call, and it goes the other way from the identity snapshots.

**Fold the snapshots in** (as the user decided): they are columns on a table A is already migrating, written by service functions A is already changing. Splitting them would mean two migrations and two passes over `openTicket`.

**Keep the picker out**, for three reasons:

1. **It is the only part of this work that touches the block contract.** A new member of `BLOCK_CONTROL_TYPES` ripples through `manifest.ts`, `conformance.ts`, `web/src/api/types.ts` (the mirrored vocabulary *and* `BLOCK_CONFIG_FIELD_KEYS`), `renderControl.tsx`'s exhaustive switch, and `nodeDescriptorDrift.test.ts`. That is a contract change with its own review surface, and bundling it into A means A cannot ship until it lands.
2. **A is complete without it.** After A, both blocks accept any declared type and the seeded two work exactly as today. Nothing is broken by the dropdown being stale — an author picks `support` or `verification` and gets what they picked.
3. **C needs a decision A does not** — the guild-scoping of descriptor options, below — and forcing that decision inside A means making it under time pressure from a migration.

So: A and B have a hard dependency; **C depends on A and is independent of B**, and could ship before B or in parallel with it.

## C.1 — A new control kind, not a widened `select`

Verified fact 4 settles this and the plan does not re-open it. `conformance.ts:468` `CHOICE_CONTROLS = ['segmented','select']` and `checkFieldChoices` (`:486-546`) rejects a `select` with zero options, with a written rationale that is correct: *"no options renders an empty dropdown, so a required key can never be set"*. A `select` whose options arrive at render time from the guild would have to be exempted from that check, and the exemption would be indistinguishable from the bug.

The precedent is `rolePicker`/`channelPicker`. `manifest.ts:61-66` states the distinction in so many words: *"A control that edits a list of pickable things … is deliberately not that control: its items come from a fetched set rather than a keyboard."* Those two carry no `options` member and are filled from `ControlContext` in `renderControl.tsx:46-49`.

So: **`ticketTypePicker`**, a new member of `BLOCK_CONTROL_TYPES`, with no `options` member, filled from a new `ControlContext` member.

**Naming and the `.claude` gate** (verified fact 15): `blockTypeBranching.test.ts:13-17` forbids any file outside `blocks/<block>/` from naming a block's *type* or importing its module, across `src/features/flows`, `src/web` and `web/src`. `ticketTypePicker` names no block — `action.openTicket` is the type, and the control is not it. The gate is satisfied.

But the control must also be **generic, not `openTicket`-aware**, and that is the stronger constraint the gate is a proxy for. Concretely: `TicketTypePickerControl` reads `context.ticketTypes` and writes `field.key`. It does not know which block declared the field, does not special-case a key name, and would work identically on a third block that needed a ticket type. `renderControl.tsx`'s switch stays a switch on the control vocabulary.

**Does `ticketTypePicker` leak a use case into the flow engine's vocabulary?** No, and the reason is worth recording because it is the question a reviewer will ask. `engineVocabulary.test.ts:75` gates `engine/`, `data/`, `constants.ts` and `blocks/` **non-recursively** (`{ path: join(FLOWS_DIR, 'blocks'), recursive: false }`), and `PROVEN_REJECTIONS` includes `'ticket'`. `manifest.ts` sits directly in `blocks/`, so it **is** gated — and `BLOCK_CONTROL_TYPES` lives in `manifest.ts`.

**This is a real problem and the implementer will hit it.** Two honest options:

- **(a) Name the control by its shape, not its domain.** `remotePicker` or `catalogPicker`, with the catalogue named in the field declaration. Passes the gate. But it is the *"renaming the concept to slip past a gate"* move that `5B1` explicitly identifies as the leak the gate exists to catch, and rejected for `journeyKey`.
- **(b) Add `ticket` to the gate's `DOMAIN_VOCABULARY` with a stated reason, and remove it from `PROVEN_REJECTIONS`.** Honest, visible in the diff, and reviewable. The argument: `rolePicker` and `channelPicker` already put `role` and `channel` in the control vocabulary, and a control vocabulary naming what it picks is not the engine learning a use case — the *interpreter* still has no concept of a ticket, and `conformance.ts` treats `ticketTypePicker` exactly as it treats `rolePicker`.

**Recommend (b), and flag it as the decision a reviewer should scrutinise.** Do not do (a). The `5B1` precedent is that when the gate fires you either respect it by moving the concept (which is what `flow_journey_links` did) or you change the gate deliberately — and here there is nowhere to move the concept to, because `BLOCK_CONTROL_TYPES` is one array and a control vocabulary split across two files would be worse than either name.

If the reviewer rejects (b), the fallback is (a) with `catalogPicker` plus a `catalog: 'ticketType'` member on the field — which keeps the gate green and puts the domain word in the *block's* declaration, where `blocks/<block>/` is ungated. Record that as the fallback rather than the plan.

## C.2 — Guild-scoped options: the two ways, and the recommendation

Verified fact 5: `GET /api/nodes` is deliberately not guild-scoped (`nodeRoutes.ts:82-83`, *"the registry is process-wide"*), and it is mounted outside the guild middleware (`index.ts:50-51`).

**Option 1 — guild-scope `/api/nodes`.** Move it under `/api/guilds/:guildId/nodes`, or accept an optional `guildId` query. The route then reads the guild's ticket config and injects per-guild options into the descriptors it serves.

Against it, and it is decisive: it makes the descriptor **not a description of the registry**, which is the one thing `nodeRoutes.ts` says it is. Every consumer of `NodeDescriptor` — `nodeDescriptorDrift.test.ts`, `defaultDataFor`, `cardSummary`, the palette — would be holding a shape whose contents depend on which guild asked. And it puts a ticket-config read inside the block catalogue route, which is the feature coupling the whole manifest design avoids. The `NON_WIRE_MEMBERS` subtraction mechanism (`nodeRoutes.ts:16-54`) exists precisely so the descriptor is *derived*, not assembled; injecting guild data breaks the derivation.

**Option 2 — a companion endpoint the builder merges into `ControlContext`.** `GET /api/guilds/:guildId/ticket-types` returning `{ ticketTypes: [{ type, label }] }`. `FlowBuilderPage` adds it to the `Promise.all` at `:428-434` beside `getGuildRoles` and `getGuildChannels`, stores it in state, and `NodeInspector` puts it on `ControlContext` beside `roles` and `channels`.

**Recommend Option 2**, and the argument is that it is not a new pattern — it is *exactly* the pattern already in use. `rolePicker` and `channelPicker` get their data from `getGuildRoles`/`getGuildChannels`, two guild-scoped endpoints the builder fetches alongside the catalogue and merges into `ControlContext` (`FlowBuilderPage.tsx:428-438`, `NodeInspector.tsx:74-78`). A ticket-type picker filled from a guild-scoped ticket-type endpoint is the third instance of a shape with two, not an invention. Option 1 would be the invention.

The endpoint itself is three lines in `ticketRoutes.ts` if B has shipped, or its own tiny route if C ships first. Either way the data is the same config read.

## C.3 — File-by-file change list

**Modify — server**
| Path | Change |
|---|---|
| `src/features/flows/blocks/manifest.ts` | `'ticketTypePicker'` in `BLOCK_CONTROL_TYPES`; a `BlockConfigField` arm with `{ control: 'ticketTypePicker'; defaultValue?: string }` and no `options` |
| `src/features/flows/__tests__/engineVocabulary.test.ts` | `'ticket'` moves from `PROVEN_REJECTIONS` to `DOMAIN_VOCABULARY`, with the reason in a comment. **The decision from C.1(b), and the line a reviewer should stop on.** Also **replace** it in `PROVEN_REJECTIONS` with a noun that is still genuinely rejected (`escalation`, say) — that list's stated purpose (`:278-283`) is to *show a reader concretely what "the engine learning a use case" means*, so emptying it of its example makes the gate demonstrate nothing |
| `src/features/flows/blocks/actionOpenTicket/index.ts` | `control: 'ticketTypePicker'`; delete the two-entry `options` |
| `src/features/flows/blocks/conditionHasOpenTicket/index.ts` | same |
| `src/web/api/ticketRoutes.ts` | `GET /:guildId/ticket-types` |

**Modify — client**
| Path | Change |
|---|---|
| `web/src/api/types.ts` | `'ticketTypePicker'` in the mirrored `BLOCK_CONTROL_TYPES`; the new `BlockConfigField` arm; `ticketTypePicker: ['key','label','description','control','defaultValue']` in `BLOCK_CONFIG_FIELD_KEYS` |
| `web/src/api/tickets.ts` | `getGuildTicketTypes` |
| `web/src/flows/controls/types.ts` | `ticketTypes: TicketTypeOption[]` on `ControlContext`, with the comment explaining it arrives through the context for the same reason `roles` does |
| `web/src/flows/controls/renderControl.tsx` | One `case 'ticketTypePicker':` — the switch is exhaustive, so this is a compile error until added, which is the design |
| `web/src/flows/NodeInspector.tsx` | `ticketTypes` prop threaded onto the context object at `:74` |
| `web/src/pages/FlowBuilderPage.tsx` | `getGuildTicketTypes` in the `Promise.all` at `:428`; state; pass to `NodeInspector` |

**Create**
| Path |
|---|
| `web/src/flows/controls/TicketTypePickerControl.tsx` |
| `web/src/flows/controls/__tests__/ticketTypeOptions.test.ts` |

## C.4 — Tests

| File | Test |
|---|---|
`controls/__tests__/ticketTypeOptions.test.ts` | a guild with no declared types yields an empty option list and a "configure types first" hint rather than an empty dropdown |
| | an option list preserves the label from config, falling back to the key when the label is blank |
| | a saved value naming a type the guild no longer declares is offered as a distinguishable stale option rather than silently reset — the `PickerControls.tsx` precedent for a deleted role |
`src/web/api/__tests__/ticketRoutes.test.ts` (extend) | `GET /ticket-types` returns the guild's declared types |
| | `GET /ticket-types` returns an empty list, not 404, for a guild with no config |
`nodeDescriptorDrift.test.ts` | Passes with no edit — it derives the server vocabulary at runtime and will start demanding the browser declare `ticketTypePicker` on its own. **That it needs no edit is the check**; if it does need one, the mirror is wrong |
`conformance` | `checkFieldChoices` must **not** fire on `ticketTypePicker`, because it is not in `CHOICE_CONTROLS`. Assert it: a field with no options passes conformance |
`blockTypeBranching.test.ts` | Passes with no edit, and `DECLARED_BLOCK_DEPENDENTS` gains no entry. If C forces an entry there, the control is not generic and the design is wrong |

## C.5 — Verification

```
pnpm test
pnpm build
pnpm build:web
pnpm dev     # live: add a type in the dashboard, open the builder, see it in the dropdown
```

**Sabotage-verify — two, both about genericity rather than correctness.**

1. **The gate that keeps the control generic.** Add `if (field.key === 'ticketType')` to `TicketTypePickerControl` — a special case keyed on a block's field name. Expect nothing to fail, and *that is the finding*: `blockTypeBranching.test.ts` catches block *types*, not field keys, so there is no automated guard here. Record that honestly rather than claiming coverage, and make the reviewer check it by reading. Then add the real guard — and **not** an arity assertion: `fn.length` is defeated by a destructured or defaulted parameter, so "takes only `(ticketTypes, currentValue)`" is not checkable and claiming it would be the same false-guard this step is trying to avoid. Instead assert **as text**, the mechanism `blockTypeBranching.test.ts:41-45` already uses for exactly this class of leak: read `TicketTypePickerControl.tsx` and assert it contains no occurrence of the string `'ticketType'`. That fails under the sabotage and cannot be satisfied by a special case hidden in a destructure.

   This is the most useful sabotage in the whole plan, because it fails to fail. A guard claim that cannot be sabotage-verified is a guard claim that should not be made.

2. **Conformance exemption.** Add `'ticketTypePicker'` to `CHOICE_CONTROLS`. Expect the block conformance suite to fail naming both ticket blocks for offering no options. Restore. This proves the new control is genuinely outside the choice-control rule rather than accidentally passing it.

---

# Dependencies between the steps

| Pair | Relationship | Why |
|---|---|---|
| **A → B** | **Hard dependency.** | B renders identity from the snapshot columns A adds, and B's config page edits the `ticketTypes` record A introduces. B's type editor has nothing to edit before A. |
| **A → C** | **Hard dependency.** | C's picker offers the guild's declared types. Before A there is no per-guild list, and `z.enum(TICKET_TYPES)` would reject anything the picker offered beyond the two. |
| **B ↔ C** | **Independent.** | C touches `manifest.ts`, `renderControl.tsx`, two blocks and one endpoint. B touches routes, three pages and the orchestration. The only overlap is `ticketRoutes.ts` — C adds `GET /ticket-types` to it, or its own file if C goes first. They can ship in either order or in parallel. |
| **B.1 → B.2** | **Hard dependency inside B.** | The routes call `applyTicketTransition`. Writing the routes first means writing the sixth copy and then deleting it. |
| **A.4 → B.1** | **Soft, and worth noting.** | If `stateMessageId` (B.1's recommendation (a)) is folded into A's migration, B.1 is a straight refactor. If it is not, B needs a second migration. **Fold it in.** |

**Within A, the ordering that matters**: the migration and `defaultTicketTypes.ts` must land before anything reads `config.ticketTypes`, for the same reason `5B1` gives for its own backfill — *"doing it lazily means two resolution rules live concurrently and the fallback becomes permanent"*. There is no fallback here at all, which is stronger: `getTicketTypeDefinition` returns `undefined` and the surface refuses nameably.

---

# Carried-forward scope — PRD §5.6 items this deliberately does not do

Named so the gap is a recorded decision rather than an omission.

| §5.6 item | Status | Why not now |
|---|---|---|
| **Per-type category** | Carried forward | All three categories stay guild-wide and `syncTicketChannelToState` keeps routing by *status*. Per-type categories mean three names per type, a per-type × per-status routing matrix in `syncTicketChannelToState`'s switch, and a migration for guilds that already have the three. The type editor would grow from four fields to seven. Nothing is broken without it: `createTicketChannelForTicket:121-123` already routes by `autoClaimOnOpen`, which covers the one distinction the two seeded types actually need. |
| **Per-type opening content** | Carried forward | Both open paths hardcode their opening message (`createModTicketModal.ts:144`, `actionOpenTicket/index.ts`). Making it per-type means a template with tokens, a second token vocabulary beside `nameTemplate`'s, and an editor for multi-line copy in the type form. It is a feature in its own right. |
| **Per-type available controls** | Carried forward | `buildTicketButtons` returns all five, enabled by state (`ticketPresentation.ts:81-93`). Per-type control sets need a layout rule for Discord's 5-per-row limit — which §5.6 itself lists as a **separate** item (*"flow-owned buttons render inside tickets … this needs a defined layout rule, not an ad-hoc second row"*) — and the two are the same problem. Doing one without the other produces the ad-hoc row the PRD warns against. |
| **Categories by id, not name** | Carried forward | `ticketingSchema.ts:29-31` stores names and `findOrCreateModeratorCategory` resolves by lookup, so renaming a category in Discord silently breaks it. A real defect, and **not** this work: it is a config-shape migration touching every category read, and Step B's config page keeps the name-based fields unchanged so the two do not collide. Worth its own slice. |
| **A type's permission model is not overridable per instance** | **Satisfied already, and stays satisfied** | `buildOverwrites` derives every overwrite from the definition and nothing per-ticket. Listed here because it is a §5.6 item a reader will look for, and the answer is that step 4 already closed it. |
| **Ticket triggers** (opened/claimed/closed/deleted) | Carried forward | Named in the build order as carried into step 5. The columns record the transitions; nothing emits them. The interesting half is the design constraint — the service must stay flows-free, so it cannot call the dispatcher — and `applyTicketTransition` (B.1) is plausibly where an emission would eventually hang, which is an argument for building it now and a reason not to design the emission inside it. |
| **§5.7 — a journey declares a ticket type as a resource** | Carried forward | Provisioning work. A 5B slice, and it needs the type-editor surface B builds before it has anything to declare *into*. |

**One PRD accuracy item found while planning, deliberately not fixed here.** §5.6 cites `logic/ticketState.ts` at four places (PRD `:263`, `:268`, `:269`, `:409`, plus `:510` and the inventory at `:649`) and that file no longer exists — step 4 deleted it. Worse than the dead path: `:263` **Durable ticket records** is still marked `(Not done)` when the `tickets` table shipped and was live-verified on 2026-09-15, and `:269` **Tickets remain usable without flows** is likewise satisfied.

Those are descriptions of the *old* system kept as "what's wrong today" evidence, so they are not wrong in the way a code citation is wrong — but three checkboxes now misreport the state of the work. This plan fixes `readme.md:28` because that is a line about code this step touches; **re-statusing the PRD is your call, not a side effect of a tickets plan.** Raised here so it is recorded rather than quietly carried.

---

# Open questions and risks

**1. The vocabulary gate decision (C.1) is the one a reviewer should reject if they are going to reject anything.** Adding `ticket` to `DOMAIN_VOCABULARY` widens a gate that `5B1` treated as inviolable. The counter-argument is strong — `role` and `channel` are already in the control vocabulary — but it is an argument, not a proof, and the fallback (`catalogPicker` plus a `catalog:` member) is recorded so rejecting it is cheap.

**2. The postgres arm of the seed is unexercised.** The build order already records this honestly for the tickets table: *"the postgres arm remains unexercised and hand-reviewed"*. The seed is worse than a `CREATE TABLE` because it is the first migration here that **rewrites** a stored JSON value, and the two dialect arms are genuinely different SQL (`jsonb ||` and `-` vs `json_set`/`json_remove`) rather than the same statement with different types. A `jsonb ||` that merged deeply, or a `-` that took a path rather than a key, would silently corrupt a live config. **Mitigation**: hand-run both arms against a throwaway database before the real migration, and assert the sqlite arm in the integration test. The postgres arm stays hand-verified, and that is stated rather than claimed as covered.

**3. `config` has no schema behind it.** `ticketing_config.config` is a JSON blob typed only by `JSONColumnType<TicketingConfig>`, which is a TypeScript assertion about bytes nothing validates. Removing three members and adding one means a row written by an old process and read by a new one, or the reverse, during deploy. The `ticketTypes?: ` optionality handles the forward case. The backward case — an old process reading a config whose `ticketChannelNameTemplate` is gone — reads `undefined` where it expected a string and writes it into a modal field. Harmless, because that field is the phantom being deleted. Stated so the reasoning is on record rather than assumed.

**4. `stateMessageId` can be null forever for existing tickets.** B.1's recommendation (a) writes it on new tickets. Every ticket open today has none, so a dashboard claim on an existing ticket cannot re-render its embed. Options: accept it (the ticket's own buttons still work and the next press re-renders), or backfill by fetching pins — which is the rejected (b). **Accept it**, and have `applyTicketTransition` report the un-rendered case in its `syncWarning` so the operator is told the in-channel embed is stale rather than left to discover it. That is genuine optionality with explicit UX, which `root-cause-over-workarounds.md` permits, rather than a hidden recovery path.

**5. The type editor's permission model is twelve checkboxes and will read as a wall.** Three participants × four flags. The seeded types use two named presets (`STAFF_PERMISSIONS`, `PARTICIPANT_PERMISSIONS`, `ticketTypes.ts:63-75`) and an operator authoring a third type almost certainly wants one of those. Risk: a form that invites twelve independent decisions where two presets and an escape hatch would serve better. **Not designed here** — it is a UI call for the implementer with the mockups in hand — but flagged, because a twelve-checkbox grid is the kind of thing that ships and then needs redoing.

**6. Deleting a type whose tickets are all `deleted` is refused, and an operator will find that surprising.** It is the right call — a deleted row still has to render its own label, and the history is why the row survives — but the refusal copy has to *say* that, or it reads as a bug. `ticketTypeInUseRefusal` must name the deleted count with an explanation, not just a number.

**7. `applyTicketTransition` is a four-step sequence with three places to fail partway.** Row committed / channel synced / message edited / announcement posted. Today each handler decides independently how much of that failing matters, and the answers differ — close's sync failure is a security statement, reopen's is an inconvenience. Centralising it risks flattening that. **Mitigation**: `syncWarning` is per-transition copy passed in, not generated, which is why the type is `string | null` rather than a boolean. If a reviewer sees a generic warning string in the implementation, the refactor has lost the thing that made it worth doing.

**8. Step B's four route tests mock `applyTicketTransition` entirely.** So the routes are covered and the orchestration is covered, and the *seam* between them is covered by nothing but the live run. That is the same gap step 4's review found (*"the service tests mock the repo, so they could not see `returningAll`, date coercion, or the unique index"*) and the same answer applies: the live run is what closes it, and it is not optional.

---

### Critical Files for Implementation

- `C:\Users\Douglas\Documents\01 Programming\01 Personal\discord-spicy-bot-tickets\src\features\tickets\logic\ticketTypes.ts`
- `C:\Users\Douglas\Documents\01 Programming\01 Personal\discord-spicy-bot-tickets\src\features\tickets\data\ticketingSchema.ts`
- `C:\Users\Douglas\Documents\01 Programming\01 Personal\discord-spicy-bot-tickets\src\features\tickets\components\ticketClaimButton.ts`
- `C:\Users\Douglas\Documents\01 Programming\01 Personal\discord-spicy-bot-tickets\src\web\api\journeyRoutes.ts`
- `C:\Users\Douglas\Documents\01 Programming\01 Personal\discord-spicy-bot-tickets\web\src\pages\JourneysListPage.tsx`
