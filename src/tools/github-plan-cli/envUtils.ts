import type { DiscussionKind } from "./planBranch.js";

export function parseDiscussionKind(raw: string | undefined): DiscussionKind {
    const s = raw?.trim();
    if (s === "pull_request" || s === "issue") {
        return s;
    }
    throw new Error(`DISCUSSION_KIND must be "issue" or "pull_request", got: ${String(raw)}`);
}

/** True when `raw` is the string `true` (ASCII case-insensitive); otherwise false. */
export function parseEnvBoolTrue(raw: string | undefined): boolean {
    return raw?.trim().toLowerCase() === "true";
}

export function parseDiscussionNumber(raw: string | undefined): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
        throw new Error(`DISCUSSION_NUMBER must be a positive integer, got: ${String(raw)}`);
    }
    return n;
}
