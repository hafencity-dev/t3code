// @effect-diagnostics nodeBuiltinImport:off - the transaction publishes through node:fs
/** fork: Effect boundary for the proven, native-files-backend transaction. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { WorkingCopyStashIdentityError } from "@t3tools/contracts";
import type { WorkingCopyGit } from "./WorkingCopyGit.ts";
import {
  acquireFilesStashTransaction,
  pendingStashRecovery,
  readFilesStashLog,
  requireStashIdentity,
  type StashIdentityInput,
  type StashPublishFs,
} from "./StashIdentityFiles.ts";

/** Publication primitives for the transaction; tests substitute failing ones. */
export class StashPublish extends Context.Reference<StashPublishFs>("t3/workingCopy/StashPublish", {
  defaultValue: (): StashPublishFs => NodeFSP,
}) {}

export function stashIdentityError(operation: string, cause: unknown, applied = false) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new WorkingCopyStashIdentityError({
    operation,
    applied,
    detail: applied
      ? `Changes were applied, but the stash could not be removed. Do not apply it again. ${detail}`
      : detail,
  });
}

export const stashFilesStorage = Effect.fn("workingCopy.stashFilesStorage")(function* (
  git: WorkingCopyGit,
) {
  const operation = "workingCopy.stashIdentity";
  const format = yield* git.run({ operation, args: ["config", "--get", "extensions.refStorage"] });
  if (
    (format.exitCode !== 0 && format.exitCode !== 1) ||
    (format.stdout.trim() !== "" && format.stdout.trim() !== "files")
  ) {
    return yield* stashIdentityError(
      operation,
      "Safe stash operations are unsupported for this Git reference backend. No changes made.",
    );
  }
  const layout = yield* git.ok({
    operation,
    args: ["rev-parse", "--show-object-format", "--git-common-dir"],
  });
  const [objectFormat = "", commonDirOutput = ""] = layout.stdout.split("\n");
  const oidLength = objectFormat.trim() === "sha1" ? 40 : objectFormat.trim() === "sha256" ? 64 : 0;
  if (oidLength === 0)
    return yield* stashIdentityError(operation, "Unsupported Git object format. No changes made.");
  const commonDir = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(NodePath.resolve(git.cwd, commonDirOutput.trim())),
    catch: (cause) => stashIdentityError(operation, cause),
  });
  return { commonDir, oidLength };
});

export const readIdentityStashLog = Effect.fn("workingCopy.readIdentityStashLog")(function* (
  git: WorkingCopyGit,
) {
  const storage = yield* stashFilesStorage(git);
  return yield* Effect.tryPromise({
    try: async () => ({
      entries: await readFilesStashLog(storage.commonDir, storage.oidLength),
      recoveryJournalPath: await pendingStashRecovery(storage.commonDir),
    }),
    catch: (cause) => stashIdentityError("workingCopy.stashList", cause),
  });
});

/** Lock lifetime includes apply and cleanup; interruption always releases locks. */
export const withStashIdentity = Effect.fn("workingCopy.withStashIdentity")(function* (
  git: WorkingCopyGit,
  input: StashIdentityInput,
  operation: string,
  apply: boolean,
  drop: boolean,
  requireBackup = false,
) {
  yield* Effect.try({
    try: () => requireStashIdentity(input),
    catch: (cause) => stashIdentityError(operation, cause),
  });
  const storage = yield* stashFilesStorage(git);
  const publish = yield* StashPublish;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const transaction = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            acquireFilesStashTransaction(storage.commonDir, storage.oidLength, input, publish),
          catch: (cause) => stashIdentityError(operation, cause),
        }),
        (tx) => Effect.promise(() => tx.release()),
      );
      if (
        requireBackup &&
        !/^(?:(?:On|WIP on) [^:]+: )?t3-backup:/.test(transaction.entry.subject)
      ) {
        return yield* stashIdentityError(
          operation,
          "This stash is not a discard backup. No changes made.",
        );
      }
      if (apply) {
        yield* git.ok({
          operation,
          args: ["stash", "apply", input.expectedCommit],
          mutating: true,
        });
      }
      if (drop) {
        // No interruption between starting publication and knowing its outcome.
        yield* Effect.tryPromise({
          try: () => transaction.drop(),
          catch: (cause) => stashIdentityError(operation, cause, apply),
        }).pipe(Effect.uninterruptible);
      }
    }),
  );
});
