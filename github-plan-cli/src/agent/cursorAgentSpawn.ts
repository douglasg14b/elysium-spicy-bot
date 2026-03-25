import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { agentModelFromEnv, agentSubprocessEnv } from "./agentEnv.js";
import { formatAgentFailureMessage } from "./formatAgentFailureMessage.js";

/** Token / cost usage when the Cursor CLI returns JSON with a usage object. */
export type CursorAgentUsage = {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
};

export type SpawnCursorAgentOptions = {
    /** Label for logs and errors. */
    name: string;
    /** Passed to `agent --workspace`. */
    workspaceRoot: string;
    /** `cwd` for the child process; defaults to `workspaceRoot`. */
    processCwd?: string;
    mode: "ask" | "plan";
    /** Full prompt (slash command + instructions). */
    prompt: string;
    model?: string;
};

export type CursorAgentSpawnResult = {
    exitCode: number;
    durationMs: number;
    rawStdout: string;
    rawStderr: string;
    usage: CursorAgentUsage | undefined;
    /** Assistant-visible text when JSON output wraps a `result` field. */
    assistantTranscript: string;
};

/** Parse Cursor CLI `--output-format json` stdout (best-effort). Exported for unit tests. */
export function parseCursorAgentJsonOutput(stdout: string): {
    assistantTranscript: string;
    usage: CursorAgentUsage | undefined;
} {
    const trimmed = stdout.trim();
    if (trimmed === "") {
        return { assistantTranscript: "", usage: undefined };
    }
    try {
        const json = JSON.parse(trimmed) as Record<string, unknown>;
        const assistantTranscript = String(
            json.result ?? json.message ?? json.output ?? json.text ?? "",
        );
        const usage = extractUsage(json);
        return { assistantTranscript, usage };
    } catch {
        return { assistantTranscript: trimmed, usage: undefined };
    }
}

function extractUsage(json: Record<string, unknown>): CursorAgentUsage | undefined {
    const usageUnknown = json.usage;
    if (usageUnknown === null || typeof usageUnknown !== "object") {
        return undefined;
    }
    const usageRecord = usageUnknown as Record<string, unknown>;
    const inputTokens = Number(usageRecord.input_tokens ?? usageRecord.prompt_tokens ?? 0) || 0;
    const outputTokens = Number(usageRecord.output_tokens ?? usageRecord.completion_tokens ?? 0) || 0;
    const cacheReadTokens =
        Number(usageRecord.cache_read_input_tokens ?? usageRecord.cache_read_tokens ?? 0) || 0;
    const cacheCreationTokens =
        Number(usageRecord.cache_creation_input_tokens ?? usageRecord.cache_creation_tokens ?? 0) || 0;
    const costUsd = Number(json.total_cost_usd ?? usageRecord.total_cost_usd ?? 0) || 0;
    if (
        inputTokens === 0 &&
        outputTokens === 0 &&
        cacheReadTokens === 0 &&
        cacheCreationTokens === 0 &&
        costUsd === 0
    ) {
        return undefined;
    }
    return {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        costUsd,
    };
}

function buildAgentArgv(options: SpawnCursorAgentOptions): string[] {
    const model = options.model ?? agentModelFromEnv();
    return [
        "-p",
        "--trust",
        "--workspace",
        options.workspaceRoot,
        `--mode=${options.mode}`,
        "--output-format",
        "json",
        "--model",
        model,
        options.prompt,
    ];
}

/**
 * Run Cursor `agent` CLI asynchronously (JSON stdout, usage when present).
 */
export async function spawnCursorAgent(options: SpawnCursorAgentOptions): Promise<CursorAgentSpawnResult> {
    const cwd = options.processCwd ?? options.workspaceRoot;
    const args = buildAgentArgv(options);
    const start = performance.now();

    return await new Promise<CursorAgentSpawnResult>((resolve, reject) => {
        const child = spawn("agent", args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            env: agentSubprocessEnv(),
        });

        let rawStdout = "";
        let rawStderr = "";

        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
            rawStdout += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
            rawStderr += chunk;
        });

        child.on("error", (error) => {
            reject(new Error(`Failed to spawn agent for "${options.name}": ${error.message}`));
        });

        child.on("close", (code) => {
            const durationMs = Math.round(performance.now() - start);
            const parsed = parseCursorAgentJsonOutput(rawStdout);
            resolve({
                exitCode: code ?? -1,
                durationMs,
                rawStdout,
                rawStderr,
                usage: parsed.usage,
                assistantTranscript: parsed.assistantTranscript,
            });
        });
    });
}

/**
 * Synchronous `agent` invocation (same argv as {@link spawnCursorAgent}).
 */
export function spawnCursorAgentSync(options: SpawnCursorAgentOptions): CursorAgentSpawnResult {
    const cwd = options.processCwd ?? options.workspaceRoot;
    const args = buildAgentArgv(options);
    const start = performance.now();
    const proc = spawnSync("agent", args, {
        encoding: "utf8",
        cwd,
        env: agentSubprocessEnv(),
        maxBuffer: 64 * 1024 * 1024,
    });
    const durationMs = Math.round(performance.now() - start);
    const rawStdout = proc.stdout ?? "";
    const rawStderr = proc.stderr ?? "";
    const parsed = parseCursorAgentJsonOutput(rawStdout);
    return {
        exitCode: proc.status ?? -1,
        durationMs,
        rawStdout,
        rawStderr,
        usage: parsed.usage,
        assistantTranscript: parsed.assistantTranscript,
    };
}

export async function spawnCursorAgentsParallel(
    runs: SpawnCursorAgentOptions[],
): Promise<CursorAgentSpawnResult[]> {
    return await Promise.all(runs.map((run) => spawnCursorAgent(run)));
}

export function assertCursorAgentSucceeded(label: string, result: CursorAgentSpawnResult): void {
    if (result.exitCode !== 0) {
        throw new Error(
            formatAgentFailureMessage(label, result.exitCode, result.rawStderr, result.rawStdout),
        );
    }
}
