import { beforeAll, describe, expect, it } from 'vitest';
import { ensureBlocksDiscovered } from '../../blocks/registry';
import { TRIGGER_BUTTON_CLICK } from '../../blocks/triggerButtonClick';
import { OPEN_GATE, ELIGIBILITY_CONFIG_KEY } from '../../engine/eligibility';
import type { FlowGraph, FlowNode } from '../../data/flowGraph';
import type { FlowEntity } from '../../data/flowsSchema';
import { MAX_BUTTONS_PER_MESSAGE, planButtonDeployment } from '../planButtonDeployment';

/**
 * Where a flow's trigger buttons go, decided from the graph alone.
 *
 * The behaviour worth holding: a destination lives on the **node**, so one flow can
 * open buttons in several channels; and every way a canvas can be wrong refuses the
 * *whole* deploy rather than posting the part that happens to work.
 */

const FLOW_ID = 'flow-1';

function buttonNode(id: string, data: Record<string, unknown> = {}): FlowNode {
    return {
        id,
        type: TRIGGER_BUTTON_CLICK,
        position: { x: 0, y: 0 },
        data: {
            channelId: 'channel-rules',
            label: 'Agree to rules',
            style: 'Primary',
            [ELIGIBILITY_CONFIG_KEY]: OPEN_GATE,
            ...data,
        },
    } as FlowNode;
}

function flow(nodes: readonly FlowNode[]): FlowEntity {
    const graph: FlowGraph = { version: 1, nodes: [...nodes], edges: [] } as FlowGraph;
    return { flowId: FLOW_ID, name: 'Onboarding', enabled: true, graph } as FlowEntity;
}

beforeAll(async () => {
    await ensureBlocksDiscovered();
});

describe('grouping buttons by the channel their node names', () => {
    it('posts one message per destination, not one per flow', () => {
        const plan = planButtonDeployment(
            flow([
                buttonNode('rules', { channelId: 'channel-rules', label: 'Agree to rules' }),
                buttonNode('verify', { channelId: 'channel-verify', label: 'Start verification' }),
            ])
        );

        // The defect this change exists to close: both of these used to land in one
        // message in whichever channel the deployer was handed.
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        expect(plan.destinations.map((entry) => entry.channelId)).toEqual([
            'channel-rules',
            'channel-verify',
        ]);
        expect(plan.destinations.every((entry) => entry.buttonCount === 1)).toBe(true);
    });

    it('keeps several buttons for one channel in a single message', () => {
        const plan = planButtonDeployment(
            flow([
                buttonNode('a', { label: 'A' }),
                buttonNode('b', { label: 'B' }),
                buttonNode('c', { channelId: 'channel-verify', label: 'C' }),
            ])
        );

        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        expect(plan.destinations).toHaveLength(2);
        const rules = plan.destinations.find((entry) => entry.channelId === 'channel-rules');
        expect(rules?.nodeIds).toEqual(['a', 'b']);
    });

    it('chunks past five into further action rows rather than throwing', () => {
        // Six buttons used to throw inside `addComponents`, and the catch around the
        // send reported it as "Could not post in that channel. Check the bot's
        // permissions." — which sent an operator to look at a permission that was fine.
        const plan = planButtonDeployment(
            flow(
                Array.from({ length: 6 }, (_unused, index) =>
                    buttonNode(`node-${index}`, { label: `Button ${index}` })
                )
            )
        );

        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        expect(plan.destinations[0].rows.map((row) => row.length)).toEqual([5, 1]);
    });
});

