import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeURL from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ClaudeCredentialLockTimeoutError,
  withClaudeConfigLock,
  withClaudeCredentialLocks,
} from "./ClaudeCredentialLock.ts";

// Exercise the actual version bundled by the workspace, without adding a server dependency.
vi.mock("node:fs", async (original) => ({ ...(await original<typeof NodeFS>()) }));
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof NodeFSP>()) }));

const require = NodeModule.createRequire(import.meta.url);
const properLockfile = require(
  NodeURL.fileURLToPath(
    new URL(
      "../../../../../node_modules/.pnpm/proper-lockfile@4.1.2/node_modules/proper-lockfile/index.js",
      import.meta.url,
    ),
  ),
) as {
  lock: (
    file: string,
    options: { lockfilePath?: string; stale: number; update: number },
  ) => Promise<() => Promise<void>>;
};

const safeMessage = "Could not safely lock Claude credentials. Try again shortly.";
const timeoutMessage = "Claude is refreshing its login, try again in a moment";

function paths(home: string) {
  return [
    NodePath.join(home, ".oauth_refresh.lock"),
    `${home}.lock`,
    NodePath.join(home, ".storage-write.lock"),
  ];
}

function properOptions(home: string, index: number) {
  return {
    ...(index === 1 ? {} : { lockfilePath: paths(home)[index] }),
    stale: index === 2 ? 15_000 : 60_000,
    update: 5_000,
  };
}

