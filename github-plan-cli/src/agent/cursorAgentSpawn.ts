import { spawn, spawnSync } from 'node:child_process';
import { agentModelFromEnv, agentSubprocessEnv, cursorAgentTimeoutMsFromEnv, cursorApiKeyFromEnv } from './agentEnv.js';
import {
    appendNdjsonChunks,
    createNdjsonBufferState,
    extractLastTerminalResultFromNdjsonStdout,
    flushNdjsonRemainder,
    handleNdjsonLine,
} from './cursorAgentStreamFormat.js';
import {
    type CursorAgentResultPayload,
    toCursorAgentResultPayload,
    transcriptFromCursorAgentPayload,
} from './cursorAgentJsonTypes.js';
import { envValueIsExplicitlyOff, envValueIsTruthy } from '../config/envTruthy.js';
import { formatAgentFailureMessage } from './formatAgentFailureMessage.js';
import { isPlanCliDebugEnabled, truncateForPlanDebug } from '../plan/planDebug.js';

const MAX_AGENT_FAILURE_DIAGNOSTIC_STREAM_CHARS = 131_072;
const AGENT_STREAM_IDLE_HEARTBEAT_MS = 20_000;

function formatArgvForDiagnosticsLog(argv: string[]): string {
    return argv.map((part) => JSON.stringify(part)).join(' ');
}

function emitCursorAgentFailureDiagnostics(
    label: string,
    result: CursorAgentSpawnResult,
    options?: SpawnCursorAgentOptions,
): void {
    const lines: string[] = [];
    lines.push(`[github-plan] Cursor agent failed: ${label}`);
    lines.push(`  exitCode: ${String(result.exitCode)}`);
    lines.push(`  durationMs: ${String(result.durationMs)}`);
    lines.push(`  outputFormat: ${result.outputFormat}`);
    lines.push(`  stderrChars: ${String(result.rawStderr.length)}`);
    lines.push(`  stdoutChars: ${String(result.rawStdout.length)}`);
    lines.push(`  cursorApiKeyPresent: ${String(Boolean(cursorApiKeyFromEnv()))}`);

    if (options !== undefined) {
        const model = options.model ?? agentModelFromEnv();
        lines.push(`  mode: ${options.mode}`);
        lines.push(`  model: ${model}`);
        lines.push(`  workspaceRoot: ${options.workspaceRoot}`);
        const argv = buildCursorAgentArgv(options, result.outputFormat);
        const argvForLog = argv.slice(0, -1);
        argvForLog.push(`[prompt ${String(options.prompt.length)} chars]`);
        lines.push(`  argv: agent ${formatArgvForDiagnosticsLog(argvForLog)}`);
    }

    const versionProbe = spawnSync('agent', ['--version'], {
        encoding: 'utf8',
        env: agentSubprocessEnv(),
        timeout: 10_000,
    });
    if (versionProbe.error) {
        lines.push(`  agent --version: spawn error (${versionProbe.error.message})`);
    } else {
        const combined = `${(versionProbe.stdout ?? '').trim()}\n${(versionProbe.stderr ?? '').trim()}`.trim();
        lines.push(
            `  agent --version: exit ${String(versionProbe.status ?? '?')} ${truncateForPlanDebug(combined || '(no output)', 400)}`,
        );
    }

    lines.push('--- agent stderr ---');
    lines.push(
        result.rawStderr.trim() === ''
            ? '(empty)'
            : truncateForPlanDebug(result.rawStderr, MAX_AGENT_FAILURE_DIAGNOSTIC_STREAM_CHARS),
    );
    lines.push('--- agent stdout ---');
    lines.push(
        result.rawStdout.trim() === ''
            ? '(empty)'
            : truncateForPlanDebug(result.rawStdout, MAX_AGENT_FAILURE_DIAGNOSTIC_STREAM_CHARS),
    );
    if (result.rawStderr.trim() === '' && result.rawStdout.trim() === '') {
        lines.push('--- hint ---');
        lines.push(
            'No output from agent. Common causes: missing/invalid CURSOR_API_KEY or JARVIS_API_KEY, `agent` not on PATH for this step, or the CLI exiting before printing (check flags and Cursor CLI release notes).',
        );
    }

    console.error(lines.join('\n'));
}

const MAX_AGENT_IO_CAPTURE_BYTES = 64 * 1024 * 1024;

