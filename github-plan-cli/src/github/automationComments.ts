import type { Octokit } from "@octokit/rest";
import {
    AUTO_COMMENT_PREFIX,
    BRANCH_PIN_MARKER,
    withAutomationPrefix,
} from "../config/githubPlanConstants.js";
import type { RepoIdentity } from "./octokit.js";

export { BRANCH_PIN_MARKER } from "../config/githubPlanConstants.js";

const UNAUTHORIZED_BODY =
    "I can only run Jarvis planning automation for repository collaborators with write access.";

export function nonPlanIntentBody(intent: string): string {
    return `Detected intent: **${intent}**. Full plan generation runs only when intent is **plan** or **plan_feedback**.`;
}

export const IMPLEMENT_NO_PLAN_BODY =
    "Cannot implement: there is **no implementation plan** on this discussion’s plan branch yet (`.jarvis/plan.md` is missing or empty). Ask Jarvis for a **plan** first, then request implementation.";

export function failureBody(runUrl: string): string {
    return `Workflow failed while generating the implementation plan.\n\nDetails: [View workflow run](${runUrl})`;
}

export function failureBodyImplement(runUrl: string): string {
    return `Workflow failed while implementing from the plan.\n\nDetails: [View workflow run](${runUrl})`;
}

/** Intent-detection job failed before plan or implement workflows ran. */
export function failureBodyIntentPhase(runUrl: string): string {
    return `Jarvis workflow failed during **intent detection** (before plan or implement steps).\n\nDetails: [View workflow run](${runUrl})`;
}

export async function createIssueComment(
    octokit: Octokit,
    repo: RepoIdentity,
    issueNumber: number,
    body: string,
): Promise<number> {
    const { data } = await octokit.rest.issues.createComment({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: issueNumber,
        body,
    });
    return data.id;
}

/** Post a comment authored by github-plan automation (adds hidden prefix for context filtering). */
export async function postAutomationIssueComment(
    octokit: Octokit,
    repo: RepoIdentity,
    issueNumber: number,
    bodyWithoutPrefix: string,
): Promise<number> {
    return await createIssueComment(octokit, repo, issueNumber, withAutomationPrefix(bodyWithoutPrefix));
}

export async function updateIssueComment(
    octokit: Octokit,
    repo: RepoIdentity,
    commentId: number,
    body: string,
): Promise<void> {
    await octokit.rest.issues.updateComment({
        owner: repo.owner,
        repo: repo.repo,
        comment_id: commentId,
        body,
    });
}

async function findCommentWithMarker(
    octokit: Octokit,
    repo: RepoIdentity,
    issueNumber: number,
    marker: string,
): Promise<number | null> {
    let page = 1;
    for (;;) {
        const { data } = await octokit.rest.issues.listComments({
            owner: repo.owner,
            repo: repo.repo,
            issue_number: issueNumber,
            per_page: 100,
            page,
        });
        for (const c of data) {
            if (c.body?.includes(marker)) return c.id;
        }
        if (data.length < 100) break;
        page += 1;
    }
    return null;
}

function branchPinBody(branchRef: string): string {
    return [
        `${BRANCH_PIN_MARKER}`,
        "",
        `**Plan branch:** \`${branchRef}\``,
        "",
        "Automation updates this comment when the plan branch is (re)generated.",
    ].join("\n");
}

export async function upsertBranchPinComment(
    octokit: Octokit,
    repo: RepoIdentity,
    issueNumber: number,
    branchRef: string,
): Promise<void> {
    const body = withAutomationPrefix(branchPinBody(branchRef));
    const existingId = await findCommentWithMarker(octokit, repo, issueNumber, BRANCH_PIN_MARKER);
    if (existingId != null) {
        await octokit.rest.issues.updateComment({
            owner: repo.owner,
            repo: repo.repo,
            comment_id: existingId,
            body,
        });
        return;
    }
    await createIssueComment(octokit, repo, issueNumber, body);
}

const PLAN_DETAILS_CLOSE = "\n\n</details>";

function planDetailsOpen(summaryLine: string): string {
    return `<details>\n<summary>${summaryLine}</summary>\n\n`;
}

function planSummaryLine(isPlanFeedbackRun: boolean): string {
    return isPlanFeedbackRun ? "Implementation plan (revised)" : "Implementation plan";
}

function truncateUtf8(s: string, maxBytes: number): string {
    if (maxBytes <= 0) return "";
    const buf = Buffer.from(s, "utf8");
    if (buf.length <= maxBytes) return s;
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
    return buf.subarray(0, end).toString("utf8");
}

