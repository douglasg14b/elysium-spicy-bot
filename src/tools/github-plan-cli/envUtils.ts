import type { DiscussionKind } from "./planBranch.js";

export function parseDiscussionKind(raw: string | undefined): DiscussionKind {
    const s = raw?.trim();
    if (s === "pull_request" || s === "issue") {
        return s;
    }
    throw new Error(`DISCUSSION_KIND must be "issue" or "pull_request", got: ${String(raw)}`);
}

export function parseDiscussionNumber(raw: string | undefined): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
        throw new Error(`DISCUSSION_NUMBER must be a positive integer, got: ${String(raw)}`);
    }
    return n;
}
