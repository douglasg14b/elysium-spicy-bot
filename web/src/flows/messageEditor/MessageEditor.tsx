/**
 * The message window: the message drawn the way Discord will show it, every part a click
 * away from being edited — MEE6's editor, for the flow builder.
 *
 * **It edits the node live.** Every change goes straight through `onChange`, as every
 * inspector control's does, so undo, the draft autosave and the server's re-check as focus
 * leaves a part all keep working while it is open (React's `onBlur` bubbles out of Mantine's
 * portal to the inspector's wrapper). **Cancel** puts back the message as it was when the
 * window opened, with one `onChange`; **Done**, the close button and Escape keep what is
 * there — an upload still on its way then lands when it answers. A message with nothing in
 * it opens on one fresh embed, written by the first edit.
 *
 * Knows no block: whoever opens it says what it is called and hands it the page's variables
 * and uploads, so a message that is not a block's field can open the same window — a message
 * resource does, with `tokens={false}` (nothing fills a token in a message no run posts) and its
 * `buttons`, drawn under the embeds. Cancel puts the buttons back too.
 */

import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Group, Modal, Progress, SegmentedControl, Stack, Alert, Text } from '@mantine/core';
import { IconAlertTriangle, IconPlus } from '@tabler/icons-react';
import { brandLogoUrl, FALLBACK_BOT_NAME } from '../../brand';
import type { ControlContext, NestedIssue } from '../controls/types';
import { ButtonRow } from './ButtonRow';
import { DISCORD, postedAtLabel, TOOL_COLUMN } from './discordLook';
import { EmbedCard } from './EmbedCard';
import { EditorScopeContext, useEditorScope, type EditorButtons, type EditorMode, type EditorScope } from './editorScope';
import { MESSAGE_TOTAL_CHARACTERS, messageCharacterCount } from './messageCharacters';
import { addEmbed, readMessageDraft, startingMessage, type MessageDraft } from './messageDraft';
import { placeMessageIssues } from './messageIssues';
import { MAX_EMBEDS } from './partRules';
import { TextPartBox } from './TextPartBox';
import './messageEditor.css';

export interface MessageEditorProps extends Pick<ControlContext, 'variables' | 'requirements' | 'uploads'> {
    /** What the message is called — the window's title reads "Edit <title>". */
    readonly title: string;
    readonly description?: string;
    /** The colours offered for an embed; the first one colours a new embed. */
    readonly swatches: readonly string[];
    /** The message as stored, whatever shape it is in. */
    readonly value: unknown;
    /** Every edit, at once; `undefined` removes the message (Cancel on one that had none). */
    readonly onChange: (next: MessageDraft | undefined) => void;
    /** The server's complaints about parts of the message, paths relative to it. */
    readonly issues: readonly NestedIssue[];
    /** The server's complaint about the message as a whole, if any. */
    readonly error?: string;
    /**
     * Whether the message takes `{{tokens}}` — the default. `false` hides `{x}` on every part
     * and the picture box's Token tab, for a message posted with no run to fill one in.
     */
    readonly tokens?: boolean;
    /** The buttons under the message, for one that has them: a row under the embeds, up to 25. */
    readonly buttons?: EditorButtons;
    readonly onClose: () => void;
}

const NUMBER = new Intl.NumberFormat('en-US');

/** Whether a key was pressed inside a popover, which closes itself on Escape. */
function inPopover(target: EventTarget): boolean {
    return target instanceof Element && target.closest('.mantine-Popover-dropdown') !== null;
}