/** Markdown inside `<details>` only (no wrapper tags). */
function buildTruncatedDetailsInner(
    planMarkdown: string,
    innerByteBudget: number,
    detailsOpen: string,
): string {
    if (innerByteBudget <= 0) {
        return "_Plan content could not fit in this comment._";
    }
    const fullInner = planMarkdown;
    const innerBytes = Buffer.byteLength(fullInner, "utf8");
    if (innerBytes <= innerByteBudget) {
        return fullInner;
    }
    const totalBytes = Buffer.byteLength(
        `${AUTO_COMMENT_PREFIX}${detailsOpen}${fullInner}${PLAN_DETAILS_CLOSE}`,
        "utf8",
    );
    const note = `_Plan was too long for a single GitHub comment (${String(totalBytes)} bytes total), so this is a truncated preview._\n\n`;
    const footer = "\n\n... _truncated_ ...";
    const overhead = Buffer.byteLength(note + footer, "utf8");
    const planBudget = Math.max(0, innerByteBudget - overhead);
    const truncated = truncateUtf8(fullInner, planBudget);
    return `${note}${truncated}${footer}`;
}

function buildPlanCommentCore(
    planMarkdown: string,
    maxBytes: number,
    isPlanFeedbackRun: boolean,
): string {
    const open = planDetailsOpen(planSummaryLine(isPlanFeedbackRun));
    const close = PLAN_DETAILS_CLOSE;
    const fixed = `${AUTO_COMMENT_PREFIX}${open}${close}`;
    const innerBudget = maxBytes - Buffer.byteLength(fixed, "utf8");
    const inner = buildTruncatedDetailsInner(planMarkdown, innerBudget, open);
    return `${AUTO_COMMENT_PREFIX}${open}${inner}${close}`;
}

/**
 * Single issue comment body after plan generation: branch line plus either the plan (in `<details>`)
 * or a short message when nothing new was committed.
 */
export function buildPlanThreadFinalBody(input: {
    branchRef: string;
    committed: boolean;
    planMarkdown: string;
    maxBytes: number;
    /** When true, copy reflects a revision pass (vs first-time plan). */
    isPlanFeedbackRun?: boolean;
}): string {
    const isPlanFeedbackRun = input.isPlanFeedbackRun ?? false;
    const branchBlock = `**Plan branch:** \`${input.branchRef}\`\n\n`;
    if (!input.committed) {
        const noCommitLine = isPlanFeedbackRun
            ? "The revised plan matches what is already on this branch — no new commit was pushed."
            : "The generated plan matches what is already on this branch — no new commit was pushed.";
        return withAutomationPrefix(`${branchBlock}${noCommitLine}`);
    }
    const open = planDetailsOpen(planSummaryLine(isPlanFeedbackRun));
    const close = PLAN_DETAILS_CLOSE;
    const frameWithoutInner = `${AUTO_COMMENT_PREFIX}${branchBlock}${open}${close}`;
    const innerBudget = input.maxBytes - Buffer.byteLength(frameWithoutInner, "utf8");
    const inner = buildTruncatedDetailsInner(input.planMarkdown, innerBudget, open);
    return `${AUTO_COMMENT_PREFIX}${branchBlock}${open}${inner}${close}`;
}

export async function postPlanComment(
    octokit: Octokit,
    repo: RepoIdentity,
    issueNumber: number,
    planMarkdown: string,
    maxBytes: number,
    isPlanFeedbackRun = false,
): Promise<void> {
    const body = buildPlanCommentCore(planMarkdown, maxBytes, isPlanFeedbackRun);
    await createIssueComment(octokit, repo, issueNumber, body);
}

export async function notifyUnauthorized(
    octokit: Octokit,
    repo: RepoIdentity,
    issueNumber: number,
): Promise<void> {
    await postAutomationIssueComment(octokit, repo, issueNumber, UNAUTHORIZED_BODY);
}

export async function notifyFailure(
    octokit: Octokit,
    repo: RepoIdentity,
    issueNumber: number,
    runUrl: string,
): Promise<void> {
    await postAutomationIssueComment(octokit, repo, issueNumber, failureBody(runUrl));
}

export async function notifyFailureImplement(
    octokit: Octokit,
    repo: RepoIdentity,
    issueNumber: number,
    runUrl: string,
): Promise<void> {
    await postAutomationIssueComment(octokit, repo, issueNumber, failureBodyImplement(runUrl));
}

export async function notifyFailureIntentPhase(
    octokit: Octokit,
    repo: RepoIdentity,
    issueNumber: number,
    runUrl: string,
): Promise<void> {
    await postAutomationIssueComment(octokit, repo, issueNumber, failureBodyIntentPhase(runUrl));
}

/** Thread comment after a PR was created or updated from implement automation. */
export function implementPrReadyBody(prUrl: string, branchRef: string): string {
    return `Opened/updated pull request for this implementation: ${prUrl}\n\n**Branch:** \`${branchRef}\``;
}
