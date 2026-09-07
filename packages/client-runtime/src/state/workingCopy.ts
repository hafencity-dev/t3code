/**
 * Atom families and commands for the source-control panel's `workingCopy.*`
 * RPCs.
 *
 * Every method is unary (there is no `subscribeWorkingCopy` — see
 * `build-log-f4-server.md` deviation 1), so this file holds no stream wiring and
 * `rpc/client.ts` needs no tag-union edit.
 *
 * Two shapes on purpose:
 *
 *  - **Reactive query atoms** for the things the panel keeps on screen
 *    (status, stashes, backups, the amend prefill). Those are refreshed by
 *    `invalidateWorkingCopy` after every mutation.
 *  - **Imperative reads** (`log`, `commitDetail`, `diff`, …) executed through
 *    `useAtomQueryRunner`, because their results are folded into client-owned
 *    paging/merge state rather than rendered straight from the atom.
 *
 * fork: f4 source-control panel
 */
import { type EnvironmentId, type VcsInvalidationDomain, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentCommand,
  createEnvironmentRpcQueryAtomFamily,
  type AtomCommandConcurrency,
} from "./runtime.ts";
import {
  ALL_REPOSITORY_DOMAINS,
  invalidateRepository,
  repositoryObservationAtom,
  serverPushesRevisions,
  workingCopyRefreshTrigger,
  type RepositoryCapabilityLookup,
} from "./repositoryInvalidation.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request, type EnvironmentRpcInput, type EnvironmentUnaryRpcTag } from "../rpc/client.ts";

export {
  bumpWorkingCopyRevision,
  workingCopyRevisionAtom,
  type WorkingCopyTarget,
} from "./repositoryInvalidation.ts";

/**
 * One mutation at a time per repository, mirroring the server's per-cwd
 * semaphore. Two repos stay independent, so a slow `stash push` in one project
 * cannot block staging in another.
 */
export const workingCopyCommandScheduler = createAtomCommandScheduler();

/**
 * fork: f4 AI commit message — a SEPARATE lane from the mutation scheduler.
 *
 * Generation is a read that can take tens of seconds. Putting it on
 * `workingCopyCommandScheduler` would make a staging press queue behind a model
 * call in the same repository, which is exactly the freeze the server-side
 * semaphore split avoids.
 */
export const workingCopyGenerationScheduler = createAtomCommandScheduler();

export const workingCopyCommandConcurrency: AtomCommandConcurrency<{
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string };
}> = {
  mode: "serial",
  key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
};

