import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TICKET_TYPES } from '../../data/defaultTicketTypes';
import type {
    TicketingConfig,
    TicketingConfigEntity,
    TicketTypeDefinition,
} from '../../data/ticketingSchema';
import { deleteTicketType, upsertTicketType, type SetTicketTypesDeps } from '../setTicketTypes';

/**
 * The validate-and-persist authority, which a Discord surface and a web route both
 * go through so a refusal exists once.
 *
 * The key, label and token rules are declared in `ticketTypeRules.ts` and their sentences
 * are tested there; here, only that this authority applies them — a surface calling it
 * directly is held to them — and stores what they normalize.
 */

function config(overrides: Partial<TicketingConfig> = {}): TicketingConfig {
    return {
        modTicketsDeployed: true,
        modTicketsDeployedChannelId: 'channel-1',
        modTicketsDeployedMessageId: 'message-1',
        categories: {
            open: { name: 'Support', discordId: '900000000000000001', provenance: 'adopted' },
            claimed: { name: 'Claimed', discordId: '900000000000000002', provenance: 'adopted' },
            closed: { name: 'Closed', discordId: '900000000000000003', provenance: 'adopted' },
        },
        moderationRoles: ['role-1'],
        ticketTypes: { ...DEFAULT_TICKET_TYPES },
        ...overrides,
    };
}

function definition(overrides: Partial<TicketTypeDefinition> = {}): TicketTypeDefinition {
    return {
        type: 'appeals',
        label: 'Appeals',
        nameTemplate: 'A{{####}}-{{subject}}',
        permissions: DEFAULT_TICKET_TYPES.support.permissions,
        autoClaimOnOpen: false,
        ...overrides,
    };
}

interface Harness {
    deps: SetTicketTypesDeps;
    /**
     * Stands in for the write. Named `update` because that is what these tests assert
     * about — whether anything was persisted — and every `not.toHaveBeenCalled()` here
     * means the same thing it did before the write moved into a transaction.
     */
    update: ReturnType<typeof vi.fn>;
    /** The config as it was actually written, parsed back from the JSON string. */
    written: () => TicketingConfig;
}

function harness(
    stored: TicketingConfig | null = config(),
    usage?: SetTicketTypesDeps['usage']
): Harness {
    const update = vi.fn().mockResolvedValue(undefined);

    /*
     * A faithful stand-in for the real `mutateConfig`: it hands the mutator the stored
     * row, and persists only what the mutator returns. The two properties the
     * production method exists for — that the read and the write are one transaction,
     * and that a null return writes nothing — are the two this fake reproduces, so a
     * refusal asserted here is a refusal that reaches the database the same way.
     *
     * What it deliberately does not reproduce is concurrency. A single-threaded fake
     * cannot interleave two writers, so the guard these tests cover is "the mutator
     * decides and its refusal writes nothing", not "a concurrent save cannot clobber
     * this one" — that one rests on the transaction itself.
     */
    const mutateConfig = vi.fn(
        async (
            _guildId: string,
            mutate: (current: TicketingConfigEntity) => Promise<TicketingConfig | null> | TicketingConfig | null
        ) => {
            if (!stored) return null;

            const entity = {
                id: 1,
                guildId: 'guild-1',
                config: stored,
                ticketNumberInc: 3,
                entityVersion: 1,
            } as TicketingConfigEntity;

            const next = await mutate(entity);
            if (!next) return null;

            // Serialized here exactly as the repo does, because the string is what the
            // column receives and `written()` parses it back.
            update({ guildId: 'guild-1', config: JSON.stringify(next) });
            return next;
        }
    );

    return {
        deps: { repo: { mutateConfig }, usage },
        update,
        // Asserted against the serialized payload rather than an in-memory object,
        // because the string is what the column receives.
        written: () => JSON.parse(update.mock.calls[0][0].config as string) as TicketingConfig,
    };
}

/** No tickets hold any type. The in-use refusal itself is exercised in `ticketTypeInUse.test.ts`. */
const UNUSED: SetTicketTypesDeps['usage'] = {
    tickets: { countByType: async () => [], listByType: async () => [] },
};

