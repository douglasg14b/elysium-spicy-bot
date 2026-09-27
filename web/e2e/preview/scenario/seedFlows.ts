import { buildOnboardingFlowGraph } from '../../../../src/features/flows/templates/onboardingFlow';
import type { PreviewPage, SeedContext } from './seedScenario';

interface CreatedFlow {
    readonly flowId: string;
    readonly name: string;
}

const STAFF_READ_WRITE = { audience: 'staff', access: 'readWrite' } as const;

/**
 * Flows in each state the flows page and the builder draw differently: installed and then
 * drifted in Discord, declared but never installed, grouped into a shared journey, and
 * empty. Names run from short to the 100-character cap.
 */
export async function seedFlows({ guild, clientGuild, discord, api }: SeedContext): Promise<PreviewPage[]> {
    const guildPath = `/api/guilds/${guild.guild.id}`;
    const createFlow = (name: string, graph?: unknown) => api.send<CreatedFlow>('POST', `${guildPath}/flows`, { name, graph });

    // Installed, then an operator renamed its channel and stripped its permissions in Discord.
    const onboarding = await createFlow(
        'Onboarding: Agree to Rules',
        buildOnboardingFlowGraph({
            memberRoleId: guild.roles.member.id,
            channelId: guild.channels.rules.id,
            welcomeMessage: 'Welcome, you filthy little rule-follower. You have your role now — go enjoy the server. 😈',
        }).graph
    );
    await api.send('PUT', `${guildPath}/flows/${onboarding.flowId}/resources`, {
        resources: [
            {
                key: 'lobby-category',
                kind: 'category',
                defaultName: 'Lobby',
                permissions: [{ audience: 'everyone', access: 'readOnly' }, STAFF_READ_WRITE],
            },
            {
                key: 'welcome-channel',
                kind: 'textChannel',
                defaultName: 'welcome',
                parentKey: 'lobby-category',
                permissions: [{ audience: 'everyone', access: 'readOnly' }, STAFF_READ_WRITE],
            },
            {
                key: 'verified-role',
                kind: 'role',
                defaultName: 'Agreed to the Rules',
            },
        ],
    });
    await api.send('POST', `${guildPath}/flows/${onboarding.flowId}/install`, {});
    const installedWelcome = clientGuild.channels.cache.find((channel) => channel.name === 'welcome');
    if (!installedWelcome) throw new Error('Seeding failed: installing onboarding created no #welcome.');
    const welcome = guild.guild.channel(installedWelcome.id);
    welcome.rename('welcome-and-rules-read-these-first');
    welcome.removeOverwrite(guild.guild.everyone);
    discord.flushGateway();

    // Declared at the cap on names, never installed.
    const verification = await createFlow(
        'Verification — ID check for the 18+ dungeon, reviewed by staff before anyone gets the Verified role',
    );
    await api.send('PUT', `${guildPath}/flows/${verification.flowId}/resources`, {
        resources: [
            {
                key: 'verification-category',
                kind: 'category',
                defaultName: 'Verification Queue — Pending ID Review',
                permissions: [{ audience: 'everyone', access: 'hidden' }, STAFF_READ_WRITE],
            },
            {
                key: 'verification-channel',
                kind: 'textChannel',
                defaultName: 'id-check-submissions-staff-eyes-only',
                parentKey: 'verification-category',
                permissions: [{ audience: 'everyone', access: 'hidden' }, STAFF_READ_WRITE],
            },
        ],
    });

    // Two flows sharing one journey.
    const munchSignup = await createFlow('Munch sign-up');
    const munchReminder = await createFlow('Munch reminder, the day before');
    await api.send('PUT', `${guildPath}/flows/${munchSignup.flowId}/resources`, {
        resources: [{ key: 'munch-channel', kind: 'textChannel', defaultName: 'munch-announcements' }],
    });
    await api.send('POST', `${guildPath}/flows/${munchReminder.flowId}/group`, {
        targetFlowId: munchSignup.flowId,
        newJourneyKey: 'events-and-munches',
        newJourneyName: 'Events & Munches (monthly, plus the big summer one)',
    });

    // Empty flows, so the list scrolls.
    for (const name of ['Birthday shout-outs', 'Reaction roles', 'Kink compatibility quiz', 'Brat tax', 'Aftercare check-in DM']) {
        await createFlow(name);
    }
    const scratch = await createFlow('Scratch');

    return [
        { name: 'flows-list', path: '/flows', note: 'ten flows: drifted install, long uninstalled names, a shared journey, empties' },
        { name: 'flow-onboarding', path: `/flows/${onboarding.flowId}`, note: 'three-node graph, installed, drifted' },
        { name: 'flow-verification', path: `/flows/${verification.flowId}`, note: 'empty graph, 100-character name, long resource names' },
        { name: 'flow-munch-signup', path: `/flows/${munchSignup.flowId}`, note: 'in a shared journey' },
        { name: 'flow-empty', path: `/flows/${scratch.flowId}`, note: 'nothing on the canvas' },
    ];
}
