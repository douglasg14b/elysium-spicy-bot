import { describe, expect, it } from 'vitest';
import { normaliseResourceName as browserNormalise } from '../../../../../web/src/flows/resourceName';
import { resourceSchema } from '../../../../web/api/journeyRoutes';
import { RESOURCE_KINDS } from '../resourceDeclaration';
import { normaliseResourceName } from '../resourceName';

/**
 * The drift gate between the server's resource-name rule and the browser's copy of it.
 *
 * The panel normalises as the operator types and the save route normalises again. If
 * the two rules differ, the panel shows one name and the server stores another — the
 * operator saves `welcome-mat` and reads back something else, with no error anywhere.
 *
 * Inputs are chosen so a mirror that dropped either rewrite still fails: an already
 * normalised name like `welcome` would agree with a mirror that did nothing at all.
 */
const INPUTS = [
    'Welcome Mat',
    'welcome',
    'STAFF\tCHAT',
    'a  b',
    ' leading and trailing ',
    'Café Crème',
    'rules!',
    '',
] as const;

const REMEDY =
    'Reconcile `web/src/flows/resourceName.ts` with `normaliseResourceName` in ' +
    '`src/features/provisioning/logic/resourceName.ts`.';

describe('resource name mirror drift', () => {
    it.each(RESOURCE_KINDS)('the browser normalises a %s exactly as the server does', (kind) => {
        for (const name of INPUTS) {
            expect(browserNormalise(kind, name), `${kind} "${name}". ${REMEDY}`).toBe(
                normaliseResourceName(kind, name)
            );
        }
    });
});

describe('normaliseResourceName', () => {
    it('lowercases a text channel and turns each whitespace character into a hyphen', () => {
        expect(normaliseResourceName('textChannel', 'Welcome Mat')).toBe('welcome-mat');
        expect(normaliseResourceName('textChannel', 'STAFF\tCHAT')).toBe('staff-chat');
        // Per character, matching the panel keystroke by keystroke.
        expect(normaliseResourceName('textChannel', 'a  b')).toBe('a--b');
    });

    it('leaves punctuation alone, since what Discord strips is not modelled', () => {
        expect(normaliseResourceName('textChannel', 'Rules!')).toBe('rules!');
    });

    it('is idempotent, so normalising on save after normalising as typed changes nothing', () => {
        for (const name of INPUTS) {
            const once = normaliseResourceName('textChannel', name);
            expect(normaliseResourceName('textChannel', once)).toBe(once);
        }
    });

    it.each(['category', 'role'] as const)('leaves a %s exactly as written', (kind) => {
        expect(normaliseResourceName(kind, 'Front Desk')).toBe('Front Desk');
    });
});

/*
 * The browser is a client, not the authority: a declaration saved by anything other
 * than the panel — or by a panel older than this rule — must still be stored as the
 * name Discord will hold.
 */
describe('the save route', () => {
    it('stores a text channel under the name Discord will hold, rather than refusing it', () => {
        const parsed = resourceSchema.parse({
            key: 'welcome-channel',
            kind: 'textChannel',
            defaultName: 'Welcome Mat',
        });

        expect(parsed.defaultName).toBe('welcome-mat');
    });

    it('stores a category exactly as written', () => {
        const parsed = resourceSchema.parse({ key: 'front-desk', kind: 'category', defaultName: 'Front Desk' });

        expect(parsed.defaultName).toBe('Front Desk');
    });
});
