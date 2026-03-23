import type { Octokit } from "@octokit/rest";
import {
    AUTO_COMMENT_PREFIX,
    BRANCH_PIN_MARKER,
    withAutomationPrefix,
} from "./githubPlanConstants.js";
import type { RepoIdentity } from "./octokit.js";

export { BRANCH_PIN_MARKER } from "./githubPlanConstants.js";

const UNAUTHORIZED_BODY =
    "I can only run Jarvis planning automation for repository collaborators with write access.";

export function nonPlanIntentBody(intent: string): string {
    return `Detected intent: **${intent}**. Full plan generation runs only when intent is **plan**.`;
}

export function failureBody(runUrl: string): string {
    return `Workflow failed while generating the implementation plan.\n\nDetails: [View workflow run](${runUrl})`;
}

export async function createIssueComment(
    octokit: Octokit,
    repo: RepoIdentity,
    issueNumber: number,
    body: string,
): Promise<void> {
    await octokit.rest.issues.createComment({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: issueNumber,
        body,
    });
}

/** Post a comment authored by github-plan automation (adds hidden prefix for context filtering). */
export async function postAutomationIssueComment(
    octokit: Octokit,
    repo: RepoIdentity,
    issueNumber: number,
    bodyWithoutPrefix: string,
): Promise<void> {
    await createIssueComment(octokit, repo, issueNumber, withAutomationPrefix(bodyWithoutPrefix));
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

const PLAN_DETAILS_OPEN = "<details>\n<summary>Implementation plan</summary>\n\n";
const PLAN_DETAILS_CLOSE = "\n\n</details>";

function truncateUtf8(s: string, maxBytes: number): string {
    if (maxBytes <= 0) return "";
    const buf = Buffer.from(s, "utf8");
    if (buf.length <= maxBytes) return s;
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
    return buf.subarray(0, end).toString("utf8");
}

function buildPlanCommentCore(planMarkdown: string, maxBytes: number): string {
    const open = PLAN_DETAILS_OPEN;
    const close = PLAN_DETAILS_CLOSE;
    const prefixBytes = Buffer.byteLength(AUTO_COMMENT_PREFIX, "utf8");
    const frameBytes = Buffer.byteLength(open + close, "utf8");
    const budget = maxBytes - prefixBytes - frameBytes;
    if (budget <= 0) {
        return `${AUTO_COMMENT_PREFIX}${open}_Plan content could not fit in this comment._${close}`;
    }
    const fullInner = planMarkdown;
    const innerBytes = Buffer.byteLength(fullInner, "utf8");
    if (innerBytes <= budget) {
        return `${AUTO_COMMENT_PREFIX}${open}${fullInner}${close}`;
    }
    const totalBytes = Buffer.byteLength(`${AUTO_COMMENT_PREFIX}${open}${fullInner}${close}`, "utf8");
    const note = `_Plan was too long for a single GitHub comment (${String(totalBytes)} bytes total), so this is a truncated preview._\n\n`;
    const footer = "\n\n... _truncated_ ...";
    const overhead = Buffer.byteLength(note + footer, "utf8");
    const planBudget = Math.max(0, budget - overhead);
    const truncated = truncateUtf8(fullInner, planBudget);
    return `${AUTO_COMMENT_PREFIX}${open}${note}${truncated}${footer}${close}`;
}

export async function postPlanComment(
    octokit: Octokit,
    repo: RepoIdentity,
    issueNumber: number,
    planMarkdown: string,
    maxBytes: number,
): Promise<void> {
    const body = buildPlanCommentCore(planMarkdown, maxBytes);
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
