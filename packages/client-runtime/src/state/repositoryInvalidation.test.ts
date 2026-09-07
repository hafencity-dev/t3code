// fork: repository invalidation — two independent client registries against
// one simulated server, wired through the real atom families.
import {
  EnvironmentId,
  WS_METHODS,
  type VcsInvalidationDomain,
  type VcsStatusLocalResult,
  type VcsStatusStreamEvent,
  type WorkingCopyDiffResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  invalidateRepository,
  observeRepositoryChange,
  workingCopyRevisionAtom,
} from "./repositoryInvalidation.ts";
import { createVcsEnvironmentAtoms } from "./vcs.ts";
import { vcsRefsCacheStateAtom } from "./vcsRefInvalidation.ts";
import { createWorkingCopyEnvironmentAtoms } from "./workingCopy.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const CWD = "/repo";
const SCOPE = { environmentId: TARGET.environmentId, cwd: CWD };
const CONNECTED: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
};
const LOCAL: VcsStatusLocalResult = {
  isRepo: true,
  sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/invalidation",
  hasWorkingTreeChanges: true,
  workingTree: { files: [], insertions: 1, deletions: 0 },
};
const EPOCH = "server-epoch";
const snapshot = (counter: number): VcsStatusStreamEvent => ({
  _tag: "snapshot",
  local: LOCAL,
  remote: null,
  workingCopyRevision: { epoch: EPOCH, counter },
  invalidatedDomains: ["worktree", "refs", "stashes"],
});
const localUpdated = (
  counter: number,
  invalidatedDomains: ReadonlyArray<VcsInvalidationDomain>,
  invalidationOrigin?: { readonly cwd: string; readonly counter: number },
): VcsStatusStreamEvent => ({
  _tag: "localUpdated",
  local: LOCAL,
  workingCopyRevision: { epoch: EPOCH, counter },
  invalidatedDomains,
  ...(invalidationOrigin === undefined ? {} : { invalidationOrigin }),
});
const domainsOf = (change: { readonly domains: ReadonlyArray<VcsInvalidationDomain> } | null) =>
  change === null ? null : change.domains;

describe("observeRepositoryChange", () => {
  it("coalesces duplicate subscriptions, ignores PR frames and forces a refresh per session", () => {
    const registry = AtomRegistry.make();
    const sessionA = {};

    // The first frame for a target never re-reads: its queries are fresh.
    expect(observeRepositoryChange(registry, SCOPE, sessionA, snapshot(0))).toBeNull();
    // A second subscription over the same session replays the same token.
    expect(observeRepositoryChange(registry, SCOPE, sessionA, snapshot(0))).toBeNull();
    expect(
      domainsOf(observeRepositoryChange(registry, SCOPE, sessionA, localUpdated(1, ["worktree"]))),
    ).toEqual(["worktree"]);
    expect(
      observeRepositoryChange(registry, SCOPE, sessionA, localUpdated(1, ["worktree"])),
    ).toBeNull();
    expect(
      observeRepositoryChange(registry, SCOPE, sessionA, {
        _tag: "remoteUpdated",
        remote: { hasUpstream: true, aheadCount: 0, behindCount: 0, pr: null },
      }),
    ).toBeNull();

    // Reconnect: the server may have restarted or changed while disconnected.
    const sessionB = {};
    expect(observeRepositoryChange(registry, SCOPE, sessionB, snapshot(1))).toEqual({
      domains: ["worktree", "refs", "stashes"],
      refsKey: sessionB,
    });
    // Sibling frames of one shared change share the refs key of their origin.
    const origin = { cwd: "/repo", counter: 2 };
    const sibling = { environmentId: TARGET.environmentId, cwd: "/repo-sibling" };
    expect(observeRepositoryChange(registry, sibling, sessionB, snapshot(6))).toBeNull();
    const fromSource = observeRepositoryChange(
      registry,
      SCOPE,
      sessionB,
      localUpdated(2, ["refs"]),
    );
    const fromSibling = observeRepositoryChange(
      registry,
      sibling,
      sessionB,
      localUpdated(7, ["refs"], origin),
    );
    expect(fromSibling?.refsKey).toBe(fromSource?.refsKey);

    // Servers without revisions fall back to payload equality.
    const legacy = {};
    const legacySnapshot: VcsStatusStreamEvent = { _tag: "snapshot", local: LOCAL, remote: null };
    expect(domainsOf(observeRepositoryChange(registry, SCOPE, legacy, legacySnapshot))).toEqual([
      "worktree",
      "refs",
      "stashes",
    ]);
    expect(observeRepositoryChange(registry, SCOPE, legacy, legacySnapshot)).toBeNull();
    expect(
      domainsOf(
        observeRepositoryChange(registry, SCOPE, legacy, {
          _tag: "localUpdated",
          local: { ...LOCAL, refName: "main" },
        }),
      ),
    ).toEqual(["worktree", "refs", "stashes"]);
    // Decisions never move the revision themselves.
    expect(registry.get(workingCopyRevisionAtom(SCOPE))).toBe(0);
    registry.dispose();
  });
});

