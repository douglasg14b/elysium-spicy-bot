import { ticketingRepo, type TicketingRepo } from '../data/ticketingRepo';
import type { TicketingConfig, TicketTypeDefinition } from '../data/ticketingSchema';
import { buildTicketChannelName } from './ticketTypes';
import { ticketTypeInUseRefusal, ticketTypeIsHeld, ticketTypeUsage, type TicketTypeUsageDeps } from './ticketTypeInUse';

/**
 * The one authority on adding, replacing and removing a guild's ticket types.
 *
 * Shaped after `warnings/logic/setWarningsModChannel.ts`: a discriminated result in
 * `logic/` with injectable deps, so a Discord surface and a web route share one
 * validator and one refusal rather than each growing their own. Two copies of a
 * refusal are two things to drift.
 */

export type SetTicketTypeResult = { ok: true; config: TicketingConfig } | { ok: false; message: string };

export interface SetTicketTypesDeps {
    readonly repo?: Pick<TicketingRepo, 'get' | 'update'>;
    readonly usage?: TicketTypeUsageDeps;
}

/** The only tokens `buildTicketChannelName` implements. Anything else is rejected by name. */
const SUPPORTED_TOKENS = ['####', 'subject', 'opener'] as const;

/** Discord's hard limit on a channel name. A template that cannot fit is rejected at save time. */
const CHANNEL_NAME_MAX_LENGTH = 100;

/**
 * The longest a username can be on Discord, used to test a template's worst case.
 *
 * 32 characters, and the sanitizer only ever shortens, so a template that fits two
 * 32-character names fits every real pair.
 */
const MAX_USERNAME_LENGTH = 32;

/**
 * The ticket number the worst-case probe uses.
 *
 * **Six digits, not four.** `{{####}}` is `padStart(4, '0')` — a minimum width, not a
 * cap — and `ticketNumberInc` is an unbounded `+1` counter. Probing at 9999 would accept
 * a template that fits in 100 characters today and renders 102 once a busy guild passes
 * six figures, at which point `channels.create` is rejected *after* the row and the
 * ticket number are already allocated, leaving a ticket with `channelId: null`.
 */
const MAX_TICKET_NUMBER = 999999;

type TemplateProblem = string | null;

/**
 * Whether a channel-name template is one `buildTicketChannelName` can actually
 * render.
 *
 * This is the collapse of the phantom-template defect: `S{{####}}-{{user}}-{{creator}}`
 * used tokens nothing implemented, and it was accepted, stored, displayed to
 * operators as the channel template, and then silently dropped. An unimplemented
 * token is now a refusal that names the token.
 *
 * Lives here rather than in a Zod schema because two of the three rules need the
 * renderer — the maximum expansion and the empty render are facts about
 * `buildTicketChannelName`, not about the string.
 */
function templateProblem(definition: TicketTypeDefinition): TemplateProblem {
    const tokens = [...definition.nameTemplate.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]);
    const unsupported = tokens.find((token) => !(SUPPORTED_TOKENS as readonly string[]).includes(token));
    if (unsupported) {
        return `\`{{${unsupported}}}\` is not a token this bot knows how to render. Use ${SUPPORTED_TOKENS.map(
            (token) => `\`{{${token}}}\``
        ).join(', ')} — nothing else, and no, wishing does not count.`;
    }

    // Rendered rather than measured, because the renderer collapses separators and
    // drops an absent opener — so the string's own length says nothing useful.
    const rendered = buildTicketChannelName(definition, {
        ticketNumber: 1,
        subjectName: 'subject',
        openerName: 'opener',
    });
    if (!rendered) {
        return 'That template renders to an empty channel name. Discord will not name a channel nothing, however minimalist.';
    }

    const longest = buildTicketChannelName(definition, {
        ticketNumber: MAX_TICKET_NUMBER,
        subjectName: 'a'.repeat(MAX_USERNAME_LENGTH),
        openerName: 'b'.repeat(MAX_USERNAME_LENGTH),
    });
    if (longest.length > CHANNEL_NAME_MAX_LENGTH) {
        return `At its longest that template renders ${longest.length} characters, and Discord caps a channel name at ${CHANNEL_NAME_MAX_LENGTH}. Trim it.`;
    }

    // Belt and braces, and it closes a class rather than a case: anything brace-shaped
    // surviving a full render is a token the renderer did not substitute. That catches
    // malformed spellings the token scan above cannot see — `{{subject}` has no closing
    // pair, so the regex never matches it, and Discord would strip the brace and leave
    // the operator with a channel named after the word "subject".
    if (/[{}]/.test(longest)) {
        return `That template still contains \`${longest.match(/\{+[^}]*\}*|\}+/)?.[0] ?? '{'}\` after rendering. Check the spelling — a token needs exactly two braces each side.`;
    }

    return null;
}

