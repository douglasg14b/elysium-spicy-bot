import { describe, expect, it } from 'vitest';
import type { MessageButton as BrowserMessageButton } from '@brattybot/web-sdk';
import { buttonDisplayName as browserDisplayName } from '../../../../../web/src/flows/buttonEmoji';
import { buttonDisplayName } from '../messageButtons';

/**
 * What the dashboard calls a button against what the server calls it, over one table.
 *
 * The server names a button in its refusals, drift and the install note; the dashboard names
 * the same button in the trigger's picker, the Button Click card and a face's accessible name.
 * `web/src/flows/buttonEmoji.ts` mirrors the server's rule because the browser cannot import
 * the bot's tree, so a change to either — a fallback reordered, `:name:` spelled differently —
 * would have an operator reading one name in the builder and another in the error it gets back.
 */

const TABLE: readonly (readonly [string, BrowserMessageButton])[] = [
    ['a label alone', { key: 'let-me-in', label: 'Let me in', style: 'Success' }],
    ['a label beside an emoji', { key: 'spicy', label: 'Spicy', style: 'Danger', emoji: { name: '\u{1F336}\u{FE0F}' } }],
    ['a standard emoji alone', { key: 'agree', style: 'Success', emoji: { name: '\u{1F44D}' } }],
    [
        "one of the server's own, alone",
        { key: 'love', style: 'Primary', emoji: { id: '112233445566778899', name: 'blobheart', animated: false } },
    ],
    ['neither, which the save refuses', { key: 'blank', style: 'Secondary' }],
];

describe('the dashboard names a button as the server does', () => {
    it.each(TABLE)('%s', (_label, button) => {
        expect(browserDisplayName(button)).toBe(buttonDisplayName(button));
    });

    it('reaches every fallback, so a vacuous table cannot pass', () => {
        expect(TABLE.map(([, button]) => buttonDisplayName(button))).toEqual([
            'Let me in',
            'Spicy',
            '\u{1F44D}',
            ':blobheart:',
            'blank',
        ]);
    });
});
