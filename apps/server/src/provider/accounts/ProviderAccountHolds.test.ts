// fork: provider accounts
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { makeProviderAccountHolds } from "./ProviderAccountHolds.ts";

describe("makeProviderAccountHolds", () => {
  // S8: a switch waits for in-flight probes of its accounts and blocks new ones meanwhile.
  it.effect("an exclusive hold waits for in-flight holds and blocks new ones until done", () =>
    Effect.gen(function* () {
      const holds = makeProviderAccountHolds();
      const order: string[] = [];
      const probeStarted = yield* Deferred.make<void>();
      const releaseProbe = yield* Deferred.make<void>();
      const probe = yield* holds
        .shared("a")(
          Effect.gen(function* () {
            yield* Deferred.succeed(probeStarted, undefined);
            yield* Deferred.await(releaseProbe);
            order.push("probe");
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(probeStarted);
      const switchStarted = yield* Deferred.make<void>();
      const releaseSwitch = yield* Deferred.make<void>();
      const switching = yield* holds
        .exclusive(["b", "a"])(
          Effect.gen(function* () {
            order.push("switch");
            yield* Deferred.succeed(switchStarted, undefined);
            yield* Deferred.await(releaseSwitch);
          }),
        )
        .pipe(Effect.forkChild);
      // Unrelated accounts are never blocked.
      yield* holds.shared("c")(Effect.sync(() => order.push("other account")));
      for (let step = 0; step < 10; step++) yield* Effect.yieldNow;
      expect(order).toEqual(["other account"]);
      yield* Deferred.succeed(releaseProbe, undefined);
      yield* Deferred.await(switchStarted);
      // A new probe of a switching account waits for the switch.
      const late = yield* holds
        .shared("b")(Effect.sync(() => order.push("late probe")))
        .pipe(Effect.forkChild);
      for (let step = 0; step < 10; step++) yield* Effect.yieldNow;
      expect(order).toEqual(["other account", "probe", "switch"]);
      yield* Deferred.succeed(releaseSwitch, undefined);
      yield* Fiber.join(switching);
      yield* Fiber.join(late);
      yield* Fiber.join(probe);
      expect(order).toEqual(["other account", "probe", "switch", "late probe"]);
    }),
  );

  it.effect("a scoped hold lasts until its scope closes", () =>
    Effect.gen(function* () {
      const holds = makeProviderAccountHolds();
      const order: string[] = [];
      const release = yield* Deferred.make<void>();
      const held = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* holds.sharedScoped("a");
          yield* Deferred.await(release);
          order.push("start finished");
        }),
      ).pipe(Effect.forkChild);
      for (let step = 0; step < 10; step++) yield* Effect.yieldNow;
      const switching = yield* holds
        .exclusive(["a"])(Effect.sync(() => order.push("switch")))
        .pipe(Effect.forkChild);
      for (let step = 0; step < 10; step++) yield* Effect.yieldNow;
      expect(order).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(held);
      yield* Fiber.join(switching);
      expect(order).toEqual(["start finished", "switch"]);
    }),
  );
});
