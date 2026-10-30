import { ChannelType, PermissionsBitField, type Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
    buildWarningIssuedNoticeEmbed,
    formatWarnSuccessMessage,
    notifyWarningIssued,
} from '../logic/warningIssuedNotice';
import { sampleWarning } from './support/sampleWarning';

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
        const countActive = vi.fn(async () => 1);
        const guild = {
            id: 'guild-1',
            channels: { fetch },
        } as unknown as Guild;

        const status = await notifyWarningIssued(guild, sampleWarning(), new Date('2026-09-01T20:00:00.000Z'), {
            configRepo: { getByGuildId: async () => null },
            warningsRepo: { countActive },
        });

        expect(status).toBe('unconfigured');
        expect(fetch).not.toHaveBeenCalled();
        // The count is the embed's; a server with no channel never builds one, so a broken
        // count there cannot turn "unconfigured" into "failed".
        expect(countActive).not.toHaveBeenCalled();
    });

    it('posts an embed to the configured mod channel', async () => {
        const send = vi.fn().mockResolvedValue({});
        const guild = {
            id: 'guild-1',
            members: {
                me: { id: 'bot-1' },
            },
            channels: {
                cache: new Map([
                    [
                        'mod-channel',
                        {
                            id: 'mod-channel',
                            type: ChannelType.GuildText,
                            permissionsFor: () =>
                                new PermissionsBitField([
                                    PermissionsBitField.Flags.ViewChannel,
                                    PermissionsBitField.Flags.SendMessages,
                                    PermissionsBitField.Flags.EmbedLinks,
                                ]),
                            send,
                        },
                    ],
                ]),
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
            channels: { cache: new Map() },
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
