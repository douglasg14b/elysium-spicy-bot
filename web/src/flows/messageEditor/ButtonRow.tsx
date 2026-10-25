/**
 * The buttons under a message resource's embeds, as Discord lays them out — five to a row, each
 * in its style — with, in Edit, what listens to each and **+ Add button** after the last
 * (mockup `message-editor.mockup.html`, section 3).
 *
 * A click on a button opens its box: the label (with its count), the style and the key. The key
 * is what a press is routed by, so it is shown and editable rather than hidden; relabelling a
 * button leaves it alone. Nothing here is ever `disabled` (see `PictureSlot`).
 *
 * "↳ Nothing listening yet" is the truth in step 2: no flow can listen to one of these buttons
 * until step 3 gives Button Click a way to, and the line becomes the listening flow's name then.
 */

import { useRef, useState, type CSSProperties } from 'react';
import { Button, Group, Popover, SegmentedControl, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import type { MessageButton, MessageButtonStyle } from '@brattybot/web-sdk';
import { DISCORD, TOOL_COLUMN } from './discordLook';
import { useEditorScope, type EditorButtons } from './editorScope';
import { addButton, BUTTONS_PER_ROW, buttonRows, removeButton, updateButton } from './messageButtons';
import { PartProblems } from './PartProblems';
import { BUTTON_LABEL_RULE, MAX_BUTTONS } from './partRules';

/** Discord's own colour for each style, and what the box calls it. */
const STYLES: Readonly<Record<MessageButtonStyle, { readonly colour: string; readonly name: string }>> = {
    Primary: { colour: '#5865f2', name: 'Blurple' },
    Secondary: { colour: '#4e5058', name: 'Grey' },
    Success: { colour: '#248046', name: 'Green' },
    Danger: { colour: '#da373c', name: 'Red' },
};

const STYLE_ORDER: readonly MessageButtonStyle[] = ['Primary', 'Secondary', 'Success', 'Danger'];

const FACE: CSSProperties = {
    fontSize: 14,
    fontWeight: 500,
    lineHeight: '18px',
    padding: '7px 16px',
    borderRadius: 4,
    color: '#fff',
    maxWidth: 240,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
};

export function ButtonRow() {
    const scope = useEditorScope();
    const buttons = scope.buttons;
    if (!buttons) return null;

    const editing = scope.mode === 'edit';
    const rows = buttonRows(buttons.value.map((button, index) => ({ button, index })));
    const canAdd = editing && buttons.value.length < MAX_BUTTONS;
    // The add button sits after the last button, on its row while there is room on it.
    const addOnLastRow = canAdd && (rows.at(-1)?.length ?? BUTTONS_PER_ROW) < BUTTONS_PER_ROW;
    const listProblems = buttons.issues?.get(-1) ?? [];

    if (!editing && buttons.value.length === 0) return null;

    return (
        <Stack gap={8} ml={TOOL_COLUMN + 10} mt={10}>
            {rows.map((row, rowIndex) => (
                <Group key={rowIndex} gap={8} align="flex-start" wrap="wrap">
                    {row.map(({ button, index }) =>
                        editing ? (
                            <ButtonSlot key={index} buttons={buttons} index={index} button={button} />
                        ) : (
                            <div key={index} style={{ ...FACE, background: STYLES[button.style].colour }}>
                                {button.label}
                            </div>
                        )
                    )}
                    {addOnLastRow && rowIndex === rows.length - 1 ? <AddButton buttons={buttons} /> : null}
                </Group>
            ))}
            {canAdd && !addOnLastRow ? (
                <Group gap={8}>
                    <AddButton buttons={buttons} />
                </Group>
            ) : null}
            {editing && buttons.value.length >= MAX_BUTTONS ? (
                <Text size="12.5px" c={DISCORD.muted}>
                    {MAX_BUTTONS} of {MAX_BUTTONS} — five rows of five is all Discord takes
                </Text>
            ) : null}
            <PartProblems problems={listProblems} mt={0} />
        </Stack>
    );
}

/** **+ Add button**: a new one, labelled and keyed, so it is never an empty button. */
function AddButton({ buttons }: { readonly buttons: EditorButtons }) {
    return (
        <UnstyledButton
            onClick={() => buttons.onChange(addButton(buttons.value))}
            style={{
                ...FACE,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                color: DISCORD.muted,
                border: `1px dashed ${DISCORD.placeholderEdge}`,
                padding: '6px 15px',
            }}
        >
            <IconPlus size={14} />
            Add button
        </UnstyledButton>
    );
}

interface ButtonSlotProps {
    readonly buttons: EditorButtons;
    readonly index: number;
    readonly button: MessageButton;
}

/** One button in Edit: its face, what listens to it under it, and its box on a click. */
function ButtonSlot({ buttons, index, button }: ButtonSlotProps) {
    const [opened, setOpened] = useState(false);
    const target = useRef<HTMLButtonElement>(null);
    const problems = buttons.issues?.get(index) ?? [];
    const update = (patch: Partial<MessageButton>) => buttons.onChange(updateButton(buttons.value, index, patch));

    // Closed from inside — Done, Remove — focus goes back to the button, as a picture's does.
    const close = () => {
        setOpened(false);
        target.current?.focus();
    };

    return (
        <Stack gap={5} align="flex-start">
            <Popover opened={opened} onChange={setOpened} width={320} position="bottom-start" withArrow shadow="xl">
                <Popover.Target>
                    <UnstyledButton
                        ref={target}
                        className="mx-picture"
                        aria-haspopup="dialog"
                        data-problem={problems.length > 0 || undefined}
                        onClick={() => setOpened((open) => !open)}
                        style={{
                            ...FACE,
                            background: STYLES[button.style].colour,
                            outline: problems.length > 0 ? '1px dashed var(--mantine-color-red-5)' : undefined,
                            outlineOffset: 2,
                        }}
                    >
                        {button.label || ' '}
                    </UnstyledButton>
                </Popover.Target>
                <Popover.Dropdown className="nokey" p={12}>
                    <ButtonBox
                        button={button}
                        problems={problems}
                        onChange={update}
                        onDone={close}
                        onRemove={() => {
                            setOpened(false);
                            buttons.onChange(removeButton(buttons.value, index));
                        }}
                    />
                </Popover.Dropdown>
            </Popover>
            <Text size="11.5px" c="yellow.5" lh={1.2}>
                ↳ Nothing listening yet
            </Text>
        </Stack>
    );
}

interface ButtonBoxProps {
    readonly button: MessageButton;
    readonly problems: readonly string[];
    readonly onChange: (patch: Partial<MessageButton>) => void;
    readonly onDone: () => void;
    readonly onRemove: () => void;
}

/** The box a button opens: its label, its style and its key. */
function ButtonBox({ button, problems, onChange, onDone, onRemove }: ButtonBoxProps) {
    const maxLength = BUTTON_LABEL_RULE.maxLength ?? Number.POSITIVE_INFINITY;
    const over = button.label.length > maxLength;

    return (
        <Stack gap={10}>
            <TextInput
                label="Label"
                value={button.label}
                onChange={(event) => onChange({ label: event.currentTarget.value })}
                rightSectionWidth={64}
                rightSection={
                    <Text size="11px" c={over ? 'red.4' : 'dark.2'}>
                        {button.label.length} / {BUTTON_LABEL_RULE.maxLength}
                    </Text>
                }
            />
            <div>
                <Text size="sm" fw={500} mb={4}>
                    Style
                </Text>
                <SegmentedControl
                    fullWidth
                    size="xs"
                    aria-label="Style"
                    value={button.style}
                    onChange={(next) => onChange({ style: next as MessageButtonStyle })}
                    data={STYLE_ORDER.map((style) => ({
                        value: style,
                        label: (
                            <Group gap={5} wrap="nowrap" justify="center">
                                <span
                                    aria-hidden
                                    style={{ width: 9, height: 9, borderRadius: 2, background: STYLES[style].colour, flex: 'none' }}
                                />
                                {STYLES[style].name}
                            </Group>
                        ),
                    }))}
                />
            </div>
            <TextInput
                label="Key"
                description="What a press is known by. Settle on it before a flow listens to this button."
                value={button.key}
                onChange={(event) => onChange({ key: event.currentTarget.value })}
            />
            <PartProblems problems={problems} mt={0} />
            <Group justify="flex-end" gap={8}>
                <Button variant="subtle" color="gray" size="xs" onClick={onRemove}>
                    Remove button
                </Button>
                <Button size="xs" onClick={onDone}>
                    Done
                </Button>
            </Group>
        </Stack>
    );
}
