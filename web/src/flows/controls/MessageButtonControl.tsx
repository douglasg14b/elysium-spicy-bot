/**
 * The `messageButton` control: one button — on one of the messages the flow's journey declares,
 * stored as the two keys `{ messageKey, buttonKey }` (mockup `message-editor.mockup.html`,
 * section 4), or under a message a block posts, stored as `{ flowId, nodeId, buttonKey }` (step 2
 * of `docs/plans/block-message-buttons-step-2.md`).
 *
 * Pick a message — the journey's, then the posts of this flow's blocks, then those of the
 * journey's other flows — then one of its buttons, each drawn in its Discord style, with who
 * listens to it. One flow per button: a button another flow listens to is shown, greyed, naming
 * that flow, and cannot be picked; the server refuses switching on a flow whose button is taken
 * all the same, so this is the author never having to meet that refusal.
 *
 * A journey's message or button can be made on the spot. "+ New button on this message" and
 * "+ New message in…" write into the journey's Resources through `declareResources` — a button
 * exists only on a message resource, so the message window shows what was made here — and the
 * new button is picked in the same click. A block's post has no "+ New button": its buttons are
 * the block's, edited in that block's own message window.
 *
 * It is not a resource picker: it writes no `<field>Key` sidecar, and nothing is written back at
 * install, because a press finds its message through the message's binding or its post's record.
 */

import { useState } from 'react';
import { Button, Group, Input, Menu, Popover, Select, Stack, Text, type ComboboxData } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import type {
    BlockButtonMessage,
    BlockConfigField,
    GuildEmoji,
    MessageButton,
    MessageButtonEmoji,
    MessageButtonRef,
    MessageButtonStyle,
    ResourceDeclaration,
} from '@brattybot/web-sdk';
import { buttonDisplayName } from '../buttonEmoji';
import {
    blockMessageOf,
    buttonHolder,
    isJourneyButtonRef,
    postName,
    readButtonPick,
    type ButtonHolder,
} from '../buttonListeners';
import { ButtonFaceContent } from '../messageEditor/ButtonFace';
import { ButtonEmojiField, ButtonLabelField, ButtonStyleField } from '../messageEditor/ButtonFields';
import { BUTTON_FACE, BUTTON_STYLES } from '../messageEditor/discordLook';
import { BUTTON_LABEL_RULE, MAX_BUTTONS } from '../messageEditor/partRules';
import {
    addButtonToMessage,
    declareMessageIn,
    newMessageChannels,
    type NewButton,
    type NewMessageChannel,
} from '../messageButtonDeclarations';
import { channelOptionLabel } from '../resourceAdoption';
import type { ControlContext, ControlProps } from './types';

type MessageButtonField = Extract<BlockConfigField, { control: 'messageButton' }>;

/** Where a message is posted, as its option's second line says it. */
function postedIn(message: ResourceDeclaration, declared: readonly ResourceDeclaration[]): string {
    const channel = declared.find((resource) => resource.kind === 'textChannel' && resource.key === message.parentKey);
    return channel ? `in #${channel.defaultName}` : 'not in any channel yet';
}

/** A journey message option's second line: where it is posted. Nothing for one not declared. */
function journeyMessageLine(
    messageKey: string,
    messages: readonly ResourceDeclaration[],
    declared: readonly ResourceDeclaration[]
): string | null {
    const candidate = messages.find((entry) => entry.key === messageKey);
    return candidate ? postedIn(candidate, declared) : null;
}

/**
 * A block post option's second line: which block posts it, when its headline is what the
 * option is called — a post with no headline is already called by its block.
 */
function blockPostLine(post: BlockButtonMessage | undefined): string | null {
    return post?.headline ? `posted by ${post.blockLabel}` : null;
}

