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

/**
 * Why a write was refused, as a value rather than a sentence.
 *
 * The route maps these onto status codes, and it needs a discriminator to do it: the
 * first version matched `message.includes('does not declare')` to choose 404 over 409,
 * and this feature already has **two** phrasings for that one concept — "does not
 * declare" here and "no longer declares" in `resolveTicketAction` — so unifying the copy
 * would have silently flipped a status code with the route tests still green, because
 * they mock the message string.
 *
 * `write-failed` is deliberately distinct from the state refusals: it is the database
 * being unavailable, not the operator being wrong, and answering 409 to it would tell a
 * caller to change something that is already correct.
 */
export type SetTicketTypeRefusal = 'no-config' | 'undeclared-type' | 'type-in-use' | 'invalid-input' | 'write-failed';

export type SetTicketTypeResult =
    | { ok: true; config: TicketingConfig }
    | { ok: false; reason: SetTicketTypeRefusal; message: string };

export interface SetTicketTypesDeps {
    readonly repo?: Pick<TicketingRepo, 'mutateConfig'>;
    readonly usage?: TicketTypeUsageDeps;
}

/**
 * Why both functions go through `mutateConfig` rather than `get` then `update`.
 *
 * `config` is one JSON blob holding every ticket setting, so editing a single type is
 * a whole-blob rewrite. Read-modify-write across two statements means two operators
 * saving at once — two browser tabs, or the dashboard and the Discord modal — each
 * write the blob they read, and the second silently discards the first. The window is
 * an HTTP round trip plus however long somebody spent filling in a form.
 *
 * The delete has a second race, and this closes it **partially** — stated plainly
 * because overstating it is worse than the gap. The in-use count now runs inside the
 * mutation callback, so it cannot be raced by another *config* writer: no concurrent
 * editor can remove or re-add a type between the count and the write. What it does not
 * close is a ticket being *opened* against the type in that window: `ticketTypeUsage`
 * queries through the module-level `database` singleton rather than this transaction's
 * connection, so it does not see the transaction's snapshot and an insert committed
 * mid-flight is not serialized against it.
 *
 * Closing that fully would mean plumbing a transaction handle through
 * `ticketTypeUsage` and `ticketsRepo`, which are shared by the Discord refusal path
 * too — a larger change than this route needs, and it would put a Kysely transaction
 * type in the signature of a function whose whole point is being callable from
 * anywhere. The residual window is one statement wide and its outcome is a ticket
 * whose type is gone, which `getTicketTypeDefinition` already refuses by name rather
 * than guessing at. Recorded in `readme.md` as the remaining half.
 *
 * Both gaps were recorded as outstanding in `readme.md` while these functions had no
 * production caller. The dashboard config route is that caller, so the clobber is
 * closed here rather than shipped onto a known race.
 */

/** The refusal a caller sees when the guild has no config row to edit. */
const NO_CONFIG_MESSAGE =
    'This server has no ticket config yet. Deploy the ticket system first, then come back.';

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
        return {
            ok: false,
            reason: 'invalid-input',
            message: 'A ticket type needs a key. Blank is not a category of anything.',
        };
    }

    // The key reaches a channel name and a flow `select` value, so it is restricted
    // rather than merely non-blank.
    if (!/^[a-z0-9_-]+$/.test(type)) {
        return {
            ok: false,
            reason: 'invalid-input',
            message: `\`${type}\` will not do as a key — lowercase letters, digits, \`-\` and \`_\` only. The label is where you get to be expressive.`,
        };
    }

    if (!input.label.trim()) {
        return {
            ok: false,
            reason: 'invalid-input',
            message: 'Give the type a label — operators have to pick it out of a list.',
        };
    }

    // Normalized *once*, and the normalized value is what gets stored under the
    // normalized key. Validating a trimmed key and then storing the untrimmed one leaves
    // a type visible in the config that every lookup misses — and `type` living inside
    // the record as well as being its map key exists precisely so the two cannot
    // disagree.
    const definition: TicketTypeDefinition = { ...input, type, label: input.label.trim() };

    const problem = templateProblem(definition);
    if (problem) {
        return { ok: false, reason: 'invalid-input', message: problem };
    }

    try {
        // Read, merge and write in one transaction, so a save that lands between
        // another editor's read and their write is not silently discarded. The merge
        // spreads both the config and the type record, so it touches exactly the one
        // type it names.
        const config = await repo.mutateConfig(guildId, (current) =>
            current.config
                ? {
                      ...current.config,
                      ticketTypes: { ...current.config.ticketTypes, [definition.type]: definition },
                  }
                : null
        );

        // Null means there was no row, or no `config` on it — the only two ways the
        // mutation above declines. Nothing else in it can refuse.
        if (!config) {
            return { ok: false, reason: 'no-config', message: NO_CONFIG_MESSAGE };
        }

        return { ok: true, config };
    } catch (error) {
        console.error('[tickets] Error saving ticket type:', error);
        return {
            ok: false,
            reason: 'write-failed',
            message: 'Could not save that ticket type. Try again in a second.',
        };
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

    /*
     * Carried out of the transaction rather than returned from it, because
     * `mutateConfig` distinguishes only "wrote" from "declined" — and this function has
     * three distinct refusals an operator has to act on differently: no config at all,
     * a type this guild never declared, and a type tickets are still holding. A single
     * null would collapse them into one message that is wrong for two of the three.
     */
    let refusal = 'This server has no ticket config yet, so there is nothing to delete.';
    /*
     * Carried beside the sentence, because the route turns it into a status code and must
     * not do that by matching words. "Does not declare" and "no longer declares" are both
     * already in this feature for the same concept, so a string match would flip 404 to
     * 409 the moment somebody unified the copy — with the route tests still green, since
     * they mock the message.
     */
    let refusalReason: SetTicketTypeRefusal = 'no-config';

    try {
        const config = await repo.mutateConfig(guildId, async (current) => {
            if (!current.config) return null;

            const definition = current.config.ticketTypes?.[type];
            if (!definition) {
                refusal = `This server does not declare a ticket type called \`${type}\`.`;
                refusalReason = 'undeclared-type';
                return null;
            }

            // Counted inside the mutation, so no other *config* writer can re-add or
            // remove a type between the count and the removal. This does not serialize
            // against a ticket being inserted concurrently — see the note above the
            // function; that query runs on the singleton, not this transaction.
            const usage = await ticketTypeUsage(guildId, type, deps?.usage);
            if (ticketTypeIsHeld(usage)) {
                refusal = ticketTypeInUseRefusal({ label: definition.label, type, usage });
                refusalReason = 'type-in-use';
                return null;
            }

            const remaining = { ...current.config.ticketTypes };
            delete remaining[type];

            return { ...current.config, ticketTypes: remaining };
        });

        if (!config) {
            return { ok: false, reason: refusalReason, message: refusal };
        }

        return { ok: true, config };
    } catch (error) {
        console.error('[tickets] Error deleting ticket type:', error);
        return {
            ok: false,
            reason: 'write-failed',
            message: 'Could not delete that ticket type. Try again in a second.',
        };
    }
}
