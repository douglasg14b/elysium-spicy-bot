import { describe, expect, it } from 'vitest';
import { RENDERABLE_TOKENS } from '../../../features/flows/engine/copyRendering';
import { BUILTIN_TOKENS, BUILTIN_TOKEN_NAMES } from '../../../../web/src/flows/builtinTokens';

/**
 * The drift gate between the engine's token vocabulary and the browser's copy of it.
 *
 * `RENDERABLE_TOKENS` is the closed list of tokens the engine will resolve; the
 * builder offers them as clickable chips from its own hand-written mirror. Neither
 * list is served — `/api/nodes` carries descriptors, and a token vocabulary is not
 * a descriptor member — so this drift is invisible to `nodeDescriptorDrift.test.ts`
 * and needs its own gate.
 *
 * A file of its own rather than another `VOCABULARIES` row there, because that
 * file's subject is *what the route serves*: its server side is derived at runtime
 * from the live registry, and a vocabulary nothing serves has no place in that
 * derivation. Same technique, different authority.
 *
 * Both failure directions are real and neither is loud on its own. A token added
 * to the engine and not here is a feature nobody can find — the exact state this
 * mirror was written to end. A name here the engine does not resolve is worse: the
 * chip inserts it, save-time validation refuses the flow, and the builder is the
 * thing that suggested it.
 *
 * The cross-workspace import is safe for the reason `nodeDescriptorDrift.test.ts`
 * sets out at length, and more simply here — `builtinTokens.ts` imports nothing at
 * all, so it costs the root program one leaf file and typechecks under either config.
 */

const REMEDY =
    'Reconcile BUILTIN_TOKEN_NAMES and BUILTIN_TOKENS in `web/src/flows/builtinTokens.ts` ' +
    'with RENDERABLE_TOKENS in `src/features/flows/engine/copyRendering.ts`. A token the ' +
    'engine resolves and the browser does not list is one no author can discover; a token ' +
    'the browser lists and the engine does not resolve is one the picker offers and every ' +
    'run rejects.';

describe('built-in token drift between engine and builder', () => {
    it('mirrors exactly the tokens the engine resolves', () => {
        const engine = [...RENDERABLE_TOKENS].sort();
        const browser = [...BUILTIN_TOKEN_NAMES].sort();

        expect(
            browser,
            `The built-in token vocabulary has drifted. Engine: [${engine.join(', ')}]; ` +
                `browser: [${browser.join(', ')}]. ${REMEDY}`
        ).toEqual(engine);
    });

    it('describes each token exactly once', () => {
        // The compiler guard in `builtinTokens.ts` catches a missing or invented
        // entry; a *duplicated* one satisfies both `satisfies` and the exhaustiveness
        // check while rendering the same chip twice.
        const names = BUILTIN_TOKENS.map((token) => token.name);

        expect(
            [...new Set(names)],
            `BUILTIN_TOKENS lists a token more than once: [${names.join(', ')}]. ` +
                'The picker maps the array, so a duplicate renders as two identical chips.'
        ).toEqual(names);
    });

    it('gives every token a tooltip', () => {
        // A chip with an empty description renders a tooltip saying nothing, which
        // the compiler is happy with and which defeats the point of the chip.
        const undescribed = BUILTIN_TOKENS.filter((token) => !token.description.trim()).map(
            (token) => token.name
        );

        expect(
            undescribed,
            `These built-in tokens have no description: [${undescribed.join(', ')}]. ` +
                'The chip exists to tell an author what a token fills in.'
        ).toEqual([]);
    });

    /*
     * Deliberately not asserted here: `lostAfterSuspend`. The server states that
     * fact only in the optionality of `FlowRunSeed.actor` and in the failure message
     * `copyRendering.ts` produces when a woken run reads the token — neither is a
     * list this can be compared against. `builtinTokens.test.ts` pins the browser's
     * side of it; a change in the engine's suspension model would not fail here.
     */
});
