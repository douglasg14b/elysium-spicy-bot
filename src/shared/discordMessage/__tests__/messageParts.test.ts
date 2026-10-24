import { describe, expect, it } from 'vitest';
import type { DiscordEmbed } from '../messageConfigSchema';
import { messageCharacterCount, messageCopyLocations, messageUploadIds } from '../messageParts';

const UPLOAD_A = '11111111-2222-4333-8444-555555555555';
const UPLOAD_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';

const embed = (parts: Partial<DiscordEmbed>): DiscordEmbed => ({ fields: [], timestamp: false, ...parts });

describe('messageCharacterCount', () => {
    it("counts every embed's title, body, field headings and text, footer and header — Discord's rule", () => {
        const count = messageCharacterCount({
            content: 'Plain text is not counted',
            embeds: [
                embed({
                    title: 'abc', // 3
                    description: 'defg', // 4
                    fields: [{ name: 'hi', value: 'there', inline: false }], // 2 + 5
                    footer: { text: 'ft', iconUrl: 'https://cdn.example/f.png' }, // 2
                    author: { name: 'auth' }, // 4
                    url: 'https://example.com/not-counted',
                    image: 'https://cdn.example/not-counted.png',
                }),
                embed({ title: 'x', fields: [{ name: 'a', value: 'b', inline: true }] }), // 1 + 1 + 1
            ],
        });

        expect(count).toBe(3 + 4 + 2 + 5 + 2 + 4 + 3);
    });

    it('is nothing for a message of plain text alone', () => {
        expect(messageCharacterCount({ content: 'Hello', embeds: [] })).toBe(0);
    });

    it('counts only the text around tokens when asked, and takes a message with its defaults left out', () => {
        const authored = { embeds: [{ title: 'Hi {{subject.username}}!', fields: [{ name: '{{ var.x }}', value: 'ok' }] }] };

        expect(messageCharacterCount(authored, 'outsideTokens')).toBe('Hi !'.length + 'ok'.length);
        expect(messageCharacterCount(authored)).toBe('Hi {{subject.username}}!'.length + '{{ var.x }}'.length + 2);
    });
});

describe('messageCopyLocations', () => {
    it('lists every copy string with where an author finds it, numbered from one', () => {
        const locations = messageCopyLocations({
            content: 'Plain',
            embeds: [
                { title: 'First' },
                {
                    author: { name: 'Header', iconUrl: '{{subject.avatarUrl}}' },
                    title: 'Second',
                    description: 'Body',
                    thumbnail: 'https://cdn.example/t.png',
                    fields: [
                        { name: 'H1', value: 'T1' },
                        { name: 'H2', value: 'T2' },
                    ],
                    image: `upload:${UPLOAD_A}`,
                    footer: { text: 'Foot', iconUrl: `upload:${UPLOAD_B}` },
                },
            ],
        });

        expect(locations.map(({ where, path, maxLength }) => [where, path.join('.'), maxLength])).toEqual([
            ['plain text', 'content', 2000],
            ['embed 1 title', 'embeds.0.title', 256],
            ['embed 2 header', 'embeds.1.author.name', 256],
            ['embed 2 header icon', 'embeds.1.author.iconUrl', undefined],
            ['embed 2 title', 'embeds.1.title', 256],
            ['embed 2 body', 'embeds.1.description', 4096],
            ['embed 2 thumbnail', 'embeds.1.thumbnail', undefined],
            ['embed 2 field 1 heading', 'embeds.1.fields.0.name', 256],
            ['embed 2 field 1 text', 'embeds.1.fields.0.value', 1024],
            ['embed 2 field 2 heading', 'embeds.1.fields.1.name', 256],
            ['embed 2 field 2 text', 'embeds.1.fields.1.value', 1024],
            ['embed 2 footer', 'embeds.1.footer.text', 2048],
        ]);
        // The two uploads are absent: an upload is attached, never rendered.
        expect(locations.find((location) => location.value.startsWith('upload:'))).toBeUndefined();
    });

    it('has every picture, and no text part, judge what it rendered to: a link, or a sentence naming the part', () => {
        const locations = messageCopyLocations({
            content: 'Plain',
            embeds: [{ title: 'T', image: '{{var.pic}}' }],
        });
        const [content, title, image] = locations;

        expect(content?.checkRendered).toBeUndefined();
        expect(title?.checkRendered).toBeUndefined();
        expect(image?.checkRendered?.('"Message" embed 1 image', 'https://cdn.example/a.png')).toBeUndefined();
        expect(image?.checkRendered?.('"Message" embed 1 image', `upload:${UPLOAD_A}`)).toMatch(
            new RegExp(`^"Message" embed 1 image came out as "upload:${UPLOAD_A}"`)
        );
    });

    it('gives nothing for a value that is not a message object', () => {
        expect(messageCopyLocations(undefined)).toEqual([]);
        expect(messageCopyLocations('Hey {{subject.mention}}')).toEqual([]);
        expect(messageCopyLocations([{ title: 'x' }])).toEqual([]);
        expect(messageCopyLocations(null)).toEqual([]);
    });

    it('skips a part that is not a string, and a container of the wrong shape, leaving both to the schema', () => {
        const locations = messageCopyLocations({
            content: 42,
            embeds: [
                'not an embed',
                { title: ['nope'], description: 'kept', fields: 'not a list', author: 'not an object' },
                { fields: [null, { name: 7, value: 'kept too' }] },
            ],
        });

        expect(locations.map(({ where, value }) => [where, value])).toEqual([
            ['embed 2 body', 'kept'],
            ['embed 3 field 2 text', 'kept too'],
        ]);
    });

    it('reads an embeds key that is not a list as no embeds', () => {
        expect(messageCopyLocations({ content: 'Hi', embeds: 'many' }).map(({ where }) => where)).toEqual(['plain text']);
    });
});

describe('messageUploadIds', () => {
    it('lists each upload once, in the order first named', () => {
        const ids = messageUploadIds({
            embeds: [
                { thumbnail: `upload:${UPLOAD_B}`, image: `upload:${UPLOAD_A}` },
                { author: { name: 'n', iconUrl: `upload:${UPLOAD_B}` }, footer: { text: 'f', iconUrl: `upload:${UPLOAD_A}` } },
                { image: 'https://cdn.example/link.png', title: `upload:${UPLOAD_A}-is-a-title-not-a-picture` },
            ],
        });

        expect(ids).toEqual([UPLOAD_B, UPLOAD_A]);
    });

    it('names no upload for a message with none, or a value that is not one', () => {
        expect(messageUploadIds({ embeds: [{ image: 'https://cdn.example/a.png' }] })).toEqual([]);
        expect(messageUploadIds('upload:' + UPLOAD_A)).toEqual([]);
    });
});