describe('refusing a deploy the guild could not hold', () => {
    it('refuses the whole thing when a destination is declared but not installed', () => {
        // The unresolved-binding shape: an empty snowflake beside a `channelIdKey`
        // sidecar naming the declaration it is waiting on.
        const plan = planButtonDeployment(
            flow([
                buttonNode('rules', { channelId: 'channel-rules' }),
                buttonNode('verify', { channelId: '', channelIdKey: 'verify-channel' }),
            ])
        );

        expect(plan.ok).toBe(false);
        if (plan.ok) return;
        expect(plan.message).toMatch(/verify-channel/);
        expect(plan.message).toMatch(/Install this flow's resources/);
        // Does not promise that installing is the whole answer: the key may be stale
        // rather than merely uninstalled, and no number of installs resolves that.
        expect(plan.message).toMatch(/stale/);
    });

    it('names every uninstalled resource once, however many buttons point at it', () => {
        const plan = planButtonDeployment(
            flow([
                buttonNode('a', { channelId: '', channelIdKey: 'verify-channel' }),
                buttonNode('b', { channelId: '', channelIdKey: 'verify-channel' }),
                buttonNode('c', { channelId: '', channelIdKey: 'rules-channel' }),
            ])
        );

        expect(plan.ok).toBe(false);
        if (plan.ok) return;
        expect(plan.message.match(/verify-channel/g)).toHaveLength(1);
        expect(plan.message).toMatch(/rules-channel/);
    });

    it('blames the node by name when a button has no destination at all', () => {
        // No sidecar either, so nothing is on the hook for the value later — a
        // genuinely unset field, which the schema refuses.
        const plan = planButtonDeployment(flow([buttonNode('lonely', { channelId: '' })]));

        expect(plan.ok).toBe(false);
        if (plan.ok) return;
        expect(plan.message).toMatch(/lonely/);
        expect(plan.message).toMatch(/channelId/);
    });

    it('refuses a channel asked to hold more buttons than one message can carry', () => {
        const plan = planButtonDeployment(
            flow(
                Array.from({ length: MAX_BUTTONS_PER_MESSAGE + 1 }, (_unused, index) =>
                    buttonNode(`node-${index}`, { label: `Button ${index}` })
                )
            )
        );

        expect(plan.ok).toBe(false);
        if (plan.ok) return;
        expect(plan.message).toMatch(/channel-rules/);
        expect(plan.message).toMatch(new RegExp(`${MAX_BUTTONS_PER_MESSAGE + 1} buttons`));
    });

    it('still refuses a flow with no button triggers at all', () => {
        const plan = planButtonDeployment(flow([]));

        expect(plan.ok).toBe(false);
        if (plan.ok) return;
        expect(plan.message).toMatch(/no button-click triggers/);
    });
});

describe('pending resources that have nothing to do with a button', () => {
    it('does not block the deploy when another node is the one waiting', () => {
        /*
         * A role the flow has declared but not installed stops that *action* from
         * running; it does not stop a button being posted. Reading every resource
         * target in the graph and refusing on any of them would make an uninstalled
         * role anywhere on the canvas block a deploy it has no bearing on — the
         * regression risk in deriving this from the graph rather than from the
         * button nodes alone.
         */
        const graph: FlowGraph = {
            version: 1,
            nodes: [
                buttonNode('rules', { channelId: 'channel-rules' }),
                {
                    id: 'grant',
                    type: 'action.assignRole',
                    position: { x: 1, y: 0 },
                    data: { roleId: '', roleIdKey: 'member-role' },
                } as FlowNode,
            ],
            edges: [],
        } as FlowGraph;

        const plan = planButtonDeployment({
            flowId: FLOW_ID,
            name: 'Onboarding',
            enabled: true,
            graph,
        } as FlowEntity);

        expect(plan.ok).toBe(true);
    });
});

describe('a resolved binding', () => {
    it('is not treated as pending just because the sidecar survived the install', () => {
        // Install writes the snowflake and deliberately leaves `channelIdKey` behind,
        // which is what makes a deleted-and-recreated channel repairable by
        // re-installing. Reading the sidecar alone would refuse every installed flow.
        const plan = planButtonDeployment(
            flow([buttonNode('rules', { channelId: 'channel-rules', channelIdKey: 'rules-channel' })])
        );

        expect(plan.ok).toBe(true);
    });
});