describe('upsertTicketType template validation', () => {
    it('holds a direct caller to the declared rules: {{user}} is refused and nothing is written', async () => {
        const { deps, update } = harness();

        const result = await upsertTicketType('guild-1', definition({ nameTemplate: 'S{{####}}-{{user}}' }), deps);

        expect(result).toEqual({
            ok: false,
            reason: 'invalid-input',
            message:
                'Only `{{####}}`, `{{subject}}` and `{{opener}}` render here, each with exactly two braces either side — nothing else, and no, wishing does not count.',
        });
        expect(update).not.toHaveBeenCalled();
    });

    it('refuses a key a channel name or a flow option cannot carry', async () => {
        const { deps, update } = harness();

        const result = await upsertTicketType('guild-1', definition({ type: 'Appeals & Bans' }), deps);

        expect(result.ok).toBe(false);
        expect(update).not.toHaveBeenCalled();
    });

    it('rejects a nameTemplate whose maximum expansion exceeds 100 characters', async () => {
        const { deps, update } = harness();
        // Two 32-character usernames plus a long literal prefix. Under 100 as written,
        // over it once the tokens expand — which is why the check renders rather than
        // measuring the template string.
        const result = await upsertTicketType(
            'guild-1',
            definition({ nameTemplate: `${'x'.repeat(50)}-{{subject}}-{{opener}}` }),
            deps
        );

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.message).toBe(
            'At its longest that template renders 116 characters, and Discord caps a channel name at 100. Trim it.'
        );
        expect(update).not.toHaveBeenCalled();
    });

    it('rejects a nameTemplate that renders empty', async () => {
        const { deps } = harness();
        // Only separators, so the collapse leaves nothing. Discord will not name a
        // channel the empty string.
        const result = await upsertTicketType('guild-1', definition({ nameTemplate: '---' }), deps);

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.message).toContain('empty');
    });

    it('measures the worst case at six digits, not four', async () => {
        const { deps } = harness();
        // `{{####}}` pads to four but does not cap, and the ticket counter is unbounded.
        // 96 characters at n=9999 and 98 at n=999999 — under the cap either way; this one
        // is 99 at four digits and 101 at six, so probing at 9999 would accept a template
        // that later breaks `channels.create` *after* the ticket number is allocated.
        const result = await upsertTicketType(
            'guild-1',
            definition({ nameTemplate: `${'x'.repeat(35)}-{{####}}-{{subject}}-{{opener}}` }),
            deps
        );

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.message).toContain('100');
    });

    it('accepts a repeated token, which the renderer now substitutes everywhere', async () => {
        const { deps } = harness();

        const result = await upsertTicketType(
            'guild-1',
            definition({ nameTemplate: 'A{{####}}-{{subject}}-{{subject}}' }),
            deps
        );

        expect(result.ok).toBe(true);
    });

    it('accepts {{####}}, {{subject}} and {{opener}} together', async () => {
        const { deps, update } = harness();

        const result = await upsertTicketType(
            'guild-1',
            definition({ nameTemplate: 'A{{####}}-{{subject}}-{{opener}}' }),
            deps
        );

        expect(result.ok).toBe(true);
        expect(update).toHaveBeenCalledTimes(1);
    });
});

describe('upsertTicketType persistence', () => {
    it('replaces a definition without touching the guild’s other types', async () => {
        const { deps, written } = harness();

        const result = await upsertTicketType(
            'guild-1',
            definition({ type: 'support', label: 'Help Desk', nameTemplate: 'H{{####}}-{{subject}}' }),
            deps
        );

        expect(result.ok).toBe(true);
        const config = written();
        expect(config.ticketTypes?.support.label).toBe('Help Desk');
        // The type it did not name survives, with its own template intact.
        expect(config.ticketTypes?.verification).toEqual(DEFAULT_TICKET_TYPES.verification);
    });

    it('preserves every other config member, not only the types', async () => {
        const { deps, written } = harness();

        await upsertTicketType('guild-1', definition(), deps);

        // The same discipline the config modal needed: a write that names one member
        // must not drop the rest.
        expect(written().moderationRoles).toEqual(['role-1']);
        expect(written().categories.open?.name).toBe('Support');
    });

    it('stores a padded key, label and template normalized, so the record and its map key agree', async () => {
        const { deps, written } = harness();

        const result = await upsertTicketType(
            'guild-1',
            definition({ type: '  appeals  ', label: ' Appeals ', nameTemplate: ' A{{####}} ' }),
            deps
        );

        expect(result.ok).toBe(true);
        // Validating the trimmed key and storing the untrimmed one would leave a type
        // visible in the config that every lookup misses.
        expect(written().ticketTypes).not.toHaveProperty('  appeals  ');
        expect(written().ticketTypes?.appeals).toMatchObject({
            type: 'appeals',
            label: 'Appeals',
            nameTemplate: 'A{{####}}',
        });
    });

    it('refuses a guild with no config row', async () => {
        const { deps, update } = harness(null);

        const result = await upsertTicketType('guild-1', definition(), deps);

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.message).toContain('no ticket config');
        expect(update).not.toHaveBeenCalled();
    });
});

describe('deleteTicketType', () => {
    it('removes a type no ticket has ever used, leaving the others', async () => {
        const { deps, written } = harness(config(), UNUSED);

        const result = await deleteTicketType('guild-1', 'verification', deps);

        expect(result.ok).toBe(true);
        expect(written().ticketTypes).not.toHaveProperty('verification');
        expect(written().ticketTypes).toHaveProperty('support');
    });

    it('refuses a type the guild does not declare', async () => {
        const { deps, update } = harness(config(), UNUSED);

        const result = await deleteTicketType('guild-1', 'appeals', deps);

        expect(result.ok).toBe(false);
        expect(update).not.toHaveBeenCalled();
    });

    it('refuses a guild with no config row', async () => {
        const { deps } = harness(null, UNUSED);

        expect((await deleteTicketType('guild-1', 'support', deps)).ok).toBe(false);
    });
});
