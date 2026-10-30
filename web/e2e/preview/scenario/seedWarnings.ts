import type { WarningResult } from '@brattybot/web-sdk';
import { warningsRepo } from '../../../../src/features/warnings/data/warningsRepo';
import { issueGuildWarning } from '../../../../src/features/warnings/logic/issueGuildWarning';
import type { PreviewPage, SeedContext } from './seedScenario';

/**
 * Warnings in every state the list, the drawer and the dialogs render differently: active,
 * edited, released with a reason, expired, and one written before names were recorded.
 *
 * **Issued, edited and released through the routes**, as the dashboard does. Two states no
 * route can make go through the product's own code instead:
 *
 *  - **Expired**: every route refuses a drop-off already past, so it is issued through
 *    `issueGuildWarning` — the write path `/warn` and the route share — as of eight months ago.
 *  - **No names**: a row from before the name columns existed. Nothing writes one any more,
 *    so it is inserted through `warningsRepo` as the old code did.
 */

const LONG_DESCRIPTION =
    'Kept going after the safeword — twice — then told the room it was "part of the scene". It was not. ' +
    'Three people in #general saw it, two DMed a mod, and one left the server. Spoken to in DMs; ' +
    'they said they "didn\'t hear it", which is its own problem.';

export async function seedWarnings({ guild, clientGuild, api }: SeedContext): Promise<PreviewPage[]> {
    const warningsPath = `/api/guilds/${guild.guild.id}/warnings`;
    const [brat, ropeBunny, switchy] = guild.members;
    if (!brat || !ropeBunny || !switchy) throw new Error('The preview guild has fewer than three members.');
    const bratName = clientGuild.members.cache.get(brat.id)?.displayName;
    if (!bratName) throw new Error('The bot holds no member for the brat.');

    await api.send<WarningResult>('POST', warningsPath, {
        userId: ropeBunny.id,
        rule: 'No means no',
        description: LONG_DESCRIPTION,
    });
    await api.send<WarningResult>('POST', warningsPath, {
        userId: brat.id,
        rule: 'Mind the mouth in the SFW channels — keep the filth where it belongs',
        description: 'Graphic play-by-play in #selfies-sfw. Asked to move it, moved it to #general instead.',
    });
    const spam = await api.send<WarningResult>('POST', warningsPath, {
        userId: switchy.id,
        rule: 'Spam',
        description: 'Fourteen copies of the same munch flyer in an hour.',
    });
    await api.send<WarningResult>('PUT', `${warningsPath}/${spam.slug}`, {
        rule: 'Spam in #events-and-munches',
        description: spam.description,
        dropsOffOn: spam.dropsOffOn,
        baseEditedAt: null,
    });
    const late = await api.send<WarningResult>('POST', warningsPath, {
        userId: ropeBunny.id,
        rule: 'Skipped aftercare duty',
        description: 'Signed up for the aftercare corner at the munch and vanished.',
    });
    await api.send<WarningResult>('POST', `${warningsPath}/${late.slug}/release`, {
        reason: 'Turned out they were in the ER with a sprained wrist. Off the hook.',
    });

    const eightMonthsAgo = new Date(Date.now() - 240 * 24 * 60 * 60 * 1000);
    const expired = await issueGuildWarning({
        guildId: guild.guild.id,
        userId: brat.id,
        userName: bratName,
        issuerId: guild.operator.id,
        issuerName: guild.operator.username,
        rule: 'Brat tax unpaid',
        description: 'Ignored three direct instructions in a row. Repeatedly. With eye contact.',
        issuedInput: '',
        expiresInput: '',
        now: eightMonthsAgo,
    });
    if (!expired.ok) throw new Error(`The expired warning was refused: ${expired.kind}`);

    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const day = longAgo.toISOString().slice(0, 10);
    const dropsOff = new Date(longAgo.getTime() + 150 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await warningsRepo.insert({
        guildId: guild.guild.id,
        userId: switchy.id,
        userName: null,
        issuerId: guild.operator.id,
        issuerName: null,
        slug: 'ghost-of-warnings-past',
        rule: 'Posted a screenshot of DMs without consent',
        description: 'Written before the bot kept names. The ids are all there is.',
        issuedAt: `${day}T00:00:00.000Z`,
        expiresAt: `${dropsOff}T00:00:00.000Z`,
        clearedAt: null,
        clearedById: null,
        clearedByName: null,
        clearReason: null,
        editedAt: null,
        editedById: null,
        editedByName: null,
        createdAt: longAgo.toISOString(),
    });

    const openDrawer = { clickText: 'No means no' } as const;
    return [
        {
            name: 'warnings',
            path: '/warnings',
            note: 'four active warnings, one edited, one with no recorded names — click All for the Status column',
        },
        { name: 'warnings-drawer', path: '/warnings', note: 'an active warning with a long description', steps: [openDrawer] },
        {
            name: 'warnings-released-drawer',
            path: '/warnings',
            note: 'a released warning: who, when, why — no actions',
            steps: [{ clickText: 'Released' }, { clickText: 'Skipped aftercare duty' }],
        },
        { name: 'warnings-issue', path: '/warnings', note: 'the issue dialog, untouched', steps: [{ clickButton: 'Issue warning' }] },
        {
            name: 'warnings-member-search',
            path: '/warnings',
            note: 'the member picker open (type two letters by hand to see results)',
            steps: [{ clickButton: 'Issue warning' }, { clickTextbox: 'Member' }],
        },
        { name: 'warnings-edit', path: '/warnings', note: 'the edit dialog, pristine', steps: [openDrawer, { clickButton: 'Edit' }] },
        {
            name: 'warnings-release',
            path: '/warnings',
            note: 'the release confirm',
            steps: [openDrawer, { clickButton: 'Release' }],
        },
    ];
}
