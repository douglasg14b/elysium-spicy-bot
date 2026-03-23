function truthyEnv(value: string | undefined): boolean {
    if (!value) {
        return false;
    }
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
}

/** When set (1/true/yes), emit `[github-plan:debug]` lines on stderr for intent/plan gathering. */
export function isPlanCliDebugEnabled(): boolean {
    return truthyEnv(process.env.GITHUB_PLAN_DEBUG);
}

export function planDebugLog(
    message: string,
    details?: Record<string, string | number | boolean | undefined>,
): void {
    if (!isPlanCliDebugEnabled()) {
        return;
    }
    const suffix =
        details !== undefined && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
    console.error(`[github-plan:debug] ${message}${suffix}`);
}
