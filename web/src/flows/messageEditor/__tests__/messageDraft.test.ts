import { describe, expect, it } from 'vitest';
import {
    addEmbed,
    addField,
    deleteEmbed,
    duplicateEmbed,
    moveEmbed,
    moveField,
    newEmbed,
    partPath,
    readMessageDraft,
    readPicture,
    readTextPart,
    removeField,
    setColour,
    setFieldInline,
    setPicture,
    setTextPart,
    setTimestamp,
    startingMessage,
    type MessageDraft,
} from '../messageDraft';

/**
 * Every edit the message window makes. Each is checked for what it makes **and** for leaving
 * what it was given alone — the input is frozen all the way down, so an edit made in place
 * throws rather than passing quietly, and the result is a different object from the input.
 */

function deepFreeze<TValue>(value: TValue): TValue {
    if (value !== null && typeof value === 'object') {
        for (const inner of Object.values(value)) deepFreeze(inner);
        Object.freeze(value);
    }
    return value;
}

/** A message two embeds long, frozen, with something in every part of the first. */
function sample(): MessageDraft {
    return deepFreeze<MessageDraft>({
        content: 'Hey {{subject.mention}}',
        embeds: [
            {
                color: '#00A2FF',
                author: { name: 'The Management', iconUrl: 'https://cdn.example/a.png' },
                title: 'House rules',
                url: 'https://example.com/rules',
                description: 'Read them.',
                thumbnail: 'upload:7d4f3b52-9a51-4a7b-8f53-0f6c5b0d2c11',
                fields: [
                    { name: 'Age', value: '18+', inline: true },
                    { name: 'Safewords', value: 'Red / Yellow' },
                ],
                image: 'https://cdn.example/banner.png',
                footer: { text: 'Behave.', iconUrl: '{{subject.avatarUrl}}' },
                timestamp: true,
            },
            { color: '#FF2D95', title: 'Second' },
        ],
    });
}

describe('reading a stored message', () => {
    it('reads nothing from a value that is not a message', () => {
        expect(readMessageDraft(undefined)).toBeUndefined();
        expect(readMessageDraft('hello')).toBeUndefined();
        expect(readMessageDraft([])).toBeUndefined();
    });

    it('keeps every part of a whole message', () => {
        expect(readMessageDraft(sample())).toEqual(sample());
    });

    it('keeps a part over its limit, so an unfinished message can still be cut down', () => {
        const long = 'x'.repeat(300);
        expect(readMessageDraft({ embeds: [{ title: long }] })?.embeds[0]?.title).toBe(long);
    });

    it('reads back exactly what the server stores, defaults written out included', () => {
        const stored = { embeds: [{ title: 'A', fields: [], timestamp: false }, { fields: [{ name: 'B', value: 'C', inline: false }] }] };

        expect(readMessageDraft(stored)).toEqual(stored);
    });

    it('leaves out parts of the wrong type, and keeps every embed at its position', () => {
        const read = readMessageDraft({
            content: 7,
            embeds: ['nonsense', { title: 3, description: 'kept', author: { name: 5 }, fields: [{ name: 1 }], timestamp: 'yes' }],
        });

        expect(read).toEqual({ embeds: [{}, { description: 'kept', fields: [{ name: '', value: '' }] }] });
    });
});

describe('starting a message', () => {
    it('opens with one embed in the colour given', () => {
        expect(startingMessage('#00A2FF')).toEqual({ embeds: [{ color: '#00A2FF' }] });
        expect(newEmbed(undefined)).toEqual({});
    });
});

