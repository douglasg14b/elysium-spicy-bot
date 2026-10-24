import { describe, expect, it } from 'vitest';
import { messageConfigSchema } from '../messageConfigSchema';
import { MESSAGE_LIMITS } from '../messageLimits';
import { messageShape } from '../messageShape';
import { pictureRefSchema } from '../pictureRef';

/**
 * The message's per-part rules, each at its limit and one over.
 *
 * Run against the shape alone, as the block builds it, so the cross-part rules of
 * `messageProblems` never decide a case here — except the title link's parse check, which
 * only the block's `messageConfigSchema` makes, and is asked of it directly.
 */

const schema = messageShape({ picture: pictureRefSchema, fillDefaults: true });

/** A message with one embed holding `embed`. */
const withEmbed = (embed: Record<string, unknown>): unknown => ({ embeds: [embed] });

/** The messages a parse refused with, or nothing when it passed. */
function refusals(value: unknown): string[] {
    const parsed = schema.safeParse(value);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

const text = (length: number): string => 'x'.repeat(length);

describe('each part at its limit, and one over', () => {
    const field = (name: string, value: string) => withEmbed({ fields: [{ name, value }] });

    it.each([
        ['plain text', (length: number) => ({ content: text(length), embeds: [] }), MESSAGE_LIMITS.content, /Plain text stops at 2000/],
        ['a title', (length: number) => withEmbed({ title: text(length) }), MESSAGE_LIMITS.title, /Titles stop at 256/],
        ['a body', (length: number) => withEmbed({ description: text(length) }), MESSAGE_LIMITS.description, /body stops at 4096/],
        ['a field heading', (length: number) => field(text(length), 'v'), MESSAGE_LIMITS.fieldName, /Field headings stop at 256/],
        ['a field text', (length: number) => field('n', text(length)), MESSAGE_LIMITS.fieldValue, /Field text stops at 1024/],
        ['header text', (length: number) => withEmbed({ author: { name: text(length) } }), MESSAGE_LIMITS.authorName, /Header text stops at 256/],
        ['footer text', (length: number) => withEmbed({ footer: { text: text(length) } }), MESSAGE_LIMITS.footerText, /Footer text stops at 2048/],
    ] as const)('%s', (_part, build, limit, sentence) => {
        expect(refusals(build(limit))).toEqual([]);
        const over = refusals(build(limit + 1));
        expect(over).toHaveLength(1);
        expect(over[0]).toMatch(sentence);
    });

    it('ten embeds, and not eleven', () => {
        const embeds = (count: number) => ({ embeds: Array.from({ length: count }, () => ({ title: 't' })) });

        expect(refusals(embeds(MESSAGE_LIMITS.embeds))).toEqual([]);
        expect(refusals(embeds(MESSAGE_LIMITS.embeds + 1))).toEqual(['10 embeds is the most Discord takes in one message.']);
    });

    it('twenty-five fields to an embed, and not twenty-six', () => {
        const fields = (count: number) => withEmbed({ fields: Array.from({ length: count }, () => ({ name: 'n', value: 'v' })) });

        expect(refusals(fields(MESSAGE_LIMITS.fields))).toEqual([]);
        expect(refusals(fields(MESSAGE_LIMITS.fields + 1))).toEqual(['An embed holds 25 fields, tops.']);
    });
});

describe('the other per-part rules', () => {
    it('refuses an empty part rather than taking it as left out', () => {
        expect(refusals({ content: '', embeds: [] })).toEqual(['Plain text needs at least one character — or leave it out.']);
        expect(refusals(withEmbed({ title: '' }))).toEqual(['A title needs at least one character — or leave it out.']);
        expect(refusals(withEmbed({ fields: [{ name: '', value: 'v' }] }))).toEqual(['A field needs a heading.']);
    });

    it('takes a colour only as #RRGGBB', () => {
        expect(refusals(withEmbed({ color: '#00A2FF' }))).toEqual([]);
        expect(refusals(withEmbed({ color: 'cyan' }))).toEqual(['Colour must be a hex value like #00A2FF']);
    });

    it('takes a title link only as a full http(s) link', () => {
        expect(refusals(withEmbed({ url: 'https://example.com/rules' }))).toEqual([]);
        expect(refusals(withEmbed({ url: 'ftp://example.com' }))).toEqual([
            'A title link has to be a full link starting http:// or https://.',
        ]);
        expect(refusals(withEmbed({ url: 'https://' }))).toHaveLength(1);
    });

    it('takes a title link only if it parses, on the block side — the wire carries the pattern alone', () => {
        // Fits the pattern, and discord.js's `setURL` throws on it: every run would fail.
        const unparseable = withEmbed({ title: 't', url: 'https://a%zz/x' });

        expect(refusals(unparseable)).toEqual([]);
        const parsed = messageConfigSchema.safeParse(unparseable);
        expect(parsed.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
            ['embeds.0.url', "That title link doesn't read as a real address — check it for a stray % or an odd character."],
        ]);
        expect(messageConfigSchema.safeParse(withEmbed({ title: 't', url: 'https://example.com/rules' })).success).toBe(true);
    });

    it('says only the pattern’s sentence for a title link that does not fit it', () => {
        const parsed = messageConfigSchema.safeParse(withEmbed({ title: 't', url: 'ftp://a%zz/x' }));

        expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
            'A title link has to be a full link starting http:// or https://.',
        ]);
    });

    it('needs an embeds list, even an empty one', () => {
        expect(refusals({})).toHaveLength(1);
        expect(refusals('x')).toHaveLength(1);
    });

    it('fills in the defaults, so a message built whole and one left bare parse alike', () => {
        const parsed = schema.parse(withEmbed({ title: 't', fields: [{ name: 'n', value: 'v' }] }));

        expect(parsed.embeds[0]).toEqual({
            title: 't',
            fields: [{ name: 'n', value: 'v', inline: false }],
            timestamp: false,
        });
    });
});
