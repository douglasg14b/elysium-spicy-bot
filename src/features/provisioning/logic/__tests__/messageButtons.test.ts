import { ButtonStyle, type APIButtonComponentWithCustomId } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildButtonRows,
    buttonDisplayName,
    isOneEmoji,
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

const NO_SERVER_EMOJI: ReadonlySet<string> = new Set();
const BLOBHEART_ID = '112233445566778899';

/** The one button `button` builds into, as it goes on the wire. */
function sent(button: MessageButton, serverEmojiIds: ReadonlySet<string> = NO_SERVER_EMOJI): APIButtonComponentWithCustomId {
    const [row] = buildButtonRows([button], serverEmojiIds);
    const [component] = (row?.toJSON().components ?? []) as APIButtonComponentWithCustomId[];
    if (!component) throw new Error('No button was built.');
    return component;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('buildButtonRows', () => {
    it.each([
        [0, []],
        [5, [5]],
        [6, [5, 1]],
        [25, [5, 5, 5, 5, 5]],
    ])('lays %i buttons out in rows of five', (count, rowSizes) => {
        expect(buildButtonRows(buttons(count), NO_SERVER_EMOJI).map((row) => row.components.length)).toEqual(rowSizes);
    });

    it('keeps the order, and gives each button its key’s id and its style', () => {
        const [row] = buildButtonRows(
            [
                { key: 'let-me-in', label: 'Let me in', style: 'Success' },
                { key: 'nope', label: 'Nope', style: 'Danger' },
            ],
            NO_SERVER_EMOJI
        );
        const components = row?.toJSON().components as APIButtonComponentWithCustomId[];

        expect(components.map((button) => [button.custom_id, button.label, button.style])).toEqual([
            ['mbtn:let-me-in', 'Let me in', ButtonStyle.Success],
            ['mbtn:nope', 'Nope', ButtonStyle.Danger],
        ]);
    });

    it('refuses a 26th button rather than have Discord refuse the message', () => {
        expect(() => buildButtonRows(buttons(26), NO_SERVER_EMOJI)).toThrow(/holds 25 buttons/);
    });

    it('puts a standard emoji beside the label, as its glyph alone', () => {
        expect(sent({ key: 'spicy', label: 'Spicy', style: 'Danger', emoji: { name: '🌶️' } })).toEqual({
            type: 2,
            custom_id: 'mbtn:spicy',
            style: ButtonStyle.Danger,
            label: 'Spicy',
            emoji: { name: '🌶️' },
        });
    });

    it("posts one of this server's emoji with its id and whether it moves", () => {
        const button: MessageButton = {
            key: 'love',
            label: 'Love',
            style: 'Primary',
            emoji: { id: BLOBHEART_ID, name: 'blobheart', animated: true },
        };

        expect(sent(button, new Set([BLOBHEART_ID])).emoji).toEqual({ id: BLOBHEART_ID, name: 'blobheart', animated: true });
    });

    it('posts an emoji-only button with no label at all', () => {
        expect(sent({ key: 'spicy', style: 'Danger', emoji: { name: '🌶️' } })).not.toHaveProperty('label');
    });

    it('drops a server emoji this server does not hold, logs it, and keeps the label', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const component = sent({ key: 'love', label: 'Love', style: 'Primary', emoji: { id: BLOBHEART_ID, name: 'blobheart' } });

        expect(component.label).toBe('Love');
        // `toJSON` keeps an unset emoji as `undefined`, which JSON drops on the wire.
        expect(component.emoji).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
            `[provisioning] posted button love without its emoji ${BLOBHEART_ID} — gone from the server`
        );
    });

    it('labels an emoji-only button :name: when its server emoji is gone, so Discord still takes it', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const component = sent({ key: 'love', style: 'Primary', emoji: { id: BLOBHEART_ID, name: 'blobheart' } });

        expect(component.label).toBe(':blobheart:');
        // `toJSON` keeps an unset emoji as `undefined`, which JSON drops on the wire.
        expect(component.emoji).toBeUndefined();
    });
});

describe('buttonDisplayName', () => {
    it.each<[string, Pick<MessageButton, 'key' | 'label' | 'emoji'>, string]>([
        ['its label, emoji or not', { key: 'spicy', label: 'Spicy', emoji: { name: '🌶️' } }, 'Spicy'],
        ['a standard emoji as its glyph', { key: 'spicy', emoji: { name: '🌶️' } }, '🌶️'],
        ['a server emoji as :name:', { key: 'love', emoji: { id: BLOBHEART_ID, name: 'blobheart' } }, ':blobheart:'],
        ['its key, with neither', { key: 'blank' }, 'blank'],
    ])('names a button by %s', (_label, button, expected) => {
        expect(buttonDisplayName(button)).toBe(expected);
    });
});

describe('isOneEmoji', () => {
    it.each(['🌶️', '🌶', '🏳️‍🌈', '1️⃣', '#️⃣', '🇬🇧', '👩‍👩‍👧', '👍🏽', '❤️', '❤', '🫩'])('takes %s', (name) => {
        expect(isOneEmoji(name)).toBe(true);
    });

    it.each([
        'ab',
        'x',
        '🌶️🌶️',
        'blobheart',
        ':fire:',
        '1',
        ' 🌶️',
        '',
        'x⃣',
        'a\u{20E3}',
        '\u{20E3}',
        '🇦',
        '🇬🇧🇫🇷',
        '🌶🏻',
        '\u{1FFFD}',
        '\u{1FAFF}',
    ])('refuses %j', (name) => {
        expect(isOneEmoji(name)).toBe(false);
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
