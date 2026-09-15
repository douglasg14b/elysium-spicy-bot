import { z } from 'zod';
import type { BlockManifest } from '../manifest';

export const ACTION_PICK_RANDOM = 'action.pickRandom';

/**
 * Longest an option may be, in characters.
 *
 * Bounded by what the picked value is *for*: it is written to a run variable and
 * read back through `{{var.<name>}}`, which lands in a message body against
 * Discord's 2000-character limit. A per-entry cap keeps a pasted paragraph out of
 * the list in the first place.
 *
 * It does **not** interact with `FLOW_MAX_VARIABLES_SIZE`, which `drainWrites`
 * measures over the whole bag at run time — a loop writing short values still
 * hits that cap, and this cannot prevent it.
 */
const PICK_RANDOM_OPTION_MAX_LENGTH = 200;

/**
 * Most options one list may hold.
 *
 * Not a Discord limit — nothing here renders as buttons — so this is a limit on
 * the *row*: the list is stored in `node.data` and the pick is stored in the
 * run's byte-capped variable bag. Fifty entries of the length above is a few
 * kilobytes of graph, which is a list an author can still read on a canvas.
 */
const PICK_RANDOM_MAX_OPTIONS = 50;

/**
 * How a variable name is spelled, matching what `{{var.<name>}}` can address.
 *
 * `variableNameOf` in `engine/copyRendering.ts` splits a token on `.` and rejects
 * anything with a second segment, so a name containing a dot would save happily
 * here and then be unreadable from copy — the author's token would resolve to
 * nothing and they would have no way to tell why. Whitespace and braces fail the
 * same way. Constrained at the schema instead, so the save is what refuses it.
 */
const VARIABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export const pickRandomConfigSchema = z.object({
    /*
     * `.min(1)`, and `.nonempty()` is **not** the stronger alternative it looks
     * like. In Zod 4 it is a length check declared as `nonempty(): this`, so it
     * infers `string[]` exactly as this does — no ordering or spelling makes an
     * empty list a compile error the way Zod 3's tuple type would have. Hence the
     * runtime guard in `run` rather than a type that rules the case out.
     */
    options: z
        .array(z.string().min(1).max(PICK_RANDOM_OPTION_MAX_LENGTH))
        .min(1)
        .max(PICK_RANDOM_MAX_OPTIONS),
    /** The flat, author-declared name later blocks read as `{{var.<name>}}`. */
    outputKey: z
        .string()
        .min(1)
        .max(64)
        .regex(
            VARIABLE_NAME_PATTERN,
            'A name must start with a letter and use only letters, numbers and underscores — ' +
                'that is what {{var.name}} can address.'
        ),
});

export type PickRandomConfig = z.infer<typeof pickRandomConfigSchema>;

/**
 * Pick one entry, given a number in `[0, 1)`.
 *
 * Injected rather than reaching for `Math.random()` inside `run`, following
 * `rollRandomXp` in `features/leveling/logic/xpCalculator.ts`: a defaulted
 * parameter is the established way this repo makes a roll testable without
 * stubbing a global. `run`'s signature is fixed by the block contract and has
 * nowhere to thread a source through, so the seam lives here — the one place the
 * randomness actually is — and the test calls this directly.
 *
 * `Math.floor` over a half-open `[0, 1)` gives each entry equal weight. A roll
 * outside that range **throws**, following `rollRandomXp`, which rejects an
 * impossible range rather than quietly correcting it: silently clamping would
 * turn a caller's bug into a biased pick that still looks random, which is the
 * one failure nobody would ever notice. `Math.random` cannot produce such a
 * value, so this only ever fires on a caller passing one.
 *
 * An empty list is rejected here rather than returning `undefined` from a
 * `: string` signature. The schema's `.min(1)` already makes it unreachable
 * through the executor, which re-parses node data on every visit — see the note
 * on the schema for why the stronger, type-level version is not available.
 */
export function pickOption(
    options: readonly string[],
    randomValue: number = Math.random()
): string {
    if (options.length === 0) {
        throw new Error('There is nothing to pick from: the list of options is empty.');
    }
    if (!(randomValue >= 0 && randomValue < 1)) {
        throw new Error(`A random roll must be in [0, 1), got ${randomValue}.`);
    }

    return options[Math.floor(randomValue * options.length)];
}

