/**
 * The ticket settings page's category slots: what the form holds, and what it sends.
 *
 * Each slot is either an **existing** category, chosen by id, or a **new** one, chosen by
 * the name it should be created under. The two never share a string: the picker's value is
 * an id or the create sentinel, and the typed name lives in its own field — a display name
 * that doubles as a binding is how two same-named categories get confused.
 *
 * Kept here rather than in the page because these are the answers worth testing; the
 * component around them is layout.
 */

import type {
    GuildChannel,
    TicketCategoryChoice,
    TicketCategorySlot,
    TicketCategoryView,
} from '../api/types';
import { channelOptionLabel } from '../flows/resourceAdoption';

/** The picker value meaning "make a new category". Not a snowflake, so it cannot collide with one. */
export const CREATE_NEW_CATEGORY = '__create__';

export type CategorySlotDraft =
    | { readonly mode: 'existing'; readonly discordId: string | null }
    | { readonly mode: 'create'; readonly name: string };

export const CATEGORY_SLOT_COPY: Readonly<Record<TicketCategorySlot, { label: string; description: string }>> = {
    open: { label: 'Open tickets', description: 'Where a fresh ticket lands.' },
    claimed: { label: 'Claimed tickets', description: 'Where it goes once somebody owns it.' },
    closed: { label: 'Closed tickets', description: 'Where it rests. Closed is not deleted.' },
};

/**
 * The form's starting point for a slot.
 *
 * A slot linked to nothing yet starts with nothing picked — even when it remembers a name.
 * Preselecting the category of that name would be the name-matching #22 removed, done in
 * the browser instead of the bot; the page names it and lets the operator pick.
 */
export function draftFromView(view: TicketCategoryView | null): CategorySlotDraft {
    return { mode: 'existing', discordId: view?.discordId ?? null };
}

/**
 * What to send for a slot: only what the operator changed.
 *
 * An unchanged slot sends `null`, "leave it as it is", rather than its loaded id. Sending
 * the id back would have a stale tab — say one only editing roles — overwrite a category
 * another tab re-picked since it loaded, or re-send an id the bot has since replaced
 * after a deletion and get a refusal for a save that never touched categories.
 */
export function choiceFromDraft(draft: CategorySlotDraft, view: TicketCategoryView | null): TicketCategoryChoice {
    if (draft.mode === 'create') return { name: draft.name.trim() };
    if (!draft.discordId || draft.discordId === view?.discordId) return null;
    return { discordId: draft.discordId };
}

/** Why a slot cannot be saved as it stands, or undefined. */
export function categorySlotProblem(draft: CategorySlotDraft): string | undefined {
    if (draft.mode === 'create' && !draft.name.trim()) return 'Name the new category, or pick an existing one.';
    return undefined;
}

/**
 * The picker's options: "create one", then the guild's categories.
 *
 * A bound category Discord no longer has is kept as an option of its own, so the slot
 * does not render blank and the operator can see what will happen: the bot remakes it
 * under its expected name the next time a ticket needs it.
 */
export function categorySlotOptions(
    channels: readonly GuildChannel[],
    view: TicketCategoryView | null
): { value: string; label: string }[] {
    const categories = channels
        .filter((channel) => channel.type === 'category')
        .map((channel) => ({ value: channel.id, label: channelOptionLabel(channel) }));

    const options = [{ value: CREATE_NEW_CATEGORY, label: 'Create a new category…' }, ...categories];

    if (view?.discordId && !categories.some((option) => option.value === view.discordId)) {
        options.push({
            value: view.discordId,
            label: `Deleted — comes back as “${view.name}” with the next ticket`,
        });
    }

    return options;
}

/**
 * A line under the slot when its state needs saying, or undefined.
 *
 * Two cases. A slot linked to nothing yet stops every ticket until it is linked, so it is
 * named loudly. A renamed category is harmless now — routing is by id — but which name
 * the bot would remake it under is worth knowing.
 */
export function categorySlotNote(view: TicketCategoryView | null): string | undefined {
    if (!view) return undefined;
    if (!view.discordId) {
        return `Not linked to a category yet, so tickets are paused. It was set to “${view.name}” — pick that category below, or create a new one.`;
    }
    if (view.liveName && view.liveName !== view.name) {
        return `Discord calls it “${view.liveName}” now. If it is ever deleted, the bot remakes it as “${view.name}”.`;
    }
    return undefined;
}
