import { readFileSync } from "node:fs";
import { z } from "zod";

const issueCommentSchema = z.object({
    issue: z.object({
        number: z.number().int().positive(),
        pull_request: z.unknown().optional().nullable(),
    }),
    comment: z.object({
        body: z.string().nullable().optional(),
    }),
});

export type IssueCommentPayload = z.infer<typeof issueCommentSchema>;

export function readIssueCommentEvent(eventPath: string): IssueCommentPayload {
    const raw = readFileSync(eventPath, "utf8");
    const json: unknown = JSON.parse(raw);
    return issueCommentSchema.parse(json);
}

export function discussionKindFromPayload(payload: IssueCommentPayload): "issue" | "pull_request" {
    return payload.issue.pull_request != null ? "pull_request" : "issue";
}

/** True when the comment mentions the Jarvis automation trigger word (word boundary, case-insensitive). */
export function commentMentionsJarvis(body: string | null | undefined): boolean {
    const b = body ?? "";
    return /\bjarvis\b/i.test(b);
}