/** What the line under a button option says about who listens to it, if anyone. */
function holderLine(holder: ButtonHolder): string | null {
    switch (holder.kind) {
        case 'nobody':
            return null;
        case 'thisNode':
            return '↳ this flow';
        case 'thisFlow':
            return '↳ another trigger in this flow';
        case 'otherFlows':
            return `↳ ${holder.flowNames.join(', ')}`;
        default: {
            const unreachable: never = holder;
            throw new Error(`Unhandled button holder: ${JSON.stringify(unreachable)}`);
        }
    }
}

/** Which message a pick is on: a journey's, by key, or a block's post, by its flow and node. */
type MessageChoice =
    | { readonly kind: 'journey'; readonly messageKey: string }
    | { readonly kind: 'block'; readonly flowId: string; readonly nodeId: string };

/** A choice as the Message select's option value — one string, unique across both kinds. */
function choiceValue(choice: MessageChoice): string {
    return choice.kind === 'journey'
        ? `journey:${choice.messageKey}`
        : `block:${JSON.stringify([choice.flowId, choice.nodeId])}`;
}

/** An option value back as the choice it was made from; `undefined` for one this never made. */
function choiceOf(value: string): MessageChoice | undefined {
    if (value.startsWith('journey:')) return { kind: 'journey', messageKey: value.slice('journey:'.length) };
    if (!value.startsWith('block:')) return undefined;
    const parsed: unknown = JSON.parse(value.slice('block:'.length));
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return undefined;
    return { kind: 'block', flowId: parsed[0], nodeId: parsed[1] };
}

/** The message a stored pick is on. */
function choiceOfPick(pick: MessageButtonRef): MessageChoice {
    return isJourneyButtonRef(pick)
        ? { kind: 'journey', messageKey: pick.messageKey }
        : { kind: 'block', flowId: pick.flowId, nodeId: pick.nodeId };
}

/** The pick a button of the chosen message makes. */
function pickOn(choice: MessageChoice, buttonKey: string): MessageButtonRef {
    return choice.kind === 'journey'
        ? { messageKey: choice.messageKey, buttonKey }
        : { flowId: choice.flowId, nodeId: choice.nodeId, buttonKey };
}

/**
 * The Message select's options: the journey's messages, then the block posts grouped by flow —
 * this flow's first, under "This flow". Flat while there are no block posts, as before there
 * could be any.
 */
function messageOptionsOf(
    messages: readonly ResourceDeclaration[],
    posts: readonly BlockButtonMessage[],
    thisFlowId: string,
    gone: { readonly value: string; readonly label: string } | undefined
): ComboboxData {
    const journeyItems = messages.map((candidate) => ({
        value: choiceValue({ kind: 'journey', messageKey: candidate.key }),
        label: candidate.defaultName,
    }));
    const goneItems = gone ? [gone] : [];
    if (posts.length === 0) return [...journeyItems, ...goneItems];

    const flowIds = [...new Set(posts.map((post) => post.flowId))].sort((left, right) =>
        left === thisFlowId ? -1 : right === thisFlowId ? 1 : 0
    );
    return [
        ...(journeyItems.length > 0 ? [{ group: "This journey's messages", items: journeyItems }] : []),
        ...flowIds.map((flowId) => {
            const inFlow = posts.filter((post) => post.flowId === flowId);
            return {
                group: flowId === thisFlowId ? 'This flow' : (inFlow[0]?.flowName ?? flowId),
                items: inFlow.map((post) => ({
                    value: choiceValue({ kind: 'block', flowId: post.flowId, nodeId: post.nodeId }),
                    label: postName(post),
                })),
            };
        }),
        ...(goneItems.length > 0 ? [{ group: 'Gone', items: goneItems }] : []),
    ];
}

/**
 * Pick a message, then one of its buttons.
 *
 * Changing the message clears the stored pick until a button of the new one is chosen: a
 * message alone names nothing a press could match. A stored pick naming a message that is not
 * offered any more stays shown, marked, rather than going blank — the readiness issue under the
 * field says what to do about it.
 */
