import * as Crypto from "effect/Crypto";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
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
  VcsStatusSubscriptionInput,
} from "@t3tools/contracts";
import { DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL } from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { mergeGitStatusParts } from "@t3tools/shared/git";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  resolveRepositoryInvalidationScope,
  type RepositoryInvalidationScope,
} from "./repositoryInvalidationScope.ts";

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

function remoteRefreshFailureDiagnostics(cause: Cause.Cause<unknown>) {
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

interface CachedRemoteStatus extends CachedValue<VcsStatusRemoteResult | null> {
  readonly branch: string | null;
  readonly localScopeFingerprint?: string;
}

interface CachedVcsStatus {
  readonly local: CachedValue<VcsStatusLocalResult> | null;
  readonly remote: CachedRemoteStatus | null;
}

interface ActiveRemotePoller {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly subscriberCount: number;
  readonly demandCwds: Ref.Ref<ReadonlyMap<string, number>>;
  readonly refreshRequests: Queue.Queue<void>;
}

export class VcsAutomaticFetchInterval extends Context.Reference<Effect.Effect<Duration.Duration>>(
  "t3/vcs/VcsAutomaticFetchInterval",
  { defaultValue: () => Effect.succeed(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL) },
) {}

export const layerAutomaticFetchInterval = Layer.effect(
  VcsAutomaticFetchInterval,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    return serverSettings.getSettings.pipe(
      Effect.map(
        (settings) => resolveServerBackgroundActivitySettings(settings).automaticGitFetchInterval,
      ),
      Effect.orElseSucceed(() => DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL),
    );
  }),
);

export class VcsAutoPullPolicy extends Context.Reference<{
  readonly isEnabled: (cwd: string) => Effect.Effect<boolean, never>;
}>("t3/vcs/VcsAutoPullPolicy", {
  defaultValue: () => ({ isEnabled: () => Effect.succeed(false) }),
}) {}

export const layerAutoPullPolicy = Layer.effect(
  VcsAutoPullPolicy,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    return {
      isEnabled: Effect.fn("VcsAutoPullPolicy.isEnabled")(
        function* (cwd: string) {
          const project = yield* projects.findActiveByWorkspaceRoot(cwd);
          if (project._tag === "None") return false;
          const settings = yield* serverSettings.getSettings;
          return resolveProjectSettings(settings, project.value.projectId).settings.defaultAutoPull;
        },
        Effect.orElseSucceed(() => false),
      ),
    };
  }),
);

