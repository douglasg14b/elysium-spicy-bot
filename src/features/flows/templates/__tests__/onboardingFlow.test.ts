import { beforeAll, describe, expect, it } from 'vitest';
import { messageResourceProblems } from '../../../provisioning/logic/messageResourceProblems';
import { validateJourneyDeclaration } from '../../../provisioning/logic/resourceDeclaration';
import { ensureBlocksDiscovered } from '../../blocks/registry';
import { flowReadinessIssues } from '../../logic/flowReadiness';
import { NEW_FLOW_SCOPE } from '../../logic/readinessScope';
import { buildOnboardingFlowGraph } from '../onboardingFlow';

const INPUT = { memberRoleId: 'role-1', channelId: '111111111111111111', welcomeMessage: 'Welcome in.' };

beforeAll(async () => {
    await ensureBlocksDiscovered();
});

/**
 * The seed switches the flow on after asking readiness, so the template has to be ready
 * against the journey it ships with — and that journey has to be one the repo and the
 * resources save would store.
 */
describe('the onboarding template', () => {
    it('is ready against the journey it declares', () => {
        const { graph, resources } = buildOnboardingFlowGraph(INPUT);

        expect(flowReadinessIssues(graph, { ...NEW_FLOW_SCOPE, declarations: resources })).toEqual([]);
    });

    it('is not ready without it: its trigger names the rules panel', () => {
        const { graph, nodeIds } = buildOnboardingFlowGraph(INPUT);

        expect(flowReadinessIssues(graph, NEW_FLOW_SCOPE)).toEqual([
            { nodeId: nodeIds.trigger, field: 'button', message: expect.stringMatching(/no message "rules-panel"/) },
        ]);
    });

    it('declares a journey the repo would store, whose panel Discord would take', () => {
        const { resources } = buildOnboardingFlowGraph(INPUT);

        expect(() => validateJourneyDeclaration({ journeyKey: 'onboarding', name: 'Onboarding', resources })).not.toThrow();
        for (const resource of resources) {
            expect(messageResourceProblems(resource)).toEqual([]);
        }
    });
});
