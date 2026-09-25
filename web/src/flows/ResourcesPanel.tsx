/**
 * Declare the guild objects a flow needs — whether or not it already has them.
 *
 * This is the authoring surface for what provisioning installs. A resource declared
 * here is offered by the pickers immediately — the point of the whole feature is that
 * building a flow no longer requires creating its channels by hand first.
 *
 * A resource is one of two things and the panel says so up front: something to
 * **create**, or something that **already exists** and should be adopted. The second
 * is not a different kind of resource — it is the same declaration carrying an
 * `adoptDiscordId`, which the install plan turns into an `adopt` rather than a
 * `create`. Declaring "this flow needs #announcements, which we already have" was
 * unsayable before that field existed.
 *
 * The panel never says "journey". A flow's journey is implicit, keyed on the flow's
 * own id, so the operator declares what this flow needs and the scope follows from
 * that. Grouping several flows under one journey is deferred (PRD §5.8 item 39).
 *
 * It lives in a modal off the toolbar rather than in the right-hand column. That
 * column is for the *selected node's* configuration; a flow-wide concern sharing it
 * meant selecting a block showed nothing while resources were open. Permission
 * editing also wants more width than 300px.
 *
 * **Sizing is deliberate and is not sidebar density.** Everything here was `xs` with
 * 12px text while the panel lived in a 300px column; moving to a modal kept the
 * cramped sizing and made it hard to read on a normal monitor. Inputs are `sm` and
 * labels are default body size. Do not shrink them back.
 *
 * ## Why rows collapse
 *
 * Every row used to be expanded, always. Fourteen resources — an ordinary flow — made
 * a four-thousand-pixel scroll in which two save-blocking errors were invisible, and
 * the operator met them as a server banner after pressing save. A row is now one line
 * carrying its **chips**, and opens only when asked.
 *
 * The chips are the compensation for what collapsing hides, and they are deliberately
 * quiet: `detectResourceProblems` gives a row a chip only when it is not the default,
 * not already visible structurally, and something you would act on. Silence means
 * normal. `docs/contracts/resource-chips.md` records the vocabulary and, more usefully,
 * the five candidates rejected for failing that rule — a kind badge and `in <category>`
 * among them, which is why neither appears here.
 *
 * ## Why field descriptions moved into the expanded body
 *
 * They are the reason the old layout could not be scanned: five lines of explanatory
 * text per row, thirty rows, and the one row with a problem looked exactly like the
 * twenty-nine without one. They are not deleted — a key's permanence and an adopted
 * channel's untouched permissions are things an operator genuinely needs told — they
 * are told at the point of editing, which is where the question is actually asked.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
    ActionIcon,
    Alert,
    Autocomplete,
    Box,
    Button,
    Collapse,
    Divider,
    Group,
    Select,
    Stack,
    Text,
    TextInput,
    Tooltip,
    UnstyledButton,
} from '@mantine/core';
import {
    IconChevronDown,
    IconChevronRight,
    IconLink,
    IconSearch,
    IconTrash,
    IconX,
} from '@tabler/icons-react';
import type {
    GuildChannel,
    GuildRole,
    ResourceDeclaration,
    ResourceKind,
} from '../api/types';
import { detectResourceProblems } from './detectResourceProblems';
import type { ResourceChipInstance } from './detectResourceProblems';
import { PermissionIntentEditor } from './PermissionIntentEditor';
import { ResourceChip } from './ResourceChip';
import {
    adoptableChannelOptions,
    adoptableRoleOptions,
    canAdopt,
    canHaveParent,
    declarationForAdoptedResource,
    declarationForNewResource,
} from './resourceAdoption';
import { RESOURCE_CHIPS } from './resourceChips';
import { keyForRenamedResource, keyIsStillDerived } from './resourceKeyFollowsName';
import { disambiguateOptions, rankSuggestions } from './resourceNameSuggestions';
import type { ResourceChipJumpTarget } from './resourceChips';
import { RESOURCE_KIND_ORDER, RESOURCE_KIND_STYLES } from './resourceMeta';
import {
    applyResourcePatch,
    filterResourceRows,
    orderResourceRows,
    removeResourceAtIndex,
} from './resourceRows';

/**
 * How far a channel sits in from its category.
 *
 * The mockup's 22px. Enough to read as containment at a glance without pushing the
 * name so far right that the chips lose their column.
 */
const CHILD_INDENT_PX = 22;

/**
 * How many suggestions the name box offers at once.
 *
 * A large guild has hundreds of channels, and an empty query matches all of them — the
 * state a freshly opened row is in. The list is ranked, so the cut falls on the worst
 * matches; what it protects is a dropdown taller than the modal on the one interaction
 * where the operator has given us nothing to narrow by.
 */
const SUGGESTION_LIMIT = 20;

