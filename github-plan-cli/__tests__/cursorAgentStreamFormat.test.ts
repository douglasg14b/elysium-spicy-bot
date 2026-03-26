import { afterEach, describe, expect, it, vi } from "vitest";
import {
    appendNdjsonChunks,
    createNdjsonBufferState,
    extractLastTerminalResultFromNdjsonStdout,
    flushNdjsonRemainder,
    formatCursorAgentStreamEventForLog,
    handleNdjsonLine,
    logCursorAgentStreamEvent,
    redactCursorAgentStreamEventForVerboseLog,
} from "../src/agent/cursorAgentStreamFormat.js";
import { parseCursorAgentResultPayload } from "../src/agent/cursorAgentSpawn.js";

describe("appendNdjsonChunks", () => {
    it("returns empty when chunk has no newline", () => {
        const state = createNdjsonBufferState();
        expect(appendNdjsonChunks(state, '{"a":1}')).toEqual([]);
        expect(state.remainder).toBe('{"a":1}');
    });

    it("emits complete lines and keeps remainder across chunks", () => {
        const state = createNdjsonBufferState();
        expect(appendNdjsonChunks(state, '{"line":1}\n{"li')).toEqual(['{"line":1}']);
        expect(state.remainder).toBe('{"li');
        expect(appendNdjsonChunks(state, 'ne":2}\n')).toEqual(['{"line":2}']);
        expect(state.remainder).toBe("");
    });

    it("handles multiple lines in one chunk", () => {
        const state = createNdjsonBufferState();
        const lines = appendNdjsonChunks(state, '{"a":1}\n{"b":2}\n');
        expect(lines).toEqual(['{"a":1}', '{"b":2}']);
        expect(state.remainder).toBe("");
    });

    it("handles CRLF line endings", () => {
        const state = createNdjsonBufferState();
        const lines = appendNdjsonChunks(state, '{"x":1}\r\n{"y":2}\r\n');
        expect(lines).toEqual(['{"x":1}', '{"y":2}']);
        const parsed = handleNdjsonLine(lines[0]!, false);
        expect(parsed.terminalResult).toBeUndefined();
    });
});

describe("formatCursorAgentStreamEventForLog", () => {
    it("formats system init", () => {
        const line = formatCursorAgentStreamEventForLog({
            type: "system",
            subtype: "init",
            model: "Claude",
            cwd: "/very/long/path/to/project",
            session_id: "c6b62c6f-7ead-4fd6-9922-e952131177ff",
        });
        expect(line).toContain("system init");
        expect(line).toContain("model=Claude");
        expect(line).toContain("session=c6b62c6f");
    });

    it("formats tool read started and completed without file body", () => {
        const started = formatCursorAgentStreamEventForLog({
            type: "tool_call",
            subtype: "started",
            call_id: "x",
            tool_call: {
                readToolCall: {
                    args: { path: "README.md" },
                },
            },
            session_id: "s",
        });
        expect(started).toBe("tool read started | README.md");

        const completed = formatCursorAgentStreamEventForLog({
            type: "tool_call",
            subtype: "completed",
            call_id: "x",
            tool_call: {
                readToolCall: {
                    args: { path: "README.md" },
                    result: {
                        success: {
                            content: "# SECRET HUGE CONTENT",
                            isEmpty: false,
                            exceededLimit: false,
                            totalLines: 54,
                            totalChars: 1254,
                        },
                    },
                },
            },
            session_id: "s",
        });
        expect(completed).toContain("README.md");
        expect(completed).toContain("lines=54");
        expect(completed).toContain("chars=1254");
        expect(completed).not.toContain("SECRET");
    });

    it("formats assistant with truncated text", () => {
        const longText = "x".repeat(500);
        const line = formatCursorAgentStreamEventForLog({
            type: "assistant",
            message: {
                role: "assistant",
                content: [{ type: "text", text: longText }],
            },
            session_id: "s",
        });
        expect(line.startsWith("assistant |")).toBe(true);
        expect(line.length).toBeLessThan(longText.length);
        expect(line).toContain("truncated");
    });

    it("formats terminal result", () => {
        expect(
            formatCursorAgentStreamEventForLog({
                type: "result",
                duration_ms: 1234,
            }),
        ).toBe("result | duration_ms=1234");
    });
});

describe("handleNdjsonLine", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("parses terminal result without logging when emitStreamDebugLog is false", () => {
        const { terminalResult } = handleNdjsonLine(
            JSON.stringify({ type: "result", result: "done", duration_ms: 1 }),
            false,
        );
        expect(terminalResult).toMatchObject({ type: "result", result: "done" });
    });

    it("logs to stderr when emitStreamDebugLog and debug enabled", () => {
        vi.stubEnv("GITHUB_ACTIONS", "");
        vi.stubEnv("GITHUB_PLAN_DEBUG", "1");
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const payload = JSON.stringify({ type: "system", subtype: "init", model: "m" });
        handleNdjsonLine(payload, true);
        expect(spy).toHaveBeenCalled();
        expect(String(spy.mock.calls[0][0])).toContain("[github-plan:agent:raw-json]");
        expect(String(spy.mock.calls[0][0])).toContain(payload);
        spy.mockRestore();
    });
});

