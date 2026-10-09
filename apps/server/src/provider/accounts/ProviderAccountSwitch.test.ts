import { accountThreadShell } from "./accountTestFixtures.ts";
import { ProviderSessionId } from "@t3tools/contracts";
import { ProviderSessionCloseError } from "../../orchestration-v2/ProviderSessionManager.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { Deferred, Effect, Fiber, Path, PubSub, Queue, Schema, Semaphore } from "effect";
import { TestClock } from "effect/testing";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";

import { resolveCodexHomeLayout } from "../Drivers/CodexHomeLayout.ts";
import {
  makeProviderAccountSwitch,
  makeProviderAccountSwitchPatch,
  resolveProviderAccountConfig,
} from "./ProviderAccountSwitch.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const codexId = defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));
const snapshot = (instanceId = codexId) => ({
  schemaVersion: 2,
  snapshotSequence: 0,
  archivedThreads: [],
  threads: [accountThreadShell(instanceId)],
});

const settings = decodeSettings({
  providerInstances: {
    [codexId]: { driver: "codex", config: { homePath: "/shared", shadowHomePath: "/old" } },
  },
});

describe("ProviderAccountSwitch config", () => {
  it.effect("reads the default instance config and supplies defaults for missing config", () =>
    Effect.gen(function* () {
      const current = decodeSettings({
        providerInstances: { [codexId]: { driver: "codex", config: { homePath: "/explicit" } } },
      });
      const resolved = yield* resolveProviderAccountConfig(current, "codex");
      expect(resolved.homePath).toBe("/explicit");
      expect(resolved.shadowHomePath).toBe("");
      const empty = decodeSettings({
        providerInstances: { [codexId]: { driver: "codex" } },
      });
      expect((yield* resolveProviderAccountConfig(empty, "codex")).homePath).toBe("");
    }),
  );

  it.effect("returns a typed error for invalid explicit settings", () =>
    Effect.gen(function* () {
      const current = decodeSettings({
        providerInstances: { [codexId]: { driver: "codex", config: { homePath: 123 } } },
      });
      expect(yield* resolveProviderAccountConfig(current, "codex").pipe(Effect.flip)).toMatchObject(
        { _tag: "ProviderAccountError" },
      );
    }),
  );

  it("creates default instances when absent and restores original Default values", () => {
    const empty = decodeSettings({});
    expect(makeProviderAccountSwitchPatch(empty, { driver: "codex", homePath: "/new" })).toEqual({
      providerInstances: { [codexId]: { driver: "codex", config: { shadowHomePath: "/new" } } },
    });
    expect(
      makeProviderAccountSwitchPatch(settings, {
        driver: "codex",
        homePath: "/shared",
        directMode: true,
      }),
    ).toEqual({
      providerInstances: {
        [codexId]: {
          ...settings.providerInstances[codexId],
          config: { homePath: "/shared", shadowHomePath: "" },
        },
      },
    });
    const claudeId = defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent"));
    expect(makeProviderAccountSwitchPatch(empty, { driver: "claudeAgent", homePath: "" })).toEqual({
      providerInstances: { [claudeId]: { driver: "claudeAgent", config: { homePath: "" } } },
    });
  });

  it.effect(
    "preserves envelopes, other instances, raw config and Codex continuation identity",
    () =>
      Effect.gen(function* () {
        const current = decodeSettings({
          providerInstances: {
            [codexId]: {
              driver: "codex",
              displayName: "Personal",
              enabled: false,
              environment: [{ name: "TEST", value: "value" }],
              config: { homePath: "/shared", shadowHomePath: "/old", futureOption: true },
            },
            other: { driver: "codex", config: { homePath: "/other" } },
          },
        });
        const patch = makeProviderAccountSwitchPatch(current, {
          driver: "codex",
          homePath: "/new",
        });
        const next = { ...current, providerInstances: patch.providerInstances! };
        expect(next.providerInstances[ProviderInstanceId.make("other")]).toEqual(
          current.providerInstances[ProviderInstanceId.make("other")],
        );
        expect(next.providerInstances[codexId]).toEqual({
          ...current.providerInstances[codexId],
          config: { homePath: "/shared", shadowHomePath: "/new", futureOption: true },
        });
        const beforeLayout = yield* resolveCodexHomeLayout(
          yield* resolveProviderAccountConfig(current, "codex"),
        );
        const afterLayout = yield* resolveCodexHomeLayout(
          yield* resolveProviderAccountConfig(next, "codex"),
        );
        expect(afterLayout.continuationKey).toBe(beforeLayout.continuationKey);
        expect(afterLayout.sharedHomePath).toBe(beforeLayout.sharedHomePath);
        expect(afterLayout.effectiveHomePath).toBe("/new");
      }).pipe(Effect.provide(Path.layer)),
  );
});

