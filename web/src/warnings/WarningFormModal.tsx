import { useRef, useState } from 'react';
import { Button, Group, Modal, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation } from '@tanstack/react-query';
import { ApiError, issueWarning, updateWarning, type Warning, type WarningResult } from '@brattybot/web-sdk';
import type { MemberNames } from '../members/memberNames';
import { MemberPicker } from './MemberPicker';
import { useWarningWriteFollowUp } from './useWarningWriteFollowUp';
import {
    draftFromWarning,
    editIsPristine,
    issueProblems,
    issueRequest,
    newWarningDraft,
    updateProblems,
    updateRequest,
    withDropsOffOn,
    withIssuedOn,
    type WarningDraft,
    type WarningFormField,
} from './warningForm';
import { dateRefusalField, formatWarningDay, warningPersonLabel, type WarningDateField } from './warningPresentation';

/** Which dialog: a new warning, or an edit of one as it was loaded. */
export type WarningFormMode = { readonly kind: 'issue' } | { readonly kind: 'edit'; readonly warning: Warning };

interface WarningFormModalProps {
    readonly guildId: string;
    /** Null while the dialog is closed. */
    readonly mode: WarningFormMode | null;
    /** Who an edited warning's member is now, from the page's one names request. */
    readonly names: MemberNames;
    readonly onClose: () => void;
}

/**
 * Issue a warning, or edit one: one form, two modes (`docs/plans/warnings-in-the-dashboard.md` §4.4).
 *
 * The form body mounts with the dialog, so every opening starts from a fresh draft — today's
 * dates for a new warning, the warning as loaded for an edit.
 *
 * **It cannot be closed while a save runs** (Escape, outside click and the ✕ are all off):
 * the save closes the dialog when it lands, and one that landed after the operator had
 * closed it and opened another would close that one, typed draft and all.
 */
export function WarningFormModal({ guildId, mode, names, onClose }: WarningFormModalProps) {
    const [busy, setBusy] = useState(false);
    return (
        <Modal
            opened={mode !== null}
            onClose={onClose}
            title={mode?.kind === 'edit' ? `Edit ${mode.warning.slug}` : 'Issue a warning'}
            size="lg"
            closeOnEscape={!busy}
            closeOnClickOutside={!busy}
            withCloseButton={!busy}
        >
            {mode && (
                <WarningForm
                    guildId={guildId}
                    mode={mode}
                    names={names}
                    onClose={onClose}
                    busy={busy}
                    onBusyChange={setBusy}
                />
            )}
        </Modal>
    );
}

interface WarningFormProps {
    readonly guildId: string;
    readonly mode: WarningFormMode;
    readonly names: MemberNames;
    readonly onClose: () => void;
    /** A save and the re-read after it are running. Held by the dialog, which stays open meanwhile. */
    readonly busy: boolean;
    readonly onBusyChange: (busy: boolean) => void;
}

/** A date refusal the server sent back, shown under its field until that date is touched again. */
interface ServerDateProblem {
    readonly field: WarningDateField;
    readonly message: string;
}

