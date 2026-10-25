import { ButtonStyle, type APIButtonComponentWithCustomId } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
    buildButtonRows,
    messageButtonCustomId,
    parseMessageButtonCustomId,
    type MessageButton,
} from '../messageButtons';

/** `count` buttons keyed `b1`, `b2`, … */
function buttons(count: number): MessageButton[] {
    return Array.from({ length: count }, (_unused, index) => ({
        key: `b${index + 1}`,
        label: `Button ${index + 1}`,
        style: 'Primary' as const,
    }));
}

describe('buildButtonRows', () => {
    it.each([
        [0, []],
        [5, [5]],
        [6, [5, 1]],
        [25, [5, 5, 5, 5, 5]],
    ])('lays %i buttons out in rows of five', (count, rowSizes) => {
        expect(buildButtonRows(buttons(count)).map((row) => row.components.length)).toEqual(rowSizes);
    });

    it('keeps the order, and gives each button its key’s id and its style', () => {
        const [row] = buildButtonRows([
            { key: 'let-me-in', label: 'Let me in', style: 'Success' },
            { key: 'nope', label: 'Nope', style: 'Danger' },
        ]);
        const sent = row?.toJSON().components as APIButtonComponentWithCustomId[];

        expect(sent.map((button) => [button.custom_id, button.label, button.style])).toEqual([
            ['mbtn:let-me-in', 'Let me in', ButtonStyle.Success],
            ['mbtn:nope', 'Nope', ButtonStyle.Danger],
        ]);
    });

    it('refuses a 26th button rather than have Discord refuse the message', () => {
        expect(() => buildButtonRows(buttons(26))).toThrow(/holds 25 buttons/);
    });
});

describe('the message button id', () => {
    it('round-trips a key', () => {
        expect(parseMessageButtonCustomId(messageButtonCustomId('let-me-in'))).toBe('let-me-in');
    });

    it.each(['flow:flow-id:node-id', 'flowc:run:node:0', 'mbtn:', 'mbtn:a:b', 'mbtnx:a'])('refuses %s', (customId) => {
        expect(parseMessageButtonCustomId(customId)).toBeNull();
    });
});
