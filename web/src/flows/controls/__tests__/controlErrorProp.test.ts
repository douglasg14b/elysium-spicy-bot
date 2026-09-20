/**
 * Field-level errors are a property of the control library, not of one control.
 *
 * `ControlProps` carries an `error` and `renderControl` passes it to every control,
 * so a new control gets field-level errors by taking a prop it already has. That is
 * only true while the controls actually read it — and the failure mode if one stops
 * is silent: the save is refused, the inspector places the message under that
 * control, and the control draws nothing.
 *
 * Asserted by reading the source rather than by rendering. This package has no DOM
 * test environment (`vitest.config.ts` collects `*.test.ts` only, and there is no
 * jsdom or React testing library in `web/package.json`), and adding one for this
 * would be a larger change than the thing it checks. The claim is correspondingly
 * bounded: **each control names `error`**, not that its widget draws it correctly.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONTROLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Controls that deliberately do not place a field-level error.
 *
 * Both edit a **list**, and a rejected save blames one entry inside it — the issue
 * arrives on a dotted path (`fields.0.name`) that names no control, so the inspector
 * renders it at node level instead. Exempted here rather than given a second error
 * channel of their own, which the plan explicitly left out of scope.
 *
 * Listed by file so adding a third list control is a decision somebody makes here,
 * not something that happens by forgetting.
 */
const NODE_LEVEL_ONLY = ['ObjectListControl.tsx', 'EligibilityControl.tsx'];

/** The dispatcher, which is not itself a control. */
const DISPATCHER = 'renderControl.tsx';

/** Every control module: the `*Control(s).tsx` files, minus the dispatcher. */
function controlFiles(): string[] {
    return readdirSync(CONTROLS_DIR).filter(
        (entry) =>
            entry !== DISPATCHER &&
            (entry.endsWith('Control.tsx') || entry.endsWith('Controls.tsx'))
    );
}

/**
 * Does every exported control in this module destructure `error` from its props?
 *
 * Matched inside the `{ … }: ControlProps<…>` parameter itself rather than anywhere
 * in the file. A looser check — the bare word `error` — passes on a comment
 * mentioning it, which is exactly the file a control would look like on the day
 * somebody removed the prop and left the note explaining it.
 *
 * The names are split on commas rather than pattern-matched, so a trailing comma
 * and a line break are both just whitespace. The first draft matched `error,` in
 * the raw source and failed three correct controls that happened to take it last.
 */
function everyControlDestructuresError(source: string): boolean {
    const parameters = [...source.matchAll(/\{([^{}]*)\}:\s*ControlProps</g)].map(
        (match) => (match[1] ?? '').split(',').map((name) => name.trim())
    );
    return parameters.length > 0 && parameters.every((names) => names.includes('error'));
}

describe('every control takes the shared error prop', () => {
    it('finds the control modules', () => {
        // The list below is generated, so a moved directory would report green over
        // nothing at all.
        const files = controlFiles();
        expect(files).toContain('PickerControls.tsx');
        expect(files.length).toBeGreaterThanOrEqual(7);
    });

    it.each(controlFiles().filter((file) => !NODE_LEVEL_ONLY.includes(file)))(
        '%s reads `error` from its props',
        (file) => {
            const source = readFileSync(join(CONTROLS_DIR, file), 'utf8');

            expect(
                everyControlDestructuresError(source),
                `${file} has a control that does not destructure \`error\`. Every control gets ` +
                    'field-level errors through ControlProps; if this one genuinely cannot place ' +
                    'a message, add it to NODE_LEVEL_ONLY in this test and say why.'
            ).toBe(true);
        }
    );

    it('passes the prop through the dispatcher', () => {
        // The one place that could break every control at once: the controls can all
        // take `error` and still draw nothing if this stops handing it over.
        const source = readFileSync(join(CONTROLS_DIR, DISPATCHER), 'utf8');

        expect(/const props = \{[^}]*\berror\b[^}]*\}/.test(source)).toBe(true);
    });
});
