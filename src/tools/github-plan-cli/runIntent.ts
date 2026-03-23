import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import {
    agentModelFromEnv,
    agentSubprocessEnv,
    assertCursorAgentApiKeyConfigured,
    cursorApiKeyFromEnv,
    JARVIS_INTENT_RESULT_FILENAME,
    JARVIS_WORKSPACE_DIR,
    workspaceRoot,
} from "./agentEnv.js";
import { formatAgentFailureMessage } from "./agentProcess.js";
import { buildPlanBranchRef, type DiscussionKind } from "./planBranch.js";
import { parseIntentFromResultFileContents } from "./intentParse.js";
import type { RepoIdentity } from "./octokit.js";
import { readIssueCommentEvent } from "./githubEvent.js";
import { writeGithubOutput } from "./githubOutput.js";
import {
    buildRichIntentContextMarkdown,
    formatCurrentPlanSection,
    latestThreadCommentForIntent,
    listIssueCommentsForContext,
} from "./threadContext.js";
import { fetchPlanMarkdownFromBranch } from "./planContent.js";
import { isPlanCliDebugEnabled, planDebugLog, truncateForPlanDebug } from "./planDebug.js";

export async function runIntentClassification(input: {
    octokit: Octokit;
    repo: RepoIdentity;
    eventPath: string;
    discussionKind: DiscussionKind;
    discussionNumber: number;
}): Promise<{ intent: string; runPlan: boolean }> {
    const payload = readIssueCommentEvent(input.eventPath);
    assertCursorAgentApiKeyConfigured();

    const triggerBody = payload.comment.body ?? "";
    planDebugLog("runIntentClassification: webhook comment (triggered this workflow run)", {
        userLogin: payload.comment.user?.login ?? "(unknown)",
        bodyChars: triggerBody.length,
        body: truncateForPlanDebug(triggerBody),
    });

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

    const latestForIntent = latestThreadCommentForIntent(comments);
    if (latestForIntent !== undefined) {
        planDebugLog(
            "runIntentClassification: latest comment in intent context (skill: classify this — last in thread)",
            {
                userLogin: latestForIntent.userLogin,
                createdAt: latestForIntent.createdAt,
                bodyChars: latestForIntent.body.length,
                body: truncateForPlanDebug(latestForIntent.body),
                triggerBodyMatchesThis:
                    latestForIntent.body === triggerBody && latestForIntent.body.length > 0,
            },
        );
    } else {
        planDebugLog(
            "runIntentClassification: no comments in intent context after filters; agent only sees title/body/plan",
            { triggerHadBody: triggerBody.trim().length > 0 },
        );
    }

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
    const intentResultAbs = join(jarvisDir, JARVIS_INTENT_RESULT_FILENAME);
    const intentResultRel = `${JARVIS_WORKSPACE_DIR}/${JARVIS_INTENT_RESULT_FILENAME}`;
    if (existsSync(intentResultAbs)) {
        unlinkSync(intentResultAbs);
    }
    writeFileSync(join(jarvisDir, "intent-context.md"), md, "utf8");

    planDebugLog("runIntentClassification: wrote intent context", {
        intentContextChars: md.length,
        titleChars: title.length,
        bodyChars: body.length,
        intentResultRel,
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
        `/intent-detector Read ${intentContextPath}. It contains the issue/PR title and body, optional current plan from the plan branch, and the human comment thread (automation comments are omitted). Classify the **latest user request** (last comment in the thread). This automation is invoked by **Jarvis**; if they ask Jarvis (or generically ask) to **make / write / create** an implementation or technical **plan** for **this** issue, that is intent **plan**, not **other**. **plan_feedback** only when they clearly revise an **existing** plan. **Required:** write **exactly one** JSON object (intent, confidence, reason) to the workspace file \`${intentResultRel}\` — UTF-8, JSON only, no markdown fences and no prose in that file. The automation **only** reads that file and **fails** if it is missing or invalid; do not rely on stdout for the result.`,
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

    if (!existsSync(intentResultAbs)) {
        throw new Error(
            `Intent classification did not produce ${intentResultRel}. The agent must write the intent JSON object to that path.`,
        );
    }
    const fileText = readFileSync(intentResultAbs, "utf8");
    const parsed = parseIntentFromResultFileContents(fileText);
    if (parsed === null) {
        throw new Error(
            `${intentResultRel} exists but is not valid intent JSON (expected one object with intent, confidence, reason and a known intent value).`,
        );
    }

    planDebugLog("runIntentClassification: parsed intent from file", {
        intent: parsed.intent,
        runPlan: parsed.runPlan,
    });
    if (isPlanCliDebugEnabled() && parsed.intent === "other") {
        planDebugLog("runIntentClassification: agent stdout preview (intent was other)", {
            stdoutPreview: truncateForPlanDebug(out, 6_000),
        });
    }
    writeGithubOutput("intent", parsed.intent);
    writeGithubOutput("run_plan", parsed.runPlan ? "true" : "false");
    return parsed;
}
