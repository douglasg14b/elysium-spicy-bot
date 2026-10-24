import { describe, expect, it } from 'vitest';
import type { DiscordEmbed } from '../messageConfigSchema';
import { trimMessageText } from '../trimMessageText';

const embed = (parts: Partial<DiscordEmbed>): DiscordEmbed => ({ fields: [], timestamp: false, ...parts });
const ICON = 'https://cdn.example/icon.png';

describe('trimMessageText', () => {
    it('trims the plain text, titles, bodies, header and footer text', () => {
        expect(
            trimMessageText({
                content: '  Kneel. ',
                embeds: [embed({ title: ' T ', description: '\nD\n', author: { name: ' A ' }, footer: { text: ' F ' } })],
            })
        ).toEqual({
            content: 'Kneel.',
            embeds: [embed({ title: 'T', description: 'D', author: { name: 'A' }, footer: { text: 'F' } })],
        });
    });

    it('leaves out a part that is blank once trimmed, keeping an icon beside it', () => {
        expect(
            trimMessageText({
                content: ' ',
                embeds: [
                    embed({ title: '\t', description: '', author: { name: ' ', iconUrl: ICON }, footer: { text: '  ' } }),
                ],
            })
        ).toEqual({ embeds: [embed({ author: { iconUrl: ICON }, footer: {} })] });
    });

    it('leaves field headings and text, and everything else, as they are', () => {
        const message = {
            embeds: [
                embed({
                    color: '#00A2FF',
                    url: 'https://example.com',
                    image: 'https://cdn.example/i.png',
                    fields: [{ name: ' n ', value: ' v ', inline: true }],
                    timestamp: true,
                }),
            ],
        };

        expect(trimMessageText(message)).toEqual(message);
    });
});
