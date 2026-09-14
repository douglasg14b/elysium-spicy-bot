import { describe, expect, it } from 'vitest';
import type { FlowRunSeed, FlowVariableValue } from '../../blocks/types';
import { isRenderableToken, renderCopy, tokensIn } from '../copyRendering';

/**
 * The renderer in isolation: no Discord, no registry, no graph.
 *
 * Everything here is a pure function over a context, which is the whole reason
 * rendering was pulled out of the blocks that emit copy — the vocabulary can be
 * pinned once, cheaply, instead of once per block that happens to send a message.
 */

const SUBJECT_MENTION = '<@user-1>';
const ACTOR_MENTION = '<@mod-9>';

function makeContext(
    options: { variables?: Record<string, FlowVariableValue>; withActor?: boolean } = {}
): FlowRunSeed {
    const subject = {
        toString: () => SUBJECT_MENTION,
        user: { username: 'spicypete' },
    } as unknown as FlowRunSeed['subject'];

    const actor = { toString: () => ACTOR_MENTION } as unknown as FlowRunSeed['actor'];

    return {
        client: {} as FlowRunSeed['client'],
        guild: { id: 'guild-1', name: 'Afterdark' } as FlowRunSeed['guild'],
        subject,
        ...(options.withActor ? { actor } : {}),
        variables: options.variables ?? {},
    };
}

const render = (template: string, context: FlowRunSeed = makeContext(), maxLength?: number) =>
    renderCopy(template, {
        context,
        fieldLabel: '"Message"',
        ...(maxLength === undefined ? {} : { maxLength }),
    });

