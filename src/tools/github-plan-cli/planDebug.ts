function truthyEnv(value: string | undefined): boolean {
    if (!value) {
        return false;
    }
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
}

function explicitPlanDebugOff(value: string | undefined): boolean {
    if (!value) {
        return false;
    }
    const normalized = value.trim().toLowerCase();
    return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

/**
 * Whether to emit `[github-plan:debug]` lines on stderr.
 *
 * - **GitHub Actions** (`GITHUB_ACTIONS=true`): on by default. Set `GITHUB_PLAN_DEBUG` to `0`, `false`, `no`, or `off` to disable.
 * - **Elsewhere**: off unless `GITHUB_PLAN_DEBUG` is `1`, `true`, or `yes`.
 */
export function isPlanCliDebugEnabled(): boolean {
    if (explicitPlanDebugOff(process.env.GITHUB_PLAN_DEBUG)) {
        return false;
    }
    if (truthyEnv(process.env.GITHUB_PLAN_DEBUG)) {
        return true;
    }
    return process.env.GITHUB_ACTIONS === "true";
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
