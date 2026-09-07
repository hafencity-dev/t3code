import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as PartitionedSemaphore from "effect/PartitionedSemaphore";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  GitManagerServiceError,
  VcsInvalidationDomain,
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { mergeGitStatusParts } from "@t3tools/shared/git";
import { resolveProjectAutoPull } from "@t3tools/shared/serverSettings";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  resolveRepositoryInvalidationScope,
  type RepositoryInvalidationScope,
} from "./repositoryInvalidationScope.ts";

const DEFAULT_VCS_STATUS_REFRESH_INTERVAL = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_BASE_DELAY = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_MAX_DELAY = Duration.minutes(15);
const MAX_FAILURE_DIAGNOSTIC_VALUES = 8;
const MAX_FAILURE_DIAGNOSTIC_VALUE_LENGTH = 128;

function boundedDiagnosticValue(value: string): string {
  return value.slice(0, MAX_FAILURE_DIAGNOSTIC_VALUE_LENGTH);
}

function diagnosticValueTag(value: unknown): string {
  try {
    if (
      typeof value === "object" &&
      value !== null &&
      "_tag" in value &&
      typeof value._tag === "string"
    ) {
      return boundedDiagnosticValue(value._tag);
    }
    if (value instanceof Error) {
      return boundedDiagnosticValue(value.name);
    }
    return typeof value;
  } catch {
    return "Uninspectable";
  }
}

function diagnosticFailureOperation(value: unknown): string | undefined {
  try {
    if (
      typeof value === "object" &&
      value !== null &&
      "operation" in value &&
      typeof value.operation === "string"
    ) {
      return boundedDiagnosticValue(value.operation);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function addUniqueDiagnosticValue(values: Array<string>, value: string | undefined): void {
  if (
    value !== undefined &&
    values.length < MAX_FAILURE_DIAGNOSTIC_VALUES &&
    !values.includes(value)
  ) {
    values.push(value);
  }
}

export function remoteRefreshFailureDiagnostics(cause: Cause.Cause<unknown>) {
  const failureTags: Array<string> = [];
  const failureOperations: Array<string> = [];
  const defectTags: Array<string> = [];
  let failureCount = 0;
  let defectCount = 0;
  let interruptionCount = 0;

  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      failureCount += 1;
      addUniqueDiagnosticValue(failureTags, diagnosticValueTag(reason.error));
      addUniqueDiagnosticValue(failureOperations, diagnosticFailureOperation(reason.error));
      continue;
    }
    if (Cause.isDieReason(reason)) {
      defectCount += 1;
      addUniqueDiagnosticValue(defectTags, diagnosticValueTag(reason.defect));
      continue;
    }
    interruptionCount += 1;
  }

  return {
    reasonCount: cause.reasons.length,
    failureCount,
    failureTags,
    failureOperations,
    defectCount,
    defectTags,
    interruptionCount,
  };
}

interface VcsStatusChange {
  readonly cwd: string;
  readonly event: VcsStatusStreamEvent;
}

interface CachedValue<T> {
  readonly fingerprint: string;
  readonly value: T;
}

interface CachedVcsStatus {
  readonly local: CachedValue<VcsStatusLocalResult> | null;
  readonly remote: CachedValue<VcsStatusRemoteResult | null> | null;
}

interface ActiveRemotePoller {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly subscriberCount: number;
  readonly demandCwds: Ref.Ref<ReadonlyMap<string, number>>;
  readonly refreshRequests: Queue.Queue<void>;
}

interface StreamStatusOptions {
  readonly automaticRemoteRefreshInterval?: Effect.Effect<Duration.Duration, never>;
}

export class VcsAutoPullPolicy extends Context.Reference<{
  readonly isEnabled: (cwd: string) => Effect.Effect<boolean, never>;
}>("t3/vcs/VcsAutoPullPolicy", {
  defaultValue: () => ({ isEnabled: () => Effect.succeed(false) }),
}) {}

export const autoPullPolicyLayer = Layer.effect(
  VcsAutoPullPolicy,
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    return {
      isEnabled: Effect.fn("VcsAutoPullPolicy.isEnabled")(
        function* (cwd: string) {
          const project = yield* snapshots.getActiveProjectByWorkspaceRoot(cwd);
          if (project._tag === "None") return false;
          const settings = yield* serverSettings.getSettings;
          return resolveProjectAutoPull(settings, project.value.id, project.value.autoPull);
        },
        Effect.orElseSucceed(() => false),
      ),
    };
  }),
);

