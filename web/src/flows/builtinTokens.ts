/**
 * The tokens the engine fills in by itself, and how the builder describes them.
 *
 * These have worked since copy rendering shipped and have never been visible: the
 * picker under a copy field offers `{{var.…}}` — the values an author's own blocks
 * write — and says nothing about the four the run supplies for free. An author who
 * did not already know `{{subject.username}}` existed had no way to find out, which
 * made a shipped feature read as a missing one.
 *
 * A mirror of `RENDERABLE_TOKENS` in `src/features/flows/engine/copyRendering.ts`,
 * hand-written for the reason every mirror across this boundary is: a single
 * `import type` from `src/` inside `web/src/` drags the bot tree into `tsc -b` and
 * breaks `pnpm build:web`. `builtinTokenDrift.test.ts` is what holds the two lists
 * together in place of the compiler.
 *
 * The labels and descriptions are the browser's own — the server has nowhere to put
 * authoring copy, and a token's tooltip is not something the engine needs.
 */

/**
 * Every token an author may write that is not a `{{var.…}}`.
 *
 * The *engine's* vocabulary, so this is closed: a name here that the server does
 * not resolve is a chip that inserts a token failing every run that reaches it.
 */
export const BUILTIN_TOKEN_NAMES = [
    'subject.mention',
    'subject.username',
    'actor.mention',
    'guild.name',
] as const;

export type BuiltinTokenName = (typeof BUILTIN_TOKEN_NAMES)[number];

/** One built-in token, and what the picker shows for it. */
export interface BuiltinToken {
    /** The token name as the engine spells it, without braces. */
    readonly name: BuiltinTokenName;
    /** What it fills in, for the chip's tooltip. */
    readonly description: string;
    /**
     * Whether a block that parks the run can leave this with nothing to fill in.
     *
     * True for `actor.mention` alone: the actor is whoever caused the current
     * step, and a run the clock woke was caused by nobody. Declared here rather
     * than derived, because the server states it only in the optionality of
     * `FlowRunSeed.actor` — there is no list to mirror.
     */
    readonly lostAfterSuspend: boolean;
}

export const BUILTIN_TOKENS = [
    {
        name: 'subject.mention',
        description: 'Pings the member the flow is about.',
        lostAfterSuspend: false,
    },
    {
        name: 'subject.username',
        description: 'Their username as plain text — no ping.',
        lostAfterSuspend: false,
    },
    {
        name: 'actor.mention',
        description: 'Pings whoever caused this step. Often the same person as the subject.',
        lostAfterSuspend: true,
    },
    {
        name: 'guild.name',
        description: "This server's name.",
        lostAfterSuspend: false,
    },
] as const satisfies readonly BuiltinToken[];

/**
 * Fails to compile if a name above has no entry in {@link BUILTIN_TOKENS}.
 *
 * `satisfies` already rejects an entry this file invents; this is the other
 * direction, so the two lists cannot disagree inside the web build either.
 */
type BuiltinTokensAreComplete = Exclude<BuiltinTokenName, (typeof BUILTIN_TOKENS)[number]['name']>;

/** Do not delete as unused: removing it erases the guard above. */
const builtinTokensAreComplete: [BuiltinTokensAreComplete] extends [never]
    ? true
    : ['BUILTIN_TOKENS is missing an entry for', BuiltinTokensAreComplete] = true;

void builtinTokensAreComplete;

/** The token an author writes, e.g. `{{guild.name}}`. */
export function builtinToken(name: BuiltinTokenName): string {
    return `{{${name}}}`;
}
