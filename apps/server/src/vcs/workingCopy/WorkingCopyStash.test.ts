// @effect-diagnostics nodeBuiltinImport:off - inspects the repository's native lock files
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { WorkingCopyStashEntry } from "@t3tools/contracts";
import { LOG_FIELD_SEPARATOR, LOG_RECORD_SEPARATOR } from "./commands.ts";
import { commitStaged } from "./WorkingCopyCommit.ts";
import { stagePaths } from "./WorkingCopyStaging.ts";
import {
  isDiscardBackupLabel,
  parseStashList,
  parseStashSubject,
  readStashList,
  stashApply,
  stashDrop,
  stashPop,
  stashPush,
} from "./WorkingCopyStash.ts";
import type { WorkingCopyGit } from "./WorkingCopyGit.ts";
import { StashPublish } from "./WorkingCopyStashIdentity.ts";
import {
  git,
  makeTestRepository,
  readFile,
  WorkingCopyTestLayer,
  writeFile,
  type WorkingCopyTestRepo,
} from "./testing/workingCopyTestRepo.ts";

describe("parseStashSubject", () => {
  it("strips the `WIP on <branch>:` and `On <branch>:` prefixes and keeps the branch", () => {
    assert.deepStrictEqual(parseStashSubject("WIP on main: 1a2b3c earlier work"), {
      label: "1a2b3c earlier work",
      branch: "main",
    });
    assert.deepStrictEqual(parseStashSubject("On feature/x: t3-backup: 2 path(s)"), {
      label: "t3-backup: 2 path(s)",
      branch: "feature/x",
    });
  });

  it("passes an unprefixed subject through with a null branch", () => {
    assert.deepStrictEqual(parseStashSubject("bare"), { label: "bare", branch: null });
  });
});

describe("isDiscardBackupLabel", () => {
  it("matches only the panel's own prefix", () => {
    assert.isTrue(isDiscardBackupLabel("t3-backup: 2 path(s)"));
    assert.isFalse(isDiscardBackupLabel("my own work"));
    assert.isFalse(isDiscardBackupLabel("not-t3-backup: sneaky"));
  });
});

describe("parseStashList (fallback for repositories without identity support)", () => {
  const record = (ref: string, subject: string) =>
    [ref, "a".repeat(40), subject, "2024-05-01T10:00:00+02:00"]
      .join(LOG_FIELD_SEPARATOR)
      .concat(LOG_RECORD_SEPARATOR);

  it("keeps the stash commit but never invents an identity", () => {
    const entries = parseStashList(record("stash@{0}", "On main: t3-backup: 1 path(s)"));
    assert.strictEqual(entries[0]?.commit, "a".repeat(40));
    assert.isUndefined(entries[0]?.identity);
  });

  it("parses the index out of the stash ref", () => {
    const entries = parseStashList(
      `${record("stash@{0}", "On main: t3-backup: 1 path(s)")}\n${record("stash@{1}", "WIP on main: earlier")}`,
    );

    assert.deepStrictEqual(
      entries.map((entry) => [entry.index, entry.ref, entry.isDiscardBackup]),
      [
        [0, "stash@{0}", true],
        [1, "stash@{1}", false],
      ],
    );
  });

  it("skips a record whose ref is not a stash handle", () => {
    assert.deepStrictEqual(parseStashList(record("HEAD", "On main: x")), []);
  });

  it("returns nothing for an empty list", () => {
    assert.deepStrictEqual(parseStashList(""), []);
  });
});

/** The wire shape a client builds from a listed entry. */
function identify(entry: WorkingCopyStashEntry, ref = entry.ref) {
  return { ref, expectedCommit: entry.commit ?? "", expectedIdentity: entry.identity ?? "" };
}

const seeded = Effect.fn("seeded")(function* () {
  const repo = yield* makeTestRepository();
  yield* writeFile(repo.cwd, "a.ts", "committed\n");
  yield* stagePaths(repo.git, ["a.ts"]);
  yield* commitStaged(repo.git, "base");
  return repo;
});

const externalPush = Effect.fn("externalPush")(function* (
  repo: WorkingCopyTestRepo,
  label: string,
) {
  yield* writeFile(repo.cwd, "a.ts", `${label}\n`);
  yield* git(repo.cwd, ["stash", "push", "-m", label]);
});

const listed = Effect.fn("listed")(function* (repo: WorkingCopyTestRepo) {
  return (yield* readStashList(repo.git)).map((entry) => entry.label);
});

