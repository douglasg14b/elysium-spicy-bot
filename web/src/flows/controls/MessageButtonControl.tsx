/**
 * The `messageButton` control: one button on one of the messages the flow's journey declares,
 * stored as the two keys `{ messageKey, buttonKey }` (mockup `message-editor.mockup.html`,
 * section 4).
 *
 * Pick a message, then one of its buttons — each drawn in its Discord style, with who listens
 * to it. One flow per button: a button another flow listens to is shown, greyed, naming that
 * flow, and cannot be picked; the server refuses switching on a flow whose button is taken all
 * the same, so this is the author never having to meet that refusal.
 *
 * Either can be made on the spot. "+ New button on this message" and "+ New message in…" write
 * into the journey's Resources through `declareResources` — a button exists only on a message
 * resource, so the message window shows what was made here — and the new button is picked in
 * the same click.
 *
 * It is not a resource picker: it writes no `<field>Key` sidecar, and nothing is written back at
 * install, because a press finds its message through the message's binding.
 */

import { useState } from 'react';
import { Button, Group, Input, Menu, Popover, Select, Stack, Text } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import type {
    BlockConfigField,
    MessageButton,
    MessageButtonStyle,
    ResourceDeclaration,
} from '@brattybot/web-sdk';
import { buttonHolder, readButtonPick, type ButtonHolder } from '../buttonListeners';
import { ButtonLabelField, ButtonStyleField } from '../messageEditor/ButtonFields';
import { BUTTON_FACE, BUTTON_STYLES } from '../messageEditor/discordLook';
import { BUTTON_LABEL_RULE, MAX_BUTTONS } from '../messageEditor/partRules';
import {
    addButtonToMessage,
    declareMessageIn,
    newMessageChannels,
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

/**
 * Pick a message, then one of its buttons.
 *
 * Changing the message clears the stored pick until a button of the new one is chosen: a
 * message key alone names nothing a press could match. A stored key the journey no longer
 * declares stays shown, marked, rather than going blank — the readiness issue under the field
 * says what to do about it.
 */
export function MessageButtonControl({ field, value, onChange, context, error }: ControlProps<MessageButtonField>) {
    const pick = readButtonPick(value);
    // A message chosen whose button is not picked yet. Ignored once a pick is stored.
    const [choosing, setChoosing] = useState<string | null>(null);
    // Whether "+ New button" is open — also opened by a new message, whose first button it asks for.
    const [addingButton, setAddingButton] = useState(false);
    const messageKey = pick?.messageKey ?? choosing;

    const declared = context.declaredResources;
    const messages = declared.filter((resource) => resource.kind === 'message');
    const message = messages.find((candidate) => candidate.key === messageKey);
    const buttons: readonly MessageButton[] = message?.buttons ?? [];

    const messageOptions = messages.map((candidate) => ({ value: candidate.key, label: candidate.defaultName }));
    if (messageKey && !message) {
        messageOptions.push({ value: messageKey, label: `${messageKey} — not in this journey's resources` });
    }

    const holders = new Map<string, ButtonHolder>(
        message
            ? buttons.map((button) => [
                  button.key,
                  buttonHolder(context.listeners, { messageKey: message.key, buttonKey: button.key }),
              ])
            : []
    );
    const buttonOptions = buttons.map((button) => {
        const holder = holders.get(button.key);
        // Somebody else's, or another trigger's in this flow: one press starts one run.
        const taken = holder?.kind === 'otherFlows' || holder?.kind === 'thisFlow';
        return { value: button.key, label: button.label, disabled: taken };
    });
    if (pick && message && !buttons.some((button) => button.key === pick.buttonKey)) {
        buttonOptions.push({ value: pick.buttonKey, label: `${pick.buttonKey} — not on this message any more`, disabled: false });
    }

    const pickMessage = (next: string) => {
        setChoosing(next);
        setAddingButton(false);
        // The old pick names a button of another message; it goes until one of this
        // message's buttons is picked.
        if (pick && pick.messageKey !== next) onChange(undefined);
    };

    const noMessagesYet = messages.length === 0 && !messageKey;

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
                            value={messageKey ?? null}
                            onChange={(next) => {
                                if (next && next !== messageKey) pickMessage(next);
                            }}
                            renderOption={({ option }) => {
                                const candidate = messages.find((entry) => entry.key === option.value);
                                return (
                                    <div>
                                        <Text size="13px">{option.label}</Text>
                                        {candidate ? (
                                            <Text size="11px" c="dimmed">
                                                {postedIn(candidate, declared)}
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
                            placeholder={messageKey ? 'Pick a button' : 'Pick a message first'}
                            // Red, with the sentence under the pair rather than under this one.
                            error={!!error}
                            data={buttonOptions}
                            value={pick?.buttonKey ?? null}
                            onChange={(next) => {
                                if (!next || !messageKey) return;
                                onChange({ messageKey, buttonKey: next });
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
                    </>
                )}
                {error ? <Input.Error>{error}</Input.Error> : null}

                {/* Side by side where they fit; stacked close where the inspector is too narrow. */}
                <Group gap={14} style={{ rowGap: 2 }}>
                    {message && buttons.length < MAX_BUTTONS ? (
                        <NewButtonPopover
                            opened={addingButton}
                            onOpenedChange={setAddingButton}
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
                            pickMessage(created.messageKey);
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
            <span style={{ ...BUTTON_FACE, fontSize: 12.5, padding: '4px 11px', background: BUTTON_STYLES[button.style].colour }}>
                {button.label}
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
    readonly onAdd: (button: { readonly label: string; readonly style: MessageButtonStyle }) => void;
}

/** "+ New button on this message": a label and a style, then Add. */
function NewButtonPopover({ opened, onOpenedChange, onAdd }: NewButtonPopoverProps) {
    const [label, setLabel] = useState('');
    const [style, setStyle] = useState<MessageButtonStyle>('Primary');
    const trimmed = label.trim();
    const problem = trimmed ? BUTTON_LABEL_RULE.problem(trimmed) : undefined;

    const close = () => {
        onOpenedChange(false);
        setLabel('');
        setStyle('Primary');
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
            <Popover.Dropdown p={12}>
                <Stack gap={10}>
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
                            disabled={!trimmed || !!problem}
                            onClick={() => {
                                onAdd({ label: trimmed, style });
                                setLabel('');
                                setStyle('Primary');
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
