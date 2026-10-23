import type { Guild } from 'discord.js';
import { ticketingRepo, type TicketingRepo } from '../data/ticketingRepo';
import {
    TICKET_CATEGORY_SLOTS,
    typeCategoryKey,
    type TicketCategorySlot,
    type TicketingConfig,
    type TicketTypeDefinition,
} from '../data/ticketingSchema';
import { describeCategorySlot } from './ticketCategories';
import {
    checkCategoryPicks,
    createNamedCategories,
    recordCategoryChanges,
    withCategorySaveLock,
    writeFailedMessage,
    type CategoryPickTarget,
    type TicketCategoryPick,
} from './ticketCategoryChoices';
import { buildTicketChannelName, getTicketTypeDefinition } from './ticketTypes';
import { TicketTypeRulesSchema } from './ticketTypeRules';
import {
    journeysHoldingTicketType,
    loadJourneyTicketTypeDeclarations,
    ticketTypeHeldByJourneyRefusal,
    ticketTypeInUseRefusal,
    ticketTypeIsHeld,
    ticketTypeUsage,
    type JourneyTicketTypeDeclarations,
    type TicketTypeHoldersDeps,
    type TicketTypeUsageDeps,
} from './ticketTypeInUse';

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
 *
 * `held-by-journey` is its own reason rather than a kind of `type-in-use`: the fix is
 * different (uninstall the journey, not retype tickets), and so is what is holding it.
 */
export type SetTicketTypeRefusal =
    | 'no-config'
    | 'undeclared-type'
    | 'type-in-use'
    | 'held-by-journey'
    | 'invalid-input'
    | 'write-failed';

export type SetTicketTypeResult =
    | { ok: true; config: TicketingConfig }
    | { ok: false; reason: SetTicketTypeRefusal; message: string };

/**
 * Why a type save was refused. Beyond the shared ones, the three a save that sets the
 * type's categories can meet — the same three, and the same meanings, as the settings
 * save's (`setTicketSettings`).
 */
export type UpsertTicketTypeRefusal =
    | Extract<SetTicketTypeRefusal, 'no-config' | 'invalid-input' | 'write-failed'>
    | 'busy'
    | 'create-failed'
    | 'taken-meanwhile';

/** The refusals that still **saved** the type — see {@link UpsertTicketTypeResult}. */
type PartlySavedTypeRefusal = Extract<UpsertTicketTypeRefusal, 'create-failed' | 'taken-meanwhile'>;

/**
 * `create-failed` and `taken-meanwhile` carry the config because they saved: the type,
 * and every category that was made. Only the slot that failed is left as it was.
 */
export type UpsertTicketTypeResult =
    | { ok: true; config: TicketingConfig }
    | { ok: false; reason: PartlySavedTypeRefusal; message: string; config: TicketingConfig }
    | { ok: false; reason: Exclude<UpsertTicketTypeRefusal, PartlySavedTypeRefusal>; message: string };

/** What the type editor chose for one of a type's slots: its own category, or `null` for the server's. */
export type TicketTypeCategoryChoice = TicketCategoryPick | null;

/**
 * The slots of a type's own categories a save changes: a pick, or `null` for the
 * server's. An absent slot is left as it is, so a save composed against an older read
 * — a stale tab, a dialog open across a recreate — cannot undo a slot it never touched.
 */
export type TicketTypeCategoryChanges = Readonly<Partial<Record<TicketCategorySlot, TicketTypeCategoryChoice>>>;

/**
 * One type to add or replace.
 *
 * Without `categories`, the type's own categories are left as they are, and nothing but
 * the database is touched. With them, the save may create categories, so it takes the
 * guild.
 */
export type UpsertTicketTypeInput =
    | { readonly guildId: string; readonly definition: TicketTypeDefinition; readonly categories?: undefined }
    | {
          readonly guild: Guild;
          readonly definition: TicketTypeDefinition;
          readonly categories: TicketTypeCategoryChanges;
      };

