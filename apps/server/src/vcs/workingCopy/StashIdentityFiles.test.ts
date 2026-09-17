// @effect-diagnostics nodeBuiltinImport:off - proves the transaction against native Git on disk
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  acquireFilesStashTransaction,
  pendingStashRecovery,
  readFilesStashLog,
} from "./StashIdentityFiles.ts";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
async function repo(format = "sha1") {
  const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-stash-identity-"));
  roots.push(cwd);
  git(cwd, "init", "-b", "main", `--object-format=${format}`);
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "user.email", "test@example.invalid");
  await NodeFSP.writeFile(NodePath.join(cwd, "a"), "base\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "base");
  const common = NodePath.join(cwd, ".git");
  const length = format === "sha1" ? 40 : 64;
  const push = async (label: string) => {
    await NodeFSP.writeFile(NodePath.join(cwd, "a"), label + "\n");
    if (format === "sha256") {
      // This distro's Git 2.43 stash push fails on SHA-256. Build the same
      // two-parent stash commit with native plumbing to prove ref semantics.
      const base = git(cwd, "rev-parse", "HEAD");
      const index = git(cwd, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "index");
      git(cwd, "add", ".");
      const tree = git(cwd, "write-tree");
      const oid = git(cwd, "commit-tree", tree, "-p", base, "-p", index, "-m", label);
      git(cwd, "update-ref", "--create-reflog", "-m", `On main: ${label}`, "refs/stash", oid);
      git(cwd, "reset", "--hard", "HEAD");
    } else git(cwd, "stash", "push", "-m", label);
    return (await readFilesStashLog(common, length)).at(-1)!;
  };
  return { cwd, common, length, push };
}
const target = (entry: { commit: string; identity: string }, ref = "stash@{0}") => ({
  ref,
  expectedCommit: entry.commit,
  expectedIdentity: entry.identity,
});
const exists = (file: string) =>
  NodeFSP.stat(file).then(
    () => true,
    () => false,
  );

