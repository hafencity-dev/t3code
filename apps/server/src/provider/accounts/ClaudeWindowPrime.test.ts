import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import type * as NodeChildProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CLAUDE_WINDOW_PRIME_MODEL,
  claudeWindowPrimeArgs,
  claudeWindowPrimeLaunch,
  runClaudeWindowPrime,
} from "./ClaudeWindowPrime.ts";

const baseEnvironment = {
  PATH: "/bin",
  CLAUDE_CONFIG_DIR: "/configured",
  CLAUDE_SECURESTORAGE_CONFIG_DIR: "/secure",
  CLAUDE_CODE_OAUTH_TOKEN: "token",
};

const launch = (active: boolean, configuredHomePath = "") =>
  claudeWindowPrimeLaunch({
    active,
    homePath: active ? "/active-home" : "/state/fork/provider-accounts/claude/work",
    configuredHomePath,
    binaryPath: "",
    environment: baseEnvironment,
    stateDir: "/state",
  });

function fakeChild() {
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    stdout: new NodeStream.PassThrough(),
    stderr: new NodeStream.PassThrough(),
    kills: [] as string[],
    kill(signal: string) {
      child.kills.push(signal);
      child.emit("close", null);
      return true;
    },
  });
  return child;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("claudeWindowPrimeArgs", () => {
  it("uses an explicit Anthropic Haiku id, never the remappable alias", () => {
    const args = claudeWindowPrimeArgs();
    expect(args[args.indexOf("--model") + 1]).toBe(CLAUDE_WINDOW_PRIME_MODEL);
    expect(CLAUDE_WINDOW_PRIME_MODEL).toMatch(/^claude-haiku-\d/u);
    expect(args).not.toContain("haiku");
    expect(args).toEqual(
      expect.arrayContaining(["-p", "--no-session-persistence", "--strict-mcp-config"]),
    );
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "",
    ]);
    // The prompt follows a non-variadic option so `--tools` can't swallow it.
    expect(args.at(-1)).toBe("hi");
    expect(args.at(-3)).toBe("--output-format");
  });
});

describe("claudeWindowPrimeLaunch", () => {
  it("runs an inactive account in its own store with the probe's sanitized environment", () => {
    const inactive = launch(false);
    expect(inactive.env.CLAUDE_CONFIG_DIR).toBe("/state/fork/provider-accounts/claude/work");
    expect(inactive.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    expect(inactive.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(inactive.env.PATH).toBe("/bin");
    expect(inactive.command).toBe("claude");
    expect(inactive.cwd).toBe("/state/fork/provider-accounts/window-primer");
  });

  it("runs the active account with the instance's normal environment", () => {
    const active = launch(true);
    expect(active.env).toEqual(baseEnvironment);
    expect(launch(true, "~/.claude-work").env.CLAUDE_CONFIG_DIR).toBe("/active-home");
  });
});

describe("runClaudeWindowPrime", () => {
  const run = (child: ReturnType<typeof fakeChild>, timeoutMs?: number) => {
    const spawn = vi.fn(() => child as unknown as NodeChildProcess.ChildProcess);
    const result = runClaudeWindowPrime(launch(false), {
      spawn,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return { spawn, result };
  };

  it("spawns with no stdin and succeeds on a clean result", async () => {
    const child = fakeChild();
    const { spawn, result } = run(child);
    child.stdout.write(JSON.stringify({ type: "result", is_error: false }));
    child.emit("close", 0);
    await expect(result).resolves.toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith(
      "claude",
      claudeWindowPrimeArgs(),
      expect.objectContaining({
        cwd: "/state/fork/provider-accounts/window-primer",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  it("classifies failures without surfacing CLI output", async () => {
    const signedOut = fakeChild();
    const first = run(signedOut);
    signedOut.stdout.write(
      JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" }),
    );
    signedOut.emit("close", 1);
    await expect(first.result).resolves.toEqual({ ok: false, reason: "signedOut" });

    const limited = fakeChild();
    const second = run(limited);
    limited.stdout.write(JSON.stringify({ is_error: true, api_error_status: 429, result: "x" }));
    limited.emit("close", 1);
    await expect(second.result).resolves.toEqual({ ok: false, reason: "rateLimited" });
  });

  it("kills only its own child after the timeout", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const { result } = run(child, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(child.kills).toEqual(["SIGTERM"]);
  });
});
