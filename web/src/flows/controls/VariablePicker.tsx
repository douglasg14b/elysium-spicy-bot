/**
 * The bridge between a block that writes a variable and the copy that reads one.
 *
 * Three rows under a copy field:
 *
 * * **Built in** — the tokens the run supplies by itself. These have worked since
 *   copy rendering shipped and were never shown anywhere, so an author who did not
 *   already know `{{subject.username}}` existed had no way to find out.
 * * **From your blocks** — the variables some upstream block writes, each a click
 *   away from being inserted as `{{var.name}}`.
 * * **Warn** — a `{{var.…}}` the copy references that nothing upstream produces.
 *   This is the typo that used to surface at *run* time as a token resolving to
 *   nothing; here it is visible while the author is looking at the field.
 *
 * The warning is advice, not enforcement. It cannot be an error: this reads the
 * graph as currently wired, and an author who writes the copy before wiring the
 * producer is doing something reasonable that will be true in a moment. Save-time
 * validation on the server is where a genuine refusal belongs. For the same reason
 * a token the actor may not survive to is greyed but still clickable.
 */

import { Group, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { BUILTIN_TOKENS, builtinToken } from '../builtinTokens';
import type { AvailableVariable } from '../variables';
import { referencedVariables, variableToken } from '../variables';

interface VariablePickerProps {
    /** What upstream blocks write, in the order a run would write them. */
    variables: AvailableVariable[];
    /** Whether `{{actor.mention}}` resolves at this node. */
    actorAvailable: boolean;
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

/** A value the author's own blocks write. Cyan, matching the output chips elsewhere. */
const VARIABLE_CHIP = {
    ...CHIP_STYLE,
    color: 'var(--mantine-color-cyan-4)',
    background: 'rgba(0,162,255,.12)',
    border: '1px solid rgba(0,162,255,.3)',
} as const;

/**
 * A value the run supplies. Deliberately not cyan.
 *
 * "The server fills this in" and "an earlier block of yours wrote this" are
 * different promises, and an author troubleshooting an empty token needs to know
 * which kind they are looking at without reading the tooltip.
 */
const BUILTIN_CHIP = {
    ...CHIP_STYLE,
    color: 'var(--mantine-color-gray-4)',
    background: 'rgba(255,255,255,.06)',
    border: '1px solid rgba(255,255,255,.14)',
} as const;

/** The same chip, for a token this node may not receive a value for. */
const UNAVAILABLE_CHIP = {
    ...CHIP_STYLE,
    color: 'var(--mantine-color-dark-2)',
    background: 'rgba(255,255,255,.03)',
    border: '1px dashed rgba(255,255,255,.12)',
} as const;

const UNAVAILABLE_NOTE =
    'A block above this one can pause the run. If the clock wakes it instead of a person, ' +
    'nobody caused this step and the token has nothing to fill in.';

export function VariablePicker({
    variables,
    actorAvailable,
    value,
    onInsert,
}: VariablePickerProps) {
    const known = new Set(variables.map((variable) => variable.name));
    const unknown = referencedVariables(value).filter((name) => !known.has(name));

    return (
        <div style={{ marginTop: 6 }}>
            <Group gap={5} align="center">
                <Text size="10.5px" c="dimmed" fw={600}>
                    Built in:
                </Text>
                {BUILTIN_TOKENS.map((token) => {
                    const unavailable = token.lostAfterSuspend && !actorAvailable;

                    return (
                        <Tooltip
                            key={token.name}
                            withArrow
                            multiline
                            w={240}
                            label={
                                <span>
                                    {token.description}
                                    {unavailable ? (
                                        <>
                                            <br />
                                            <br />
                                            {UNAVAILABLE_NOTE}
                                        </>
                                    ) : null}
                                    <br />
                                    Click to insert.
                                </span>
                            }
                        >
                            <UnstyledButton
                                onClick={() => onInsert(builtinToken(token.name))}
                                style={unavailable ? UNAVAILABLE_CHIP : BUILTIN_CHIP}
                            >
                                {token.name}
                            </UnstyledButton>
                        </Tooltip>
                    );
                })}
            </Group>

            {variables.length > 0 ? (
                <Group gap={5} align="center" mt={5}>
                    <Text size="10.5px" c="dimmed" fw={600}>
                        From your blocks:
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
                                style={VARIABLE_CHIP}
                            >
                                {variable.name}
                            </UnstyledButton>
                        </Tooltip>
                    ))}
                </Group>
            ) : null}

            {unknown.length > 0 ? (
                <Text size="10.5px" c="yellow.5" mt={5}>
                    Nothing above this block writes{' '}
                    {unknown.map((name) => variableToken(name)).join(', ')} — it&apos;ll come out
                    empty and fail the run unless you wire up a block that does.
                </Text>
            ) : null}
        </div>
    );
}
