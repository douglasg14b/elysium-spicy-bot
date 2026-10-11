import { ChannelType, type Guild, type GuildBasedChannel } from 'discord.js';
import {
    describeOwner,
    ownerOf,
    type BindingOwnerKind,
    type GuildOwnership,
} from '../../features/provisioning';

/**
 * The guild directory shapes the browser receives.
 *
 * Extracted from `guildRoutes.ts`'s inline `.map()` callbacks so the wire shape is a
 * named contract rather than something you discover by reading a request — the same
 * reason `driftBody.ts` and `publishedBody.ts` exist, and a precondition for the drift
 * gate, which needs an exported key list to compare against.
 *
 * ## Why `type` had to be added
 *
 * `GET /channels` used to return text channels only, as `{id, name}`. That made two
 * things impossible and one thing dangerous:
 *
 *  - **Two channels called `#general` were indistinguishable.** The operator picked one
 *    of two identical rows and found out later which.
 *  - **A category could not be adopted at all.** The install model adopts all three
 *    kinds; the picker could not offer what the endpoint never sent. (Roles were the
 *    same gap with a different cause — they come from `GET /roles`, and the panel
 *    simply never handed that list to a picker. `adoptableRoleOptions` closes it.)
 *  - And the *absence* of a type was load-bearing in a place nobody had written down:
 *    `ChannelPickerControl` maps every channel it is given into "somewhere to post",
 *    with a comment claiming categories are excluded. They were — by this endpoint's
 *    filter, two files away. Sending categories without giving the browser a way to
 *    tell them apart would have offered a category as a place to post a message, which
 *    fails at runtime in a live guild after publish.
 *
 * So `type` is **required**, not optional. A consumer that must not offer a category
 * now has a field to filter on, and adding the field as required is what makes every
 * existing `.map()` over a channel list a place the compiler points at.
 */

/**
 * The channel kinds this endpoint reports.
 *
 * A closed vocabulary rather than discord.js's numeric `ChannelType`, because the
 * browser must not carry a copy of that enum and only these two mean anything to a
 * flow or a declaration. Everything else — voice, stage, forum, thread — is filtered
 * out rather than labelled, since nothing in the product can target one.
 *
 * ## Why announcement channels are not in this list
 *
 * They were, briefly, and it was wrong — not because an announcement channel is
 * unusable, but because **this endpoint is not where that question gets answered.**
 * Three places already disagreed about which channels a flow may use:
 *
 *  - `actionSendMessage` / `actionPostEmbed` ask `isTextBased() && 'send' in channel`,
 *    a capability check an announcement channel passes.
 *  - `deployFlowButtons` refuses anything but `ChannelType.GuildText`.
 *  - `existsInGuildAs`, which gates adoption, does the same.
 *
 * Listing `announcement` here added a *fourth* opinion and matched none of them: the
 * picker offered one, the declaration passed every save-time check, and the apply threw
 * in `requireAdoptable` after earlier resources had really been created — the
 * half-applied state the up-front validation exists to prevent.
 *
 * The directory now reports what the strictest consumer accepts. Widening it again
 * means first giving the product one answer to "may a flow use this channel?" and making
 * all three sites ask it; until then, a type this endpoint does not send is a type no
 * picker can offer, which is the honest failure.
 */
export const GUILD_CHANNEL_TYPES = ['text', 'category'] as const;
export type GuildChannelType = (typeof GUILD_CHANNEL_TYPES)[number];

/**
 * Who already holds a channel, category or role: a journey, or the ticket system.
 *
 * `kind` and `key` let a picker tell its *own* holdings (the journey being edited) from
 * someone else's; `label` is how the operator is told, written server-side so every
 * surface names an owner the same way ("the ticket system", `journey "Onboarding"`).
 *
 * **One owner, the first in `(kind, key)` order.** Two can hold an object only through a
 * cross-claim from before the one-owner rule (the 2026-10-10 migration logs them). There
 * a picker may judge it by the wrong one; the server, which excludes the asker, decides.
 */
export interface GuildObjectOwnerBody {
    readonly kind: BindingOwnerKind;
    readonly key: string;
    readonly label: string;
}

export interface GuildChannelBody {
    readonly id: string;
    readonly name: string;
    readonly type: GuildChannelType;
    /** The category this sits in, or null at the top level. Always null for a category. */
    readonly parentId: string | null;
    /**
     * The category's name, resolved here rather than in the browser.
     *
     * The browser holds the same list and could look it up, but only after the whole
     * list has loaded and only if the parent is in it — and the parent is filtered out
     * of nothing today, which is exactly the kind of "true for now" the endpoint should
     * not make a caller depend on. Sending the name makes a row self-describing.
     */
    readonly parentName: string | null;
    /**
     * The owner holding a settled binding for this channel, or null when nobody does.
     *
     * A category or channel belongs to one owner (2026-10-10), so the pickers disable one
     * held by somebody else rather than offering an adoption the server refuses. Null for
     * an object only an `intended` row names — that row has no id yet.
     */
    readonly owner: GuildObjectOwnerBody | null;
}

