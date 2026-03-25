/** Discussion kind from GitHub Actions / webhook (issue_comment). */
export type DiscussionKind = "issue" | "pull_request";

const BRANCH_REF_RE = /^ai\/(issue|pr)-(\d+)$/;

/**
 * Deterministic plan / implementation branch for an issue or PR-thread discussion.
 * Same ref is used for plan commits and follow-up implementation; do not rename.
 */
export function buildPlanBranchRef(input: {
    kind: DiscussionKind;
    number: number;
}): string {
    const n = Math.floor(input.number);
    if (!Number.isFinite(n) || n < 1) {
        throw new Error(`Invalid discussion number: ${String(input.number)}`);
    }
    const segment = input.kind === "pull_request" ? "pr" : "issue";
    return `ai/${segment}-${n}`;
}

export type ParsedPlanBranchRef =
    | { kind: DiscussionKind; number: number }
    | null;

/** Parse a branch ref produced by {@link buildPlanBranchRef}. */
export function parsePlanBranchRef(ref: string): ParsedPlanBranchRef {
    const normalized = ref.trim().replace(/^refs\/heads\//, "");
    const m = normalized.match(BRANCH_REF_RE);
    if (!m) return null;
    const segment = m[1];
    const number = Number(m[2]);
    if (!Number.isFinite(number) || number < 1) return null;
    const kind: DiscussionKind = segment === "pr" ? "pull_request" : "issue";
    return { kind, number };
}
