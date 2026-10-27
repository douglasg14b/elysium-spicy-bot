/**
 * Declaring a resource that already exists.
 *
 * The panel offers one picker holding two different kinds of answer: "create a new
 * one, called this" and "use #announcements, which we already have". Both produce a
 * `ResourceDeclaration`; they differ only in whether `adoptDiscordId` is set.
 *
 * The logic lives here rather than inside `ResourcesPanel.tsx` because it is the part
 * with answers worth checking — which channels are offered, what a picked channel
 * seeds into the key and name, and whether an already-claimed channel is offered
 * twice. The panel around it is layout, and the repo pins decisions in `.ts` logic
 * modules a unit test drives rather than through a render (see `cardSummary.ts`,
 * `variables.ts`).
 */

import type { GuildChannel, GuildObjectOwner, GuildRole, ResourceDeclaration, ResourceKind } from '@brattybot/web-sdk';
import { emptyTicketTypeDraft } from '../tickets/ticketTypeForm';
import { RESOURCE_KEY_MAX_LENGTH } from './contractValues';

type GuildChannelType = GuildChannel['type'];

/**
 * Derive a key from a display name.
 *
 * Keys must be slug-shaped — the server rejects anything else — and asking an operator
 * to invent one alongside a name is asking them to understand why the distinction
 * exists. They can still edit it: a key is permanent in a way a name is not, so it
 * stays visible rather than hidden.
 *
 * Cut to the server's length before the trailing hyphens go, so a cut that lands just
 * after a word break cannot leave the key ending in one.
 */
export function slugifyResourceName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+/, '')
        .slice(0, RESOURCE_KEY_MAX_LENGTH)
        .replace(/-+$/, '');
}

/**
 * Make a key unique within a list by suffixing it.
 *
 * A duplicate key is rejected by the server, and silently renaming the operator's
 * resource would be worse than a suffix they can see and edit. Takes anything keyed, so a
 * message's buttons — whose keys follow the same pattern and must be unique the same way —
 * are given theirs by the same rule.
 */