export function createWorkingCopyEnvironmentAtoms<R, E>(
  // `EnvironmentCacheStore` is required by `invalidateCachedVcsRefs` (Gap B);
  // the same runtime already backs `createVcsEnvironmentAtoms`.
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
  options: { readonly capabilities?: RepositoryCapabilityLookup } = {},
) {
  // Status is deliberately short-lived in cache but never auto-refreshed: the
  // panel drives every re-read (push, post-mutation, visible-only poll). A
  // `refreshIntervalMs` here would repaint while the panel is hidden.
  const status = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:status",
    tag: WS_METHODS.workingCopyStatus,
    staleTimeMs: 1_000,
    idleTtlMs: 60_000,
    refreshTrigger: workingCopyRefreshTrigger,
  });
  const stashList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:stash-list",
    tag: WS_METHODS.workingCopyStashList,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshTrigger: workingCopyRefreshTrigger,
  });
  const discardBackups = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:discard-backups",
    tag: WS_METHODS.workingCopyListDiscardBackups,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshTrigger: workingCopyRefreshTrigger,
  });
  const lastCommitMessage = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:last-commit-message",
    tag: WS_METHODS.workingCopyLastCommitMessage,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshTrigger: workingCopyRefreshTrigger,
  });
  const log = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:log",
    tag: WS_METHODS.workingCopyLog,
    staleTimeMs: 1_000,
    idleTtlMs: 60_000,
    refreshTrigger: workingCopyRefreshTrigger,
  });
  const commitDetail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:commit-detail",
    tag: WS_METHODS.workingCopyCommitDetail,
    // A commit is immutable, so its detail can be cached for the session.
    staleTimeMs: 5 * 60_000,
    idleTtlMs: 5 * 60_000,
  });
  const diff = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:diff",
    tag: WS_METHODS.workingCopyDiff,
    staleTimeMs: 1_000,
    idleTtlMs: 60_000,
    refreshTrigger: workingCopyRefreshTrigger,
  });
  const commitFileDiff = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:commit-file-diff",
    tag: WS_METHODS.workingCopyCommitFileDiff,
    staleTimeMs: 5 * 60_000,
    idleTtlMs: 5 * 60_000,
  });
  const fileAtRef = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:file-at-ref",
    tag: WS_METHODS.workingCopyFileAtRef,
    staleTimeMs: 1_000,
    idleTtlMs: 60_000,
    refreshTrigger: workingCopyRefreshTrigger,
  });

  const refresh = createEnvironmentCommand(runtime, {
    label: "environment-data:working-copy:refresh",
    execute: (
      input: { readonly cwd: string; readonly domains?: ReadonlyArray<VcsInvalidationDomain> },
      registry,
      environmentId,
    ) => invalidateRepository(registry, { environmentId, cwd: input.cwd }, input.domains),
  });

  // Every `workingCopy.*` input carries `cwd` (the containment guard requires
  // it), but that is a fact about the 28 tags rather than something the generic
  // parameter can prove, so the scheduler key and the invalidation target read
  // it through one narrow local assertion instead of widening the helper.
  const cwdOf = (input: unknown): string => (input as { readonly cwd: string }).cwd;

  /**
   * fork: f4 invalidation Gap B — the mutations that MOVE OR CREATE A REF also
   * invalidate the cached ref list, exactly like every upstream `vcs.*` command
   * does (`vcs.ts` passes `invalidateRefs` on all of them).
   *
   * Without it, a tag created from the History context menu, a commit, an amend
   * or a checkout landed on disk but the branch/tag pickers elsewhere in the
   * app kept showing the pre-mutation list until something else happened to
   * refresh it.
   */
  const mutation = <TTag extends EnvironmentUnaryRpcTag>(
    label: string,
    tag: TTag,
    mutationOptions?: { readonly movesRefs?: boolean },
  ) =>
    createEnvironmentCommand(runtime, {
      label,
      scheduler: workingCopyCommandScheduler,
      concurrency: {
        mode: "serial",
        key: ({
          environmentId,
          input,
        }: {
          readonly environmentId: EnvironmentId;
          readonly input: EnvironmentRpcInput<TTag>;
        }) => JSON.stringify([environmentId, cwdOf(input)]),
      },
      execute: (input: EnvironmentRpcInput<TTag>, registry, environmentId) =>
        Effect.gen(function* () {
          const scope = { environmentId, cwd: cwdOf(input) };
          const observedBefore = registry.get(repositoryObservationAtom(scope));
          return yield* request(tag, input).pipe(
            Effect.ensuring(
              Effect.suspend(() => {
                // A revision-aware server pushes for every settled mutation, so
                // the client never re-reads on its own. The fallback stays for
                // old servers, unless one of their frames already carried a
                // revision for this exact target while the RPC was in flight.
                if (serverPushesRevisions(options.capabilities, registry, environmentId)) {
                  return Effect.void;
                }
                const observedAfter = registry.get(repositoryObservationAtom(scope));
                if (observedAfter !== observedBefore && observedAfter?.token !== undefined) {
                  return Effect.void;
                }
                return invalidateRepository(
                  registry,
                  scope,
                  mutationOptions?.movesRefs ? ALL_REPOSITORY_DOMAINS : ["worktree", "stashes"],
                );
              }),
            ),
          );
        }),
    });

  /**
   * fork: f4 AI commit message. Not a `mutation`: nothing in the repository
   * changes, so there is nothing to invalidate and no status refresh to push.
   * `singleFlight` keyed by env:cwd:amend means a second press while one is in
   * flight joins the first rather than paying for a second model call.
   */
  const generateCommitMessage = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:working-copy:generate-commit-message",
    tag: WS_METHODS.workingCopyGenerateCommitMessage,
    scheduler: workingCopyGenerationScheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) =>
        JSON.stringify([environmentId, input.cwd, input.amend === true]),
    },
  });

  return {
    refresh,
    status,
    stashList,
    discardBackups,
    lastCommitMessage,
    log,
    commitDetail,
    diff,
    commitFileDiff,
    fileAtRef,
    generateCommitMessage,

    stagePaths: mutation(
      "environment-data:working-copy:stage-paths",
      WS_METHODS.workingCopyStagePaths,
    ),
    unstagePaths: mutation(
      "environment-data:working-copy:unstage-paths",
      WS_METHODS.workingCopyUnstagePaths,
    ),
    applyPatch: mutation(
      "environment-data:working-copy:apply-patch",
      WS_METHODS.workingCopyApplyPatch,
    ),
    discardPaths: mutation(
      "environment-data:working-copy:discard-paths",
      WS_METHODS.workingCopyDiscardPaths,
    ),
    restoreDiscardBackup: mutation(
      "environment-data:working-copy:restore-discard-backup",
      WS_METHODS.workingCopyRestoreDiscardBackup,
    ),
    // fork: f4 Gap B — every mutation below moves or creates a ref.
    commitStaged: mutation(
      "environment-data:working-copy:commit-staged",
      WS_METHODS.workingCopyCommitStaged,
      { movesRefs: true },
    ),
    amendCommit: mutation(
      "environment-data:working-copy:amend-commit",
      WS_METHODS.workingCopyAmendCommit,
      { movesRefs: true },
    ),
    undoLastCommit: mutation(
      "environment-data:working-copy:undo-last-commit",
      WS_METHODS.workingCopyUndoLastCommit,
      { movesRefs: true },
    ),
    stashPush: mutation(
      "environment-data:working-copy:stash-push",
      WS_METHODS.workingCopyStashPush,
    ),
    stashApply: mutation(
      "environment-data:working-copy:stash-apply",
      WS_METHODS.workingCopyStashApply,
    ),
    stashPop: mutation("environment-data:working-copy:stash-pop", WS_METHODS.workingCopyStashPop),
    stashDrop: mutation(
      "environment-data:working-copy:stash-drop",
      WS_METHODS.workingCopyStashDrop,
    ),
    resolveConflict: mutation(
      "environment-data:working-copy:resolve-conflict",
      WS_METHODS.workingCopyResolveConflict,
    ),
    abortOperation: mutation(
      "environment-data:working-copy:abort-operation",
      WS_METHODS.workingCopyAbortOperation,
    ),
    cherryPick: mutation(
      "environment-data:working-copy:cherry-pick",
      WS_METHODS.workingCopyCherryPick,
      { movesRefs: true },
    ),
    revertCommit: mutation(
      "environment-data:working-copy:revert-commit",
      WS_METHODS.workingCopyRevertCommit,
      { movesRefs: true },
    ),
    checkoutCommit: mutation(
      "environment-data:working-copy:checkout-commit",
      WS_METHODS.workingCopyCheckoutCommit,
      { movesRefs: true },
    ),
    resetToCommit: mutation(
      "environment-data:working-copy:reset-to-commit",
      WS_METHODS.workingCopyResetToCommit,
      { movesRefs: true },
    ),
    tagCommit: mutation(
      "environment-data:working-copy:tag-commit",
      WS_METHODS.workingCopyTagCommit,
      { movesRefs: true },
    ),
  };
}

export type WorkingCopyEnvironmentAtoms = ReturnType<typeof createWorkingCopyEnvironmentAtoms>;
