import { screen, waitFor } from '@testing-library/react';
import type { LevelingUserDetail, StatsPeriod } from '@brattybot/web-sdk';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi, type FakeApiReply } from '../../__tests__/support/fakeApi';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { GuildProvider } from '../../guilds/GuildContext';
import { LevelingInsightsPage } from '../LevelingInsightsPage';
import { LevelingUserPage } from '../LevelingUserPage';

/**
 * The two leveling pages whose reads carry a decision: the insights report's 503 is a
 * capacity answer and not a fault, and the member page keeps its header through a period
 * change while asking the server for the new window.
 *
 * Through the fake API, so the generated client, its `ApiError` and the query cache run as
 * they do in the browser.
 */

const GUILD_ID = '900000000000000001';
const USER_ID = '111111111111111111';
const LEVELING_PATH = `/api/guilds/${GUILD_ID}/leveling`;

function serveGuild(api: FakeApi): void {
    api.on('GET', '/api/guilds', () => ({
        body: { guilds: [{ id: GUILD_ID, name: 'Brat Palace', iconURL: null, memberCount: 3 }] },
    }));
}

function renderAt(path: string) {
    return renderWithProviders(
        <MemoryRouter initialEntries={[path]}>
            <GuildProvider>
                <Routes>
                    <Route path="/leveling/insights" element={<LevelingInsightsPage />} />
                    <Route path="/leveling/:userId" element={<LevelingUserPage />} />
                </Routes>
            </GuildProvider>
        </MemoryRouter>
    );
}

function activity(): LevelingUserDetail['recentActivity'] {
    return { messageCount: 40, reactionCount: 12, photoUploadCount: 3, voiceSessionCount: 1, totalXp: 800, eventCount: 56 };
}

function detail(statsPeriod: StatsPeriod): LevelingUserDetail {
    return {
        userId: USER_ID,
        member: { userId: USER_ID, displayName: 'Kitten', username: 'kittenuser', avatarUrl: null, isBot: false },
        level: 14,
        totalXp: 12_500,
        xpWithinLevel: 500,
        xpToNextLevel: 900,
        xpForCurrentLevelStep: 1_400,
        hasAnyActivity: true,
        statsPeriod,
        recentPeriodDays: statsPeriod === 'week' ? 7 : 30,
        recentActivity: activity(),
        totalActivity: activity(),
        voiceSessionCount: 18,
        totalVoiceSeconds: 46_800,
        activityChart: { granularity: 'daily', buckets: [] },
        metrics: {
            activityStatus: 'active',
            lastActiveAt: '2026-09-20T18:30:00.000Z',
            memberSince: '2026-01-04T09:15:00.000Z',
            tenureDays: 264,
            recentMsgsPerDay: 5.7,
            recentXpPerDay: 114.3,
            allTimeMsgsPerDay: 3.7,
            messageSharePercent: 72,
            reactionSharePercent: 26,
            voiceSharePercent: 2,
            photoRatePercent: 5,
            avgMessageLengthRecent: 84,
            avgXpPerMessageRecent: 20,
            dailyPeakEvents: 41,
        },
    };
}

describe('LevelingInsightsPage', () => {
    it('shows a 503 as a guild too big to scan, in the server’s words, not as a fault', async () => {
        const api = installFakeApi();
        serveGuild(api);
        const refusal =
            'This guild has 1,200,000 logged XP events, over the 750,000 ceiling the insights report will scan.';
        api.on('GET', `${LEVELING_PATH}/insights`, () => ({ status: 503, body: { error: refusal } }));

        renderAt('/leveling/insights');

        expect(await screen.findByText('Too much history to crunch')).toBeTruthy();
        expect(screen.getByText(refusal)).toBeTruthy();
        expect(screen.queryByText("Couldn't load the insights report")).toBeNull();
    });
});

describe('LevelingUserPage', () => {
    it('lets the server pick the first window, then asks for the one picked while keeping the member on screen', async () => {
        const api = installFakeApi();
        serveGuild(api);
        const userPath = `${LEVELING_PATH}/users/${USER_ID}`;
        api.on('GET', userPath, () => ({ body: detail('week') }));
        let answerMonth: (reply: FakeApiReply) => void = () => undefined;
        api.on('GET', `${userPath}?period=month`, () => new Promise<FakeApiReply>((resolve) => (answerMonth = resolve)));
        const { user } = renderAt(`/leveling/${USER_ID}`);

        expect(await screen.findByRole('heading', { name: 'Kitten' })).toBeTruthy();
        await user.click(screen.getByRole('radio', { name: '30 days' }));

        // The month is being read, and the member is still on screen while it is.
        await waitFor(() => expect(api.requests.map((request) => request.path)).toContain(`${userPath}?period=month`));
        expect(screen.getByRole('heading', { name: 'Kitten' })).toBeTruthy();

        answerMonth({ body: detail('month') });
        await waitFor(() =>
            expect((screen.getByRole('radio', { name: '30 days' }) as HTMLInputElement).checked).toBe(true)
        );
        // The first read named no window: the bot's own default decided it.
        expect(api.requests.filter((request) => request.path.startsWith(userPath)).map((request) => request.path)).toEqual([
            userPath,
            `${userPath}?period=month`,
        ]);
    });
});