export interface SetTicketTypesDeps {
    readonly repo?: Pick<TicketingRepo, 'mutateConfig' | 'clearTypeCategories'>;
    readonly usage?: TicketTypeUsageDeps;
    /** Which journeys hold a type — read by `deleteTicketType` only. */
    readonly holders?: TicketTypeHoldersDeps;
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
 * Whether a channel-name template renders to a channel name Discord will take.
 *
 * Only the two rules that need the renderer: the empty render and the maximum expansion
 * are facts about `buildTicketChannelName`, not about the string. That the template uses
 * only known tokens, with no stray braces, is `TicketNameTemplateSchema`'s rule
 * (`ticketTypeRules.ts`), parsed before this runs.
 */
function templateProblem(definition: TicketTypeDefinition): TemplateProblem {
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

    return null;
}

/** A definition checked by {@link checkTicketTypeDefinition}: normalised, or refused in words. */
type TicketTypeDefinitionCheck =
    | { readonly ok: true; readonly definition: TicketTypeDefinition }
    | { readonly ok: false; readonly message: string };

/**
 * A ticket type definition held to every rule that is a fact about the definition itself,
 * and normalised.
 *
 * First `ticketTypeRules.ts` — the key (non-blank, slug-shaped, short enough), the label
 * (one an operator can pick out of a list, short enough for the mod modal) and the
 * template's tokens — which the dashboard route's request schema composes too, so the
 * browser refuses with the same sentence. Then what a schema cannot see: whether the
 * template renders to a channel name Discord will take.
 *
 * Normalised *once*, and the parsed value is what callers store: validating a trimmed key
 * and then storing the untrimmed one leaves a type visible in the config that every lookup
 * misses — and `type` living inside the record as well as being its map key exists
 * precisely so the two cannot disagree.
 */
function checkTicketTypeDefinition(input: TicketTypeDefinition): TicketTypeDefinitionCheck {
    const declared = TicketTypeRulesSchema.safeParse(input);
    if (!declared.success) {
        return { ok: false, message: declared.error.issues[0]?.message ?? 'That ticket type does not hold together.' };
    }

    const definition: TicketTypeDefinition = { ...input, ...declared.data };
    const problem = templateProblem(definition);
    return problem ? { ok: false, message: problem } : { ok: true, definition };
}

/**
 * What is wrong with a ticket type definition, in words for the operator, or null.
 *
 * {@link checkTicketTypeDefinition}'s verdict, for a caller that only asks — the journey
 * save route, which checks a declared ticket type before it is stored. Pure, so it,
 * `upsertTicketType` and `createTicketTypeIfAbsent` (a journey's install) share one copy.
 */
export function ticketTypeDefinitionProblem(definition: TicketTypeDefinition): string | null {
    const check = checkTicketTypeDefinition(definition);
    return check.ok ? null : check.message;
}

/**
 * Add or replace one ticket type.
 *
 * The key, label and template are held to `ticketTypeRules.ts` here as well as in the
 * dashboard route's request schema, which composes the same rules: the route's copy is
 * what lets the browser refuse with the server's sentence before sending, and this one is
 * what keeps a surface that calls this directly from saving `{{user}}`. One declaration,
 * parsed in two places — no rule is written twice. Then what a schema cannot see: whether
 * the template renders to a channel name Discord will take, and whether the guild has a
 * config row at all.
 *
 * Writes by **spreading** the existing config and the existing type record, so a
 * save touches exactly the one type it names — the same discipline the config
 * modal needed after it was found silently dropping every member it did not list.
 *
 * **Replaces** a type of the same key. A journey's install never comes through here: it
 * creates only when absent, through {@link createTicketTypeIfAbsent}.
 *
 * Given `categories`, also sets the type's own categories — checked, created and recorded
 * by `ticketCategoryChoices`, under the lock the settings save holds — on the same
 * transaction as the type. The definition is checked first, so a type that would be
 * refused never makes a category.
 */
export async function upsertTicketType(
    input: UpsertTicketTypeInput,
    deps?: SetTicketTypesDeps
): Promise<UpsertTicketTypeResult> {
    // Stored as parsed, so a padded key is stored as the key every lookup will use.
    const check = checkTicketTypeDefinition(input.definition);
    if (!check.ok) {
        return { ok: false, reason: 'invalid-input', message: check.message };
    }
    const definition = check.definition;

    if (!input.categories) return writeTicketType(input.guildId, definition, deps);

    const { guild, categories } = input;
    return withCategorySaveLock(
        guild.id,
        () => ({
            ok: false,
            reason: 'busy',
            message: 'Another save of this server’s ticket categories is still running, so nothing was changed. Wait a moment and try again.',
        }),
        () => writeTicketTypeWithCategories(guild, definition, categories, deps)
    );
}

/** {@link upsertTicketType} without categories: the type record alone. */
async function writeTicketType(
    guildId: string,
    definition: TicketTypeDefinition,
    deps?: SetTicketTypesDeps
): Promise<UpsertTicketTypeResult> {
    const repo = deps?.repo ?? ticketingRepo;

    try {
        // Read, merge and write in one transaction, so a save that lands between
        // another editor's read and their write is not silently discarded. The merge
        // spreads both the config and the type record, so it touches exactly the one
        // type it names.
        const config = await repo.mutateConfig(guildId, (current) =>
            current.config ? withTicketType(current.config, definition) : null
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
 * {@link upsertTicketType} with the type's own categories: check every pick, create the
 * named ones, then write the type and the categories once — the settings save's order.
 */
async function writeTicketTypeWithCategories(
    guild: Guild,
    definition: TicketTypeDefinition,
    categories: TicketTypeCategoryChanges,
    deps?: SetTicketTypesDeps
): Promise<UpsertTicketTypeResult> {
    const repo = deps?.repo ?? ticketingRepo;

    const current = await ticketingRepo.get(guild.id);
    if (!current?.config) {
        return { ok: false, reason: 'no-config', message: NO_CONFIG_MESSAGE };
    }

    const own = current.config.typeCategories.get(definition.type);
    const targets: CategoryPickTarget[] = [];
    const toClear: TicketCategorySlot[] = [];
    for (const slot of TICKET_CATEGORY_SLOTS) {
        const pick = categories[slot];
        if (pick === undefined) continue;
        if (pick === null) {
            toClear.push(slot);
            continue;
        }
        targets.push({
            resourceKey: typeCategoryKey(definition.type, slot),
            described: describeCategorySlot(slot, definition.label),
            pick,
            currentDiscordId: own?.[slot]?.discordId ?? null,
        });
    }

    const checked = await checkCategoryPicks(guild, targets);
    if (!checked.ok) return { ok: false, reason: 'invalid-input', message: checked.message };

    const { created, madeNames, failure } = await createNamedCategories(
        guild,
        checked.toCreate,
        current.config.moderationRoles
    );

    let saved: TicketingConfig | null;
    let takenMeanwhile: string[] = [];
    try {
        saved = await repo.mutateConfig(guild.id, async (row, transaction) => {
            if (!row.config) return null;
            takenMeanwhile = await recordCategoryChanges(
                guild.id,
                new Map([...checked.adopted, ...created]),
                checked.journeyNames,
                transaction
            );
            await repo.clearTypeCategories(guild.id, definition.type, toClear, transaction);
            return withTicketType(row.config, definition);
        });
    } catch (error) {
        console.error('[tickets] Error saving ticket type:', error);
        return { ok: false, reason: 'write-failed', message: writeFailedMessage(madeNames, 'the ticket type') };
    }

    if (!saved) {
        return { ok: false, reason: 'no-config', message: NO_CONFIG_MESSAGE };
    }

    if (takenMeanwhile.length > 0) {
        const alsoFailed = failure ? ` ${failure}.` : '';
        return {
            ok: false,
            reason: 'taken-meanwhile',
            message: `${takenMeanwhile.join(' ')}${alsoFailed} Everything else was saved.`,
            config: saved,
        };
    }

    if (failure) {
        return { ok: false, reason: 'create-failed', message: `${failure}. Everything else was saved.`, config: saved };
    }

    return { ok: true, config: saved };
}

/**
 * The config with one type added or replaced, spreading both the config and the type
 * record, so a save touches exactly the one type it names — the same discipline the
 * config modal needed after it was found silently dropping every member it did not list.
 */
function withTicketType(config: TicketingConfig, definition: TicketTypeDefinition): TicketingConfig {
    return { ...config, ticketTypes: { ...config.ticketTypes, [definition.type]: definition } };
}

/** What creating a type only-if-absent came to. */
export type CreateTicketTypeIfAbsentResult =
    | { readonly outcome: 'created'; readonly config: TicketingConfig }
    /** A type of this key was already there, and is left exactly as it is. */
    | { readonly outcome: 'exists'; readonly label: string }
    | {
          readonly outcome: 'refused';
          readonly reason: Extract<SetTicketTypeRefusal, 'no-config' | 'invalid-input' | 'write-failed'>;
          readonly message: string;
      };

/**
 * Add a ticket type **only if the guild has none of this key**. Never replaces one.
 *
 * For a journey's install (`ticketTypeProvisioning.ts`), which must never change a type
 * someone else made — another journey, the dashboard, the Discord modal, or this journey
 * on an earlier install. Deliberately *not* {@link upsertTicketType}, which replaces the
 * record: a type created between an install's preview and its apply would be silently
 * overwritten with the journey's settings.
 *
 * Validated exactly as `upsertTicketType` validates ({@link checkTicketTypeDefinition}),
 * and the existence check and the write share one `mutateConfig` transaction, so nothing
 * can slip a type in between them.
 */
export async function createTicketTypeIfAbsent(
    guildId: string,
    input: TicketTypeDefinition,
    deps?: SetTicketTypesDeps
): Promise<CreateTicketTypeIfAbsentResult> {
    const repo = deps?.repo ?? ticketingRepo;

    const check = checkTicketTypeDefinition(input);
    if (!check.ok) {
        return { outcome: 'refused', reason: 'invalid-input', message: check.message };
    }
    const definition = check.definition;

    // Carried out of the transaction, as `deleteTicketType` carries its refusal: a null
    // from `mutateConfig` cannot say whether there was no config or a type already there.
    const found: { label?: string } = {};

    try {
        const config = await repo.mutateConfig(guildId, (current) => {
            if (!current.config) return null;

            // Own keys only: a plain index would find `Object.prototype.constructor` for a
            // type keyed `constructor` and call it an existing type.
            const existing = getTicketTypeDefinition(current.config, definition.type);
            if (existing) {
                found.label = existing.label;
                return null;
            }

            return withTicketType(current.config, definition);
        });

        if (config) return { outcome: 'created', config };
        if (found.label !== undefined) return { outcome: 'exists', label: found.label };
        return { outcome: 'refused', reason: 'no-config', message: NO_CONFIG_MESSAGE };
    } catch (error) {
        console.error('[tickets] Error creating ticket type for a journey:', error);
        return {
            outcome: 'refused',
            reason: 'write-failed',
            message: 'Could not save that ticket type. Try again in a second.',
        };
    }
}

/**
 * Remove a ticket type, unless tickets still reference it or a journey installed it.
 *
 * The refusal is this function's, not the route's: a Discord config surface must
 * refuse for the same reason and with the same words.
 *
 * **Unconditional — no force flag and no confirmable override.** A type whose
 * definition is gone leaves `getTicketTypeDefinition` returning `undefined` for a
 * live ticket, and there is no correct behaviour at that point; a confirmable
 * override would make the promise conditional.
 *
 * A journey holding the type is refused for the same reason from the other side: its
 * flows are wired to the key, and uninstalling the journey — which forgets the row and
 * never touches the type — is how an operator lets go of it. Flows that name a type with
 * no journey behind them are not checked here; that gap predates journeys declaring types.
 */
export async function deleteTicketType(
    guildId: string,
    type: string,
    deps?: SetTicketTypesDeps
): Promise<SetTicketTypeResult> {
    const repo = deps?.repo ?? ticketingRepo;

    // Before the transaction: the journeys come off the singleton, which must not be queried
    // from inside `mutateConfig` (SQLite's one connection). Only the binding rows are read there.
    let declarations: JourneyTicketTypeDeclarations;
    try {
        declarations = await loadJourneyTicketTypeDeclarations(guildId, deps?.holders);
    } catch (error) {
        console.error('[tickets] Error reading journeys before deleting a ticket type:', error);
        return {
            ok: false,
            reason: 'write-failed',
            message: 'Could not delete that ticket type. Try again in a second.',
        };
    }

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
        const config = await repo.mutateConfig(guildId, async (current, transaction) => {
            if (!current.config) return null;

            const definition = current.config.ticketTypes?.[type];
            if (!definition) {
                refusal = `This server does not declare a ticket type called \`${type}\`.`;
                refusalReason = 'undeclared-type';
                return null;
            }

            // On the transaction, so no singleton query can deadlock it. Not a lock against
            // an install: a journey's install creates the type and records its row in two
            // separate writes, so a delete landing between them leaves a row for a type
            // that is gone — which the next install plans as "removed; made again".
            const holders = await journeysHoldingTicketType(guildId, type, declarations, transaction, deps?.holders);
            if (holders.length > 0) {
                refusal = ticketTypeHeldByJourneyRefusal({ label: definition.label, type, holders });
                refusalReason = 'held-by-journey';
                return null;
            }

            /*
             * Counted inside the mutation, **on the mutation's own transaction** — so the
             * count and the removal cannot straddle a ticket being opened, and so this does
             * not deadlock.
             *
             * The transaction is not optional. Kysely's sqlite dialect has one mutexed
             * connection which `mutateConfig` holds for its whole duration, so a count
             * issued on the `database` singleton from inside this callback waits on a mutex
             * that cannot be released until the callback returns. That was this code's
             * behaviour until it was caught: one click of Delete hung the request and
             * poisoned the process's only connection, taking every other feature down with
             * it until restart. The whole suite missed it because every test injects a fake
             * on one side or the other, so the real transaction never met the real repo.
             */
            const usage = await ticketTypeUsage(guildId, type, deps?.usage, transaction);
            if (ticketTypeIsHeld(usage)) {
                refusal = ticketTypeInUseRefusal({ label: definition.label, type, usage });
                refusalReason = 'type-in-use';
                return null;
            }

            // Its own categories go with it — the rows, not the categories, which stay in
            // Discord. Left behind, they would be picked up by a type made later under the
            // same key.
            await repo.clearTypeCategories(guildId, type, TICKET_CATEGORY_SLOTS, transaction);

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
