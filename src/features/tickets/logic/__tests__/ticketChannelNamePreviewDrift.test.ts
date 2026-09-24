import { describe, expect, it } from 'vitest';
import {
    ensureBlocksDiscovered,
    listBlockDefinitions,
} from '../../../flows/blocks/registry';
import { DEFAULT_TICKET_TYPES } from '../../data/defaultTicketTypes';
import { buildTicketChannelName } from '../ticketTypes';
import {
    TICKET_TYPE_NAME_TEMPLATES,
    buildMirroredChannelName,
    isPreviewableTicketType,
    previewTicketChannelName,
} from '../../../../../web/src/flows/ticketChannelName';

/**
 * The drift gate between real ticket channel naming and the builder's preview of it.
 *
 * The flow builder shows an author what channel an Open Ticket block will create,
 * from a mirror of the type templates in `web/src/flows/ticketChannelName.ts`. The
 * browser cannot import this module — `ticketTypes.ts` reaches `discord.js` — so
 * the mirror is hand-written and this is what stops it rotting.
 *
 * The load-bearing assertion is the last one: it runs *both* implementations and
 * compares their output. Comparing the template strings alone would miss the half
 * of the naming that is not in the template — the sanitizer's character class, the
 * lowercasing, the separator collapse and the trailing-dash strip. A preview that
 * got those wrong would be a confident preview of a name Discord never assigns,
 * which is worse than the confusion the preview was built to end.
 *
 * **What this gate can and cannot reach**, since ticket types became guild data:
 * it holds the mirror to `DEFAULT_TICKET_TYPES` — the migration's *seed* — because
 * that is the only part of the type record living in source on both sides. A guild
 * whose operator edited a template is beyond any source-level gate; the preview's
 * own doc comment says so, and the flow-builder type picker is what will fix it. The
 * substitution logic, which is the part that actually produced wrong names, is gated
 * in full: the template is an input here, so these cases drive templates no guild is
 * seeded with.
 */

/** The seeded type keys, which the browser mirror claims to know. */
const SEEDED_TYPES = Object.keys(DEFAULT_TICKET_TYPES) as readonly string[];

const REMEDY =
    'Reconcile `web/src/flows/ticketChannelName.ts` with `buildTicketChannelName` in ' +
    '`src/features/tickets/logic/ticketTypes.ts` and the seed in ' +
    '`src/features/tickets/data/defaultTicketTypes.ts`.';

/**
 * The real builder over a bare template, matching the mirror's signature.
 *
 * The server takes a whole `TicketTypeDefinition` because production always has one;
 * only `nameTemplate` is read. Wrapping it here lets a case state the template it is
 * testing inline rather than constructing a permission model it does not care about.
 */
function realChannelName(template: string, subjectName: string): string {
    return buildTicketChannelName(
        { ...DEFAULT_TICKET_TYPES.support, nameTemplate: template },
        { ticketNumber: 42, subjectName, openerName: null }
    );
}

describe('which blocks claim to create a channel they do not name', () => {
    /**
     * The claim is only useful if it matches what the blocks actually do.
     *
     * Checked against `manageChannels` rather than a hardcoded list of block types:
     * creating a Discord channel needs that permission, so the declaration and the
     * capability have to agree. A block claiming it without the permission would
     * have the builder preview a channel that the bot then fails to create.
     */
    it('is claimed only by blocks that can actually create one', async () => {
        await ensureBlocksDiscovered();
        const definitions = listBlockDefinitions();
        expect(definitions.length).toBeGreaterThan(0);

        const unbacked = definitions
            .filter(
                (definition) =>
                    definition.createsChannel &&
                    !definition.capabilities.includes('manageChannels')
            )
            .map((definition) => definition.type);

        expect(
            unbacked,
            `These blocks declare createsChannel without asking for ` +
                'manageChannels: they either do not really create a channel — in which case ' +
                'the builder is previewing one nobody will see — or their capabilities are ' +
                'wrong and the bot will fail at runtime.'
        ).toEqual([]);
    });

    /**
     * The regression that put this member here in the first place.
     *
     * The preview originally recognised a ticket-opening node by the presence of a
     * `ticketType` config field. `condition.hasOpenTicket` declares one too and
     * creates nothing, so the builder told an author that a read-only condition
     * would create `#S0042-someone`. A field name is not a side effect.
     */
    it('is not claimed by a block that only reads tickets', async () => {
        await ensureBlocksDiscovered();

        const misclaiming = listBlockDefinitions()
            .filter(
                (definition) =>
                    definition.configFields.some((field) => field.key === 'ticketType') &&
                    !definition.capabilities.includes('manageChannels') &&
                    definition.createsChannel
            )
            .map((definition) => definition.type);

        expect(
            misclaiming,
            'A block with a `ticketType` field that cannot manage channels reads tickets ' +
                'rather than opening them. Claiming otherwise makes the builder promise a ' +
                'channel it will never create.'
        ).toEqual([]);
    });
});

