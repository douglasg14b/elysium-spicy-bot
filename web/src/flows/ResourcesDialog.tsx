/**
 * The resource **declarations** editor, in a modal, for either a flow or a journey.
 *
 * ## Why this exists
 *
 * The group header's "⛁ N resources" button opened `JourneyResourcesDialog` — the
 * *teardown inventory*, which lists what is **installed**. The count on the button was the
 * number of **declarations**. So a journey with four declared and nothing installed showed
 * a button reading "4 resources" that opened a dialog reading "Nothing live in the server
 * yet." The button promised declarations and delivered installations, and there was no way
 * at all to edit a group's declarations without opening one of its member flows in the
 * builder and going through a toolbar that never mentions the journey.
 *
 * This is the builder's resources modal, lifted out so both surfaces render the same thing.
 * It is a *wrapper*: `ResourcesPanel` is untouched and still knows nothing about flows,
 * journeys or endpoints. What moved here is the wiring the builder had inline — the initial
 * read, the roles and channels the pickers need, the autosave, and the modal's sizing.
 *
 * ## What it saves against
 *
 * Not a flow. A {@link ResourceSaveTarget}, which is a flow *or* a journey, and that module
 * records why the two surfaces cannot share one endpoint. The short version: routing a
 * group header's edits through `flows[0]` picks an arbitrary member to speak for the whole
 * journey — the mistake `JourneyResourcesDialog` was written to undo on the teardown side —
 * and the flow route refuses every write to a shared journey with a 409 anyway, so it would
 * not have worked.
 *
 * ## Never disabled while being typed into
 *
 * `saving` reaches `ResourcesPanel` as an indicator and never as `disabled`. The long
 * comment on that prop records why: HTML's focus fixup rule takes the cursor away from a
 * focused element the moment it stops being focusable, and the save is debounced, so it can
 * land mid-word. Nothing here may tighten that, including the dialog's own close button —
 * which is why there is no busy state on the modal itself.
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { ApiError } from '../api/client';
import { getGuildChannels } from '../api/config';
import { getGuildRoles } from '../api/flows';
import type { GuildChannel, GuildRole, ResourceDeclaration } from '../api/types';
import { ResourcesPanel } from './ResourcesPanel';
import { loadResources, resourceTargetIdentity, type ResourceSaveTarget } from './resourceSaveTarget';
import { useResourceAutosave } from './useResourceAutosave';

interface ResourcesDialogProps {
    readonly opened: boolean;
    readonly onClose: () => void;
    readonly guildId: string;
    /** Where the declarations are read from and written to. */
    readonly target: ResourceSaveTarget;
    /** The modal's heading — "Resources this flow needs", "Resources Onboarding needs". */
    readonly title: string;
    /**
     * Rendered above the panel, for whatever the owning surface has to say about scope.
     *
     * The builder puts its `JourneyAttachmentControl` here, which answers "whose resources
     * are these?" and is meaningless on a group header, where the answer is the header.
     * A slot rather than a `scope` prop threaded through this component's internals — the
     * parameter tunnelling `.claude/rules/elegance.md` warns about, and here it would carry
     * exactly one difference.
     */
    readonly header?: React.ReactNode;
    /**
     * Resource keys with something live in the guild, so the key stops following the name.
     *
     * See `resourceKeyFollowsName.ts`. Omitted by a caller that cannot know, which narrows
     * the rule to hand-editing alone.
     */
    readonly installedKeys?: ReadonlySet<string>;
    /**
     * The declarations, and the setter the panel's edits go through.
     *
     * **Owned by the caller, not by this dialog.** The builder's pickers read
     * `declaredResources` to offer channels that do not exist yet, so the list has to live
     * where the canvas can see it — and it must survive this modal closing, which it would
     * not if it were state here. The flows page has no such need but passes its own state
     * for the same reason: a dialog that unmounts on close would re-fetch on every open and
     * discard an in-flight debounce with it.
     */
    readonly resources: ResourceDeclaration[];
    readonly onChange: (next: ResourceDeclaration[]) => void;
    /**
     * The journey the list belongs to, for the autosave's bookkeeping identity.
     *
     * The builder supplies its attachment's key, because attaching swaps the list without
     * the flow id changing. A `journey` target repeats its own key here, harmlessly.
     */
    readonly journeyKey: string | undefined;
    /** Whether the caller has finished its own initial load. Nothing is saved before. */
    readonly loaded: boolean;
    /**
     * Why the declarations could not be read, when they could not be.
     *
     * **Shown instead of the panel, not above it.** An unloaded panel renders "Nothing
     * declared yet" with live "＋ Channel" buttons — a flat assertion that a journey whose
     * header button said "4 resources" one click ago declares nothing, made at the exact
     * moment we could not find out. The recovery an operator would reasonably take from
     * that screen is the destructive one: re-add the four resources by hand, which the
     * `loaded` gate now lets through, and because the PUT is a full replace their keys are
     * freshly slugged and no longer match the `resource_bindings` rows or the node
     * `<field>Key` sidecars pointing at the originals.
     *
     * So the guard that protects the data has to be visible, or it protects the data by
     * routing the operator into corrupting it another way. Same shape and near-identical
     * copy as `JourneyResourcesDialog`'s `loadError`, which answers the same question for
     * the inventory beside this.
     */
    readonly loadError?: string | null;
    /** Told when the server confirms a save, so the caller can adopt the normalised list. */
    readonly onSaved: (resources: ResourceDeclaration[]) => void;
}

