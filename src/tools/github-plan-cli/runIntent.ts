import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import {
    agentModelFromEnv,
    agentSubprocessEnv,
    assertCursorAgentApiKeyConfigured,
    cursorApiKeyFromEnv,
    JARVIS_WORKSPACE_DIR,
    workspaceRoot,
} from "./agentEnv.js";
import { formatAgentFailureMessage } from "./agentProcess.js";
import { buildPlanBranchRef, type DiscussionKind } from "./planBranch.js";
import { parseIntentFromAgentJson } from "./intentParse.js";
import type { RepoIdentity } from "./octokit.js";
import { readIssueCommentEvent } from "./githubEvent.js";
import { writeGithubOutput } from "./githubOutput.js";
import {
    buildRichIntentContextMarkdown,
    formatCurrentPlanSection,
    listIssueCommentsForContext,
} from "./threadContext.js";
import { fetchPlanMarkdownFromBranch } from "./planContent.js";
import { planDebugLog } from "./planDebug.js";

export async function runIntentClassification(input: {
    octokit: Octokit;
    repo: RepoIdentity;
    eventPath: string;
    discussionKind: DiscussionKind;
    discussionNumber: number;
}): Promise<{ intent: string; runPlan: boolean }> {
    readIssueCommentEvent(input.eventPath);
    assertCursorAgentApiKeyConfigured();

    const branchRef = buildPlanBranchRef({
        kind: input.discussionKind,
        number: input.discussionNumber,
    });
    planDebugLog("runIntentClassification: start", {
        kind: input.discussionKind,
        number: input.discussionNumber,
        branchRef,
        repo: `${input.repo.owner}/${input.repo.repo}`,
    });

    const [{ data: issue }, comments, planFromBranch] = await Promise.all([
        input.octokit.rest.issues.get({
            owner: input.repo.owner,
            repo: input.repo.repo,
            issue_number: input.discussionNumber,
        }),
        listIssueCommentsForContext(input.octokit, input.repo, input.discussionNumber),
        fetchPlanMarkdownFromBranch(input.octokit, input.repo, branchRef),
    ]);

    planDebugLog("runIntentClassification: thread loaded", {
        commentCount: comments.length,
        hasCurrentPlanSection: planFromBranch != null && planFromBranch.trim() !== "",
        planChars: planFromBranch?.length ?? 0,
    });

    const title = issue.title ?? "";
    const body = issue.body ?? "";
    const currentPlanSection =
        planFromBranch != null && planFromBranch.trim() !== ""
            ? formatCurrentPlanSection(planFromBranch, branchRef)
            : "";

    const md = buildRichIntentContextMarkdown({
        kind: input.discussionKind,
        number: input.discussionNumber,
        title,
        body,
        comments,
        currentPlanSection,
    });

    const root = workspaceRoot();
    const jarvisDir = join(root, JARVIS_WORKSPACE_DIR);
    mkdirSync(jarvisDir, { recursive: true });
    writeFileSync(join(jarvisDir, "intent-context.md"), md, "utf8");

    planDebugLog("runIntentClassification: wrote intent context", {
        intentContextChars: md.length,
        titleChars: title.length,
        bodyChars: body.length,
    });

    const intentContextPath = `${JARVIS_WORKSPACE_DIR}/intent-context.md`;
    const agentArgs = [
        "-p",
        "--trust",
        "--workspace",
        root,
        "--mode=ask",
        "--output-format",
        "json",
        "--model",
        agentModelFromEnv(),
        `/intent-detector Read ${intentContextPath}. It contains the issue/PR title and body, optional current plan from the plan branch, and the human comment thread (automation comments are omitted). Classify the latest user request (last comment in the thread) and return exactly one JSON object matching the skill schema.`,
    ];
    planDebugLog("runIntentClassification: spawning agent", {
        model: agentModelFromEnv(),
        hasCursorApiKey: Boolean(cursorApiKeyFromEnv()),
    });
    const proc = spawnSync("agent", agentArgs, {
        encoding: "utf8",
        cwd: root,
        env: agentSubprocessEnv(),
        maxBuffer: 64 * 1024 * 1024,
    });
    if (proc.error) {
        throw proc.error;
    }
    if (proc.status !== 0) {
        throw new Error(
            formatAgentFailureMessage("agent (intent)", proc.status, proc.stderr ?? "", proc.stdout ?? ""),
        );
    }
    const out = proc.stdout ?? "";
    planDebugLog("runIntentClassification: agent finished", {
        stdoutChars: out.length,
        stderrChars: (proc.stderr ?? "").length,
    });
    const parsed = parseIntentFromAgentJson(out);
    planDebugLog("runIntentClassification: parsed intent", {
        intent: parsed.intent,
        runPlan: parsed.runPlan,
    });
    writeGithubOutput("intent", parsed.intent);
    writeGithubOutput("run_plan", parsed.runPlan ? "true" : "false");
    return parsed;
}