it.layer(WorkingCopyTestLayer)("stash operations", (it) => {
  it.effect("pushes, lists with commit + identity, applies and drops the listed entry", () =>
    Effect.gen(function* () {
      const repo = yield* seeded();
      yield* writeFile(repo.cwd, "a.ts", "work in progress\n");

      yield* stashPush(repo.git, { message: "my work", includeUntracked: true });

      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "committed\n");
      const listed = yield* readStashList(repo.git);
      assert.strictEqual(listed.length, 1);
      const entry = listed[0]!;
      assert.strictEqual(entry.label, "my work");
      assert.strictEqual(entry.branch, "main");
      assert.isFalse(entry.isDiscardBackup);
      assert.match(entry.commit ?? "", /^[0-9a-f]{40}$/);
      assert.match(entry.identity ?? "", /^[0-9a-f]{64}$/);

      yield* stashApply(repo.git, identify(entry));
      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "work in progress\n");
      // apply keeps the entry; drop removes it.
      assert.strictEqual((yield* readStashList(repo.git)).length, 1);

      yield* stashDrop(repo.git, identify(entry));
      assert.deepStrictEqual(yield* readStashList(repo.git), []);
    }),
  );

  it.effect("pops in one step", () =>
    Effect.gen(function* () {
      const repo = yield* seeded();
      yield* writeFile(repo.cwd, "a.ts", "dirty\n");
      yield* stashPush(repo.git, { includeUntracked: true });
      const entry = (yield* readStashList(repo.git))[0]!;

      yield* stashPop(repo.git, identify(entry));

      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "dirty\n");
      assert.deepStrictEqual(yield* readStashList(repo.git), []);
    }),
  );

  it.effect("refuses an identity-less request before reaching git", () =>
    Effect.gen(function* () {
      const repo = yield* seeded();
      yield* externalPush(repo, "keep");

      const failure = yield* stashDrop(repo.git, {
        ref: "stash@{0}",
        expectedCommit: "",
        expectedIdentity: "",
      }).pipe(Effect.flip);

      assert.strictEqual(failure._tag, "WorkingCopyStashIdentityError");
      assert.deepStrictEqual(yield* listed(repo), ["keep"]);
    }),
  );

  it.effect(
    "rejects a position that moved between display and action, then drops the right one",
    () =>
      Effect.gen(function* () {
        const repo = yield* seeded();
        yield* externalPush(repo, "first");
        const stale = (yield* readStashList(repo.git))[0]!;
        // Barrier: the client rendered `stash@{0}` = first; an agent pushes.
        yield* externalPush(repo, "second");

        const failure = yield* stashDrop(repo.git, identify(stale)).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "WorkingCopyStashIdentityError");
        assert.include(failure.message, "refresh");
        assert.deepStrictEqual(yield* listed(repo), ["second", "first"]);

        // Positional handle with a fresh list, and the immutable OID as handle.
        const fresh = yield* readStashList(repo.git);
        yield* stashDrop(repo.git, identify(fresh[1]!));
        assert.deepStrictEqual(yield* listed(repo), ["second"]);
        yield* stashDrop(repo.git, identify(fresh[0]!, fresh[0]!.commit ?? ""));
        assert.deepStrictEqual(yield* listed(repo), []);
      }),
  );

  it.effect("applies the immutable commit even when the entry has been renumbered", () =>
    Effect.gen(function* () {
      const repo = yield* seeded();
      yield* externalPush(repo, "wanted");
      const wanted = (yield* readStashList(repo.git))[0]!;
      yield* externalPush(repo, "other");

      // The client re-reads the list before acting; the entry is now stash@{1}.
      const current = (yield* readStashList(repo.git)).find(
        (entry) => entry.identity === wanted.identity,
      )!;
      assert.strictEqual(current.ref, "stash@{1}");
      yield* stashPop(repo.git, identify(current));

      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "wanted\n");
      assert.deepStrictEqual(yield* listed(repo), ["other"]);
    }),
  );

  it.effect("a conflicting apply fails and keeps the stash", () =>
    Effect.gen(function* () {
      const repo = yield* seeded();
      yield* externalPush(repo, "stashed");
      const entry = (yield* readStashList(repo.git))[0]!;
      yield* writeFile(repo.cwd, "a.ts", "conflicting commit\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "conflict");

      const failure = yield* stashPop(repo.git, identify(entry)).pipe(Effect.flip);

      assert.strictEqual(failure._tag, "VcsProcessExitError");
      assert.deepStrictEqual(yield* listed(repo), ["stashed"]);
    }),
  );

  it.effect("tells duplicate OIDs apart and removes only the chosen entry", () =>
    Effect.gen(function* () {
      const repo = yield* seeded();
      yield* externalPush(repo, "original");
      const original = (yield* readStashList(repo.git))[0]!;
      // Git skips a reflog entry whose value equals the tip, so separate them.
      yield* externalPush(repo, "separator");
      yield* git(repo.cwd, ["stash", "store", "-m", "copy", original.commit ?? ""]);
      const [copy, , still] = yield* readStashList(repo.git);
      assert.strictEqual(copy?.commit, still?.commit);
      assert.notStrictEqual(copy?.identity, still?.identity);

      yield* stashDrop(repo.git, identify(copy!));

      const left = yield* readStashList(repo.git);
      assert.deepStrictEqual(
        left.map((entry) => entry.identity),
        [(yield* readStashList(repo.git))[0]?.identity, original.identity],
      );
      assert.deepStrictEqual(yield* listed(repo), ["separator", "original"]);
    }),
  );

  it.effect("lock contention is a visible failure that changes nothing", () =>
    Effect.gen(function* () {
      const repo = yield* seeded();
      yield* externalPush(repo, "guarded");
      const entry = (yield* readStashList(repo.git))[0]!;
      const lock = NodePath.join(repo.cwd, ".git/refs/stash.lock");
      yield* Effect.promise(() => NodeFSP.writeFile(lock, ""));

      const failure = yield* stashDrop(repo.git, identify(entry)).pipe(Effect.flip);

      assert.strictEqual(failure._tag, "WorkingCopyStashIdentityError");
      assert.include(failure.message, "another Git process");
      yield* Effect.promise(() => NodeFSP.unlink(lock));
      assert.deepStrictEqual(yield* listed(repo), ["guarded"]);
      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "committed\n");
    }),
  );

  it.effect("pop reports an applied-but-not-removed outcome instead of applying twice", () =>
    Effect.gen(function* () {
      const repo = yield* seeded();
      yield* externalPush(repo, "fragile");
      const entry = (yield* readStashList(repo.git))[0]!;
      const failing = {
        rename: () => Promise.reject(new Error("disk full")),
        unlink: NodeFSP.unlink,
      };

      const failure = yield* stashPop(repo.git, identify(entry)).pipe(
        Effect.provideService(StashPublish, failing),
        Effect.flip,
      );

      assert.strictEqual(failure._tag, "WorkingCopyStashIdentityError");
      assert.isTrue(failure._tag === "WorkingCopyStashIdentityError" && failure.applied);
      assert.include(failure.message, "Do not apply it again");
      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "fragile\n");
      assert.deepStrictEqual(yield* listed(repo), ["fragile"]);
      // The untouched journal clears itself; a plain drop finishes the job.
      yield* stashDrop(repo.git, identify(entry));
      assert.deepStrictEqual(yield* listed(repo), []);
    }),
  );

  it.effect("a pending recovery journal is visible in the list and blocks mutations", () =>
    Effect.gen(function* () {
      const repo = yield* seeded();
      yield* externalPush(repo, "kept");
      yield* externalPush(repo, "interrupted");
      const [top, kept] = yield* readStashList(repo.git);
      let renames = 0;
      const partial = {
        rename: async (from: string, to: string) => {
          if (++renames > 1) throw new Error("power loss");
          await NodeFSP.rename(from, to);
        },
        unlink: NodeFSP.unlink,
      };
      const failure = yield* stashDrop(repo.git, identify(top!)).pipe(
        Effect.provideService(StashPublish, partial),
        Effect.flip,
      );
      assert.strictEqual(failure._tag, "WorkingCopyStashIdentityError");

      const listed = yield* readStashList(repo.git);
      assert.deepStrictEqual(
        listed.map((entry) => entry.label),
        ["kept"],
      );
      assert.strictEqual(
        listed[0]?.recoveryJournalPath,
        NodePath.join(repo.cwd, ".git/t3-stash-recovery.json"),
      );
      const blocked = yield* stashDrop(repo.git, identify(kept!, "stash@{0}")).pipe(Effect.flip);
      assert.include(blocked.message, "manual recovery");
      assert.strictEqual(yield* git(repo.cwd, ["rev-parse", "refs/stash"]), `${top?.commit}\n`);
    }),
  );

  it.effect("an unsupported ref backend still lists, and refuses every mutation", () =>
    Effect.gen(function* () {
      const repo = yield* seeded();
      yield* externalPush(repo, "reftable-hosted");
      // Report an unsupported backend without creating an invalid repository:
      // newer Git rejects a refStorage extension on format version 0 outright.
      const unsupportedGit: WorkingCopyGit = {
        ...repo.git,
        run: (input) =>
          repo.git
            .run(input)
            .pipe(
              Effect.map((output) =>
                input.args.join(" ") === "config --get extensions.refStorage"
                  ? { ...output, exitCode: ChildProcessSpawner.ExitCode(0), stdout: "reftable\n" }
                  : output,
              ),
            ),
      };

      const entries = yield* readStashList(unsupportedGit);
      assert.deepStrictEqual(
        entries.map((entry) => [entry.label, entry.identity]),
        [["reftable-hosted", undefined]],
      );
      const failure = yield* stashDrop(unsupportedGit, {
        ref: "stash@{0}",
        expectedCommit: entries[0]?.commit ?? "",
        expectedIdentity: "0".repeat(64),
      }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WorkingCopyStashIdentityError");
      assert.include(failure.message, "unsupported");
      assert.strictEqual(
        yield* git(repo.cwd, ["stash", "list"]),
        "stash@{0}: On main: reftable-hosted\n",
      );
    }),
  );

  it.effect("lists nothing in a repository that has never stashed", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();

      assert.deepStrictEqual(yield* readStashList(repo.git), []);
    }),
  );
});
