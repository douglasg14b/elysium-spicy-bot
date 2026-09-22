import { describe, expect, it } from 'vitest';
import { optionalParticipantLabel, participantLabel } from '../participantLabel';

/**
 * How the identity snapshots render.
 *
 * Three states, and the third is the one that matters: a row written before the snapshot
 * columns existed has no names at all, and the dashboard has to say *something* that is
 * not a lie about who that was.
 */

describe('participantLabel', () => {
    it('renders Kitten (@someuser) when both names are present', () => {
        expect(participantLabel({ id: '1', username: 'someuser', nickname: 'Kitten' })).toBe(
            'Kitten (@someuser)'
        );
    });

    it('renders the username alone when the nickname is null', () => {
        // No nickname set, or they have left the guild. Either way the handle is all
        // there is and padding it out would invent information.
        expect(participantLabel({ id: '1', username: 'someuser', nickname: null })).toBe('someuser');
    });

    it('renders the raw id when both names are null', () => {
        // A pre-snapshot row. Null means "not recorded", not "has no name", so inventing
        // `Unknown User` would put a string here no consumer could tell from somebody's
        // actual username.
        expect(participantLabel({ id: '123456789', username: null, nickname: null })).toBe('123456789');
    });

    it('keeps the pair when the nickname equals the username', () => {
        // The snapshot stores `member.nickname`, not `displayName`, precisely so "no
        // nickname" and "nickname matching the handle" stay different facts. Somebody who
        // set their nickname to their handle did that on purpose.
        expect(participantLabel({ id: '1', username: 'someuser', nickname: 'someuser' })).toBe(
            'someuser (@someuser)'
        );
    });

    it('falls back to the id when a nickname was recorded but no username', () => {
        // Not reachable through `resolveTicketIdentity`, whose username is non-nullable —
        // but the columns are independently nullable, so a hand-written row can be in
        // this state and the label must not render "Kitten (@null)".
        expect(participantLabel({ id: '99', username: null, nickname: 'Kitten' })).toBe('99');
    });
});

describe('optionalParticipantLabel', () => {
    it('says what absence means rather than rendering a dash', () => {
        // A flow-opened ticket genuinely has no human opener.
        expect(optionalParticipantLabel(null, 'Automated')).toBe('Automated');
        expect(optionalParticipantLabel(null, 'Unclaimed')).toBe('Unclaimed');
    });

    it('renders the person when there is one', () => {
        expect(optionalParticipantLabel({ id: '1', username: 'mod', nickname: null }, 'Unclaimed')).toBe(
            'mod'
        );
    });
});
