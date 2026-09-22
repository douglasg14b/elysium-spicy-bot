import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModalSubmitInteraction } from 'discord.js';
import { DEFAULT_TICKET_TYPES } from '../../data/defaultTicketTypes';
import type { TicketingConfig, TicketingConfigEntity } from '../../data/ticketingSchema';

/**
 * The config modal's write, which is the highest-risk edit in this step.
 *
 * It used to build `TicketingConfig` as a complete object literal with **no
 * spread**, so it silently dropped every member it did not name. That was harmless
 * only while those eleven members *were* the whole type. With `ticketTypes` in the
 * shape, the literal made this modal a silent destructor: the first operator to press
 * ⚙️ Configure and save would wipe their guild's entire type record, and every
 * subsequent claim, close and reopen would then refuse.
 *
 * **Nothing else in the suite can see that, and neither can `tsc`** — the literal is
 * perfectly well-typed. This file is the whole guard, which is why it exists
 * separately rather than as one more assertion somewhere convenient.
 */

const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockUpsert = vi.fn();

vi.mock('../../data/ticketingRepo', () => ({
    ticketingRepo: {
        get: (...args: unknown[]) => mockGet(...args),
        update: (...args: unknown[]) => mockUpdate(...args),
        upsert: (...args: unknown[]) => mockUpsert(...args),
    },
}));

vi.mock('../../utils/updateDeployedMessage', () => ({
    updateDeployedTicketMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../logic/ticketChannelPermissions', () => ({
    findOrCreateModeratorCategory: vi.fn().mockResolvedValue({ ok: true, value: { id: 'category-1' } }),
}));

vi.mock('../../utils', () => ({
    validateTicketCategoryPermissions: () => ({ valid: true, missingPermissions: [] }),
}));

import { TicketConfigModalComponent } from '../ticketConfigModal';

/** A guild that has authored a third type on top of the two seeded ones. */
function storedConfig(overrides: Partial<TicketingConfig> = {}): TicketingConfig {
    return {
        modTicketsDeployed: true,
        modTicketsDeployedChannelId: 'channel-1',
        modTicketsDeployedMessageId: 'message-1',
        supportTicketCategoryName: 'Old Support',
        claimedTicketCategoryName: 'Old Claimed',
        closedTicketCategoryName: 'Old Closed',
        moderationRoles: ['role-old'],
        ticketTypes: {
            ...DEFAULT_TICKET_TYPES,
            appeals: {
                type: 'appeals',
                label: 'Appeals',
                nameTemplate: 'A{{####}}-{{subject}}',
                permissions: DEFAULT_TICKET_TYPES.support.permissions,
                autoClaimOnOpen: false,
            },
        },
        ...overrides,
    };
}

function interaction(): ModalSubmitInteraction {
    const fields = new Map<string, string>([
        ['support_category_input', 'Support Tickets'],
        ['claimed_category_input', 'Claimed Tickets'],
        ['closed_category_input', 'Closed Tickets'],
    ]);

    return {
        guild: { id: 'guild-1' },
        memberPermissions: { has: () => true },
        fields: {
            getTextInputValue: (id: string) => fields.get(id) ?? '',
            getSelectedRoles: () => new Map([['role-new', { id: 'role-new' }]]),
        },
        reply: vi.fn().mockResolvedValue(undefined),
    } as unknown as ModalSubmitInteraction;
}

/** The config as the column actually received it, parsed back from the JSON string. */
function written(call: ReturnType<typeof vi.fn>): TicketingConfig {
    return JSON.parse(call.mock.calls[0][0].config as string) as TicketingConfig;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue(undefined);
    mockUpsert.mockResolvedValue(undefined);
});

describe('a config-modal save', () => {
    it('preserves ticketTypes untouched, including a type the operator authored', async () => {
        mockGet.mockResolvedValue({
            id: 1,
            guildId: 'guild-1',
            config: storedConfig(),
            ticketNumberInc: 12,
            entityVersion: 1,
        } as TicketingConfigEntity);

        const result = await TicketConfigModalComponent().handler(interaction());

        expect(result.status).toBe('success');
        const saved = written(mockUpdate);
        // All three survive. Without the spread the whole record is gone and every
        // button on every existing ticket starts refusing.
        expect(Object.keys(saved.ticketTypes ?? {}).sort()).toEqual(['appeals', 'support', 'verification']);
        expect(saved.ticketTypes?.appeals.nameTemplate).toBe('A{{####}}-{{subject}}');
        // And the categories it *does* own were still updated, so the guard is not
        // passing by making the handler a no-op.
        expect(saved.supportTicketCategoryName).toBe('Support Tickets');
        expect(saved.moderationRoles).toEqual(['role-new']);
    });

    it('preserves a config member this modal has never heard of', async () => {
        // The general form of the same defect: `config` is an unvalidated JSON blob, so
        // a member added by any other writer must survive a save here.
        mockGet.mockResolvedValue({
            id: 1,
            guildId: 'guild-1',
            config: { ...storedConfig(), somethingElseEntirely: 'keep me' } as TicketingConfig,
            ticketNumberInc: 12,
            entityVersion: 1,
        } as TicketingConfigEntity);

        await TicketConfigModalComponent().handler(interaction());

        expect(written(mockUpdate)).toHaveProperty('somethingElseEntirely', 'keep me');
    });

    it('seeds DEFAULT_TICKET_TYPES on a guild with no config row', async () => {
        // A guild that configures before it ever deploys has no row, so this is a
        // *creating* path — and the seed migration is an `UPDATE` that never reached it.
        mockGet.mockResolvedValue(null);

        const result = await TicketConfigModalComponent().handler(interaction());

        expect(result.status).toBe('success');
        const saved = written(mockUpsert);
        expect(Object.keys(saved.ticketTypes ?? {}).sort()).toEqual(['support', 'verification']);
        expect(saved.ticketTypes?.support.nameTemplate).toBe(DEFAULT_TICKET_TYPES.support.nameTemplate);
        // Deployment state belongs to `/deploy-ticket-system`. Configuring first is
        // allowed; claiming to be deployed because of it is not.
        expect(saved.modTicketsDeployed).toBe(false);
        expect(saved.modTicketsDeployedChannelId).toBeNull();
    });

    it('does not reset deployment state on a guild that is already deployed', async () => {
        // The deployment defaults sit *before* the spread precisely so an existing row's
        // values win. Put them after and every config save silently undeploys the panel.
        mockGet.mockResolvedValue({
            id: 1,
            guildId: 'guild-1',
            config: storedConfig(),
            ticketNumberInc: 12,
            entityVersion: 1,
        } as TicketingConfigEntity);

        await TicketConfigModalComponent().handler(interaction());

        const saved = written(mockUpdate);
        expect(saved.modTicketsDeployed).toBe(true);
        expect(saved.modTicketsDeployedChannelId).toBe('channel-1');
        expect(saved.modTicketsDeployedMessageId).toBe('message-1');
    });

    // No test here for "drops the dead `userTicketsDeployed`/`ticketChannelNameTemplate`
    // members". Removing them is the **migration's** job and
    // `ticketIdentitySnapshots.integration.test.ts` asserts it against real SQL. A test
    // here would also have been wrong about the behaviour: with the spread in place, a
    // row that still carries them has them copied *forward*, which is correct — this
    // modal preserves what it does not own, and that is the whole point of the spread.
});