export const GUILD_CHANNEL_KEYS = [
    'id',
    'name',
    'type',
    'parentId',
    'parentName',
    'owner',
] as const satisfies readonly (keyof GuildChannelBody)[];

/** Gated by shape as well as by name, as `TICKET_ROLE_PERMISSIONS_KEYS` is one level down. */
export const GUILD_OBJECT_OWNER_KEYS = ['kind', 'key', 'label'] as const satisfies readonly (keyof GuildObjectOwnerBody)[];

export interface GuildRoleBody {
    readonly id: string;
    readonly name: string;
    readonly color: number;
    readonly position: number;
    /**
     * The owner holding a settled binding for this role, or null — as on a channel. A
     * journey can bind a role, and the install plan refuses to adopt one another owner
     * holds, so the role picker has to know too or it offers what install will block.
     */
    readonly owner: GuildObjectOwnerBody | null;
}

export const GUILD_ROLE_KEYS = [
    'id',
    'name',
    'color',
    'position',
    'owner',
] as const satisfies readonly (keyof GuildRoleBody)[];

/** The wire shape for guild settings, as every settings route answers it. */
export interface GuildSettingsBody {
    readonly staffRoleIds: string[];
    readonly staffRoles: { id: string; name: string }[];
    /** The picked zone (an IANA name), `null` until someone picks one. */
    readonly timeZone: string | null;
    /** What an unpicked zone means, so the dashboard can say so without its own copy. */
    readonly defaultTimeZone: string;
}

export const GUILD_SETTINGS_KEYS = [
    'staffRoleIds',
    'staffRoles',
    'timeZone',
    'defaultTimeZone',
] as const satisfies readonly (keyof GuildSettingsBody)[];

type KeyListsComplete =
    | Exclude<keyof GuildChannelBody, (typeof GUILD_CHANNEL_KEYS)[number]>
    | Exclude<keyof GuildObjectOwnerBody, (typeof GUILD_OBJECT_OWNER_KEYS)[number]>
    | Exclude<keyof GuildRoleBody, (typeof GUILD_ROLE_KEYS)[number]>
    | Exclude<keyof GuildSettingsBody, (typeof GUILD_SETTINGS_KEYS)[number]>;

/**
 * Do not delete as unused: removing this erases the guards above.
 *
 * The tuple wrapper is load-bearing — a bare `extends never` distributes over the union
 * and is vacuously true for an empty one. See `ticketRoutes.ts` for the full reasoning.
 */
type _KeyListsAreComplete = [KeyListsComplete] extends [never] ? true : never;
const _keyListsAreComplete: _KeyListsAreComplete = true;
void _keyListsAreComplete;

/**
 * Which of a channel's types the browser is told about, or `undefined` to omit it.
 *
 * Announcement channels fall through to `undefined` along with voice, stage and forum.
 * That is deliberate and is **not** a claim that a flow could not post in one — see the
 * note on `GUILD_CHANNEL_TYPES`. It is that provisioning and button deployment both
 * refuse anything but `GuildText`, and a directory that offers what those two reject
 * produces a declaration that fails after the apply has already started.
 */
function channelTypeOf(channel: GuildBasedChannel): GuildChannelType | undefined {
    switch (channel.type) {
        case ChannelType.GuildText:
            return 'text';
        case ChannelType.GuildCategory:
            return 'category';
        default:
            return undefined;
    }
}

/**
 * The guild's channels, as the directory reports them.
 *
 * Sorted by name for stable display, as before. Categories now appear alongside
 * channels rather than being filtered out — every consumer that must not treat one as
 * postable filters on `type`, which is the point of sending it.
 *
 * `ownership` is the guild's bindings, read once by the route, so each channel's `owner`
 * costs no query of its own.
 */
export function guildChannelBodies(guild: Guild, ownership: GuildOwnership): GuildChannelBody[] {
    const channels = [...guild.channels.cache.values()];
    const nameById = new Map(channels.map((channel) => [channel.id, channel.name]));

    return channels
        .flatMap((channel) => {
            const type = channelTypeOf(channel);
            if (!type) return [];

            // A category has no parent of its own, and Discord reports `parentId` as
            // null for one anyway — stated rather than relied upon, because a category
            // claiming a parent would read as a nested category, which cannot exist.
            const parentId = type === 'category' ? null : channel.parentId ?? null;

            return [
                {
                    id: channel.id,
                    name: channel.name,
                    type,
                    parentId,
                    parentName: parentId ? nameById.get(parentId) ?? null : null,
                    owner: guildObjectOwner(ownership, channel.id),
                } satisfies GuildChannelBody,
            ];
        })
        .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Who holds a guild object, as the directory reports it — the one place a channel's or a
 * role's `owner` is built, so both name owners the same way.
 */
export function guildObjectOwner(ownership: GuildOwnership, discordId: string): GuildObjectOwnerBody | null {
    const owner = ownerOf(ownership.bindings, discordId);
    return owner ? { kind: owner.kind, key: owner.key, label: describeOwner(owner, ownership.journeyNames) } : null;
}