describe("NDJSON stream terminal result", () => {
    it("keeps the last type=result event when processing multiple lines", () => {
        const state = createNdjsonBufferState();
        const chunk =
            '{"type":"result","result":"first"}\n' +
            '{"type":"assistant","message":{"role":"a","content":[{"type":"text","text":"hi"}]},"session_id":"s"}\n' +
            '{"type":"result","result":"last","duration_ms":10}\n';
        let lastTerminal: Record<string, unknown> | undefined;
        for (const line of appendNdjsonChunks(state, chunk)) {
            const { terminalResult } = handleNdjsonLine(line, false);
            if (terminalResult !== undefined) {
                lastTerminal = terminalResult;
            }
        }
        const flushed = flushNdjsonRemainder(state.remainder, false);
        if (flushed.terminalResult !== undefined) {
            lastTerminal = flushed.terminalResult;
        }
        expect(lastTerminal).toMatchObject({ type: "result", result: "last" });
        expect(parseCursorAgentResultPayload(lastTerminal!).assistantTranscript).toBe("last");
    });
});

describe("extractLastTerminalResultFromNdjsonStdout", () => {
    it("recovers last result from full stdout when emitStreamDebugLog is false (no duplicate logs)", () => {
        const stdout =
            '{"type":"assistant","message":{"role":"a","content":[{"type":"text","text":"x"}]}}\n' +
            '{"type":"result","result":"recovered","duration_ms":1}\n';
        const last = extractLastTerminalResultFromNdjsonStdout(stdout, false);
        expect(last).toMatchObject({ type: "result", result: "recovered" });
        expect(parseCursorAgentResultPayload(last!).assistantTranscript).toBe("recovered");
    });
});

describe("logCursorAgentStreamEvent verbose mode", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it("redacts tool read content when GITHUB_PLAN_AGENT_STREAM_VERBOSE is set", () => {
        vi.stubEnv("GITHUB_PLAN_DEBUG", "1");
        vi.stubEnv("GITHUB_PLAN_AGENT_STREAM_VERBOSE", "1");
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        logCursorAgentStreamEvent({
            type: "tool_call",
            subtype: "completed",
            tool_call: {
                readToolCall: {
                    args: { path: "p" },
                    result: { success: { content: "ULTRA_SECRET_FILE_BODY" } },
                },
            },
        });
        const msg = String(spy.mock.calls[0]?.[0] ?? "");
        expect(msg).toContain("[github-plan:agent:verbose]");
        expect(msg).not.toContain("ULTRA_SECRET");
        spy.mockRestore();
    });

    it("truncates function-tool arguments in verbose mode", () => {
        vi.stubEnv("GITHUB_PLAN_DEBUG", "1");
        vi.stubEnv("GITHUB_PLAN_AGENT_STREAM_VERBOSE", "1");
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const longArgs = "z".repeat(500);
        logCursorAgentStreamEvent({
            type: "tool_call",
            subtype: "started",
            tool_call: {
                function: { name: "fn", arguments: longArgs },
            },
        });
        const msg = String(spy.mock.calls[0]?.[0] ?? "");
        expect(msg).not.toContain(longArgs);
        expect(msg.length).toBeLessThan(longArgs.length + 200);
        spy.mockRestore();
    });
});

describe("redactCursorAgentStreamEventForVerboseLog", () => {
    it("strips read tool file content and write fileText", () => {
        const redacted = redactCursorAgentStreamEventForVerboseLog({
            type: "tool_call",
            subtype: "completed",
            tool_call: {
                readToolCall: {
                    args: { path: "secret.txt" },
                    result: {
                        success: {
                            content: "TOP_SECRET_BODY",
                            totalLines: 1,
                            totalChars: 15,
                        },
                    },
                },
            },
        });
        const json = JSON.stringify(redacted);
        expect(json).not.toContain("TOP_SECRET");
        expect(json).toContain("redacted");
        expect(json).toContain("secret.txt");

        const writeRedacted = redactCursorAgentStreamEventForVerboseLog({
            type: "tool_call",
            subtype: "started",
            tool_call: {
                writeToolCall: {
                    args: { path: "out.md", fileText: "PRIVATE" },
                },
            },
        });
        expect(JSON.stringify(writeRedacted)).not.toContain("PRIVATE");
    });

    it("drops unknown event shapes to safe scalars", () => {
        const redacted = redactCursorAgentStreamEventForVerboseLog({
            type: "custom",
            secretPayload: "LEAK",
            session_id: "s",
        });
        expect(JSON.stringify(redacted)).not.toContain("LEAK");
        expect(redacted).toEqual({ type: "custom", subtype: undefined, session_id: "s" });
    });
});

describe("flushNdjsonRemainder", () => {
    it("returns empty for whitespace remainder", () => {
        expect(flushNdjsonRemainder("  \n  ", true).terminalResult).toBeUndefined();
    });

    it("parses final JSON line without trailing newline", () => {
        const { terminalResult } = flushNdjsonRemainder(
            JSON.stringify({ type: "result", result: "final", duration_ms: 9 }),
            false,
        );
        expect(terminalResult).toMatchObject({ type: "result", result: "final" });
    });
});
