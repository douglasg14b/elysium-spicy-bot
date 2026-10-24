import { describe, expect, it } from 'vitest';
import { zDiscordMessage } from '../../../../packages/web-sdk/src/gen/zod.gen';
import { MESSAGE_LIMITS } from '../messageLimits';
import { messageShape } from '../messageShape';
import { pictureRefSchema } from '../pictureRef';

/**
 * The browser's `zDiscordMessage` — generated from the spec's `DiscordMessage`, which
 * `messageBody.ts` builds from this same `messageShape` — against the block's own shape.
 *
 * One set of messages through both: every case is taken or refused alike, with the same
 * sentences, **except picture form**, which only the block's refined `pictureRefSchema`
 * judges. Verdicts, not parsed values: the block fills `fields`, `inline` and `timestamp`
 * where the wire leaves them optional, and both take their absence. The cross-part rules
 * (`messageProblems`) are left out of both on purpose: the browser never runs them, and the
 * block runs them in a `superRefine` this compares around.
 *
 * Fails until `pnpm sdk:generate` has been run after a change to the shape.
 */

const blockShape = messageShape({ picture: pictureRefSchema, fillDefaults: true });

const text = (length: number): string => 'x'.repeat(length);
const withEmbed = (embed: Record<string, unknown>): unknown => ({ embeds: [embed] });

/** What one schema says about a value: taken, or the sentences it refused with, sorted. */
function verdict(schema: { safeParse: (value: unknown) => { success: boolean; error?: { issues: { message: string }[] } } }, value: unknown) {
    const parsed = schema.safeParse(value);
    return parsed.success ? 'taken' : (parsed.error?.issues.map((issue) => issue.message).sort() ?? []);
}

const AGREED: readonly (readonly [string, unknown])[] = [
    ['plain text alone', { content: 'Hi', embeds: [] }],
    ['no parts at all', { embeds: [] }],
    ['a full embed', withEmbed({
        color: '#FF2D95',
        author: { name: 'The Management', iconUrl: 'https://cdn.example/a.png' },
        title: 'House Rules',
        url: 'https://example.com/rules',
        description: 'Read them.',
        fields: [{ name: 'Safeword', value: 'Red', inline: true }],
        thumbnail: 'https://cdn.example/t.png',
        image: 'https://cdn.example/i.png',
        footer: { text: 'Behave', iconUrl: 'https://cdn.example/f.png' },
        timestamp: true,
    })],
    ['plain text at its limit', { content: text(MESSAGE_LIMITS.content), embeds: [] }],
    ['plain text one over', { content: text(MESSAGE_LIMITS.content + 1), embeds: [] }],
    ['empty plain text', { content: '', embeds: [] }],
    ['a title one over', withEmbed({ title: text(MESSAGE_LIMITS.title + 1) })],
    ['an empty title', withEmbed({ title: '' })],
    ['a body one over', withEmbed({ description: text(MESSAGE_LIMITS.description + 1) })],
    ['a field heading one over', withEmbed({ fields: [{ name: text(MESSAGE_LIMITS.fieldName + 1), value: 'v' }] })],
    ['a field text one over', withEmbed({ fields: [{ name: 'n', value: text(MESSAGE_LIMITS.fieldValue + 1) }] })],
    ['a field with no heading', withEmbed({ fields: [{ name: '', value: 'v' }] })],
    ['too many fields', withEmbed({ fields: Array.from({ length: MESSAGE_LIMITS.fields + 1 }, () => ({ name: 'n', value: 'v' })) })],
    ['header text one over', withEmbed({ author: { name: text(MESSAGE_LIMITS.authorName + 1) } })],
    ['footer text one over', withEmbed({ footer: { text: text(MESSAGE_LIMITS.footerText + 1) } })],
    ['too many embeds', { embeds: Array.from({ length: MESSAGE_LIMITS.embeds + 1 }, () => ({ title: 't' })) }],
    ['a colour that is not hex', withEmbed({ color: 'hot pink' })],
    ['a title link that is not http(s)', withEmbed({ url: 'mailto:someone@example.com' })],
    ['a title link with no host', withEmbed({ url: 'https://' })],
    ['a title link with a capitalised scheme', withEmbed({ url: 'Https://example.com' })],
    ['an upload picture', withEmbed({ image: 'upload:11111111-2222-4333-8444-555555555555' })],
    ['a token picture', withEmbed({ thumbnail: '{{subject.avatarUrl}}' })],
    ['no embeds key', {}],
    ['not an object', 'x'],
];

/** Picture strings only the block judges; the wire takes any string there. */
const PICTURE_FORM_ONLY: readonly (readonly [string, unknown])[] = [
    ['a picture that is a word', withEmbed({ image: 'a cute picture' })],
    ['an icon that is not http(s)', withEmbed({ title: 't', author: { name: 'n', iconUrl: 'ftp://cdn.example/a.png' } })],
    ['a link no URL parser takes', withEmbed({ thumbnail: 'https://a%zz/x.png' })],
];

describe('the block’s message shape and the browser’s zDiscordMessage', () => {
    it.each(AGREED)('agree on %s', (_name, value) => {
        expect(verdict(zDiscordMessage, value)).toEqual(verdict(blockShape, value));
    });

    it.each(PICTURE_FORM_ONLY)('differ only on picture form: %s', (_name, value) => {
        expect(verdict(zDiscordMessage, value)).toBe('taken');
        expect(verdict(blockShape, value)).toEqual([
            'A picture takes an upload, a full http:// or https:// link, or a token like {{subject.avatarUrl}}.',
        ]);
    });
});
