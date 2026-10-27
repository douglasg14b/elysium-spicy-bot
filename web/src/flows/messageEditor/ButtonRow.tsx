/**
 * The buttons under a message resource's embeds, as Discord lays them out — five to a row, each
 * in its style — with, in Edit, what listens to each and **+ Add button** after the last
 * (mockup `message-editor.mockup.html`, section 3).
 *
 * A click on a button opens its box: the emoji, the label (with its count), the style and the
 * key. Either the emoji or the label may go, not both — the save says so if both do. The key
 * is what a press is routed by, so it is shown and editable rather than hidden; relabelling a
 * button leaves it alone. Nothing here is ever `disabled` (see `PictureSlot`).
 *
 * Under each button, the flow whose Button Click trigger listens to it, or "Nothing listening
 * yet". A listened button's key is locked — `readOnly`, never `disabled`, since the field can
 * hold focus — because renaming it would leave its trigger naming a button that is gone; and
 * Remove asks first, naming who it cuts off.
 */

import { useRef, useState } from 'react';
import { Button, Group, Popover, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { IconLock, IconPlus } from '@tabler/icons-react';
import type { ButtonListener, GuildEmoji, MessageButton } from '@brattybot/web-sdk';
import { buttonDisplayName } from '../buttonEmoji';
import { cutOffQuestion, flowNamesOf } from '../buttonListeners';
import { joinWithAnd } from '../nameLists';
import { ButtonFaceContent } from './ButtonFace';
import { ButtonEmojiField, ButtonLabelField, ButtonStyleField } from './ButtonFields';
import { BUTTON_FACE, BUTTON_STYLES, DISCORD, TOOL_COLUMN } from './discordLook';
import { useEditorScope, type EditorButtons } from './editorScope';
import { addButton, BUTTONS_PER_ROW, buttonRows, removeButton, updateButton } from './messageButtons';
import { PartProblems } from './PartProblems';
import { MAX_BUTTONS } from './partRules';

/** An emoji on a face, as Discord sets it beside 14px text. */
const FACE_EMOJI_SIZE = 18;

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
                            <div key={index} style={{ ...BUTTON_FACE, background: BUTTON_STYLES[button.style].colour }}>
                                <ButtonFaceContent button={button} emojiSize={FACE_EMOJI_SIZE} />
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
                ...BUTTON_FACE,
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
    const listeners = buttons.listeners.filter((listener) => listener.buttonKey === button.key);
    const update = (patch: Partial<MessageButton>) => buttons.onChange(updateButton(buttons.value, index, patch));

    // Closed from inside — Escape, Done, Remove — focus goes back to the button, as a picture's does.
    const close = () => {
        setOpened(false);
        target.current?.focus();
    };

    return (
        <Stack gap={5} align="flex-start">
            {/* Escape on the way up, not Mantine's capturing close: the emoji grid inside takes the first one. */}
            <Popover
                opened={opened}
                onChange={setOpened}
                width={320}
                position="bottom-start"
                withArrow
                shadow="xl"
                closeOnEscape={false}
            >
                <Popover.Target>
                    <UnstyledButton
                        ref={target}
                        className="mx-picture"
                        aria-haspopup="dialog"
                        // Its label, else its emoji, else its key — never nameless, whatever is on it.
                        aria-label={buttonDisplayName(button)}
                        data-problem={problems.length > 0 || undefined}
                        onClick={() => setOpened((open) => !open)}
                        style={{
                            ...BUTTON_FACE,
                            background: BUTTON_STYLES[button.style].colour,
                            outline: problems.length > 0 ? '1px dashed var(--mantine-color-red-5)' : undefined,
                            outlineOffset: 2,
                        }}
                    >
                        <ButtonFaceContent button={button} emojiSize={FACE_EMOJI_SIZE} />
                    </UnstyledButton>
                </Popover.Target>
                <Popover.Dropdown className="nokey" p={12} onKeyDown={(event) => event.key === 'Escape' && close()}>
                    {/* Unmounted while shut, so a box reopened never carries a pending question. */}
                    <ButtonBox
                        button={button}
                        listeners={listeners}
                        problems={problems}
                        serverEmojis={buttons.serverEmojis}
                        onChange={update}
                        onDone={close}
                        onRemove={() => {
                            setOpened(false);
                            buttons.onChange(removeButton(buttons.value, index));
                        }}
                    />
                </Popover.Dropdown>
            </Popover>
            {listeners.length > 0 ? (
                <Text size="11.5px" c="teal.4" lh={1.2}>
                    ↳ {joinWithAnd(flowNamesOf(listeners))}
                </Text>
            ) : (
                <Text size="11.5px" c="yellow.5" lh={1.2}>
                    ↳ Nothing listening yet
                </Text>
            )}
        </Stack>
    );
}

