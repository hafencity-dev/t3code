// @effect-diagnostics nodeBuiltinImport:off globalDate:off - native Git lock files and reflog timestamps
/**
 * fork: files-backend stash entry transaction. Git's files_reflog_expire and
 * ref updates serialize on refs/stash.lock (logs/refs/stash.lock alone is NOT
 * sufficient). Keep that lock from identity validation through apply/removal.
 * https://github.com/git/git/blob/v2.43.0/refs/files-backend.c#L3136-L3268
 *
 * Like native Git, ref + reflog publication is not a multi-file atomic rename.
 * Stage/fsync everything first; a durable journal detects interrupted commits.
 * A journal whose transaction provably never published, or provably finished,
 * is cleared; anything in between keeps the journal and refuses further app
 * mutations. Never replay an apply or guess at recovery. Unselected entries
 * remain in the log.
 * Only regular files, the files ref backend, SHA-1/SHA-256 are supported.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MAX_LOG_BYTES = 8 * 1024 * 1024;
/** Whole-file rewrite on last-entry removal; beyond this, fail closed. */
const MAX_PACKED_BYTES = 64 * 1024 * 1024;
const JOURNAL = "t3-stash-recovery.json";
const fullOid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface StashIdentityInput {
  readonly ref: string;
  readonly expectedCommit: string;
  readonly expectedIdentity: string;
}

export interface FilesStashEntry {
  readonly commit: string;
  readonly identity: string;
  readonly subject: string;
  readonly createdAt: string;
  readonly line: string;
}

/** The publication primitives; tests inject failures through this seam. */
export interface StashPublishFs {
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly unlink: (file: string) => Promise<void>;
}

export function requireStashIdentity(input: StashIdentityInput): void {
  if (
    !fullOid.test(input.expectedCommit ?? "") ||
    !/^[0-9a-f]{64}$/.test(input.expectedIdentity ?? "")
  ) {
    throw new Error(
      "Stash identity is missing or invalid; refresh the stash list before trying again.",
    );
  }
  if (!/^stash@\{\d+\}$/.test(input.ref) && input.ref !== input.expectedCommit) {
    throw new Error("Invalid stash reference; refresh the stash list before trying again.");
  }
}

