import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESOURCE_CHIPS, RESOURCE_CHIP_IDS, RESOURCE_CHIP_ORDER } from '../resourceChips';
import type { ResourceChipTone } from '../resourceChips';

/**
 * The table and the contract doc cannot drift.
 *
 * `docs/contracts/resource-chips.md` is where someone decides whether a chip should
 * exist, and the rejection list in it is the reasoning that stops the same five
 * rejected chips being re-proposed every time the modal is touched. A doc that has
 * silently fallen behind the code is worse than no doc: it is confidently wrong about
 * the thing it is consulted for.
 *
 * Checked in **both** directions, because the two failures are different mistakes. A
 * chip in the code and not the doc is an undocumented chip; a chip in the doc and not
 * the code is a promise to a reader that nothing keeps.
 *
 * Deliberately not checked: that the labels, tones and descriptions match word for
 * word. The doc's `Appears when` column is prose written for a reader and the table's
 * `reason` is one sentence for a tooltip; holding them literally equal would force the
 * doc to be written in code comments, and the value of the doc is that it is not.
 */

const DOC_PATH = fileURLToPath(new URL('../../../../docs/contracts/resource-chips.md', import.meta.url));

const doc = readFileSync(DOC_PATH, 'utf8');

/**
 * Chip ids named in the **vocabulary table's** first column.
 *
 * Scoped to the section rather than swept from the whole file, and the first draft of
 * this test proved why by failing: the rejection table's `Inherits` row has the same
 * `| \`word\` |` shape as a real vocabulary row, and the other four rejected
 * candidates escaped only because their names happen to contain spaces. A parser that
 * counts rejected chips as declared ones would report drift that is not there — and,
 * worse, would go quiet if a rejected name were ever tightened to one word.
 *
 * So: read from the `## The vocabulary` heading to the next `##`, and no further.
 *
 * Scanned line by line rather than by slicing the file on `'\n## …\n'`, because this
 * repository is worked on Windows and the checked-out Markdown has **CRLF** endings —
 * a substring search containing a bare `\n` finds nothing, and the first version of
 * this test duly passed alone and failed in the full suite depending on which form the
 * file happened to be in. Splitting on `\r?\n` makes the question not arise.
 */
const VOCABULARY_HEADING = '## The vocabulary';

function chipIdsInDocTable(markdown: string): string[] {
    const lines = markdown.split(/\r?\n/);
    const headingIndex = lines.indexOf(VOCABULARY_HEADING);

    if (headingIndex < 0) {
        throw new Error(
            `docs/contracts/resource-chips.md has no \`${VOCABULARY_HEADING}\` heading. This ` +
                'test reads the chip table from that section; renaming the heading blinds it.'
        );
    }

    const ids: string[] = [];
    for (const line of lines.slice(headingIndex + 1)) {
        // The section ends at the next same-level heading. `###` subsections inside it
        // are part of the section and are scanned; they hold prose, not table rows.
        if (line.startsWith('## ')) break;

        const match = /^\|\s*`([A-Za-z]+)`\s*\|/.exec(line);
        if (match?.[1]) ids.push(match[1]);
    }

    return ids;
}

describe('resource chip vocabulary matches its contract doc', () => {
    const documented = chipIdsInDocTable(doc);

    it('documents every chip the table declares', () => {
        const missing = RESOURCE_CHIP_IDS.filter((id) => !documented.includes(id));

        expect(
            missing,
            `These chips exist in RESOURCE_CHIPS but have no row in the vocabulary table of ` +
                `docs/contracts/resource-chips.md: ${missing.join(', ')}. Add a row, or the ` +
                `chip is undocumented.`
        ).toEqual([]);
    });

    it('declares every chip the doc documents', () => {
        const stale = documented.filter(
            (id) => !RESOURCE_CHIP_IDS.includes(id as (typeof RESOURCE_CHIP_IDS)[number])
        );

        expect(
            stale,
            `docs/contracts/resource-chips.md documents chips that no longer exist in ` +
                `RESOURCE_CHIPS: ${stale.join(', ')}. Remove the rows, or the doc promises a ` +
                `chip nothing renders.`
        ).toEqual([]);
    });

    it('documents each chip exactly once', () => {
        const duplicated = documented.filter(
            (id, index) => documented.indexOf(id) !== index
        );

        expect(
            duplicated,
            `These chips have more than one row in the vocabulary table: ${duplicated.join(', ')}.`
        ).toEqual([]);
    });
});

describe('the table is internally consistent', () => {
    it('renders every declared chip', () => {
        // `RESOURCE_CHIP_ORDER` is what the row maps over, so a chip missing from it
        // is detected and then silently never drawn.
        const missing = Object.keys(RESOURCE_CHIPS).filter(
            (id) => !RESOURCE_CHIP_ORDER.includes(id as (typeof RESOURCE_CHIP_ORDER)[number])
        );

        expect(
            missing,
            `These chips are declared in RESOURCE_CHIPS but absent from RESOURCE_CHIP_ORDER, ` +
                `so they would never render: ${missing.join(', ')}.`
        ).toEqual([]);
    });

    it('orders errors before install-blockers before warnings before info', () => {
        // The render order is a decision the doc states: a row that cannot save leads
        // with why, then one that cannot install. Asserted rather than left to whoever
        // edits the array next.
        const tones = RESOURCE_CHIP_ORDER.map((id) => RESOURCE_CHIPS[id].tone);
        const rank = { error: 0, blocksInstall: 1, warn: 2, info: 3 } as const satisfies Record<
            ResourceChipTone,
            number
        >;

        expect(tones.map((tone) => rank[tone])).toEqual(
            [...tones.map((tone) => rank[tone])].sort((first, second) => first - second)
        );
    });

    it('gives every chip a non-empty reason, which is also its tooltip', () => {
        for (const id of RESOURCE_CHIP_IDS) {
            expect(RESOURCE_CHIPS[id].reason.length, `${id} has no reason`).toBeGreaterThan(0);
        }
    });
});
