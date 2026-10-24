import { describe, expect, it } from 'vitest';
import { buildMessagePayload, type MessageUploadFile } from '../buildMessagePayload';
import type { DiscordEmbed } from '../messageConfigSchema';

const UPLOAD_A = '11111111-2222-4333-8444-555555555555';
const UPLOAD_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';

const embed = (parts: Partial<DiscordEmbed>): DiscordEmbed => ({ fields: [], timestamp: false, ...parts });

const uploads: readonly MessageUploadFile[] = [
    { uploadId: UPLOAD_A, extension: 'png', bytes: Buffer.from('a-bytes') },
    { uploadId: UPLOAD_B, extension: 'webp', bytes: Buffer.from('b-bytes') },
];

describe('buildMessagePayload', () => {
    it('attaches an upload used twice once, and points every part showing it at that one file', () => {
        const payload = buildMessagePayload(
            {
                embeds: [
                    embed({ title: 'One', thumbnail: `upload:${UPLOAD_A}`, footer: { text: 'f', iconUrl: `upload:${UPLOAD_A}` } }),
                    embed({ title: 'Two', image: `upload:${UPLOAD_A}`, author: { name: 'h', iconUrl: `upload:${UPLOAD_B}` } }),
                ],
            },
            uploads
        );

        expect(payload.files).toEqual([
            { attachment: Buffer.from('a-bytes'), name: `${UPLOAD_A}.png` },
            { attachment: Buffer.from('b-bytes'), name: `${UPLOAD_B}.webp` },
        ]);
        const [first, second] = payload.embeds.map((built) => built.toJSON());
        expect(first?.thumbnail?.url).toBe(`attachment://${UPLOAD_A}.png`);
        expect(first?.footer).toEqual({ text: 'f', icon_url: `attachment://${UPLOAD_A}.png` });
        expect(second?.image?.url).toBe(`attachment://${UPLOAD_A}.png`);
        expect(second?.author).toEqual({ name: 'h', icon_url: `attachment://${UPLOAD_B}.webp` });
    });

    it('passes the plain text and every part through, a link as it is', () => {
        const payload = buildMessagePayload(
            {
                content: 'Read this',
                embeds: [
                    embed({
                        color: '#00A2FF',
                        title: 'Rules',
                        url: 'https://example.com/rules',
                        description: 'Behave.',
                        fields: [{ name: 'Safeword', value: 'Red', inline: true }],
                        image: 'https://cdn.example/a.png',
                        timestamp: true,
                    }),
                ],
            },
            []
        );

        expect(payload.content).toBe('Read this');
        expect(payload.files).toEqual([]);
        const built = payload.embeds[0]?.toJSON();
        expect(built).toMatchObject({
            color: 0x00a2ff,
            title: 'Rules',
            url: 'https://example.com/rules',
            description: 'Behave.',
            fields: [{ name: 'Safeword', value: 'Red', inline: true }],
            image: { url: 'https://cdn.example/a.png' },
        });
        expect(built?.timestamp).toEqual(expect.any(String));
    });

    it('leaves the plain text out when there is none', () => {
        expect('content' in buildMessagePayload({ embeds: [embed({ title: 'T' })] }, [])).toBe(false);
    });

    it('attaches nothing for an icon on a header or footer that is left off for want of text', () => {
        const payload = buildMessagePayload(
            {
                embeds: [
                    embed({ title: 'T', author: { iconUrl: `upload:${UPLOAD_A}` }, footer: { iconUrl: `upload:${UPLOAD_B}` } }),
                ],
            },
            uploads
        );

        expect(payload.files).toEqual([]);
        expect(payload.embeds[0]?.toJSON().author).toBeUndefined();
    });

    it('refuses an upload it was not given, rather than posting without it', () => {
        expect(() => buildMessagePayload({ embeds: [embed({ image: `upload:${UPLOAD_A}` })] }, [])).toThrow(
            new RegExp(`not given upload ${UPLOAD_A}`)
        );
    });

    it('refuses a picture still holding a token, which has to be rendered and checked first', () => {
        expect(() => buildMessagePayload({ embeds: [embed({ image: '{{subject.avatarUrl}}' })] }, [])).toThrow(
            /not a link or an upload/
        );
    });
});