export function uniqueResourceKey(
    desired: string,
    existing: readonly { readonly key: string }[]
): string {
    // A name of only punctuation slugs to nothing, and an empty key fails the
    // server's own `min(1)`. Falling back keeps the failure out of the save path.
    const base = desired || 'resource';
    if (!existing.some((resource) => resource.key === base)) return base;

    let suffix = 2;
    while (existing.some((resource) => resource.key === `${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
}

/** One entry in the "which channel" picker. */
export interface ExistingChannelOption {
    /** The channel's snowflake — what `adoptDiscordId` is set to. */
    value: string;
    /**
     * `#name`, so it reads the way Discord shows it.
     *
     * Never carries the owner text: `labelToName` parses labels and `disambiguateOptions`
     * counts on their equality, so the owner travels in {@link heldBy} instead.
     */
    label: string;
    /**
     * Shown but not pickable: another owner already holds it, so the server would refuse
     * the adoption (one owner per object, 2026-10-10). Absent means pickable.
     */
    disabled?: boolean;
    /** Who holds it, as the server names them — "the ticket system", `journey "Onboarding"`. */
    heldBy?: string;
}

/**
 * Whether a kind can be adopted from the builder's channel list.
 *
 * **Channels and categories, not roles** — not because a role cannot be adopted, but
 * because a role is not in this list. Roles arrive from `GET /:guildId/roles` as a
 * separate shape, and `adoptableRoleOptions` is their equivalent; `canAdopt` is what a
 * caller asking "does this row get a picker at all?" should use.
 *
 * This was text-channels-only, and the reason given was the endpoint rather than the
 * model: `GET /:guildId/channels` sent text channels alone, so the list held nothing a
 * category could adopt. Offering it under "Category" anyway was worse than offering
 * nothing — the picker showed `#general` beside the label "Which category", the
 * declaration passed Zod and `validateJourneyDeclaration`, and the failure landed
 * mid-apply in `requireAdoptable`, after earlier resources had really been created.
 */
export function canAdoptFromChannelList(kind: ResourceKind): boolean {
    return kind === 'textChannel' || kind === 'category';
}

/**
 * Whether a declared resource of this kind can be pointed at something existing.
 *
 * All three kinds, which is what the install model has always supported — `installPlan`
 * turns any declaration carrying an `adoptDiscordId` into an `adopt`, and
 * `existsInGuildAs` validates a role id against the role cache exactly as it does a
 * channel. The panel simply never offered roles a picker, so the capability was
 * unreachable for a third of the resources an operator can declare.
 *
 * Exhaustive on `ResourceKind` so a new kind cannot be added without deciding this —
 * and the fourth, a ticket type, decided no: it is found by its key, and one that already
 * exists is used as it is, so there is nothing to point at. The fifth, a message, decided no
 * too: the bot can only edit a message it posted, so install always posts its own.
 */
export function canAdopt(kind: ResourceKind): boolean {
    switch (kind) {
        case 'textChannel':
        case 'category':
        case 'role':
            return true;
        case 'ticketType':
        case 'message':
            return false;
        default: {
            const unreachable: never = kind;
            throw new Error(`Unhandled resource kind: ${String(unreachable)}`);
        }
    }
}

/**
 * The channel types a declared resource of this kind may adopt.
 *
 * The one place that answers it, so a picker cannot offer a category to a declaration
 * that wanted a channel — precisely the mismatch that used to survive validation and
 * fail mid-apply.
 */
function adoptableTypesFor(kind: ResourceKind): readonly GuildChannelType[] {
    return kind === 'category' ? ['category'] : ['text'];
}

/**
 * The channels a flow may post a message in.
 *
 * Exported and named because the alternative is what shipped: every picker mapping the
 * raw list into "somewhere to post" and relying on the *server* to have filtered it.
 * `ChannelPickerControl` carried a comment saying categories were excluded while doing
 * nothing to exclude them — true only because of a filter two files away, on the other
 * side of the wire. Now the invariant is enforced where it is claimed.
 */
export function postableChannels(channels: readonly GuildChannel[]): GuildChannel[] {
    return channels.filter((channel) => channel.type === 'text');
}

/**
 * How to name a channel so two of them can be told apart.
 *
 * The motivating case: two channels called `general`, one in Support and one in
 * General, rendered as two identical `#general` rows. The operator picked one and
 * found out later which. The parent is the cheapest thing that distinguishes them and
 * the one a human actually navigates by.
 *
 * A category gets no `#` — it is not a channel you post in, and the prefix is the main
 * thing that made a category read as one in the picker that should never have offered
 * it.
 */
export function channelOptionLabel(channel: GuildChannel): string {
    const name = channel.type === 'category' ? channel.name : `#${channel.name}`;
    return channel.parentName ? `${name} · in ${channel.parentName}` : name;
}

/**
 * How a picker shows an option another owner holds: its label, then who holds it.
 *
 * One function for both pickers (adoption here, the ticket category slots), so an owner
 * reads the same way wherever a disabled option says why. For display only — never store
 * the result as an option's `label`, which `labelToName` parses.
 */
export function heldByLabel(label: string, ownerLabel: string): string {
    return `${label} — held by ${ownerLabel}`;
}

/**
 * The kind of declared resource a row of this kind sits in, or `undefined` for one that sits
 * in nothing: a text channel goes in a category, and a message is posted in a text channel.
 *
 * A category gets none, stricter than the server's own check on purpose:
 * `validateJourneyDeclaration` accepts a *category* with a parent — and then
 * `applyInstallPlan`'s category branch creates with no `parent` argument at all, so the
 * parent is stored and silently ignored. Offering the control for a category is a form with
 * no effect.
 *
 * One answer rather than inline `kind` checks, so a new kind cannot answer this differently
 * in the panel than in the declaration builders — and exhaustive, so it cannot be added
 * without deciding.
 */
export function parentKindFor(kind: ResourceKind): ResourceKind | undefined {
    switch (kind) {
        case 'textChannel':
            return 'category';
        case 'message':
            return 'textChannel';
        case 'category':
        case 'role':
        case 'ticketType':
            return undefined;
        default: {
            const unreachable: never = kind;
            throw new Error(`Unhandled resource kind: ${String(unreachable)}`);
        }
    }
}

/**
 * Whether a kind carries channel permission overwrites: a channel or a category.
 *
 * Not a role, which *appears in* overwrites rather than having them, and not a ticket
 * type, whose access is its own permission grid. Named rather than written as
 * `kind !== 'role'`, which a fourth kind slipped straight through.
 */
export function hasChannelPermissions(kind: ResourceKind): boolean {
    return kind === 'textChannel' || kind === 'category';
}

/**
 * The existing channels a new declaration may adopt.
 *
 * Channels already claimed by another row are **left out** rather than shown and
 * rejected on save. Two resources adopting one channel is refused by
 * `validateJourneyDeclaration`, and an option that can only produce an error is worse
 * than no option — the operator picks it, the save fails, and nothing in the picker
 * said why.
 *
 * Channels **another owner** holds — another journey, or the ticket system — are shown
 * but **disabled**, naming the owner. Different from the claimed-by-a-row case because
 * nothing in this list explains it: the operator can see the channel in Discord, and a
 * row that silently lacks it reads as a bug. The journey being edited is not "another
 * owner", so its own installed channels stay pickable.
 */
export function adoptableChannelOptions(
    channels: readonly GuildChannel[],
    kind: ResourceKind,
    declared: readonly ResourceDeclaration[],
    /** The row being edited, whose own adoption must stay selectable. */
    exceptKey?: string,
    /**
     * The journey these declarations belong to, so its own holdings are not disabled.
     * Absent for a flow in no journey yet, for which every holder is somebody else.
     */
    ownJourneyKey?: string
): ExistingChannelOption[] {
    if (!canAdoptFromChannelList(kind)) return [];

    const claimed = idsClaimedByOtherRows(declared, exceptKey);

    // Filtered by *type* as well as by claim: a declaration asking for a category must
    // not be offered a text channel, which is precisely the mismatch that used to
    // survive validation and fail mid-apply.
    const allowedTypes = new Set<GuildChannelType>(adoptableTypesFor(kind));

    return channels
        .filter((channel) => allowedTypes.has(channel.type) && !claimed.has(channel.id))
        .map((channel) =>
            withOwnership({ value: channel.id, label: channelOptionLabel(channel) }, channel.owner, ownJourneyKey)
        );
}

/**
 * An option, disabled and naming its holder when another owner holds the object.
 *
 * Shared by the channel and role pickers so "another owner" means the same thing in both:
 * any holder but the journey being edited, which keeps its own installed objects
 * pickable. With no journey yet, every holder is somebody else.
 */
function withOwnership(
    option: ExistingChannelOption,
    owner: GuildObjectOwner | null,
    ownJourneyKey: string | undefined
): ExistingChannelOption {
    const holder = otherHolder(owner, ownJourneyKey);
    return holder ? { ...option, disabled: true, heldBy: holder.label } : option;
}

/**
 * The owner holding an object, unless it is the journey being edited — what makes an object
 * unpickable here. The adopt pickers and the Button Click trigger's "+ New message" ask it, so
 * "another owner" means the same thing in each.
 */
export function otherHolder(owner: GuildObjectOwner | null, ownJourneyKey: string | undefined): GuildObjectOwner | undefined {
    const ownedHere = owner?.kind === 'journey' && owner.key === ownJourneyKey;
    return owner && !ownedHere ? owner : undefined;
}

/**
 * The existing roles a role declaration may adopt.
 *
 * The sibling of `adoptableChannelOptions`, and separate rather than generic because a
 * role and a channel share nothing but `{id, name}`: a role has no type to filter on
 * and no parent to disambiguate by, while a channel is meaningless without both. One
 * function over a union would be a `kind` switch wearing a type parameter.
 *
 * **What makes this safe is upstream.** `GET /:guildId/roles` already excludes
 * `@everyone` and managed roles, and the exclusion is not cosmetic: `@everyone`'s id
 * *is the guild id*, so adopting it would bind a declaration to the same id the
 * `everyone` audience compiles to — and since later intents override earlier ones per
 * id in `compilePermissionIntents`, the canonical "deny everyone, then allow staff"
 * declaration would erase its own deny and produce a world-readable channel that every
 * plan and dashboard still reports as staff-only. This function does not re-filter,
 * because duplicating that rule is how the two copies drift; it consumes a list the
 * endpoint has already made safe.
 *
 * A role **another owner** holds is shown disabled, naming the owner, exactly as a channel
 * is in `adoptableChannelOptions`: install refuses to adopt it, so offering it would be an
 * option that can only produce a blocked plan.
 */
export function adoptableRoleOptions(
    roles: readonly GuildRole[],
    kind: ResourceKind,
    declared: readonly ResourceDeclaration[],
    exceptKey?: string,
    /** The journey these declarations belong to, so its own roles stay pickable. */
    ownJourneyKey?: string
): ExistingChannelOption[] {
    if (kind !== 'role') return [];

    const claimed = idsClaimedByOtherRows(declared, exceptKey);

    return roles
        .filter((role) => !claimed.has(role.id))
        .map((role) => withOwnership({ value: role.id, label: roleOptionLabel(role) }, role.owner, ownJourneyKey));
}

/**
 * How a role reads in the picker.
 *
 * `@` for the same reason a channel gets `#`: it is how Discord writes one, and the
 * prefix is what tells an operator at a glance which list they are looking at. Roles
 * carry no parent, so there is nothing to qualify with — two roles of one name are
 * genuinely indistinguishable here, which is a gap this cannot close because the wire
 * shape has nothing else to say about them.
 */
export function roleOptionLabel(role: GuildRole): string {
    return `@${role.name}`;
}

/**
 * The Discord ids other declarations have already adopted.
 *
 * Shared by both pickers so "already claimed" cannot mean one thing for channels and
 * another for roles. Claimed ids are **left out** of the options rather than shown and
 * rejected on save: two resources adopting one id is refused by
 * `validateJourneyDeclaration`, and an option that can only produce an error is worse
 * than no option — the operator picks it, the save fails, and nothing in the picker
 * said why.
 *
 * Ids are compared across kinds rather than within one. A role id and a channel id can
 * never collide in practice, and scoping the set per kind would be a filter with no
 * effect that the next reader has to prove is harmless.
 */
function idsClaimedByOtherRows(
    declared: readonly ResourceDeclaration[],
    exceptKey?: string
): ReadonlySet<string> {
    return new Set(
        declared
            .filter((resource) => resource.key !== exceptKey)
            // `flatMap` over an assertion: an absent id contributes nothing rather
            // than being filtered and then re-asserted as present.
            .flatMap((resource) => resource.adoptDiscordId ?? [])
    );
}

/**
 * Something in the guild a declaration can be pointed at.
 *
 * Structural rather than `GuildChannel | GuildRole` because this is the whole of what
 * adoption reads: an id to bind to and a name to seed from. Naming the two wire shapes
 * would make every future field on either of them look like something adoption might
 * depend on, and would have to be widened again for the next kind.
 */
export interface AdoptableTarget {
    readonly id: string;
    readonly name: string;
}

export interface AdoptedResourceInput {
    /**
     * The channel **or role** being adopted.
     *
     * Was `channel`, and renaming it is the point: a role declaration adopting a role
     * went through this function reading a field that said otherwise.
     */
    readonly target: AdoptableTarget;
    readonly kind: ResourceKind;
    /** The rows already declared, so the derived key does not collide with one. */
    readonly existing: readonly ResourceDeclaration[];
    /** The category this sits under, when the operator chose one. */
    readonly parentKey?: string | null;
}

/**
 * Build the declaration for adopting something that already exists.
 *
 * The name and key are seeded from the target, because the UI already knows them and
 * making the operator retype what is on screen is the complaint this exists to answer.
 * Both stay editable afterwards — the key is identity, and an operator may want their
 * own regardless of what the channel or role happens to be called today.
 */
export function declarationForAdoptedResource(
    input: AdoptedResourceInput
): ResourceDeclaration {
    const { target, kind, existing, parentKey } = input;

    const declaration: ResourceDeclaration = {
        key: uniqueResourceKey(slugifyResourceName(target.name), existing),
        kind,
        defaultName: target.name,
        adoptDiscordId: target.id,
    };

    // Only carried when the kind can actually hold one — see `parentKindFor`.
    if (parentKey && parentKindFor(kind)) {
        declaration.parentKey = parentKey;
    }

    return declaration;
}

/**
 * The name a row gets when someone types into it while it is adopted: **only what they
 * typed**, never the label it was typed into.
 *
 * An adopted row's field shows the adopted object's label — `#rules`, or
 * `#general · in Support` — because that is what identifies it. The label is decoration,
 * not a name, so editing it in place produced names like `#rulesx` and
 * `#general-·-in-supportx`. Typing on an adopted row now means starting over: `x` gives
 * `x`, and a deletion gives an empty field, which is the search-everything state.
 *
 * The input only reports its whole new value, so what was typed is recovered by
 * comparing that value with `shown`, what the field held before:
 *
 *  - **An insertion** — typing or pasting with nothing selected — is exact. The caret
 *    sits just after the inserted text and the growth in length says how much there
 *    was, so the segment is sliced out directly. This is the common case.
 *  - **Anything else** (a selection replaced, a deletion) takes what lies between the
 *    longest shared prefix and the longest shared suffix. For a deletion that is empty,
 *    which is the intended result. For a replacement, a run of repeated characters at
 *    its edge can shift where the segment is read from. The length is still right, and
 *    the operator sees the result straight away.
 */
export function nameTypedOverAdoption(input: {
    /** What the field showed before the keystroke: the adopted label. */
    readonly shown: string;
    /** What the field holds now. */
    readonly next: string;
    /** The caret after the keystroke, when the input could report it. */
    readonly caret: number | null;
}): string {
    const { shown, next, caret } = input;
    const grownBy = next.length - shown.length;

    if (caret !== null && grownBy > 0 && caret >= grownBy) {
        const start = caret - grownBy;
        if (next.slice(0, start) + next.slice(caret) === shown) return next.slice(start, caret);
    }

    let prefix = 0;
    while (prefix < shown.length && prefix < next.length && shown[prefix] === next[prefix]) {
        prefix += 1;
    }
    let suffix = 0;
    while (
        suffix < shown.length - prefix &&
        suffix < next.length - prefix &&
        shown[shown.length - 1 - suffix] === next[next.length - 1 - suffix]
    ) {
        suffix += 1;
    }
    return next.slice(prefix, next.length - suffix);
}

export interface NewResourceInput {
    readonly name: string;
    readonly kind: ResourceKind;
    readonly existing: readonly ResourceDeclaration[];
    readonly parentKey?: string | null;
}

/** The name a fresh row of this kind is seeded with, so it is valid the moment it exists. */
function generatedNameFor(kind: ResourceKind): string {
    switch (kind) {
        case 'textChannel':
            return 'new-channel';
        case 'category':
            return 'new-category';
        case 'role':
            return 'new-role';
        // A label, read in a list of ticket types, so it reads like one.
        case 'ticketType':
            return 'New ticket type';
        // Only the dashboard shows a message's name, so it reads like a label too.
        case 'message':
            return 'New message';
        default: {
            const unreachable: never = kind;
            throw new Error(`Unhandled resource kind: ${String(unreachable)}`);
        }
    }
}

/**
 * Build the declaration for a resource that does not exist yet.
 *
 * A ticket type also gets the settings it would be created with — the same starting
 * arrangement the tickets page offers a new type, so neither surface hands out a type
 * whose channel nobody can see.
 *
 * A message gets one embed titled with its name, so it can be saved the moment it is added
 * (an empty message is refused), and goes in the first declared text channel when no
 * parent is given — a message is almost always added for a channel already on the list.
 */
export function declarationForNewResource(input: NewResourceInput): ResourceDeclaration {
    const { kind, existing } = input;
    const name = input.name.trim() || generatedNameFor(kind);
    const parentKey =
        input.parentKey ??
        (kind === 'message' ? existing.find((resource) => resource.kind === 'textChannel')?.key : undefined);

    const declaration: ResourceDeclaration = {
        key: uniqueResourceKey(slugifyResourceName(name), existing),
        kind,
        defaultName: name,
    };

    if (parentKey && parentKindFor(kind)) {
        declaration.parentKey = parentKey;
    }

    if (kind === 'ticketType') {
        const { nameTemplate, permissions, autoClaimOnOpen } = emptyTicketTypeDraft();
        declaration.ticketType = { nameTemplate, permissions, autoClaimOnOpen };
    }

    if (kind === 'message') {
        declaration.message = { embeds: [{ title: name }] };
    }

    return declaration;
}