interface ResourcesPanelProps {
    resources: ResourceDeclaration[];
    onChange: (next: ResourceDeclaration[]) => void;
    /** Real roles in the guild, for permission rules that name one. */
    roles: GuildRole[];
    /** Real channels in the guild, so a resource can adopt one instead of creating it. */
    channels: GuildChannel[];
    /**
     * Set while an autosave is in flight. **Deliberately not `disabled`.**
     *
     * It used to be, and that was the whole of the typing bug: the panel saved on every
     * keystroke, so every keystroke disabled the field it had just been typed into. HTML's
     * **focus fixup rule** then applies — when the focused area stops being focusable, the
     * document's viewport becomes the focused area — so the browser takes the cursor away
     * and nothing on the React side can decline. Each character cost the cursor.
     *
     * Browsers differ only in where focus lands (Chrome drops to `body`, Safari and
     * Firefox move to the next control), which is worth knowing because it means the bug
     * presents slightly differently per browser but is never absent.
     *
     * Saving is now debounced and continues in the background, which means it can land
     * *while* a field is focused. Disabling on it would reintroduce exactly the same
     * blur, only intermittently — a worse bug than the one it replaced, because it would
     * depend on typing speed and network latency and so would not reproduce on demand.
     *
     * There is nothing to protect against by locking the form: an edit during a save is
     * ordinary, and `useResourceAutosave` already refuses to let a response overwrite a
     * list that is newer than it. The flag is a quiet indicator, not a gate.
     */
    saving?: boolean;
    /** A rejected save, shown verbatim — the server's message names the real problem. */
    error?: string;
    /**
     * Resource keys that already have something live in the guild.
     *
     * Only used to decide whether a rename may carry the key with it — see
     * `resourceKeyFollowsName.ts`. Absent means "we could not find out", which narrows that
     * rule to its hand-edit half rather than disabling it.
     */
    installedKeys?: ReadonlySet<string>;
    /**
     * Whose declarations these are, for the one sentence that has to say so.
     *
     * The same discriminator `summarisePublished` takes and for the same reason: everything
     * else in this panel is identical for both scopes, and a forked component would be a
     * second place to make every future copy change. Defaults to `flow`, which is what the
     * builder has always meant.
     */
    scope?: 'flow' | 'journey';
}

/**
 * Which field a jump should land on, once the row holding it has opened.
 *
 * Carried as state rather than acted on directly because opening the row and focusing
 * inside it cannot happen in the same tick: the click sets `expanded`, and the field is
 * only reachable once React has committed that render. The row claims the request on
 * its next render, focuses, and clears it.
 *
 * Note this is a *render* ordering problem, not a mounting one. Mantine's `Collapse`
 * keeps its children mounted and hides them with `height: 0; overflow: hidden` — it
 * returns `null` only when `duration` is 0, which needs `respectReducedMotion`, and the
 * theme does not set it. So the ref is attached even while the row is shut, and
 * focusing early would scroll to something invisible rather than fail outright. The
 * handshake is still required; do not conclude from a populated ref that it is not.
 */
interface PendingJump {
    readonly index: number;
    readonly target: ResourceChipJumpTarget;
    /** Which rule row, for the `rule` target. */
    readonly ruleIndex?: number;
}

