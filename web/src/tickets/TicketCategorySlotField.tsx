import { Select, Stack, Text, TextInput } from '@mantine/core';
import type { GuildChannel, TicketCategoryView } from '@brattybot/web-sdk';
import {
    CATEGORY_SLOT_COPY,
    CREATE_NEW_CATEGORY,
    SERVER_DEFAULT_CATEGORY,
    categorySlotNote,
    categorySlotOptions,
    serverDefaultOption,
    typeCategoryProblem,
    type CategorySlotDraft,
    type TicketCategorySlot,
    type TypeCategoryDraft,
} from './categorySlots';

interface CommonProps {
    readonly slot: TicketCategorySlot;
    readonly view: TicketCategoryView | null;
    readonly channels: readonly GuildChannel[];
}

/**
 * A server-wide slot, which is always some category; or a type's own, which may also be
 * "the server's" — offered, naming the category it is, only when `serverDefault` is
 * given, so only that field's `onChange` can be handed a `default` draft.
 */
type TicketCategorySlotFieldProps = CommonProps &
    (
        | {
              readonly serverDefault?: undefined;
              readonly draft: CategorySlotDraft;
              readonly onChange: (draft: CategorySlotDraft) => void;
          }
        | {
              readonly serverDefault: { readonly view: TicketCategoryView | null };
              readonly draft: TypeCategoryDraft;
              readonly onChange: (draft: TypeCategoryDraft) => void;
          }
    );

function pickerValueOf(draft: TypeCategoryDraft): string | null {
    switch (draft.mode) {
        case 'default':
            return SERVER_DEFAULT_CATEGORY;
        case 'create':
            return CREATE_NEW_CATEGORY;
        case 'existing':
            return draft.discordId;
        default: {
            const unhandled: never = draft;
            throw new Error(`Unhandled category draft: ${JSON.stringify(unhandled)}`);
        }
    }
}

/**
 * One category slot: pick an existing category, or name a new one for the bot to make —
 * and, for a type's own slot, go back to the server's.
 *
 * Never `disabled` while a save is in flight — the name field is typed into, and
 * disabling it mid-word steals focus.
 */
export function TicketCategorySlotField(props: TicketCategorySlotFieldProps) {
    const { slot, view, channels, draft } = props;
    const copy = CATEGORY_SLOT_COPY[slot];
    const note = categorySlotNote(view);
    const options = categorySlotOptions(channels, view);

    function pick(value: string | null): void {
        if (value === SERVER_DEFAULT_CATEGORY) {
            if (props.serverDefault) props.onChange({ mode: 'default' });
            return;
        }
        props.onChange(
            value === CREATE_NEW_CATEGORY
                ? { mode: 'create', name: draft.mode === 'create' ? draft.name : view?.name ?? '' }
                : { mode: 'existing', discordId: value }
        );
    }

    return (
        <Stack gap={6}>
            <Select
                label={copy.label}
                description={copy.description}
                placeholder="Pick a category, or create one"
                data={props.serverDefault ? [serverDefaultOption(props.serverDefault.view), ...options] : options}
                value={pickerValueOf(draft)}
                onChange={pick}
                searchable
                nothingFoundMessage="No category by that name. Pick “Create a new category…” to make one."
                allowDeselect={false}
            />
            {draft.mode === 'create' && (
                <TextInput
                    aria-label={`New category name for ${copy.label.toLowerCase()}`}
                    placeholder="What should the bot call it?"
                    value={draft.name}
                    onChange={(event) => props.onChange({ mode: 'create', name: event.currentTarget.value })}
                    error={typeCategoryProblem(draft)}
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
