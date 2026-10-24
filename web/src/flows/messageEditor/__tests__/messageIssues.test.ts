import { describe, expect, it } from 'vitest';
import { placeMessageIssues } from '../messageIssues';

const MESSAGE = { embeds: [{ title: 'A', fields: [{ name: 'B', value: 'C' }] }, {}] };

describe('placing the server’s complaints about a message', () => {
    it('marks the part a complaint names, empty parts included', () => {
        const placed = placeMessageIssues(
            [
                { path: 'embeds.0.title', message: 'Too long.' },
                { path: 'embeds.0.fields.0.value', message: 'Needs text.' },
                { path: 'embeds.1.footer.iconUrl', message: 'Needs footer text beside it.' },
            ],
            MESSAGE
        );

        expect([...placed.byPart]).toEqual([
            ['embeds.0.title', ['Too long.']],
            ['embeds.0.fields.0.value', ['Needs text.']],
            ['embeds.1.footer.iconUrl', ['Needs footer text beside it.']],
        ]);
        expect(placed.rest).toEqual([]);
    });

    it('puts a complaint about an embed, or a part of it with no box, under that embed', () => {
        const placed = placeMessageIssues(
            [
                { path: 'embeds.1', message: 'Embed 2 is empty.' },
                { path: 'embeds.0.fields', message: '25 fields, tops.' },
            ],
            MESSAGE
        );

        expect([...placed.byEmbed]).toEqual([
            [1, ['Embed 2 is empty.']],
            [0, ['25 fields, tops.']],
        ]);
    });

    it('lists everything else, never dropping it', () => {
        const placed = placeMessageIssues(
            [
                { path: 'embeds', message: '10 embeds is the most.' },
                { path: 'embeds.7.title', message: 'About an embed that is gone.' },
            ],
            MESSAGE
        );

        expect(placed.rest).toEqual(['10 embeds is the most.', 'About an embed that is gone.']);
    });
});
