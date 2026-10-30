import { useState } from 'react';
import { Button, Checkbox, Group, Modal, NumberInput, Select, Stack, Text } from '@mantine/core';
import { zSaveFlashChatChannelBody, type FlashChatChannel, type FlashChatSettings } from '@brattybot/web-sdk';
import { fieldProblems } from '../api/fieldProblems';
import { isTimerUnit, TIMER_UNITS, timerFromSeconds, timerToSeconds, type TimerUnit } from './flashChatTimer';

/** What the modal edits: a new channel (picked here), or one flash chat is already on in. */
export type FlashChatModalTarget =
    | { readonly kind: 'new' }
    | { readonly kind: 'existing'; readonly channel: FlashChatChannel };

interface ChannelOption {
    readonly value: string;
    readonly label: string;
}

interface FlashChatChannelModalProps {
    readonly target: FlashChatModalTarget;
    /** The text channels flash chat could be turned on in: not already on. */
    readonly channelOptions: readonly ChannelOption[];
    readonly saving: boolean;
    readonly onSave: (channelId: string, settings: FlashChatSettings) => void;
    readonly onClose: () => void;
}

interface Draft {
    readonly channelId: string | null;
    /** `''` while the field is empty. */
    readonly amount: number | '';
    readonly unit: TimerUnit;
    readonly preservePinned: boolean;
    readonly preserveHistory: boolean;
}

/**
 * Keeping history is the default for a new channel: leaving it off wipes what is already
 * there on save, which nobody should get by not reading a checkbox.
 */
const NEW_CHANNEL_DRAFT: Draft = {
    channelId: null,
    amount: 1,
    unit: 'hours',
    preservePinned: true,
    preserveHistory: true,
};

function draftFor(target: FlashChatModalTarget): Draft {
    if (target.kind === 'new') return NEW_CHANNEL_DRAFT;
    const { channel } = target;
    return {
        channelId: channel.channelId,
        ...timerFromSeconds(channel.timeoutSeconds),
        preservePinned: channel.preservePinned,
        preserveHistory: channel.preserveHistory,
    };
}

/**
 * Turn flash chat on in a channel, or change it. Mounted only while open, so each opening
 * starts from the target's saved settings. Nothing here is disabled while a save flies but
 * the buttons: an input being typed into must keep its focus.
 */
export function FlashChatChannelModal({ target, channelOptions, saving, onSave, onClose }: FlashChatChannelModalProps) {
    const [draft, setDraft] = useState<Draft>(() => draftFor(target));

    const settings =
        draft.amount === ''
            ? null
            : {
                  timeoutSeconds: timerToSeconds({ amount: draft.amount, unit: draft.unit }),
                  preservePinned: draft.preservePinned,
                  preserveHistory: draft.preserveHistory,
              };
    // The server's own rule and sentence, from the zod the SDK generates from its route.
    const check = settings ? zSaveFlashChatChannelBody.safeParse(settings) : null;
    const timerProblem = check ? fieldProblems(check).timeoutSeconds : undefined;
    const sendable = !!draft.channelId && !!check?.success;

    function handleSave() {
        if (!draft.channelId || !check?.success) return;
        onSave(draft.channelId, check.data);
    }

    return (
        <Modal
            opened
            onClose={onClose}
            title={
                target.kind === 'new'
                    ? 'Turn on flash chat'
                    : `Flash chat in #${target.channel.channelName ?? 'deleted-channel'}`
            }
            size="md"
        >
            <Stack gap="md">
                {target.kind === 'new' && (
                    <Select
                        label="Channel"
                        description="Text channels only, and only ones not already self-destructing."
                        placeholder="Pick a channel"
                        data={channelOptions.map((option) => ({ ...option }))}
                        value={draft.channelId}
                        onChange={(channelId) => setDraft({ ...draft, channelId })}
                        searchable
                        nothingFoundMessage="No text channels left to pick"
                        allowDeselect={false}
                        data-autofocus
                    />
                )}

                <div>
                    <Group gap="sm" align="flex-start" wrap="nowrap">
                        <NumberInput
                            label="Delete messages after"
                            min={1}
                            allowDecimal={false}
                            allowNegative={false}
                            value={draft.amount}
                            onChange={(amount) => setDraft({ ...draft, amount: typeof amount === 'number' ? amount : '' })}
                            error={timerProblem}
                            flex={1}
                        />
                        <Select
                            label="Unit"
                            data={TIMER_UNITS.map((unit) => ({ value: unit.value, label: unit.label }))}
                            value={draft.unit}
                            onChange={(unit) => {
                                if (isTimerUnit(unit)) setDraft({ ...draft, unit });
                            }}
                            allowDeselect={false}
                            w={130}
                        />
                    </Group>
                    <Text size="12px" c="dimmed" mt={4}>
                        Up to 14 days. Every message gets this long, then it&apos;s gone.
                    </Text>
                </div>

                <Checkbox
                    label="Keep pinned messages"
                    description="Pin the rules and they survive the purge."
                    checked={draft.preservePinned}
                    onChange={(event) => setDraft({ ...draft, preservePinned: event.currentTarget.checked })}
                />
                <Checkbox
                    label="Keep what's already in the channel"
                    description="Untick it and saving wipes every message already there that's older than the timer."
                    checked={draft.preserveHistory}
                    onChange={(event) => setDraft({ ...draft, preserveHistory: event.currentTarget.checked })}
                />

                <Group justify="flex-end" gap="sm">
                    <Button variant="subtle" color="gray" onClick={onClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button color="brand" loading={saving} disabled={!sendable} onClick={handleSave}>
                        {target.kind === 'new' ? 'Turn on' : 'Save changes'}
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
}