function appendWithByteCap(accumulated: string, chunk: string, maxBytes: number): string {
    if (accumulated.length >= maxBytes) {
        return accumulated;
    }
    const room = maxBytes - accumulated.length;
    return room >= chunk.length ? accumulated + chunk : accumulated + chunk.slice(0, room);
}

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
    mode: 'ask' | 'plan' | 'agent';
    /** Full prompt (slash command + instructions). */
    prompt: string;
    model?: string;
};

/** How the CLI wrote stdout for this run (affects `rawStdout` shape). */
export type CursorAgentStdoutFormat = 'json' | 'stream-json';

export type CursorAgentSpawnResult = {
    exitCode: number;
    durationMs: number;
    /**
     * Raw stdout from `agent`. With `outputFormat === "json"`, typically one JSON object. With `stream-json`, newline-delimited JSON (full session).
     * Do not assume a single `JSON.parse` works unless `outputFormat === "json"` or you scan for the terminal `result` line.
     */
    rawStdout: string;
    rawStderr: string;
    usage: CursorAgentUsage | undefined;
    /** Assistant-visible text when JSON output wraps a `result` field. */
    assistantTranscript: string;
    /** Mirrors `--output-format` passed to the Cursor CLI. */
    outputFormat: CursorAgentStdoutFormat;
};

/** Parses one top-level JSON object from Cursor `agent` stdout (terminal `result` line or `--output-format json`). */
export function parseCursorAgentResultPayload(json: unknown): {
    assistantTranscript: string;
    usage: CursorAgentUsage | undefined;
} {
    const payload = toCursorAgentResultPayload(json);
    return {
        assistantTranscript: transcriptFromCursorAgentPayload(payload),
        usage: usageFromPayload(payload),
    };
}

/** Parses full stdout when `--output-format json` (single JSON value). */
export function parseCursorAgentJsonOutput(stdout: string): {
    assistantTranscript: string;
    usage: CursorAgentUsage | undefined;
} {
    const trimmed = stdout.trim();
    if (trimmed === '') {
        return { assistantTranscript: '', usage: undefined };
    }
    try {
        const json: unknown = JSON.parse(trimmed);
        return parseCursorAgentResultPayload(json);
    } catch {
        return { assistantTranscript: trimmed, usage: undefined };
    }
}

