import { describe, expect, it } from 'vitest';
import { FLOW_MAX_NODE_VISITS, FLOW_MAX_RETRY_ATTEMPTS } from '../../constants';
import {
    FLOW_RUN_EVENTS,
    FLOW_RUN_STATUSES,
    FLOW_RUN_TRANSITIONS,
    IllegalFlowRunTransitionError,
    isLegalRunTransition,
    nextRunStatus,
    type FlowRunEvent,
    type FlowRunStatus,
} from '../flowRunLifecycle';
import { FLOW_STEP_OUTCOME_KINDS } from '../../engine/stepOutcome';

/**
 * The interpreter's two state machines, driven exhaustively.
 *
 * Deliberately free of a Discord client and of a database: these are the only two
 * machines the flow engine owns, and their correctness must be provable without
 * either. If a change here needs a mock, the machine has grown a dependency it
 * should not have.
 *
 * The expectations below are written out by hand rather than derived from
 * `FLOW_RUN_TRANSITIONS`. Deriving them would make this file agree with the
 * implementation by construction and prove nothing — the point is that widening
 * either machine cannot happen without someone editing this list on purpose.
 */
const LEGAL_EVENTS_BY_STATUS: Record<FlowRunStatus, readonly FlowRunEvent[]> = {
    suspended: ['claim', 'cancel'],
    running: ['park', 'release', 'reclaim', 'complete', 'fail', 'cancel'],
    completed: [],
    failed: [],
    cancelled: [],
};

const EXPECTED_TARGET: Record<FlowRunEvent, FlowRunStatus> = {
    claim: 'running',
    park: 'suspended',
    release: 'suspended',
    reclaim: 'suspended',
    complete: 'completed',
    fail: 'failed',
    cancel: 'cancelled',
};

describe('the frozen member sets', () => {
    it('pins the run statuses', () => {
        expect([...FLOW_RUN_STATUSES]).toEqual(['suspended', 'running', 'completed', 'failed', 'cancelled']);
    });

    it('pins the step outcomes, with no deliberate-termination member', () => {
        expect([...FLOW_STEP_OUTCOME_KINDS]).toEqual(['continue', 'suspend', 'fail']);
    });

    it('pins the lifecycle events', () => {
        expect([...FLOW_RUN_EVENTS]).toEqual([
            'claim',
            'park',
            'release',
            'reclaim',
            'complete',
            'fail',
            'cancel',
        ]);
    });

    it('keeps the three ways a claim is given back distinguishable but identical', () => {
        // `park`, `release` and `reclaim` are different things happening, so a log
        // can tell them apart — but they must land a run in the same place.
        for (const event of ['park', 'release', 'reclaim'] as const) {
            expect(nextRunStatus('running', event)).toBe('suspended');
        }
    });

    it('keeps the retry budget separate from the visit budget', () => {
        // Sharing them would let a flaky Discord call spend the visits a
        // legitimate authored loop needs.
        expect(FLOW_MAX_RETRY_ATTEMPTS).not.toBe(FLOW_MAX_NODE_VISITS);
        expect(FLOW_MAX_RETRY_ATTEMPTS).toBeGreaterThan(0);
    });
});

describe('the run lifecycle transition table', () => {
    for (const status of FLOW_RUN_STATUSES) {
        for (const event of FLOW_RUN_EVENTS) {
            const shouldBeLegal = LEGAL_EVENTS_BY_STATUS[status].includes(event);

            if (shouldBeLegal) {
                it(`allows ${event} on a ${status} run, landing on ${EXPECTED_TARGET[event]}`, () => {
                    expect(isLegalRunTransition(status, event)).toBe(true);
                    expect(nextRunStatus(status, event)).toBe(EXPECTED_TARGET[event]);
                });
            } else {
                it(`rejects ${event} on a ${status} run`, () => {
                    expect(isLegalRunTransition(status, event)).toBe(false);
                    // Raising, not returning the current status: a lifecycle that
                    // silently no-ops is how a run ends up somewhere nobody can
                    // explain.
                    expect(() => nextRunStatus(status, event)).toThrow(IllegalFlowRunTransitionError);
                });
            }
        }
    }

    it('names both the status and the event when it refuses', () => {
        expect(() => nextRunStatus('completed', 'claim')).toThrow(/cannot claim a run that is completed/i);
        expect(() => nextRunStatus('completed', 'claim')).toThrow(/legal from: suspended/i);
    });

    it('treats every terminal status as a dead end', () => {
        for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
            for (const event of FLOW_RUN_EVENTS) {
                expect(isLegalRunTransition(terminal, event)).toBe(false);
            }
        }
    });

    it('lands every event on a declared status', () => {
        for (const event of FLOW_RUN_EVENTS) {
            expect(FLOW_RUN_STATUSES).toContain(FLOW_RUN_TRANSITIONS[event].to);
            for (const source of FLOW_RUN_TRANSITIONS[event].from) {
                expect(FLOW_RUN_STATUSES).toContain(source);
            }
        }
    });

    it('can be driven from a parked run to each terminal status', () => {
        // The three ways a run actually ends, walked end to end.
        expect(nextRunStatus(nextRunStatus('suspended', 'claim'), 'complete')).toBe('completed');
        expect(nextRunStatus(nextRunStatus('suspended', 'claim'), 'fail')).toBe('failed');
        expect(nextRunStatus('suspended', 'cancel')).toBe('cancelled');
    });

    it('round-trips a run through park and claim without leaving the machine', () => {
        // A flow that parks repeatedly — a delay inside a loop — must cycle
        // forever without needing a state the table does not have.
        let status: FlowRunStatus = 'suspended';
        for (let cycle = 0; cycle < 3; cycle += 1) {
            status = nextRunStatus(status, 'claim');
            expect(status).toBe('running');
            status = nextRunStatus(status, 'park');
            expect(status).toBe('suspended');
        }
    });
});
