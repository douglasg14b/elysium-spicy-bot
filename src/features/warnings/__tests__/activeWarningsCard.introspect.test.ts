/**
 * Local /warnings card preview — edit PREVIEW scenarios below, then run:
 *
 *   pnpm test activeWarningsCard.introspect
 *
 * Writes `.jarvis/active-warnings-card-preview.png` (default counts)
 * and `.jarvis/active-warnings-member-preview.png` (`user:` view).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderActiveWarningsCard } from '../cards/activeWarningsCard/renderActiveWarningsCard';

const PREVIEW_DIR = join(process.cwd(), '.jarvis');
const SUMMARY_PREVIEW_OUTPUT = join(PREVIEW_DIR, 'active-warnings-card-preview.png');
const MEMBER_PREVIEW_OUTPUT = join(PREVIEW_DIR, 'active-warnings-member-preview.png');

const SUMMARY_PREVIEW = {
    kind: 'summary' as const,
    guildName: 'Spicy Server',
    totalWarnings: 12,
    totalMembers: 8,
    summaries: [
        {
            userId: '123456789012345601',
            warningCount: 3,
            soonestExpiresAt: new Date('2026-09-15T00:00:00.000Z'),
        },
        {
            userId: '123456789012345602',
            warningCount: 2,
            soonestExpiresAt: new Date('2026-10-01T00:00:00.000Z'),
        },
        {
            userId: '123456789012345603',
            warningCount: 2,
            soonestExpiresAt: new Date('2026-11-20T00:00:00.000Z'),
        },
        {
            userId: '123456789012345604',
            warningCount: 1,
            soonestExpiresAt: new Date('2026-12-08T00:00:00.000Z'),
        },
        {
            userId: '123456789012345605',
            warningCount: 1,
            soonestExpiresAt: new Date('2027-01-04T00:00:00.000Z'),
        },
        {
            userId: '123456789012345606',
            warningCount: 1,
            soonestExpiresAt: new Date('2027-02-14T00:00:00.000Z'),
        },
        {
            userId: '123456789012345607',
            warningCount: 1,
            soonestExpiresAt: new Date('2027-03-01T00:00:00.000Z'),
        },
        {
            userId: '123456789012345608',
            warningCount: 1,
            soonestExpiresAt: new Date('2027-03-12T00:00:00.000Z'),
        },
    ],
    members: [
        { userId: '123456789012345601', displayName: 'BratOne', avatarUrl: null },
        { userId: '123456789012345602', displayName: 'OopsAllRed', avatarUrl: null },
        { userId: '123456789012345603', displayName: 'ChatGoblin', avatarUrl: null },
        { userId: '123456789012345604', displayName: 'LeftTheServerMaybe', avatarUrl: null },
        { userId: '123456789012345605', displayName: 'RepeatCustomer', avatarUrl: null },
        { userId: '123456789012345606', displayName: 'SoftLimitSkip', avatarUrl: null },
        { userId: '123456789012345607', displayName: 'CameraHappy', avatarUrl: null },
        { userId: '123456789012345608', displayName: 'QuietOne', avatarUrl: null },
    ],
};

const MEMBER_PREVIEW = {
    kind: 'member' as const,
    memberName: 'BratOne',
    totalActive: 3,
    entries: [
        {
            slug: 'consent-k7m2',
            rule: 'Consent',
            expiresAt: new Date('2026-09-15T00:00:00.000Z'),
        },
        {
            slug: 'harassment-b9x2',
            rule: 'Harassment / dogpiling',
            expiresAt: new Date('2026-11-20T00:00:00.000Z'),
        },
        {
            slug: 'privacy-t5j9',
            rule: 'Privacy / screenshots',
            expiresAt: new Date('2027-03-01T00:00:00.000Z'),
        },
    ],
};

describe('active warnings card introspection', () => {
    it('writes PNG previews for the default count card and the member list card', async () => {
        const [summaryPng, memberPng] = await Promise.all([
            renderActiveWarningsCard(SUMMARY_PREVIEW),
            renderActiveWarningsCard(MEMBER_PREVIEW),
        ]);

        await mkdir(PREVIEW_DIR, { recursive: true });
        await writeFile(SUMMARY_PREVIEW_OUTPUT, summaryPng);
        await writeFile(MEMBER_PREVIEW_OUTPUT, memberPng);

        console.log(`\nDefault /warnings preview:\n  ${SUMMARY_PREVIEW_OUTPUT}`);
        console.log(`Member /warnings user: preview:\n  ${MEMBER_PREVIEW_OUTPUT}\n`);

        expect(summaryPng.byteLength).toBeGreaterThan(1_000);
        expect(memberPng.byteLength).toBeGreaterThan(1_000);
        expect(summaryPng.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(memberPng.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }, 30_000);
});
