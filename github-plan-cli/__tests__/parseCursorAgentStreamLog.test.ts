import { describe, expect, it } from "vitest";
import {
    assembleThinkingFromStreamLog,
    parseCursorAgentStreamLog,
} from "../src/agent/parseCursorAgentStreamLog.js";

describe("parseCursorAgentStreamLog", () => {
    it("counts types, detects shell rejected, and records result summaries", () => {
        const sample = [
            '{"type":"system","subtype":"init","session_id":"s1"}',
            '{"type":"thinking","subtype":"delta","text":"a","session_id":"s1"}',
            '{"type":"thinking","subtype":"delta","text":"b","session_id":"s1"}',
            '{"type":"thinking","subtype":"completed","session_id":"s1"}',
            '{"type":"tool_call","subtype":"started","call_id":"c1","tool_call":{"shellToolCall":{"args":{"command":"pnpm build"}}},"session_id":"s1"}',
            '{"type":"tool_call","subtype":"completed","call_id":"c1","tool_call":{"shellToolCall":{"args":{"command":"pnpm build"},"result":{"rejected":{"command":"pnpm build","reason":"","workingDirectory":"/tmp"}}}},"session_id":"s1"}',
            '{"type":"result","subtype":"success","is_error":false,"duration_ms":100,"result":"done"}',
            "not json",
        ].join("\n");

        const report = parseCursorAgentStreamLog(sample);
        expect(report.parseFailures).toHaveLength(1);
        expect(report.countsByType.system).toBe(1);
        expect(report.countsByType.thinking).toBe(3);
        expect(report.countsByThinkingSubtype.delta).toBe(2);
        expect(report.countsByThinkingSubtype.completed).toBe(1);
        expect(report.toolCalls.byKind.shell).toEqual({ started: 1, completed: 1 });
        expect(report.shellRejected).toHaveLength(1);
        expect(report.shellRejected[0]?.command).toBe("pnpm build");
        expect(report.shellRejected[0]?.callId).toBe("c1");
        expect(report.results).toHaveLength(1);
        expect(report.results[0]?.isError).toBe(false);
        expect(report.streamSemanticsNote).toContain("delta");
    });

    it("assembleThinkingFromStreamLog summarizes blocks at completed boundaries", () => {
        const sample = [
            '{"type":"thinking","subtype":"delta","text":"x","session_id":"s1"}',
            '{"type":"thinking","subtype":"delta","text":"y","session_id":"s1"}',
            '{"type":"thinking","subtype":"completed","session_id":"s1"}',
            '{"type":"thinking","subtype":"delta","text":"z","session_id":"s1"}',
            '{"type":"thinking","subtype":"completed","session_id":"s1"}',
        ].join("\n");
        const blocks = assembleThinkingFromStreamLog(sample);
        expect(blocks).toHaveLength(2);
        expect(blocks[0]?.deltaCount).toBe(2);
        expect(blocks[0]?.assembledChars).toBe(2);
        expect(blocks[1]?.deltaCount).toBe(1);
        expect(blocks[1]?.assembledChars).toBe(1);
    });
});
