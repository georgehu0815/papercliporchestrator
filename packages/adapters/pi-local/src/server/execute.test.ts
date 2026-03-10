import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

// Mocks are hoisted by vitest — must come before dynamic imports

vi.mock("node:fs/promises", async () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    stat: vi.fn().mockResolvedValue({ isDirectory: () => false }),
    lstat: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    readdir: vi.fn().mockResolvedValue([]),
    symlink: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...original,
    ensureAbsoluteDirectory: vi.fn().mockResolvedValue(undefined),
    ensureCommandResolvable: vi.fn().mockResolvedValue(undefined),
    ensurePathInEnv: vi.fn((env: Record<string, string | undefined>) => ({
      PATH: "/usr/bin:/bin",
      ...env,
    })),
    buildPaperclipEnv: vi.fn((agent: { id: string }) => ({
      PAPERCLIP_AGENT_ID: agent.id,
    })),
    redactEnvForLogs: vi.fn((env: unknown) => env),
    runChildProcess: vi.fn(),
  };
});

vi.mock("../model/token-manager.js", () => ({
  getApiKeyFromKeychain: vi.fn().mockReturnValue(undefined),
}));

vi.mock("./models.js", () => ({
  ensurePiModelConfiguredAndAvailable: vi.fn().mockResolvedValue([]),
}));

import { execute } from "./execute.js";
import {
  runChildProcess,
  ensureCommandResolvable,
} from "@paperclipai/adapter-utils/server-utils";
import { getApiKeyFromKeychain } from "../model/token-manager.js";

// ---- helpers ----------------------------------------------------------------

function makePiJsonl(message: string, usage?: { input: number; output: number; cost: number }) {
  const events = [
    JSON.stringify({ type: "agent_start" }),
    JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        content: message,
        ...(usage
          ? {
              usage: {
                input: usage.input,
                output: usage.output,
                cacheRead: 0,
                cost: { total: usage.cost },
              },
            }
          : {}),
      },
      toolResults: [],
    }),
    JSON.stringify({ type: "agent_end", messages: [] }),
  ];
  return events.join("\n");
}

function makeRunResult(overrides?: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
}) {
  return {
    exitCode: overrides?.exitCode ?? 0,
    signal: null,
    timedOut: overrides?.timedOut ?? false,
    stdout: overrides?.stdout ?? makePiJsonl("Done."),
    stderr: overrides?.stderr ?? "",
  };
}

function makeCtx(overrides?: {
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
  runtime?: Partial<AdapterExecutionContext["runtime"]>;
  authToken?: string;
}): AdapterExecutionContext {
  return {
    runId: "run-test-123",
    agent: {
      id: "agent-test",
      companyId: "company-test",
      name: "Test Agent",
      adapterType: "pi_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
      ...overrides?.runtime,
    },
    config: overrides?.config ?? {},
    context: overrides?.context ?? {},
    onLog: vi.fn().mockResolvedValue(undefined),
    onMeta: vi.fn().mockResolvedValue(undefined),
    authToken: overrides?.authToken ?? "test-auth-token",
  };
}

// ---- tests ------------------------------------------------------------------

