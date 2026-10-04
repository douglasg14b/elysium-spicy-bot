import { describe, expect, it } from 'vitest';
import type { GuildChannel, TicketCategoryView } from '@brattybot/web-sdk';
import {
    CREATE_NEW_CATEGORY,
    categorySlotNote,
    categorySlotOptions,
    choiceFromDraft,
    draftFromView,
} from '../categorySlots';

const CHANNELS: GuildChannel[] = [
    { id: '100000000000000001', name: 'Support', type: 'category', parentId: null, parentName: null },
    { id: '100000000000000002', name: 'general', type: 'text', parentId: null, parentName: null },
];

const UNLINKED: TicketCategoryView = { name: 'Support', discordId: null, provenance: null, liveName: null };

describe('ticket category slots', () => {
    it('starts an unlinked slot with nothing picked, even when a category has its old name', () => {
        // Preselecting "Support" would be the name-matching issue #22 removed.
        expect(draftFromView(UNLINKED)).toEqual({ mode: 'existing', discordId: null });
        expect(categorySlotNote(UNLINKED)).toMatch(/tickets are paused/);
    });

    it('sends an id for a new pick, a trimmed name for a create, and nothing for an untouched slot', () => {
        expect(choiceFromDraft({ mode: 'existing', discordId: '100000000000000001' }, UNLINKED)).toEqual({
            discordId: '100000000000000001',
        });
        expect(choiceFromDraft({ mode: 'create', name: '  Tickets ' }, UNLINKED)).toEqual({ name: 'Tickets' });
        expect(choiceFromDraft({ mode: 'existing', discordId: null }, UNLINKED)).toBeNull();
    });

    it('sends nothing for a bound slot left as loaded, so a stale tab cannot overwrite a newer pick', () => {
        const bound: TicketCategoryView = {
            name: 'Tickets',
            discordId: '100000000000000001',
            provenance: 'created',
            liveName: 'Tickets',
        };

        expect(choiceFromDraft(draftFromView(bound), bound)).toBeNull();
    });

    it('offers categories only, plus "create one"', () => {
        expect(categorySlotOptions(CHANNELS, null).map((option) => option.value)).toEqual([
            CREATE_NEW_CATEGORY,
            '100000000000000001',
        ]);
    });

    it('keeps a deleted bound category visible, saying what will happen to it', () => {
        const deleted: TicketCategoryView = {
            name: 'Tickets',
            discordId: '100000000000000009',
            provenance: 'created',
            liveName: null,
        };

        const options = categorySlotOptions(CHANNELS, deleted);

        expect(options.at(-1)).toEqual({
            value: '100000000000000009',
            label: 'Deleted — comes back as “Tickets” with the next ticket',
        });
    });

    it('notes a rename, which is harmless now', () => {
        const renamed: TicketCategoryView = {
            name: 'Tickets',
            discordId: '100000000000000001',
            provenance: 'adopted',
            liveName: 'Help Desk',
        };
        expect(categorySlotNote(renamed)).toMatch(/calls it “Help Desk” now.*remakes it as “Tickets”/);
    });
});
