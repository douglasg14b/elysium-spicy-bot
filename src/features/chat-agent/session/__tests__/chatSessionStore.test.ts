import { describe, expect, it } from 'vitest';
import type { TracedTurn } from '../historyToModelMessages';
import { ChatSessionStore, MAX_TRACED_TURNS_PER_CHANNEL, SESSION_IDLE_TTL_MS } from '../chatSessionStore';

const reply = (text: string): TracedTurn => ({ askerId: 'vex', messages: [{ role: 'assistant', content: text }] });

describe('ChatSessionStore', () => {
    it('finds a reply by its first message and marks the rest continuations', () => {
        const store = new ChatSessionStore();
        store.recordTurn('channel', ['m1', 'm2'], reply('long answer'), 0);
        const lookup = store.traceLookup('channel', 0);
        expect(lookup('m1')).toEqual(reply('long answer'));
        expect(lookup('m2')).toBe('continuation');
        expect(lookup('m3')).toBeUndefined();
    });

    it('keeps channels apart', () => {
        const store = new ChatSessionStore();
        store.recordTurn('channel-a', ['m1'], reply('a'), 0);
        expect(store.traceLookup('channel-b', 0)('m1')).toBeUndefined();
    });

    it(`keeps only the latest ${MAX_TRACED_TURNS_PER_CHANNEL} traces per channel, continuations included`, () => {
        const store = new ChatSessionStore();
        store.recordTurn('channel', ['first', 'first-part-2'], reply('first'), 0);
        for (let turn = 1; turn <= MAX_TRACED_TURNS_PER_CHANNEL; turn++) {
            store.recordTurn('channel', [`m${turn}`], reply(`turn ${turn}`), turn);
        }
        const lookup = store.traceLookup('channel', 10);
        expect(lookup('first')).toBeUndefined();
        expect(lookup('first-part-2')).toBeUndefined();
        expect(lookup('m1')).toEqual(reply('turn 1'));
        expect(lookup(`m${MAX_TRACED_TURNS_PER_CHANNEL}`)).toBeDefined();
    });

    it('forgets a channel left idle past the TTL', () => {
        const store = new ChatSessionStore();
        store.recordTurn('channel', ['m1'], reply('a'), 0);
        expect(store.traceLookup('channel', SESSION_IDLE_TTL_MS + 1)('m1')).toBeUndefined();
    });

    it('records nothing for a reply that posted no messages', () => {
        const store = new ChatSessionStore();
        store.recordTurn('channel', [], reply('a'), 0);
        expect(store.traceLookup('channel', 0)('')).toBeUndefined();
    });
});
