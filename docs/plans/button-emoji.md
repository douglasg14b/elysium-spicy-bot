# Emoji on message buttons

A message resource's button can carry an emoji beside its label, the way MEE6's button editor offers one. It can be a standard emoji or one of the server's own. Builds on the message resource (`message-resource-step-2.md`) and Button Click's "+ New button" (`message-resource-step-3.md`).

## Douglas's answers (2026-10-26)

| Question | Answer |
| --- | --- |
| Which emoji? | Standard **and** the server's own custom emoji, animated included. |
| Emoji-only button, with no label? | Yes. A button needs a label or an emoji, at least one. |
| How is one picked? | A searchable grid, like Discord's (one new package). |
| A server emoji used by a button is deleted | Quietly post the button without it; install carries on. |

## My calls (Douglas approved all six, 2026-10-26; the `:name:` fallback by choice over the key)

1. **An emoji-only button whose server emoji is gone posts `:name:` as its label.** This is where two of the answers meet: with no label and the emoji dropped, Discord would refuse the button, and so the whole message. The stored name keeps it pressable and says what used to be there. Every drop logs `[provisioning] posted button <key> without its emoji <id> — gone from the server`.
2. **The dashboard says so too.** The button box shows "This emoji's gone from the server — it'll post without it" when the server's emoji list lacks the id. It isn't a save problem: refusing would block every unrelated edit to the journey until someone re-picked an emoji.
3. **Only this server's emoji post.** The save accepts any well-formed custom emoji, but install drops one that isn't in this server's emoji (the bot could otherwise show one from another server it's in).
4. **Drift.** An emoji change makes a posted message "out of date", and Repair edits it in place, like a label change. A gone emoji is not drift: the declaration didn't change.
5. **The bot listens for emoji changes** (`GuildExpressions`, a non-privileged intent), so an emoji added after startup shows up in the picker without a restart.
6. **Sentences that name a button** (claims, refusals, drift, the install note) call it by its label, else its emoji, else its key, so an emoji-only button never reads as `""`.

## The shape

Discord's own partial emoji, which the TestDiscord fake already accepts:

```ts
interface MessageButton {
    readonly key: string;
    readonly label?: string;          // 1–80 when present
    readonly style: MessageButtonStyle;
    readonly emoji?: MessageButtonEmoji;
}
// standard: { name: '🌶️' }   server: { id: '123…', name: 'blobheart', animated: false }
interface MessageButtonEmoji { readonly name: string; readonly id?: string; readonly animated?: boolean }
```

`.optional()`, never nullable: `canonicalJson` drops `undefined` but hashes `null`, so an absent emoji leaves every existing message's digest as it is (the pinned hash in `messageDrift.test.ts` proves it). No migration: nothing stored changes shape.

## Slice A — server

1. `MessageButton` (`provisioning/logic/messageButtons.ts`) and `MessageButtonSchema` (`journeyBody.ts`) together (`SchemaMatches` holds them). Custom id: digits, 17–20; custom name: Discord's `[A-Za-z0-9_]{2,32}`.
2. Two rules the spec can't carry, in `messageResourceProblems` and its browser mirror, with rows in `messageResourceProblemsDrift.test.ts`: a label or an emoji, at least one; a standard emoji's `name` is one emoji. `holdsCopyToken(button.label)` copes with no label on both sides.
3. `messageDigest` adds `emoji` to its pick.
4. `buildButtonRows` takes the server's emoji ids: `setLabel` only with a label, `setEmoji` with a present emoji, call 1's fallback and log otherwise. Both callers (`applyInstallPlan`, `prepareMessageEdit`) pass them.
5. `buttonDisplayName` in `messageButtons.ts`, used by `buttonClaims`, `messageButtonReferences`, `journeyDriftPlan`, `installPlan`, and `lookupBoundMessage`'s read-back.
6. `GET /api/guilds/{guildId}/emojis` → `{ emojis: { id, name, animated }[] }` from the cache, on the roles route's pattern; general budget (`EXPECTED_BUDGET`), not a Discord read. `GuildExpressions` intent in `discordClient.ts`.
7. TestDiscord: guild emoji state, seeded into `GUILD_CREATE`, for the route test and the gone-emoji test.
8. `pnpm sdk:generate`.

Tests: an emoji-only button posts with no label; a gone emoji drops (and an emoji-only one posts `:name:`); an emoji change drifts and repairs; the pinned digest holds; the route lists the seeded emoji and hides another server's. Sabotage the digest pin and the label-or-emoji rule.

