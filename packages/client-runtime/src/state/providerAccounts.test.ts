import { expect, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderAccountId,
  WS_METHODS,
  type ProviderAccountAutoSwitchEvent,
  type ProviderAccountLoginEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createProviderAccountsEnvironmentAtoms } from "./providerAccounts.ts";

interface OpenedLogin {
  readonly events: Queue.Queue<ProviderAccountLoginEvent>;
  readonly closed: Deferred.Deferred<void>;
}

/** Runs `lookup` as if the GC had collected every weakly held function, but no atom. */
function withCollectedWeakFunctions<A>(lookup: () => A): A {
  const deref = WeakRef.prototype.deref;
  const spy = vi.spyOn(WeakRef.prototype, "deref").mockImplementation(function (
    this: WeakRef<object>,
  ) {
    const value = deref.call(this);
    return typeof value === "function" ? undefined : value;
  });
  try {
    return lookup();
  } finally {
    spy.mockRestore();
  }
}

it.effect(
  "starts one login across dual subscriptions, list refresh, code submission and family GC",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const target = new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("accounts"),
          label: "Accounts",
          httpBaseUrl: "https://example.test",
          wsBaseUrl: "wss://example.test",
        });
        const opened = yield* Queue.unbounded<OpenedLogin>();
        let starts = 0;
        let lists = 0;
        let submits = 0;
        const client = {
          [WS_METHODS.providerAccountsList]: () =>
            Effect.sync(() => {
              lists++;
              return { groups: [] };
            }),
          [WS_METHODS.providerAccountsSubmitLoginCode]: () =>
            Effect.sync(() => {
              submits++;
            }),
          [WS_METHODS.providerAccountsStartLogin]: () =>
            Stream.unwrap(
              Effect.gen(function* () {
                starts++;
                const events = yield* Queue.unbounded<ProviderAccountLoginEvent>();
                const closed = yield* Deferred.make<void>();
                yield* Queue.offer(opened, { events, closed });
                return Stream.fromQueue(events).pipe(
                  Stream.ensuring(Deferred.succeed(closed, undefined)),
                );
              }),
            ),
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.of({
          target,
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected",
          }),
          session: yield* SubscriptionRef.make(Option.some({ client } as RpcSession)),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const environments = EnvironmentRegistry.of({
          run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
          runStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry["Service"]);
        const atoms = createProviderAccountsEnvironmentAtoms(
          Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)),
        );
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        );

        // The account dialog keeps the list mounted while a login runs.
        const list = atoms.list({ environmentId: target.environmentId, input: {} });
        registry.mount(list);
        const settledList = () =>
          AtomRegistry.toStream(registry, list).pipe(
            Stream.filter((result) => AsyncResult.isSuccess(result) && !result.waiting),
            Stream.runHead,
          );
        yield* settledList();

        // AddAccountPanel: useEnvironmentQuery plus the immediate login-id subscription.
        const request = {
          environmentId: target.environmentId,
          input: { driver: "claudeAgent" as const, attempt: 1 },
        };
        const atom = atoms.loginEvents(request);
        const stopQuery = registry.subscribe(atom, () => {});
        let loginId: string | undefined;
        const stopLoginId = registry.subscribe(
          atom,
          (result) => {
            if (AsyncResult.isSuccess(result) && result.value._tag === "started") {
              loginId = result.value.loginId;
            }
          },
          { immediate: true },
        );
        const first = yield* Queue.take(opened);
        yield* Queue.offer(first.events, {
          _tag: "started",
          loginId: "login-1",
          accountId: ProviderAccountId.make("account-1"),
        });
        yield* AtomRegistry.toStream(registry, atom).pipe(
          Stream.filter(AsyncResult.isSuccess),
          Stream.runHead,
        );
        yield* settledList();
        expect(loginId).toBe("login-1");

        // The started event and an explicit refresh both re-read the list.
        const reads = lists;
        registry.refresh(list);
        yield* settledList();
        expect(lists).toBeGreaterThan(reads);

        // Pasting the code settles a command that invalidates the list again.
        const submitted = yield* Effect.promise(() =>
          atoms.submitLoginCode.run(registry, {
            environmentId: target.environmentId,
            input: { loginId: loginId!, code: "code" },
          }),
        );
        expect(submitted._tag).toBe("Success");
        expect(submits).toBe(1);
        yield* settledList();
        expect(starts).toBe(1);

        // A re-render after GC must resolve to the mounted atom, not start a new login.
        const rendered = withCollectedWeakFunctions(() =>
          atoms.loginEvents({ ...request, input: { ...request.input } }),
        );
        expect(rendered).toBe(atom);
        const stopRendered = registry.subscribe(rendered, () => {}, { immediate: true });
        expect(starts).toBe(1);
        stopRendered();
        stopLoginId();
        stopQuery();
        yield* Deferred.await(first.closed);

        // "Try again" is the only way to start another login.
        const retry = atoms.loginEvents({ ...request, input: { ...request.input, attempt: 2 } });
        expect(retry).not.toBe(atom);
        const stopRetry = registry.mount(retry);
        const second = yield* Queue.take(opened);
        expect(starts).toBe(2);
        stopRetry();
        yield* Deferred.await(second.closed);
      }),
    ),
);