describe("execute (pi_local)", () => {
  const runProcessMock = vi.mocked(runChildProcess);
  const keychainMock = vi.mocked(getApiKeyFromKeychain);

  beforeEach(() => {
    runProcessMock.mockResolvedValue(makeRunResult());
    keychainMock.mockReturnValue(undefined);
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  // ---- default model ----------------------------------------------------------

  it("passes --provider anthropic --model <default> when no model configured", async () => {
    await execute(makeCtx());

    const [, , args] = runProcessMock.mock.calls[0];
    expect(args).toContain("--provider");
    expect(args[args.indexOf("--provider") + 1]).toBe("anthropic");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-5-20250929");
  });

  it("passes --provider and --model from explicit model config", async () => {
    const ctx = makeCtx({ config: { model: "xai/grok-4" } });
    await execute(ctx);

    const [, , args] = runProcessMock.mock.calls[0];
    expect(args[args.indexOf("--provider") + 1]).toBe("xai");
    expect(args[args.indexOf("--model") + 1]).toBe("grok-4");
  });

  it("always uses --mode rpc", async () => {
    await execute(makeCtx());

    const [, , args] = runProcessMock.mock.calls[0];
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("rpc");
  });

  it("includes default tools flag", async () => {
    await execute(makeCtx());

    const [, , args] = runProcessMock.mock.calls[0];
    expect(args).toContain("--tools");
    const toolsValue = args[args.indexOf("--tools") + 1];
    expect(toolsValue).toContain("read");
    expect(toolsValue).toContain("bash");
    expect(toolsValue).toContain("edit");
  });

  it("includes --session arg", async () => {
    await execute(makeCtx());

    const [, , args] = runProcessMock.mock.calls[0];
    expect(args).toContain("--session");
    const sessionArg = args[args.indexOf("--session") + 1];
    expect(sessionArg).toMatch(/\.pi\/paperclips\//);
  });

  it("passes --append-system-prompt with agent info", async () => {
    await execute(makeCtx());

    const [, , args] = runProcessMock.mock.calls[0];
    expect(args).toContain("--append-system-prompt");
    const prompt = args[args.indexOf("--append-system-prompt") + 1];
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  // ---- stdin RPC --------------------------------------------------------------

  it("sends a JSON prompt command via stdin", async () => {
    await execute(makeCtx());

    const [, , , opts] = runProcessMock.mock.calls[0];
    expect(opts.stdin).toBeDefined();
    const parsed = JSON.parse((opts.stdin as string).trim());
    expect(parsed.type).toBe("prompt");
    expect(typeof parsed.message).toBe("string");
  });

  // ---- keychain API key injection ---------------------------------------------

  it("injects ANTHROPIC_API_KEY from keychain when provider is anthropic and no key present", async () => {
    keychainMock.mockReturnValue("sk-ant-from-keychain");

    await execute(makeCtx({ config: { model: "anthropic/claude-opus-4-5" } }));

    const [, , , opts] = runProcessMock.mock.calls[0];
    const env = opts.env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-from-keychain");
  });

  it("injects keychain key for default anthropic model", async () => {
    keychainMock.mockReturnValue("sk-ant-default-key");

    await execute(makeCtx());

    const [, , , opts] = runProcessMock.mock.calls[0];
    const env = opts.env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-default-key");
  });

  it("does NOT inject keychain key when ANTHROPIC_API_KEY already in process.env", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-process-env";
    keychainMock.mockReturnValue("sk-ant-from-keychain");

    await execute(makeCtx());

    // getApiKeyFromKeychain should not be called since process.env key is present
    expect(keychainMock).not.toHaveBeenCalled();
  });

  it("does NOT inject keychain key when ANTHROPIC_API_KEY set in config env", async () => {
    keychainMock.mockReturnValue("sk-ant-from-keychain");

    await execute(
      makeCtx({ config: { env: { ANTHROPIC_API_KEY: "sk-ant-config-env" } } }),
    );

    const [, , , opts] = runProcessMock.mock.calls[0];
    const env = opts.env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-config-env");
  });

  it("does NOT inject keychain key when provider is not anthropic", async () => {
    keychainMock.mockReturnValue("sk-ant-from-keychain");

    await execute(makeCtx({ config: { model: "xai/grok-4" } }));

    const [, , , opts] = runProcessMock.mock.calls[0];
    const env = opts.env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(keychainMock).not.toHaveBeenCalled();
  });

  // ---- session handling -------------------------------------------------------

  it("uses a new session path on first run (no sessionParams)", async () => {
    await execute(makeCtx());

    const [, , args] = runProcessMock.mock.calls[0];
    const sessionPath = args[args.indexOf("--session") + 1];
    expect(sessionPath).toMatch(/paperclips\//);
    expect(sessionPath).toMatch(/agent-test/);
  });

  it("resumes session when sessionId is provided and cwd matches", async () => {
    const sessionPath = `/home/user/.pi/paperclips/2025-01-01T00-00-00-000Z-agent-test.jsonl`;
    const ctx = makeCtx({
      runtime: {
        sessionId: null,
        sessionParams: { sessionId: sessionPath, cwd: process.cwd() },
        sessionDisplayId: null,
        taskKey: null,
      },
    });

    await execute(ctx);

    const [, , args] = runProcessMock.mock.calls[0];
    const usedSession = args[args.indexOf("--session") + 1];
    expect(usedSession).toBe(sessionPath);
  });

  it("starts fresh session when session cwd differs from run cwd", async () => {
    const sessionPath = `/home/user/.pi/paperclips/old-session.jsonl`;
    const ctx = makeCtx({
      runtime: {
        sessionId: null,
        sessionParams: { sessionId: sessionPath, cwd: "/some/other/directory" },
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { cwd: process.cwd() },
    });

    await execute(ctx);

    const [, , args] = runProcessMock.mock.calls[0];
    const usedSession = args[args.indexOf("--session") + 1];
    expect(usedSession).not.toBe(sessionPath);
  });

  // ---- session retry on stale session ----------------------------------------

  it("retries with a fresh session on unknown session error", async () => {
    const staleSession = `/home/user/.pi/paperclips/stale.jsonl`;
    const ctx = makeCtx({
      runtime: {
        sessionId: null,
        sessionParams: { sessionId: staleSession, cwd: process.cwd() },
        sessionDisplayId: null,
        taskKey: null,
      },
    });

    runProcessMock
      .mockResolvedValueOnce(
        makeRunResult({
          exitCode: 1,
          stderr: "unknown session id: " + staleSession,
          stdout: "",
        }),
      )
      .mockResolvedValueOnce(makeRunResult({ stdout: makePiJsonl("Retried OK.") }));

    const result = await execute(ctx);

    expect(runProcessMock).toHaveBeenCalledTimes(2);
    expect(result.clearSession).toBe(true);
    expect(result.summary).toContain("Retried OK");
  });

  it("does NOT retry on a non-session error", async () => {
    const ctx = makeCtx({
      runtime: {
        sessionId: null,
        sessionParams: { sessionId: "/some/session.jsonl", cwd: process.cwd() },
        sessionDisplayId: null,
        taskKey: null,
      },
    });

    runProcessMock.mockResolvedValueOnce(
      makeRunResult({ exitCode: 1, stderr: "out of memory" }),
    );

    await execute(ctx);

    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  // ---- result mapping ---------------------------------------------------------

  it("returns exit code, usage, and summary from pi output", async () => {
    runProcessMock.mockResolvedValue(
      makeRunResult({
        stdout: makePiJsonl("Task complete.", { input: 200, output: 80, cost: 0.0025 }),
      }),
    );

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toContain("Task complete");
    expect(result.usage?.inputTokens).toBe(200);
    expect(result.usage?.outputTokens).toBe(80);
    expect(result.costUsd).toBeCloseTo(0.0025, 4);
  });

  it("returns errorMessage from stderr on non-zero exit", async () => {
    runProcessMock.mockResolvedValue(
      makeRunResult({ exitCode: 1, stderr: "fatal: something went wrong", stdout: "" }),
    );

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("fatal: something went wrong");
  });

  it("returns provider and model in result", async () => {
    const result = await execute(makeCtx({ config: { model: "anthropic/claude-opus-4-5" } }));

    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("anthropic/claude-opus-4-5");
  });

  it("returns sessionParams with session path and cwd", async () => {
    const result = await execute(makeCtx());

    expect(result.sessionParams).toBeDefined();
    expect(result.sessionParams?.sessionId).toBeDefined();
    expect(result.sessionParams?.cwd).toBeDefined();
  });

  // ---- thinking flag ----------------------------------------------------------

  it("passes --thinking flag when configured", async () => {
    await execute(makeCtx({ config: { thinking: "high" } }));

    const [, , args] = runProcessMock.mock.calls[0];
    expect(args).toContain("--thinking");
    expect(args[args.indexOf("--thinking") + 1]).toBe("high");
  });

  it("does not pass --thinking flag when not configured", async () => {
    await execute(makeCtx());

    const [, , args] = runProcessMock.mock.calls[0];
    expect(args).not.toContain("--thinking");
  });

  // ---- extra args -------------------------------------------------------------

  it("appends extraArgs to the command", async () => {
    await execute(makeCtx({ config: { extraArgs: ["--debug", "--verbose"] } }));

    const [, , args] = runProcessMock.mock.calls[0];
    expect(args).toContain("--debug");
    expect(args).toContain("--verbose");
  });

  // ---- command override -------------------------------------------------------

  it("uses the configured command instead of default pi", async () => {
    await execute(makeCtx({ config: { command: "/usr/local/bin/picoclaw" } }));

    const [, command] = runProcessMock.mock.calls[0];
    expect(command).toBe("/usr/local/bin/picoclaw");
    expect(vi.mocked(ensureCommandResolvable).mock.calls[0][0]).toBe("/usr/local/bin/picoclaw");
  });

  // ---- timed out --------------------------------------------------------------

  it("returns timedOut:true when process times out", async () => {
    runProcessMock.mockResolvedValue(makeRunResult({ timedOut: true, exitCode: null }));

    const result = await execute(makeCtx({ config: { timeoutSec: 30 } }));

    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toMatch(/timed out/i);
  });
});