describe('the copy renderer', () => {
    it('leaves copy with no tokens exactly as the author wrote it', () => {
        // A graph saved before any of this existed must render unchanged — this is
        // the compatibility claim, expressed at the smallest unit that can hold it.
        const untouched = 'Welcome to the dungeon. Read the rules, behave, have fun.';

        expect(render(untouched)).toEqual({ ok: true, text: untouched });
    });

    it('fills in who the run is about', () => {
        const result = render('Say hi to {{subject.mention}} ({{subject.username}})');

        expect(result).toEqual({ ok: true, text: `Say hi to ${SUBJECT_MENTION} (spicypete)` });
    });

    it('fills in the guild and the member who caused this step', () => {
        const result = render('{{actor.mention}} approved you in {{guild.name}}', makeContext({ withActor: true }));

        expect(result).toEqual({ ok: true, text: `${ACTOR_MENTION} approved you in Afterdark` });
    });

    it('tolerates whitespace inside the braces, because an author will type it', () => {
        expect(render('hi {{ subject.username }}')).toEqual({ ok: true, text: 'hi spicypete' });
    });

    it('reads a value an earlier block recorded', () => {
        const context = makeContext({ variables: { ticketChannelId: '4242', strikes: 3, vetted: true } });

        expect(render('#{{var.ticketChannelId}} · {{var.strikes}} · {{var.vetted}}', context)).toEqual({
            ok: true,
            text: '#4242 · 3 · true',
        });
    });

    it('renders a variable explicitly set to nothing as nothing, not as "null"', () => {
        // Printing the JavaScript spelling of absence into a Discord message leaks
        // the implementation rather than telling anybody anything.
        const context = makeContext({ variables: { note: null } });

        expect(render('note:{{var.note}}', context)).toEqual({ ok: true, text: 'note:' });
    });

    describe('refuses rather than degrades', () => {
        it('rejects a token that is not in the vocabulary, naming it', () => {
            const result = render('hello {{subject.nmae}}');

            expect(result.ok).toBe(false);
            if (result.ok) throw new Error('unreachable');
            expect(result.error).toContain('{{subject.nmae}}');
            // And says what the author *can* write, since they are mid-typo.
            expect(result.error).toContain('{{subject.mention}}');
        });

        it('rejects a bare nonsense token', () => {
            const result = render('{{nonsense}}');

            expect(result.ok).toBe(false);
            if (result.ok) throw new Error('unreachable');
            expect(result.error).toContain('{{nonsense}}');
        });

        it('never leaks braces to a member', () => {
            // The failure that matters most: an unmatched token posted verbatim is
            // visible to everyone in the channel and fixable by nobody in it.
            const result = render('welcome {{whatever.this.is}}');

            expect(result.ok).toBe(false);
        });

        it('refuses a nested variable lookup rather than silently reading the first segment', () => {
            const context = makeContext({ variables: { a: 'shallow' } });
            const result = render('{{var.a.b}}', context);

            expect(result.ok).toBe(false);
        });

        it('names the variable when nothing has recorded it yet', () => {
            const result = render('channel {{var.ticketChannelId}}');

            expect(result.ok).toBe(false);
            if (result.ok) throw new Error('unreachable');
            expect(result.error).toContain('ticketChannelId');
        });

        it('says so when the run has no actor, rather than rendering an empty gap', () => {
            // A resumed run was woken by the clock, so nobody acted. Rendering
            // "" here would post " approved you" and look like a bug in the copy.
            const result = render('{{actor.mention}} approved you');

            expect(result.ok).toBe(false);
            if (result.ok) throw new Error('unreachable');
            expect(result.error).toContain('actor');
        });

        // Every one of these was accepted before the prototype chain was closed
        // off, and two of them rendered `[object Object]` into a Discord message
        // while two threw a raw TypeError. Garbage that looks deliberate is worse
        // than leaked braces, because nobody reading the channel spots it.
        it.each(['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty'])(
            'rejects {{%s}}, which lives on Object.prototype rather than in the vocabulary',
            (token) => {
                const result = render(`hi {{${token}}}`);

                expect(result.ok).toBe(false);
            }
        );

        it.each(['var.toString', 'var.constructor', 'var.__proto__'])(
            'rejects {{%s}} rather than resolving an inherited member',
            (token) => {
                const result = render(`hi {{${token}}}`);

                expect(result.ok).toBe(false);
                if (result.ok) throw new Error('unreachable');
                // Reported as "nothing recorded that", not as a rendered value.
                expect(result.error).not.toContain('native code');
            }
        );

        it('reports only the first bad token, so the author fixes one thing at a time', () => {
            const result = render('{{first.bad}} and {{second.bad}}');

            expect(result.ok).toBe(false);
            if (result.ok) throw new Error('unreachable');
            expect(result.error).toContain('{{first.bad}}');
            expect(result.error).not.toContain('{{second.bad}}');
        });
    });

    describe('the platform limit', () => {
        it('fails nameably when the rendered copy overflows, rather than truncating', () => {
            // 19 characters of template become far more once expanded, which is
            // exactly why the limit is checked after substitution and not before.
            const result = render('{{subject.mention}}', makeContext(), 5);

            expect(result.ok).toBe(false);
            if (result.ok) throw new Error('unreachable');
            expect(result.error).toContain('5');
            expect(result.error).toContain(String(SUBJECT_MENTION.length));
        });

        it('measures the rendered length, not the authored one', () => {
            // The template is under the limit and the result is over it. A check
            // done before substitution would pass this and post an over-long
            // message to Discord, which rejects it at the API.
            const context = makeContext({ variables: { blurb: 'x'.repeat(50) } });

            expect(render('{{var.blurb}}', context, 20).ok).toBe(false);
            expect(render('{{var.blurb}}', context, 60).ok).toBe(true);
        });

        it('accepts copy that fits once rendered', () => {
            expect(render('hi {{subject.username}}', makeContext(), 100)).toEqual({
                ok: true,
                text: 'hi spicypete',
            });
        });
    });
});

describe('the vocabulary shared with save-time validation', () => {
    it.each(['subject.mention', 'subject.username', 'actor.mention', 'guild.name'])(
        'recognises {{%s}}',
        (token) => {
            expect(isRenderableToken(token)).toBe(true);
        }
    );

    it('accepts any variable name, because blocks do not declare outputs yet', () => {
        expect(isRenderableToken('var.anythingAtAll')).toBe(true);
    });

    it.each([
        'subject.foo',
        'nonsense',
        'channel.current',
        'var',
        'var.a.b',
        // Prototype members are not vocabulary. `in` would have said otherwise,
        // and save-time validation gates solely on this function.
        'toString',
        'constructor',
        'valueOf',
        '__proto__',
        'hasOwnProperty',
    ])('rejects {{%s}}', (token) => {
        expect(isRenderableToken(token)).toBe(false);
    });

    it('finds the tokens the renderer will later try to expand', () => {
        // The validator and the renderer must agree about what a token *is*, or
        // save-time validation passes copy that fails in front of a member.
        expect(tokensIn('a {{one}} b {{ two }} c')).toEqual(['one', 'two']);
        expect(tokensIn('no tokens here')).toEqual([]);
    });
});
