import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TICKET_TYPES } from '../../data/defaultTicketTypes';
import type {
    TicketingConfig,
    TicketingConfigEntity,
    TicketTypeDefinition,
} from '../../data/ticketingSchema';
import {
    createTicketTypeIfAbsent,
    deleteTicketType,
    upsertTicketType,
    type SetTicketTypesDeps,
} from '../setTicketTypes';

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
        typeCategories: new Map(),
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

/** No journey holds any type. The held-by-journey refusal is exercised below. */
const NO_JOURNEY_HOLDS: SetTicketTypesDeps['holders'] = {
    bindings: { listByGuild: async () => [] },
    journeys: { listTicketTypeDeclarations: async () => [] },
};

interface Harness {
    deps: SetTicketTypesDeps;
    /**
     * Stands in for the write. Named `update` because that is what these tests assert
     * about — whether anything was persisted — and every `not.toHaveBeenCalled()` here
     * means the same thing it did before the write moved into a transaction.
     */
    update: ReturnType<typeof vi.fn>;
    /** Stands in for dropping a type's own category rows. */
    clearTypeCategories: ReturnType<typeof vi.fn>;
    /** The config as it was actually written, parsed back from the JSON string. */
    written: () => TicketingConfig;
}

function harness(
    stored: TicketingConfig | null = config(),
    usage?: SetTicketTypesDeps['usage']
): Harness {
    const update = vi.fn().mockResolvedValue(undefined);
    const clearTypeCategories = vi.fn().mockResolvedValue(undefined);

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
        deps: { repo: { mutateConfig, clearTypeCategories }, usage, holders: NO_JOURNEY_HOLDS },
        update,
        clearTypeCategories,
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

        const result = await upsertTicketType({ guildId: 'guild-1', definition: definition({ nameTemplate: 'S{{####}}-{{user}}' }) }, deps);

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

        const result = await upsertTicketType({ guildId: 'guild-1', definition: definition({ type: 'Appeals & Bans' }) }, deps);

        expect(result.ok).toBe(false);
        expect(update).not.toHaveBeenCalled();
    });

    it('rejects a nameTemplate whose maximum expansion exceeds 100 characters', async () => {
        const { deps, update } = harness();
        // Two 32-character usernames plus a long literal prefix. Under 100 as written,
        // over it once the tokens expand — which is why the check renders rather than
        // measuring the template string.
        const result = await upsertTicketType({ guildId: 'guild-1', definition: definition({ nameTemplate: `${'x'.repeat(50)}-{{subject}}-{{opener}}` }) }, deps);

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
        const result = await upsertTicketType({ guildId: 'guild-1', definition: definition({ nameTemplate: '---' }) }, deps);

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.message).toContain('empty');
    });

    it('measures the worst case at six digits, not four', async () => {
        const { deps } = harness();
        // `{{####}}` pads to four but does not cap, and the ticket counter is unbounded.
        // 96 characters at n=9999 and 98 at n=999999 — under the cap either way; this one
        // is 99 at four digits and 101 at six, so probing at 9999 would accept a template
        // that later breaks `channels.create` *after* the ticket number is allocated.
        const result = await upsertTicketType({ guildId: 'guild-1', definition: definition({ nameTemplate: `${'x'.repeat(35)}-{{####}}-{{subject}}-{{opener}}` }) }, deps);

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.message).toContain('100');
    });

    it('accepts a repeated token, which the renderer now substitutes everywhere', async () => {
        const { deps } = harness();

        const result = await upsertTicketType({ guildId: 'guild-1', definition: definition({ nameTemplate: 'A{{####}}-{{subject}}-{{subject}}' }) }, deps);

        expect(result.ok).toBe(true);
    });

    it('accepts {{####}}, {{subject}} and {{opener}} together', async () => {
        const { deps, update } = harness();

        const result = await upsertTicketType({ guildId: 'guild-1', definition: definition({ nameTemplate: 'A{{####}}-{{subject}}-{{opener}}' }) }, deps);

        expect(result.ok).toBe(true);
        expect(update).toHaveBeenCalledTimes(1);
    });
});

