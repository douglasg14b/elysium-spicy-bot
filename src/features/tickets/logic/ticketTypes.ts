import { PermissionsBitField } from 'discord.js';
import type {
    TicketingConfig,
    TicketPermissionModel,
    TicketRolePermissions,
    TicketTypeDefinition,
} from '../data/ticketingSchema';

/**
 * The type-shaped rules that need discord.js, and the lookup into a guild's own
 * declarations.
 *
 * `TicketRolePermissions`, `TicketPermissionModel` and `TicketTypeDefinition`
 * moved to `data/ticketingSchema.ts` when types became a persisted JSON member —
 * `logic/` must not own a column's type — and the two permission presets moved to
 * `data/defaultTicketTypes.ts`, which the migration reads. They are re-exported
 * here so existing importers of this module keep working.
 */
export type { TicketPermissionModel, TicketRolePermissions, TicketTypeDefinition };
export { DEFAULT_TICKET_TYPES, PARTICIPANT_PERMISSIONS, STAFF_PERMISSIONS } from '../data/defaultTicketTypes';

/**
 * A guild's declaration for one ticket type, or `undefined` when it has none.
 *
 * **Synchronous, and it stays that way.** `config` is a JSON column that arrives
 * whole in one read, and every caller already holds the entity: the four button
 * handlers get it from `resolveTicketAction`'s `TicketActionContext.config`, and
 * both open paths read it to create the channel. Making this async would push
 * `await` through `buildTicketEmbed` and `buildTicketButtons` — two pure render
 * functions — to fetch data the caller is already holding.
 *
 * Returns `undefined` rather than throwing or substituting a default. A ticket
 * whose type was deleted out from under it must fail *nameably* at the surface
 * that has somewhere to put the message, which is what
 * `root-cause-over-workarounds.md` means by "no silent alternates".
 *
 * **Absence is rare but not impossible, and not only via a hand-edited blob.**
 * `deleteTicketType` refuses while any ticket holds a type, but that check and the
 * write are two statements, so a ticket opened in the window between them lands on a
 * type that is then removed. A row written by a process older than the seed migration
 * is the other route. Both are exactly why there is no fallback: the caller says which
 * type is missing and stops, rather than re-permissioning a real channel from a guess.
 */
export function getTicketTypeDefinition(
    config: TicketingConfig,
    type: string
): TicketTypeDefinition | undefined {
    return config.ticketTypes?.[type];
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

export interface TicketChannelNameParams {
    readonly ticketNumber: number;
    readonly subjectName: string;
    readonly openerName: string | null;
}

/**
 * Builds a channel name from the type's template.
 *
 * Takes the **definition**, not a type key plus a config: it needs only
 * `nameTemplate`, and threading a whole config through to read one string is the
 * context-tunneling `elegance.md` names. Renamed from
 * `buildTicketChannelNameForType` because it no longer takes a type.
 *
 * A template with no `{{opener}}` is how a flow-opened ticket names itself
 * without inventing a placeholder opener; any leftover separators from the
 * absent token are collapsed rather than left dangling.
 *
 * **`replaceAll`, not `replace`.** A string needle replaces only the *first*
 * occurrence, so `S{{####}}-{{subject}}-{{subject}}` used to render
 * `S0001-alice-{{subject}}` — and since Discord strips braces, the operator silently
 * got `s0001-alice-subject`. Templates are operator-authored free text now, which is
 * the whole point of this step, so that was reachable through the supported path: the
 * exact "accepted, stored, then silently mangled" class the phantom
 * `SUPPORT_TICKET_NAME_TEMPLATE` is being deleted for.
 */
export function buildTicketChannelName(
    definition: TicketTypeDefinition,
    { ticketNumber, subjectName, openerName }: TicketChannelNameParams
): string {
    const sanitize = (name: string): string => name.replace(/[^a-z0-9-]/gi, '').toLowerCase();

    return definition.nameTemplate
        .replaceAll('{{####}}', ticketNumber.toString().padStart(4, '0'))
        .replaceAll('{{subject}}', sanitize(subjectName))
        .replaceAll('{{opener}}', openerName ? sanitize(openerName) : '')
        .replace(/-+/g, '-')
        .replace(/-$/, '');
}