/**
 * Pick one of the author's options at random and record it for later blocks.
 *
 * Deliberately knows nothing about messages or embeds. It writes a run variable,
 * and whatever reads `{{var.<name>}}` decides what the pick *means* — a prompt to
 * post, a reviewer to ping, a punishment to hand out. Binding the roll to a
 * message payload instead would need a second block the first time somebody wants
 * to pick something that is not a message.
 *
 * Composition today is by token: this block writes `outputKey`, and a downstream
 * copy field says `{{var.<outputKey>}}`. The reference picker the PRD describes
 * would make that a dropdown rather than typing; it does not exist yet, and
 * nothing here assumes it.
 */
export const block: BlockManifest<PickRandomConfig> = {
    type: ACTION_PICK_RANDOM,
    kind: 'action',
    label: 'Pick at Random',
    description: 'Roll for it. Picks one thing off your list and hands it to whatever comes next.',
    group: 'actions',
    icon: '🎲',
    configSchema: pickRandomConfigSchema,
    configFields: [
        {
            key: 'options',
            label: 'Options',
            description: 'One per row. Every entry is equally likely — stack the deck by repeating a favourite.',
            control: 'textList',
            placeholder: 'Something filthy',
            maxLength: PICK_RANDOM_OPTION_MAX_LENGTH,
            minEntries: 1,
            maxEntries: PICK_RANDOM_MAX_OPTIONS,
            addLabel: 'Add an option',
            defaultValue: ['Heads', 'Tails'],
        },
        {
            key: 'outputKey',
            label: 'Save the pick as',
            description: 'Later blocks read it as {{var.name}} — use that in a message to say what came up.',
            control: 'text',
            placeholder: 'dare',
            maxLength: 64,
            defaultValue: 'pick',
            // Deliberately NOT `rendersTokens`: this is the *name* of a variable,
            // not copy somebody reads. Expanding tokens in it would let an author
            // write a name that changes per run, which nothing downstream could
            // then reference.
        },
    ],
    cardSummary: [
        { key: 'options', emptyText: 'nothing to pick from', stopIfEmpty: true },
        { key: 'outputKey', prefix: ' → {{var.', suffix: '}}', hideWhenEmpty: true },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    /*
     * **`key` names the config field, not the variable this writes.** The name is
     * authored — `setOutput` is called with `config.outputKey`, whose *value* is
     * what `{{var.…}}` addresses — so there is no fixed key to declare here, and
     * this names the shape instead. The producer fixture
     * (`__tests__/fixtures/blocks/producer/actionRecordValue`) does the same.
     *
     * Recorded loudly because this is the first *shipped* block with a non-empty
     * `outputs`, and nothing reads the member yet. The deferred check in
     * `graphValidation.ts` — "a variable no upstream block produces" — must not be
     * built against this shape naively: it would reject the one correct graph
     * (this writes `pick`, downstream reads `{{var.pick}}`) and accept
     * `{{var.outputKey}}`, which nothing ever writes. Whichever milestone builds
     * that check needs a way to say "this key is config-named", not a second
     * reading of `key`.
     */
    outputs: [
        {
            key: 'outputKey',
            label: 'The picked option',
            description: 'Whichever entry came up, under the name this block was given.',
        },
    ],
    // Nothing here reads the subject: the block picks from the author's own list
    // and writes a variable. Declaring `subject` would assert a dependency the
    // code does not have, matching `action.delay` and `action.sendMessage` rather
    // than the role blocks.
    requires: [],
    capabilities: [],
    canSuspend: false,
    run(config, context) {
        // The schema's `.min(1)` makes this unreachable through the executor,
        // which re-parses node data on every visit. Reported rather than assumed
        // away, matching `action.prompt`'s missing-channel arm: `pickOption`
        // throws on an empty list, and a raw throw out of `run` is recorded
        // against the node but reads as a crash rather than as the authoring
        // mistake it is. Returning `fail` is how this block says so in words.
        if (config.options.length === 0) {
            return {
                kind: 'fail',
                error: 'This block has nothing to pick from — its list of options is empty.',
            };
        }

        context.setOutput(config.outputKey, pickOption(config.options));
        return { kind: 'continue' };
    },
};