export function MessageEditor({
    title,
    description,
    swatches,
    value,
    onChange,
    variables,
    requirements,
    uploads,
    issues,
    error,
    tokens = true,
    buttons,
    onClose,
}: MessageEditorProps) {
    // What Cancel puts back: the value and the buttons as they were when the window opened.
    const [snapshot] = useState(value);
    const [buttonsSnapshot] = useState(buttons?.value);
    const [mode, setMode] = useState<EditorMode>('edit');
    const [editing, setEditing] = useState<string | null>(null);
    const [uploadsInFlight, setUploadsInFlight] = useState(0);
    const message = readMessageDraft(value) ?? startingMessage(swatches[0]);

    /*
     * The message an edit is applied to: the latest, not the one a render saw. An upload
     * answers whenever it answers, and by then the author may have typed elsewhere — applying
     * it to the message as it was when it was sent would undo that typing. Updated as each
     * edit is made, so two in one tick both land.
     */
    const latest = useRef(message);
    latest.current = message;
    /*
     * Set by Cancel alone, so an upload answering after it does not write its picture back
     * over the message Cancel put back. Not by the window closing: Done keeps what is there,
     * and to an author watching "Uploading…" the picture is there.
     */
    const cancelled = useRef(false);

    const apply = useCallback(
        (edit: (current: MessageDraft) => MessageDraft) => {
            if (cancelled.current) return;
            const next = edit(latest.current);
            latest.current = next;
            onChange(next);
        },
        [onChange]
    );

    const trackUpload = useCallback(async <TResult,>(work: Promise<TResult>): Promise<TResult> => {
        setUploadsInFlight((count) => count + 1);
        try {
            return await work;
        } finally {
            setUploadsInFlight((count) => count - 1);
        }
    }, []);

    const cancel = () => {
        cancelled.current = true;
        if (value !== snapshot) onChange(readMessageDraft(snapshot));
        if (buttons && buttons.value !== buttonsSnapshot) buttons.onChange([...(buttonsSnapshot ?? [])]);
        onClose();
    };

    /*
     * Escape, handled here rather than by Mantine, which closes the window on any Escape at
     * all: in a popover it is the popover's, in a part being typed into it finishes the part,
     * and only otherwise does it close the window — keeping the changes, as Done does.
     */
    const escape = (event: KeyboardEvent<HTMLElement>) => {
        if (event.key !== 'Escape' || inPopover(event.target)) return;
        if (editing !== null) {
            setEditing(null);
            return;
        }
        onClose();
    };

    const placed = placeMessageIssues(issues, message);
    const unplaced = [...(error ? [error] : []), ...placed.rest];
    const scope: EditorScope = {
        mode,
        message,
        apply,
        editing,
        setEditing,
        uploading: uploadsInFlight > 0,
        trackUpload,
        issues: placed,
        variables,
        requirements,
        uploads,
        swatches,
        tokens,
        buttons,
    };

    return (
        <Modal.Root opened onClose={onClose} size={1180} centered closeOnEscape={false} className="nokey">
            <Modal.Overlay />
            <Modal.Content radius="lg">
                {/* Here, not on `Modal.Content`, which drops an `onKeyDown` it is given. */}
                <div onKeyDown={escape}>
                    <Modal.Header style={{ borderBottom: '1px solid var(--mantine-color-dark-6)', gap: 14 }}>
                        <div>
                            <Modal.Title fw={800} fz={17} lh={1.35}>
                                Edit {title.toLowerCase()}
                            </Modal.Title>
                            {description ? (
                                <Text size="12.5px" c="dark.2" mt={2}>
                                    {description}
                                </Text>
                            ) : null}
                        </div>
                        <SegmentedControl
                            ml="auto"
                            size="xs"
                            value={mode}
                            onChange={(next) => {
                                setEditing(null);
                                setMode(next as EditorMode);
                            }}
                            data={[
                                { value: 'edit', label: 'Edit' },
                                { value: 'preview', label: 'Preview' },
                            ]}
                        />
                        <Modal.CloseButton aria-label="Close, keeping the changes" ml={0} />
                    </Modal.Header>

                    <Modal.Body p={0}>
                        <EditorScopeContext.Provider value={scope}>
                            <Stage unplaced={unplaced} />
                        </EditorScopeContext.Provider>

                        <Group
                            gap={14}
                            px={20}
                            py={12}
                            style={{
                                position: 'sticky',
                                bottom: 0,
                                zIndex: 2,
                                background: 'var(--mantine-color-body)',
                                borderTop: '1px solid var(--mantine-color-dark-6)',
                            }}
                        >
                            <Meter message={message} />
                            <Group gap={8} ml="auto">
                                <Button variant="subtle" color="gray" onClick={cancel}>
                                    Cancel
                                </Button>
                                <Button onClick={onClose}>Done</Button>
                            </Group>
                        </Group>
                    </Modal.Body>
                </div>
            </Modal.Content>
        </Modal.Root>
    );
}

