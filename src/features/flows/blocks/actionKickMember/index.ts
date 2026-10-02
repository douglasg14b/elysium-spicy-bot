import { DiscordAPIError, PermissionFlagsBits, RESTJSONErrorCodes, type Guild, type GuildMember } from 'discord.js';
import { z } from 'zod';
import type { BlockManifest } from '../manifest';

export const ACTION_KICK_MEMBER = 'action.kickMember';

/** Discord's cap on an audit-log reason. */
export const KICK_REASON_MAX_LENGTH = 512;

export const kickMemberConfigSchema = z.object({
    reason: z.string().min(1).max(KICK_REASON_MAX_LENGTH).optional(),
});

export type KickMemberConfig = z.infer<typeof kickMemberConfigSchema>;

/**
 * Kick the run's member out of the server.
 *
 * **Already gone carries on.** The member is fetched fresh right before the kick —
 * not read from the run, which may have parked for days — and a member Discord no
 * longer knows counts as kicked. So does one who leaves between that fetch and the
 * kick itself. Either way the rest of the flow still runs.
 *
 * **A refused kick fails by name.** When discord.js says the member is not kickable,
 * the run fails saying which of Discord's reasons applies, rather than letting the
 * API answer with a bare 50013.
 */
export const block: BlockManifest<KickMemberConfig> = {
    type: ACTION_KICK_MEMBER,
    kind: 'action',
    label: 'Kick Member',
    description: 'Show them the door. They can come back with an invite — this is a kick, not a ban.',
    group: 'actions',
    icon: '👢',
    configSchema: kickMemberConfigSchema,
    configFields: [
        {
            key: 'reason',
            label: 'Reason',
            description: "Lands in the server's audit log, not in front of them. Leave empty for none.",
            control: 'text',
            optional: true,
            placeholder: 'Ghosted us one time too many',
            // No `maxLength` here, deliberately: the executor would refuse a reason
            // that renders past it and fail the node, so a long display name in a
            // token could stop the kick. The schema caps what the author types; the
            // rendered text is trimmed to Discord's limit in `run` instead.
            rendersTokens: true,
        },
    ],
    cardSummary: [{ text: 'Boot them' }, { key: 'reason', prefix: ' · ', quote: true, truncate: 24, hideWhenEmpty: true }],
    note:
        'Send any DM before this block, not after — once they share no server with the bot, the DM bounces. ' +
        'Someone who has already left counts as kicked, so the rest of the flow still runs.',
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: ['subject'],
    capabilities: ['kickMembers'],
    canSuspend: false,
    async run(config, context) {
        const member = await fetchIfStillHere(context.guild, context.subject.id);
        if (!member) {
            return { kind: 'continue' };
        }

        if (!member.kickable) {
            return { kind: 'fail', error: whyNotKickable(member) };
        }

        try {
            await member.kick(auditReason(config.reason));
        } catch (error) {
            // They left in the moment between the fetch and the kick.
            if (isUnknownMember(error)) {
                return { kind: 'continue' };
            }
            throw error;
        }

        return { kind: 'continue' };
    },
};

/**
 * The member as Discord holds them now, or null if they are no longer in the server.
 *
 * `force` because the cache may still hold someone who has left, and a cached member
 * would make the kick a 404 the block then has to interpret anyway.
 */
async function fetchIfStillHere(guild: Guild, userId: string): Promise<GuildMember | null> {
    try {
        return await guild.members.fetch({ user: userId, force: true });
    } catch (error) {
        if (isUnknownMember(error)) {
            return null;
        }
        throw error;
    }
}

/**
 * The rendered reason, cut to Discord's audit-log limit. By code point, so a trim never
 * splits an emoji into half a surrogate pair.
 */
function auditReason(reason: string | undefined): string | undefined {
    return reason === undefined ? undefined : [...reason].slice(0, KICK_REASON_MAX_LENGTH).join('');
}

function isUnknownMember(error: unknown): boolean {
    return error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMember;
}

/**
 * Which of Discord's reasons stops this kick, worded for whoever reads the run log.
 *
 * Mirrors what `GuildMember.kickable` checks: not the owner, not the bot itself, the
 * bot holds Kick Members, and the bot's highest role outranks theirs.
 */
function whyNotKickable(member: GuildMember): string {
    const { guild } = member;
    const name = member.user.username;

    if (member.id === guild.ownerId) {
        return `${name} owns the server, and nobody kicks the owner.`;
    }
    if (member.id === guild.client.user.id) {
        return 'Kick Member was pointed at the bot itself, and it declines to leave.';
    }
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.KickMembers)) {
        return `The bot lacks the Kick Members permission, so ${name} stays.`;
    }
    return (
        `${name}'s highest role ranks at or above the bot's, so Discord won't let it kick them. ` +
        "Move the bot's role above theirs."
    );
}