describe('text parts', () => {
    it('sets each part where the server addresses it', () => {
        const parts = [
            [{ kind: 'content' }, 'content'],
            [{ kind: 'authorName', embed: 1 }, 'embeds.1.author.name'],
            [{ kind: 'title', embed: 1 }, 'embeds.1.title'],
            [{ kind: 'url', embed: 1 }, 'embeds.1.url'],
            [{ kind: 'description', embed: 1 }, 'embeds.1.description'],
            [{ kind: 'footerText', embed: 1 }, 'embeds.1.footer.text'],
        ] as const;

        for (const [part, path] of parts) {
            const before = sample();
            const after = setTextPart(before, part, 'new words');

            expect(readTextPart(after, part), path).toBe('new words');
            expect(partPath(part)).toBe(path);
            expect(after).not.toBe(before);
            expect(before).toEqual(sample());
        }
    });

    it("sets a field's heading and text", () => {
        const before = sample();
        const named = setTextPart(before, { kind: 'fieldName', embed: 0, field: 1 }, 'Limits');
        const written = setTextPart(named, { kind: 'fieldValue', embed: 0, field: 1 }, 'Ask first');

        expect(written.embeds[0]?.fields?.[1]).toEqual({ name: 'Limits', value: 'Ask first' });
        expect(written.embeds[0]?.fields?.[0]).toBe(before.embeds[0]?.fields?.[0]);
        expect(written.embeds[1]).toBe(before.embeds[1]);
        expect(partPath({ kind: 'fieldValue', embed: 0, field: 1 })).toBe('embeds.0.fields.1.value');
    });

    it('removes a cleared part, rather than writing an empty one', () => {
        const before = sample();

        const noContent = setTextPart(before, { kind: 'content' }, '');
        const noTitle = setTextPart(before, { kind: 'title', embed: 0 }, '');

        expect('content' in noContent).toBe(false);
        expect('title' in (noTitle.embeds[0] ?? {})).toBe(false);
        expect(before).toEqual(sample());
    });

    it('keeps the header while its icon stays, and drops it once both are gone', () => {
        const before = sample();
        const nameless = setTextPart(before, { kind: 'authorName', embed: 0 }, '');
        const bare = setPicture(nameless, { kind: 'authorIcon', embed: 0 }, undefined);

        expect(nameless.embeds[0]?.author).toEqual({ iconUrl: 'https://cdn.example/a.png' });
        expect('author' in (bare.embeds[0] ?? {})).toBe(false);
    });

    it('drops the footer once its text and icon are both gone', () => {
        const textless = setTextPart(sample(), { kind: 'footerText', embed: 0 }, '');
        const bare = setPicture(textless, { kind: 'footerIcon', embed: 0 }, '');

        expect(textless.embeds[0]?.footer).toEqual({ iconUrl: '{{subject.avatarUrl}}' });
        expect('footer' in (bare.embeds[0] ?? {})).toBe(false);
    });

    it("keeps an emptied field heading as empty, since a field can't be without one", () => {
        const after = setTextPart(sample(), { kind: 'fieldName', embed: 0, field: 0 }, '');

        expect(after.embeds[0]?.fields?.[0]).toEqual({ name: '', value: '18+', inline: true });
    });

    it('starts a header on an embed that had none', () => {
        const after = setTextPart(sample(), { kind: 'authorName', embed: 1 }, 'Staff');

        expect(after.embeds[1]).toEqual({ color: '#FF2D95', title: 'Second', author: { name: 'Staff' } });
    });
});

describe('pictures', () => {
    it('sets and reads each of the four', () => {
        for (const kind of ['authorIcon', 'thumbnail', 'image', 'footerIcon'] as const) {
            const before = sample();
            const after = setPicture(before, { kind, embed: 1 }, 'upload:0e6f1d2a-5b4c-4d3e-8f2a-1b0c9d8e7f6a');

            expect(readPicture(after, { kind, embed: 1 }), kind).toBe('upload:0e6f1d2a-5b4c-4d3e-8f2a-1b0c9d8e7f6a');
            expect(before).toEqual(sample());
        }
        expect(partPath({ kind: 'footerIcon', embed: 2 })).toBe('embeds.2.footer.iconUrl');
        expect(partPath({ kind: 'thumbnail', embed: 0 })).toBe('embeds.0.thumbnail');
    });

    it('removes one, leaving its key out', () => {
        const after = setPicture(sample(), { kind: 'image', embed: 0 }, undefined);

        expect('image' in (after.embeds[0] ?? {})).toBe(false);
    });
});

