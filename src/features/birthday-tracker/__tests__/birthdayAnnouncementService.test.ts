import type { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
    BirthdayAnnouncementDependencies,
    detectAnnouncementViolations,
    runBirthdayAnnouncementTick,
    sanitizeAnnouncementForSend,
} from '../birthdayAnnouncementService';

describe('detectAnnouncementViolations', () => {
    it('flags broad mentions and age references', () => {
        const violations = detectAnnouncementViolations('Happy birthday @everyone, turning 32 today!', {
            forbiddenPhrases: ['Avery'],
        });
        expect(violations).toContain('output must not include @everyone or @here');
        expect(violations).toContain('output must not mention age');
    });

    it('flags display name/username if included', () => {
        const violations = detectAnnouncementViolations('Happy birthday Avery, enjoy your day!', {
            forbiddenPhrases: ['Avery'],
        });
        expect(violations).toContain('output must not include "Avery"');
    });
});

describe('sanitizeAnnouncementForSend', () => {
    it('defangs broad mentions', () => {
        const sanitized = sanitizeAnnouncementForSend('Happy birthday @everyone and @here');
        expect(sanitized).toContain('@\u200beveryone');
        expect(sanitized).toContain('@\u200bhere');
        expect(sanitized).not.toContain('@everyone');
        expect(sanitized).not.toContain('@here');
    });
});

describe('runBirthdayAnnouncementTick', () => {
    it('skips overlapping runs when a previous tick is still running', async () => {
        let resolvePendingFind: (value: []) => void = () => {};
        const pendingFind = new Promise<[]>(function resolver(resolve) {
            resolvePendingFind = resolve;
        });

        const findDueForAnnouncementToday = vi.fn(async () => await pendingFind);

        const dependencies = {
            birthdayRepository: {
                findDueForAnnouncementToday,
                markAnnounced: vi.fn(),
            },
            birthdayConfigRepo: {
                getByGuildId: vi.fn(),
            },
            aiService: {
                generateBirthdayAnnouncement: vi.fn(),
            },
        } as unknown as BirthdayAnnouncementDependencies;

        const fakeClient = {
            user: { id: 'bot-user' },
        } as unknown as Client;

        const firstTick = runBirthdayAnnouncementTick(fakeClient, dependencies);

        await Promise.resolve();
        await runBirthdayAnnouncementTick(fakeClient, dependencies);

        expect(findDueForAnnouncementToday).toHaveBeenCalledTimes(1);

        resolvePendingFind([]);
        await firstTick;
    });

    it('skips birthday lookup outside the Pacific announcement window', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-04-17T10:00:00.000Z'));

            const findDueForAnnouncementToday = vi.fn(async () => []);

            const dependencies = {
                birthdayRepository: {
                    findDueForAnnouncementToday,
                    markAnnounced: vi.fn(),
                },
                birthdayConfigRepo: {
                    getByGuildId: vi.fn(),
                },
                aiService: {
                    generateBirthdayAnnouncement: vi.fn(),
                },
            } as unknown as BirthdayAnnouncementDependencies;

            const fakeClient = {
                user: { id: 'bot-user' },
            } as unknown as Client;

            await runBirthdayAnnouncementTick(fakeClient, dependencies);

            expect(findDueForAnnouncementToday).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('sends fallback when model keeps violating safety checks', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-04-17T15:05:00.000Z'));

            const send = vi.fn(
                async (_payload: { content: string; allowedMentions: { parse: string[]; users: string[] } }) => ({})
            );
            const dependencies = {
                birthdayRepository: {
                    findDueForAnnouncementToday: vi.fn(async () => [
                        {
                            guildId: 'g-1',
                            userId: 'u-1',
                            displayName: 'Avery',
                            username: 'avery',
                        },
                    ]),
                    markAnnounced: vi.fn(async () => undefined),
                },
                birthdayConfigRepo: {
                    getByGuildId: vi.fn(async () => ({
                        announcementChannelId: 'c-1',
                        contextChannelId: null,
                    })),
                },
                aiService: {
                    generateBirthdayAnnouncement: vi.fn(async () => 'Happy birthday @everyone and @here'),
                },
            } as unknown as BirthdayAnnouncementDependencies;

            const fakeClient = {
                user: { id: 'bot-user' },
                guilds: {
                    cache: new Map([
                        [
                            'g-1',
                            {
                                id: 'g-1',
                                channels: {
                                    fetch: vi.fn(async () => ({
                                        id: 'c-1',
                                        isTextBased: () => true,
                                        isDMBased: () => false,
                                        permissionsFor: () => ({
                                            has: () => true,
                                        }),
                                        send,
                                    })),
                                },
                                members: {
                                    me: { id: 'bot-user' },
                                    fetchMe: vi.fn(),
                                    fetch: vi.fn(async () => null),
                                },
                            },
                        ],
                    ]),
                    fetch: vi.fn(),
                },
            } as unknown as Client;

            await runBirthdayAnnouncementTick(fakeClient, dependencies);

            expect(send).toHaveBeenCalledTimes(1);
            const sentContent = send.mock.calls[0]?.[0]?.content as string;
            expect(dependencies.aiService.generateBirthdayAnnouncement).toHaveBeenCalledTimes(3);
            expect(sentContent).toContain('Happy birthday. Cause a little tasteful chaos today.');
            expect(sentContent).not.toContain('@everyone');
            expect(sentContent).not.toContain('@here');
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not re-post in the same runtime when marking announced fails', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-04-17T15:05:00.000Z'));

            const send = vi.fn(async (_payload: { content: string; allowedMentions: { parse: string[]; users: string[] } }) => ({}));
            const markAnnounced = vi.fn(async () => {
                throw new Error('database unavailable');
            });

            const dependencies = {
                birthdayRepository: {
                    findDueForAnnouncementToday: vi.fn(async () => [
                        {
                            guildId: 'g-2',
                            userId: 'u-2',
                            displayName: 'Raven',
                            username: 'raven',
                        },
                    ]),
                    markAnnounced,
                },
                birthdayConfigRepo: {
                    getByGuildId: vi.fn(async () => ({
                        announcementChannelId: 'c-2',
                        contextChannelId: null,
                    })),
                },
                aiService: {
                    generateBirthdayAnnouncement: vi.fn(async () => 'Happy birthday, darling.'),
                },
            } as unknown as BirthdayAnnouncementDependencies;

            const fakeClient = {
                user: { id: 'bot-user' },
                guilds: {
                    cache: new Map([
                        [
                            'g-2',
                            {
                                id: 'g-2',
                                channels: {
                                    fetch: vi.fn(async () => ({
                                        id: 'c-2',
                                        isTextBased: () => true,
                                        isDMBased: () => false,
                                        permissionsFor: () => ({
                                            has: () => true,
                                        }),
                                        send,
                                    })),
                                },
                                members: {
                                    me: { id: 'bot-user' },
                                    fetchMe: vi.fn(),
                                    fetch: vi.fn(async () => null),
                                },
                            },
                        ],
                    ]),
                    fetch: vi.fn(),
                },
            } as unknown as Client;

            const firstTick = runBirthdayAnnouncementTick(fakeClient, dependencies);
            await vi.runAllTimersAsync();
            await firstTick;
            await runBirthdayAnnouncementTick(fakeClient, dependencies);

            expect(send).toHaveBeenCalledTimes(1);
            expect(markAnnounced).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });
});
