import { Collection, PermissionsBitField, type Guild, type GuildEmoji, type GuildTextBasedChannel, type Role } from 'discord.js';

/** A role the fake guild holds: an id, plus whatever a test needs to say about it. */
export interface FakeRoleInput {
    readonly id: string;
    readonly name?: string;
    readonly managed?: boolean;
    /** Permission bits the role carries, e.g. `PermissionFlagsBits.Administrator`. */
    readonly permissions?: bigint;
}

/**
 * A guild holding just the roles and channels a test names (and no emoji), in the caches flows
 * read them from — so a block or a save-time check resolving an id against "this server" finds
 * exactly these and nothing else.
 *
 * Channels are passed in as whatever the test already built (a `{ send }` mock, usually);
 * each is given the two narrowing methods `asGuildTextChannel` asks, unless it carries its
 * own.
 */
export function fakeGuild(options: {
    readonly id?: string;
    /** What `{{guild.name}}` renders as. */
    readonly name?: string;
    readonly roles?: readonly FakeRoleInput[];
    readonly channels?: Readonly<Record<string, object>>;
    /**
     * Channels of this guild the cache does not hold — archived threads — which
     * `channels.fetch` still finds. Any other id it refuses, as discord.js does for a
     * channel that is not this guild's.
     */
    readonly uncachedChannels?: Readonly<Record<string, object>>;
}): Guild {
    const id = options.id ?? 'guild-1';
    const roles = new Map<string, Role>(
        (options.roles ?? []).map((role) => [
            role.id,
            {
                id: role.id,
                name: role.name ?? role.id,
                managed: role.managed ?? false,
                permissions: new PermissionsBitField(role.permissions ?? 0n),
            } as unknown as Role,
        ])
    );
    const asChannels = (entries: Readonly<Record<string, object>>): Map<string, GuildTextBasedChannel> =>
        new Map(
            Object.entries(entries).map(([channelId, channel]) => [
                channelId,
                { id: channelId, isDMBased: () => false, isTextBased: () => true, ...channel } as unknown as GuildTextBasedChannel,
            ])
        );
    const channels = asChannels(options.channels ?? {});
    const uncached = asChannels(options.uncachedChannels ?? {});
    const fetch = async (channelId: string): Promise<GuildTextBasedChannel> => {
        const channel = channels.get(channelId) ?? uncached.get(channelId);
        if (!channel) throw new Error(`Unknown Channel ${channelId}`);
        return channel;
    };

    // No emoji of its own: a posted message's buttons are checked against this cache
    // (`serverEmojiIds`), as a real guild's are, and a fake guild's buttons use none.
    const emojis = new Collection<string, GuildEmoji>();

    return {
        id,
        name: options.name,
        roles: { cache: roles },
        channels: { cache: channels, fetch },
        emojis: { cache: emojis },
    } as unknown as Guild;
}