function WarningForm({ guildId, mode, names, onClose, busy, onBusyChange }: WarningFormProps) {
    const followUp = useWarningWriteFollowUp();
    const loaded = mode.kind === 'edit' ? mode.warning : null;
    const [draft, setDraft] = useState<WarningDraft>(() => (loaded ? draftFromWarning(loaded) : newWarningDraft()));
    /*
     * Fields somebody has changed. A rule's refusal appears once its field is touched, not on
     * a form just opened: five red sentences on an empty dialog say nothing the disabled Save
     * does not. Save is disabled on any problem either way.
     */
    const [touched, setTouched] = useState<ReadonlySet<WarningFormField>>(new Set());
    const [serverProblem, setServerProblem] = useState<ServerDateProblem | null>(null);
    /* Set before the click's handler returns; `isPending` reaches the render a tick later. */
    const inFlight = useRef(false);

    const save = useMutation({
        mutationFn: async (): Promise<WarningResult> => {
            if (loaded) {
                return (
                    await updateWarning({
                        path: { guildId, slug: loaded.slug },
                        body: updateRequest(draft, loaded),
                    })
                ).data;
            }
            return (await issueWarning({ path: { guildId }, body: issueRequest(draft) })).data;
        },
    });

    const problems = loaded ? updateProblems(draft, loaded) : issueProblems(draft);
    const pristine = loaded ? editIsPristine(draft, loaded) : false;
    const canSave = Object.keys(problems).length === 0 && !pristine && !busy;

    function shown(field: WarningFormField): string | undefined {
        if (serverProblem?.field === field) return serverProblem.message;
        return touched.has(field) ? problems[field] : undefined;
    }

    function change(field: WarningFormField, next: WarningDraft): void {
        setDraft(next);
        setTouched((current) => new Set(current).add(field));
        // A date refusal is about the pair, so either date changing may have answered it.
        if (field === 'issuedOn' || field === 'dropsOffOn') setServerProblem(null);
    }

    /**
     * Save, then say so and re-read the list — all of it `busy`, so the button spins until the
     * table has caught up and the dialog cannot be closed under it.
     */
    async function handleSave(): Promise<void> {
        if (!canSave || inFlight.current) return;
        inFlight.current = true;
        onBusyChange(true);
        try {
            const result = await save.mutateAsync();
            await followUp.landed(guildId, loaded ? 'edit' : 'issue', result);
            onClose();
        } catch (error) {
            await handleRefusal(error);
        } finally {
            inFlight.current = false;
            onBusyChange(false);
        }
    }

    /**
     * A refused save. The form is kept for anything the operator can fix here; on an edit, a
     * warning that moved under the dialog (released, edited by somebody else, gone) closes it
     * and re-reads the list, because the base it was loaded from is no longer true. An issue
     * has no warning to have moved — its 404 is the bot gone from the server — so it keeps the
     * form and says so.
     */
    async function handleRefusal(error: unknown): Promise<void> {
        if (loaded && error instanceof ApiError && (error.status === 404 || error.status === 409)) {
            await followUp.moved(guildId, error);
            onClose();
            return;
        }
        if (error instanceof ApiError && error.status === 400) {
            const field = dateRefusalField(error.message);
            // An edit shows no issued date, so a refusal about it has nowhere to sit but a notification.
            if (field && (field === 'dropsOffOn' || !loaded)) {
                setServerProblem({ field, message: error.message });
                return;
            }
        }
        notifications.show({
            color: 'red',
            title: "Couldn't save",
            message:
                error instanceof ApiError
                    ? error.message
                    : "Couldn't reach the server. Your form is still here — try again in a second.",
        });
    }

    return (
        <Stack gap="md">
            {loaded ? (
                <Text size="13px" c="dimmed">
                    Warning for{' '}
                    <Text span fw={700} c="bright">
                        {warningPersonLabel(loaded.member, names)}
                    </Text>
                    , issued {formatWarningDay(loaded.issuedOn)}. The issued date is when it happened — that
                    stays put.
                </Text>
            ) : (
                <MemberPicker
                    guildId={guildId}
                    value={draft.memberId}
                    onChange={(memberId) => change('userId', { ...draft, memberId })}
                    error={shown('userId')}
                />
            )}

            {/*
             * No input here is ever `disabled` while saving: disabling a focused input hands
             * focus to the body and the next keystroke goes nowhere.
             */}
            <TextInput
                label="Rule"
                description="The line they crossed, in a few words."
                placeholder="No means no"
                value={draft.rule}
                onChange={(event) => change('rule', { ...draft, rule: event.currentTarget.value })}
                error={shown('rule')}
                data-autofocus={loaded ? true : undefined}
            />
            <Textarea
                label="Description"
                description="What happened. Specific enough that future you believes it."
                autosize
                minRows={3}
                maxRows={10}
                value={draft.description}
                onChange={(event) => change('description', { ...draft, description: event.currentTarget.value })}
                error={shown('description')}
            />
            <Group grow align="flex-start">
                {loaded ? null : (
                    <TextInput
                        label="Issued"
                        description="Today, unless you're catching up on old sins."
                        placeholder="YYYY-MM-DD"
                        value={draft.issuedOn}
                        onChange={(event) => change('issuedOn', withIssuedOn(draft, event.currentTarget.value))}
                        error={shown('issuedOn')}
                    />
                )}
                <TextInput
                    label="Drops off"
                    description={
                        loaded
                            ? 'Move it later to extend it. Leave it be and it stays as it is.'
                            : 'Six months on, unless you say otherwise.'
                    }
                    placeholder="YYYY-MM-DD"
                    value={draft.dropsOffOn}
                    onChange={(event) => change('dropsOffOn', withDropsOffOn(draft, event.currentTarget.value))}
                    error={shown('dropsOffOn')}
                />
            </Group>

            <Group justify="flex-end" gap="sm">
                <Button variant="subtle" color="gray" onClick={onClose} disabled={busy}>
                    Cancel
                </Button>
                <Button color="brand" loading={busy} disabled={!canSave} onClick={() => void handleSave()}>
                    {loaded ? 'Save changes' : 'Issue warning'}
                </Button>
            </Group>
        </Stack>
    );
}