export function ResourcesDialog({
    opened,
    onClose,
    guildId,
    target,
    title,
    header,
    installedKeys,
    resources,
    onChange,
    journeyKey,
    loaded,
    loadError,
    onSaved,
}: ResourcesDialogProps) {
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { roles, channels } = useGuildDirectory(guildId, opened);

    useResourceAutosave({
        guildId,
        target,
        journeyKey,
        resources,
        loaded,
        onSaved,
        onSavingChange: setSaving,
        onError: setError,
    });

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={title}
            /*
             * Generously sized, and the reasoning moved here with the markup: a resource
             * row holds a name, a key, an "already exists" picker, a parent and a list of
             * permission rules, each rule being an audience plus an access level plus
             * possibly a role list. That does not fit a narrow column — which was half of
             * why the panel was unusable in the 300px sidebar it started in — and `xl` was
             * still cramped enough to read as one.
             *
             * An explicit width rather than a `size` token because the token ladder stops
             * short of what a row needs. The height keeps several resources out of a short
             * scroll well, which was the other half of the complaint.
             */
            size="1100px"
            styles={{ content: { height: 'min(88vh, 900px)' }, body: { paddingBottom: 24 } }}
        >
            <Stack gap="lg">
                {header}
                {loadError ? (
                    /*
                     * In place of the panel, so the add-a-resource buttons are genuinely
                     * unreachable rather than merely discouraged. See `loadError`'s prop
                     * docs: an empty panel here is not a blank slate, it is a false claim
                     * about a list we failed to read, and acting on it corrupts keys.
                     */
                    <Alert color="orange" icon={<IconAlertTriangle size={16} />}>
                        <Text size="13.5px">
                            {loadError} Nothing has been changed — close this and try again.
                        </Text>
                    </Alert>
                ) : (
                    <ResourcesPanel
                        resources={resources}
                        onChange={onChange}
                        roles={roles}
                        channels={channels}
                        installedKeys={installedKeys}
                        // Derived from the target rather than taken as a prop: the scope of
                        // the copy and the scope of the endpoint are the same fact, and
                        // letting a caller set them independently is how a journey's editor
                        // ends up describing a shared list as one flow's.
                        scope={target.kind}
                        saving={saving}
                        error={error ?? undefined}
                    />
                )}
            </Stack>
        </Modal>
    );
}