describe("native Git files-backend identity transaction proof", () => {
  it.each(["sha1", "sha256"])(
    "drops middle, top and last entries with packed refs (%s)",
    async (format: string) => {
      const r = await repo(format);
      const a = await r.push("a"),
        b = await r.push("b"),
        c = await r.push("c");
      git(r.cwd, "pack-refs", "--all");
      for (const [entry, ref] of [
        [b, "stash@{1}"],
        [c, "stash@{0}"],
        [a, "stash@{0}"],
      ] as const) {
        const tx = await acquireFilesStashTransaction(r.common, r.length, target(entry, ref));
        try {
          await tx.drop();
        } finally {
          await tx.release();
        }
        expect(git(r.cwd, "stash", "list", "--format=%H").split("\n")).not.toContain(entry.commit);
        expect(git(r.cwd, "fsck", "--no-dangling")).toBe("");
      }
      expect(git(r.cwd, "stash", "list")).toBe("");
      expect(() => git(r.cwd, "rev-parse", "--verify", "refs/stash")).toThrow();
      // delete_ref parity: the reflog goes with the ref, no orphaned log file.
      expect(await exists(NodePath.join(r.common, "logs/refs/stash"))).toBe(false);
      for (const lock of [
        "refs/stash.lock",
        "logs/refs/stash.lock",
        "packed-refs.lock",
        "packed-refs.t3-new",
        "t3-stash-recovery.json",
      ]) {
        expect(await exists(NodePath.join(r.common, lock))).toBe(false);
      }
      await r.push("after last drop");
      expect(git(r.cwd, "stash", "list").split("\n")).toHaveLength(1);
    },
  );

  it("rewrites old OIDs byte-for-byte like `reflog delete --rewrite`, including the oldest entry", async () => {
    const r = await repo();
    const a = await r.push("a");
    const b = await r.push("b");
    await r.push("c");
    const reference = await repo();
    for (const label of ["a", "b", "c"]) await reference.push(label);
    const logOf = (common: string) =>
      NodeFSP.readFile(NodePath.join(common, "logs/refs/stash"), "utf8");
    const normalize = (log: string) =>
      log
        .replace(/[0-9a-f]{40}/g, (oid) => (oid === a.commit ? "A" : oid === b.commit ? "B" : "?"))
        .replace(/\d{10} [+-]\d{4}/g, "T");
    const before = await logOf(r.common);
    // Oldest entry dropped: native zeroes the next line's old OID.
    const tx = await acquireFilesStashTransaction(r.common, 40, target(a, "stash@{2}"));
    try {
      await tx.drop();
    } finally {
      await tx.release();
    }
    git(reference.cwd, "stash", "drop", "stash@{2}");
    const ours = await logOf(r.common);
    expect(ours.split("\n")[0]?.startsWith("0".repeat(40) + " " + b.commit)).toBe(true);
    expect(normalize(ours).replace(/[^AB?T\n ]/g, "")).toBe(
      normalize(await logOf(reference.common)).replace(/[^AB?T\n ]/g, ""),
    );
    expect(ours).not.toBe(before);
    expect(git(r.cwd, "stash", "list", "--format=%gs")).toBe("On main: c\nOn main: b");
  });

  it("keeps the replaced files' modes instead of Git-alien 0600", async () => {
    const r = await repo();
    const a = await r.push("a");
    await r.push("b");
    await NodeFSP.chmod(NodePath.join(r.common, "refs/stash"), 0o664);
    await NodeFSP.chmod(NodePath.join(r.common, "logs/refs/stash"), 0o664);
    const tx = await acquireFilesStashTransaction(r.common, 40, target(a, "stash@{1}"));
    try {
      await tx.drop();
    } finally {
      await tx.release();
    }
    const mode = async (file: string) =>
      (await NodeFSP.stat(NodePath.join(r.common, file))).mode & 0o777;
    expect(await mode("logs/refs/stash")).toBe(0o664);
    git(r.cwd, "pack-refs", "--all");
    await NodeFSP.chmod(NodePath.join(r.common, "packed-refs"), 0o664);
    const last = (await readFilesStashLog(r.common, 40))[0]!;
    const tx2 = await acquireFilesStashTransaction(r.common, 40, target(last));
    try {
      await tx2.drop();
    } finally {
      await tx2.release();
    }
    expect(await mode("packed-refs")).toBe(0o664);
  });

  it("parses a message-less reflog line and keeps the whole stash mutable", async () => {
    const r = await repo();
    const first = await r.push("first");
    git(r.cwd, "update-ref", "refs/stash", git(r.cwd, "rev-parse", "HEAD"));
    const entries = await readFilesStashLog(r.common, 40);
    expect(entries.map((entry) => entry.subject)).toEqual(["On main: first", ""]);
    const tx = await acquireFilesStashTransaction(r.common, 40, target(entries[1]!));
    try {
      await tx.drop();
    } finally {
      await tx.release();
    }
    expect(git(r.cwd, "stash", "list", "--format=%H")).toBe(first.commit);
  });

  it("rejects stale client positions after a controlled external push before lock acquisition", async () => {
    const r = await repo();
    const first = await r.push("client one");
    // Deterministic barrier: client captured identity, external Git finishes,
    // only then let the transaction acquire native locks.
    const second = await r.push("external");
    await expect(acquireFilesStashTransaction(r.common, 40, target(first))).rejects.toThrow(
      "Stash changed",
    );
    expect((await readFilesStashLog(r.common, 40)).map((x) => x.commit)).toEqual([
      first.commit,
      second.commit,
    ]);
  });

  it("excludes external push/store/drop/clear/pack-refs while validating and deleting", async () => {
    const r = await repo();
    const first = await r.push("first");
    await r.push("second");
    const tx = await acquireFilesStashTransaction(r.common, 40, target(first, "stash@{1}"));
    try {
      await NodeFSP.writeFile(NodePath.join(r.cwd, "a"), "racing edit\n");
      for (const args of [
        ["stash", "push", "-m", "racing"],
        ["stash", "store", "-m", "external", first.commit],
        ["stash", "drop", "stash@{0}"],
        ["stash", "clear"],
        ["pack-refs", "--all"],
      ]) {
        expect(() =>
          git(r.cwd, "-c", "core.filesRefLockTimeout=0", "-c", "core.packedRefsTimeout=0", ...args),
        ).toThrow();
      }
      // The excluded push saved nothing and reverted nothing.
      expect(await NodeFSP.readFile(NodePath.join(r.cwd, "a"), "utf8")).toBe("racing edit\n");
      await tx.drop();
    } finally {
      await tx.release();
    }
    expect((await readFilesStashLog(r.common, 40)).map((x) => x.subject)).toEqual([
      "On main: second",
    ]);
    expect(await NodeFSP.readFile(NodePath.join(r.cwd, "a"), "utf8")).toBe("racing edit\n");
  });

  it("distinguishes duplicate OIDs and rejects genuinely identical reflog entries", async () => {
    const r = await repo();
    const first = await r.push("first");
    const second = await r.push("second");
    git(r.cwd, "stash", "store", "-m", "duplicate oid", first.commit);
    const tx = await acquireFilesStashTransaction(r.common, 40, target(first, "stash@{2}"));
    try {
      await tx.drop();
    } finally {
      await tx.release();
    }
    const left = await readFilesStashLog(r.common, 40);
    expect(left).toHaveLength(2);
    expect(left[1]?.subject).toBe("duplicate oid");
    // The public Git CLI can produce indistinguishable entries in one second.
    const env = { ...process.env, GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z" };
    for (let i = 0; i < 2; i++) {
      NodeChildProcess.execFileSync("git", ["stash", "store", "-m", "separator", second.commit], {
        cwd: r.cwd,
        env,
      });
      NodeChildProcess.execFileSync("git", ["stash", "store", "-m", "identical", first.commit], {
        cwd: r.cwd,
        env,
      });
    }
    const duplicate = (await readFilesStashLog(r.common, 40)).at(-1)!;
    await expect(acquireFilesStashTransaction(r.common, 40, target(duplicate))).rejects.toThrow(
      "ambiguous",
    );
    expect(await readFilesStashLog(r.common, 40)).toHaveLength(6);
  });

  it("lock contention and an unreadable journal preserve the original bytes and release every lock", async () => {
    const r = await repo();
    const first = await r.push("first");
    const before = await NodeFSP.readFile(NodePath.join(r.common, "logs/refs/stash"));
    for (const file of [
      "refs/stash.lock",
      "logs/refs/stash.lock",
      "packed-refs.lock",
      "t3-stash-recovery.json",
    ]) {
      const lock = NodePath.join(r.common, file);
      await NodeFSP.writeFile(lock, "occupied");
      await expect(acquireFilesStashTransaction(r.common, 40, target(first))).rejects.toThrow(
        file.endsWith(".lock") ? "another Git process is using the stash" : "manual recovery",
      );
      expect(await NodeFSP.readFile(NodePath.join(r.common, "logs/refs/stash"))).toEqual(before);
      expect(git(r.cwd, "rev-parse", "refs/stash")).toBe(first.commit);
      await NodeFSP.unlink(lock);
      for (const other of ["refs/stash.lock", "logs/refs/stash.lock", "packed-refs.lock"]) {
        expect(await exists(NodePath.join(r.common, other))).toBe(false);
      }
    }
  });

  it("a prepublication failure changes nothing and its journal clears itself", async () => {
    const r = await repo();
    const first = await r.push("first");
    const second = await r.push("second");
    const before = await NodeFSP.readFile(NodePath.join(r.common, "logs/refs/stash"));
    const failing = {
      rename: async () => {
        throw new Error("disk full");
      },
      unlink: NodeFSP.unlink,
    };
    const tx = await acquireFilesStashTransaction(
      r.common,
      40,
      target(first, "stash@{1}"),
      failing,
    );
    try {
      await expect(tx.drop()).rejects.toThrow("not fully completed");
    } finally {
      await tx.release();
    }
    expect(await NodeFSP.readFile(NodePath.join(r.common, "logs/refs/stash"))).toEqual(before);
    expect(git(r.cwd, "rev-parse", "refs/stash")).toBe(second.commit);
    expect(await exists(NodePath.join(r.common, "t3-stash-recovery.json"))).toBe(true);
    // Untouched bytes prove the interrupted transaction never published.
    const retry = await acquireFilesStashTransaction(r.common, 40, target(first, "stash@{1}"));
    try {
      await retry.drop();
    } finally {
      await retry.release();
    }
    expect(await exists(NodePath.join(r.common, "t3-stash-recovery.json"))).toBe(false);
    expect(git(r.cwd, "stash", "list", "--format=%H")).toBe(second.commit);
  });

  it("a mid-publication failure keeps the journal and refuses further mutations", async () => {
    const r = await repo();
    const first = await r.push("first");
    const second = await r.push("second");
    let renames = 0;
    const partial = {
      rename: async (from: string, to: string) => {
        if (++renames > 1) throw new Error("power loss");
        await NodeFSP.rename(from, to);
      },
      unlink: NodeFSP.unlink,
    };
    const tx = await acquireFilesStashTransaction(r.common, 40, target(second), partial);
    try {
      await expect(tx.drop()).rejects.toThrow("not fully completed");
    } finally {
      await tx.release();
    }
    // Reflog published, ref not: exactly native Git's own interrupted state.
    expect((await readFilesStashLog(r.common, 40)).map((x) => x.commit)).toEqual([first.commit]);
    expect(git(r.cwd, "rev-parse", "refs/stash")).toBe(second.commit);
    await expect(acquireFilesStashTransaction(r.common, 40, target(first))).rejects.toThrow(
      "manual recovery",
    );
    expect(await exists(NodePath.join(r.common, "t3-stash-recovery.json"))).toBe(true);
    // An external push chained off the unpublished ref records the removed
    // commit as its old OID; that is not "completed", the journal stays.
    await NodeFSP.writeFile(NodePath.join(r.cwd, "a"), "external\n");
    git(r.cwd, "stash", "push", "-m", "external");
    await expect(acquireFilesStashTransaction(r.common, 40, target(first))).rejects.toThrow(
      "manual recovery",
    );
    expect(await exists(NodePath.join(r.common, "t3-stash-recovery.json"))).toBe(true);
    git(r.cwd, "stash", "drop", "stash@{0}");
    expect(await pendingStashRecovery(r.common)).toBe(
      NodePath.join(r.common, "t3-stash-recovery.json"),
    );
    // Once the ref agrees with the reflog again (manual repair), a journal
    // whose removed entry is gone is recognised as completed and archived.
    await NodeFSP.writeFile(NodePath.join(r.common, "refs/stash"), first.commit + "\n");
    const next = await acquireFilesStashTransaction(r.common, 40, target(first));
    await next.release();
    expect(await pendingStashRecovery(r.common)).toBeUndefined();
    const archived = (await NodeFSP.readdir(r.common)).filter((name) =>
      /^t3-stash-recovery-.*\.json$/.test(name),
    );
    expect(archived).toHaveLength(1);
    expect(
      JSON.parse(await NodeFSP.readFile(NodePath.join(r.common, archived[0]!), "utf8"))
        .removedCommit,
    ).toBe(second.commit);
  });

  it("uses the common directory for linked worktrees", async () => {
    const r = await repo();
    const entry = await r.push("first");
    const linked = NodePath.join(r.cwd, "linked");
    git(r.cwd, "worktree", "add", "-b", "linked", linked);
    const common = await NodeFSP.realpath(
      NodePath.resolve(linked, git(linked, "rev-parse", "--git-common-dir")),
    );
    expect(common).toBe(r.common);
    const tx = await acquireFilesStashTransaction(common, 40, target(entry));
    try {
      await tx.drop();
    } finally {
      await tx.release();
    }
    expect(git(linked, "stash", "list")).toBe("");
    expect(git(r.cwd, "stash", "list")).toBe("");
  });
});