describe("withClaudeCredentialLocks", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-credential-lock-"));
    home = NodePath.join(root, "home");
    await NodeFSP.mkdir(home);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("excludes actual proper-lockfile holders on all three paths and releases them", async () => {
    const value = await withClaudeCredentialLocks([home], async (assertHeld) => {
      assertHeld();
      for (const index of [0, 1, 2]) {
        await expect(properLockfile.lock(home, properOptions(home, index))).rejects.toMatchObject({
          code: "ELOCKED",
        });
      }
      return 42;
    });
    expect(value).toBe(42);
    for (const index of [0, 1, 2]) {
      const release = await properLockfile.lock(home, properOptions(home, index));
      await release();
    }
  });

  it.each([0, 1, 2])(
    "waits for proper-lockfile lock %i rather than entering concurrently",
    async (index) => {
      const release = await properLockfile.lock(home, properOptions(home, index));
      const retryScheduled = Promise.withResolvers<void>();
      const setTimeoutOriginal = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
        const timer = setTimeoutOriginal(callback, delay, ...args);
        if (delay === 100) retryScheduled.resolve();
        return timer;
      });
      let entered = false;
      const job = withClaudeCredentialLocks([home], async () => {
        entered = true;
      });
      await retryScheduled.promise;
      expect(entered).toBe(false);
      await release();
      await job;
      expect(entered).toBe(true);
    },
  );

  it("deduplicates aliases, sorts homes, and releases in reverse order", async () => {
    const second = NodePath.join(root, "aaa");
    const alias = NodePath.join(root, "alias");
    await NodeFSP.mkdir(second);
    await NodeFSP.symlink(home, alias, "dir");
    const mkdir = vi.spyOn(NodeFSP, "mkdir");
    const rmdir = vi.spyOn(NodeFS, "rmdirSync");
    await withClaudeCredentialLocks([home, second, alias, home], async () => undefined);
    const expected = [...paths(second), ...paths(home)];
    expect(mkdir.mock.calls.map(([target]) => target)).toEqual(expected);
    expect(rmdir.mock.calls.map(([target]) => target)).toEqual(expected.toReversed());
  });

  it("reclaims stale refresh and storage directories using their distinct thresholds", async () => {
    const old = new Date(Date.now() - 61_000);
    for (const [index, lockPath] of paths(home).entries()) {
      await NodeFSP.mkdir(lockPath);
      const age = index === 2 ? new Date(Date.now() - 16_000) : old;
      await NodeFSP.utimes(lockPath, age, age);
    }
    await withClaudeCredentialLocks([home], async (assertHeld) => assertHeld());
    expect(paths(home).some((lockPath) => NodeFS.existsSync(lockPath))).toBe(false);
  });

  it("bounds total acquisition time and cleans partially acquired locks without exposing paths", async () => {
    const release = await properLockfile.lock(home, properOptions(home, 2));
    const stat = NodeFSP.stat;
    let elapsed = 0;
    vi.spyOn(NodePerfHooks.performance, "now").mockImplementation(() => elapsed);
    vi.spyOn(NodeFSP, "stat").mockImplementation(async (...args) => {
      const result = await stat(...args);
      if (args[0] === paths(home)[2]) elapsed = 30_001;
      return result;
    });
    const operation = vi.fn(async () => undefined);
    const job = withClaudeCredentialLocks([home], operation);
    await expect(job).rejects.toBeInstanceOf(ClaudeCredentialLockTimeoutError);
    await expect(job).rejects.toThrow(timeoutMessage);
    expect(operation).not.toHaveBeenCalled();
    expect(NodeFS.existsSync(paths(home)[0]!)).toBe(false);
    expect(NodeFS.existsSync(paths(home)[1]!)).toBe(false);
    expect(NodeFS.existsSync(paths(home)[2]!)).toBe(true);
    await release();
  });

  it("heartbeats all locks every five seconds and clears timers on release", async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const job = withClaudeCredentialLocks([home], async (assertHeld) => {
      entered.resolve();
      await finish.promise;
      assertHeld();
    });
    await entered.promise;
    const before = paths(home).map((target) => NodeFS.statSync(target).mtimeMs);
    await vi.advanceTimersByTimeAsync(5_000);
    paths(home).forEach((target, index) => {
      expect(NodeFS.statSync(target).mtimeMs).toBeGreaterThan(before[index]!);
    });
    finish.resolve();
    await job;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("probes second-resolution filesystems and rounds heartbeat mtimes upward", async () => {
    vi.useFakeTimers();
    const utimes = NodeFSP.utimes;
    vi.spyOn(NodeFSP, "utimes").mockImplementation(async (target, atime, mtime) => {
      const rounded = new Date(Math.floor(Number(mtime) / 1000) * 1000);
      await utimes(target, atime, rounded);
    });
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const job = withClaudeCredentialLocks([home], async (assertHeld) => {
      entered.resolve();
      await finish.promise;
      assertHeld();
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    for (const target of paths(home)) {
      expect(NodeFS.statSync(target).mtime.getTime()).toBe(Math.ceil(Date.now() / 1000) * 1000);
    }
    finish.resolve();
    await job;
  });

  it.each([0, 1])(
    "does not reclaim refresh lock %i at the storage stale threshold",
    async (index) => {
      const target = paths(home)[index]!;
      await NodeFSP.mkdir(target);
      const recent = new Date(Date.now() - 16_000);
      await NodeFSP.utimes(target, recent, recent);
      const stat = NodeFSP.stat;
      let elapsed = 0;
      vi.spyOn(NodePerfHooks.performance, "now").mockImplementation(() => elapsed);
      vi.spyOn(NodeFSP, "stat").mockImplementation(async (...args) => {
        const current = await stat(...args);
        if (args[0] === target) elapsed = 30_001;
        return current;
      });
      await expect(withClaudeCredentialLocks([home], async () => undefined)).rejects.toThrow(
        timeoutMessage,
      );
      expect(NodeFS.statSync(target).mtime.getTime()).toBe(recent.getTime());
    },
  );

  it("detects replaced locks and never removes a new holder's directory", async () => {
    await expect(
      withClaudeCredentialLocks([home], async (assertHeld) => {
        const target = paths(home)[0]!;
        await NodeFSP.rmdir(target);
        await NodeFSP.mkdir(target);
        const changed = new Date(Date.now() + 10_000);
        await NodeFSP.utimes(target, changed, changed);
        expect(assertHeld).toThrow(safeMessage);
      }),
    ).rejects.toThrow(safeMessage);
    expect(NodeFS.existsSync(paths(home)[0]!)).toBe(true);
    expect(NodeFS.existsSync(paths(home)[1]!)).toBe(false);
    expect(NodeFS.existsSync(paths(home)[2]!)).toBe(false);
  });

  it("reports heartbeat compromise even if the operation does not call assertHeld", async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const job = withClaudeCredentialLocks([home], async () => {
      entered.resolve();
      await finish.promise;
    });
    const rejection = expect(job).rejects.toThrow(safeMessage);
    await entered.promise;
    await NodeFSP.rmdir(paths(home)[2]!);
    await vi.advanceTimersByTimeAsync(5_000);
    finish.resolve();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases locks on operation failure and invalidates an escaped assertion", async () => {
    const failure = new Error("operation failed");
    let escaped = () => undefined as void;
    await expect(
      withClaudeCredentialLocks([home], async (assertHeld) => {
        escaped = assertHeld;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(paths(home).some((target) => NodeFS.existsSync(target))).toBe(false);
    expect(escaped).toThrow(safeMessage);
  });

  it("shares Claude's config lock: excludes and waits for a proper-lockfile holder with default staleness", async () => {
    const configPath = NodePath.join(home, ".claude.json");
    await NodeFSP.writeFile(configPath, "{}");
    const lockfilePath = `${configPath}.lock`;
    // proper-lockfile defaults, spelled out because Claude relies on them.
    const claudeOptions = { lockfilePath, stale: 10_000, update: 5_000 };
    await withClaudeConfigLock(configPath, async (assertHeld) => {
      assertHeld();
      await expect(properLockfile.lock(configPath, claudeOptions)).rejects.toMatchObject({
        code: "ELOCKED",
      });
    });
    expect(NodeFS.existsSync(lockfilePath)).toBe(false);
    const release = await properLockfile.lock(configPath, claudeOptions);
    const retryScheduled = Promise.withResolvers<void>();
    const setTimeoutOriginal = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      const timer = setTimeoutOriginal(callback, delay, ...args);
      if (delay === 100) retryScheduled.resolve();
      return timer;
    });
    let entered = false;
    const job = withClaudeConfigLock(configPath, async () => {
      entered = true;
    });
    await retryScheduled.promise;
    expect(entered).toBe(false);
    await release();
    await job;
    expect(entered).toBe(true);
    // Claude's default stale threshold is 10s: a 16s-old lock is reclaimed, a 5s-old one is not.
    await NodeFSP.mkdir(lockfilePath);
    const recent = new Date(Date.now() - 5_000);
    await NodeFSP.utimes(lockfilePath, recent, recent);
    let elapsed = 0;
    vi.spyOn(NodePerfHooks.performance, "now").mockImplementation(() => elapsed);
    const stat = NodeFSP.stat;
    vi.spyOn(NodeFSP, "stat").mockImplementation(async (...args) => {
      const current = await stat(...args);
      if (args[0] === lockfilePath) elapsed = 30_001;
      return current;
    });
    await expect(withClaudeConfigLock(configPath, async () => undefined)).rejects.toThrow(
      timeoutMessage,
    );
    vi.restoreAllMocks();
    const old = new Date(Date.now() - 16_000);
    await NodeFSP.utimes(lockfilePath, old, old);
    await withClaudeConfigLock(configPath, async (assertHeld) => assertHeld());
    expect(NodeFS.existsSync(lockfilePath)).toBe(false);
  });

  it("sanitizes errors resolving missing homes", async () => {
    await expect(
      withClaudeCredentialLocks([NodePath.join(root, "missing")], async () => undefined),
    ).rejects.toThrow(safeMessage);
  });
});
