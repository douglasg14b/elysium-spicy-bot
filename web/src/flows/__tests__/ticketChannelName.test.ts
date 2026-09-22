/**
 * The channel name the builder promises, and when it declines to promise one.
 *
 * The drift gate in `src/features/tickets/logic/__tests__/` proves this agrees
 * with the real builder. What is left to prove here is the shape an author sees
 * and, more importantly, the cases where nothing should be shown at all.
 */

import { describe, expect, it } from 'vitest';
import {
    isPreviewableTicketType,
    previewTicketChannelName,
    ticketChannelNameFor,
} from '../ticketChannelName';

describe('previewTicketChannelName', () => {
    it('shows a support channel with no dangling separator where the opener would be', () => {
        // A flow-opened ticket has no opener, so `{{opener}}` is always empty here
        // and the collapse is the normal path rather than an edge case.
        expect(previewTicketChannelName('support')).toBe('S0042-someone');
    });

    it('shows a verification channel', () => {
        expect(previewTicketChannelName('verification')).toBe('V0042-someone');
    });

    it('keeps the template prefix uppercase, as the real name does', () => {
        // Counterintuitive and worth pinning: the sanitizer lowercases the
        // *subject*, not the template, so the prefix survives as written. This
        // previews the name the bot asks Discord for, which is exactly what the
        // drift gate compares against.
        expect(previewTicketChannelName('support').startsWith('S')).toBe(true);
    });

    it('never leaves a doubled or trailing dash', () => {
        for (const type of ['support', 'verification'] as const) {
            const name = previewTicketChannelName(type);
            expect(name).not.toMatch(/--/);
            expect(name).not.toMatch(/-$/);
        }
    });
});

describe('isPreviewableTicketType', () => {
    it('accepts the types this build knows', () => {
        expect(isPreviewableTicketType('support')).toBe(true);
        expect(isPreviewableTicketType('verification')).toBe(true);
    });

    it('rejects anything else, including a type added after this bundle shipped', () => {
        expect(isPreviewableTicketType('escalation')).toBe(false);
        expect(isPreviewableTicketType(undefined)).toBe(false);
        expect(isPreviewableTicketType('')).toBe(false);
        expect(isPreviewableTicketType(42)).toBe(false);
    });

    it('does not accept an inherited property name as a ticket type', () => {
        expect(isPreviewableTicketType('toString')).toBe(false);
        expect(isPreviewableTicketType('constructor')).toBe(false);
    });
});

describe('the channel a node will create', () => {
    const opensTickets = { createsChannel: true } as const;
    const createsNothing = {} as const;

    it('names one for a block that declares it creates a ticket channel', () => {
        expect(ticketChannelNameFor(opensTickets, { ticketType: 'support', title: 'Hi' })).toBe(
            'S0042-someone'
        );
    });

    it('names none for a block that creates no channel but has a ticketType field', () => {
        // The regression this member exists for. `condition.hasOpenTicket` declares
        // a `ticketType` field and creates nothing — an earlier draft keyed on the
        // field name and told an author that a read-only condition would create a
        // channel. A field name is not a capability.
        expect(
            ticketChannelNameFor(createsNothing, { ticketType: 'support' })
        ).toBeUndefined();
    });

    it('names none for a block with no ticket fields at all', () => {
        // Every other block in the catalogue, which is the case that must stay
        // silent — the inspector renders this for every node it draws.
        expect(ticketChannelNameFor(createsNothing, { message: 'Welcome!' })).toBeUndefined();
    });

    it('names none before the author has picked a type', () => {
        expect(ticketChannelNameFor(opensTickets, { title: 'Hi' })).toBeUndefined();
    });

    it('names none for a type this build does not know', () => {
        // Degrades to silence rather than throwing: there is no error boundary
        // above the inspector, so a saved graph from a newer server must still open.
        expect(ticketChannelNameFor(opensTickets, { ticketType: 'escalation' })).toBeUndefined();
    });
});