export function MessageButtonControl({ field, value, onChange, context, error }: ControlProps<MessageButtonField>) {
    const pick = readButtonPick(value);
    // A message chosen whose button is not picked yet, as its option value. Ignored once a pick is stored.
    const [choosing, setChoosing] = useState<string | null>(null);
    // Whether "+ New button" is open — also opened by a new message, whose first button it asks for.
    const [addingButton, setAddingButton] = useState(false);
    const choice: MessageChoice | undefined = pick ? choiceOfPick(pick) : choosing ? choiceOf(choosing) : undefined;
    const chosenValue = choice ? choiceValue(choice) : null;

    const declared = context.declaredResources;
    const posts = context.listeners.blockMessages;
    const messages = declared.filter((resource) => resource.kind === 'message');
    const message =
        choice?.kind === 'journey' ? messages.find((candidate) => candidate.key === choice.messageKey) : undefined;
    const post = choice?.kind === 'block' ? blockMessageOf(posts, choice) : undefined;
    const buttons: readonly MessageButton[] = message?.buttons ?? post?.buttons ?? [];
    // The chosen message is offered: a journey message still declared, or a post still posting.
    const offered = message ?? post;

    const gone =
        choice && chosenValue && !offered
            ? {
                  value: chosenValue,
                  label:
                      choice.kind === 'journey'
                          ? `${choice.messageKey} — not in this journey's resources`
                          : "A block's post that isn't here any more",
              }
            : undefined;
    const messageOptions = messageOptionsOf(messages, posts, context.listeners.flowId, gone);

    const holders = new Map<string, ButtonHolder>(
        choice && offered
            ? buttons.map((button) => [button.key, buttonHolder(context.listeners, pickOn(choice, button.key))])
            : []
    );
    const buttonOptions = buttons.map((button) => {
        const holder = holders.get(button.key);
        // Somebody else's, or another trigger's in this flow: one press starts one run.
        const taken = holder?.kind === 'otherFlows' || holder?.kind === 'thisFlow';
        return { value: button.key, label: buttonDisplayName(button), disabled: taken };
    });
    if (pick && offered && !buttons.some((button) => button.key === pick.buttonKey)) {
        buttonOptions.push({ value: pick.buttonKey, label: `${pick.buttonKey} — not on this message any more`, disabled: false });
    }

    const pickMessage = (next: string) => {
        setChoosing(next);
        setAddingButton(false);
        // The old pick names a button of another message; it goes until one of this
        // message's buttons is picked.
        if (pick && chosenValue !== next) onChange(undefined);
    };

    const noMessagesYet = messages.length === 0 && posts.length === 0 && !choice;

    return (
        // One label over both selects, and the issue line under them both: the field is the pair.
        // The line is placed by hand, between the pair and the links to make one, so it sits
        // under what it is about rather than under "+ New message in…" (mockup section 4).
        <Input.Wrapper label={field.label} description={field.description}>
            <Stack gap={6} mt={4}>
                {noMessagesYet ? (
                    <Text size="12px" c="dimmed">
                        This flow&apos;s journey has no messages yet.
                    </Text>
                ) : (
                    <>
                        <Select
                            aria-label="Message"
                            placeholder="Pick a message"
                            data={messageOptions}
                            value={chosenValue}
                            onChange={(next) => {
                                if (next && next !== chosenValue) pickMessage(next);
                            }}
                            renderOption={({ option }) => {
                                const optionChoice = choiceOf(option.value);
                                const line =
                                    optionChoice?.kind === 'journey'
                                        ? journeyMessageLine(optionChoice.messageKey, messages, declared)
                                        : optionChoice?.kind === 'block'
                                          ? blockPostLine(blockMessageOf(posts, optionChoice))
                                          : null;
                                return (
                                    <div>
                                        <Text size="13px">{option.label}</Text>
                                        {line ? (
                                            <Text size="11px" c="dimmed">
                                                {line}
                                            </Text>
                                        ) : null}
                                    </div>
                                );
                            }}
                            allowDeselect={false}
                            comboboxProps={{ withinPortal: true }}
                        />
                        <Select
                            aria-label="Button"
                            placeholder={choice ? 'Pick a button' : 'Pick a message first'}
                            // Red, with the sentence under the pair rather than under this one.
                            error={!!error}
                            data={buttonOptions}
                            value={pick?.buttonKey ?? null}
                            onChange={(next) => {
                                if (!next || !choice) return;
                                onChange(pickOn(choice, next));
                            }}
                            renderOption={({ option }) => {
                                const button = buttons.find((entry) => entry.key === option.value);
                                const holder = holders.get(option.value);
                                return button ? (
                                    <ButtonOption button={button} line={holder ? holderLine(holder) : null} />
                                ) : (
                                    <Text size="13px">{option.label}</Text>
                                );
                            }}
                            allowDeselect={false}
                            comboboxProps={{ withinPortal: true }}
                        />
                        {message && buttons.length === 0 && !addingButton ? (
                            <Text size="11px" c="dimmed">
                                &ldquo;{message.defaultName}&rdquo; has no buttons yet — give it one.
                            </Text>
                        ) : null}
                        {post ? (
                            <Text size="11px" c="dimmed">
                                {buttons.length === 0
                                    ? `"${postName(post)}" posts no buttons yet — give it some in its own message window.`
                                    : 'Its buttons are edited in its own message window.'}
                            </Text>
                        ) : null}
                    </>
                )}
                {error ? <Input.Error>{error}</Input.Error> : null}

                {/* Side by side where they fit; stacked close where the inspector is too narrow. */}
                <Group gap={14} style={{ rowGap: 2 }}>
                    {message && buttons.length < MAX_BUTTONS ? (
                        <NewButtonPopover
                            opened={addingButton}
                            onOpenedChange={setAddingButton}
                            serverEmojis={context.serverEmojis}
                            onAdd={(requested) => {
                                const target = message.key;
                                const added = addButtonToMessage(declared, target, requested);
                                context.declareResources(
                                    (current) => addButtonToMessage(current, target, requested).resources
                                );
                                onChange({ messageKey: target, buttonKey: added.buttonKey });
                                setAddingButton(false);
                            }}
                        />
                    ) : null}
                    <NewMessageMenu
                        context={context}
                        onPick={(where) => {
                            const created = declareMessageIn(declared, where);
                            context.declareResources((current) => declareMessageIn(current, where).resources);
                            pickMessage(choiceValue({ kind: 'journey', messageKey: created.messageKey }));
                            // A message with no button is nothing a trigger can listen to yet.
                            setAddingButton(true);
                        }}
                    />
                </Group>
            </Stack>
        </Input.Wrapper>
    );
}