/**
 * The guild's real roles and channels, for the adopt and permission pickers.
 *
 * Fetched here rather than passed in because both callers would otherwise have to fetch
 * them for this dialog alone — the flows page has no other use for either list, and making
 * it acquire two guild directories to open a modal is the wiring this extraction was meant
 * to remove.
 *
 * Keyed on `opened` so a page holding the dialog closed pays nothing. A failed fetch leaves
 * the lists empty, which degrades to "no channel to adopt" and "no role to name" rather
 * than to a broken panel: both pickers already render an empty list as a legitimate state,
 * and the declarations themselves — the thing the operator came to edit — do not depend on
 * either.
 */
function useGuildDirectory(
    guildId: string,
    active: boolean
): { roles: GuildRole[]; channels: GuildChannel[] } {
    const [roles, setRoles] = useState<GuildRole[]>([]);
    const [channels, setChannels] = useState<GuildChannel[]>([]);

    useEffect(() => {
        if (!active) return;
        let cancelled = false;

        void (async () => {
            try {
                const [guildRoles, guildChannels] = await Promise.all([
                    getGuildRoles(guildId),
                    getGuildChannels(guildId),
                ]);
                if (cancelled) return;
                setRoles(guildRoles);
                setChannels(guildChannels);
            } catch {
                // Left as they were. See the note above: an empty directory is a state both
                // pickers already render, and blanking what we have would remove options
                // that are still valid because one refresh failed.
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [guildId, active]);

    return { roles, channels };
}

/**
 * Load a target's declarations once, for a caller that owns the list.
 *
 * Exported because the *owner* of the state does the loading — see `resources` on the props
 * above for why the list cannot live in this dialog. Both callers need the same "read it,
 * and do not let a stale response land after the target changed" shape, and duplicating
 * that is how one of them ends up without the guard.
 */
export function useLoadedResources(
    guildId: string | undefined,
    target: ResourceSaveTarget | undefined
): {
    resources: ResourceDeclaration[];
    setResources: (next: ResourceDeclaration[]) => void;
    loaded: boolean;
    loadError: string | null;
} {
    const [resources, setResources] = useState<ResourceDeclaration[]>([]);
    /**
     * *Which* target the list in hand was read for, rather than a `loaded` boolean.
     *
     * **`loaded` is derived from this, not stored, and the difference is a real bug.** A
     * stored flag can only be cleared by an effect, and `useLoadedResources` is called at
     * page scope while `useResourceAutosave` lives inside `ResourcesDialog` — React runs
     * child effects before parent effects. So on the commit that changes the target, the
     * autosave would run first and see `loaded === true` alongside the *previous* target's
     * list, and record one target's declarations as the other's baseline, before the reset
     * below ever ran.
     *
     * Comparing identities makes the gate a render-time fact instead. It is false on the
     * very commit the target changes, with no ordering to get right.
     */
    const [loadedIdentity, setLoadedIdentity] = useState<string | undefined>(undefined);
    const [loadError, setLoadError] = useState<string | null>(null);

    // The target as a string, so an inline object does not re-run the fetch every render.
    const identity = target ? resourceTargetIdentity(target) : undefined;

    useEffect(() => {
        if (!guildId || !target) return;
        let cancelled = false;

        // The previous target's error must not stand over this one's fetch. `loaded` needs
        // no reset — it is derived, and already false for this identity.
        setLoadError(null);

        void (async () => {
            try {
                const stored = await loadResources(guildId, target);
                if (cancelled) return;
                setResources(stored);
                setLoadedIdentity(resourceTargetIdentity(target));
            } catch (err) {
                if (cancelled) return;
                setLoadError(
                    err instanceof ApiError ? err.message : 'Could not read what this declares.'
                );
                // Deliberately left unloaded. `loaded` gates the autosave, and marking a
                // failed read as loaded would let the empty list standing in for it be
                // saved over the stored declarations — an autosave that deletes what it
                // could not read.
            }
        })();

        return () => {
            cancelled = true;
        };
        // `target` is named by `identity`; including the object would refetch every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [guildId, identity]);

    const replace = useCallback((next: ResourceDeclaration[]) => setResources(next), []);

    return {
        resources,
        setResources: replace,
        // Derived, so it cannot lag the target it describes. See `loadedIdentity`.
        loaded: identity !== undefined && loadedIdentity === identity,
        loadError,
    };
}