describe('upsertTicketType persistence', () => {
    it('replaces a definition without touching the guild’s other types', async () => {
        const { deps, written } = harness();

        const result = await upsertTicketType({ guildId: 'guild-1', definition: definition({ type: 'support', label: 'Help Desk', nameTemplate: 'H{{####}}-{{subject}}' }) }, deps);

        expect(result.ok).toBe(true);
        const config = written();
        expect(config.ticketTypes?.support.label).toBe('Help Desk');
        // The type it did not name survives, with its own template intact.
        expect(config.ticketTypes?.verification).toEqual(DEFAULT_TICKET_TYPES.verification);
    });

    it('preserves every other config member, not only the types', async () => {
        const { deps, written } = harness();

        await upsertTicketType({ guildId: 'guild-1', definition: definition() }, deps);

        // The same discipline the config modal needed: a write that names one member
        // must not drop the rest.
        expect(written().moderationRoles).toEqual(['role-1']);
        expect(written().categories.open?.name).toBe('Support');
    });

    it('stores a padded key, label and template normalized, so the record and its map key agree', async () => {
        const { deps, written } = harness();

        const result = await upsertTicketType({ guildId: 'guild-1', definition: definition({ type: '  appeals  ', label: ' Appeals ', nameTemplate: ' A{{####}} ' }) }, deps);

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

        const result = await upsertTicketType({ guildId: 'guild-1', definition: definition() }, deps);

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.message).toContain('no ticket config');
        expect(update).not.toHaveBeenCalled();
    });

    it('refuses a key over 64 characters, naming the limit, and writes nothing', async () => {
        const { deps, update } = harness();

        const result = await upsertTicketType({ guildId: 'guild-1', definition: definition({ type: 'a'.repeat(65) }) }, deps);

        expect(result.ok === false && result.reason).toBe('invalid-input');
        expect(result.ok === false && result.message).toContain('64 characters');
        expect(update).not.toHaveBeenCalled();
    });

    it('accepts a key of exactly 64 characters', async () => {
        const { deps } = harness();

        expect((await upsertTicketType({ guildId: 'guild-1', definition: definition({ type: 'a'.repeat(64) }) }, deps)).ok).toBe(true);
    });

    it('refuses a label over 45 characters — the Discord picker cannot show it — and writes nothing', async () => {
        const { deps, update } = harness();

        const result = await upsertTicketType({ guildId: 'guild-1', definition: definition({ label: 'A'.repeat(46) }) }, deps);

        expect(result.ok === false && result.reason).toBe('invalid-input');
        expect(result.ok === false && result.message).toContain('45 characters');
        expect(update).not.toHaveBeenCalled();
    });

    it('measures the label after trimming, so padding does not count against it', async () => {
        const { deps, written } = harness();

        const result = await upsertTicketType({ guildId: 'guild-1', definition: definition({ label: `  ${'A'.repeat(45)}  ` }) }, deps);

        expect(result.ok).toBe(true);
        expect(written().ticketTypes?.appeals.label).toBe('A'.repeat(45));
    });
});