async function regularContents(
  file: string,
  optional = false,
  maxBytes = MAX_LOG_BYTES,
): Promise<string> {
  let handle;
  try {
    handle = await NodeFSP.open(file, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("Unsupported stash storage file or size.");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export function parseFilesStashLog(contents: string, oidLength: number): FilesStashEntry[] {
  if (oidLength !== 40 && oidLength !== 64) throw new Error("Unsupported Git object format.");
  if (contents !== "" && !contents.endsWith("\n"))
    throw new Error("Incomplete stash reflog; repair it with Git before trying again.");
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      // A message-less update (`update-ref` without -m) writes no tab at all.
      const match = /^([0-9a-f]+) ([0-9a-f]+) (.+) (\d+) ([+-]\d{4})(?:\t(.*))?$/.exec(line);
      if (!match || match[1]?.length !== oidLength || match[2]?.length !== oidLength) {
        throw new Error("Unsupported stash reflog record.");
      }
      // --rewrite changes the old OID, not this entry's immutable payload.
      const payload = line.slice(oidLength + 1);
      return {
        commit: match[2],
        identity: NodeCrypto.createHash("sha256").update(payload).digest("hex"),
        subject: match[6] ?? "",
        createdAt: new Date(Number(match[4]) * 1000).toISOString(),
        line,
      };
    });
}

export async function readFilesStashLog(commonDir: string, oidLength: number) {
  return parseFilesStashLog(
    await regularContents(NodePath.join(commonDir, "logs/refs/stash"), true),
    oidLength,
  );
}

/** The journal of an interrupted removal, if one is pending; lists surface it. */
export async function pendingStashRecovery(commonDir: string): Promise<string | undefined> {
  const journalPath = NodePath.join(commonDir, JOURNAL);
  return (await NodeFSP.stat(journalPath).then(
    () => true,
    () => false,
  ))
    ? journalPath
    : undefined;
}

/** Best effort, like Git's own default `core.fsync`; Windows cannot open directories. */
async function syncDirectory(directory: string) {
  let handle;
  try {
    handle = await NodeFSP.open(directory, "r");
  } catch {
    return;
  }
  try {
    await handle.sync();
  } catch {
    /* durability hint only */
  } finally {
    await handle.close();
  }
}

/** Native lock files are 0666 & umask; a replaced file keeps its exact mode (shared repositories). */
async function inheritMode(handle: NodeFSP.FileHandle, target: string) {
  const stat = await NodeFSP.stat(target).catch(() => undefined);
  if (stat?.isFile()) await handle.chmod(stat.mode & 0o777);
}

interface Journal {
  readonly ref: string;
  readonly packedStash: string | undefined;
  readonly originalLog: string;
  readonly removedCommit: string;
  readonly removedIdentity: string;
}

/** Acquires native locks without retries. Contention means no mutation, not a stale retry. */
export async function acquireFilesStashTransaction(
  commonDir: string,
  oidLength: number,
  input: StashIdentityInput,
  publish: StashPublishFs = NodeFSP,
) {
  requireStashIdentity(input);
  if (input.expectedCommit.length !== oidLength)
    throw new Error("Stash object format changed; refresh the stash list.");
  const refPath = NodePath.join(commonDir, "refs/stash");
  const logPath = NodePath.join(commonDir, "logs/refs/stash");
  const packedPath = NodePath.join(commonDir, "packed-refs");
  const journalPath = NodePath.join(commonDir, JOURNAL);
  const locks = new Map<string, NodeFSP.FileHandle>();
  const lock = async (file: string) => {
    try {
      const handle = await NodeFSP.open(`${file}.lock`, "wx", 0o666);
      locks.set(file, handle);
      return handle;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `${file}.lock exists: another Git process is using the stash, or a crashed Git or T3 Code process left it behind. Remove that file only when no Git is running. No changes made.`,
          { cause },
        );
      }
      throw cause;
    }
  };
  const release = async () => {
    for (const [file, handle] of locks) {
      await handle.close().catch(() => undefined);
      await NodeFSP.unlink(`${file}.lock`).catch(() => undefined);
    }
    locks.clear();
  };
  try {
    // Git creates these directories itself on push. Missing means no stash.
    const refLock = await lock(refPath);
    const logLock = await lock(logPath);
    const originalLog = await regularContents(logPath, true);
    const entries = parseFilesStashLog(originalLog, oidLength);
    const looseRef = await regularContents(refPath, true);
    // Always lock packed refs: pack-refs must not publish a stale packed stash
    // while the last loose stash is removed. Native ref updates use this order.
    await lock(packedPath);
    const packed = await regularContents(packedPath, true, MAX_PACKED_BYTES);
    const packedLines = packed.split("\n");
    let packedStash: string | undefined;
    for (const line of packedLines) {
      if (line === "" || line.startsWith("#")) continue;
      if (line.startsWith("^") && fullOid.test(line.slice(1))) continue;
      const match = /^([0-9a-f]+) ([^\s]+)$/.exec(line);
      if (!match || match[1]?.length !== oidLength)
        throw new Error("Unsupported packed-refs format.");
      if (match[2] === "refs/stash") {
        if (packedStash !== undefined) throw new Error("Duplicate packed stash ref.");
        packedStash = match[1];
      }
    }
    const tip = looseRef.trim() || packedStash;
    const consistent =
      tip === undefined
        ? entries.length === 0
        : fullOid.test(tip) && tip === entries.at(-1)?.commit;

    if (
      await NodeFSP.stat(journalPath).then(
        () => true,
        () => false,
      )
    ) {
      let journal: Journal | undefined;
      try {
        journal = JSON.parse(await regularContents(journalPath)) as Journal;
      } catch {
        journal = undefined;
      }
      const untouched =
        journal !== undefined &&
        journal.originalLog === originalLog &&
        journal.ref === looseRef &&
        journal.packedStash === packedStash;
      // Completed means the removed entry is gone AND nothing was chained off
      // its commit afterwards: an external push on top of an unpublished ref
      // records the removed commit in its old-OID column.
      const completed =
        journal !== undefined &&
        consistent &&
        !entries.some(
          (entry) =>
            entry.identity === journal.removedIdentity ||
            entry.line.slice(0, oidLength) === journal.removedCommit,
        );
      if (!untouched && !completed) {
        throw new Error(
          `An interrupted stash transaction needs manual recovery; inspect ${journalPath}. No changes made.`,
        );
      }
      // Untouched leaves no trace; a finished removal keeps its breadcrumb.
      if (untouched) await NodeFSP.unlink(journalPath);
      else
        await NodeFSP.rename(
          journalPath,
          `${journalPath.slice(0, -".json".length)}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        );
    }

    const matches = entries.filter((entry) => entry.identity === input.expectedIdentity);
    const index =
      input.ref === input.expectedCommit
        ? entries.findIndex((entry) => entry.identity === input.expectedIdentity)
        : entries.length - 1 - Number(input.ref.slice(7, -1));
    const entry = entries[index];
    if (
      matches.length !== 1 ||
      !entry ||
      entry.commit !== input.expectedCommit ||
      entry.identity !== input.expectedIdentity
    ) {
      throw new Error(
        "Stash changed or its entry identity is ambiguous; refresh the stash list. No changes made.",
      );
    }
    if (!consistent) {
      throw new Error(
        "Stash ref and reflog disagree; repair with Git before trying again. No changes made.",
      );
    }
    let attempted = false;
    const drop = async () => {
      if (attempted)
        throw new Error("Stash removal already attempted; do not replay the operation.");
      attempted = true;
      const kept = entries.filter((_, i) => i !== index);
      // `reflog delete --rewrite` semantics: last_kept_oid starts at the null
      // OID, so every kept line's old OID becomes the previously kept commit.
      let previous = "0".repeat(oidLength);
      const newLog = kept
        .map((item) => {
          const line = previous + item.line.slice(oidLength);
          previous = item.commit;
          return line + "\n";
        })
        .join("");
      const newTip = kept.at(-1)?.commit;
      let removePeeled = false;
      const newPacked = packedLines
        .filter((line) => {
          if (line.endsWith(" refs/stash")) {
            removePeeled = true;
            return false;
          }
          if (removePeeled && line.startsWith("^")) {
            removePeeled = false;
            return false;
          }
          removePeeled = false;
          return true;
        })
        .join("\n");
      // Stage every byte before publishing anything. A prepublication failure
      // leaves ref/reflog/packed-refs byte-for-byte intact.
      await logLock.writeFile(newLog);
      await logLock.sync();
      await inheritMode(logLock, logPath);
      if (newTip) {
        await refLock.writeFile(newTip + "\n");
        await refLock.sync();
        await inheritMode(refLock, refPath);
      }
      // packed-refs transactions retain packed-refs.lock across publication
      // and loose-ref deletion; publishing the lock itself would open a race.
      const packedNew = `${packedPath}.t3-new`;
      if (!newTip && packedStash) {
        // Only a crash of our own can leave this behind; packed-refs.lock is held.
        await NodeFSP.unlink(packedNew).catch(() => undefined);
        const stagedPacked = await NodeFSP.open(packedNew, "wx", 0o666);
        try {
          await stagedPacked.writeFile(newPacked);
          await stagedPacked.sync();
          await inheritMode(stagedPacked, packedPath);
        } finally {
          await stagedPacked.close();
        }
      }
      const journal: Journal = {
        ref: looseRef,
        packedStash,
        originalLog,
        removedCommit: entry.commit,
        removedIdentity: entry.identity,
      };
      const journalHandle = await NodeFSP.open(journalPath, "wx", 0o666);
      try {
        await journalHandle.writeFile(JSON.stringify(journal));
        await journalHandle.sync();
      } finally {
        await journalHandle.close();
      }
      await syncDirectory(commonDir);
      try {
        // Native Git publishes the rewritten reflog before the new ref, too.
        await publish.rename(`${logPath}.lock`, logPath);
        locks.delete(logPath);
        await logLock.close();
        await syncDirectory(NodePath.dirname(logPath));
        if (newTip) {
          await publish.rename(`${refPath}.lock`, refPath);
          locks.delete(refPath);
          await refLock.close();
        } else {
          if (packedStash) {
            await publish.rename(packedNew, packedPath);
            await syncDirectory(commonDir);
          }
          if (looseRef) await publish.unlink(refPath);
          // delete_ref removes the reflog with the ref; an orphaned log is not native state.
          await publish.unlink(logPath);
        }
        await syncDirectory(NodePath.dirname(refPath));
        await NodeFSP.unlink(journalPath);
        await syncDirectory(commonDir);
      } catch (cause) {
        await NodeFSP.unlink(packedNew).catch(() => undefined);
        throw new Error(
          `Stash removal was not fully completed. Do not retry automatically; recovery details are in ${journalPath}.`,
          { cause },
        );
      }
    };
    return { entry, drop, release };
  } catch (error) {
    await release();
    throw error;
  }
}
