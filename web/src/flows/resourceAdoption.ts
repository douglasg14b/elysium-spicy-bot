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
 * twice. The panel around it is layout, and the repo tests `.ts` logic modules rather
 * than rendering components (see `cardSummary.ts`, `variables.ts`).
 */

import type {
    GuildChannel,
    GuildChannelType,
    GuildRole,
    ResourceDeclaration,
    ResourceKind,
} from '../api/types';

/**
 * Derive a key from a display name.
 *
 * Keys must be slug-shaped — the server rejects anything else — and asking an operator
 * to invent one alongside a name is asking them to understand why the distinction
 * exists. They can still edit it: a key is permanent in a way a name is not, so it
 * stays visible rather than hidden.
 */
export function slugifyResourceName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}

/**
 * Make a key unique within a list by suffixing it.
 *
 * A duplicate key is rejected by the server, and silently renaming the operator's
 * resource would be worse than a suffix they can see and edit.
 */
export function uniqueResourceKey(
    desired: string,
    existing: readonly ResourceDeclaration[]
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
    /** `#name`, so it reads the way Discord shows it. */
    label: string;
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
 * Exhaustive on `ResourceKind` so a fourth kind cannot be added without deciding this.
 */
export function canAdopt(kind: ResourceKind): boolean {
    switch (kind) {
        case 'textChannel':
        case 'category':
        case 'role':
            return true;
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
 * Whether a kind can be placed inside a category.
 *
 * Text channels only, and stricter than the server's own check on purpose.
 * `validateJourneyDeclaration` rejects a *role* with a parent but accepts a
 * *category* with one — and then `applyInstallPlan`'s category branch creates with no
 * `parent` argument at all, so the parent is stored and silently ignored. Offering
 * the control for a category is a form with no effect.
 *
 * One predicate rather than three inline `kind !== 'role'` checks, so a fourth kind
 * cannot answer this differently in the panel than in the declaration builders.
 */
export function canHaveParent(kind: ResourceKind): boolean {
    return kind === 'textChannel';
}

/**
 * The existing channels a new declaration may adopt.
 *
 * Channels already claimed by another row are **left out** rather than shown and
 * rejected on save. Two resources adopting one channel is refused by
 * `validateJourneyDeclaration`, and an option that can only produce an error is worse
 * than no option — the operator picks it, the save fails, and nothing in the picker
 * said why.
 */
export function adoptableChannelOptions(
    channels: readonly GuildChannel[],
    kind: ResourceKind,
    declared: readonly ResourceDeclaration[],
    /** The row being edited, whose own adoption must stay selectable. */
    exceptKey?: string
): ExistingChannelOption[] {
    if (!canAdoptFromChannelList(kind)) return [];

    const claimed = idsClaimedByOtherRows(declared, exceptKey);

    // Filtered by *type* as well as by claim: a declaration asking for a category must
    // not be offered a text channel, which is precisely the mismatch that used to
    // survive validation and fail mid-apply.
    const allowedTypes = new Set<GuildChannelType>(adoptableTypesFor(kind));

    return channels
        .filter((channel) => allowedTypes.has(channel.type) && !claimed.has(channel.id))
        .map((channel) => ({ value: channel.id, label: channelOptionLabel(channel) }));
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
 */
export function adoptableRoleOptions(
    roles: readonly GuildRole[],
    kind: ResourceKind,
    declared: readonly ResourceDeclaration[],
    exceptKey?: string
): ExistingChannelOption[] {
    if (kind !== 'role') return [];

    const claimed = idsClaimedByOtherRows(declared, exceptKey);

    return roles
        .filter((role) => !claimed.has(role.id))
        .map((role) => ({ value: role.id, label: roleOptionLabel(role) }));
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

    // Only carried when the kind can actually hold one — see `canHaveParent`.
    if (parentKey && canHaveParent(kind)) {
        declaration.parentKey = parentKey;
    }

    return declaration;
}

export interface NewResourceInput {
    readonly name: string;
    readonly kind: ResourceKind;
    readonly existing: readonly ResourceDeclaration[];
    readonly parentKey?: string | null;
}

/** Build the declaration for a resource that does not exist yet. */
export function declarationForNewResource(input: NewResourceInput): ResourceDeclaration {
    const { kind, existing, parentKey } = input;
    const name = input.name.trim() || `new-${kind === 'textChannel' ? 'channel' : kind}`;

    const declaration: ResourceDeclaration = {
        key: uniqueResourceKey(slugifyResourceName(name), existing),
        kind,
        defaultName: name,
    };

    if (parentKey && canHaveParent(kind)) {
        declaration.parentKey = parentKey;
    }

    return declaration;
}
