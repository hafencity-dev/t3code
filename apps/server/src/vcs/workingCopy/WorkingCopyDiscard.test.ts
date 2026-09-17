import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  backupMessage,
  discardDestructively,
  discardPaths,
  listDiscardBackups,
  restoreDiscardBackup,
  supportsPathspecStash,
} from "./WorkingCopyDiscard.ts";
import { readStashList } from "./WorkingCopyStash.ts";
import type { WorkingCopyDiscardResult, WorkingCopyStashEntry } from "@t3tools/contracts";
import { readWorkingCopyStatus } from "./WorkingCopyStatus.ts";
import { stagePaths } from "./WorkingCopyStaging.ts";
import { commitStaged } from "./WorkingCopyCommit.ts";
import {
  git,
  makeTestRepository,
  readFile,
  WorkingCopyTestLayer,
  writeFile,
} from "./testing/workingCopyTestRepo.ts";

/** What the undo toast holds: the immutable handle the server returned. */
function undoTarget(result: WorkingCopyDiscardResult) {
  return {
    ref: result.backupRef ?? "",
    expectedCommit: result.backupRef ?? "",
    expectedIdentity: result.backupIdentity ?? "",
  };
}

/** What the "Recent backups" list holds. */
function listedTarget(entry: WorkingCopyStashEntry) {
  return {
    ref: entry.ref,
    expectedCommit: entry.commit ?? "",
    expectedIdentity: entry.identity ?? "",
  };
}

describe("supportsPathspecStash", () => {
  it("requires git >= 2.13, the release that added `stash push -- <paths>`", () => {
    assert.isFalse(supportsPathspecStash("git version 2.12.5"));
    assert.isTrue(supportsPathspecStash("git version 2.13.0"));
    assert.isTrue(supportsPathspecStash("git version 2.39.3 (Apple Git-146)"));
    assert.isTrue(supportsPathspecStash("git version 3.0.0"));
  });

  it("refuses to guess when the version cannot be read", () => {
    assert.isFalse(supportsPathspecStash(""));
    assert.isFalse(supportsPathspecStash("git version unknown"));
  });
});

describe("backupMessage", () => {
  it("always carries the prefix the prune step keys on", () => {
    assert.isTrue(backupMessage("3 files", 3).startsWith("t3-backup:"));
    assert.isTrue(backupMessage(undefined, 0).startsWith("t3-backup:"));
  });
});

