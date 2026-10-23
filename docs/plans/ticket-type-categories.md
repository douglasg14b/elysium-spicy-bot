# Categories per ticket type

> **Status**: Built 2026-10-22; live run pending.
> **Owner**: Douglas

## The gap

Every ticket lives in the same three categories (open, claimed, closed), whatever its type. Douglas wants verification tickets under a verification category and support tickets under a support one, while still letting every type close into one shared "closed tickets".

## Decisions

From Douglas (2026-10-22):

- **The three server-wide categories stay, as defaults.** A type can swap in its own category for any of the three. A slot it leaves alone uses the server's.
- **Picked in the type's edit dialog**, next to its label, channel name and permissions.
- **A type's category can be a new name the bot makes**, as the defaults can.

My picks:

- **Stored as ticket-owned `resource_bindings` rows**, like the defaults, keyed `type:<typeKey>:<slot>`. So the journey fences see them, and a deleted category's recreate (`repointOwned`) already repoints every row that held it. Not in the `TicketTypeDefinition` blob: categories left the blob on 2026-10-10 precisely so the fences could see them, and the definition is also what a journey declares a type with.
- **Existing tickets stay where they are** until they next move (claim, unclaim, close, reopen). Same as changing a default today.
- **The type save and the settings save share one per-guild lock and one choreography** (check every pick, create, write once, re-check adopts on the write's transaction). Both create categories, so two at once could each make one.
- **The type save sends only the slots that changed.** An absent slot (or absent `categories`) is left as it is; `null` puts a slot back on the server default. That stops a stale dialog from resending an id the bot has since recreated, or undoing another tab's pick, and a label-only edit never touches categories or takes the lock. A journey's declared type is checked against the same zod and sends none.
- **Deleting a type deletes its category rows**, on the delete's own transaction. The categories themselves stay in Discord.
- **A journey's install never sets a type's categories.** It creates a type only if absent, with none.
- The deployed panel keeps listing the three defaults only.

## Shape

- `TicketingConfig.typeCategories` — assembled by `ticketingRepo` from the rows, stripped on write, like `categories`. A `Map`, so a type keyed `constructor` cannot find a prototype member.
- `ticketCategoryFor(config, type, slot)` — the one answer to "where does this ticket go", used by channel create, the state sync, and the recreate's re-read.
- `logic/ticketCategoryChoices.ts` — the shared check / create / write, lifted out of `setTicketSettings`.
- `upsertTicketType({ guildId, definition, categories? })` — when `categories` is given, also takes the guild and does the choreography; partly-saved refusals (`create-failed`, `taken-meanwhile`) carry the config, as settings do.
- Wire: `TicketTypeView.categories` (null per slot = server default), `TicketTypeUpdate.categories` (optional).
- Dashboard: three pickers in the type dialog, each offering "Server default", an existing category, or a new name; a column on the types table naming the slots a type overrides.
