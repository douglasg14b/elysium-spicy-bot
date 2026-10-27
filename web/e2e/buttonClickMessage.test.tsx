import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Events, type Interaction, type PermissionsString } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { interactionsRegistry } from '../../src/features-system/commands';
import { ACTION_SEND_MESSAGE } from '../../src/features/flows/blocks/actionSendMessage';
import { TRIGGER_BUTTON_CLICK } from '../../src/features/flows/blocks/triggerButtonClick';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../src/features/flows/data/flowGraph';
import { handleMessageButtonPress } from '../../src/features/flows/logic/messageButtonPress';
import { MESSAGE_BUTTON_CUSTOM_ID_PREFIX } from '../../src/features/provisioning';
import { TestDiscord } from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi, type DashboardRequest } from './support/dashboardApi';
import { renderDashboard } from './support/renderDashboard';

/**
 * A Button Click trigger listening to a message's button, end to end (step 3): from a flow on
 * no journey, the trigger's own "+ New message in #rules" and "+ New button" declare the
 * message and pick its button — with one of the server's own emoji beside its label; Save and
 * the builder's install wizard post it; TestDiscord then holds one message with one `mbtn:`
 * button wearing that emoji, and a member pressing it runs the flow.
 *
 * The emoji grid is stood in for at its package (`stubEmojiPicker`): jsdom lays nothing out, so
 * the real, virtualised grid would draw no emoji to click. The emoji list it offers is the real
 * route's, read from TestDiscord's guild.
 *
 * The graph — the trigger with nothing picked and a line into #lounge — is written through the
 * API, as `builderResourceSaves.test.tsx` writes its trigger: dragging blocks onto the canvas is
 * not what is under test. The press goes through the real `interactionsRegistry` to the real
 * router, registered here under the prefix `initFlows` registers it under, since
 * `bootBotForDashboard` wires no gateway handlers.
 */

const BOT_PERMISSIONS: readonly PermissionsString[] = [
    'ViewChannel',
    'ManageChannels',
    'SendMessages',
    'EmbedLinks',
    'ReadMessageHistory',
];
const OPERATOR = { id: '100000000000000005', username: 'e2e-operator' };
const SAID = 'Welcome in, you gorgeous rule-reader.';

vi.mock('emoji-picker-react', async (importOriginal) => {
    const { stubEmojiPickerModule } = await import('../src/__tests__/support/stubEmojiPicker');
    return stubEmojiPickerModule(await importOriginal<typeof import('emoji-picker-react')>());
});

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
    interactionsRegistry.registerDynamic(`${MESSAGE_BUTTON_CUSTOM_ID_PREFIX}:`, handleMessageButtonPress);
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

