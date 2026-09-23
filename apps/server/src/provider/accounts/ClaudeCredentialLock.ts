import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";

const ACQUIRE_TIMEOUT_MS = 30_000;
const UPDATE_MS = 5_000;
const RETRY_MS = 100;
const LOCK_ERROR = "Could not safely lock Claude credentials. Try again shortly.";

export class ClaudeCredentialLockTimeoutError extends Error {
  constructor() {
    super("Claude is refreshing its login, try again in a moment");
    this.name = "ClaudeCredentialLockTimeoutError";
  }
}

function lockError() {
  // Do not expose config paths or filesystem errors through account RPCs.
  return new Error(LOCK_ERROR);
}

function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

type HeldLock = {
  lockPath: string;
  stale: number;
  mtime: number;
  dev: number;
  ino: number;
  seconds: boolean;
  lastUpdate: number;
  compromised: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
};

function checkOwned(lock: HeldLock) {
  if (lock.compromised) throw lockError();
  try {
    const current = NodeFS.statSync(lock.lockPath);
    if (
      current.dev !== lock.dev ||
      current.ino !== lock.ino ||
      current.mtime.getTime() !== lock.mtime ||
      !current.isDirectory()
    ) {
      throw lockError();
    }
  } catch {
    lock.compromised = true;
    throw lockError();
  }
}

function heartbeat(lock: HeldLock, delay = UPDATE_MS) {
  lock.timer = setTimeout(() => {
    lock.timer = undefined;
    try {
      checkOwned(lock);
      const now = Date.now();
      const mtime = new Date(lock.seconds ? Math.ceil(now / 1000) * 1000 : now);
      // These metadata calls are synchronous so assertHeld cannot observe a new
      // on-disk mtime before the corresponding in-memory ownership update.
      NodeFS.utimesSync(lock.lockPath, mtime, mtime);
      lock.mtime = mtime.getTime();
      lock.lastUpdate = NodePerfHooks.performance.now();
      heartbeat(lock);
    } catch (error) {
      if (
        lock.compromised ||
        hasCode(error, "ENOENT") ||
        NodePerfHooks.performance.now() - lock.lastUpdate >= lock.stale
      ) {
        lock.compromised = true;
      } else {
        heartbeat(lock, 1000);
      }
    }
  }, delay);
  lock.timer.unref();
}

async function tryAcquire(lockPath: string, stale: number): Promise<HeldLock | undefined> {
  try {
    await NodeFSP.mkdir(lockPath);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw lockError();
    try {
      const current = await NodeFSP.stat(lockPath);
      if (current.mtime.getTime() < Date.now() - stale) {
        // Like proper-lockfile, use rmdir, never recursive removal or unlink.
        await NodeFSP.rmdir(lockPath);
      }
    } catch (statError) {
      if (!hasCode(statError, "ENOENT")) throw lockError();
    }
    return undefined;
  }

  try {
    // proper-lockfile 4.1.2 probes with a whole second plus 5ms, then rounds
    // future updates up to seconds only if the filesystem dropped those 5ms.
    const probe = new Date(Math.ceil(Date.now() / 1000) * 1000 + 5);
    await NodeFSP.utimes(lockPath, probe, probe);
    const current = await NodeFSP.stat(lockPath);
    const lock: HeldLock = {
      lockPath,
      stale,
      mtime: current.mtime.getTime(),
      dev: current.dev,
      ino: current.ino,
      seconds: current.mtime.getTime() % 1000 === 0,
      lastUpdate: NodePerfHooks.performance.now(),
      compromised: false,
      timer: undefined,
    };
    heartbeat(lock);
    return lock;
  } catch {
    await NodeFSP.rmdir(lockPath).catch(() => undefined);
    throw lockError();
  }
}

type LockSpec = { lockPath: string; stale: number };

async function withLocks<T>(
  resolveSpecs: () => Promise<readonly LockSpec[]>,
  operation: (assertHeld: () => void) => Promise<T>,
): Promise<T> {
  const deadline = NodePerfHooks.performance.now() + ACQUIRE_TIMEOUT_MS;
  const held: HeldLock[] = [];
  let released = false;
  let cleanupFailed = false;
  let result!: T;
  const assertHeld = () => {
    if (released) throw lockError();
    for (const lock of held) {
      checkOwned(lock);
      // A stalled event loop must not let a mutation run on an expired lease.
      if (NodePerfHooks.performance.now() - lock.lastUpdate >= lock.stale) {
        lock.compromised = true;
        throw lockError();
      }
    }
  };

  try {
    let specs: readonly LockSpec[];
    try {
      specs = await resolveSpecs();
    } catch {
      throw lockError();
    }
    for (const { lockPath, stale } of specs) {
      for (;;) {
        assertHeld();
        if (NodePerfHooks.performance.now() >= deadline)
          throw new ClaudeCredentialLockTimeoutError();
        const lock = await tryAcquire(lockPath, stale);
        if (lock) {
          held.push(lock);
          break;
        }
        const remaining = deadline - NodePerfHooks.performance.now();
        if (remaining <= 0) throw new ClaudeCredentialLockTimeoutError();
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(RETRY_MS, remaining)));
      }
    }
    if (NodePerfHooks.performance.now() >= deadline) throw new ClaudeCredentialLockTimeoutError();
    assertHeld();
    result = await operation(assertHeld);
    assertHeld();
  } finally {
    released = true;
    for (const lock of held.toReversed()) {
      if (lock.timer) clearTimeout(lock.timer);
      try {
        checkOwned(lock);
        NodeFS.rmdirSync(lock.lockPath);
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (cleanupFailed) throw lockError();
  return result;
}

/** Hold Claude's refresh, legacy refresh, and storage locks across credential moves.
 * Call assertHeld immediately before each mutation after an await. The operation
 * is not cancelled on compromise: it must settle before other locks are released.
 */
export function withClaudeCredentialLocks<T>(
  homes: readonly string[],
  operation: (assertHeld: () => void) => Promise<T>,
): Promise<T> {
  return withLocks(async () => {
    const canonicalHomes = [
      ...new Set(await Promise.all(homes.map((home) => NodeFSP.realpath(home)))),
    ].sort();
    return canonicalHomes.flatMap((home) => [
      { lockPath: NodePath.join(home, ".oauth_refresh.lock"), stale: 60_000 },
      { lockPath: `${home}.lock`, stale: 60_000 },
      { lockPath: NodePath.join(home, ".storage-write.lock"), stale: 15_000 },
    ]);
  }, operation);
}

/**
 * Claude serializes every global-config write through proper-lockfile on
 * `${configPath}.lock` with library defaults (stale 10s, update 5s). Acquire it
 * last, after the credential locks, and only around one read-modify-write.
 */
export function withClaudeConfigLock<T>(
  configPath: string,
  operation: (assertHeld: () => void) => Promise<T>,
): Promise<T> {
  return withLocks(async () => [{ lockPath: `${configPath}.lock`, stale: 10_000 }], operation);
}