/** One button as the option list draws it: its face in its style, and who listens under it. */
function ButtonOption({ button, line }: { readonly button: MessageButton; readonly line: string | null }) {
    return (
        <Group gap={10} wrap="nowrap">
            <span
                style={{
                    ...BUTTON_FACE,
                    gap: 5,
                    fontSize: 12.5,
                    padding: '4px 11px',
                    background: BUTTON_STYLES[button.style].colour,
                }}
            >
                <ButtonFaceContent button={button} emojiSize={16} />
            </span>
            {line ? (
                <Text size="11px" c="dimmed" truncate>
                    {line}
                </Text>
            ) : null}
        </Group>
    );
}

interface NewButtonPopoverProps {
    readonly opened: boolean;
    readonly onOpenedChange: (opened: boolean) => void;
    /** The server's own emoji, for the grid; `undefined` until the page has read them. */
    readonly serverEmojis: readonly GuildEmoji[] | undefined;
    readonly onAdd: (button: NewButton) => void;
}

/**
 * "+ New button on this message": an emoji, a label and a style, then Add — once it has a
 * label or an emoji, which is all a button needs to have something to press.
 *
 * Escape is handled on the way up, not by Mantine's capturing close, so one in the emoji grid
 * shuts the grid and leaves the label typed so far (see `ButtonEmojiField`).
 */
