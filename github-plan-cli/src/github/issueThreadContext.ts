import type { Octokit } from "@octokit/rest";
import { shouldExcludeCommentFromContext } from "../config/githubPlanConstants.js";
import type { DiscussionKind } from "../plan/planBranch.js";
import type { RepoIdentity } from "./octokit.js";

export type ThreadCommentForContext = {
    readonly userLogin: string;
    readonly createdAt: string;
    readonly body: string;
};

export async function listIssueCommentsForContext(
    octokit: Octokit,
    repo: RepoIdentity,
    issueNumber: number,
): Promise<ThreadCommentForContext[]> {
    const out: ThreadCommentForContext[] = [];
    let page = 1;
    for (;;) {
        const { data } = await octokit.rest.issues.listComments({
            owner: repo.owner,
            repo: repo.repo,
            issue_number: issueNumber,
            per_page: 100,
            page,
        });
        for (const comment of data) {
            const body = comment.body ?? "";
            if (shouldExcludeCommentFromContext(body)) {
                continue;
            }
            out.push({
                userLogin: comment.user?.login ?? "unknown",
                createdAt: comment.created_at ?? "",
                body,
            });
        }
        if (data.length < 100) {
            break;
        }
        page += 1;
    }
    out.sort((first, second) => {
        const timeA = Date.parse(first.createdAt);
        const timeB = Date.parse(second.createdAt);
        if (Number.isNaN(timeA) || Number.isNaN(timeB)) {
            return 0;
        }
        return timeA - timeB;
    });
    return out;
}

/**
 * Last comment in chronological order after `shouldExcludeCommentFromContext` filtering.
 * Matches the intent-detector prompt: "last comment in the thread".
 */
export function latestThreadCommentForIntent(
    comments: readonly ThreadCommentForContext[],
): ThreadCommentForContext | undefined {
    if (comments.length === 0) {
        return undefined;
    }
    return comments[comments.length - 1];
}

export function formatCommentThreadSection(comments: readonly ThreadCommentForContext[]): string {
    if (comments.length === 0) {
        return "### Comment thread\n\n_(No human comments yet; automation-only or empty.)_\n";
    }
    const blocks = comments.map((comment, index) => {
        const header = `#### Comment ${String(index + 1)} — @${comment.userLogin} — ${comment.createdAt}`;
        return `${header}\n\n${comment.body}\n`;
    });
    return `### Comment thread\n\n${blocks.join("\n---\n\n")}\n`;
}

export function formatCurrentPlanSection(planMarkdown: string, branchRef: string): string {
    const trimmed = planMarkdown.trim();
    if (!trimmed) {
        return "";
    }
    return [
        "## Current plan (from branch)",
        "",
        `Branch: \`${branchRef}\``,
        "",
        trimmed,
        "",
    ].join("\n");
}

/**
 * Full markdown for `.jarvis/intent-context.md`: description, optional committed plan, chronological human comments.
 */
export function buildRichIntentContextMarkdown(input: {
    kind: DiscussionKind;
    number: number;
    title: string;
    body: string;
    comments: readonly ThreadCommentForContext[];
    currentPlanSection: string;
}): string {
    const header =
        input.kind === "pull_request"
            ? `## Pull request #${String(input.number)}\n\n`
            : `## GitHub issue #${String(input.number)}\n\n`;
    const descriptionBody = input.body ?? "";
    const description = `${header}### Title\n\n${input.title}\n\n### Body\n\n${descriptionBody}\n`;
    const planBlock =
        input.currentPlanSection.trim() === "" ? "" : `\n${input.currentPlanSection.trim()}\n\n`;
    const thread = formatCommentThreadSection(input.comments);
    return `${description}${planBlock}${thread}`;
}