function usageFromPayload(payload: CursorAgentResultPayload): CursorAgentUsage | undefined {
    const usage = payload.usage;
    if (usage === undefined) {
        return undefined;
    }
    const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
    const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
    const cacheReadTokens = Number(usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? 0) || 0;
    const cacheCreationTokens = Number(usage.cache_creation_input_tokens ?? usage.cache_creation_tokens ?? 0) || 0;
    const costUsd = Number(payload.total_cost_usd ?? usage.total_cost_usd ?? 0) || 0;
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

function buildAgentArgv(options: SpawnCursorAgentOptions, outputFormat: CursorAgentStdoutFormat): string[] {
    const model = options.model ?? agentModelFromEnv();
    const modeArg = options.mode === 'agent' ? undefined : `--mode=${options.mode}`;
    /** Token-level `thinking` / assistant deltas; explodes GitHub Actions log line count. Opt in with `GITHUB_PLAN_STREAM_PARTIAL=1`. */
    const streamPartialArg =
        outputFormat === 'stream-json' && envValueIsTruthy(process.env.GITHUB_PLAN_STREAM_PARTIAL)
            ? ['--stream-partial-output']
            : [];
    /**
     * Headless CI has no human to approve each shell tool call; `--force` matches Cursor CLI “allow commands unless
     * explicitly denied” (see CLI docs). `cli.json` `deny` (e.g. `Shell(rm)`) still applies.
     */
    const forceArg = process.env.GITHUB_ACTIONS === 'true' ? (['--force'] as const) : [];
    return [
        '-p',
        '--trust',
        ...forceArg,
        '--workspace',
        options.workspaceRoot,
        ...(modeArg ? [modeArg] : []),
        '--output-format',
        outputFormat,
        ...streamPartialArg,
        '--model',
        model,
        options.prompt,
    ];
}

/**
 * Resolves Cursor `agent` `--output-format`:
 * - **`json`**: one JSON object on stdout when the run finishes — fewest log lines (best for GitHub Actions).
 * - **`stream-json`**: NDJSON events (tool calls, etc.); without `GITHUB_PLAN_STREAM_PARTIAL=1` we omit `--stream-partial-output` so logs stay much smaller than token-level deltas.
 *
 * Rules:
 * - `GITHUB_PLAN_DEBUG` explicitly off (`0`, `false`, …) → `json`.
 * - **`GITHUB_ACTIONS=true`** and debug **not** explicitly on (`1`, `true`, `yes`) → **`json`** (CI default).
 * - Otherwise → `stream-json`.
 */
export function cursorAgentStdoutFormatFromPlanDebug(): CursorAgentStdoutFormat {
    if (envValueIsExplicitlyOff(process.env.GITHUB_PLAN_DEBUG)) {
        return 'json';
    }
    if (process.env.GITHUB_ACTIONS === 'true' && !envValueIsTruthy(process.env.GITHUB_PLAN_DEBUG)) {
        return 'json';
    }
    return isPlanCliDebugEnabled() ? 'stream-json' : 'json';
}

/** Builds the `agent` argv array (workspace, mode, output format, model, prompt). */
export function buildCursorAgentArgv(
    options: SpawnCursorAgentOptions,
    outputFormat: CursorAgentStdoutFormat,
): string[] {
    return buildAgentArgv(options, outputFormat);
}

/** Parses captured stdout after {@link spawnCursorAgent} / {@link spawnCursorAgentSync} complete. */
export function parseCursorAgentStdoutSnapshot(
    rawStdout: string,
    outputFormat: CursorAgentStdoutFormat,
    lastTerminalResult: Record<string, unknown> | undefined,
): {
    assistantTranscript: string;
    usage: CursorAgentUsage | undefined;
} {
    let terminal = lastTerminalResult;
    if (outputFormat === 'stream-json' && terminal === undefined) {
        terminal = extractLastTerminalResultFromNdjsonStdout(rawStdout, false);
    }
    if (outputFormat === 'stream-json' && terminal !== undefined) {
        return parseCursorAgentResultPayload(terminal);
    }
    if (outputFormat === 'stream-json') {
        return { assistantTranscript: '', usage: undefined };
    }
    return parseCursorAgentJsonOutput(rawStdout);
}

function finishSpawnResult(input: {
    exitCode: number;
    durationMs: number;
    rawStdout: string;
    rawStderr: string;
    outputFormat: CursorAgentStdoutFormat;
    lastTerminalResult: Record<string, unknown> | undefined;
}): CursorAgentSpawnResult {
    const parsed = parseCursorAgentStdoutSnapshot(input.rawStdout, input.outputFormat, input.lastTerminalResult);
    return {
        exitCode: input.exitCode,
        durationMs: input.durationMs,
        rawStdout: input.rawStdout,
        rawStderr: input.rawStderr,
        usage: parsed.usage,
        assistantTranscript: parsed.assistantTranscript,
        outputFormat: input.outputFormat,
    };
}

/**
 * Run Cursor `agent` CLI asynchronously (JSON or stream-json stdout depending on plan debug).
 */
export async function spawnCursorAgent(options: SpawnCursorAgentOptions): Promise<CursorAgentSpawnResult> {
    const cwd = options.processCwd ?? options.workspaceRoot;
    const outputFormat = cursorAgentStdoutFormatFromPlanDebug();
    const args = buildAgentArgv(options, outputFormat);
    const start = performance.now();
    const timeoutMs = cursorAgentTimeoutMsFromEnv();

    return await new Promise<CursorAgentSpawnResult>((resolve, reject) => {
        const child = spawn('agent', args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: agentSubprocessEnv(),
        });

        let rawStdout = '';
        let rawStderr = '';
        let lastIoAt = Date.now();
        const ndjsonState = createNdjsonBufferState();
        let lastTerminalResult: Record<string, unknown> | undefined;
        let settled = false;

        const killTimer = timeoutMs
            ? setTimeout(() => {
                  if (settled) {
                      return;
                  }
                  settled = true;
                  child.kill('SIGTERM');
                  setTimeout(() => {
                      try {
                          child.kill('SIGKILL');
                      } catch {
                          /* process may already be gone */
                      }
                  }, 10_000);
                  reject(
                      new Error(`agent "${options.name}" exceeded JARVIS_AGENT_TIMEOUT_MS (${String(timeoutMs)} ms)`),
                  );
              }, timeoutMs)
            : undefined;

        const clearKillTimer = (): void => {
            if (killTimer !== undefined) {
                clearTimeout(killTimer);
            }
        };
        const heartbeatTimer =
            outputFormat === 'stream-json' && isPlanCliDebugEnabled()
                ? setInterval(() => {
                      if (settled) {
                          return;
                      }
                      const idleMs = Date.now() - lastIoAt;
                      if (idleMs < AGENT_STREAM_IDLE_HEARTBEAT_MS) {
                          return;
                      }
                      console.error(
                          `[github-plan:agent] waiting | name=${options.name} idle_ms=${String(idleMs)} stdout_chars=${String(rawStdout.length)} stderr_chars=${String(rawStderr.length)}`,
                      );
                  }, AGENT_STREAM_IDLE_HEARTBEAT_MS)
                : undefined;

        const clearHeartbeatTimer = (): void => {
            if (heartbeatTimer !== undefined) {
                clearInterval(heartbeatTimer);
            }
        };

        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            lastIoAt = Date.now();
            rawStdout = appendWithByteCap(rawStdout, chunk, MAX_AGENT_IO_CAPTURE_BYTES);
            if (outputFormat !== 'stream-json') {
                return;
            }
            const lines = appendNdjsonChunks(ndjsonState, chunk);
            for (const line of lines) {
                const { terminalResult } = handleNdjsonLine(line, true);
                if (terminalResult !== undefined) {
                    lastTerminalResult = terminalResult;
                }
            }
        });
        child.stderr?.on('data', (chunk: string) => {
            lastIoAt = Date.now();
            rawStderr = appendWithByteCap(rawStderr, chunk, MAX_AGENT_IO_CAPTURE_BYTES);
        });

        child.on('error', (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearKillTimer();
            clearHeartbeatTimer();
            reject(new Error(`Failed to spawn agent for "${options.name}": ${error.message}`));
        });

        child.on('close', (code) => {
            if (settled) {
                return;
            }
            settled = true;
            clearKillTimer();
            clearHeartbeatTimer();
            const durationMs = Math.round(performance.now() - start);
            if (outputFormat === 'stream-json') {
                const flushed = flushNdjsonRemainder(ndjsonState.remainder, true);
                if (flushed.terminalResult !== undefined) {
                    lastTerminalResult = flushed.terminalResult;
                }
            }
            resolve(
                finishSpawnResult({
                    exitCode: code ?? -1,
                    durationMs,
                    rawStdout,
                    rawStderr,
                    outputFormat,
                    lastTerminalResult,
                }),
            );
        });
    });
}

