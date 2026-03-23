/** Best-effort HTTP status from Octokit / fetch-style errors. */
export function getHttpStatusFromError(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null || !("status" in error)) {
        return undefined;
    }
    const status = (error as { status: unknown }).status;
    return typeof status === "number" ? status : undefined;
}