describe('embeds', () => {
    it('adds one at the bottom in the colour given', () => {
        const before = sample();
        const after = addEmbed(before, '#7A5CFF');

        expect(after.embeds).toHaveLength(3);
        expect(after.embeds[2]).toEqual({ color: '#7A5CFF' });
        expect(after.embeds[0]).toBe(before.embeds[0]);
        expect(before.embeds).toHaveLength(2);
    });

    it('moves one past its neighbour, and stays put at either end', () => {
        const before = sample();

        expect(moveEmbed(before, 1, -1).embeds.map((embed) => embed.title)).toEqual(['Second', 'House rules']);
        expect(moveEmbed(before, 0, 1).embeds.map((embed) => embed.title)).toEqual(['Second', 'House rules']);
        expect(moveEmbed(before, 0, -1).embeds).toEqual(before.embeds);
        expect(moveEmbed(before, 1, 1).embeds).toEqual(before.embeds);
        expect(moveEmbed(before, 0, -1).embeds).not.toBe(before.embeds);
        expect(before).toEqual(sample());
    });

    it('duplicates one straight after itself, sharing nothing with the original', () => {
        const before = sample();
        const after = duplicateEmbed(before, 0);

        expect(after.embeds.map((embed) => embed.title)).toEqual(['House rules', 'House rules', 'Second']);
        expect(after.embeds[1]).toEqual(before.embeds[0]);
        expect(after.embeds[1]).not.toBe(before.embeds[0]);
        expect(after.embeds[1]?.author).not.toBe(before.embeds[0]?.author);
        expect(after.embeds[1]?.footer).not.toBe(before.embeds[0]?.footer);
        expect(after.embeds[1]?.fields).not.toBe(before.embeds[0]?.fields);
        expect(after.embeds[1]?.fields?.[0]).not.toBe(before.embeds[0]?.fields?.[0]);
    });

    it('deletes one', () => {
        const before = sample();
        const after = deleteEmbed(before, 0);

        expect(after.embeds).toEqual([before.embeds[1]]);
        expect(before.embeds).toHaveLength(2);
    });

    it('sets and clears its colour', () => {
        const before = sample();

        expect(setColour(before, 1, '#7a5cff').embeds[1]?.color).toBe('#7a5cff');
        expect('color' in (setColour(before, 1, undefined).embeds[1] ?? {})).toBe(false);
        expect(before).toEqual(sample());
    });

    it('turns its timestamp on and off, leaving the key out when off', () => {
        const before = sample();

        expect(setTimestamp(before, 1, true).embeds[1]?.timestamp).toBe(true);
        expect('timestamp' in (setTimestamp(before, 0, false).embeds[0] ?? {})).toBe(false);
        expect(before).toEqual(sample());
    });
});

describe('fields', () => {
    it('adds an empty one, on an embed with none yet too', () => {
        const before = sample();

        expect(addField(before, 0).embeds[0]?.fields).toHaveLength(3);
        expect(addField(before, 1).embeds[1]?.fields).toEqual([{ name: '', value: '' }]);
        expect(before).toEqual(sample());
    });

    it('removes one, and the list with its last', () => {
        const before = sample();
        const once = removeField(before, 0, 0);
        const twice = removeField(once, 0, 0);

        expect(once.embeds[0]?.fields).toEqual([{ name: 'Safewords', value: 'Red / Yellow' }]);
        expect('fields' in (twice.embeds[0] ?? {})).toBe(false);
        expect(before).toEqual(sample());
    });

    it('moves one past its neighbour, and stays put at an end', () => {
        const before = sample();

        expect(moveField(before, 0, 0, 1).embeds[0]?.fields?.map((field) => field.name)).toEqual(['Safewords', 'Age']);
        expect(moveField(before, 0, 1, 1).embeds[0]?.fields?.map((field) => field.name)).toEqual(['Age', 'Safewords']);
        expect(before).toEqual(sample());
    });

    it('sets one inline, and back onto a row of its own', () => {
        const before = sample();

        expect(setFieldInline(before, 0, 1, true).embeds[0]?.fields?.[1]).toEqual({
            name: 'Safewords',
            value: 'Red / Yellow',
            inline: true,
        });
        expect(setFieldInline(before, 0, 0, false).embeds[0]?.fields?.[0]).toEqual({ name: 'Age', value: '18+' });
        expect(before).toEqual(sample());
    });
});
