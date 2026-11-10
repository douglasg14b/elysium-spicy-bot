import type { JSONValue, ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { withoutStaffOnlyResults } from '../staffOnlyTrace';

function toolTurn(toolName: string, value: JSONValue): ModelMessage {
    return { role: 'tool', content: [{ type: 'tool-result', toolCallId: `call-${toolName}`, toolName, output: { type: 'json', value } }] };
}

describe('withoutStaffOnlyResults', () => {
    it('keeps a staff-only result as a note, and where a read reached, but nothing that was read', () => {
        const kept = withoutStaffOnlyResults([
            toolTurn('readChannelMessages', { found: true, channel: '#ticket-0057-river', messages: [{ text: 'Damon DMed me' }], continueBefore: '500000000000000101' }),
            toolTurn('findTickets', { found: true, tickets: [{ number: 57, reason: 'Unwanted DMs' }] }),
            toolTurn('getBotFeature', { answered: true, setupHere: { botRules: 'secret' } }),
            { role: 'assistant', content: 'Ticket 57: Damon, final warning.' },
        ]);

        expect(JSON.stringify(kept)).not.toMatch(/Damon DMed|Unwanted DMs|secret/);
        expect(kept[0]).toMatchObject({
            content: [{ output: { value: { channel: '#ticket-0057-river', continueBefore: '500000000000000101' } } }],
        });
        expect(kept[3]).toEqual({ role: 'assistant', content: 'Ticket 57: Damon, final warning.' });
    });

    it('leaves every other tool result as it was', () => {
        const rules = toolTurn('getServerRules', { found: true, sources: [] });
        expect(withoutStaffOnlyResults([rules])).toEqual([rules]);
    });
});
