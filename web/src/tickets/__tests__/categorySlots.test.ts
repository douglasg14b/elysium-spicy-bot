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
    { id: '100000000000000001', name: 'Support', type: 'category', parentId: null, parentName: null, owner: null },
    { id: '100000000000000002', name: 'general', type: 'text', parentId: null, parentName: null, owner: null },
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

    it('disables a category a journey holds, naming it, and keeps the ticket system\'s own pickable', () => {
        const channels: GuildChannel[] = [
            { ...CHANNELS[0]!, owner: { kind: 'journey', key: 'onboarding', label: 'journey "Onboarding"' } },
            {
                id: '100000000000000003',
                name: 'Tickets',
                type: 'category',
                parentId: null,
                parentName: null,
                owner: { kind: 'tickets', key: 'tickets', label: 'the ticket system' },
            },
        ];

        const options = categorySlotOptions(channels, null);

        expect(options.find((option) => option.value === '100000000000000001')).toEqual({
            value: '100000000000000001',
            label: 'Support — held by journey "Onboarding"',
            disabled: true,
        });
        // Two slots on one category is one owner.
        expect(options.find((option) => option.value === '100000000000000003')?.disabled).toBeUndefined();
    });

    it('keeps the slot\'s own current category pickable even if a journey also holds it', () => {
        const channels: GuildChannel[] = [
            { ...CHANNELS[0]!, owner: { kind: 'journey', key: 'onboarding', label: 'journey "Onboarding"' } },
        ];
        const current: TicketCategoryView = {
            name: 'Support',
            discordId: '100000000000000001',
            provenance: 'adopted',
            liveName: 'Support',
        };

        expect(categorySlotOptions(channels, current).find((option) => option.value === current.discordId)?.disabled).toBeUndefined();
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