it.effect("a command resolves only after the mounted list shows its outcome", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("accounts"),
        label: "Accounts",
        httpBaseUrl: "https://example.test",
        wsBaseUrl: "wss://example.test",
      });
      let label = "Before";
      // Once the rename landed, the next list read blocks until the test releases it.
      let gated = false;
      const listCalled = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const snapshot = () => ({
        groups: [
          {
            driver: "codex" as const,
            switchMode: "restart" as const,
            instanceId: "codex",
            accounts: [
              {
                id: ProviderAccountId.make("work"),
                driver: "codex" as const,
                label,
                kind: "managed" as const,
                status: "ready" as const,
                active: true,
              },
            ],
            autoSwitch: {
              enabled: false,
              thresholdPercent: 10,
              weeklyThresholdPercent: 2,
              state: "off" as const,
            },
          },
        ],
      });
      const client = {
        [WS_METHODS.providerAccountsList]: () =>
          Effect.gen(function* () {
            if (gated) {
              yield* Deferred.succeed(listCalled, undefined);
              yield* Deferred.await(release);
            }
            return snapshot();
          }),
        [WS_METHODS.providerAccountsRename]: () =>
          Effect.sync(() => {
            label = "After";
            gated = true;
            return snapshot();
          }),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
        }),
        session: yield* SubscriptionRef.make(Option.some({ client } as RpcSession)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const environments = EnvironmentRegistry.of({
        run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        runStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry["Service"]);
      const atoms = createProviderAccountsEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)),
      );
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const list = atoms.list({ environmentId: target.environmentId, input: {} });
      registry.mount(list);
      const shownLabel = () => {
        const result = registry.get(list);
        return AsyncResult.isSuccess(result) ? result.value.groups[0]?.accounts[0]?.label : null;
      };
      yield* AtomRegistry.toStream(registry, list).pipe(
        Stream.filter((result) => AsyncResult.isSuccess(result) && !result.waiting),
        Stream.runHead,
      );
      expect(shownLabel()).toBe("Before");

      let labelAtResolve: string | null | undefined;
      const renamed = atoms.rename
        .run(registry, {
          environmentId: target.environmentId,
          input: { accountId: ProviderAccountId.make("work"), label: "After" },
        })
        .then((result) => {
          labelAtResolve = shownLabel();
          return result;
        });
      // The list refresh is in flight and still shows the old label. Give a command that
      // doesn't wait every chance to resolve anyway; passing never depends on this.
      yield* Deferred.await(listCalled);
      yield* Effect.raceFirst(
        Effect.promise(() => renamed),
        Effect.yieldNow.pipe(Effect.repeat({ times: 20 })),
      );
      expect(labelAtResolve).toBeUndefined();
      expect(shownLabel()).toBe("Before");
      yield* Deferred.succeed(release, undefined);
      const result = yield* Effect.promise(() => renamed);
      expect(result._tag).toBe("Success");
      expect(labelAtResolve).toBe("After");
    }),
  ),
);

it.effect("an activity hint refetches only the open activity log; other events the list", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("accounts"),
        label: "Accounts",
        httpBaseUrl: "https://example.test",
        wsBaseUrl: "wss://example.test",
      });
      const events = yield* Queue.unbounded<ProviderAccountAutoSwitchEvent>();
      let lists = 0;
      let reads = 0;
      const client = {
        [WS_METHODS.providerAccountsList]: () =>
          Effect.sync(() => {
            lists++;
            return { groups: [] };
          }),
        [WS_METHODS.providerAccountsActivity]: () =>
          Effect.sync(() => {
            reads++;
            return { entries: [] };
          }),
        [WS_METHODS.providerAccountsAutoSwitchEvents]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
        }),
        session: yield* SubscriptionRef.make(Option.some({ client } as RpcSession)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const environments = EnvironmentRegistry.of({
        run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        runStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry["Service"]);
      const atoms = createProviderAccountsEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)),
      );
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const environmentId = target.environmentId;
      const list = atoms.list({ environmentId, input: {} });
      const activity = atoms.activity({ environmentId, input: { driver: "codex", limit: 100 } });
      const settled = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
        AtomRegistry.toStream(registry, atom).pipe(
          Stream.filter((result) => AsyncResult.isSuccess(result) && !result.waiting),
          Stream.runHead,
        );
      registry.mount(list);
      registry.mount(activity);
      const received = yield* Queue.unbounded<void>();
      registry.subscribe(
        atoms.autoSwitchEvents({ environmentId, input: {} }),
        (result) => {
          if (AsyncResult.isSuccess(result)) Queue.offerUnsafe(received, undefined);
        },
        { immediate: true },
      );
      yield* settled(list);
      yield* settled(activity);
      expect({ lists, reads }).toEqual({ lists: 1, reads: 1 });

      yield* Queue.offer(events, { _tag: "changed", driver: "codex", activity: true });
      yield* Queue.take(received);
      yield* settled(activity);
      expect({ lists, reads }).toEqual({ lists: 1, reads: 2 });

      yield* Queue.offer(events, { _tag: "changed", driver: "codex" });
      yield* Queue.take(received);
      yield* settled(list);
      expect({ lists, reads }).toEqual({ lists: 2, reads: 2 });
    }),
  ),
);