function remoteRefreshFailureDelay(
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
    readonly refreshStatus: (
      cwd: string,
      options?: { readonly localOnly?: boolean },
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly refreshPullRequestStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly streamStatus: (
      input: VcsStatusSubscriptionInput,
    ) => Stream.Stream<VcsStatusStreamEvent, GitManagerServiceError>;
  }
>()("t3/vcs/VcsStatusBroadcaster") {}

function fingerprintStatusPart(status: unknown): string {
  return JSON.stringify(status);
}

// fork: remote state belongs to a repository/ref/provider identity, not its worktree contents.
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

/** @public */
export const make = Effect.gen(function* () {
  const automaticFetchInterval = yield* VcsAutomaticFetchInterval;
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
  const epoch = yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.orDie);
  const counters = new Map<string, number>();
  const revision = (cwd: string) => ({ epoch, counter: counters.get(cwd) ?? 0 });
  const advanceRevision = (cwd: string) => {
    counters.set(cwd, (counters.get(cwd) ?? 0) + 1);
    return revision(cwd);
  };
  // One permit per cwd for remote reads that write the cache. Without it a
  // periodic poll that started before an agent creates a PR can finish after the
  // turn-end refresh and overwrite the fresh PR with its stale `pr: null`.
  const remoteWriteLocks = yield* KeyedLock.make<string>();
  const withRemoteWriteLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
    remoteWriteLocks.withLock(cwd, effect);
  const pollersRef = yield* SynchronizedRef.make(new Map<string, ActiveRemotePoller>());

  const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")(function* (
    cwd: string,
  ) {
    return yield* Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));
  });

  const updateCachedLocalStatus = Effect.fn("VcsStatusBroadcaster.updateCachedLocalStatus")(
    function* (
      cwd: string,
      readLocal: VcsStatusLocalResult,
      options?: {
        publish?: boolean;
        mutationDomains?: ReadonlyArray<VcsInvalidationDomain>;
        expectedCounter?: number;
      },
    ) {
      // fork: never republish a read that raced a mutation under a newer revision.
      const previousLocal = (yield* getCachedStatus(cwd))?.local?.value;
      const local =
        options?.expectedCounter !== undefined && revision(cwd).counter !== options.expectedCounter
          ? (previousLocal ?? readLocal)
          : readLocal;
      const nextLocal = { fingerprint: fingerprintStatusPart(local), value: local };
      const [localChanged, remoteCleared, remoteScopeChanged] = yield* Ref.modify(
        cacheRef,
        (cache) => {
          const previous = cache.get(cwd) ?? { local: null, remote: null };
          const sameScope =
            remoteStatusScopeFingerprint(previous.local?.value ?? null) ===
            remoteStatusScopeFingerprint(local);
          const remote =
            sameScope && previous.remote?.branch === local.refName ? previous.remote : null;
          return [
            [
              previous.local?.fingerprint !== nextLocal.fingerprint,
              previous.remote !== remote,
              !sameScope,
            ],
            new Map(cache).set(cwd, { local: nextLocal, remote }),
          ] as const;
        },
      );
      if (options?.publish && remoteCleared) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: { _tag: "remoteUpdated", remote: null },
        });
      }
      if (options?.publish && (localChanged || options.mutationDomains !== undefined)) {
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
      if (remoteScopeChanged) {
        const poller = (yield* SynchronizedRef.get(pollersRef)).get(cwd);
        if (poller) yield* Queue.offer(poller.refreshRequests, undefined);
      }
      return local;
    },
  );

  const updateCachedRemoteStatus = Effect.fn("VcsStatusBroadcaster.updateCachedRemoteStatus")(
    function* (cwd: string, remote: CachedRemoteStatus | null, options?: { publish?: boolean }) {
      const [changed, value] = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        const next =
          remote !== null &&
          remote.branch === previous.local?.value.refName &&
          (remote.localScopeFingerprint === undefined ||
            remote.localScopeFingerprint ===
              remoteStatusScopeFingerprint(previous.local?.value ?? null))
            ? remote
            : null;
        return [
          [previous.remote?.fingerprint !== next?.fingerprint, next?.value ?? null],
          new Map(cache).set(cwd, { ...previous, remote: next }),
        ] as const;
      });
      if (options?.publish && changed) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: { _tag: "remoteUpdated", remote: value },
        });
      }
      return value;
    },
  );

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

  const getStatusParts = Effect.fn("VcsStatusBroadcaster.getStatusParts")(function* (cwd: string) {
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local) {
      return { local: cached.local.value, remote: cached.remote?.value ?? null };
    }
    return { local: yield* loadLocalStatus(cwd), remote: null };
  });

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
    yield* getOrLoadLocalStatus(cwd);
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        const latest = yield* getCachedStatus(cwd);
        const refreshUpstream = !Duration.isZero(yield* automaticFetchInterval);
        const remote = latest?.remote ?? (yield* readRemoteStatus(cwd, { refreshUpstream }));
        yield* updateCachedRemoteStatus(cwd, remote);
        const parts = yield* getStatusParts(cwd);
        return mergeGitStatusParts(parts.local, parts.remote);
      }),
    );
  });

  // A refresh that started after a request saw every change that request could mean, so queued
  // callers share it instead of each running git status again.
  const localRefreshLocks = yield* KeyedLock.make<string>();
  const localRefreshRequests = new Map<string, number>();
  const localRefreshResults = new Map<
    string,
    { readonly startedAt: number; readonly local: VcsStatusLocalResult }
  >();
  const refreshLocalStatusCore = Effect.fn("VcsStatusBroadcaster.refreshLocalStatusCore")(
    function* (cwd: string, mutationDomains?: ReadonlyArray<VcsInvalidationDomain>) {
      const requestedAt = (localRefreshRequests.get(cwd) ?? 0) + 1;
      localRefreshRequests.set(cwd, requestedAt);
      return yield* localRefreshLocks.withLock(
        cwd,
        Effect.gen(function* () {
          const shared = localRefreshResults.get(cwd);
          if (shared !== undefined && shared.startedAt >= requestedAt) {
            return mutationDomains === undefined
              ? shared.local
              : yield* updateCachedLocalStatus(cwd, shared.local, {
                  publish: true,
                  mutationDomains,
                });
          }
          const startedAt = localRefreshRequests.get(cwd) ?? requestedAt;
          const local = yield* Effect.gen(function* () {
            yield* workflow.invalidateLocalStatus(cwd);
            return yield* workflow.localStatus({ cwd });
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                // A failed read must not hide a completed partial mutation.
                const cached = yield* getCachedStatus(cwd);
                if (mutationDomains !== undefined && cached?.local) return cached.local.value;
                if (mutationDomains !== undefined) advanceRevision(cwd);
                return yield* error;
              }),
            ),
          );
          localRefreshResults.set(cwd, { startedAt, local });
          return yield* updateCachedLocalStatus(cwd, local, {
            publish: true,
            ...(mutationDomains === undefined ? {} : { mutationDomains }),
          });
        }),
      );
    },
  );

  // fork: shared refs/stashes invalidate subscribed sibling worktrees without another disk read.
  const publishSharedInvalidation = Effect.fn("VcsStatusBroadcaster.publishSharedInvalidation")(
    function* (
      cwd: string,
      domains: ReadonlyArray<VcsInvalidationDomain>,
      origin: { readonly cwd: string; readonly counter: number },
    ) {
      yield* localRefreshLocks.withLock(
        cwd,
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

  const readRemoteStatus = Effect.fn("VcsStatusBroadcaster.readRemoteStatus")(function* (
    cwd: string,
    options?: Parameters<GitWorkflowService.GitWorkflowService["Service"]["remoteStatus"]>[1],
  ) {
    const branch = yield* workflow.currentBranch(cwd);
    const localScopeFingerprint = remoteStatusScopeFingerprint(
      (yield* getCachedStatus(cwd))?.local?.value ?? null,
    );
    // GitManager's remote TTL cache is keyed by cwd, not the checked-out branch.
    yield* workflow.invalidateRemoteStatus(cwd);
    const value = yield* workflow.remoteStatus({ cwd }, options);
    const currentBranch = yield* workflow.currentBranch(cwd);
    const cached = yield* getCachedStatus(cwd);
    if (branch !== currentBranch || cached?.local?.value.refName !== currentBranch) {
      yield* refreshLocalStatusCore(cwd);
    }
    return branch === currentBranch
      ? { branch, value, fingerprint: fingerprintStatusPart(value), localScopeFingerprint }
      : null;
  });

  const maybeAutoPull = Effect.fn("VcsStatusBroadcaster.maybeAutoPull")(function* (
    cwd: string,
    remoteRead: CachedRemoteStatus | null,
    policyCwds: ReadonlyArray<string>,
  ) {
    const remote = remoteRead?.value ?? null;
    let pullAttempted = false;
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
      if (
        !local.isRepo ||
        !local.isDefaultRef ||
        local.hasWorkingTreeChanges ||
        local.refName !== remoteRead?.branch
      )
        return null;

      pullAttempted = true;
      yield* workflow.pullCurrentBranch(cwd).pipe(Effect.ensuring(notifyMutation(cwd)));
      yield* workflow.invalidateStatus(cwd);
      yield* refreshLocalStatusCore(cwd);
      const refreshedRemote = yield* readRemoteStatus(cwd, { refreshUpstream: false });
      yield* updateCachedRemoteStatus(cwd, refreshedRemote, { publish: true });
      return yield* getStatusParts(cwd);
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Automatic project pull failed", {
            cwdLength: cwd.length,
            errorTag: error._tag,
          });
          if (!pullAttempted) return null;
          // A pull or its follow-up reads can fail after local state has changed.
          // Let a failed reconciliation reach the caller instead of publishing old status.
          yield* refreshLocalStatusCore(cwd);
          yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
          return yield* getStatusParts(cwd);
        }),
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
        const previousRemote = (yield* getCachedStatus(cwd))?.remote?.value;
        const remoteRead = yield* readRemoteStatus(cwd, options);
        const remote = remoteRead?.value;
        const pulled =
          options?.refreshUpstream === false
            ? null
            : yield* maybeAutoPull(cwd, remoteRead, options?.policyCwds ?? [cwd]);
        if (pulled !== null) return true;
        if (
          remote &&
          (!previousRemote ||
            previousRemote.aheadCount !== remote.aheadCount ||
            previousRemote.behindCount !== remote.behindCount ||
            previousRemote.aheadOfDefaultCount !== remote.aheadOfDefaultCount)
        ) {
          yield* refreshLocalStatusCore(cwd);
        }
        yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
        return (yield* getCachedStatus(cwd))?.remote !== null;
      }),
    );
  });

  const refreshStatus: VcsStatusBroadcaster["Service"]["refreshStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshStatus",
  )(function* (rawCwd, options) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    const previous = options?.localOnly ? yield* getCachedStatus(cwd) : null;
    const local = yield* refreshLocalStatusCore(cwd);
    if (options?.localOnly) {
      return yield* withRemoteWriteLock(
        cwd,
        Effect.gen(function* () {
          if (previous?.local?.value.refName !== local.refName || !previous?.remote) {
            yield* workflow.invalidateRemoteStatus(cwd);
            yield* updateCachedRemoteStatus(
              cwd,
              { branch: local.refName, fingerprint: fingerprintStatusPart(null), value: null },
              { publish: true },
            );
          }
          const parts = yield* getStatusParts(cwd);
          return mergeGitStatusParts(parts.local, parts.remote);
        }),
      );
    }
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        const refreshUpstream = !Duration.isZero(yield* automaticFetchInterval);
        // Bump the PR lookup epoch after earlier remote writers have finished.
        yield* workflow.invalidateStatus(cwd);
        const remoteRead = yield* readRemoteStatus(cwd, { refreshUpstream });
        // Fetch can move the base used for local Changes totals.
        const expectedCounter = revision(cwd).counter;
        const local = yield* workflow.localStatus({ cwd });
        yield* updateCachedLocalStatus(cwd, local, { publish: true, expectedCounter });
        // Without a fetch, the cached behind count cannot justify an automatic pull.
        const pulled = refreshUpstream ? yield* maybeAutoPull(cwd, remoteRead, [rawCwd]) : null;
        if (pulled !== null) return mergeGitStatusParts(pulled.local, pulled.remote);
        yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
        const parts = yield* getStatusParts(cwd);
        return mergeGitStatusParts(parts.local, parts.remote);
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
          if (!cached?.local || cached.remote?.value === null) return null;
          const poller = (yield* SynchronizedRef.get(pollersRef)).get(cwd);
          const demandCwds = poller ? [...(yield* Ref.get(poller.demandCwds)).keys()] : [rawCwd];
          const shouldRefresh = (yield* Effect.forEach(
            demandCwds,
            (demandCwd) =>
              backgroundPolicy.shouldRunScopeWork({ type: "vcs-status", cwd: demandCwd }),
            { concurrency: "unbounded" },
          )).some(Boolean);
          if (!shouldRefresh) return null;
          const remoteRead = yield* readRemoteStatus(cwd, {
            refreshUpstream: false,
            refreshMissingPullRequest: true,
          });
          return yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
        }),
      );
    });

  // A subscription owns this loop; keep each poll's spans out of a never-ending parent span.
  const makeRemoteRefreshLoop = Effect.fnUntraced(function* (
    cwd: string,
    demandCwdsRef: Ref.Ref<ReadonlyMap<string, number>>,
    refreshRequests: Queue.Queue<void>,
  ) {
    const consecutiveFailuresRef = yield* Ref.make(0);
    const nextDelayRef = yield* Ref.make<Duration.Duration | null>(null);
    const refreshRequiredRef = yield* Ref.make(false);

    return yield* Effect.forever(
      Effect.gen(function* () {
        const configuredInterval = yield* automaticFetchInterval;
        const activeInterval = Duration.isZero(configuredInterval)
          ? DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL
          : configuredInterval;
        const nextDelay = (yield* Ref.get(nextDelayRef)) ?? activeInterval;
        const refreshRequested = yield* Queue.take(refreshRequests).pipe(
          Effect.as(true),
          Effect.timeoutOrElse({ duration: nextDelay, orElse: () => Effect.succeed(false) }),
        );
        const refreshRequired = refreshRequested || (yield* Ref.get(refreshRequiredRef));

        if (Duration.isZero(configuredInterval) && !refreshRequired) {
          yield* Ref.set(nextDelayRef, activeInterval);
          return;
        }

        const demandCwds = yield* Ref.get(demandCwdsRef);
        const shouldRun =
          refreshRequired ||
          (yield* Effect.forEach(
            [...demandCwds.keys()],
            (demandCwd) =>
              backgroundPolicy.shouldRunScopeWork({
                type: "vcs-status",
                cwd: demandCwd,
              }),
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
        const fiber = yield* makeRemoteRefreshLoop(cwd, demandCwds, refreshRequests).pipe(
          Effect.forkIn(broadcasterScope),
        );
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

  const streamStatus: VcsStatusBroadcaster["Service"]["streamStatus"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
        const subscription = yield* PubSub.subscribe(changesPubSub);
        const initialLocal = yield* getOrLoadLocalStatus(cwd);
        const cachedStatus = yield* getCachedStatus(cwd);
        const initialRemote = cachedStatus?.remote?.value ?? null;
        if (input.includeRemote !== false) {
          yield* retainRemotePoller(
            cwd,
            input.cwd,
            cachedStatus?.remote === null || cachedStatus?.remote === undefined,
          );
        }
        const release =
          input.includeRemote === false
            ? Effect.void
            : releaseRemotePoller(cwd, input.cwd).pipe(Effect.ignore, Effect.asVoid);

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
