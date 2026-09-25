import { ChannelType, type Guild, type GuildBasedChannel } from 'discord.js';

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
}

export const GUILD_CHANNEL_KEYS = [
    'id',
    'name',
    'type',
    'parentId',
    'parentName',
] as const satisfies readonly (keyof GuildChannelBody)[];

export interface GuildRoleBody {
    readonly id: string;
    readonly name: string;
    readonly color: number;
    readonly position: number;
}

export const GUILD_ROLE_KEYS = [
    'id',
    'name',
    'color',
    'position',
] as const satisfies readonly (keyof GuildRoleBody)[];

type KeyListsComplete =
    | Exclude<keyof GuildChannelBody, (typeof GUILD_CHANNEL_KEYS)[number]>
    | Exclude<keyof GuildRoleBody, (typeof GUILD_ROLE_KEYS)[number]>;

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
 */
export function guildChannelBodies(guild: Guild): GuildChannelBody[] {
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
                } satisfies GuildChannelBody,
            ];
        })
        .sort((left, right) => left.name.localeCompare(right.name));
}
