// fork: push-driven account rotation; all service access is injected.
import type {
  ProviderAccountAutoSwitch,
  ProviderAccountAutoSwitchEvent,
  ProviderAccountAutoSwitchLastSwitch,
  ProviderAccountBusyError,
  ProviderAccountDriver,
  ProviderAccountError,
  ProviderAccountGroup,
  ProviderAccountId,
  ServerProvider,
} from "@t3tools/contracts";
import { Clock, DateTime, Effect, Fiber, Queue, Stream } from "effect";

import type { ProviderAccountAutoSwitch as PersistedConfig } from "./ProviderAccountRegistry.ts";
import { chooseNextAccount } from "./autoSwitchPolicy.ts";

export interface ProviderAccountAutoSwitchRead {
  readonly config: PersistedConfig;
  /** Must come from list(), which masks the previous active account's usage after a switch. */
  readonly group: ProviderAccountGroup;
  readonly loginInProgress: readonly string[];
  readonly probeBlocked?: ReadonlySet<ProviderAccountId>;
  readonly probeWakeAt?: ReadonlyMap<ProviderAccountId, number>;
}

export type ProviderAccountAutoSwitchState = Pick<
  ProviderAccountAutoSwitch,
  "state" | "message" | "pendingTargetAccountId" | "wakeAt"
>;

export interface ProviderAccountAutoSwitchDependencies {
  readonly read: (
    driver: ProviderAccountDriver,
  ) => Effect.Effect<ProviderAccountAutoSwitchRead, ProviderAccountError>;
  readonly refresh: (
    accountIds: readonly ProviderAccountId[],
  ) => Effect.Effect<unknown, ProviderAccountError>;
  /** Unlocked switch with interruptRunning:false; only restart-mode groups check busy. */
  readonly switchAccount: (
    accountId: ProviderAccountId,
  ) => Effect.Effect<unknown, ProviderAccountError | ProviderAccountBusyError>;
  /** Persist the successful automatic switch. */
  readonly persistLastSwitch: (
    driver: ProviderAccountDriver,
    lastSwitch: ProviderAccountAutoSwitchLastSwitch,
  ) => Effect.Effect<unknown, ProviderAccountError>;
  readonly withMutation: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly providerChanges: Stream.Stream<readonly ServerProvider[]>;
  /** Delivered after the session projection commits; restart-mode switches recheck busy. */
  readonly idleChanges: Stream.Stream<ProviderAccountDriver>;
  readonly publish: (event: ProviderAccountAutoSwitchEvent) => Effect.Effect<void>;
}

const drivers = ["claudeAgent", "codex"] as const;
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));

