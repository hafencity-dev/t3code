import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationThread,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  getStartedThreadModelChangeBlockReason,
  isModelSelectionSaving,
  pendingModelSelectionAtom,
  saveThreadModelSelection,
} from "./pendingModelSelection.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from "./threadState.ts";

const THREAD_ID = ThreadId.make("thread-1");
const codex = ProviderInstanceId.make("codex");
const MODEL_A: ModelSelection = {
  instanceId: codex,
  model: "ModelA",
  options: [{ id: "effort", value: "high" }],
};
const MODEL_B: ModelSelection = { instanceId: codex, model: "ModelB" };
const MODEL_C: ModelSelection = { instanceId: codex, model: "ModelC" };

const THREAD: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Shared thread",
  modelSelection: MODEL_A,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

/** Flush a bounded number of microtask hops; nothing here waits on wall time. */
async function settle(): Promise<void> {
  for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** One client: its own registry and its own view of the environment thread state. */
function makeClient(ref: ScopedThreadRef, initial: OrchestrationThread, sequence: number) {
  const registry = AtomRegistry.make({ defaultIdleTTL: 60_000, timeoutResolution: 1 });
  const stateOf = (data: OrchestrationThread, appliedSequence: number): EnvironmentThreadState => ({
    ...EMPTY_ENVIRONMENT_THREAD_STATE,
    status: "live",
    data: Option.some(data),
    appliedSequence,
  });
  const stateAtom = Atom.make<AsyncResult.AsyncResult<EnvironmentThreadState, never>>(
    AsyncResult.success(stateOf(initial, sequence)),
  ).pipe(Atom.keepAlive);
  const thread = () =>
    Option.getOrThrow(
      AsyncResult.value(registry.get(stateAtom)).pipe(Option.flatMap((state) => state.data)),
    );
  const pending = () => registry.get(pendingModelSelectionAtom(ref));
  return {
    registry,
    stateAtom,
    /** The server stream delivered an applied read model at this sequence. */
    apply(data: OrchestrationThread, appliedSequence: number) {
      registry.set(stateAtom, AsyncResult.success(stateOf(data, appliedSequence)));
    },
    pending,
    /** What the composer shows and what its next send snapshot would use. */
    picker: () => pending() ?? thread().modelSelection,
  };
}

/** Deterministic stand-in for the server: replaces the full selection and hands
 * back the event sequence; publication to clients is driven by each test. */
function makeServer(thread: OrchestrationThread, sequence: number) {
  const server = { thread, sequence };
  return {
    updateMetadata(selection: ModelSelection) {
      server.sequence += 1;
      server.thread = { ...server.thread, modelSelection: selection };
      return { sequence: server.sequence, thread: server.thread };
    },
    current: () => server.thread,
  };
}

describe("saveThreadModelSelection", () => {
  const ref: ScopedThreadRef = { environmentId: EnvironmentId.make("env-1"), threadId: THREAD_ID };

  it("shows a remote pick on both clients and keeps the host's next payload on the saved model", async () => {
    const server = makeServer(THREAD, 7);
    const host = makeClient(ref, THREAD, 7);
    const remote = makeClient(ref, THREAD, 7);
    const dispatch = deferred<{ sequence: number }>();
    const dispatched: ModelSelection[] = [];

    const save = saveThreadModelSelection({
      registry: remote.registry,
      threadRef: ref,
      selection: MODEL_B,
      stateAtom: remote.stateAtom,
      dispatch: () => {
        dispatched.push(MODEL_B);
        return dispatch.promise;
      },
    });
    // The remote shows its pick immediately and blocks further picks and Send.
    expect(remote.pending()).toEqual(MODEL_B);
    expect(isModelSelectionSaving(remote.registry, ref)).toBe(true);
    // The stale host is untouched by another client's optimistic state.
    expect(host.pending()).toBeNull();
    expect(isModelSelectionSaving(host.registry, ref)).toBe(false);
    expect(host.picker()).toEqual(MODEL_A);

    // Full replacement: the removed options never come back through the wire.
    expect(dispatched).toEqual([{ instanceId: codex, model: "ModelB" }]);
    const applied = server.updateMetadata(MODEL_B);
    expect(applied.thread.modelSelection).toEqual({ instanceId: codex, model: "ModelB" });
    host.apply(applied.thread, applied.sequence);
    remote.apply(applied.thread, applied.sequence);

    // Read model arrived before the receipt: the save is still pending.
    await settle();
    expect(isModelSelectionSaving(remote.registry, ref)).toBe(true);
    dispatch.resolve({ sequence: applied.sequence });
    await save;

    expect(remote.pending()).toBeNull();
    expect(remote.picker()).toEqual(MODEL_B);
    expect(host.picker()).toEqual(MODEL_B);
  });

  it("waits for the applied sequence to reach the receipt before releasing Send", async () => {
    const server = makeServer(THREAD, 7);
    const client = makeClient(ref, THREAD, 7);
    const dispatch = deferred<{ sequence: number }>();
    let settled = false;
    const save = saveThreadModelSelection({
      registry: client.registry,
      threadRef: ref,
      selection: MODEL_B,
      stateAtom: client.stateAtom,
      dispatch: () => dispatch.promise,
    }).then(() => {
      settled = true;
    });

    const applied = server.updateMetadata(MODEL_B);
    dispatch.resolve({ sequence: applied.sequence });
    await settle();
    // Receipt first, stream later: the model is confirmed only once applied.
    expect(settled).toBe(false);
    expect(client.picker()).toEqual(MODEL_B);

    client.apply(applied.thread, applied.sequence);
    await save;
    expect(settled).toBe(true);
    expect(client.pending()).toBeNull();
    expect(client.picker()).toEqual(MODEL_B);
  });

  it("lets a newer remote selection win over the delayed local receipt", async () => {
    const server = makeServer(THREAD, 7);
    const host = makeClient(ref, THREAD, 7);
    const remote = makeClient(ref, THREAD, 7);
    const dispatch = deferred<{ sequence: number }>();
    const save = saveThreadModelSelection({
      registry: remote.registry,
      threadRef: ref,
      selection: MODEL_B,
      stateAtom: remote.stateAtom,
      dispatch: () => dispatch.promise,
    });

    const appliedB = server.updateMetadata(MODEL_B);
    host.apply(appliedB.thread, appliedB.sequence);
    remote.apply(appliedB.thread, appliedB.sequence);
    const appliedC = server.updateMetadata(MODEL_C);
    host.apply(appliedC.thread, appliedC.sequence);
    remote.apply(appliedC.thread, appliedC.sequence);
    await settle();
    // Still holding B until the receipt lands, even though C already applied.
    expect(remote.picker()).toEqual(MODEL_B);
    expect(host.picker()).toEqual(MODEL_C);

    dispatch.resolve({ sequence: appliedB.sequence });
    await save;
    expect(remote.pending()).toBeNull();
    expect(remote.picker()).toEqual(MODEL_C);
  });

  it("shows server truth and rejects when the save fails", async () => {
    const client = makeClient(ref, THREAD, 7);
    const failure = new Error("Thread no longer exists");
    const save = saveThreadModelSelection({
      registry: client.registry,
      threadRef: ref,
      selection: MODEL_B,
      stateAtom: client.stateAtom,
      dispatch: () => Promise.reject(failure),
    });
    expect(client.picker()).toEqual(MODEL_B);
    await expect(save).rejects.toBe(failure);
    expect(client.pending()).toBeNull();
    expect(isModelSelectionSaving(client.registry, ref)).toBe(false);
    expect(client.picker()).toEqual(MODEL_A);
  });

  it("ignores a second pick while one is saving", async () => {
    const server = makeServer(THREAD, 7);
    const client = makeClient(ref, THREAD, 7);
    const dispatch = deferred<{ sequence: number }>();
    let dispatches = 0;
    const first = saveThreadModelSelection({
      registry: client.registry,
      threadRef: ref,
      selection: MODEL_B,
      stateAtom: client.stateAtom,
      dispatch: () => {
        dispatches += 1;
        return dispatch.promise;
      },
    });
    await saveThreadModelSelection({
      registry: client.registry,
      threadRef: ref,
      selection: MODEL_C,
      stateAtom: client.stateAtom,
      dispatch: () => {
        dispatches += 1;
        return dispatch.promise;
      },
    });
    expect(dispatches).toBe(1);
    expect(client.picker()).toEqual(MODEL_B);

    const applied = server.updateMetadata(MODEL_B);
    client.apply(applied.thread, applied.sequence);
    dispatch.resolve({ sequence: applied.sequence });
    await first;
    expect(client.pending()).toBeNull();
  });

  it("keeps pending state isolated per environment for the same thread id", async () => {
    const otherRef: ScopedThreadRef = {
      environmentId: EnvironmentId.make("env-2"),
      threadId: THREAD_ID,
    };
    const client = makeClient(ref, THREAD, 7);
    const other = makeClient(otherRef, THREAD, 7);
    const dispatch = deferred<{ sequence: number }>();
    const save = saveThreadModelSelection({
      registry: client.registry,
      threadRef: ref,
      selection: MODEL_B,
      stateAtom: client.stateAtom,
      dispatch: () => dispatch.promise,
    });
    expect(client.registry.get(pendingModelSelectionAtom(ref))).toEqual(MODEL_B);
    expect(client.registry.get(pendingModelSelectionAtom(otherRef))).toBeNull();
    expect(isModelSelectionSaving(client.registry, otherRef)).toBe(false);
    expect(other.pending()).toBeNull();
    expect(client.registry.get(pendingModelSelectionAtom(null))).toBeNull();

    const applied = makeServer(THREAD, 7).updateMetadata(MODEL_B);
    client.apply(applied.thread, applied.sequence);
    dispatch.resolve({ sequence: applied.sequence });
    await save;
    expect(other.picker()).toEqual(MODEL_A);
  });
});

describe("getStartedThreadModelChangeBlockReason", () => {
  const providers = [
    { instanceId: codex, requiresNewThreadForModelChange: true },
    { instanceId: ProviderInstanceId.make("claudeAgent"), requiresNewThreadForModelChange: false },
  ];

  it("blocks only started sessions on providers that require a new thread", () => {
    const claude: ModelSelection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "opus",
    };
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: false,
        currentModelSelection: MODEL_A,
        nextModelSelection: MODEL_B,
      }),
    ).toBeNull();
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: MODEL_A,
        nextModelSelection: { instanceId: codex, model: "ModelA" },
      }),
    ).toBeNull();
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: MODEL_A,
        nextModelSelection: MODEL_B,
      })?.title,
    ).toBe("Start a new chat to change models");
    // The session's provider instance wins over stale picker metadata.
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: claude,
        currentProviderInstanceId: codex,
        nextModelSelection: { ...claude, model: "sonnet" },
      }),
    ).not.toBeNull();
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: claude,
        nextModelSelection: { ...claude, model: "sonnet" },
      }),
    ).toBeNull();
  });
});