## Slice B — dashboard

1. `pnpm add emoji-picker-react` in `web/`; confirm its `customEmojis` and click payload from its types, not the README. Lazy-loaded inside the popover; dark; native glyphs; the server's emoji in their own "This server" group, drawn from `cdn.discordapp.com/emojis/<id>.webp` (`.gif` when animated).
2. `ButtonEmojiField` in `ButtonFields.tsx`: a square showing the emoji (or a smiley placeholder), the grid on click, a ✕ to clear (which deletes the key). Used by the button box and "+ New button".
3. The emoji on every face: the editor's buttons (`ButtonRow`, edit and read-only), the trigger's button picker (`MessageButtonControl`) and the Button Click card (`cardSummary.ts`, which today shows `''` for no label). `BUTTON_FACE` becomes inline-flex.
4. The label stops being required: `BUTTON_LABEL_RULE` unwraps the optional; "+ New button" adds once it has a label or an emoji; an emoji-only new button takes its key from the custom emoji's name, else `button`.
5. The emoji list threaded to the editor (`ResourcesPanel` → `EditorScope`) and the builder (`FlowBuilderPage` → `ControlContext`).

Tests: e2e — pick a standard and a server emoji, clear one, make an emoji-only button, see the gone note. Screenshots at 1280 and 1440.

## As built — slice A

- The server-emoji name rule (`[A-Za-z0-9_]{2,32}`), "one standard emoji" (Unicode's RGI emoji set, `isOneEmoji`) and "only a server emoji is animated" live in `messageResourceProblems` and its browser mirror, not the schema: one emoji object's `name` takes both a glyph and `blobheart`, and the spec can't carry a rule that depends on `id`.
- A label present but blank reads "A button's label can't be blank — write one, or leave it off and let the emoji talk." Slice B deletes the key when the field is emptied.
- `prepareMessageEdit` takes the server's emoji ids, not the guild. `applyMessage` builds the whole message before its send's `try`.
- **Known limit of call 4:** an emoji dropped while the server had lost the boosts paying for it (`available: false`) isn't put back when they return, because the declaration didn't change. Repair after any edit to the message puts it back.
- TestDiscord seeds server emoji before `start()` only; "gone" is an id the server never held.
- Slice B must send `animated` for a server emoji every time and never for a standard one: the digest hashes what's sent, so `animated: false` vs absent would read as "out of date".

## As built — slice B

- The grid is `messageEditor/EmojiGrid.tsx`, lazy-loaded by `ButtonEmojiField` (its own chunk, ~334 kB), capped at Emoji 15.0. Its popover sits inside the box's DOM (`withinPortal={false}`); the box and "+ New button" close on Escape on the way up, so the first Escape shuts the grid, the next the box. The real grid's own Escape clears a typed search first.
- **The grid hides any emoji whose picture fails to load** (emoji-picker-react's behaviour), so a server emoji Discord's CDN won't serve — a hiccup, or a role-locked one if that's how Discord answers — quietly drops out of "This server". Worth watching in the live run's last item.
- Names vs faces: `buttonDisplayName` (`web/src/flows/buttonEmoji.ts`, held to the server's by `buttonDisplayNameDrift.test.ts`) names a button in the picker's input and a face's accessible name; the Button Click card shows the face as text, emoji before label (`buttonFaceText`: `Rules panel · 😈 Let me in`).
- A face whose server emoji picture won't load (deleted, most often) draws its `:name:` instead of a broken picture (`EmojiGlyph`); the box's note says it'll post without it.
- Tests stand the grid in at its package: `web/src/__tests__/support/stubEmojiPicker.tsx` (clicks shaped as the installed `EmojiClickData`), mounted with `vi.mock` as its JSDoc shows.

## Not in this step

Ticket buttons (their emoji are fixed in code), the Reaction Added trigger's emoji text field, and Post Embed (it has no buttons).

## Live run (Douglas)

Post a message with a standard-emoji button, a server-emoji button and an emoji-only one; press each. Change one's emoji → "out of date" → Repair. Delete the server emoji → Repair → the button posts without it (emoji-only: as `:name:`). Add a new server emoji → it's in the picker without a restart. Lock a server emoji to a role the bot doesn't have and post a button with it: if Discord refuses the message, the picker and install must leave role-locked emoji out (`serverEmojiIds`).
