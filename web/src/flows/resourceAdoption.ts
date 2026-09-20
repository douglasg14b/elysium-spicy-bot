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

import type { GuildChannel, ResourceDeclaration, ResourceKind } from '../api/types';

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
 * **Text channels only, and the reason is the endpoint, not the model.**
 * `GET /:guildId/channels` returns text channels alone (`guildRoutes.ts`,
 * `textChannels`), so the list holds nothing a category or a role could adopt.
 * Offering it under "Category" was worse than offering nothing: the picker showed
 * `#general` beside the label "Which category", the declaration passed Zod and
 * `validateJourneyDeclaration`, and the failure landed mid-apply in
 * `requireAdoptable` — after earlier resources were really created.
 *
 * The install model itself adopts all three kinds perfectly well. Widening this needs
 * the endpoint to return `type` so categories and roles can be listed separately;
 * until then the honest answer is that they cannot be picked here.
 */
export function canAdoptFromChannelList(kind: ResourceKind): boolean {
    return kind === 'textChannel';
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

    const claimed = new Set(
        declared
            .filter((resource) => resource.key !== exceptKey)
            // `flatMap` over an assertion: an absent id contributes nothing rather
            // than being filtered and then re-asserted as present.
            .flatMap((resource) => resource.adoptDiscordId ?? [])
    );

    return channels
        .filter((channel) => !claimed.has(channel.id))
        .map((channel) => ({ value: channel.id, label: `#${channel.name}` }));
}

export interface AdoptedResourceInput {
    readonly channel: GuildChannel;
    readonly kind: ResourceKind;
    /** The rows already declared, so the derived key does not collide with one. */
    readonly existing: readonly ResourceDeclaration[];
    /** The category this sits under, when the operator chose one. */
    readonly parentKey?: string | null;
}

/**
 * Build the declaration for adopting a channel that already exists.
 *
 * The name and key are seeded from the channel, because the UI already knows them and
 * making the operator retype what is on screen is the complaint this exists to answer.
 * Both stay editable afterwards — the key is identity, and an operator may want their
 * own regardless of what the channel happens to be called today.
 */
export function declarationForAdoptedChannel(
    input: AdoptedResourceInput
): ResourceDeclaration {
    const { channel, kind, existing, parentKey } = input;

    const declaration: ResourceDeclaration = {
        key: uniqueResourceKey(slugifyResourceName(channel.name), existing),
        kind,
        defaultName: channel.name,
        adoptDiscordId: channel.id,
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
