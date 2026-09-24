// fork: provider accounts — one headless Claude request that starts an account's 5-hour window.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { expandHomePath } from "../../pathExpansion.ts";
import { inactiveClaudeProbeEnvironment } from "./ClaudeAccountHome.ts";

/**
 * Claude's 5-hour session window starts with the first request an account sends, whatever the
 * model, so a minimal Haiku request is enough. Always an explicit Anthropic model id: this fork
 * can remap the `haiku` alias to Codex through the Claude → Codex bridge, which would never
 * start a Claude window.
 */
export const CLAUDE_WINDOW_PRIME_MODEL = "claude-haiku-4-5-20251001";
export const CLAUDE_WINDOW_PRIME_PROMPT = "hi";
export const CLAUDE_WINDOW_PRIME_TIMEOUT_MS = 60_000;

/**
 * `-p` runs headless. No tools, no MCP servers, no user/project/local settings (their hooks,
 * env overrides and model settings stay out), one turn, and no saved transcript. The prompt
 * goes last: `--tools` is variadic and would swallow a following positional argument.
 */
export const claudeWindowPrimeArgs = () => [
  "-p",
  "--model",
  CLAUDE_WINDOW_PRIME_MODEL,
  "--max-turns",
  "1",
  "--no-session-persistence",
  "--tools",
  "",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--output-format",
  "json",
  CLAUDE_WINDOW_PRIME_PROMPT,
];

/** A dedicated empty directory, so no project files or instructions load for the request. */
export const claudeWindowPrimeCwd = (stateDir: string) =>
  NodePath.join(stateDir, "fork", "provider-accounts", "window-primer");

export interface ClaudeWindowPrimeLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

/**
 * The active account runs in the active home with the instance's normal environment, like its
 * sessions. An inactive account runs in its own store with the same sanitized environment as
 * inactive usage probes, so it can only authenticate from that store.
 */
export function claudeWindowPrimeLaunch(input: {
  readonly active: boolean;
  /** Active: the resolved active home. Inactive: the account's own store. */
  readonly homePath: string;
  /** Claude's `homePath` setting; only an explicit one is exported for the active home. */
  readonly configuredHomePath: string;
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly stateDir: string;
}): ClaudeWindowPrimeLaunch {
  const env = input.active
    ? input.configuredHomePath.trim()
      ? { ...input.environment, CLAUDE_CONFIG_DIR: input.homePath }
      : { ...input.environment }
    : { ...inactiveClaudeProbeEnvironment(input.environment), CLAUDE_CONFIG_DIR: input.homePath };
  return {
    command: expandHomePath(input.binaryPath.trim() || "claude"),
    args: claudeWindowPrimeArgs(),
    env,
    cwd: claudeWindowPrimeCwd(input.stateDir),
  };
}

export type ClaudeWindowPrimeFailure = "signedOut" | "rateLimited" | "timeout" | "failed";
export type ClaudeWindowPrimeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ClaudeWindowPrimeFailure };

type Spawn = (
  command: string,
  args: string[],
  options: NodeChildProcess.SpawnOptions,
) => NodeChildProcess.ChildProcess;

/** Classify only; the CLI's output is never logged or forwarded. */
function classify(code: number | null, stdout: string): ClaudeWindowPrimeResult {
  let parsed: { is_error?: unknown; api_error_status?: unknown; result?: unknown } | undefined;
  try {
    const value: unknown = JSON.parse(stdout);
    if (typeof value === "object" && value !== null) parsed = value;
  } catch {
    parsed = undefined;
  }
  if (code === 0 && parsed?.is_error !== true) return { ok: true };
  const result = typeof parsed?.result === "string" ? parsed.result : "";
  if (parsed?.api_error_status === 429 || /rate.?limit|usage limit/iu.test(result))
    return { ok: false, reason: "rateLimited" };
  if (parsed?.api_error_status === 401 || /not logged in|\/login|log ?in again/iu.test(result))
    return { ok: false, reason: "signedOut" };
  return { ok: false, reason: "failed" };
}

/** Runs the launch, kills only its own child on timeout or abort, never rejects. */
export function runClaudeWindowPrime(
  launch: ClaudeWindowPrimeLaunch,
  options?: { readonly spawn?: Spawn; readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<ClaudeWindowPrimeResult> {
  return new Promise((resolve) => {
    let child: NodeChildProcess.ChildProcess;
    try {
      child = (options?.spawn ?? NodeChildProcess.spawn)(launch.command, [...launch.args], {
        env: launch.env,
        cwd: launch.cwd,
        // `-p` appends piped stdin to the prompt; nothing may be read from it.
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ ok: false, reason: "failed" });
      return;
    }
    let stdout = "";
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
      killTimer.unref?.();
    };
    const onAbort = () => {
      timedOut = true;
      kill();
    };
    const timer = setTimeout(onAbort, options?.timeoutMs ?? CLAUDE_WINDOW_PRIME_TIMEOUT_MS);
    timer.unref?.();
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (result: ClaudeWindowPrimeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options?.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-65_536);
    });
    // Drain stderr so a chatty CLI can't block on a full pipe; its content is discarded.
    child.stderr?.resume();
    child.once("error", () => finish({ ok: false, reason: "failed" }));
    child.once("close", (code) =>
      finish(timedOut ? { ok: false, reason: "timeout" } : classify(code, stdout)),
    );
    if (options?.signal?.aborted) onAbort();
  });
}