it.layer(WorkingCopyTestLayer)("discardPaths", (it) => {
  it.effect("reverts the named paths, keeps a prefixed backup, and reports recoverable", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* writeFile(repo.cwd, "b.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts", "b.ts"]);
      yield* commitStaged(repo.git, "base");

      yield* writeFile(repo.cwd, "a.ts", "dirty\n");
      yield* writeFile(repo.cwd, "b.ts", "also dirty\n");

      const result = yield* discardPaths(repo.git, { paths: ["a.ts"], label: "a.ts" });

      assert.strictEqual(result.recoverable, true);
      assert.deepStrictEqual(result.discardedPaths, ["a.ts"]);
      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "committed\n");
      // The paths that were not named are untouched.
      assert.strictEqual(yield* readFile(repo.cwd, "b.ts"), "also dirty\n");

      const stashes = yield* readStashList(repo.git);
      assert.strictEqual(stashes.length, 1);
      assert.isTrue(stashes[0]?.isDiscardBackup);
      assert.include(stashes[0]?.label ?? "", "t3-backup:");
      // The handle is the stash COMMIT, not `stash@{0}`: it has to survive a
      // second discard renumbering the stack under the undo toast.
      assert.strictEqual(result.backupRef, stashes[0]?.commit);
      assert.match(result.backupRef ?? "", /^[0-9a-f]{40}$/);
      assert.strictEqual(result.backupIdentity, stashes[0]?.identity);
      assert.isUndefined(result.warning);
    }),
  );

  it.effect("restores exactly the discarded bytes", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "a.ts", "precious edit\n");

      const result = yield* discardPaths(repo.git, { paths: ["a.ts"] });
      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "committed\n");

      yield* restoreDiscardBackup(repo.git, undoTarget(result));

      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "precious edit\n");
      // `pop` removed the backup, so undo cannot be replayed twice.
      assert.deepStrictEqual(yield* listDiscardBackups(repo.git), []);
    }),
  );

  it.effect("backs up an untracked file too", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "keep.ts", "keep\n");
      yield* stagePaths(repo.git, ["keep.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "fresh.ts", "brand new\n");

      const result = yield* discardPaths(repo.git, { paths: ["fresh.ts"] });

      assert.strictEqual(result.recoverable, true);
      assert.strictEqual(yield* readFile(repo.cwd, "fresh.ts"), null);

      yield* restoreDiscardBackup(repo.git, undoTarget(result));
      assert.strictEqual(yield* readFile(repo.cwd, "fresh.ts"), "brand new\n");
    }),
  );

  it.effect("refuses an unbackable discard and destroys nothing until it is confirmed", () =>
    Effect.gen(function* () {
      // Unborn HEAD: nothing to stash against. The answer must arrive BEFORE
      // anything is destroyed, or the confirm-first rung can never fire on the
      // first discard in a fresh `git init`.
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "fresh.ts", "unborn\n");

      const preflight = yield* discardPaths(repo.git, { paths: ["fresh.ts"] });

      assert.strictEqual(preflight.requiresConfirmation, true);
      assert.strictEqual(preflight.recoverable, false);
      assert.deepStrictEqual(preflight.discardedPaths, []);
      assert.strictEqual(yield* readFile(repo.cwd, "fresh.ts"), "unborn\n");
    }),
  );

  it.effect("discards irrecoverably once the client confirms", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "fresh.ts", "unborn\n");

      const result = yield* discardPaths(repo.git, {
        paths: ["fresh.ts"],
        confirmedDestructive: true,
      });

      assert.strictEqual(result.recoverable, false);
      assert.isUndefined(result.requiresConfirmation);
      assert.isUndefined(result.backupRef);
      assert.strictEqual(yield* readFile(repo.cwd, "fresh.ts"), null);
    }),
  );

  it.effect("undo pops the right backup after a second discard renumbered the stack", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed a\n");
      yield* writeFile(repo.cwd, "b.ts", "committed b\n");
      yield* stagePaths(repo.git, ["a.ts", "b.ts"]);
      yield* commitStaged(repo.git, "base");

      yield* writeFile(repo.cwd, "a.ts", "precious a\n");
      const first = yield* discardPaths(repo.git, { paths: ["a.ts"] });
      yield* writeFile(repo.cwd, "b.ts", "precious b\n");
      yield* discardPaths(repo.git, { paths: ["b.ts"] });

      // `a.ts`'s backup is now `stash@{1}`. Undoing by the handle taken at
      // discard time must restore `a.ts`, never `b.ts`.
      yield* restoreDiscardBackup(repo.git, undoTarget(first));

      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "precious a\n");
      assert.strictEqual(yield* readFile(repo.cwd, "b.ts"), "committed b\n");
      const remaining = yield* listDiscardBackups(repo.git);
      assert.strictEqual(remaining.length, 1);
    }),
  );

  it.effect("fails loudly when the referenced backup is gone rather than popping stash@{0}", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "a.ts", "dirty\n");
      const result = yield* discardPaths(repo.git, { paths: ["a.ts"] });
      yield* git(repo.cwd, ["stash", "drop", "stash@{0}"]);

      const error = yield* restoreDiscardBackup(repo.git, undoTarget(result)).pipe(Effect.flip);

      assert.strictEqual(error._tag, "WorkingCopyStashIdentityError");
      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "committed\n");
    }),
  );

  // fork: remote Git — the backup is found by its operation marker, never by
  // assuming it is `stash@{0}`; an agent's stash between the push and the
  // read-back must not become the undo target.
  it.effect("captures its own backup when another stash lands right after the push", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed a\n");
      yield* writeFile(repo.cwd, "b.ts", "committed b\n");
      yield* stagePaths(repo.git, ["a.ts", "b.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "a.ts", "precious a\n");
      yield* writeFile(repo.cwd, "b.ts", "agent b\n");

      const result = yield* discardPaths(repo.git, { paths: ["a.ts"] });
      // Barrier: the toast is on screen, an agent stashes b.ts on top.
      yield* git(repo.cwd, ["stash", "push", "-m", "agent work", "--", "b.ts"]);

      yield* restoreDiscardBackup(repo.git, undoTarget(result));

      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "precious a\n");
      assert.strictEqual(yield* readFile(repo.cwd, "b.ts"), "committed b\n");
      const all = yield* readStashList(repo.git);
      assert.deepStrictEqual(
        all.map((entry) => entry.label),
        ["agent work"],
      );
    }),
  );

  it.effect("restore refuses a stash that is not one of the panel's backups", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "a.ts", "user work\n");
      yield* git(repo.cwd, ["stash", "push", "-m", "mine"]);
      const mine = (yield* readStashList(repo.git))[0]!;

      const error = yield* restoreDiscardBackup(repo.git, listedTarget(mine)).pipe(Effect.flip);

      assert.strictEqual(error._tag, "WorkingCopyStashIdentityError");
      assert.include(error.message, "not a discard backup");
      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "committed\n");
      assert.strictEqual((yield* readStashList(repo.git)).length, 1);
    }),
  );

  it.effect("restore from the backups list applies that entry after a renumbering", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "a.ts", "first\n");
      yield* discardPaths(repo.git, { paths: ["a.ts"] });
      const shown = (yield* listDiscardBackups(repo.git))[0]!;
      yield* writeFile(repo.cwd, "a.ts", "second\n");
      yield* discardPaths(repo.git, { paths: ["a.ts"] });

      // The list the user clicked said stash@{0}; it is stash@{1} now.
      const stale = yield* restoreDiscardBackup(repo.git, listedTarget(shown)).pipe(Effect.flip);
      assert.strictEqual(stale._tag, "WorkingCopyStashIdentityError");
      const current = (yield* listDiscardBackups(repo.git)).find(
        (entry) => entry.identity === shown.identity,
      )!;
      yield* restoreDiscardBackup(repo.git, listedTarget(current));

      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "first\n");
      assert.strictEqual((yield* listDiscardBackups(repo.git)).length, 1);
    }),
  );

  it.effect("the destructive fallback resets to HEAD, not just to the index", () =>
    Effect.gen(function* () {
      // Same semantics as the stash path. `checkout -- <paths>` alone restores
      // the worktree from the INDEX, so a file with both a staged and an
      // unstaged edit would keep its staged half while the confirm dialog said
      // the changes were lost permanently.
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "a.ts", "staged edit\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* writeFile(repo.cwd, "a.ts", "worktree edit\n");

      yield* discardDestructively(repo.git, ["a.ts"]);

      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "committed\n");
      const status = yield* readWorkingCopyStatus(repo.git);
      assert.deepStrictEqual(status.files, []);
    }),
  );

  it.effect("discards everything when no paths are named", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "a.ts", "dirty\n");
      yield* writeFile(repo.cwd, "fresh.ts", "new\n");

      const result = yield* discardPaths(repo.git, { paths: [] });

      assert.strictEqual(result.recoverable, true);
      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "committed\n");
      assert.strictEqual(yield* readFile(repo.cwd, "fresh.ts"), null);
      const status = yield* readWorkingCopyStatus(repo.git);
      assert.deepStrictEqual(status.files, []);
    }),
  );

  it.effect("prunes to 10 backups and touches only prefixed stashes", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");

      // One stash the user made themselves; it must survive every prune.
      yield* writeFile(repo.cwd, "a.ts", "user work\n");
      yield* git(repo.cwd, ["stash", "push", "-m", "my own work"]);

      for (let round = 0; round < 12; round += 1) {
        yield* writeFile(repo.cwd, "a.ts", `dirty ${round}\n`);
        yield* discardPaths(repo.git, { paths: ["a.ts"], label: `round ${round}` });
      }

      const backups = yield* listDiscardBackups(repo.git);
      assert.strictEqual(backups.length, 10);
      // The newest survive; the oldest two rounds were pruned.
      assert.deepStrictEqual(
        backups.map((entry) => entry.label.replace(/ \[t3-operation:[^\]]+\]$/, "")),
        Array.from({ length: 10 }, (_, i) => `t3-backup: round ${11 - i}`),
      );

      const all = yield* readStashList(repo.git);
      const mine = all.filter((entry) => !entry.isDiscardBackup);
      assert.deepStrictEqual(
        mine.map((entry) => entry.label),
        ["my own work"],
      );
    }),
  );

  it.effect("listDiscardBackups excludes the user's own stashes", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "a.ts", "user work\n");
      yield* git(repo.cwd, ["stash", "push", "-m", "mine"]);
      yield* writeFile(repo.cwd, "a.ts", "dirty\n");
      yield* discardPaths(repo.git, { paths: ["a.ts"] });

      const backups = yield* listDiscardBackups(repo.git);

      assert.strictEqual(backups.length, 1);
      assert.isTrue(backups[0]?.isDiscardBackup);
    }),
  );
});
