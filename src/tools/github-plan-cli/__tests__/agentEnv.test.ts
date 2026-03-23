import { afterEach, describe, expect, it, vi } from "vitest";
import { agentSubprocessEnv, cursorApiKeyFromEnv } from "../agentEnv.js";

describe("cursorApiKeyFromEnv", () => {
    it("prefers CURSOR_API_KEY when both are set", () => {
        expect(
            cursorApiKeyFromEnv({
                CURSOR_API_KEY: "cursor-key",
                JARVIS_API_KEY: "jarvis-key",
            }),
        ).toBe("cursor-key");
    });

    it("falls back to JARVIS_API_KEY when CURSOR is missing", () => {
        expect(cursorApiKeyFromEnv({ JARVIS_API_KEY: "jarvis-only" })).toBe("jarvis-only");
    });

    it("ignores blank CURSOR_API_KEY and uses JARVIS_API_KEY", () => {
        expect(
            cursorApiKeyFromEnv({
                CURSOR_API_KEY: "   ",
                JARVIS_API_KEY: "from-jarvis",
            }),
        ).toBe("from-jarvis");
    });

    it("returns undefined when neither key is set", () => {
        expect(cursorApiKeyFromEnv({})).toBeUndefined();
    });
});

describe("agentSubprocessEnv", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("sets CURSOR_API_KEY from JARVIS_API_KEY when Cursor key is unset", () => {
        vi.stubEnv("CURSOR_API_KEY", "");
        vi.stubEnv("JARVIS_API_KEY", "from-jarvis");
        const env = agentSubprocessEnv();
        expect(env.CURSOR_API_KEY).toBe("from-jarvis");
    });

    it("keeps CURSOR_API_KEY when already set", () => {
        vi.stubEnv("CURSOR_API_KEY", "direct");
        vi.stubEnv("JARVIS_API_KEY", "jarvis");
        const env = agentSubprocessEnv();
        expect(env.CURSOR_API_KEY).toBe("direct");
    });
});