export function remoteRefreshFailureDelay(
  consecutiveFailures: number,
  configuredInterval: Duration.Duration,
) {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const backoffMs =
    Duration.toMillis(VCS_STATUS_REFRESH_FAILURE_BASE_DELAY) * Math.pow(2, exponent);
  const cappedBackoff = Duration.min(
    Duration.millis(backoffMs),
    VCS_STATUS_REFRESH_FAILURE_MAX_DELAY,
  );
  return Duration.max(configuredInterval, cappedBackoff);
}

export class VcsStatusBroadcaster extends Context.Service<
  VcsStatusBroadcaster,
  {
    readonly getStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly refreshLocalStatus: (
      cwd: string,
      mutationDomains?: ReadonlyArray<VcsInvalidationDomain>,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly notifyMutation: (
      cwd: string,
      domains?: ReadonlyArray<VcsInvalidationDomain>,
    ) => Effect.Effect<void>;
    readonly refreshStatus: (cwd: string) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    /**
     * Refresh a loaded cwd after a turn if background policy allows it.
     * GitManager retries missing PRs for the current branch and keeps known
     * PRs and failed lookup backoff cached. This does not fetch Git remotes.
     */
    readonly refreshPullRequestStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly streamStatus: (
      input: VcsStatusInput,
      options?: StreamStatusOptions,
    ) => Stream.Stream<VcsStatusStreamEvent, GitManagerServiceError>;
  }
>()("t3/vcs/VcsStatusBroadcaster") {}

function fingerprintStatusPart(status: unknown): string {
  return JSON.stringify(status);
}

// fork: project session grid — remote PR/ahead state is only valid for the
// local repository/ref identity that produced it. Working-tree-only changes
// deliberately do not invalidate the slower remote half.
function remoteStatusScopeFingerprint(local: VcsStatusLocalResult | null): string {
  return fingerprintStatusPart(
    local === null
      ? null
      : {
          isRepo: local.isRepo,
          hasPrimaryRemote: local.hasPrimaryRemote,
          isDefaultRef: local.isDefaultRef,
          refName: local.refName,
          sourceControlProvider: local.sourceControlProvider ?? null,
        },
  );
}

const normalizeCwd = (cwd: string) =>
  resolveRepositoryInvalidationScope(cwd).pipe(Effect.map((scope) => scope.root));
const ALL_REPOSITORY_DOMAINS = ["worktree", "refs", "stashes"] as const;

export const make = Effect.gen(function* () {
  const autoPullPolicy = yield* VcsAutoPullPolicy;
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const fs = yield* FileSystem.FileSystem;
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<VcsStatusChange>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const cacheRef = yield* Ref.make(new Map<string, CachedVcsStatus>());
  // fork: revisions are independent of the aggregate status fingerprint.
  const epoch = NodeCrypto.randomUUID();
  const counters = new Map<string, number>();
  const revision = (cwd: string) => ({ epoch, counter: counters.get(cwd) ?? 0 });
  const advanceRevision = (cwd: string) => {
    counters.set(cwd, (counters.get(cwd) ?? 0) + 1);
    return revision(cwd);
  };
  // One permit per cwd for remote reads that write the cache. Without it a
  // periodic poll that started before `gh pr create` can finish after the
  // turn-end refresh and overwrite the fresh PR with its stale `pr: null`.
  const remoteWriteLocks = new Map<string, Semaphore.Semaphore>();
  const withRemoteWriteLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) => {
    let lock = remoteWriteLocks.get(cwd);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      remoteWriteLocks.set(cwd, lock);
    }
    return lock.withPermits(1)(effect);
  };
  const pollersRef = yield* SynchronizedRef.make(new Map<string, ActiveRemotePoller>());

  const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")(function* (
    cwd: string,
  ) {
    return yield* Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));
  });

  const updateCachedLocalStatus = Effect.fn("VcsStatusBroadcaster.updateCachedLocalStatus")(
    function* (
      cwd: string,
      local: VcsStatusLocalResult,
      options?: { publish?: boolean; mutationDomains?: ReadonlyArray<VcsInvalidationDomain> },
    ) {
      const nextLocal = {
        fingerprint: fingerprintStatusPart(local),
        value: local,
      } satisfies CachedValue<VcsStatusLocalResult>;
      const update = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        const remoteScopeUnchanged =
          remoteStatusScopeFingerprint(previous.local?.value ?? null) ===
          remoteStatusScopeFingerprint(local);
        const nextCache = new Map(cache);
        nextCache.set(cwd, {
          local: nextLocal,
          remote: remoteScopeUnchanged ? previous.remote : null,
        });
        return [
          {
            localChanged: previous.local?.fingerprint !== nextLocal.fingerprint,
            remoteScopeChanged: !remoteScopeUnchanged,
          },
          nextCache,
        ] as const;
      });

      if (options?.publish && (update.localChanged || options.mutationDomains !== undefined)) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: {
            _tag: "localUpdated",
            local,
            workingCopyRevision: advanceRevision(cwd),
            invalidatedDomains: options.mutationDomains ?? ALL_REPOSITORY_DOMAINS,
          },
        });
      }

      if (update.remoteScopeChanged) {
        const poller = (yield* SynchronizedRef.get(pollersRef)).get(cwd);
        if (poller) {
          // fork: project session grid — a branch/provider transition must
          // wake an already-retained zero-interval reconciliation poller.
          yield* Queue.offer(poller.refreshRequests, undefined);
        }
      }

      return local;
    },
  );

  const updateCachedRemoteStatus = Effect.fn("VcsStatusBroadcaster.updateCachedRemoteStatus")(
    function* (
      cwd: string,
      remote: VcsStatusRemoteResult | null,
      options?: { publish?: boolean; expectedLocalScopeFingerprint?: string },
    ) {
      const nextRemote = {
        fingerprint: fingerprintStatusPart(remote),
        value: remote,
      } satisfies CachedValue<VcsStatusRemoteResult | null>;
      const update = yield* Ref.modify(
        cacheRef,
        (
          cache,
        ): readonly [
          { readonly accepted: boolean; readonly shouldPublish: boolean },
          Map<string, CachedVcsStatus>,
        ] => {
          const previous = cache.get(cwd) ?? { local: null, remote: null };
          if (
            options?.expectedLocalScopeFingerprint !== undefined &&
            remoteStatusScopeFingerprint(previous.local?.value ?? null) !==
              options.expectedLocalScopeFingerprint
          ) {
            return [{ accepted: false, shouldPublish: false }, cache];
          }
          const nextCache = new Map(cache);
          nextCache.set(cwd, {
            ...previous,
            remote: nextRemote,
          });
          return [
            {
              accepted: true,
              shouldPublish: previous.remote?.fingerprint !== nextRemote.fingerprint,
            },
            nextCache,
          ];
        },
      );

      if (options?.publish && update.shouldPublish) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: {
            _tag: "remoteUpdated",
            remote,
          },
        });
      }

      return update.accepted;
    },
  );

  const updateCachedStatus = Effect.fn("VcsStatusBroadcaster.updateCachedStatus")(function* (
    cwd: string,
    readLocal: VcsStatusLocalResult,
    remote: VcsStatusRemoteResult | null,
    options?: { publish?: boolean; expectedCounter?: number },
  ) {
    // fork: a read that raced a mutation must not republish the older worktree
    // under a newer revision; the mutation's own frame already carries it.
    const raced =
      options?.expectedCounter !== undefined && revision(cwd).counter !== options.expectedCounter;
    const local = raced
      ? ((yield* Ref.get(cacheRef)).get(cwd)?.local?.value ?? readLocal)
      : readLocal;
    const nextLocal = {
      fingerprint: fingerprintStatusPart(local),
      value: local,
    } satisfies CachedValue<VcsStatusLocalResult>;
    const nextRemote = {
      fingerprint: fingerprintStatusPart(remote),
      value: remote,
    } satisfies CachedValue<VcsStatusRemoteResult | null>;
    const update = yield* Ref.modify(cacheRef, (cache) => {
      const previous = cache.get(cwd) ?? { local: null, remote: null };
      const nextCache = new Map(cache);
      nextCache.set(cwd, {
        local: nextLocal,
        remote: nextRemote,
      });
      return [
        {
          localChanged: previous.local?.fingerprint !== nextLocal.fingerprint,
          remoteChanged: previous.remote?.fingerprint !== nextRemote.fingerprint,
        },
        nextCache,
      ] as const;
    });

    if (options?.publish && (update.localChanged || update.remoteChanged)) {
      yield* PubSub.publish(changesPubSub, {
        cwd,
        event: update.localChanged
          ? {
              _tag: "snapshot",
              local,
              remote,
              workingCopyRevision: advanceRevision(cwd),
              invalidatedDomains: ALL_REPOSITORY_DOMAINS,
            }
          : { _tag: "remoteUpdated", remote },
      });
    }

    return mergeGitStatusParts(local, remote);
  });

  const loadLocalStatus = Effect.fn("VcsStatusBroadcaster.loadLocalStatus")(function* (
    cwd: string,
  ) {
    const local = yield* workflow.localStatus({ cwd });
    return yield* updateCachedLocalStatus(cwd, local);
  });

  const getOrLoadLocalStatus = Effect.fn("VcsStatusBroadcaster.getOrLoadLocalStatus")(function* (
    cwd: string,
  ) {
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local) {
      return cached.local.value;
    }
    return yield* loadLocalStatus(cwd);
  });

  // fork: the invalidation scope resolver also needs `Path`.
  const path = yield* Path.Path;
  const withFileSystem = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const getStatus: VcsStatusBroadcaster["Service"]["getStatus"] = Effect.fn(
    "VcsStatusBroadcaster.getStatus",
  )(function* (input) {
    const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local && cached.remote) {
      return mergeGitStatusParts(cached.local.value, cached.remote.value);
    }
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        const latest = yield* getCachedStatus(cwd);
        const [local, remote] = yield* Effect.all(
          [
            latest?.local ? Effect.succeed(latest.local.value) : workflow.localStatus({ cwd }),
            latest?.remote ? Effect.succeed(latest.remote.value) : workflow.remoteStatus({ cwd }),
          ],
          { concurrency: "unbounded" },
        );
        return yield* updateCachedStatus(cwd, local, remote);
      }),
    );
  });

  const localWriteLock = PartitionedSemaphore.makeUnsafe<string>({ permits: 1 });
  const refreshLocalStatusCore = Effect.fn("VcsStatusBroadcaster.refreshLocalStatusCore")(
    function* (cwd: string, mutationDomains?: ReadonlyArray<VcsInvalidationDomain>) {
      return yield* localWriteLock.withPermit(cwd)(
        Effect.gen(function* () {
          const local = yield* Effect.gen(function* () {
            yield* workflow.invalidateLocalStatus(cwd);
            return yield* workflow.localStatus({ cwd });
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                // A failed local read must not hide a completed partial mutation.
                const cached = yield* getCachedStatus(cwd);
                if (mutationDomains !== undefined && cached?.local) return cached.local.value;
                if (mutationDomains !== undefined) advanceRevision(cwd);
                return yield* Effect.fail(error);
              }),
            ),
          );
          return yield* updateCachedLocalStatus(cwd, local, {
            publish: true,
            ...(mutationDomains === undefined ? {} : { mutationDomains }),
          });
        }),
      );
    },
  );

  /**
   * Siblings sharing the git dir learn about refs/stashes without a worktree
   * read: their cached local status is republished under a new revision. A
   * subscribed sibling always has one loaded; one without is simply skipped.
   */
  const publishSharedInvalidation = Effect.fn("VcsStatusBroadcaster.publishSharedInvalidation")(
    function* (
      cwd: string,
      domains: ReadonlyArray<VcsInvalidationDomain>,
      origin: { readonly cwd: string; readonly counter: number },
    ) {
      yield* localWriteLock.withPermit(cwd)(
        Effect.gen(function* () {
          const cached = (yield* Ref.get(cacheRef)).get(cwd)?.local ?? null;
          if (cached === null) return;
          yield* PubSub.publish(changesPubSub, {
            cwd,
            event: {
              _tag: "localUpdated",
              local: cached.value,
              workingCopyRevision: advanceRevision(cwd),
              invalidatedDomains: domains,
              invalidationOrigin: origin,
            },
          });
        }),
      );
    },
  );

  const notifyMutation: VcsStatusBroadcaster["Service"]["notifyMutation"] = Effect.fn(
    "VcsStatusBroadcaster.notifyMutation",
  )(function* (rawCwd, domains = ALL_REPOSITORY_DOMAINS) {
    const source = yield* withFileSystem(resolveRepositoryInvalidationScope(rawCwd));
    yield* refreshLocalStatusCore(source.root, domains).pipe(Effect.ignoreCause({ log: true }));
    const sharedDomains = domains.filter((domain) => domain !== "worktree");
    if (sharedDomains.length === 0 || source.commonDir === null) return;
    // Only existing authorized subscriptions receive sibling notifications.
    const siblings: Array<string> = [];
    for (const cwd of (yield* SynchronizedRef.get(pollersRef)).keys()) {
      if (cwd === source.root) continue;
      const sibling: RepositoryInvalidationScope = yield* withFileSystem(
        resolveRepositoryInvalidationScope(cwd),
      );
      if (sibling.commonDir === source.commonDir) siblings.push(cwd);
    }
    const origin = { cwd: source.root, counter: revision(source.root).counter };
    yield* Effect.forEach(
      siblings,
      (cwd) => publishSharedInvalidation(cwd, sharedDomains, origin),
      { concurrency: "unbounded", discard: true },
    );
  });

  const refreshLocalStatus: VcsStatusBroadcaster["Service"]["refreshLocalStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshLocalStatus",
  )(function* (rawCwd, mutationDomains) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    if (mutationDomains !== undefined) {
      yield* notifyMutation(rawCwd, mutationDomains);
      return yield* getOrLoadLocalStatus(cwd);
    }
    return yield* refreshLocalStatusCore(cwd);
  });

  const maybeAutoPull = Effect.fn("VcsStatusBroadcaster.maybeAutoPull")(function* (
    cwd: string,
    remote: VcsStatusRemoteResult | null,
    policyCwds: ReadonlyArray<string>,
  ) {
    return yield* Effect.gen(function* () {
      const autoPullEnabled = (yield* Effect.forEach(policyCwds, autoPullPolicy.isEnabled, {
        concurrency: "unbounded",
      })).some(Boolean);
      if (
        remote === null ||
        !remote.hasUpstream ||
        remote.aheadCount > 0 ||
        remote.behindCount <= 0 ||
        !autoPullEnabled
      ) {
        return null;
      }

      yield* workflow.invalidateLocalStatus(cwd);
      const local = yield* workflow.localStatus({ cwd });
      if (!local.isRepo || !local.isDefaultRef || local.hasWorkingTreeChanges) return null;

      yield* workflow.pullCurrentBranch(cwd).pipe(Effect.ensuring(notifyMutation(cwd)));
      yield* workflow.invalidateStatus(cwd);
      const expectedCounter = revision(cwd).counter;
      const [refreshedLocal, refreshedRemote] = yield* Effect.all(
        [workflow.localStatus({ cwd }), workflow.remoteStatus({ cwd }, { refreshUpstream: false })],
        { concurrency: "unbounded" },
      );
      yield* updateCachedStatus(cwd, refreshedLocal, refreshedRemote, {
        publish: true,
        expectedCounter,
      });
      return { local: refreshedLocal, remote: refreshedRemote };
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning("Automatic project pull failed", { cwd }).pipe(Effect.as(null)),
      ),
    );
  });

  const refreshRemoteStatus = Effect.fn("VcsStatusBroadcaster.refreshRemoteStatus")(function* (
    cwd: string,
    options?: {
      readonly refreshUpstream?: boolean;
      readonly policyCwds?: ReadonlyArray<string>;
    },
  ) {
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        const expectedLocalScopeFingerprint = remoteStatusScopeFingerprint(
          (yield* getCachedStatus(cwd))?.local?.value ?? null,
        );
        if (options?.refreshUpstream !== false) {
          yield* workflow.invalidateRemoteStatus(cwd);
        }
        const remote = yield* workflow.remoteStatus({ cwd }, options);
        const pulled = yield* maybeAutoPull(cwd, remote, options?.policyCwds ?? [cwd]);
        if (pulled !== null) return pulled.remote;
        return yield* updateCachedRemoteStatus(cwd, remote, {
          publish: true,
          expectedLocalScopeFingerprint,
        });
      }),
    );
  });

  const refreshStatus: VcsStatusBroadcaster["Service"]["refreshStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshStatus",
  )(function* (rawCwd) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    // invalidateStatus (not the two partial invalidations) so an explicit
    // refresh also bypasses GitManager's slow PR-lookup cache.
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        yield* workflow.invalidateStatus(cwd);
        const expectedCounter = revision(cwd).counter;
        const [local, remote] = yield* Effect.all(
          [workflow.localStatus({ cwd }), workflow.remoteStatus({ cwd })],
          { concurrency: "unbounded" },
        );
        const pulled = yield* maybeAutoPull(cwd, remote, [rawCwd]);
        if (pulled !== null) return mergeGitStatusParts(pulled.local, pulled.remote);
        return yield* updateCachedStatus(cwd, local, remote, { publish: true, expectedCounter });
      }),
    );
  });

  const refreshPullRequestStatus: VcsStatusBroadcaster["Service"]["refreshPullRequestStatus"] =
    Effect.fn("VcsStatusBroadcaster.refreshPullRequestStatus")(function* (rawCwd) {
      const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
      return yield* withRemoteWriteLock(
        cwd,
        Effect.gen(function* () {
          const cached = yield* getCachedStatus(cwd);
          if (cached === null) return null;
          const poller = (yield* SynchronizedRef.get(pollersRef)).get(cwd);
          const demandCwds = poller ? [...(yield* Ref.get(poller.demandCwds)).keys()] : [rawCwd];
          const shouldRefresh = (yield* Effect.forEach(
            demandCwds,
            (demandCwd) =>
              backgroundPolicy.shouldRunScopeWork({ type: "vcs-status", cwd: demandCwd }),
            { concurrency: "unbounded" },
          )).some(Boolean);
          if (!shouldRefresh) return null;
          // Resolve the checked-out branch again. A cached PR can belong to
          // the previous branch after an agent checks out another branch.
          const remote = yield* workflow.remoteStatus(
            { cwd },
            { refreshUpstream: false, refreshMissingPullRequest: true },
          );
          const accepted = yield* updateCachedRemoteStatus(cwd, remote, { publish: true });
          return accepted ? remote : null;
        }),
      );
    });

  const makeRemoteRefreshLoop = (
    cwd: string,
    demandCwdsRef: Ref.Ref<ReadonlyMap<string, number>>,
    refreshRequests: Queue.Queue<void>,
    automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
  ) =>
    Effect.gen(function* () {
      const consecutiveFailuresRef = yield* Ref.make(0);
      const nextDelayRef = yield* Ref.make<Duration.Duration | null>(null);
      const refreshRequiredRef = yield* Ref.make(false);

      return yield* Effect.forever(
        Effect.gen(function* () {
          const configuredInterval = yield* automaticRemoteRefreshInterval;
          const activeInterval = Duration.isZero(configuredInterval)
            ? DEFAULT_VCS_STATUS_REFRESH_INTERVAL
            : configuredInterval;
          const nextDelay = (yield* Ref.get(nextDelayRef)) ?? activeInterval;
          const refreshRequested = yield* Effect.raceFirst(
            Effect.sleep(nextDelay).pipe(Effect.as(false)),
            Queue.take(refreshRequests).pipe(Effect.as(true)),
          );
          const refreshRequired = refreshRequested || (yield* Ref.get(refreshRequiredRef));

          if (Duration.isZero(configuredInterval) && !refreshRequired) {
            yield* Ref.set(nextDelayRef, activeInterval);
            return;
          }

          const demandCwds = yield* Ref.get(demandCwdsRef);
          const shouldRun =
            refreshRequired ||
            (yield* Effect.all(
              [...demandCwds.keys()].map((demandCwd) =>
                backgroundPolicy.shouldRunScopeWork({
                  type: "vcs-status",
                  cwd: demandCwd,
                }),
              ),
              { concurrency: "unbounded" },
            )).some(Boolean);
          if (!shouldRun) {
            yield* Ref.set(nextDelayRef, activeInterval);
            return;
          }

          const exit = yield* refreshRemoteStatus(cwd, {
            refreshUpstream: !Duration.isZero(configuredInterval),
            policyCwds: [...demandCwds.keys()],
          }).pipe(Effect.exit);
          if (Exit.isSuccess(exit)) {
            yield* Ref.set(nextDelayRef, activeInterval);
            if (exit.value) {
              yield* Ref.set(refreshRequiredRef, false);
              yield* Ref.set(consecutiveFailuresRef, 0);
            } else {
              // The local scope moved while the remote request was in flight.
              // Keep the request hot so zero-interval subscribers cannot stall.
              yield* Ref.set(refreshRequiredRef, true);
              yield* Queue.offer(refreshRequests, undefined);
            }
            return;
          }

          const interruptionReasons = exit.cause.reasons.filter(Cause.isInterruptReason);
          if (interruptionReasons.length > 0) {
            return yield* Effect.failCause(Cause.fromReasons<never>(interruptionReasons));
          }

          const consecutiveFailures = yield* Ref.updateAndGet(
            consecutiveFailuresRef,
            (count) => count + 1,
          );
          const failureDelay = remoteRefreshFailureDelay(consecutiveFailures, activeInterval);
          yield* Ref.set(refreshRequiredRef, refreshRequired);
          yield* Ref.set(nextDelayRef, failureDelay);
          yield* Effect.logWarning("VCS remote status refresh failed", {
            cwdLength: cwd.length,
            ...remoteRefreshFailureDiagnostics(exit.cause),
            consecutiveFailures,
            nextDelayMs: Duration.toMillis(failureDelay),
          });
        }),
      );
    });

  const retainRemotePoller = Effect.fn("VcsStatusBroadcaster.retainRemotePoller")(function* (
    cwd: string,
    demandCwd: string,
    automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    refreshImmediately: boolean,
  ) {
    yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
      const existing = activePollers.get(cwd);
      if (existing) {
        return Effect.gen(function* () {
          yield* Ref.update(existing.demandCwds, (demandCwds) => {
            const next = new Map(demandCwds);
            next.set(demandCwd, (next.get(demandCwd) ?? 0) + 1);
            return next;
          });
          if (refreshImmediately) {
            yield* Queue.offer(existing.refreshRequests, undefined);
          }
          const nextPollers = new Map(activePollers);
          nextPollers.set(cwd, {
            ...existing,
            subscriberCount: existing.subscriberCount + 1,
          });
          return [undefined, nextPollers] as const;
        });
      }

      return Effect.gen(function* () {
        const demandCwds = yield* Ref.make<ReadonlyMap<string, number>>(new Map([[demandCwd, 1]]));
        const refreshRequests = yield* Queue.sliding<void>(1);
        if (refreshImmediately) {
          yield* Queue.offer(refreshRequests, undefined);
        }
        const fiber = yield* makeRemoteRefreshLoop(
          cwd,
          demandCwds,
          refreshRequests,
          automaticRemoteRefreshInterval,
        ).pipe(Effect.forkIn(broadcasterScope));
        const nextPollers = new Map(activePollers);
        nextPollers.set(cwd, {
          fiber,
          subscriberCount: 1,
          demandCwds,
          refreshRequests,
        });
        return [undefined, nextPollers] as const;
      });
    });
  });

  const releaseRemotePoller = Effect.fn("VcsStatusBroadcaster.releaseRemotePoller")(function* (
    cwd: string,
    demandCwd: string,
  ) {
    const pollerToInterrupt = yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
      const existing = activePollers.get(cwd);
      if (!existing) {
        return Effect.succeed([null, activePollers] as const);
      }

      if (existing.subscriberCount > 1) {
        return Ref.update(existing.demandCwds, (demandCwds) => {
          const nextDemandCwds = new Map(demandCwds);
          const count = nextDemandCwds.get(demandCwd) ?? 0;
          if (count <= 1) {
            nextDemandCwds.delete(demandCwd);
          } else {
            nextDemandCwds.set(demandCwd, count - 1);
          }
          return nextDemandCwds;
        }).pipe(
          Effect.as([
            null,
            new Map(activePollers).set(cwd, {
              ...existing,
              subscriberCount: existing.subscriberCount - 1,
            }),
          ] as const),
        );
      }

      return Effect.succeed([
        existing.fiber,
        new Map([...activePollers].filter(([activeCwd]) => activeCwd !== cwd)),
      ] as const);
    });

    if (pollerToInterrupt) {
      yield* Fiber.interrupt(pollerToInterrupt).pipe(Effect.ignore);
    }
  });

  const streamStatus: VcsStatusBroadcaster["Service"]["streamStatus"] = (input, options) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
        const subscription = yield* PubSub.subscribe(changesPubSub);
        const initialLocal = yield* getOrLoadLocalStatus(cwd);
        const cachedStatus = yield* getCachedStatus(cwd);
        const initialRemote = cachedStatus?.remote?.value ?? null;
        yield* retainRemotePoller(
          cwd,
          input.cwd,
          options?.automaticRemoteRefreshInterval ??
            Effect.succeed(DEFAULT_VCS_STATUS_REFRESH_INTERVAL),
          cachedStatus?.remote === null || cachedStatus?.remote === undefined,
        );

        const release = releaseRemotePoller(cwd, input.cwd).pipe(Effect.ignore, Effect.asVoid);

        return Stream.concat(
          Stream.make({
            _tag: "snapshot" as const,
            local: initialLocal,
            remote: initialRemote,
            workingCopyRevision: revision(cwd),
            invalidatedDomains: ALL_REPOSITORY_DOMAINS,
          }),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.cwd === cwd),
            Stream.map((event) => event.event),
          ),
        ).pipe(Stream.ensuring(release));
      }),
    );

  return VcsStatusBroadcaster.of({
    getStatus,
    notifyMutation,
    refreshLocalStatus,
    refreshStatus,
    refreshPullRequestStatus,
    streamStatus,
  });
});

export const layer = Layer.effect(VcsStatusBroadcaster, make);