/**
 * Add or replace one ticket type.
 *
 * Validation lives here rather than in a Zod body schema for the two rules Zod
 * cannot see: that the guild has a config row at all, and that `nameTemplate` uses
 * only tokens the renderer implements.
 *
 * Writes by **spreading** the existing config and the existing type record, so a
 * save touches exactly the one type it names — the same discipline the config
 * modal needed after it was found silently dropping every member it did not list.
 */
export async function upsertTicketType(
    guildId: string,
    input: TicketTypeDefinition,
    deps?: SetTicketTypesDeps
): Promise<SetTicketTypeResult> {
    const repo = deps?.repo ?? ticketingRepo;

    const type = input.type.trim();
    if (!type) {
        return { ok: false, message: 'A ticket type needs a key. Blank is not a category of anything.' };
    }

    // The key reaches a channel name and a flow `select` value, so it is restricted
    // rather than merely non-blank.
    if (!/^[a-z0-9_-]+$/.test(type)) {
        return {
            ok: false,
            message: `\`${type}\` will not do as a key — lowercase letters, digits, \`-\` and \`_\` only. The label is where you get to be expressive.`,
        };
    }

    if (!input.label.trim()) {
        return { ok: false, message: 'Give the type a label — operators have to pick it out of a list.' };
    }

    // Normalized *once*, and the normalized value is what gets stored under the
    // normalized key. Validating a trimmed key and then storing the untrimmed one leaves
    // a type visible in the config that every lookup misses — and `type` living inside
    // the record as well as being its map key exists precisely so the two cannot
    // disagree.
    const definition: TicketTypeDefinition = { ...input, type, label: input.label.trim() };

    const problem = templateProblem(definition);
    if (problem) {
        return { ok: false, message: problem };
    }

    const existing = await repo.get(guildId);
    if (!existing?.config) {
        return {
            ok: false,
            message: 'This server has no ticket config yet. Deploy the ticket system first, then come back.',
        };
    }

    const config: TicketingConfig = {
        ...existing.config,
        ticketTypes: { ...existing.config.ticketTypes, [definition.type]: definition },
    };

    try {
        await repo.update({ guildId, config: JSON.stringify(config) });
        return { ok: true, config };
    } catch (error) {
        console.error('[tickets] Error saving ticket type:', error);
        return { ok: false, message: 'Could not save that ticket type. Try again in a second.' };
    }
}

/**
 * Remove a ticket type, unless tickets still reference it.
 *
 * The refusal is this function's, not the route's: a Discord config surface must
 * refuse for the same reason and with the same words.
 *
 * **Unconditional — no force flag and no confirmable override.** A type whose
 * definition is gone leaves `getTicketTypeDefinition` returning `undefined` for a
 * live ticket, and there is no correct behaviour at that point; a confirmable
 * override would make the promise conditional.
 */
export async function deleteTicketType(
    guildId: string,
    type: string,
    deps?: SetTicketTypesDeps
): Promise<SetTicketTypeResult> {
    const repo = deps?.repo ?? ticketingRepo;

    const existing = await repo.get(guildId);
    if (!existing?.config) {
        return {
            ok: false,
            message: 'This server has no ticket config yet, so there is nothing to delete.',
        };
    }

    const definition = existing.config.ticketTypes?.[type];
    if (!definition) {
        return { ok: false, message: `This server does not declare a ticket type called \`${type}\`.` };
    }

    const usage = await ticketTypeUsage(guildId, type, deps?.usage);
    if (ticketTypeIsHeld(usage)) {
        return { ok: false, message: ticketTypeInUseRefusal({ label: definition.label, type, usage }) };
    }

    const remaining = { ...existing.config.ticketTypes };
    delete remaining[type];

    const config: TicketingConfig = { ...existing.config, ticketTypes: remaining };

    try {
        await repo.update({ guildId, config: JSON.stringify(config) });
        return { ok: true, config };
    } catch (error) {
        console.error('[tickets] Error deleting ticket type:', error);
        return { ok: false, message: 'Could not delete that ticket type. Try again in a second.' };
    }
}