export function ResourcesPanel({
    resources,
    onChange,
    roles,
    channels,
    saving,
    error,
    installedKeys,
    scope = 'flow',
}: ResourcesPanelProps) {
    const [filter, setFilter] = useState('');
    /**
     * Which rows are open, by list position.
     *
     * Position rather than key, for the same reason `updateResource` patches by
     * position: the key is editable, so a set keyed by it would lose track of the open
     * row on the first keystroke into the key field.
     */
    const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
    const [pendingJump, setPendingJump] = useState<PendingJump | undefined>(undefined);
    /** A freshly added row, whose name field should take focus once it mounts. */
    const [pendingNameFocus, setPendingNameFocus] = useState<number | undefined>(undefined);

    const categories = resources.filter((resource) => resource.kind === 'category');
    const declaredRoles = resources.filter((resource) => resource.kind === 'role');

    // One detection pass per render, keyed by position. Three of the checks are
    // relational — duplicate keys, duplicate adoptions, role references naming a key
    // the flow does not declare — so this cannot be done a row at a time.
    // The directory is handed in so `nameTaken` can fire — the one detection that is
    // about the guild rather than the declaration, and the reason the parameter is
    // optional there (the cross-boundary agreement test has no guild to pass).
    const detected = useMemo(
        () => detectResourceProblems(resources, { channels, roles }),
        [resources, channels, roles]
    );
    const chipsByIndex = useMemo(() => {
        const byIndex = new Map<number, readonly ResourceChipInstance[]>();
        for (const entry of detected) byIndex.set(entry.index, entry.chips);
        return byIndex;
    }, [detected]);

    const rows = useMemo(
        () => filterResourceRows(orderResourceRows(resources), filter),
        [resources, filter]
    );

    /**
     * Patch by position, not by key.
     *
     * The key is itself editable, so matching on it would break the moment an operator
     * typed into the key field: the first keystroke changes the value being matched
     * against, and every later keystroke would find no row.
     */
    function updateResource(index: number, patch: Partial<ResourceDeclaration>) {
        // Both halves of this — rewriting references when a key changes, and treating an
        // explicit `undefined` as a deletion — live in `applyResourcePatch`, where the
        // suite can drive them. They are the two ways a patch can silently corrupt a
        // declaration, so neither should be verifiable only by rendering the panel.
        onChange(applyResourcePatch(resources, index, patch));
    }

    function removeResource(index: number) {
        const removed = resources[index];
        if (!removed) return;

        // Open rows are tracked by position, so removing one shifts every row after it.
        // Left alone, the set would reopen whichever resource slid into the gap.
        setExpanded((current) => shiftPositionsAfterRemoval(current, index));

        // A jump or a focus request is aimed at a position, and the row that position
        // named has just gone. Left set, the index now points at whichever resource slid
        // up into it — which is not expanded, so the focus effect returns early without
        // clearing the request, parking it until some later expansion steals focus for
        // no reason the operator can connect to anything they did.
        setPendingJump(undefined);
        setPendingNameFocus(undefined);

        // Clearing the references a deleted resource leaves behind lives beside the
        // rename in `resourceRows.ts`, so both halves of "no declaration may reference
        // a key nothing declares" are enforced in one tested place.
        onChange(removeResourceAtIndex(resources, index));
    }

    /**
     * Rename a resource, carrying its key along while the key is still derived.
     *
     * Its own handler rather than a plain `updateResource({ defaultName })` because a
     * rename is **two** fields when the key has never been claimed. The old behaviour
     * slugified the key once at creation, so adding a channel and then naming it — the
     * first thing anyone does, since rows are seeded with a generated name — left the key
     * reading `new-channel` forever, invisibly, because the key field is collapsed.
     *
     * Every rule about *when* the key may follow is in `resourceKeyFollowsName.ts`, where
     * the suite can drive it: a hand-edited key is left alone permanently, an installed one
     * is frozen because `resource_bindings` and node sidecars point at it, and a derived
     * key is de-duplicated against the rest of the list so this cannot manufacture the
     * duplicate the red chip complains about.
     *
     * Both fields go in **one** patch, which is what makes the rename atomic:
     * `applyResourcePatch` rewrites every `parentKey` and `resource:` reference naming the
     * old key in the same call, so a category's children follow it through a rename without
     * ever passing through a state the server would refuse.
     */
    function renameResource(
        index: number,
        nextName: string,
        options?: { readonly clearAdoption?: boolean }
    ) {
        const target = resources[index];
        if (!target) return;

        const nextKey = keyForRenamedResource({
            resource: target,
            nextName,
            resources,
            installedKeys,
        });

        const patch: Partial<ResourceDeclaration> = { defaultName: nextName };
        // Omitted rather than set to the current key: `applyResourcePatch` reads a `key` in
        // the patch as a rename and rebuilds the list, which would remount every row on
        // each keystroke of the name field.
        if (nextKey !== undefined) patch.key = nextKey;

        /*
         * Dropping an adoption travels with the rename rather than in its own call.
         *
         * Now that the name box *is* the adopt picker, typing over an adopted name is
         * how an operator says "not that one after all" — and the two changes have to
         * land in one patch, because both are derived from the same captured
         * `resources` and a second call would overwrite the first rather than compose
         * with it.
         *
         * Explicit `undefined` rather than omitted: `applyResourcePatch` reads a present
         * key holding `undefined` as a deletion and an absent one as "leave it alone".
         */
        if (options?.clearAdoption) patch.adoptDiscordId = undefined;

        updateResource(index, patch);
    }

    /**
     * Point a row at an existing channel or role, or back at a new one.
     *
     * Adopting re-seeds the name and the key from the target, which is the behaviour
     * the old add form had through `declarationForAdoptedResource` and the reason that
     * helper still exists: a row left reading `new-channel` while bound to `#rules`
     * tells the operator the wrong name for what install is about to touch, and the key
     * — the flow's permanent handle on it — would be wrong too.
     *
     * Each field is re-seeded only while it is **still the generated one**, and the two
     * are asked independently. Someone who has typed their own name has said what they
     * want the row called; someone who has edited the key has done something with more
     * consequence still, since node configs may already name it. Overwriting either
     * because they then identified which channel it is would be the panel arguing with
     * them.
     *
     * Clearing the picker leaves the name alone entirely. There is no channel to take a
     * name from, and reverting to `new-channel` would discard a real edit.
     */
    function setAdoption(index: number, discordId: string | undefined) {
        const target = resources[index];
        if (!target) return;

        if (!discordId) {
            updateResource(index, { adoptDiscordId: undefined });
            return;
        }

        /*
         * Which list to look in is decided by the row's own kind, not by searching
         * both. A role declaration must not resolve its name from a channel that
         * happens to share the id — nothing would stop the seeded name being a
         * channel's, and the row would then describe the wrong object entirely.
         */
        const adoptable: { id: string; name: string } | undefined =
            target.kind === 'role'
                ? roles.find((candidate) => candidate.id === discordId)
                : channels.find((candidate) => candidate.id === discordId);

        // The picker only offers ids from that list, so a miss means the list changed
        // under the selection. Binding the id without a name we can trust is better
        // than guessing one.
        if (!adoptable) {
            updateResource(index, { adoptDiscordId: discordId });
            return;
        }

        const others = resources.filter((_resource, position) => position !== index);
        const generated = declarationForNewResource({ name: '', kind: target.kind, existing: others });
        const adopted = declarationForAdoptedResource({
            target: adoptable,
            kind: target.kind,
            existing: others,
            parentKey: target.parentKey,
        });

        // Each field is asked separately, because an operator can have edited either
        // one alone. Seeding a field they have already written would be the panel
        // arguing with them — and the key especially, which the row calls the flow's
        // permanent handle on the resource and which node configs may already name.
        //
        // The key's "untouched" test goes through `keyIsStillDerived` against the
        // *generated* name, rather than comparing to `generated.key`: that value is
        // de-duplicated against the rest of the list, so a second unnamed channel holds
        // `new-channel-2` and a bare equality would never call it untouched. The same
        // predicate decides whether a rename may carry the key, so adoption and renaming
        // cannot disagree about which keys are still ours.
        const patch: Partial<ResourceDeclaration> = { adoptDiscordId: discordId };

        if (target.defaultName === generated.defaultName) {
            patch.defaultName = adopted.defaultName;
        }
        if (keyIsStillDerived({ ...target, defaultName: generated.defaultName })) {
            patch.key = adopted.key;
        }

        updateResource(index, patch);
    }

    /**
     * Add a resource of one kind, already open with its name selected.
     *
     * The old panel had a permanent "add a resource" card carrying a name box, a kind
     * toggle, a parent picker and a create-versus-adopt switch — a form to fill in
     * before the thing existed. Three buttons replace it, and the row itself is the
     * form. Adoption is chosen from the row's own "already exists" picker rather than a
     * mode toggle, because it is a property of the declaration rather than of the act
     * of adding one.
     *
     * The name is seeded by `declarationForNewResource` rather than left blank, so the
     * row is valid the instant it exists — an empty name is a red `Name required` chip,
     * and greeting someone with an error for pressing Add would be a lie about what
     * they did wrong.
     */
    function addResource(kind: ResourceKind) {
        const declaration = declarationForNewResource({ name: '', kind, existing: resources });
        const index = resources.length;

        onChange([...resources, declaration]);
        setExpanded((current) => new Set(current).add(index));
        setPendingNameFocus(index);
        // A new row that the current filter excludes would be added and then
        // immediately hidden. Clearing is the honest response to "I just made this".
        setFilter('');
    }

    /**
     * Open the row a chip belongs to and remember what to focus once it is mounted.
     *
     * The decision of *where* a chip lands is `RESOURCE_CHIPS[id].jumpTo`'s, and the
     * refs belong to the expanded body, so this function only routes between them —
     * which is the separation `ResourceChip` and `resourceChips.ts` were both written
     * to preserve.
     */
    const jumpToChip = useCallback((index: number, chip: ResourceChipInstance) => {
        setExpanded((current) => new Set(current).add(index));
        setPendingJump({
            index,
            target: RESOURCE_CHIPS[chip.id].jumpTo,
            ruleIndex: chip.detail.ruleIndex,
        });
    }, []);

    const clearJump = useCallback(() => setPendingJump(undefined), []);
    const clearNameFocus = useCallback(() => setPendingNameFocus(undefined), []);

    function toggleExpanded(index: number) {
        setExpanded((current) => {
            const next = new Set(current);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    }

    return (
        <Stack gap="lg">
            <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
                {/*
                 * "these flows" rather than "this flow" on a journey, and nothing else
                 * changes. The panel is rendered by a group header now as well as by the
                 * builder, and a shared list of declarations described as one flow's is the
                 * same misattribution `summarisePublished`'s `scope` exists to avoid —
                 * except here it would be telling an operator that edits reaching several
                 * flows reach one.
                 */}
                <Text c="dimmed">
                    Channels and roles {scope === 'journey' ? 'these flows need' : 'this flow needs'}.
                    Declare them here and they show up in the pickers straight away — you can
                    build the whole flow before any of them exist, or point one at something you
                    already have.
                </Text>

                {/*
                 * Shown only while a write is actually in flight — the same rule the
                 * chips follow. A permanent "Saved" would be on screen essentially
                 * always, which makes it decoration rather than information, and would
                 * additionally be *wrong* during the pause before a save starts.
                 *
                 * The space is reserved either way, so the heading beside it does not
                 * reflow each time the word appears; at typing speed that would be a
                 * flicker next to text someone is reading.
                 */}
                <Text size="sm" c="dimmed" ta="right" style={{ flex: 'none', width: 70 }}>
                    {saving ? 'Saving…' : ''}
                </Text>
            </Group>

            {error && (
                <Alert color="red" variant="light">
                    <Text>{error}</Text>
                </Alert>
            )}

            <Group gap="sm" wrap="nowrap">
                <TextInput
                    size="sm"
                    placeholder="Filter resources…"
                    value={filter}
                    onChange={(event) => setFilter(event.currentTarget.value)}
                    leftSection={<IconSearch size={16} />}
                    style={{ flex: 1 }}
                />

                {/*
                 * Each button wears the colour and glyph of the kind it creates, so the
                 * button that makes a channel looks like the channel rows it makes.
                 * Kind is the one field on a declaration that is silent when wrong, and
                 * a grey row of identical buttons teaches nothing; repetition of blue-#
                 * is what turns the accent colour into a vocabulary rather than
                 * decoration an operator has to decode.
                 */}
                {RESOURCE_KIND_ORDER.map((kind) => {
                    const style = RESOURCE_KIND_STYLES[kind];
                    const KindIcon = style.icon;
                    return (
                        <Button
                            key={kind}
                            size="sm"
                            variant="light"
                            color={style.color}
                            leftSection={<KindIcon size={16} />}
                            onClick={() => addResource(kind)}
                        >
                            {style.label}
                        </Button>
                    );
                })}
            </Group>

            {resources.length === 0 ? (
                <Text c="dimmed" ta="center" pt="lg">
                    Nothing declared yet. If{' '}
                    {scope === 'journey' ? 'these flows only use' : 'this flow only uses'} channels
                    that already exist and you have picked them on the blocks themselves,{' '}
                    {scope === 'journey' ? 'they don' : 'it doesn'}&apos;t need anything here.
                </Text>
            ) : rows.length === 0 ? (
                <Text c="dimmed" ta="center" pt="lg">
                    Nothing matches &ldquo;{filter}&rdquo;.
                </Text>
            ) : (
                <Stack gap={6}>
                    {rows.map((row) => (
                        <ResourceRow
                            // Position in the underlying list, not in the filtered rows:
                            // a React key that changed as the filter narrowed would
                            // remount the row and lose focus mid-word.
                            key={row.index}
                            resource={row.resource}
                            depth={row.depth}
                            isFilterContext={row.isFilterContext}
                            chips={chipsByIndex.get(row.index) ?? []}
                            expanded={expanded.has(row.index)}
                            onToggle={() => toggleExpanded(row.index)}
                            onJump={(chip) => jumpToChip(row.index, chip)}
                            pendingJump={
                                pendingJump?.index === row.index ? pendingJump : undefined
                            }
                            onJumpHandled={clearJump}
                            focusNameOnMount={pendingNameFocus === row.index}
                            onNameFocusHandled={clearNameFocus}
                            categories={categories.filter(
                                (category) => category.key !== row.resource.key
                            )}
                            roles={roles}
                            channels={channels}
                            allResources={resources}
                            declaredRoles={declaredRoles.filter(
                                // A role granting itself permissions is meaningless,
                                // and a role has no overwrites at all.
                                (declared) => declared.key !== row.resource.key
                            )}
                            onUpdate={(patch) => updateResource(row.index, patch)}
                            onRename={(nextName, options) =>
                                renameResource(row.index, nextName, options)
                            }
                            keyIsInstalled={installedKeys?.has(row.resource.key) ?? false}
                            onAdopt={(channelId) => setAdoption(row.index, channelId)}
                            onRemove={() => removeResource(row.index)}
                        />
                    ))}
                </Stack>
            )}
        </Stack>
    );
}

/**
 * Keep the open-row set pointing at the same resources after one is removed.
 *
 * Positions above the removed index all shift down by one. Without this the set would
 * still name the old positions, and the row that moved up into the gap would appear
 * already open — which reads as the wrong resource having been expanded by the delete.
 */
function shiftPositionsAfterRemoval(
    open: ReadonlySet<number>,
    removedIndex: number
): ReadonlySet<number> {
    const next = new Set<number>();
    for (const position of open) {
        if (position === removedIndex) continue;
        next.add(position > removedIndex ? position - 1 : position);
    }
    return next;
}

interface ResourceRowProps {
    resource: ResourceDeclaration;
    /** `1` for a channel under its category, `0` otherwise. */
    depth: number;
    /** Shown only to give a matching child a parent; dimmed, and not a search hit. */
    isFilterContext: boolean;
    chips: readonly ResourceChipInstance[];
    expanded: boolean;
    onToggle: () => void;
    onJump: (chip: ResourceChipInstance) => void;
    /** Set when this row owns an unhandled jump request. */
    pendingJump: PendingJump | undefined;
    onJumpHandled: () => void;
    focusNameOnMount: boolean;
    onNameFocusHandled: () => void;
    categories: ResourceDeclaration[];
    roles: GuildRole[];
    channels: GuildChannel[];
    /** Every declared resource, so this row's picker can skip ones another row adopts. */
    allResources: ResourceDeclaration[];
    declaredRoles: ResourceDeclaration[];
    onUpdate: (patch: Partial<ResourceDeclaration>) => void;
    /**
     * Renaming is its own callback because the key may have to follow the name — and,
     * now that the name box is also the adopt picker, because typing over an adopted
     * name has to drop the adoption in the *same* patch.
     */
    onRename: (nextName: string, options?: { readonly clearAdoption?: boolean }) => void;
    /** Whether this row's key is frozen by something live in the guild. */
    keyIsInstalled: boolean;
    /** Adoption is its own callback because it may re-seed the name and key too. */
    onAdopt: (channelId: string | undefined) => void;
    onRemove: () => void;
}

function ResourceRow({
    resource,
    depth,
    isFilterContext,
    chips,
    expanded,
    onToggle,
    onJump,
    pendingJump,
    onJumpHandled,
    focusNameOnMount,
    onNameFocusHandled,
    categories,
    roles,
    channels,
    allResources,
    declaredRoles,
    onUpdate,
    onRename,
    keyIsInstalled,
    onAdopt,
    onRemove,
}: ResourceRowProps) {
    const showParentPicker = canHaveParent(resource.kind) && categories.length > 0;
    const adoptingRole = resource.kind === 'role';
    const style = RESOURCE_KIND_STYLES[resource.kind];
    const KindIcon = style.icon;
    const adopting = Boolean(resource.adoptDiscordId);

    // The expanded body owns these, which is why the jump decision is routed here
    // rather than taken in `ResourceChip`: only this component can focus them. There
    // is no `adoptRef` any more — the name box *is* the adopt control.
    const nameRef = useRef<HTMLInputElement>(null);
    const keyRef = useRef<HTMLInputElement>(null);
    const rulesRef = useRef<HTMLDivElement>(null);

    const hasBlockingChip = chips.some((chip) => RESOURCE_CHIPS[chip.id].tone === 'error');

    // One of the two is always empty — the functions each refuse a kind they do not
    // serve — so concatenating them is the whole of the routing. A `kind` switch here
    // would put the same decision in a third place.
    const adoptOptions = useMemo(
        () =>
            // Disambiguated **here**, once, so the dropdown and the committed row share
            // one label space. Doing it downstream of ranking put them in two: the list
            // offered `@Verified (r2)` and the adopted row then read its label from the
            // undecorated source, so picking one of two identical objects left nothing
            // on screen saying which — the question the suffix exists to answer.
            disambiguateOptions(
                canAdopt(resource.kind)
                    ? [
                          ...adoptableChannelOptions(
                              channels,
                              resource.kind,
                              allResources,
                              resource.key
                          ),
                          ...adoptableRoleOptions(
                              roles,
                              resource.kind,
                              allResources,
                              resource.key
                          ),
                      ]
                    : []
            ),
        [channels, roles, resource.kind, resource.key, allResources]
    );

    /**
     * The suggestion list, ranked against what has been typed so far.
     *
     * **Keyed by Discord id, not by label**, and that is load-bearing in three separate
     * ways — all of which the first cut got wrong by making the display string carry the
     * binding:
     *
     *  - Mantine throws on a duplicate option `value`, *during render*. Two roles named
     *    `Verified`, or two top-level channels named `general`, produce identical labels
     *    — both ordinary in a real guild — and the exception lands inside `Collapse`,
     *    taking down the tree rather than glitching a dropdown. Ids are unique by
     *    construction.
     *  - Resolving a click by label returns the *first* entry sharing it, so picking the
     *    second `#general` would bind the first one's id. The row would then show the
     *    right name and the wrong binding, and install would adopt a channel nobody
     *    pointed at.
     *  - Recognising a *selection* by comparing the typed text to a label is unsound for
     *    categories specifically: `channelOptionLabel` deliberately gives a category no
     *    `#`, and a top-level one has no parent either, so its label is the bare name.
     *    Typing `Arrivals` would have silently adopted an existing `Arrivals` — the exact
     *    thing §5.7 forbids twice and that `nameTaken` exists to avoid doing.
     *
     * `limit` is applied here rather than passed to Mantine: in v7 `limit` is handed *to*
     * the filter function rather than applied after it, so a custom `filter` that ignores
     * the argument — as ours must, the list being pre-ranked — silently renders every
     * option. A fresh row in a 300-channel guild would open a 300-row dropdown.
     */
    const ranked = useMemo(
        () => rankSuggestions(adoptOptions, resource.defaultName).slice(0, SUGGESTION_LIMIT),
        [adoptOptions, resource.defaultName]
    );
    const suggestionData = useMemo(
        () => ranked.map((entry) => ({ value: entry.option.value, label: entry.option.label })),
        [ranked]
    );

    /**
     * What the combobox shows while adopting.
     *
     * The declaration's own name normally, but the **adopted object's label** once a row
     * is bound — because the label is what the dropdown offered and what identifies which
     * of two same-named objects this is. Showing the bare name would make an adopted
     * `#general · in Support` indistinguishable from an adopted `#general · in Lounge`
     * the moment the dropdown closed.
     */
    const adoptedLabel = adopting
        ? adoptOptions.find((option) => option.value === resource.adoptDiscordId)?.label
        : undefined;

    const adoptionDescription = adopting
        ? 'Adopting what you already have. Install will bind to it and leave it alone — not rename it, not touch its permissions.'
        : `What it gets called. Pick one of the ${adoptingRole ? 'roles' : 'channels'} listed to use that instead of creating a new one.`;

    /**
     * Set for the one `onChange` Mantine fires as part of committing a selection.
     *
     * `Autocomplete`'s `onOptionSubmit` runs `onOptionSubmit?.(val)` and then
     * `handleValueChange(optionsLockup[val].label)` — which, on a controlled input, is
     * our own `onChange` with the label. So every pick arrives here as **two** calls in
     * one event, and taking the second at face value would rename the row (clearing the
     * adoption the first call just made) on every single selection.
     *
     * A ref rather than state, because it must be readable within the same event that
     * set it; a state update would not have landed yet. It is a genuine signal — set
     * only by `onOptionSubmit`, consumed once — rather than a guess about what the text
     * looks like, which is precisely the mistake this replaced.
     */
    const submittingOption = useRef(false);

    /**
     * Picking a suggestion. Adoption, and never anything else.
     *
     * Separate from typing because Mantine tells us which it was: `onOptionSubmit`
     * receives the option's **value**, so the binding never round-trips through a string
     * a human could also have typed. That is what makes *"the operator is never silently
     * bound to something they did not choose"* true structurally rather than by hoping
     * label decoration is unguessable — which it is not, since a top-level category's
     * label is its bare name.
     */
    function onSuggestionPicked(discordId: string) {
        submittingOption.current = true;
        onAdopt(discordId);
    }

    /**
     * Typing. Always a rename, and it **clears an existing adoption**.
     *
     * Worth stating: having adopted `#welcome` and then typed a different name, the
     * operator has said they want something else, and silently keeping the old binding
     * while showing the new name would be the row lying about what install will touch.
     *
     * **One call, not two.** The obvious shape is `onAdopt(undefined)` followed by
     * `onRename(next)`, and it silently loses the first: both derive their next list from
     * the `resources` captured by this render, so the second overwrites rather than
     * composes. `onRename` takes the un-adopt as part of the same patch, which is the
     * same reason a rename carries its key — `applyResourcePatch` is the only place
     * allowed to sequence field changes.
     */
    function onNameTyped(next: string) {
        // The echo of a selection, not a keystroke. `onSuggestionPicked` has already
        // adopted, and `setAdoption` seeds the name from the adopted object.
        if (submittingOption.current) {
            submittingOption.current = false;
            return;
        }

        onRename(next, { clearAdoption: adopting });
    }

    // Focus runs after the body has mounted, which is why it is an effect keyed on the
    // request rather than something done when the chip is clicked. `Collapse` renders
    // nothing while closed, so the input does not exist at click time.
    useFocusOnRequest({
        pendingJump,
        expanded,
        onJumpHandled,
        nameRef,
        keyRef,
        rulesRef,
    });

    useFocusNameOnMount({ focusNameOnMount, expanded, nameRef, onNameFocusHandled });

    return (
        <Box style={{ marginLeft: depth * CHILD_INDENT_PX }}>
            <Box
                style={{
                    background: 'var(--mantine-color-dark-7)',
                    border: `1px solid ${
                        hasBlockingChip
                            ? 'var(--mantine-color-red-9)'
                            : 'var(--mantine-color-dark-5)'
                    }`,
                    borderRadius: 10,
                    overflow: 'hidden',
                    // A context row is scenery — it is shown so a matching child has
                    // something to sit under, and styling it like a hit would claim it
                    // matched the filter when it did not.
                    opacity: isFilterContext ? 0.55 : 1,
                }}
            >
                <Group gap="sm" wrap="nowrap" pr="sm">
                    <UnstyledButton
                        onClick={onToggle}
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${resource.defaultName}`}
                        style={{ flex: 1, minWidth: 0 }}
                    >
                        <Group gap="sm" wrap="nowrap" py={10} pl={0}>
                            {/*
                             * The kind's colour down the edge, so a list is scannable by
                             * kind without reading a single label. 3px rather than the
                             * old 4px border — the mockup's, and enough at this density.
                             */}
                            <Box
                                style={{
                                    width: 3,
                                    alignSelf: 'stretch',
                                    borderRadius: 2,
                                    flex: 'none',
                                    background: `var(--mantine-color-${style.color}-6)`,
                                }}
                            />
                            <KindIcon
                                size={18}
                                color={`var(--mantine-color-${style.color}-5)`}
                                style={{ flex: 'none' }}
                            />
                            <Text fw={700} size="md" truncate>
                                {style.prefix}
                                {resource.defaultName}
                            </Text>

                            <Group gap={6} wrap="wrap" justify="flex-end" style={{ marginLeft: 'auto' }}>
                                {chips.map((chip) => (
                                    <ResourceChip
                                        key={`${chip.id}-${chip.detail.ruleIndex ?? ''}`}
                                        id={chip.id}
                                        detail={chip.detail}
                                        onJump={() => onJump(chip)}
                                    />
                                ))}
                            </Group>

                            {expanded ? (
                                <IconChevronDown size={16} style={{ flex: 'none' }} />
                            ) : (
                                <IconChevronRight size={16} style={{ flex: 'none' }} />
                            )}
                        </Group>
                    </UnstyledButton>

                    <Tooltip label="Remove" withArrow>
                        <ActionIcon
                            size="md"
                            variant="subtle"
                            color="red"
                            onClick={onRemove}
                            aria-label={`Remove ${resource.defaultName}`}
                        >
                            <IconTrash size={16} />
                        </ActionIcon>
                    </Tooltip>
                </Group>

                <Collapse in={expanded}>
                    <Stack
                        gap="md"
                        px="md"
                        pt="md"
                        pb="lg"
                        style={{ borderTop: '1px solid var(--mantine-color-dark-6)' }}
                    >
                        <Group gap="md" wrap="nowrap" align="flex-start" grow>
                            {/*
                              * One control, not two. This was a Name box beside a "Does it
                              * already exist?" picker, and the PRD names that shape as the
                              * thing to remove: *"one autocomplete field, not an
                              * adopt-or-create fork"*. From the operator's side adopting and
                              * creating are the same gesture — they know what the thing is
                              * called, and whether it exists is something the panel can
                              * answer. Two controls made them answer it twice, and the second
                              * answer was optional, so the common mistake was typing
                              * `welcome` into a row that then tried to create a *second*
                              * `#welcome`.
                              *
                              * Free text is the point: `Autocomplete` rather than a
                              * `Select`, because a name nothing matches is a perfectly good
                              * answer meaning "create it". A `Select` cannot say that.
                              */}
                            <Autocomplete
                                ref={nameRef}
                                size="sm"
                                label="Name"
                                description={adoptionDescription}
                                placeholder={style.namePlaceholder}
                                // The adopted object's label once bound, so an adopted
                                // `#general · in Support` stays distinguishable from an
                                // adopted `#general · in Lounge` after the dropdown shuts.
                                value={adoptedLabel ?? resource.defaultName}
                                data={suggestionData}
                                // Typing renames; picking adopts. They are *different
                                // callbacks* rather than one handler inspecting the text,
                                // because only `onOptionSubmit` carries the id — matching
                                // the typed string against a label would bind the first of
                                // two same-named objects, and would silently adopt a
                                // category, whose label is its bare name.
                                onChange={onNameTyped}
                                onOptionSubmit={onSuggestionPicked}
                                // Mantine filters `data` itself by default, which would
                                // re-answer a question `rankSuggestions` has already
                                // answered — and answer it differently, since it does not
                                // know the exact-before-prefix rule. The list handed in is
                                // already both filtered and ranked, and already cut to
                                // `SUGGESTION_LIMIT`: v7 hands `limit` *to* the filter
                                // rather than applying it after, so passing it alongside a
                                // custom filter that ignores it does nothing at all.
                                filter={({ options }) => options}
                                leftSection={
                                    adopting ? (
                                        <IconLink size={16} color="var(--mantine-color-teal-5)" />
                                    ) : style.prefix ? (
                                        <Text c="dimmed">{style.prefix}</Text>
                                    ) : undefined
                                }
                                rightSection={
                                    adopting ? (
                                        <Tooltip label="Create a new one instead" withArrow>
                                            <ActionIcon
                                                size="sm"
                                                variant="subtle"
                                                color="gray"
                                                onClick={() => onAdopt(undefined)}
                                                aria-label="Stop adopting and create a new one"
                                            >
                                                <IconX size={14} />
                                            </ActionIcon>
                                        </Tooltip>
                                    ) : undefined
                                }
                            />

                            <TextInput
                                ref={keyRef}
                                size="sm"
                                label="Key"
                                /*
                                 * Says which of the two states this key is in, because the
                                 * difference is what the operator is about to act on:
                                 * before anything is installed the key is still following
                                 * the name, and typing here is what stops that — silently,
                                 * and permanently. Afterwards it is identity and cannot
                                 * move at all.
                                 */
                                description={
                                    keyIsInstalled
                                        ? "Installed things point at this, so it's fixed now. A rename in Discord won't break it."
                                        : 'How this flow refers to it. Follows the name until you edit it or install.'
                                }
                                value={resource.key}
                                onChange={(event) => onUpdate({ key: event.currentTarget.value })}
                            />
                        </Group>

                        {showParentPicker && (
                            <Select
                                size="sm"
                                label="Inside category"
                                description={
                                    adopting
                                        ? 'Only used if this is created after all. Adopting leaves it where it is.'
                                        : 'Leave empty for top level.'
                                }
                                placeholder="Top level"
                                data={categories.map((category) => ({
                                    value: category.key,
                                    label: category.defaultName,
                                }))}
                                value={resource.parentKey ?? null}
                                onChange={(next) => onUpdate({ parentKey: next ?? undefined })}
                                clearable
                                comboboxProps={{ withinPortal: true }}
                            />
                        )}

                        {/*
                         * Roles carry no permission overwrites — overwrites are a
                         * property of a channel or a category, and a role *appears in*
                         * them rather than having them. Offering the editor here would
                         * be a form with no effect.
                         */}
                        {resource.kind !== 'role' && (
                            <div ref={rulesRef}>
                                <Stack gap="md">
                                    <Divider
                                        label={<Text c="dimmed">Who can see it</Text>}
                                        labelPosition="left"
                                    />
                                    {/*
                                     * Said once, here, rather than on every rule:
                                     * `applyInstallPlan` only compiles overwrites on the
                                     * *create* path, so an adopted channel keeps whatever
                                     * permissions it already has. Rules left on the row
                                     * would otherwise look applied and never be.
                                     */}
                                    {adopting && (
                                        <Alert color="yellow" variant="light">
                                            <Text size="sm">
                                                Adopting keeps the permissions this channel
                                                already has — install won&apos;t touch them.
                                                Rules below are saved but only take effect if
                                                you switch back to creating it.
                                            </Text>
                                        </Alert>
                                    )}
                                    <PermissionIntentEditor
                                        intents={resource.permissions}
                                        onChange={(next) => onUpdate({ permissions: next })}
                                        roles={roles}
                                        declaredRoles={declaredRoles}
                                        canInherit={Boolean(resource.parentKey)}
                                        focusRuleIndex={
                                            pendingJump?.target === 'rule'
                                                ? pendingJump.ruleIndex
                                                : undefined
                                        }
                                    />
                                </Stack>
                            </div>
                        )}
                    </Stack>
                </Collapse>
            </Box>
        </Box>
    );
}

interface FocusOnRequestInput {
    pendingJump: PendingJump | undefined;
    expanded: boolean;
    onJumpHandled: () => void;
    nameRef: RefObject<HTMLInputElement>;
    keyRef: RefObject<HTMLInputElement>;
    rulesRef: RefObject<HTMLDivElement>;
}

/**
 * Land a chip's jump on the field that caused it, once that field exists.
 *
 * **The switch is exhaustive on purpose.** `ResourceChipJumpTarget` is a closed union
 * precisely so that adding a tenth chip pointing somewhere new cannot compile until it
 * has been given a destination — a chip that silently focuses nothing is worse than no
 * chip, because it teaches the operator that clicking them does not work.
 *
 * `rule` is handled by scrolling to the editor and letting `PermissionIntentEditor`
 * focus the numbered row, because only it knows how its rows are built. The rejected
 * alternative was threading a ref per rule up through the editor, which would have made
 * this component own the shape of a list it does not render.
 */
function useFocusOnRequest({
    pendingJump,
    expanded,
    onJumpHandled,
    nameRef,
    keyRef,
    rulesRef,
}: FocusOnRequestInput): void {
    const target = pendingJump?.target;

    useEffect(() => {
        if (!pendingJump || !expanded) return;

        // One frame, so `Collapse` has mounted the body it is animating open. Focusing
        // synchronously here finds nothing on the render that first opens the row.
        const handle = window.requestAnimationFrame(() => {
            switch (pendingJump.target) {
                case 'nameCombobox':
                    // One target where there were two. Every chip that used to ask for
                    // the adopt picker is asking for this same control now — it is the
                    // name box *and* the list of things to adopt.
                    focusAndSelect(nameRef.current);
                    break;
                case 'keyField':
                    focusAndSelect(keyRef.current);
                    break;
                case 'rules':
                    rulesRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    break;
                case 'rule':
                    // Deliberately nothing. `PermissionIntentEditor` scrolls the
                    // numbered row itself, via `focusRuleIndex` — only it knows where
                    // its rows are. Scrolling the container here as well would land in
                    // the same frame and win, because a child's effect registers its
                    // `requestAnimationFrame` before the parent's does: the two chips
                    // that exist specifically to name a rule would then land exactly
                    // where a plain `rules` chip does.
                    break;
                default: {
                    // Exhaustiveness: a new jump target has to be handled above.
                    const unreachable: never = pendingJump.target;
                    throw new Error(`Unhandled chip jump target: ${String(unreachable)}`);
                }
            }
            onJumpHandled();
        });

        return () => window.cancelAnimationFrame(handle);
        // `target` is in the deps so a second click on a *different* chip of the same
        // row re-runs this; `pendingJump` identity alone would do it, but naming the
        // field makes the intent legible.
    }, [pendingJump, target, expanded, onJumpHandled, nameRef, keyRef, rulesRef]);
}

interface FocusNameOnMountInput {
    focusNameOnMount: boolean;
    expanded: boolean;
    nameRef: RefObject<HTMLInputElement>;
    onNameFocusHandled: () => void;
}

/**
 * Put the cursor in the name box of a row that was just added.
 *
 * The add buttons create a named, valid resource rather than a blank one, so the text
 * is selected rather than merely focused — typing replaces the placeholder name in one
 * go, which is what someone who just pressed "＋ Channel" is about to do.
 */
function useFocusNameOnMount({
    focusNameOnMount,
    expanded,
    nameRef,
    onNameFocusHandled,
}: FocusNameOnMountInput): void {
    useEffect(() => {
        if (!focusNameOnMount || !expanded) return;

        const handle = window.requestAnimationFrame(() => {
            focusAndSelect(nameRef.current);
            onNameFocusHandled();
        });

        return () => window.cancelAnimationFrame(handle);
    }, [focusNameOnMount, expanded, nameRef, onNameFocusHandled]);
}

function focusAndSelect(input: HTMLInputElement | null): void {
    if (!input) return;
    input.focus();
    input.select();
}
