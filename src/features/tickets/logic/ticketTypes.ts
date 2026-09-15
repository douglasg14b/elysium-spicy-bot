import { PermissionsBitField } from 'discord.js';
import type { TicketType } from '../data/ticketsSchema';

/**
 * Who gets what on a ticket channel, declared once per role a person can play.
 *
 * Lifted to data rather than written inline at each site because the old code
 * expressed its permission intent three times — at creation, at close, at reopen
 * — and the three had already drifted: `createTicketChannel` denied `@everyone`
 * explicitly while `reopenTicketChannel` reset it to inherit, so a reopened
 * ticket was *more* permissive than the same ticket when new, and whether that
 * mattered depended on which category it landed in.
 *
 * With the arrangement declared per type, adding verification cannot quietly
 * lose the rule that a type's model is enforced by the type — there is no third
 * branch to forget.
 */
export interface TicketRolePermissions {
    readonly view: boolean;
    readonly send: boolean;
    readonly readHistory: boolean;
    readonly manageMessages: boolean;
}

/**
 * The permission model for one ticket type.
 *
 * `subject` is who the ticket is about, `opener` whoever filed it (absent when a
 * flow did), `staff` the configured moderation roles. `everyone` is always a
 * denial; it is named rather than assumed so the drift above stays impossible to
 * reintroduce.
 */
export interface TicketPermissionModel {
    readonly subject: TicketRolePermissions;
    readonly opener: TicketRolePermissions;
    readonly staff: TicketRolePermissions;
}

export interface TicketTypeDefinition {
    readonly type: TicketType;
    readonly label: string;
    /**
     * Channel name template. `{{####}}` is the zero-padded ticket number,
     * `{{subject}}` and `{{opener}}` the usernames.
     *
     * Per type because §5.6 requires it and because the previous single
     * hardcoded constant is what made the old channel-name regex — and every
     * predicate built on it — blind to any ticket that was not a support ticket.
     */
    readonly nameTemplate: string;
    readonly permissions: TicketPermissionModel;
    /**
     * Whether opening auto-claims to the opener.
     *
     * True for support, because a moderator filing a ticket about someone is
     * already handling it. False for verification: a flow opens it and no human
     * has picked it up yet, which is exactly the state the old model could not
     * represent since creation always auto-claimed.
     */
    readonly autoClaimOnOpen: boolean;
}

const STAFF_PERMISSIONS: TicketRolePermissions = {
    view: true,
    send: true,
    readHistory: true,
    manageMessages: true,
};

const PARTICIPANT_PERMISSIONS: TicketRolePermissions = {
    view: true,
    send: true,
    readHistory: true,
    manageMessages: false,
};

const TICKET_TYPE_DEFINITIONS: Readonly<Record<TicketType, TicketTypeDefinition>> = {
    support: {
        type: 'support',
        label: 'Support',
        nameTemplate: 'S{{####}}-{{subject}}-{{opener}}',
        permissions: {
            subject: PARTICIPANT_PERMISSIONS,
            opener: { ...PARTICIPANT_PERMISSIONS, manageMessages: true },
            staff: STAFF_PERMISSIONS,
        },
        autoClaimOnOpen: true,
    },
    verification: {
        type: 'verification',
        label: 'Verification',
        nameTemplate: 'V{{####}}-{{subject}}',
        permissions: {
            subject: PARTICIPANT_PERMISSIONS,
            opener: PARTICIPANT_PERMISSIONS,
            staff: STAFF_PERMISSIONS,
        },
        autoClaimOnOpen: false,
    },
};

export function getTicketTypeDefinition(type: TicketType): TicketTypeDefinition {
    return TICKET_TYPE_DEFINITIONS[type];
}

/**
 * Turns a declared permission arrangement into the bitfield pair Discord wants.
 *
 * Every flag is stated in exactly one of `allow` or `deny` rather than left
 * unset, so a channel's effective permissions come from the type definition and
 * not from whichever category it happens to be sitting in. That is the specific
 * bug this replaces: a reopened ticket inheriting `@everyone` visibility from
 * its parent.
 */
export function toPermissionOverwrite(permissions: TicketRolePermissions): {
    allow: bigint[];
    deny: bigint[];
} {
    const allow: bigint[] = [];
    const deny: bigint[] = [];

    const assign = (granted: boolean, flag: bigint): void => {
        if (granted) {
            allow.push(flag);
        } else {
            deny.push(flag);
        }
    };

    assign(permissions.view, PermissionsBitField.Flags.ViewChannel);
    assign(permissions.send, PermissionsBitField.Flags.SendMessages);
    assign(permissions.readHistory, PermissionsBitField.Flags.ReadMessageHistory);
    assign(permissions.manageMessages, PermissionsBitField.Flags.ManageMessages);

    return { allow, deny };
}

interface TicketChannelNameParams {
    readonly ticketNumber: number;
    readonly subjectName: string;
    readonly openerName: string | null;
}

/**
 * Builds a channel name from the type's template.
 *
 * Replaces `buildTicketChannelName`, which ignored the stored template entirely
 * and always used the one hardcoded support constant — while the config modal
 * presented the template as an editable field and silently discarded whatever
 * was typed into it.
 *
 * A template with no `{{opener}}` is how a flow-opened ticket names itself
 * without inventing a placeholder opener; any leftover separators from the
 * absent token are collapsed rather than left dangling.
 */
export function buildTicketChannelNameForType(
    type: TicketType,
    { ticketNumber, subjectName, openerName }: TicketChannelNameParams
): string {
    const sanitize = (name: string): string => name.replace(/[^a-z0-9-]/gi, '').toLowerCase();

    return getTicketTypeDefinition(type)
        .nameTemplate.replace('{{####}}', ticketNumber.toString().padStart(4, '0'))
        .replace('{{subject}}', sanitize(subjectName))
        .replace('{{opener}}', openerName ? sanitize(openerName) : '')
        .replace(/-+/g, '-')
        .replace(/-$/, '');
}
