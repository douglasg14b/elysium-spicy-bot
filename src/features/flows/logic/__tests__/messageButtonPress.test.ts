import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { InteractionType, type Interaction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { InteractionsRegistry } from '../../../../features-system/commands/interactionsRegistry';
import { MESSAGE_BUTTON_CUSTOM_ID_PREFIX } from '../../../provisioning';
import { FLOW_CHOICE_CUSTOM_ID_PREFIX, FLOW_CUSTOM_ID_PREFIX } from '../../constants';
import { handleMessageButtonPress, NOTHING_HOOKED_UP } from '../messageButtonPress';

/**
 * A press on a journey message's button — `mbtn:<buttonKey>` — through a real registry: it
 * answers the presser alone, and does nothing else. Step 3 gives it something to do.
 *
 * The registry here is a fresh one holding the three prefixes flows registers, so the
 * longest-prefix routing between them is the real code; that `initFlows` registers this
 * handler under this prefix is read off its source below, since running `initFlows` would
 * attach every gateway listener the engine has.
 */

/** What the registry itself reads off an interaction to route and answer it. */
const REGISTRY_READS = new Set<PropertyKey>(['type', 'customId', 'isRepliable', 'replied', 'deferred', 'reply']);

/** A button press whose every member read is recorded, so "touches nothing" can be asserted. */
function fakeButtonPress(customId: string) {
    const read = new Set<PropertyKey>();
    const reply = vi.fn().mockResolvedValue(undefined);
    const target = {
        type: InteractionType.MessageComponent,
        customId,
        isButton: () => true,
        isRepliable: () => true,
        replied: false,
        deferred: false,
        reply,
    };
    const interaction = new Proxy(target, {
        get(object, property, receiver) {
            read.add(property);
            return Reflect.get(object, property, receiver);
        },
    });
    return { interaction: interaction as unknown as Interaction, read, reply };
}

function registryWithFlowPrefixes() {
    const registry = new InteractionsRegistry();
    const flowPress = vi.fn().mockResolvedValue({ status: 'success' });
    const choicePress = vi.fn().mockResolvedValue({ status: 'success' });
    registry.registerDynamic(`${FLOW_CUSTOM_ID_PREFIX}:`, flowPress);
    registry.registerDynamic(`${FLOW_CHOICE_CUSTOM_ID_PREFIX}:`, choicePress);
    registry.registerDynamic(`${MESSAGE_BUTTON_CUSTOM_ID_PREFIX}:`, handleMessageButtonPress);
    return { registry, flowPress, choicePress };
}

describe('pressing a message resource’s button', () => {
    it('answers the presser alone that nothing is hooked up, and touches nothing else', async () => {
        const { registry, flowPress, choicePress } = registryWithFlowPrefixes();
        const press = fakeButtonPress('mbtn:agree');

        await registry.handleInteraction(press.interaction);

        expect(press.reply).toHaveBeenCalledOnce();
        expect(press.reply).toHaveBeenCalledWith({ content: NOTHING_HOOKED_UP, ephemeral: true });
        expect(NOTHING_HOOKED_UP).toBe("Nothing's hooked up to this yet. Poke it all you like, babe — it isn't going to put out.");
        // The handler read whether it was a button, and nothing else: no message, no member, no reply of its own.
        expect([...press.read].filter((property) => !REGISTRY_READS.has(property))).toEqual(['isButton']);
        expect(flowPress).not.toHaveBeenCalled();
        expect(choicePress).not.toHaveBeenCalled();
    });

    it('still routes a flowc: answer to choices, and a flow: press to its trigger', async () => {
        const { registry, flowPress, choicePress } = registryWithFlowPrefixes();

        await registry.handleInteraction(fakeButtonPress('flowc:run-1:node-1:0').interaction);
        await registry.handleInteraction(fakeButtonPress('flow:flow-1:node-1').interaction);

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
