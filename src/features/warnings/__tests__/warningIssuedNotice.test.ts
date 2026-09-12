import { ChannelType, PermissionsBitField, type Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { Warning } from '../data/warningsSchema';
import {
    buildWarningIssuedNoticeEmbed,
    formatWarnSuccessMessage,
    notifyWarningIssued,
} from '../logic/warningIssuedNotice';

function sampleWarning(overrides: Partial<Warning> = {}): Warning {
    return {
        id: 1,
        guildId: 'guild-1',
        userId: 'user-1',
        issuerId: 'mod-1',
        slug: 'consent-k7m2',
        rule: 'Consent',
        description: 'Pushed past a no.',
        issuedAt: new Date('2026-09-01T00:00:00.000Z'),
        expiresAt: new Date('2027-03-01T00:00:00.000Z'),
        clearedAt: null,
        clearedById: null,
        createdAt: new Date('2026-09-01T20:00:00.000Z'),
        ...overrides,
    };
}

describe('buildWarningIssuedNoticeEmbed', () => {
    it('includes member, issuer, slug, description, and dates', () => {
        const embed = buildWarningIssuedNoticeEmbed({
            warning: sampleWarning(),
            activeCount: 2,
        });
        const serialized = JSON.stringify(embed.toJSON());

        expect(serialized).toContain('Warning issued');
        expect(serialized).toContain('<@user-1>');
        expect(serialized).toContain('<@mod-1>');
        expect(serialized).toContain('consent-k7m2');
        expect(serialized).toContain('Pushed past a no.');
        expect(serialized).toContain('2026-09-01');
        expect(serialized).toContain('2027-03-01');
        expect(serialized).toContain('2');
    });
});

describe('formatWarnSuccessMessage', () => {
    it('hints at /warnings-config when no mod channel is set', () => {
        expect(formatWarnSuccessMessage('user-1', 'consent-k7m2', '2027-03-01', 'unconfigured')).toContain(
            '/warnings-config'
        );
        expect(formatWarnSuccessMessage('user-1', 'consent-k7m2', '2027-03-01', 'sent')).toBe(
            'Warned <@user-1>. Slug `consent-k7m2` — they can stew until 2027-03-01.'
        );
        expect(formatWarnSuccessMessage('user-1', 'consent-k7m2', '2027-03-01', 'skipped')).toContain(
            'cannot reach the configured mod channel'
        );
        expect(formatWarnSuccessMessage('user-1', 'consent-k7m2', '2027-03-01', 'failed')).toContain(
            'posting to the mod channel blew up'
        );
    });
});

describe('notifyWarningIssued', () => {
    it('returns unconfigured without fetching a channel', async () => {
        const fetch = vi.fn();
        const guild = {
            id: 'guild-1',
            channels: { fetch },
        } as unknown as Guild;

        const status = await notifyWarningIssued(guild, sampleWarning(), new Date('2026-09-01T20:00:00.000Z'), {
            configRepo: { getByGuildId: async () => null },
            warningsRepo: { countActive: async () => 1 },
        });

        expect(status).toBe('unconfigured');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('posts an embed to the configured mod channel', async () => {
        const send = vi.fn().mockResolvedValue({});
        const guild = {
            id: 'guild-1',
            members: {
                me: { id: 'bot-1' },
            },
            channels: {
                fetch: vi.fn().mockResolvedValue({
                    id: 'mod-channel',
                    type: ChannelType.GuildText,
                    permissionsFor: () =>
                        new PermissionsBitField([
                            PermissionsBitField.Flags.ViewChannel,
                            PermissionsBitField.Flags.SendMessages,
                            PermissionsBitField.Flags.EmbedLinks,
                        ]),
                    send,
                }),
            },
        } as unknown as Guild;

        const status = await notifyWarningIssued(guild, sampleWarning(), new Date('2026-09-01T20:00:00.000Z'), {
            configRepo: {
                getByGuildId: async () => ({
                    id: 1,
                    guildId: 'guild-1',
                    modChannelId: 'mod-channel',
                    createdAt: new Date('2026-09-01T00:00:00.000Z'),
                    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
                    configVersion: 1,
                }),
            },
            warningsRepo: { countActive: async () => 3 },
        });

        expect(status).toBe('sent');
        expect(send).toHaveBeenCalledOnce();
        const payload = send.mock.calls[0]?.[0] as { allowedMentions: { parse: string[] }; embeds: unknown[] };
        expect(payload.allowedMentions).toEqual({ parse: [] });
        expect(JSON.stringify(payload.embeds)).toContain('consent-k7m2');
        expect(JSON.stringify(payload.embeds)).toContain('3');
    });

    it('skips when the configured channel is gone', async () => {
        const guild = {
            id: 'guild-1',
            members: { me: { id: 'bot-1' } },
            channels: { fetch: vi.fn().mockResolvedValue(null) },
        } as unknown as Guild;

        const status = await notifyWarningIssued(guild, sampleWarning(), new Date('2026-09-01T20:00:00.000Z'), {
            configRepo: {
                getByGuildId: async () => ({
                    id: 1,
                    guildId: 'guild-1',
                    modChannelId: 'missing',
                    createdAt: new Date('2026-09-01T00:00:00.000Z'),
                    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
                    configVersion: 1,
                }),
            },
            warningsRepo: { countActive: async () => 1 },
        });

        expect(status).toBe('skipped');
    });
});