function makeInstance(): ProviderInstance {
  return {
    instanceId: codexId,
    driverKind: ProviderDriverKind.make("codex"),
    displayName: undefined,
    enabled: true,
    continuationIdentity: {
      driverKind: ProviderDriverKind.make("codex"),
      continuationKey: "shared",
    },
    get snapshot(): never {
      throw new Error("Switch must not use a usage snapshot as a rebuild receipt");
    },
    get orchestrationAdapter(): never {
      throw new Error("Switch must not call an adapter directly");
    },
    get textGeneration(): never {
      throw new Error("Switch must not generate text");
    },
  };
}

const makeHarness = Effect.fnUntraced(function* (
  options: {
    otherInstance?: boolean;
    failStop?: boolean;
    blockStop?: boolean;
    blockRebuild?: boolean;
  } = {},
) {
  const registryChanges = yield* PubSub.unbounded<void>();
  const patched = yield* Deferred.make<void>();
  const dispatched = yield* Deferred.make<void>();
  const instanceReads = yield* Queue.unbounded<void>();
  const state = { current: makeInstance() as ProviderInstance | undefined, subscriptions: 0 };
  const trackSubscription = Effect.acquireRelease(
    Effect.sync(() => {
      state.subscriptions++;
    }),
    () =>
      Effect.sync(() => {
        state.subscriptions--;
      }),
  );
  const instances = {
    getInstance: () =>
      Effect.gen(function* () {
        yield* Queue.offer(instanceReads, undefined);
        return state.current;
      }),
    subscribeChanges: Effect.gen(function* () {
      yield* trackSubscription;
      const subscription = yield* PubSub.subscribe(registryChanges);
      order.push("subscribe-registry");
      return subscription;
    }),
  };
  const patches: ServerSettingsPatch[] = [];
  const order: string[] = [];
  const shell = snapshot(options.otherInstance ? ProviderInstanceId.make("codex-other") : codexId);
  const service = makeProviderAccountSwitch({
    instances,
    settings: {
      getSettings: Effect.sync(() => {
        order.push("read-settings");
        return settings;
      }),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          order.push("patch");
          patches.push(patch);
          yield* Deferred.succeed(patched, undefined);
          if (!options.blockRebuild) {
            state.current = makeInstance();
            yield* PubSub.publish(registryChanges, undefined);
          }
          return {
            ...settings,
            providerInstances: patch.providerInstances ?? settings.providerInstances,
          };
        }),
    },
    snapshots: { getShellSnapshot: () => Effect.succeed(shell) },
    sessions: {
      closeInstance: () =>
        Effect.gen(function* () {
          order.push("close");
          yield* Deferred.succeed(dispatched, undefined);
          if (options.blockStop) return yield* Effect.never;
          if (options.failStop)
            return yield* new ProviderSessionCloseError({
              providerSessionId: ProviderSessionId.make("session-1"),
            });
          order.push("completion");
        }),
    },
  });
  return {
    ...service,
    patches,
    order,
    instances,
    state,
    registryChanges,
    patched,
    dispatched,
    instanceReads,
  };
});

