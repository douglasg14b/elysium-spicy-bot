import type { UnpublishedResource } from '@brattybot/web-sdk';

/** The toast an uninstall ends with, as both resources dialogs show it. */
export interface UninstallNotice {
    readonly color: 'orange' | 'brand';
    readonly title: 'Partly done' | 'Uninstalled';
    readonly message: string;
}

/**
 * What an uninstall's results come to, for the operator.
 *
 * Anything `failed`, and anything `refused` that the operator was not already shown would be
 * kept, is still in the server, so the run is "Partly done", not "Uninstalled". A refusal they
 * were shown — an adopted channel the plan said it would leave — is the uninstall doing what
 * it promised, and still reads as done. One they were not — a message an install posted again
 * between the plan and the confirm, which stays up with its record — must not be called
 * uninstalled.
 *
 * @param shownAsKept the resource keys the dialog listed as left alone before the confirm
 *   (`PublishedFlowState.refusedResources`).
 */
export function uninstallNotice(
    results: readonly UnpublishedResource[],
    shownAsKept: ReadonlySet<string>
): UninstallNotice {
    const deleted = results.filter((result) => result.outcome === 'deleted').length;
    const leftInPlace = results.filter(
        (result) =>
            result.outcome === 'failed' || (result.outcome === 'refused' && !shownAsKept.has(result.resourceKey))
    );
    const [first] = leftInPlace;

    if (!first) {
        return {
            color: 'brand',
            title: 'Uninstalled',
            message: `${deleted} thing${deleted === 1 ? '' : 's'} deleted from the server. Anything adopted was left exactly where it was.`,
        };
    }
    return {
        color: 'orange',
        title: 'Partly done',
        message: `${deleted} deleted; ${leftInPlace.length} left in place: ${first.explanation ?? 'Discord said no.'}`,
    };
}