/** The Discord-coloured part of the window: the bot's name, the plain text, the embeds. */
function Stage({ unplaced }: { readonly unplaced: readonly string[] }) {
    return (
        <div style={{ background: DISCORD.background, padding: '22px 26px 26px' }}>
            {unplaced.length > 0 ? (
                <Alert color="red" variant="light" p="xs" mb={14} icon={<IconAlertTriangle size={16} />} title="Fix before this goes live">
                    <Stack gap={2}>
                        {unplaced.map((problem, index) => (
                            <Text key={index} size="11.5px">
                                {problem}
                            </Text>
                        ))}
                    </Stack>
                </Alert>
            ) : null}
            <Author />
            <EditorEmbeds />
            <ButtonRow />
        </div>
    );
}

/** The bot as Discord shows it above its message, with the plain text under its name. */
function Author() {
    return (
        <Group gap={14} align="flex-start" wrap="nowrap" mb={10}>
            <img src={brandLogoUrl(null)} alt="" style={{ width: 40, height: 40, borderRadius: '50%', flex: 'none' }} />
            <div style={{ flex: 1, minWidth: 0, maxWidth: 560 }}>
                <Group gap={7} mb={4} wrap="nowrap">
                    <Text fw={700} fz={15} c={DISCORD.heading}>
                        {FALLBACK_BOT_NAME}
                    </Text>
                    <Text
                        component="span"
                        fz={10}
                        fw={700}
                        c="#fff"
                        style={{ background: DISCORD.appBadge, borderRadius: 3, padding: '1px 5px' }}
                    >
                        APP
                    </Text>
                    <Text component="span" fz={12} c={DISCORD.muted}>
                        {postedAtLabel(new Date())}
                    </Text>
                </Group>
                <TextPartBox
                    part={{ kind: 'content' }}
                    placeholder="Plain text above the embeds — optional, and it can ping."
                    multiline
                />
            </div>
        </Group>
    );
}

function EditorEmbeds() {
    const scope = useEditorScope();
    const count = scope.message.embeds.length;
    return (
        <>
            {scope.message.embeds.map((_embed, index) => (
                // By position: an embed has no identity of its own, and nothing holds state
                // per embed across a move but its popovers.
                <EmbedCard key={index} index={index} />
            ))}
            {scope.mode === 'edit' ? (
                <Group gap={10} ml={TOOL_COLUMN + 10}>
                    {count < MAX_EMBEDS ? (
                        <Button
                            variant="default"
                            size="xs"
                            leftSection={<IconPlus size={14} />}
                            onClick={() => scope.apply((message) => addEmbed(message, scope.swatches[0]))}
                        >
                            Add embed
                        </Button>
                    ) : null}
                    <Text size="12.5px" c={DISCORD.muted}>
                        {count} of {MAX_EMBEDS}
                        {count >= MAX_EMBEDS ? " — that's all Discord takes in one message" : ''}
                    </Text>
                </Group>
            ) : null}
        </>
    );
}

/** How much of Discord's 6000 characters the embeds spend, counted as a save counts them. */
function Meter({ message }: { readonly message: MessageDraft }) {
    const used = messageCharacterCount(message);
    const over = used > MESSAGE_TOTAL_CHARACTERS;
    return (
        <Group gap={10} wrap="nowrap">
            <Progress
                w={140}
                size={6}
                value={Math.min(100, (used / MESSAGE_TOTAL_CHARACTERS) * 100)}
                color={over ? 'red' : 'brand'}
                aria-label="Characters used across all embeds"
            />
            <Text size="12.5px" c={over ? 'red.4' : 'dark.2'}>
                {NUMBER.format(used)} / {NUMBER.format(MESSAGE_TOTAL_CHARACTERS)} characters across all embeds
            </Text>
        </Group>
    );
}
