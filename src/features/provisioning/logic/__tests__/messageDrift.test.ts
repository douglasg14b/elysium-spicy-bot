import { describe, expect, it } from 'vitest';
import { canonicalJson, messageDigest } from '../messageDrift';

/**
 * The fingerprint a posted message is stored with, which drift compares against. It must
 * not move for anything but a change to what is posted — above all not for key order,
 * which Postgres's `jsonb` reorders on every read.
 *
 * Key order is pinned on `canonicalJson` directly: `messageDigest` parses the message first,
 * and the parse re-emits its keys in schema order, so a reordered message would hash the
 * same through it even with `JSON.stringify` in `canonicalJson`'s place.
 */

describe('canonicalJson', () => {
    it('writes the same text whatever order an object’s keys arrive in, at every depth', () => {
        const stored = { message: { embeds: [{ title: 'Rules', color: '#00A2FF' }], content: 'Read me' }, buttons: [] };
        const fromJsonb = { buttons: [], message: { content: 'Read me', embeds: [{ color: '#00A2FF', title: 'Rules' }] } };

        expect(canonicalJson(fromJsonb)).toBe(canonicalJson(stored));
    });

    it('keeps an array’s order, which is meaning, not storage', () => {
        expect(canonicalJson(['a', 'b'])).not.toBe(canonicalJson(['b', 'a']));
    });

    it('leaves out an undefined member, as JSON does', () => {
        expect(canonicalJson({ title: 'Rules', url: undefined })).toBe(canonicalJson({ title: 'Rules' }));
    });
});

describe('messageDigest', () => {
    const MESSAGE = { content: 'Read me', embeds: [{ title: 'Rules', fields: [{ name: 'One', value: 'Be nice' }] }] };
    const BUTTONS = [{ key: 'agree', label: 'I agree', style: 'Success' as const }];

    it('hashes a message with its defaults filled, so an absent part and its default are the same', () => {
        const bare = { embeds: [{ title: 'Rules' }] };
        const filled = { embeds: [{ title: 'Rules', fields: [], timestamp: false }] };

        expect(messageDigest(filled)).toBe(messageDigest(bare));
    });

    // What drift relies on, end to end. Held by the parse and the button mapping as much as by
    // `canonicalJson` (see the header), so it passes with either alone; the guard on
    // `canonicalJson` itself is above.
    it('hashes the same declaration the same with its keys in another order, as jsonb hands it back', () => {
        const fromJsonb = {
            embeds: [{ fields: [{ value: 'Be nice', name: 'One' }], title: 'Rules' }],
            content: 'Read me',
        };
        const reorderedButtons = [{ style: 'Success' as const, label: 'I agree', key: 'agree' }];

        expect(messageDigest(fromJsonb, reorderedButtons)).toBe(messageDigest(MESSAGE, BUTTONS));
    });

    it('treats no buttons and an empty list as the same', () => {
        expect(messageDigest(MESSAGE, [])).toBe(messageDigest(MESSAGE));
    });

    it('changes when what is posted changes: a title, or a button’s label', () => {
        const base = messageDigest(MESSAGE, BUTTONS);

        expect(messageDigest({ ...MESSAGE, embeds: [{ ...MESSAGE.embeds[0], title: 'New rules' }] }, BUTTONS)).not.toBe(base);
        expect(messageDigest(MESSAGE, [{ ...BUTTONS[0]!, label: 'Fine, whatever' }])).not.toBe(base);
    });

    it('changes when a button’s emoji is added, swapped or taken off', () => {
        const withChilli = [{ ...BUTTONS[0]!, emoji: { name: '🌶️' } }];
        const withBlobheart = [{ ...BUTTONS[0]!, emoji: { id: '112233445566778899', name: 'blobheart', animated: false } }];

        const digests = [BUTTONS, withChilli, withBlobheart].map((buttons) => messageDigest(MESSAGE, buttons));

        expect(new Set(digests).size).toBe(3);
    });

    it('tells two emoji-only buttons apart by their emoji', () => {
        const emojiOnly = (name: string) => [{ key: 'agree', style: 'Success' as const, emoji: { name } }];

        expect(messageDigest(MESSAGE, emojiOnly('🌶️'))).not.toBe(messageDigest(MESSAGE, emojiOnly('👍')));
    });

    it('is a SHA-256 in hex', () => {
        expect(messageDigest(MESSAGE)).toMatch(/^[0-9a-f]{64}$/);
    });

    /*
     * Pinned, because every posted message's `message_digest` was stored by this function. If
     * this value has to change — `canonicalJson`, the parse's defaults, the button mapping or
     * the hash — every stored digest reads as out of date, and every installed message is
     * offered for repair at once. Recompute them alongside the change: a migration, or one
     * repair pass over every journey. Never just update the expected value. A button with no
     * emoji must keep hashing to this: emoji arrived after these digests were stored.
     */
    it('hashes this fixture to exactly what is already stored', () => {
        expect(messageDigest(MESSAGE, BUTTONS)).toBe('68c9e164b42eebe856c63c6857044ebbdc79a33423d1cc93cead997c584c17e5');
    });
});