describe('ticket channel name preview drift', () => {
    it('mirrors every ticket type the server seeds', () => {
        const server = [...SEEDED_TYPES].sort();
        const browser = Object.keys(TICKET_TYPE_NAME_TEMPLATES).sort();

        expect(
            browser,
            `The previewable ticket types have drifted. Server seed: [${server.join(', ')}]; ` +
                `browser: [${browser.join(', ')}]. A type the browser does not know renders no ` +
                `preview at all on a block configured to open it. ${REMEDY}`
        ).toEqual(server);
    });

    it.each(SEEDED_TYPES)('mirrors the %s template verbatim', (type) => {
        expect(isPreviewableTicketType(type)).toBe(true);
        if (!isPreviewableTicketType(type)) return;

        expect(
            TICKET_TYPE_NAME_TEMPLATES[type],
            `The \`${type}\` channel-name template has drifted from the seed. ${REMEDY}`
        ).toBe(DEFAULT_TICKET_TYPES[type]?.nameTemplate);
    });

    it.each(SEEDED_TYPES)('previews the %s name the builder really produces', (type) => {
        expect(isPreviewableTicketType(type)).toBe(true);
        if (!isPreviewableTicketType(type)) return;

        const definition = DEFAULT_TICKET_TYPES[type];
        expect(definition).toBeDefined();
        if (!definition) return;

        // The same inputs the preview assumes: a flow-opened ticket has no opener,
        // and the preview's stand-in number and subject are what it substitutes.
        const real = buildTicketChannelName(definition, {
            ticketNumber: 42,
            subjectName: 'someone',
            openerName: null,
        });

        expect(
            previewTicketChannelName(type),
            `The \`${type}\` preview disagrees with the name a ticket would actually get. ` +
                'This gates the sanitizer and the separator collapse, not just the template ' +
                `string. ${REMEDY}`
        ).toBe(real);
    });

    /**
     * A repeated token, which only became reachable when templates became editable.
     *
     * The server moved to `replaceAll` for exactly this: a string needle replaces the
     * first occurrence only, so the second `{{subject}}` survived into the channel
     * name and Discord stripped its braces, silently yielding `…-subject`. Neither
     * seeded template repeats a token, so nothing above this case would notice the
     * mirror still using `replace` — and the mirror *did*, until this merge.
     *
     * Driven through both implementations rather than pinned to a literal alone, so
     * it gates the pair rather than one side's idea of the answer.
     */
    it.each([
        // The template's own characters are *not* lowercased — only the sanitized
        // subject is — so the leading `S` survives. Worth pinning: the sanitizer
        // lowercases, and the obvious wrong expectation is that the whole name does.
        ['S{{####}}-{{subject}}-{{subject}}', 'S0042-alice-alice'],
        ['{{####}}-{{####}}-{{subject}}', '0042-0042-alice'],
        // Two openers, both empty for a flow-opened ticket: gates that the collapse
        // runs after every substitution rather than after the first.
        ['T{{####}}-{{opener}}-{{subject}}-{{opener}}', 'T0042-alice'],
    ])('substitutes every occurrence in %s, as the server does', (template, expected) => {
        const real = realChannelName(template, 'alice');

        expect(
            buildMirroredChannelName(template, 'alice'),
            `The preview disagrees with the server on the repeated-token template ` +
                `"${template}". An operator may write one — templates are free text — and a ` +
                `mirror using \`replace\` renders the second token literally. ${REMEDY}`
        ).toBe(real);

        expect(real, `The real builder's output changed. ${REMEDY}`).toBe(expected);
    });

    /**
     * The preview's own stand-in subject, driven through the real builder.
     *
     * Not an arbitrary fixture: the gate is only as strong as the input it uses,
     * and the assertions above run the preview on `'someone'` — already lowercase
     * and pure ASCII, so they would pass a mirror that had dropped the lowercasing
     * or the character strip entirely. (It shipped that way for one commit and a
     * sabotage check caught it.) These cases exercise the parts of the sanitizer
     * the stand-in cannot reach.
     */
    it.each([
        // Mixed case: gates the `.toLowerCase()` the stand-in cannot exercise.
        ['MixedCase', 'S0042-mixedcase'],
        // Spaces and punctuation are stripped, not replaced with separators.
        ['Two Words!', 'S0042-twowords'],
        // Non-ASCII is stripped, not transliterated — a preview that quietly
        // transliterated would promise a channel name Discord never creates. Note
        // the ASCII letters *around* the stripped characters survive, so the
        // result is legible-looking nonsense rather than an obviously empty name.
        ['Ünïcødé Näme', 'S0042-ncdnme'],
        // A subject sanitizing to nothing leaves no dangling separator.
        ['✨✨', 'S0042'],
    ])('sanitizes %s the same way the real builder does', (subjectName, expected) => {
        const supportTemplate = TICKET_TYPE_NAME_TEMPLATES.support;
        const real = realChannelName(supportTemplate, subjectName);

        expect(
            buildMirroredChannelName(supportTemplate, subjectName),
            `The preview's sanitizer disagrees with the server's on "${subjectName}". ${REMEDY}`
        ).toBe(real);

        // Pinned literally as well as compared, so a change to *both* sides at
        // once still has to be deliberate rather than merely self-consistent.
        expect(real, `The real builder's output changed. ${REMEDY}`).toBe(expected);
    });
});