describe('deleteTicketType', () => {
    it('removes a type no ticket has ever used, leaving the others', async () => {
        const { deps, written, clearTypeCategories } = harness(config(), UNUSED);

        const result = await deleteTicketType('guild-1', 'verification', deps);

        expect(result.ok).toBe(true);
        expect(written().ticketTypes).not.toHaveProperty('verification');
        expect(written().ticketTypes).toHaveProperty('support');
        // Its own categories go with it, so a type made later under the key starts on the defaults.
        expect(clearTypeCategories).toHaveBeenCalledWith('guild-1', 'verification', ['open', 'claimed', 'closed'], undefined);
    });

    it('refuses a type the guild does not declare', async () => {
        const { deps, update, clearTypeCategories } = harness(config(), UNUSED);

        const result = await deleteTicketType('guild-1', 'appeals', deps);

        expect(result.ok).toBe(false);
        expect(update).not.toHaveBeenCalled();
        expect(clearTypeCategories).not.toHaveBeenCalled();
    });

    it('refuses a guild with no config row', async () => {
        const { deps } = harness(null, UNUSED);

        expect(await deleteTicketType('guild-1', 'support', deps)).toMatchObject({ ok: false, reason: 'no-config' });
    });

    it('refuses a type a journey installed, naming the journey, and writes nothing', async () => {
        const { deps, update } = harness(config(), UNUSED);
        const row = {
            id: 7,
            guildId: 'guild-1',
            ownerKind: 'journey' as const,
            ownerKey: 'onboarding',
            resourceKey: 'verification',
            kind: 'ticketType' as const,
            state: 'adopted' as const,
            discordId: 'verification',
            name: 'Verification',
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        const result = await deleteTicketType('guild-1', 'verification', {
            ...deps,
            holders: {
                bindings: { listByGuild: async () => [row] },
                journeys: {
                    listTicketTypeDeclarations: async () => [
                        { journeyKey: 'onboarding', name: 'Onboarding', ticketTypeKeys: ['verification'] },
                    ],
                },
            },
        });

        expect(result).toMatchObject({ ok: false, reason: 'held-by-journey' });
        expect(result.ok === false && result.message).toMatch(/journey "Onboarding".*Uninstall that journey/);
        expect(update).not.toHaveBeenCalled();
    });

    it('does not count a journey row for another type, or a ticket category the ticket system holds', async () => {
        const { deps, written } = harness(config(), UNUSED);
        const base = {
            guildId: 'guild-1',
            state: 'adopted' as const,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        const result = await deleteTicketType('guild-1', 'verification', {
            ...deps,
            holders: {
                bindings: {
                    listByGuild: async () => [
                        { ...base, id: 1, ownerKind: 'journey' as const, ownerKey: 'j', resourceKey: 's', kind: 'ticketType' as const, discordId: 'support', name: 'Support' },
                        { ...base, id: 2, ownerKind: 'tickets' as const, ownerKey: 'tickets', resourceKey: 'open', kind: 'category' as const, discordId: 'verification', name: 'Open' },
                    ],
                },
                journeys: { listTicketTypeDeclarations: async () => [] },
            },
        });

        expect(result.ok).toBe(true);
        expect(written().ticketTypes).not.toHaveProperty('verification');
    });

    it.each([
        ['whose journey has been deleted', []],
        [
            'whose journey no longer declares it',
            [{ journeyKey: 'onboarding', name: 'Onboarding', ticketTypeKeys: [] as string[] }],
        ],
    ])('does not let a leftover row %s lock the type', async (_label, journeys) => {
        // Deleting a journey, emptying it by grouping, or dropping the type all leave the
        // row; counting it would lock the type behind advice nobody can follow.
        const { deps, written } = harness(config(), UNUSED);
        const result = await deleteTicketType('guild-1', 'verification', {
            ...deps,
            holders: {
                bindings: {
                    listByGuild: async () => [
                        {
                            id: 7,
                            guildId: 'guild-1',
                            ownerKind: 'journey' as const,
                            ownerKey: 'onboarding',
                            resourceKey: 'verification',
                            kind: 'ticketType' as const,
                            state: 'adopted' as const,
                            discordId: 'verification',
                            name: 'Verification',
                            createdAt: new Date(),
                            updatedAt: new Date(),
                        },
                    ],
                },
                journeys: { listTicketTypeDeclarations: async () => journeys },
            },
        });

        expect(result.ok).toBe(true);
        expect(written().ticketTypes).not.toHaveProperty('verification');
    });
});

/** A journey's install: create only when absent, never replace. */
describe('createTicketTypeIfAbsent', () => {
    it('adds a type the guild does not have, trimmed, leaving the others', async () => {
        const { deps, written } = harness();

        const result = await createTicketTypeIfAbsent('guild-1', definition({ label: '  Appeals  ' }), deps);

        expect(result.outcome).toBe('created');
        expect(written().ticketTypes?.appeals).toEqual(definition());
        expect(written().ticketTypes).toHaveProperty('support');
    });

    it('leaves a type of that key exactly as it is, and reports its label', async () => {
        const { deps, update } = harness();

        const result = await createTicketTypeIfAbsent(
            'guild-1',
            definition({ type: 'verification', label: 'Prove it', nameTemplate: 'P{{####}}' }),
            deps
        );

        expect(result).toEqual({ outcome: 'exists', label: 'Verification' });
        expect(update).not.toHaveBeenCalled();
    });

    it('refuses with the same words upsert uses, for the same rules', async () => {
        const { deps, update } = harness();

        const refused = definition({ nameTemplate: 'A{{user}}' });
        const result = await createTicketTypeIfAbsent('guild-1', refused, deps);
        const upserted = await upsertTicketType({ guildId: 'guild-1', definition: refused }, deps);

        expect(result).toMatchObject({ outcome: 'refused', reason: 'invalid-input' });
        expect(upserted.ok).toBe(false);
        expect(result.outcome === 'refused' && result.message).toBe(!upserted.ok && upserted.message);
        // The template rule's own sentence (`ticketTypeRules.ts`), which names what does render.
        expect(result.outcome === 'refused' && result.message).toMatch(/^Only `\{\{####\}\}`/);
        expect(update).not.toHaveBeenCalled();
    });

    it('creates a type keyed `constructor`, which a plain index would mistake for one already there', async () => {
        const { deps, written } = harness();

        const result = await createTicketTypeIfAbsent('guild-1', definition({ type: 'constructor' }), deps);

        expect(result.outcome).toBe('created');
        expect(written().ticketTypes?.constructor).toMatchObject({ type: 'constructor' });
    });

    it('refuses a guild with no config row', async () => {
        const { deps } = harness(null);

        expect(await createTicketTypeIfAbsent('guild-1', definition(), deps)).toMatchObject({
            outcome: 'refused',
            reason: 'no-config',
        });
    });
});
