import { describe, expect, it } from 'vitest';
import { BUILTIN_TOKENS, builtinToken } from '../builtinTokens';

describe('builtinToken', () => {
    it('wraps a name in the braces an author would type', () => {
        expect(builtinToken('guild.name')).toBe('{{guild.name}}');
    });

    it('does not namespace a built-in the way a variable is namespaced', () => {
        // `{{var.subject.username}}` is a token the engine sees and refuses: the
        // variable bag is flat, so a dotted name under `var.` resolves to nothing.
        expect(builtinToken('subject.username')).toBe('{{subject.username}}');
    });
});

describe('BUILTIN_TOKENS', () => {
    it('marks the actor token, and only it, as lost after a suspend', () => {
        // The one entry that is a judgement rather than a mirror, and the one a
        // copy-paste would get wrong. `subject` is carried on every resumed run;
        // `actor` is the member who caused the *current* step, so a run the clock
        // woke has none.
        const lost = BUILTIN_TOKENS.filter((token) => token.lostAfterSuspend).map(
            (token) => token.name
        );

        expect(lost).toEqual(['actor.mention']);
    });
});
