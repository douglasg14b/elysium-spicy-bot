import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { InteractionType, type Interaction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { InteractionsRegistry } from '../../../../features-system/commands/interactionsRegistry';
import type { MessageComponentInteraction } from '../../../../features-system/commands/types';
import { MESSAGE_BUTTON_CUSTOM_ID_PREFIX } from '../../../provisioning';
import { FLOW_CHOICE_CUSTOM_ID_PREFIX, FLOW_CUSTOM_ID_PREFIX } from '../../constants';
import { handleMessageButtonPress } from '../messageButtonPress';

/**
 * The `mbtn:` handler's routing and its refusals before it reads anything. What a press on a
 * real message does — the binding, the listeners, the gate, the wake and the run — is the
 * integration test's (`messageButtonPress.integration.test.ts`), against real discord.js and
 * a real database.
 *
 * The registry here is a fresh one holding the three prefixes flows registers, so the
 * longest-prefix routing between them is the real code; that `initFlows` registers this
 * handler under this prefix is read off its source below, since running `initFlows` would
 * attach every gateway listener the engine has.
 */

/** A press that is not a guild member's: what the handler must refuse before any read. */
function strayPress(customId: string, overrides: Record<string, unknown> = {}): MessageComponentInteraction {
    return {
        type: InteractionType.MessageComponent,
        customId,
        isButton: () => true,
        guild: null,
        member: null,
        ...overrides,
    } as unknown as MessageComponentInteraction;
}

describe('pressing a message resource’s button', () => {
    it('refuses what it cannot route, before reading anything', async () => {
        await expect(handleMessageButtonPress(strayPress('mbtn:agree', { isButton: () => false }))).resolves.toEqual({
            status: 'skipped',
            message: 'Message resources only carry buttons.',
        });
        await expect(handleMessageButtonPress(strayPress('mbtn:agree:extra'))).resolves.toMatchObject({
            status: 'error',
            message: 'Malformed message button id.',
        });
        await expect(handleMessageButtonPress(strayPress('mbtn:agree'))).resolves.toMatchObject({
            status: 'error',
            message: '❌ This button can only be used in a server.',
        });
    });

    it('routes mbtn: here, a flowc: answer to choices, and a flow: press to its trigger', async () => {
        const registry = new InteractionsRegistry();
        const flowPress = vi.fn().mockResolvedValue({ status: 'success' });
        const choicePress = vi.fn().mockResolvedValue({ status: 'success' });
        const messagePress = vi.fn().mockResolvedValue({ status: 'success' });
        registry.registerDynamic(`${FLOW_CUSTOM_ID_PREFIX}:`, flowPress);
        registry.registerDynamic(`${FLOW_CHOICE_CUSTOM_ID_PREFIX}:`, choicePress);
        registry.registerDynamic(`${MESSAGE_BUTTON_CUSTOM_ID_PREFIX}:`, messagePress);
        const routed = (customId: string) =>
            ({ ...strayPress(customId), isRepliable: () => false, replied: false, deferred: false }) as unknown as Interaction;

        await registry.handleInteraction(routed('mbtn:agree'));
        await registry.handleInteraction(routed('flowc:run-1:node-1:0'));
        await registry.handleInteraction(routed('flow:flow-1:node-1'));

        expect(messagePress).toHaveBeenCalledOnce();
        expect(choicePress).toHaveBeenCalledOnce();
        expect(flowPress).toHaveBeenCalledOnce();
    });

    it('is registered by initFlows under the provisioning prefix', () => {
        const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'initFlows.ts'), 'utf8');

        expect(source).toMatch(
            /interactionsRegistry\.registerDynamic\(`\$\{MESSAGE_BUTTON_CUSTOM_ID_PREFIX\}:`, handleMessageButtonPress\)/
        );
    });
});