/** A sibling worktree frame folded in by the same client session. */
const observeAndInvalidate = (
  registry: AtomRegistry.AtomRegistry,
  target: { readonly environmentId: EnvironmentId; readonly cwd: string },
  event: VcsStatusStreamEvent,
  cache: Persistence.EnvironmentCacheStore["Service"],
) =>
  Effect.gen(function* () {
    const session = {};
    // The first frame per target only records; the second one is the change.
    observeRepositoryChange(registry, target, session, snapshot(0));
    const change = observeRepositoryChange(registry, target, session, event);
    if (change === null) return;
    yield* invalidateRepository(registry, target, change.domains, change.refsKey).pipe(
      Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    );
  });

/** One simulated client: its own session, registry, runtime and stream queue. */
const makeClient = Effect.fn("makeClient")(function* (options: {
  readonly diff: () => Effect.Effect<WorkingCopyDiffResult>;
  readonly stagePaths?: () => Effect.Effect<{ readonly staged: number }>;
  readonly clears?: Ref.Ref<number>;
  readonly serverPushesRevisions?: () => boolean;
}) {
  const frames = yield* Queue.unbounded<VcsStatusStreamEvent>();
  const client = {
    [WS_METHODS.subscribeVcsStatus]: () => Stream.fromQueue(frames),
    [WS_METHODS.workingCopyDiff]: () => options.diff(),
    [WS_METHODS.workingCopyStagePaths]: () =>
      options.stagePaths?.() ?? Effect.succeed({ staged: 1 }),
    [WS_METHODS.vcsRefreshStatus]: () => Effect.succeed({ ...LOCAL, pr: null }),
  } as unknown as WsRpcProtocolClient;
  const makeSession = (): RpcSession => ({
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  });
  const session = yield* SubscriptionRef.make(Option.some(makeSession()));
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(CONNECTED),
    session,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeed(Option.none()),
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () =>
      options.clears === undefined ? Effect.void : Ref.update(options.clears, (n) => n + 1),
    clear: () => Effect.void,
  });
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(Persistence.EnvironmentCacheStore, cache),
    ),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const capabilities = () =>
    options.serverPushesRevisions === undefined
      ? null
      : { workingCopyRevision: options.serverPushesRevisions() };
  const vcs = createVcsEnvironmentAtoms(runtime, { capabilities });
  const workingCopy = createWorkingCopyEnvironmentAtoms(runtime, { capabilities });
  yield* AtomRegistry.mount(
    registry,
    vcs.status({ environmentId: TARGET.environmentId, input: { cwd: CWD } }),
  );
  const revision = () => registry.get(workingCopyRevisionAtom(SCOPE));
  /** Barrier: resolves once the stream fiber has folded a frame into the revision. */
  const awaitRevision = (expected: number) =>
    Effect.suspend(() =>
      revision() >= expected
        ? Effect.void
        : Effect.callback<void>((resume) => {
            const unsubscribe = registry.subscribe(workingCopyRevisionAtom(SCOPE), (value) => {
              if (value >= expected) resume(Effect.void);
            });
            return Effect.sync(unsubscribe);
          }),
    );
  const reconnect = () => SubscriptionRef.set(session, Option.some(makeSession()));
  return { frames, registry, vcs, workingCopy, revision, awaitRevision, reconnect, cache };
});