function NewButtonPopover({ opened, onOpenedChange, serverEmojis, onAdd }: NewButtonPopoverProps) {
    const [label, setLabel] = useState('');
    const [emoji, setEmoji] = useState<MessageButtonEmoji | undefined>(undefined);
    const [style, setStyle] = useState<MessageButtonStyle>('Primary');
    const trimmed = label.trim();
    const problem = trimmed ? BUTTON_LABEL_RULE.problem(trimmed) : undefined;

    const reset = () => {
        setLabel('');
        setEmoji(undefined);
        setStyle('Primary');
    };
    const close = () => {
        onOpenedChange(false);
        reset();
    };

    return (
        <Popover
            opened={opened}
            onChange={(next) => (next ? onOpenedChange(true) : close())}
            width={300}
            position="bottom-start"
            withArrow
            shadow="xl"
            trapFocus
            closeOnEscape={false}
        >
            <Popover.Target>
                <Button
                    variant="subtle"
                    size="compact-xs"
                    leftSection={<IconPlus size={13} />}
                    onClick={() => (opened ? close() : onOpenedChange(true))}
                >
                    New button on this message
                </Button>
            </Popover.Target>
            <Popover.Dropdown p={12} onKeyDown={(event) => event.key === 'Escape' && close()}>
                <Stack gap={10}>
                    <ButtonEmojiField value={emoji} onChange={setEmoji} serverEmojis={serverEmojis} />
                    <ButtonLabelField value={label} onChange={setLabel} autoFocus />
                    <ButtonStyleField value={style} onChange={setStyle} />
                    {problem ? (
                        <Text size="11.5px" c="red.4">
                            {problem}
                        </Text>
                    ) : null}
                    <Group justify="flex-end" gap={8}>
                        <Button variant="subtle" color="gray" size="xs" onClick={close}>
                            Cancel
                        </Button>
                        <Button
                            size="xs"
                            disabled={(!trimmed && !emoji) || !!problem}
                            onClick={() => {
                                onAdd({ ...(trimmed ? { label: trimmed } : {}), style, ...(emoji ? { emoji } : {}) });
                                reset();
                            }}
                        >
                            Add
                        </Button>
                    </Group>
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
}

interface NewMessageMenuProps {
    readonly context: ControlContext;
    readonly onPick: (where: NewMessageChannel) => void;
}

/** "+ New message in…": the journey's text channels, then the server's. */
function NewMessageMenu({ context, onPick }: NewMessageMenuProps) {
    const { declared, server } = newMessageChannels({
        declared: context.declaredResources,
        channels: context.channels,
        journeyKey: context.journey.key,
        boundKeys: context.journey.boundKeys,
    });

    return (
        <Menu position="bottom-start" shadow="md" width={280} withinPortal>
            <Menu.Target>
                <Button variant="subtle" size="compact-xs" leftSection={<IconPlus size={13} />}>
                    New message in…
                </Button>
            </Menu.Target>
            <Menu.Dropdown mah={360} style={{ overflowY: 'auto' }}>
                {declared.length > 0 ? <Menu.Label>Declared here</Menu.Label> : null}
                {declared.map((choice) => (
                    <Menu.Item key={`declared:${choice.key}`} onClick={() => onPick(choice)}>
                        #{choice.name}
                    </Menu.Item>
                ))}
                {declared.length > 0 && server.length > 0 ? <Menu.Divider /> : null}
                {server.length > 0 ? <Menu.Label>In your server</Menu.Label> : null}
                {server.map((choice) => (
                    <Menu.Item
                        key={`server:${choice.channel.id}`}
                        disabled={!!choice.heldBy}
                        onClick={() => onPick(choice)}
                    >
                        <Text size="13px">{channelOptionLabel(choice.channel)}</Text>
                        {choice.heldBy ? (
                            <Text size="11px" c="dimmed">
                                held by {choice.heldBy}
                            </Text>
                        ) : null}
                    </Menu.Item>
                ))}
                {declared.length === 0 && server.length === 0 ? (
                    <Menu.Item disabled>No text channels to put it in yet.</Menu.Item>
                ) : null}
            </Menu.Dropdown>
        </Menu>
    );
}
