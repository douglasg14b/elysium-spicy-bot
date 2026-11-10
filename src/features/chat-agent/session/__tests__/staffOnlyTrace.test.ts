import type { JSONValue, ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { usesStaffOnlyTools } from '../staffOnlyTrace';
import { withoutResult } from '../traceNotes';

function call(toolName: string): ModelMessage {
    return { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `call-${toolName}`, toolName, input: {} }] };
}

describe('usesStaffOnlyTools', () => {
    it('finds a staff-only call anywhere in a trace, and nothing in one without', () => {
        expect(usesStaffOnlyTools([call('getServerRules'), call('readChannelMessages'), { role: 'assistant', content: 'done' }])).toBe(true);
        expect(usesStaffOnlyTools([call('getServerRules'), { role: 'assistant', content: 'done' }])).toBe(false);
    });
});

describe('withoutResult', () => {
    it('keeps a result as a note, and where a read reached, but nothing that was read', () => {
        const value: JSONValue = { found: true, channel: '#ticket-0057-river', messages: [{ text: 'Damon DMed me' }], continueBefore: '500000000000000101' };
        const noted = withoutResult({ type: 'tool-result', toolCallId: 'call-1', toolName: 'readChannelMessages', output: { type: 'json', value } });

        expect(noted.output).toEqual({
            type: 'json',
            value: { note: 'Not kept: call readChannelMessages again if you need it.', channel: '#ticket-0057-river', continueBefore: '500000000000000101' },
        });
    });
});
