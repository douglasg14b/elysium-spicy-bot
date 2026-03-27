import { z } from "zod";

/** Relative to repo root; written by the Cursor implement orchestrator, not committed. */
export const PR_DRAFT_RELATIVE_PATH = ".jarvis/pr-draft.json";

const PR_DRAFT_SCHEMA = z.object({
    /** Schema version for forward compatibility. */
    version: z.literal(1),
    /** GitHub PR title. */
    title: z.string().min(1).max(512),
    /** GitHub PR body (markdown). */
    bodyMarkdown: z.string().min(1),
});

export type PrDraft = z.infer<typeof PR_DRAFT_SCHEMA>;

export const PR_DRAFT_JSON_SCHEMA = PR_DRAFT_SCHEMA.toJSONSchema();

/**
 * Parse and validate `.jarvis/pr-draft.json` after the implement orchestrator run.
 */
export function parsePrDraftJson(raw: string): PrDraft {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch {
        throw new Error(`${PR_DRAFT_RELATIVE_PATH} is not valid JSON.`);
    }
    const result = PR_DRAFT_SCHEMA.safeParse(parsed);
    if (!result.success) {
        throw new Error(
            `${PR_DRAFT_RELATIVE_PATH} failed validation: ${result.error.message}`,
        );
    }
    return result.data;
}
