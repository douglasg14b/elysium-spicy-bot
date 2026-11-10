import type { ModelMessage } from 'ai';
import { ChannelType, type GuildMember } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { SessionTurn } from '../../data/chatSessionsRepo';
import type { Viewers } from '../../tools/visibleChannels';
import type { HistoryMessage } from '../historyToModelMessages';
import { sessionMemory, type ReplayContext } from '../sessionReplay';

const STAFF_ROLE = 'staff-role';
const MODEL = 'mistralai/mistral-large-4-0';

/** Who sees each channel, by member id: changed by a test to take access away. */
const seenBy: Record<string, string[]> = {};

function fakeChannel(id: string) {
    return { id, name: id, type: ChannelType.GuildText, isThread: () => false, parent: null, position: 0, permissionsFor: (who: { id: string }) => ({ has: () => seenBy[id]?.includes(who.id) ?? false }) };
}

const guild = {
    ownerId: 'owner',
    memberCount: 0,
    members: { cache: { size: 0 } },
    channels: { cache: new Map([['general', fakeChannel('general')], ['mods', fakeChannel('mods')]]) },
};

function member(id: string, staff = true): GuildMember {
    return { id, guild, permissions: { has: () => false }, roles: { cache: new Map(staff ? [[STAFF_ROLE, { id: STAFF_ROLE }]] : []) } } as unknown as GuildMember;
}

const KAT = member('kat');
const VEX = member('vex');
const RIVER = member('river', false);

function lookup(toolName: string): readonly ModelMessage[] {
    return [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName, input: {} }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName, output: { type: 'json', value: { found: true, text: 'Damon DMed me' } } }] },
        { role: 'assistant', content: 'River reported Damon.' },
    ];
}

const TICKET_READ = lookup('readChannelMessages');
const RULES_READ = lookup('getServerRules');

/** A turn asked as `questionId`, posted as `postIds`; ids are snowflake-ordered numbers, the window starting at 500. */
function turn(questionId: string, postIds: string[], overrides: Partial<SessionTurn> = {}): SessionTurn {
    return {
        askerId: 'kat',
        questionId,
        question: '[2026-11-09 11:00] Kat: ticket 57?',
        answer: 'River reported Damon.',
        messages: TICKET_READ,
        model: MODEL,
        readerIds: ['kat', 'vex'],
        visibleChannelIds: ['general', 'mods'],
        postIds,
        createdAt: new Date(),
        ...overrides,
    };
}

function inHistory(...ids: string[]): HistoryMessage[] {
    return ids.map((id) => ({ id, authorName: 'x', isFromThisBot: true, isFromOtherBot: false, content: '', createdAt: new Date(), replyToAuthorName: undefined, isBeingAnswered: false }));
}

function context(viewers: Viewers, overrides: Partial<ReplayContext> = {}): ReplayContext {
    return { viewers, staffRoleIds: [STAFF_ROLE], viewersCanReadHistory: true, modelId: MODEL, ...overrides };
}

function everyoneSees() {
    seenBy.general = ['kat', 'vex', 'river'];
    seenBy.mods = ['kat', 'vex'];
}

describe('sessionMemory', () => {
    it('splices a turn whose posts are in the window — for whoever asks — and puts older ones first, as question and trace', () => {
        everyoneSees();
        const memory = sessionMemory([turn('100', ['101']), turn('600', ['601', '602'])], inHistory('500', '600', '601', '602'), context([VEX, KAT]));

        expect(memory.earlier).toEqual([{ question: '[2026-11-09 11:00] Kat: ticket 57?', answer: 'River reported Damon.', trace: TICKET_READ }]);
        expect(memory.postFor('601')).toEqual({ kind: 'traced', trace: TICKET_READ, question: '[2026-11-09 11:00] Kat: ticket 57?', questionId: '600' });
        expect(memory.postFor('602')).toEqual({ kind: 'continuation', of: '601' });
    });

    it("shows no trace once someone reads the channel who didn't then — only what was posted", () => {
        everyoneSees();
        const memory = sessionMemory([turn('100', ['101'], { readerIds: ['kat'] })], inHistory('500'), context([KAT, VEX]));
        expect(memory.earlier).toEqual([expect.objectContaining({ trace: undefined, answer: 'River reported Damon.' })]);
    });

    it('still shows it when readers have only left since', () => {
        everyoneSees();
        const memory = sessionMemory([turn('100', ['101'])], inHistory('500'), context([KAT]));
        expect(memory.earlier[0]?.trace).toBe(TICKET_READ);
    });

    it('shows no trace once a reader has lost a channel they could all see then', () => {
        everyoneSees();
        seenBy.mods = ['kat'];
        const memory = sessionMemory([turn('100', ['101'], { messages: RULES_READ })], inHistory('500'), context([KAT, VEX]));
        expect(memory.earlier[0]?.trace).toBeUndefined();
    });

    it("drops a turn that asked a staff-only tool, whole, once not every reader is staff — and keeps any other turn's", () => {
        everyoneSees();
        const demoted = member('vex', false);
        const memory = sessionMemory([turn('100', ['101']), turn('102', ['103'], { messages: RULES_READ })], inHistory('500'), context([KAT, demoted]));
        expect(memory.earlier.map((earlier) => earlier.trace)).toEqual([undefined, RULES_READ]);
    });

    it('shows a trace only to the model that wrote it', () => {
        everyoneSees();
        const memory = sessionMemory([turn('100', ['101'])], inHistory('500'), context([KAT], { modelId: 'someone/else' }));
        expect(memory.earlier[0]?.trace).toBeUndefined();
    });

    it('shows nothing of a turn whose post or question was deleted from inside the window', () => {
        everyoneSees();
        const memory = sessionMemory([turn('600', ['601']), turn('100', ['700'])], inHistory('500', '601', '800'), context([KAT]));
        expect(memory.earlier).toEqual([]);
        expect(memory.postFor('601')).toBeUndefined();
    });

    it("shows none of the session where not every reader can read the channel's history", () => {
        everyoneSees();
        const memory = sessionMemory([turn('100', ['101'], { readerIds: ['kat', 'river'] })], inHistory('500'), context([KAT, RIVER], { viewersCanReadHistory: false }));
        expect(memory.earlier).toEqual([]);
    });

    it('shows a turn whose messages could not be read as its text alone', () => {
        everyoneSees();
        const memory = sessionMemory([turn('100', ['101'], { messages: undefined })], inHistory('500'), context([KAT]));
        expect(memory.earlier).toEqual([expect.objectContaining({ trace: undefined })]);
    });
});