describe('a Button Click trigger on a message it made', () => {
    it('declares the message and its button from the trigger, posts them on install, and runs on a press', async () => {
        const discord = new TestDiscord();
        running.push(discord);
        const guild = discord.createGuild({ bot: { permissions: BOT_PERMISSIONS } });
        const rules = guild.createTextChannel({ name: 'rules' });
        const lounge = guild.createTextChannel({ name: 'lounge' });
        const member = guild.createMember({ username: 'fresh_meat' });
        const blobheart = guild.createEmoji({ name: 'blobheart' });
        const client = await discord.start();
        const handling: Promise<unknown>[] = [];
        // What `bot.ts` does with every interaction.
        client.on(Events.InteractionCreate, (interaction: Interaction) => {
            handling.push(interactionsRegistry.handleInteraction(interaction));
        });

        const faults: string[] = [];
        const api = createSeedApi(buildDashboardApp({ client, operator: OPERATOR, onFault: (fault) => faults.push(fault) }), discord);
        const guildPath = `/api/guilds/${guild.id}`;
        const flow = await api.send<{ flowId: string }>('POST', `${guildPath}/flows`, { name: 'Rules gate' });
        const flowPath = `${guildPath}/flows/${flow.flowId}`;
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'press', type: TRIGGER_BUTTON_CLICK, position: { x: 0, y: 0 }, data: {} },
                {
                    id: 'greet',
                    type: ACTION_SEND_MESSAGE,
                    position: { x: 0, y: 160 },
                    data: { channelId: lounge.id, message: SAID },
                },
            ],
            edges: [{ id: 'e1', source: 'press', target: 'greet' }],
        };
        await api.send('PUT', flowPath, { graph });

        const dashboard = installDashboardApi(client, OPERATOR);
        const { user } = renderDashboard(`/flows/${flow.flowId}`);

        // The trigger makes its own message in #rules — adopting the server's channel — then its button.
        fireEvent.click(await screen.findByText(/no button picked/));
        await user.click(await screen.findByRole('button', { name: 'New message in…' }));
        await user.click(await screen.findByRole('menuitem', { name: /^#rules/ }));
        await user.click(await screen.findByRole('button', { name: 'Pick an emoji' }));
        await user.click(await screen.findByRole('button', { name: 'blobheart' }));
        await user.type(await screen.findByRole('textbox', { name: 'Label' }), 'Let me in');
        await user.click(screen.getByRole('button', { name: 'Add' }));

        // Stored before the graph is saved, so the save is judged against a journey holding the button.
        const heart = { id: blobheart.id, name: 'blobheart', animated: false };
        await waitFor(async () => {
            const stored = await api.send<{ resources: { kind: string; buttons?: { label: string }[] }[] }>(
                'GET',
                `${flowPath}/resources`
            );
            expect(stored.resources.find((resource) => resource.kind === 'message')?.buttons).toEqual([
                { key: 'let-me-in', label: 'Let me in', style: 'Primary', emoji: heart },
            ]);
        });

        await user.click(screen.getByRole('button', { name: 'Save' }));
        const saved: DashboardRequest = { method: 'PUT', path: flowPath };
        await waitFor(() => expect(dashboard.requests).toContainEqual(saved));
        expect(await screen.findByText('"Rules gate" is locked in.')).toBeTruthy();

        // Install from the builder's wizard: the channel is adopted, the message posted.
        await user.click(await screen.findByRole('button', { name: 'Install 2' }));
        const wizard = await screen.findByRole('dialog', { name: 'Install what this flow needs' });
        await user.click(within(wizard).getByRole('button', { name: 'Install' }));
        await user.click(within(wizard).getByRole('button', { name: 'Yes, build it' }));
        await waitFor(() => expect(dashboard.requests).toContainEqual({ method: 'POST', path: `${flowPath}/install` }));
        await waitFor(() => expect(rules.messages).toHaveLength(1));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Install what this flow needs' })).toBeNull());

        // Live.
        await user.click(screen.getByRole('switch', { name: 'Enabled' }));
        await waitFor(async () => {
            const stored = await api.send<{ enabled: boolean }>('GET', flowPath);
            expect(stored.enabled).toBe(true);
        });

        // Discord holds one message in #rules carrying one `mbtn:` button.
        const [posted] = rules.messages;
        if (!posted) throw new Error('Nothing was posted in #rules.');
        const buttons = posted.components.flatMap((row) => row.components);
        const customIds = buttons.map((button) => ('custom_id' in button ? button.custom_id : undefined));
        expect(customIds).toEqual([expect.stringMatching(/^mbtn:/)]);
        expect(buttons.map((button) => ('emoji' in button ? button.emoji : undefined))).toEqual([heart]);
        const [customId] = customIds;
        if (!customId) throw new Error('The posted button has no custom id.');

        // A member presses it, and the flow runs: a deferred update, then its line in #lounge.
        const pressed = rules.pressButton({ by: member, messageId: posted.id, customId });
        await Promise.all(handling.splice(0));
        expect(pressed.responses).toEqual([{ kind: 'deferUpdate' }]);
        await waitFor(() => expect(lounge.messages.map((message) => message.content)).toEqual([SAID]));
        expect(faults).toEqual([]);
    });
});
