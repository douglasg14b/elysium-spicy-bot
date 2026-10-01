import { Select, Stack, Text, TextInput } from '@mantine/core';
import type { GuildChannel, TicketCategorySlot, TicketCategoryView } from '../api/types';
import {
    CATEGORY_SLOT_COPY,
    CREATE_NEW_CATEGORY,
    categorySlotNote,
    categorySlotOptions,
    categorySlotProblem,
    type CategorySlotDraft,
} from './categorySlots';

interface TicketCategorySlotFieldProps {
    readonly slot: TicketCategorySlot;
    readonly view: TicketCategoryView | null;
    readonly channels: readonly GuildChannel[];
    readonly draft: CategorySlotDraft;
    readonly onChange: (draft: CategorySlotDraft) => void;
}

/**
 * One category slot: pick an existing category, or name a new one for the bot to make.
 *
 * Never `disabled` while a save is in flight — the name field is typed into, and
 * disabling it mid-word steals focus.
 */
export function TicketCategorySlotField({ slot, view, channels, draft, onChange }: TicketCategorySlotFieldProps) {
    const copy = CATEGORY_SLOT_COPY[slot];
    const note = categorySlotNote(view);
    const pickerValue = draft.mode === 'create' ? CREATE_NEW_CATEGORY : draft.discordId;

    return (
        <Stack gap={6}>
            <Select
                label={copy.label}
                description={copy.description}
                placeholder="Pick a category, or create one"
                data={categorySlotOptions(channels, view)}
                value={pickerValue}
                onChange={(value) =>
                    onChange(
                        value === CREATE_NEW_CATEGORY
                            ? { mode: 'create', name: draft.mode === 'create' ? draft.name : view?.name ?? '' }
                            : { mode: 'existing', discordId: value }
                    )
                }
                searchable
                nothingFoundMessage="No category by that name. Pick “Create a new category…” to make one."
                allowDeselect={false}
            />
            {draft.mode === 'create' && (
                <TextInput
                    aria-label={`New category name for ${copy.label.toLowerCase()}`}
                    placeholder="What should the bot call it?"
                    value={draft.name}
                    onChange={(event) => onChange({ mode: 'create', name: event.currentTarget.value })}
                    error={categorySlotProblem(draft)}
                    description="Made on save, hidden from everyone but the bot and your moderation roles."
                />
            )}
            {note && (
                <Text size="12.5px" c={view?.discordId ? 'dimmed' : 'yellow.5'}>
                    {note}
                </Text>
            )}
        </Stack>
    );
}