interface ButtonBoxProps {
    readonly button: MessageButton;
    /** The triggers listening to this button; none leaves its key free and its removal unasked. */
    readonly listeners: readonly ButtonListener[];
    readonly problems: readonly string[];
    /** The server's own emoji, for the grid and the "gone" note; `undefined` until read. */
    readonly serverEmojis: readonly GuildEmoji[] | undefined;
    /** A change to the button; `label` or `emoji` as `undefined` takes it off (`updateButton`). */
    readonly onChange: (patch: Partial<MessageButton>) => void;
    readonly onDone: () => void;
    readonly onRemove: () => void;
}

/** The box a button opens: its emoji, its label, its style and its key. */
function ButtonBox({ button, listeners, problems, serverEmojis, onChange, onDone, onRemove }: ButtonBoxProps) {
    // Removing a button a flow listens to asks first, in the box, before anything goes.
    const [askingToRemove, setAskingToRemove] = useState(false);
    const listened = listeners.length > 0;
    const listening = flowNamesOf(listeners);

    if (askingToRemove) {
        return (
            <Stack gap={10}>
                <Text size="13px">{cutOffQuestion(listeners, 'button')}</Text>
                <Group justify="flex-end" gap={8}>
                    <Button variant="subtle" color="gray" size="xs" onClick={() => setAskingToRemove(false)}>
                        Keep it
                    </Button>
                    <Button color="red" size="xs" onClick={onRemove}>
                        Remove anyway
                    </Button>
                </Group>
            </Stack>
        );
    }

    return (
        <Stack gap={10}>
            <ButtonEmojiField value={button.emoji} onChange={(emoji) => onChange({ emoji })} serverEmojis={serverEmojis} />
            {/* Emptied, the label goes: an emoji-only button has none, and the server refuses an empty one. */}
            <ButtonLabelField value={button.label ?? ''} onChange={(label) => onChange({ label: label || undefined })} />
            <ButtonStyleField value={button.style} onChange={(style) => onChange({ style })} />
            <TextInput
                label="Key"
                description={
                    listened
                        ? `Fixed — ${joinWithAnd(listening)} ${listening.length === 1 ? 'listens' : 'listen'} for it.`
                        :'What a press is known by. Settle on it before a flow listens to this button.'
                }
                value={button.key}
                // `readOnly`, never `disabled`: a field that stops being focusable while it has
                // focus throws the cursor away (see `ResourcesPanelProps.saving`).
                readOnly={listened}
                rightSection={listened ? <IconLock size={14} aria-label="Locked" /> : undefined}
                onChange={(event) => onChange({ key: event.currentTarget.value })}
            />
            <PartProblems problems={problems} mt={0} />
            <Group justify="flex-end" gap={8}>
                <Button
                    variant="subtle"
                    color="gray"
                    size="xs"
                    onClick={() => (listened ? setAskingToRemove(true) : onRemove())}
                >
                    Remove button
                </Button>
                <Button size="xs" onClick={onDone}>
                    Done
                </Button>
            </Group>
        </Stack>
    );
}
