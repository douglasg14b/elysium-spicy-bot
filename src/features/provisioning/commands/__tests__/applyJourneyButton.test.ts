import { PermissionsBitField } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallPlan } from '../../logic/installPlan';

/**
 * The apply button, which is the gesture that mutates a live server.
 *
 * The behaviour worth pinning is what it *refuses*: a press by someone without
 * Manage Server, an unknown journey, and — the subtle one — a plan that stopped being
 * applicable between preview and press. That last case is why the handler rebuilds
 * the plan rather than trusting the button's existence as approval.
 */

const previewInstall = vi.fn();
const installJourney = vi.fn();
const getJourney = vi.fn();

vi.mock('../../provisioningService', () => ({
    previewInstall: (input: unknown) => previewInstall(input),
    installJourney: (input: unknown) => installJourney(input),
}));

// Journeys are rows now, so the source is mocked rather than a registry being
// filled. A test fixture stands in for whatever an operator authored.
vi.mock('../../journeys/journeySource', () => ({
    getJourney: (guildId: string, journeyKey: string) => getJourney(guildId, journeyKey),
}));

const { handleApplyJourney } = await import('../applyJourneyButton');

/** A minimal journey, declared here rather than imported from a bundled example. */
const TEST_JOURNEY = {
    journeyKey: 'onboarding',
    name: 'Onboarding',
    resources: [{ key: 'member-role', kind: 'role' as const, defaultName: 'Member' }],
};

function makePlan(overrides: Partial<InstallPlan> = {}): InstallPlan {
    return {
        guildId: 'guild-1',
        journeyKey: 'onboarding',
        items: [
            {
                resourceKey: 'member-role',
                kind: 'role',
                action: 'create',
                name: 'Member',
            },
        ],
        blockers: [],
        ...overrides,
    };
}

/** Just the parts of a Discord reply payload these assertions read. */
interface DiscordReplyPayload {
    content?: string;
    embeds?: { data: { description?: string; fields?: { name: string; value: string }[] } }[];
    components?: unknown[];
}

interface InteractionOptions {
    hasPermission?: boolean;
    customId?: string;
    inGuild?: boolean;
}

function makeInteraction({
    hasPermission = true,
    customId = 'provisioning:apply:onboarding',
    inGuild = true,
}: InteractionOptions = {}) {
    // Typed payload rather than `vi.fn()` with inferred `never[]` args, so the
    // assertions below can read `.embeds` without a cast at every call site.
    const reply = vi.fn(async (_payload: DiscordReplyPayload) => undefined);
    const editReply = vi.fn(async (_payload: DiscordReplyPayload) => undefined);
    const deferUpdate = vi.fn(async () => undefined);

    return {
        interaction: {
            customId,
            guild: inGuild ? { id: 'guild-1', name: 'Test Guild' } : null,
            memberPermissions: {
                has: (flag: bigint) => hasPermission && flag === PermissionsBitField.Flags.ManageGuild,
            },
            reply,
            editReply,
            deferUpdate,
        } as never,
        reply,
        editReply,
        deferUpdate,
    };
}

/** The embed from the first editReply, failing loudly if there wasn't one. */
function firstEmbed(editReply: { mock: { calls: [DiscordReplyPayload][] } }) {
    const embed = editReply.mock.calls[0]?.[0].embeds?.[0];
    if (!embed) throw new Error('editReply was not called with an embed');
    return embed;
}

beforeEach(() => {
    vi.clearAllMocks();
    getJourney.mockResolvedValue(TEST_JOURNEY);
});

describe('handleApplyJourney', () => {
    it('applies the plan and reports what was created', async () => {
        previewInstall.mockResolvedValue(makePlan());
        installJourney.mockResolvedValue({
            applied: [
                { resourceKey: 'member-role', discordId: 'role-1', action: 'created', name: 'Member' },
            ],
        });

        const { interaction, editReply } = makeInteraction();
        const result = await handleApplyJourney(interaction);

        expect(installJourney).toHaveBeenCalledTimes(1);
        expect(result.status).toBe('success');
        // A role renders as a role mention, taken from the declaration's kind.
        const embed = firstEmbed(editReply);
        expect(embed.data.description).toContain('<@&role-1>');
    });

    it('refuses a press from someone without Manage Server', async () => {
        // The custom id is guessable and this mutates the server, so permission is
        // re-checked at press time rather than trusted from whoever ran the command.
        const { interaction, reply } = makeInteraction({ hasPermission: false });

        const result = await handleApplyJourney(interaction);

        expect(result.status).toBe('error');
        expect(reply).toHaveBeenCalled();
        expect(installJourney).not.toHaveBeenCalled();
    });

    it('refuses a journey key this guild has no row for', async () => {
        // The lookup is guild-scoped, so this also covers a key that exists on some
        // *other* server: a guessable custom id must not reach another guild's
        // declaration.
        getJourney.mockResolvedValue(undefined);
        const { interaction } = makeInteraction({ customId: 'provisioning:apply:not-a-journey' });

        const result = await handleApplyJourney(interaction);

        expect(result.status).toBe('error');
        expect(installJourney).not.toHaveBeenCalled();
        expect(getJourney).toHaveBeenCalledWith('guild-1', 'not-a-journey');
    });

    it('refuses to mutate when the plan stopped being applicable since preview', async () => {
        // Someone created a clashing channel between the preview and the press. The
        // operator approved a plan that no longer describes this server, so the
        // approval must not carry over.
        previewInstall.mockResolvedValue(
            makePlan({
                items: [
                    {
                        resourceKey: 'member-role',
                        kind: 'role',
                        action: 'blocked',
                        name: 'Member',
                        reason: 'A role named "Member" already exists.',
                    },
                ],
            })
        );

        const { interaction, editReply } = makeInteraction();
        const result = await handleApplyJourney(interaction);

        expect(installJourney).not.toHaveBeenCalled();
        expect(result.status).toBe('error');
        // The operator is shown the new plan, not just told no.
        expect(editReply.mock.calls[0]?.[0].embeds).toHaveLength(1);
    });

    it('refuses when a guild-level blocker appeared since preview', async () => {
        previewInstall.mockResolvedValue(
            makePlan({ blockers: ['The bot lacks **Manage Roles**.'] })
        );

        const { interaction } = makeInteraction();
        const result = await handleApplyJourney(interaction);

        expect(installJourney).not.toHaveBeenCalled();
        expect(result.status).toBe('error');
    });

    it('reports a partial install rather than claiming success', async () => {
        // What was applied is real and bound; the operator needs to see both halves.
        previewInstall.mockResolvedValue(makePlan());
        installJourney.mockResolvedValue({
            applied: [
                { resourceKey: 'member-role', discordId: 'role-1', action: 'created', name: 'Member' },
            ],
            failure: 'rate limited',
        });

        const { interaction, editReply } = makeInteraction();
        const result = await handleApplyJourney(interaction);

        expect(result.status).toBe('error');
        const embed = firstEmbed(editReply);
        expect(embed.data.description).toContain('<@&role-1>');
        expect(JSON.stringify(embed.data.fields)).toMatch(/rate limited/);
    });

    it('defers before doing any work', async () => {
        // Creating several channels and a role exceeds the 3-second acknowledgement
        // deadline on its own, before rate limiting.
        previewInstall.mockResolvedValue(makePlan());
        installJourney.mockResolvedValue({ applied: [] });

        const { interaction, deferUpdate } = makeInteraction();
        await handleApplyJourney(interaction);

        expect(deferUpdate).toHaveBeenCalled();
    });
});
