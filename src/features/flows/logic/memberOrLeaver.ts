import type { Guild, GuildMember, PartialGuildMember } from 'discord.js';
import { isUnknownMember } from '../../../utils/isUnknownMember';

/** The member, or null when Discord says they are not in the guild. Any other failure throws. */
async function fetchUnlessGone(guild: Guild, userId: string): Promise<GuildMember | null> {
    try {
        return await guild.members.fetch(userId);
    } catch (error) {
        if (isUnknownMember(error)) {
            return null;
        }
        throw error;
    }
}

/**
 * A member a run is started about or by — a ticket's subject, whoever made a ticket change,
 * the member a block's post was about — even when they have left the server.
 *
 * A leaver is not skipped, as Level Reached skips: what happened still happened, and a flow
 * reacting to it — closing their other tickets, telling staff — needs no member to act on.
 * They get a **partial** member instead, the same object a Member Leaves run is handed for an
 * uncached leaver: an id and a user, no join date, no roles. Blocks that need a full member
 * then fail by name, as they already do on Member Leaves; copy that mentions them still
 * renders, since a mention needs only the id.
 *
 * discord.js has no public way to build that object, so this does exactly what its own
 * `GuildMemberRemove` action does when the `GuildMember` partial is enabled
 * (`client/actions/Action.js` → `getMember` → `manager._add`), with `false` so a member
 * who is not in the guild is never cached as though they were.
 *
 * Only Discord's `Unknown Member` makes someone a leaver; any other failure throws — a timeout
 * or a rate limit says nothing about whether someone left, so it must not turn a present
 * member into a leaver. A user Discord cannot fetch at all throws too.
 */
export async function memberOrLeaver(guild: Guild, userId: string): Promise<GuildMember | PartialGuildMember> {
    const member = await fetchUnlessGone(guild, userId);
    if (member) {
        return member;
    }

    // Fetched into the client's user cache, which `_add` relies on: it is handed only the
    // id, and the member's `user` is resolved from that cache — this fetch is what gives
    // the partial its name rather than a user with every field null.
    const user = await guild.client.users.fetch(userId, { cache: true });
    return guild.members['_add']({ user: { id: user.id } }, false);
}