describe("repository invalidation across clients", () => {
  it.effect("another client's stage/unstage re-reads a mounted diff without a summary change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const patches = ["patch-1", "patch-2", "patch-3"];
        const diffCalls = yield* Ref.make(0);
        const secondDiff = yield* Deferred.make<void>();
        const clearsB = yield* Ref.make(0);
        const a = yield* makeClient({
          diff: () => Effect.succeed({ patch: "", truncated: false }),
        });
        const b = yield* makeClient({
          clears: clearsB,
          diff: () =>
            Effect.gen(function* () {
              const call = yield* Ref.updateAndGet(diffCalls, (n) => n + 1);
              // The second read is the stale one: it settles only after the
              // third read has already been requested.
              if (call === 2) yield* Deferred.await(secondDiff);
              return { patch: patches[call - 1] ?? "patch-late", truncated: false };
            }),
        });
        const diffAtom = b.workingCopy.diff({
          environmentId: TARGET.environmentId,
          input: { cwd: CWD, path: "a.ts", staged: false },
        });
        yield* AtomRegistry.mount(b.registry, diffAtom);
        const diffValue = () =>
          Option.getOrNull(AsyncResult.value(b.registry.get(diffAtom)))?.patch ?? null;
        const settledDiff = () =>
          AtomRegistry.getResult(b.registry, diffAtom, { suspendOnWaiting: true });

        // Both clients receive the initial snapshot; nothing is re-read.
        yield* Queue.offer(a.frames, snapshot(0));
        yield* Queue.offer(b.frames, snapshot(0));
        expect((yield* settledDiff()).patch).toBe("patch-1");
        expect(yield* Ref.get(diffCalls)).toBe(1);
        expect(b.revision()).toBe(0);

        // Client A stages a file. The server's summary is unchanged, only the
        // revision moved.
        yield* Queue.offer(a.frames, localUpdated(1, ["worktree"]));
        yield* Queue.offer(b.frames, localUpdated(1, ["worktree"]));
        yield* a.awaitRevision(1);
        yield* b.awaitRevision(1);
        expect(yield* Ref.get(diffCalls)).toBe(2);
        expect(diffValue()).toBe("patch-1");

        // A third change supersedes the in-flight second read.
        yield* Queue.offer(b.frames, localUpdated(2, ["worktree"]));
        yield* b.awaitRevision(2);
        expect((yield* settledDiff()).patch).toBe("patch-3");
        yield* Deferred.succeed(secondDiff, undefined);
        expect((yield* settledDiff()).patch).toBe("patch-3");
        expect(yield* Ref.get(diffCalls)).toBe(3);

        // PR-only frames and replays change nothing.
        yield* Queue.offer(b.frames, {
          _tag: "remoteUpdated",
          remote: { hasUpstream: true, aheadCount: 0, behindCount: 0, pr: null },
        });
        yield* Queue.offer(b.frames, localUpdated(2, ["worktree"]));
        // A refs change from the other client invalidates cached branch lists
        // once, even though a sibling worktree announces the same change.
        yield* Queue.offer(b.frames, localUpdated(3, ["refs"]));
        yield* b.awaitRevision(3);
        yield* observeAndInvalidate(
          b.registry,
          { environmentId: TARGET.environmentId, cwd: "/repo-sibling" },
          localUpdated(9, ["refs"], { cwd: CWD, counter: 3 }),
          b.cache,
        );
        expect(b.registry.get(vcsRefsCacheStateAtom(TARGET)).revision).toBe(1);
        expect(yield* Ref.get(clearsB)).toBe(1);
        expect((yield* settledDiff()).patch).toBe("patch-late");
        expect(yield* Ref.get(diffCalls)).toBe(4);

        // Reconnect with an unchanged token still refreshes everything.
        yield* b.reconnect();
        yield* Queue.offer(b.frames, snapshot(3));
        yield* b.awaitRevision(4);
        expect(b.registry.get(vcsRefsCacheStateAtom(TARGET)).revision).toBe(2);
        expect(yield* Ref.get(clearsB)).toBe(2);
        expect(a.revision()).toBe(1);
      }),
    ),
  );

  it.effect("a mutation falls back to a local refresh only when the server did not push", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // What the simulated server does before answering the RPC.
        const server: { beforeSettling: Effect.Effect<void>; advertises: boolean } = {
          beforeSettling: Effect.void,
          advertises: false,
        };
        const client = yield* makeClient({
          diff: () => Effect.succeed({ patch: "", truncated: false }),
          stagePaths: () => server.beforeSettling.pipe(Effect.as({ staged: 1 })),
          serverPushesRevisions: () => server.advertises,
        });
        yield* Queue.offer(client.frames, snapshot(0));
        const run = () =>
          Effect.promise(() =>
            client.workingCopy.stagePaths.run(client.registry, {
              environmentId: TARGET.environmentId,
              input: { cwd: CWD, paths: ["a.ts"] },
            }),
          );

        const outcome = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
          AsyncResult.isFailure(result) ? String(Cause.squash(result.cause)) : "ok";

        // Old server: no push, so the client invalidates once itself.
        expect(outcome(yield* run())).toBe("ok");
        expect(client.revision()).toBe(1);

        // An unrelated bump during the RPC does not satisfy the fallback.
        server.beforeSettling = Effect.sync(() => {
          client.registry.update(workingCopyRevisionAtom(SCOPE), (n) => n + 1);
        });
        expect(outcome(yield* run())).toBe("ok");
        expect(client.revision()).toBe(3);

        // A server frame carrying a revision for this target does.
        server.beforeSettling = Queue.offer(client.frames, localUpdated(1, ["worktree"])).pipe(
          Effect.andThen(client.awaitRevision(4)),
        );
        expect(outcome(yield* run())).toBe("ok");
        expect(client.revision()).toBe(4);

        // A server advertising revisions never triggers the fallback, and the
        // same applies to the upstream vcs commands.
        server.advertises = true;
        server.beforeSettling = Effect.void;
        expect(outcome(yield* run())).toBe("ok");
        expect(client.revision()).toBe(4);
        expect(
          outcome(
            yield* Effect.promise(() =>
              client.vcs.refreshStatus.run(client.registry, {
                environmentId: TARGET.environmentId,
                input: { cwd: CWD },
              }),
            ),
          ),
        ).toBe("ok");
        expect(client.revision()).toBe(4);
        expect(client.registry.get(vcsRefsCacheStateAtom(TARGET)).revision).toBe(0);
      }),
    ),
  );
});
