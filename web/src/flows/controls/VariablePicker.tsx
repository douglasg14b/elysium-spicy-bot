/**
 * The bridge between a block that writes a variable and the copy that reads one.
 *
 * Two halves, both under a copy field:
 *
 * * **Offer** — the variables some upstream block writes, each a click away from
 *   being inserted as `{{var.name}}`. An author no longer has to remember a name
 *   they typed into a different node, or the token syntax that reads it.
 * * **Warn** — a `{{var.…}}` the copy references that nothing upstream produces.
 *   This is the typo that used to surface at *run* time as a token resolving to
 *   nothing; here it is visible while the author is looking at the field.
 *
 * The warning is advice, not enforcement. It cannot be an error: this reads the
 * graph as currently wired, and an author who writes the copy before wiring the
 * producer is doing something reasonable that will be true in a moment. Save-time
 * validation on the server is where a genuine refusal belongs.
 */

import { Group, Text, Tooltip, UnstyledButton } from '@mantine/core';
import type { AvailableVariable } from '../variables';
import { referencedVariables, variableToken } from '../variables';

interface VariablePickerProps {
    /** What upstream blocks write, in the order a run would write them. */
    variables: AvailableVariable[];
    /** The copy currently in the field, scanned for references. */
    value: string;
    /** Append a token to the field's value. */
    onInsert: (token: string) => void;
}

const CHIP_STYLE = {
    borderRadius: 6,
    padding: '1.5px 6px',
    fontSize: 11,
    fontWeight: 600,
    fontFamily: 'var(--mantine-font-family-monospace)',
    lineHeight: 1.5,
} as const;

export function VariablePicker({ variables, value, onInsert }: VariablePickerProps) {
    const known = new Set(variables.map((variable) => variable.name));
    const unknown = referencedVariables(value).filter((name) => !known.has(name));

    if (variables.length === 0 && unknown.length === 0) {
        return null;
    }

    return (
        <div style={{ marginTop: 6 }}>
            {variables.length > 0 ? (
                <Group gap={5} align="center">
                    <Text size="10.5px" c="dimmed" fw={600}>
                        Available:
                    </Text>
                    {variables.map((variable) => (
                        <Tooltip
                            key={variable.name}
                            withArrow
                            multiline
                            w={220}
                            label={
                                <span>
                                    {variable.producerIcon} From <b>{variable.producerLabel}</b>
                                    {variable.description ? ` — ${variable.description}` : ''}
                                    <br />
                                    Click to insert.
                                </span>
                            }
                        >
                            <UnstyledButton
                                onClick={() => onInsert(variableToken(variable.name))}
                                style={{
                                    ...CHIP_STYLE,
                                    color: 'var(--mantine-color-cyan-4)',
                                    background: 'rgba(0,162,255,.12)',
                                    border: '1px solid rgba(0,162,255,.3)',
                                }}
                            >
                                {variable.name}
                            </UnstyledButton>
                        </Tooltip>
                    ))}
                </Group>
            ) : null}

            {unknown.length > 0 ? (
                <Text size="10.5px" c="yellow.5" mt={variables.length > 0 ? 5 : 0}>
                    Nothing above this block writes{' '}
                    {unknown.map((name) => variableToken(name)).join(', ')} — it&apos;ll come out
                    empty and fail the run unless you wire up a block that does.
                </Text>
            ) : null}
        </div>
    );
}