/**
 * Synchronous `agent` invocation (same argv as {@link spawnCursorAgent}).
 * `spawnSync` uses `maxBuffer` 64 MiB; async {@link spawnCursorAgent} retains at most the same per stream.
 */
export function spawnCursorAgentSync(options: SpawnCursorAgentOptions): CursorAgentSpawnResult {
    const cwd = options.processCwd ?? options.workspaceRoot;
    const outputFormat = cursorAgentStdoutFormatFromPlanDebug();
    const args = buildAgentArgv(options, outputFormat);
    const start = performance.now();
    const proc = spawnSync('agent', args, {
        encoding: 'utf8',
        cwd,
        env: agentSubprocessEnv(),
        maxBuffer: MAX_AGENT_IO_CAPTURE_BYTES,
    });
    if (proc.error) {
        throw new Error(`Cursor agent (sync) failed: ${proc.error.message}`);
    }
    const durationMs = Math.round(performance.now() - start);
    const rawStdout = proc.stdout ?? '';
    const rawStderr = proc.stderr ?? '';
    let lastTerminalResult: Record<string, unknown> | undefined;
    if (outputFormat === 'stream-json') {
        lastTerminalResult = extractLastTerminalResultFromNdjsonStdout(rawStdout, true);
    }
    return finishSpawnResult({
        exitCode: proc.status ?? -1,
        durationMs,
        rawStdout,
        rawStderr,
        outputFormat,
        lastTerminalResult,
    });
}

/** Run several agent invocations in parallel. */
export async function spawnCursorAgentsParallel(runs: SpawnCursorAgentOptions[]): Promise<CursorAgentSpawnResult[]> {
    return await Promise.all(runs.map((run) => spawnCursorAgent(run)));
}

/**
 * Throws if `result.exitCode !== 0`.
 * On failure, prints a diagnostic block to stderr (full-ish streams, argv summary, `agent --version`) then throws with a bounded message.
 */
export function assertCursorAgentSucceeded(
    label: string,
    result: CursorAgentSpawnResult,
    options?: SpawnCursorAgentOptions,
): void {
    if (result.exitCode !== 0) {
        emitCursorAgentFailureDiagnostics(label, result, options);
        throw new Error(formatAgentFailureMessage(label, result.exitCode, result.rawStderr, result.rawStdout));
    }
}