describe("ProviderAccountSwitch orchestration", () => {
  it.effect(
    "never routes Claude through restart orchestration even with interruption requested",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const error = yield* harness
          .switchAccount({
            driver: "claudeAgent",
            homePath: "/unused",
            interruptRunning: true,
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ProviderAccountError",
          message: "Claude accounts must use hot switching.",
        });
        expect(harness.order).toEqual([]);
        expect(harness.patches).toEqual([]);
      }),
  );

  it.effect("refuses busy instances without dispatch or patch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(
        yield* harness.switchAccount({ driver: "codex", homePath: "/new" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "ProviderAccountBusyError", runningTurnCount: 1 });
      expect(harness.order).toEqual([]);
    }),
  );

  it.effect(
    "rechecks busy immediately before patching without interrupting a newly started turn",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        let patched = false;
        const { instances } = yield* makeHarness();
        const service = makeProviderAccountSwitch({
          instances,
          settings: {
            getSettings: Effect.succeed(settings),
            updateSettings: () =>
              Effect.sync(() => {
                patched = true;
                return settings;
              }),
          },
          snapshots: {
            getShellSnapshot: () =>
              Effect.sync(() => {
                reads++;
                return reads === 1 ? { ...snapshot(), threads: [] } : snapshot();
              }),
          },
          sessions: {
            closeInstance: () => Effect.die("Automatic switching must not interrupt a turn"),
          },
        });
        expect(
          yield* service
            .switchAccount({ driver: "codex", homePath: "/new", interruptRunning: false })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "ProviderAccountBusyError", runningTurnCount: 1 });
        expect(reads).toBe(2);
        expect(patched).toBe(false);
      }),
  );

  it.effect("does not block on a different session instance", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ otherInstance: true });
      yield* harness.switchAccount({ driver: "codex", homePath: "/new" });
      expect(harness.order).toEqual(["read-settings", "subscribe-registry", "patch"]);
    }),
  );

  it.effect("awaits V2 session closure before patching", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.switchAccount({ driver: "codex", homePath: "/new", interruptRunning: true });
      expect(harness.order).toEqual([
        "close",
        "completion",
        "read-settings",
        "subscribe-registry",
        "patch",
      ]);
      expect(harness.patches).toEqual([
        makeProviderAccountSwitchPatch(settings, { driver: "codex", homePath: "/new" }),
      ]);
    }),
  );

  it.effect("does not patch when the V2 session shutdown fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ failStop: true });
      expect(
        yield* harness
          .switchAccount({ driver: "codex", homePath: "/new", interruptRunning: true })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "ProviderAccountError" });
      expect(harness.patches).toEqual([]);
    }),
  );
});

describe("ProviderAccountSwitch bounded receipts", () => {
  it.effect(
    "waits for the target instance, ignoring unrelated changes and unavailable instances",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ otherInstance: true, blockRebuild: true });
        const fiber = yield* harness
          .switchAccount({ driver: "codex", homePath: "/new" })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(harness.patched);
        // Capture-before and post-patch reads have completed before sending receipts.
        yield* Queue.take(harness.instanceReads);
        yield* Queue.take(harness.instanceReads);
        yield* PubSub.publish(harness.registryChanges, undefined);
        yield* Queue.take(harness.instanceReads);
        expect(fiber.pollUnsafe()).toBeUndefined();
        harness.state.current = undefined;
        yield* PubSub.publish(harness.registryChanges, undefined);
        yield* Queue.take(harness.instanceReads);
        expect(fiber.pollUnsafe()).toBeUndefined();
        harness.state.current = makeInstance();
        yield* PubSub.publish(harness.registryChanges, undefined);
        yield* Fiber.join(fiber);
        expect(harness.state.subscriptions).toBe(0);
      }),
  );

  it.effect("does not wait for a rebuild when the config patch is a no-op", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ otherInstance: true, blockRebuild: true });
      yield* harness.switchAccount({ driver: "codex", homePath: "/old" });
      expect(harness.patches).toHaveLength(1);
      expect(harness.state.subscriptions).toBe(0);
    }),
  );

  it.effect(
    "times out rebuilding after 20 seconds and releases the subscription and mutation",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ otherInstance: true, blockRebuild: true });
        const mutation = yield* Semaphore.make(1);
        const fiber = yield* harness
          .switchAccount({ driver: "codex", homePath: "/new" })
          .pipe(mutation.withPermit, Effect.flip, Effect.forkScoped);
        yield* Deferred.await(harness.patched);
        yield* TestClock.adjust(19_999);
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(1);
        expect(yield* Fiber.join(fiber)).toMatchObject({
          _tag: "ProviderAccountError",
          message: expect.stringContaining("Timed out rebuilding"),
        });
        expect(harness.state.subscriptions).toBe(0);
        expect(yield* mutation.withPermit(Effect.succeed("released"))).toBe("released");
      }),
  );

  it.effect("times out stopping after 20 seconds without patching and releases the mutation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ blockStop: true });
      const mutation = yield* Semaphore.make(1);
      const fiber = yield* harness
        .switchAccount({ driver: "codex", homePath: "/new", interruptRunning: true })
        .pipe(mutation.withPermit, Effect.flip, Effect.forkScoped);
      yield* Deferred.await(harness.dispatched);
      yield* TestClock.adjust(19_999);
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(1);
      expect(yield* Fiber.join(fiber)).toMatchObject({
        _tag: "ProviderAccountError",
        message: expect.stringContaining("Timed out stopping"),
      });
      expect(harness.patches).toEqual([]);
      expect(harness.state.subscriptions).toBe(0);
      expect(yield* mutation.withPermit(Effect.succeed("released"))).toBe("released");
    }),
  );
});