export const makeProviderAccountAutoSwitch = Effect.fn("makeProviderAccountAutoSwitch")(function* (
  deps: ProviderAccountAutoSwitchDependencies,
) {
  // Captured here so notify/clear never require a caller-owned scope for timers.
  const scope = yield* Effect.scope;
  const makeRuntime = Effect.fnUntraced(function* () {
    return {
      state: { state: "off" } as ProviderAccountAutoSwitchState,
      queue: yield* Queue.sliding<void>(1),
      generation: 0,
      enabled: false,
      threshold: 10,
      needsIdle: false,
      usageKnown: false,
      recent: [] as number[],
      timer: undefined as Fiber.Fiber<void> | undefined,
      subscriptions: undefined as Fiber.Fiber<void> | undefined,
      pendingKey: undefined as string | undefined,
    };
  });
  const runtimes = { claudeAgent: yield* makeRuntime(), codex: yield* makeRuntime() };
  let idleSubscription: Fiber.Fiber<void> | undefined;
  const needsIdle = (driver: ProviderAccountDriver) =>
    runtimes[driver].enabled && runtimes[driver].needsIdle;
  const notify = (driver: ProviderAccountDriver) =>
    Queue.offer(runtimes[driver].queue, undefined).pipe(Effect.asVoid);
  const stopTimer = Effect.fnUntraced(function* (driver: ProviderAccountDriver) {
    const runtime = runtimes[driver];
    const timer = runtime.timer;
    runtime.timer = undefined;
    if (timer) yield* Fiber.interrupt(timer);
  });
  const clear = Effect.fnUntraced(function* (driver: ProviderAccountDriver) {
    const runtime = runtimes[driver];
    runtime.generation++;
    runtime.needsIdle = false;
    runtime.pendingKey = undefined;
    runtime.state = { state: runtime.enabled ? "watching" : "off" };
    yield* stopTimer(driver);
  });
  const subscribe = Effect.fnUntraced(function* (
    driver: ProviderAccountDriver,
    instanceId: string,
  ) {
    const runtime = runtimes[driver];
    if (runtime.subscriptions) return;
    if (!idleSubscription) {
      idleSubscription = yield* deps.idleChanges.pipe(
        Stream.runForEach((changedDriver) =>
          needsIdle(changedDriver) ? notify(changedDriver) : Effect.void,
        ),
        Effect.forkIn(scope),
      );
    }
    let lastProviderKey: string | undefined;
    const providers = deps.providerChanges.pipe(
      Stream.runForEach((providers) =>
        Effect.gen(function* () {
          const provider = providers.find((item) => item.instanceId === instanceId);
          if (!provider || !runtime.enabled) return;
          const known =
            (provider.usageLimits?.windows.length ?? 0) > 0 &&
            provider.usageLimits?.unavailable?.reason !== "unsupported";
          const becameKnown = !runtime.usageKnown && known;
          runtime.usageKnown = known;
          const key = `${provider.usageLimits?.checkedAt ?? ""}:${provider.auth.status}:${provider.status}:${known}`;
          if (key === lastProviderKey && !becameKnown) return;
          lastProviderKey = key;
          const now = yield* Clock.currentTimeMillis;
          const low = provider.usageLimits?.windows.some(
            (window) => window.kind !== "other" && 100 - window.usedPercent <= runtime.threshold,
          );
          if (
            becameKnown ||
            low ||
            provider.auth.status === "unauthenticated" ||
            provider.status === "error" ||
            (runtime.state.wakeAt !== undefined && Date.parse(runtime.state.wakeAt) <= now)
          )
            yield* notify(driver);
        }),
      ),
    );
    runtime.subscriptions = yield* providers.pipe(Effect.forkIn(scope));
  });
  const evaluate = Effect.fnUntraced(function* (driver: ProviderAccountDriver) {
    const runtime = runtimes[driver];
    const generation = runtime.generation;
    const probed = new Set<ProviderAccountId>();
    const failed = new Set<ProviderAccountId>();
    // At most two accounts per probe, and each account at most once per evaluation.
    // Account mutations invalidate this evaluation instead of extending its probe budget.
    let remainingProbes: number | undefined;
    yield* stopTimer(driver);
    while (generation === runtime.generation) {
      const next = yield* deps.withMutation(
        Effect.gen(function* () {
          if (generation !== runtime.generation) return;
          const { config, group, loginInProgress, probeBlocked, probeWakeAt } =
            yield* deps.read(driver);
          if (generation !== runtime.generation) return;
          runtime.enabled = config.enabled;
          runtime.threshold = config.thresholdPercent;
          if (!config.enabled) {
            runtime.state = { state: "off" };
            runtime.needsIdle = false;
            runtime.pendingKey = undefined;
            if (runtime.subscriptions) {
              yield* Fiber.interrupt(runtime.subscriptions);
              runtime.subscriptions = undefined;
            }
            if (idleSubscription && !drivers.some((item) => runtimes[item].enabled)) {
              yield* Fiber.interrupt(idleSubscription);
              idleSubscription = undefined;
            }
            return;
          }
          const active = group.accounts.find((account) => account.id === group.activeAccountId);
          runtime.usageKnown =
            (active?.usage?.windows.length ?? 0) > 0 &&
            active?.usage?.unavailable?.reason !== "unsupported";
          yield* subscribe(driver, group.instanceId);
          if (!active) {
            runtime.state = { state: "watching", message: "Waiting for an active account." };
            runtime.needsIdle = false;
            runtime.pendingKey = undefined;
            return;
          }
          remainingProbes ??= group.accounts.length;
          const now = yield* Clock.currentTimeMillis;
          runtime.recent = runtime.recent.filter((at) => at > now - 3_600_000);
          const view = (account: typeof active) => ({
            ...account,
            loginInProgress: loginInProgress.includes(account.id),
            // A failed refresh must not promote retained numbers to fresh via `probed`.
            ...(failed.has(account.id) && account.usage
              ? {
                  usage: {
                    ...account.usage,
                    unavailable: { reason: "probeFailed" as const },
                  },
                }
              : {}),
          });
          const decision = chooseNextAccount({
            now,
            config,
            active: view(active),
            candidates: group.accounts.map(view),
            probed,
            ...(probeBlocked ? { probeBlocked } : {}),
            ...(probeWakeAt ? { probeWakeAt } : {}),
            recentAutoSwitchAts: runtime.recent,
            ...(config.lastSwitch ? { lastSwitchAt: Date.parse(config.lastSwitch.at) } : {}),
          });
          runtime.needsIdle =
            group.switchMode === "restart" &&
            (active.status === "signedOut" ||
              active.status === "error" ||
              (active.usage?.windows.some(
                (window) =>
                  window.kind !== "other" && 100 - window.usedPercent <= config.thresholdPercent,
              ) ??
                false));
          if (decision.kind === "probe") return decision;
          if (decision.kind === "stay") {
            const state =
              decision.code === "circuitBreaker"
                ? "paused"
                : decision.code === "healthy"
                  ? "watching"
                  : "waiting";
            const changed =
              runtime.state.state !== state || runtime.state.message !== decision.reason;
            runtime.pendingKey = undefined;
            runtime.state = {
              state,
              message: decision.reason,
              ...(decision.wakeAt !== undefined ? { wakeAt: iso(decision.wakeAt) } : {}),
            };
            if (decision.wakeAt !== undefined && decision.wakeAt > now) {
              runtime.timer = yield* Effect.sleep(decision.wakeAt - now).pipe(
                Effect.andThen(notify(driver)),
                Effect.forkIn(scope),
              );
            }
            if (
              changed &&
              (decision.code === "allExhausted" ||
                decision.code === "noCandidates" ||
                decision.code === "circuitBreaker")
            ) {
              yield* deps.publish({ _tag: "blocked", driver, reason: decision.reason });
            }
            return;
          }
          const target = group.accounts.find((account) => account.id === decision.targetAccountId);
          if (!target) return;
          // Hot switches preserve running sessions. Restart switches recheck busy under
          // this mutation; a turn starting between that check and settings patch is a v1 race.
          const switched = yield* deps.switchAccount(target.id).pipe(
            Effect.as(true),
            Effect.catchTag("ProviderAccountBusyError", (error) =>
              Effect.gen(function* () {
                if (group.switchMode === "hot") return yield* error;
                runtime.needsIdle = true;
                runtime.state = {
                  state: "pending",
                  message: decision.reason,
                  pendingTargetAccountId: target.id,
                };
                const key = `${target.id}:${error.runningTurnCount}:${decision.reason}`;
                if (runtime.pendingKey !== key) {
                  runtime.pendingKey = key;
                  yield* deps.publish({
                    _tag: "pending",
                    driver,
                    toAccountId: target.id,
                    toLabel: target.label,
                    runningTurnCount: error.runningTurnCount,
                    reason: decision.reason,
                  });
                }
                return false;
              }),
            ),
          );
          if (!switched) return;
          const at = yield* Clock.currentTimeMillis;
          runtime.recent.push(at);
          runtime.pendingKey = undefined;
          runtime.needsIdle = false;
          runtime.state = { state: "watching", message: decision.reason };
          const lastSwitch = {
            at: iso(at),
            fromAccountId: active.id,
            toAccountId: target.id,
            trigger: decision.trigger,
            reason: decision.reason,
          };
          yield* deps.persistLastSwitch(driver, lastSwitch);
          yield* deps.publish({ _tag: "switched", driver, ...lastSwitch, toLabel: target.label });
          // Re-read via list(), never via the triggering provider snapshot.
          yield* notify(driver);
        }),
      );
      if (!next || generation !== runtime.generation) return;
      const ids = next.accountIds
        .filter((id) => !probed.has(id))
        .slice(0, Math.min(2, remainingProbes ?? 0));
      if (ids.length === 0) return;
      remainingProbes = (remainingProbes ?? 0) - ids.length;
      for (const id of ids) probed.add(id);
      // Network probes deliberately do not own the mutation semaphore.
      yield* deps.refresh(ids).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            for (const id of ids) failed.add(id);
          }),
        ),
      );
    }
  });
  for (const driver of drivers) {
    yield* Queue.take(runtimes[driver].queue).pipe(
      Effect.andThen(
        evaluate(driver).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              runtimes[driver].pendingKey = undefined;
              runtimes[driver].state = {
                state: "paused",
                message: "Auto-switch could not check accounts. It will retry on the next update.",
              };
              yield* Effect.logWarning("Provider account auto-switch evaluation failed", cause);
            }),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkIn(scope),
    );
    yield* notify(driver);
  }
  return {
    getState: (driver: ProviderAccountDriver) => runtimes[driver].state,
    needsIdle,
    notify,
    clear,
  };
});
