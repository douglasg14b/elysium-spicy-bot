import type { TicketRolePermissions, TicketTypeDefinition } from './ticketingSchema';

/**
 * The two ticket types every guild starts with, and the presets they are built
 * from.
 *
 * **This file imports nothing but types, on purpose.** It is read by the
 * `2026-09-23-Add_Ticket_Identity_And_Types` migration as its seed value, and
 * `migrate.ts` dynamically `import()`s every file in the migrations directory
 * *before any migration runs* — so a value import reaching discord.js here would
 * drag the bot tree into `pnpm migrate:latest` and break every migration, not
 * just this one. `logic/ticketTypes.ts:1` imports `PermissionsBitField`, which is
 * why the presets live here and `logic/` imports them *from* here, never the
 * reverse. The migration imports this file by direct path, never through
 * `logic/index.ts`.
 *
 * It stopped being the runtime lookup table when types moved into
 * `ticketing_config.config`; it is now the seed, read by the migration and by
 * every path that creates a config row. One copy, so the seeded shape and the
 * TypeScript record cannot drift.
 */

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

export { PARTICIPANT_PERMISSIONS, STAFF_PERMISSIONS };

export const DEFAULT_TICKET_TYPES: Readonly<Record<string, TicketTypeDefinition>> = {
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

/**
 * A fresh, **deeply** independent copy of the seed, for writing into a new config row.
 *
 * `DEFAULT_TICKET_TYPES` is `Readonly`, and `TicketingConfig.ticketTypes` is a plain
 * mutable record because operators edit it. A shallow `{ ...DEFAULT_TICKET_TYPES }`
 * would not actually protect anything: the copy's `support` *is* the module object, and
 * both seeded types share the same `PARTICIPANT_PERMISSIONS` and `STAFF_PERMISSIONS`
 * objects. An editor that set `config.ticketTypes.support.label` before serializing
 * would rewrite the seed for every other caller in the process.
 *
 * `structuredClone` because the shape is plain JSON — no dates, no functions — so there
 * is nothing for it to choke on and nothing for a hand-rolled copy to get right.
 */
export function defaultTicketTypes(): Record<string, TicketTypeDefinition> {
    return structuredClone(DEFAULT_TICKET_TYPES) as Record<string, TicketTypeDefinition>;
}
