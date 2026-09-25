import { describe, expect, it } from "@effect/vitest";
import {
  ProviderAccountBusyError,
  ProviderAccountError,
  ProviderAccountGroup,
  ProviderAccountId,
  type ProviderAccountAutoSwitchEvent,
  type ProviderAccountAutoSwitchLastSwitch,
  type ProviderAccountDriver,
  ServerProvider,
} from "@t3tools/contracts";
import { Clock, Deferred, Effect, Queue, Schema, Semaphore, Stream } from "effect";
import { TestClock } from "effect/testing";

import { makeProviderAccountAutoSwitch } from "./ProviderAccountAutoSwitch.ts";
import type { ProviderAccountAutoSwitchRead } from "./ProviderAccountAutoSwitch.ts";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const personal = ProviderAccountId.make("personal");
const work = ProviderAccountId.make("work");
const decodeGroup = Schema.decodeUnknownSync(ProviderAccountGroup);
const group = (
  used = 95,
  candidateUsed = 20,
  reset = 3_600_000,
  driver: ProviderAccountDriver = "codex",
) =>
  decodeGroup({
    driver,
    switchMode: driver === "claudeAgent" ? "hot" : "restart",
    instanceId: driver,
    activeAccountId: personal,
    autoSwitch: { enabled: true, thresholdPercent: 10, state: "watching" },
    accounts: [
      {
        id: personal,
        label: "Personal",
        driver,
        kind: "default",
        status: "ready",
        active: true,
        usage: {
          checkedAt: new Date(0).toISOString(),
          windows: [
            {
              id: "session",
              label: "5h",
              kind: "session",
              usedPercent: used,
              resetsAt: new Date(reset).toISOString(),
            },
          ],
        },
      },
      {
        id: work,
        label: "Work",
        driver,
        kind: "managed",
        status: "ready",
        active: false,
        usage: {
          checkedAt: new Date(-600_000).toISOString(),
          windows: [
            {
              id: "session",
              label: "5h",
              kind: "session",
              usedPercent: candidateUsed,
              resetsAt: new Date(reset).toISOString(),
            },
          ],
        },
      },
    ],
  });

const manualSwitch = (snapshot: ProviderAccountAutoSwitchRead, id: ProviderAccountId) => ({
  ...snapshot,
  group: {
    ...snapshot.group,
    activeAccountId: id,
    accounts: snapshot.group.accounts.map((account) => ({ ...account, active: account.id === id })),
  },
});

const makeHarness = Effect.fnUntraced(function* (options?: {
  driver?: ProviderAccountDriver;
  enabled?: boolean;
  claudeEnabled?: boolean;
  unknown?: boolean;
  used?: number;
  candidateUsed?: number;
  busy?: boolean;
  failRefresh?: boolean;
  reset?: number;
  blockRefresh?: boolean;
  failSwitch?: boolean;
  probeBlockedUntil?: number;
  /** The refresh runs but its probes measure nothing (gated or dropped). */
  unmeasured?: boolean;
}) {
  const events = yield* Queue.unbounded<ProviderAccountAutoSwitchEvent>();
  const completions = yield* Queue.unbounded<void>();
  const idle = yield* Queue.unbounded<ProviderAccountDriver>();
  const providers = yield* Queue.unbounded<readonly ServerProvider[]>();
  const probeStarted = yield* Deferred.make<void>();
  const probeRelease = yield* Deferred.make<void>();
  const mutation = yield* Semaphore.make(1);
  const idleSubscribed = yield* Deferred.make<void>();
  const idleStopped = yield* Deferred.make<void>();
  const state = {
    snapshot: {
      config: {
        enabled: options?.enabled ?? true,
        thresholdPercent: 10,
      },
      group: group(options?.used, options?.candidateUsed, options?.reset, options?.driver),
      loginInProgress: [],
    } as ProviderAccountAutoSwitchRead,
    busy: options?.busy ?? false,
    failSwitch: options?.failSwitch ?? false,
    probes: [] as (readonly ProviderAccountId[])[],
    switches: [] as ProviderAccountId[],
    persisted: [] as ProviderAccountAutoSwitchLastSwitch[],
    subscriptions: 0,
    idleSubscriptions: 0,
    claudeEnabled: options?.claudeEnabled ?? false,
  };
  if (options?.unknown) {
    state.snapshot = {
      ...state.snapshot,
      group: {
        ...state.snapshot.group,
        accounts: state.snapshot.group.accounts.map((account) => {
          const { usage: _usage, ...rest } = account;
          return account.active ? rest : account;
        }),
      },
    };
  }
  const reactor = yield* makeProviderAccountAutoSwitch({
    read: (driver) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const snapshot =
          options?.probeBlockedUntil !== undefined && now < options.probeBlockedUntil
            ? {
                ...state.snapshot,
                probeBlocked: new Set([work]),
                probeWakeAt: new Map([[work, options.probeBlockedUntil]]),
              }
            : state.snapshot;
        return driver === snapshot.group.driver
          ? snapshot
          : {
              ...snapshot,
              group: decodeGroup({
                ...snapshot.group,
                driver,
                instanceId: driver,
                switchMode: driver === "claudeAgent" ? "hot" : "restart",
                accounts: snapshot.group.accounts.map((account) => ({ ...account, driver })),
              }),
              config: { enabled: state.claudeEnabled, thresholdPercent: 10 },
            };
      }),
    refresh: (ids) =>
      Effect.gen(function* () {
        state.probes.push(ids);
        yield* Deferred.succeed(probeStarted, undefined);
        if (options?.blockRefresh) yield* Deferred.await(probeRelease);
        if (options?.failRefresh)
          return yield* new ProviderAccountError({ message: "Probe failed" });
        if (options?.unmeasured) return [];
        const now = yield* Clock.currentTimeMillis;
        state.snapshot = {
          ...state.snapshot,
          group: {
            ...state.snapshot.group,
            accounts: state.snapshot.group.accounts.map((account) =>
              ids.includes(account.id) && account.usage
                ? {
                    ...account,
                    usage: { ...account.usage, checkedAt: new Date(now).toISOString() },
                  }
                : account,
            ),
          },
        };
        return ids;
      }),
    switchAccount: (id) =>
      Effect.gen(function* () {
        if (state.failSwitch) return yield* new ProviderAccountError({ message: "Switch failed" });
        if (state.busy && state.snapshot.group.switchMode === "restart")
          return yield* new ProviderAccountBusyError({ runningTurnCount: 2 });
        state.switches.push(id);
        // Service list masks usage until a snapshot for the new home arrives.
        state.snapshot = {
          ...state.snapshot,
          group: {
            ...state.snapshot.group,
            activeAccountId: id,
            accounts: state.snapshot.group.accounts.map((account) => {
              const { usage: _usage, ...rest } = account;
              return account.id === id ? { ...rest, active: true } : { ...account, active: false };
            }),
          },
        };
      }),
    persistLastSwitch: (_driver, lastSwitch) =>
      Effect.sync(() => {
        state.persisted.push(lastSwitch);
        state.snapshot = {
          ...state.snapshot,
          config: { ...state.snapshot.config, lastSwitch },
        };
      }),
    withMutation: (effect) =>
      mutation.withPermit(effect).pipe(Effect.ensuring(Queue.offer(completions, undefined))),
    providerChanges: Stream.unwrap(
      Effect.sync(() => {
        state.subscriptions++;
        return Stream.fromQueue(providers);
      }),
    ),
    idleChanges: Stream.unwrap(
      Effect.gen(function* () {
        state.idleSubscriptions++;
        yield* Effect.addFinalizer(() => Deferred.succeed(idleStopped, undefined));
        yield* Deferred.succeed(idleSubscribed, undefined);
        return Stream.fromQueue(idle);
      }),
    ),
    publish: (event) => Queue.offer(events, event).pipe(Effect.asVoid),
  });
  return {
    reactor,
    state,
    events,
    completions,
    idle,
    providers,
    probeStarted,
    probeRelease,
    idleSubscribed,
    idleStopped,
    mutation,
  };
});

// Receipts from the injected mutation and event publisher, never sleeps or polling.
const completed = (queue: Queue.Queue<void>, count = 1) =>
  Effect.forEach(Array.from({ length: count }), () => Queue.take(queue), { discard: true });

describe("ProviderAccountAutoSwitch", () => {
  it("requires an explicit hot or restart group switch mode", () => {
    expect(group(undefined, undefined, undefined, "claudeAgent").switchMode).toBe("hot");
    const restartGroup = group();
    expect(restartGroup.switchMode).toBe("restart");
    const { switchMode: _switchMode, ...missingMode } = restartGroup;
    expect(() => decodeGroup(missingMode)).toThrow();
    expect(() => decodeGroup({ ...restartGroup, switchMode: "unknown" })).toThrow();
  });

  it.effect("gated probes stay bounded until the retry timer expires", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ probeBlockedUntil: 900_000 });
      expect((yield* Queue.take(h.events))._tag).toBe("blocked");
      yield* completed(h.completions, 2);
      expect(h.state.probes).toEqual([]);
      expect(h.reactor.getState("codex").wakeAt).toBe(new Date(900_000).toISOString());
      yield* h.reactor.notify("codex");
      yield* completed(h.completions);
      expect(h.state.probes).toEqual([]);
      expect(yield* Queue.size(h.completions)).toBe(0);
      yield* TestClock.adjust(900_000);
      expect((yield* Queue.take(h.events))._tag).toBe("switched");
      yield* completed(h.completions, 3);
      expect(h.state.probes).toEqual([[work]]);
      expect(h.state.switches).toEqual([work]);
      expect(yield* Queue.size(h.completions)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("successful hard-exhaustion rotation persists the last switch", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ used: 100 });
      expect((yield* Queue.take(h.events))._tag).toBe("switched");
      expect(h.state.snapshot.config.lastSwitch?.toAccountId).toBe(work);
    }).pipe(Effect.scoped),
  );

  it.effect("a manual switch to a low account still auto-switches at the threshold", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ used: 20, candidateUsed: 95 });
      yield* completed(h.completions, 2);
      expect(h.state.switches).toEqual([]);
      h.state.snapshot = manualSwitch(h.state.snapshot, work);
      yield* h.reactor.clear("codex");
      yield* h.reactor.notify("codex");
      expect(yield* Queue.take(h.events)).toMatchObject({
        _tag: "switched",
        fromAccountId: work,
        toAccountId: personal,
        trigger: "session",
      });
      expect(h.state.switches).toEqual([personal]);
    }).pipe(Effect.scoped),
  );

  it.effect("shares one idle subscription and stops it when both drivers are disabled", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ used: 10, claudeEnabled: true });
      yield* completed(h.completions, 2);
      yield* Deferred.await(h.idleSubscribed);
      expect(h.state.idleSubscriptions).toBe(1);
      expect(h.reactor.needsIdle("codex")).toBe(false);
      expect(h.reactor.needsIdle("claudeAgent")).toBe(false);
      h.state.snapshot = { ...h.state.snapshot, config: { enabled: false, thresholdPercent: 10 } };
      yield* h.reactor.notify("codex");
      yield* completed(h.completions);
      expect(yield* Deferred.isDone(h.idleStopped)).toBe(false);
      h.state.claudeEnabled = false;
      yield* h.reactor.notify("claudeAgent");
      yield* completed(h.completions);
      yield* Deferred.await(h.idleStopped);
      expect(h.reactor.needsIdle("codex")).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("unknown active usage becoming healthy enables proactive rotation", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ unknown: true, used: 10 });
      yield* completed(h.completions, 2);
      h.state.snapshot = {
        ...h.state.snapshot,
        group: {
          ...group(10),
          accounts: group(10).accounts.map((account) => ({
            ...account,
            usage: {
              ...account.usage!,
              windows: [
                ...account.usage!.windows,
                {
                  id: "weekly",
                  label: "Weekly",
                  kind: "weekly" as const,
                  usedPercent: 20,
                  resetsAt: new Date(account.active ? 72 * 3_600_000 : 3_600_000).toISOString(),
                },
              ],
            },
          })),
        },
      };
      yield* Queue.offer(h.providers, [
        decodeProvider({
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: new Date(0).toISOString(),
          models: [],
          usageLimits: h.state.snapshot.group.accounts[0]!.usage,
        }),
      ]);
      expect(yield* Queue.take(h.events)).toMatchObject({ _tag: "switched", trigger: "expiring" });
      expect(h.state.switches).toEqual([work]);
    }).pipe(Effect.scoped),
  );

  it.effect("Claude hot-switches during running turns without waiting for idle", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ driver: "claudeAgent", busy: true, blockRefresh: true });
      yield* Deferred.await(h.probeStarted);
      expect(h.reactor.needsIdle("claudeAgent")).toBe(false);
      yield* Deferred.succeed(h.probeRelease, undefined);
      expect(yield* Queue.take(h.events)).toMatchObject({
        _tag: "switched",
        driver: "claudeAgent",
        fromAccountId: personal,
        toAccountId: work,
      });
      yield* completed(h.completions, 4);
      expect(h.state.busy).toBe(true);
      expect(h.state.switches).toEqual([work]);
      expect(h.state.persisted).toHaveLength(1);
      expect(h.reactor.needsIdle("claudeAgent")).toBe(false);
      expect(h.reactor.getState("claudeAgent").state).toBe("watching");
      expect(yield* Queue.size(h.events)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("Codex probes mid-turn, dedupes pending, then switches once on idle", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ busy: true });
      expect(yield* Queue.take(h.events)).toMatchObject({
        _tag: "pending",
        toAccountId: work,
        runningTurnCount: 2,
      });
      yield* completed(h.completions, 3); // two startup reads and the post-probe decision
      expect(h.state.probes).toEqual([[work]]);
      expect(h.state.switches).toEqual([]);
      expect(h.reactor.getState("codex").state).toBe("pending");
      expect(h.reactor.needsIdle("codex")).toBe(true);
      yield* h.reactor.notify("codex");
      yield* completed(h.completions);
      expect(yield* Queue.size(h.events)).toBe(0);
      h.state.busy = false;
      yield* Queue.offer(h.idle, "codex");
      expect(yield* Queue.take(h.events)).toMatchObject({
        _tag: "switched",
        fromAccountId: personal,
        toAccountId: work,
      });
      yield* completed(h.completions, 2);
      expect(h.state.switches).toEqual([work]);
      expect(h.state.persisted).toHaveLength(1);
      expect(h.reactor.needsIdle("codex")).toBe(false);
      expect(h.reactor.getState("codex").state).toBe("watching");
      expect(h.state.probes).toEqual([[work]]);
    }).pipe(Effect.scoped),
  );

  it.effect("disabled startup does not subscribe or probe; enabling starts evaluation", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ enabled: false });
      yield* completed(h.completions, 2);
      expect(h.state.subscriptions).toBe(0);
      expect(h.state.probes).toEqual([]);
      expect(h.reactor.getState("codex")).toEqual({ state: "off" });
      h.state.snapshot = { ...h.state.snapshot, config: { enabled: true, thresholdPercent: 10 } };
      yield* h.reactor.notify("codex");
      expect((yield* Queue.take(h.events))._tag).toBe("switched");
      expect(h.state.subscriptions).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("failed probes are bounded and never select retained usage", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ failRefresh: true });
      expect((yield* Queue.take(h.events))._tag).toBe("blocked");
      yield* completed(h.completions, 3);
      expect(h.state.probes).toEqual([[work]]);
      expect(h.state.switches).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("manual mutation can run during a probe and invalidates its result", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ blockRefresh: true });
      yield* Deferred.await(h.probeStarted);
      yield* h.mutation.withPermit(
        Effect.gen(function* () {
          h.state.snapshot = manualSwitch(h.state.snapshot, work);
          yield* h.reactor.clear("codex");
        }),
      );
      yield* Deferred.succeed(h.probeRelease, undefined);
      yield* h.reactor.notify("codex");
      yield* completed(h.completions, 3);
      expect(h.state.switches).toEqual([]);
      expect(h.reactor.getState("codex").pendingTargetAccountId).toBeUndefined();
      expect(h.reactor.getState("codex").state).toBe("watching");
    }).pipe(Effect.scoped),
  );

  it.effect("all-exhausted reset arms one timer and probes before switching on rollover", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ used: 100, candidateUsed: 100, reset: 60_000 });
      expect((yield* Queue.take(h.events))._tag).toBe("blocked");
      yield* completed(h.completions, 2);
      expect(h.reactor.getState("codex").wakeAt).toBe(new Date(60_000).toISOString());
      // Active stays exhausted after the candidate resets.
      h.state.snapshot = {
        ...h.state.snapshot,
        group: {
          ...h.state.snapshot.group,
          accounts: h.state.snapshot.group.accounts.map((account) =>
            account.id === personal && account.usage
              ? {
                  ...account,
                  usage: {
                    ...account.usage,
                    windows: account.usage.windows.map((window) => ({
                      ...window,
                      resetsAt: new Date(3_600_000).toISOString(),
                    })),
                  },
                }
              : account,
          ),
        },
      };
      yield* TestClock.adjust(60_000);
      expect((yield* Queue.take(h.events))._tag).toBe("switched");
      expect(h.state.probes).toEqual([[work]]);
      expect(h.state.switches).toEqual([work]);
    }).pipe(Effect.scoped),
  );

  it.effect("clear cancels a reset timer and disables further background work", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ used: 100, candidateUsed: 100, reset: 60_000 });
      yield* Queue.take(h.events);
      yield* completed(h.completions, 2);
      h.state.snapshot = { ...h.state.snapshot, config: { enabled: false, thresholdPercent: 10 } };
      yield* h.reactor.clear("codex");
      yield* h.reactor.notify("codex");
      yield* completed(h.completions);
      yield* TestClock.adjust(120_000);
      expect(h.state.probes).toEqual([]);
      expect(h.state.switches).toEqual([]);
      expect(h.reactor.getState("codex")).toEqual({ state: "off" });
      expect(yield* Queue.size(h.completions)).toBe(0);
    }).pipe(Effect.scoped),
  );
  it.effect("provider pushes only evaluate default-instance threshold crossings", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ used: 10 });
      yield* completed(h.completions, 2);
      const provider = decodeProvider({
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: new Date(0).toISOString(),
        models: [],
        usageLimits: {
          checkedAt: new Date(1).toISOString(),
          windows: [{ id: "session", kind: "session", label: "5h", usedPercent: 95 }],
        },
      });
      // Nondefault and healthy pushes must not evaluate the now-low service snapshot.
      h.state.snapshot = { ...h.state.snapshot, group: group() };
      yield* Queue.offer(h.providers, [decodeProvider({ ...provider, instanceId: "other-codex" })]);
      yield* Queue.offer(h.providers, [
        { ...provider, usageLimits: { ...provider.usageLimits!, windows: [] } },
      ]);
      yield* Queue.offer(h.providers, [
        {
          ...provider,
          usageLimits: { ...provider.usageLimits!, checkedAt: new Date(2).toISOString() },
        },
      ]);
      expect((yield* Queue.take(h.events))._tag).toBe("switched");
      yield* completed(h.completions, 3);
      expect(h.state.probes).toEqual([[work]]);
      expect(h.state.switches).toEqual([work]);
      expect(yield* Queue.size(h.completions)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("coalesces a burst of notifications while a probe is running", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ busy: true, blockRefresh: true });
      yield* Deferred.await(h.probeStarted);
      for (let index = 0; index < 100; index++) yield* h.reactor.notify("codex");
      yield* Deferred.succeed(h.probeRelease, undefined);
      expect((yield* Queue.take(h.events))._tag).toBe("pending");
      yield* completed(h.completions, 4);
      expect(h.state.probes).toEqual([[work]]);
      expect(yield* Queue.size(h.events)).toBe(0);
      expect(yield* Queue.size(h.completions)).toBe(0);
    }).pipe(Effect.scoped),
  );
  // S3: a probe that ran but measured nothing never promotes retained numbers to fresh.
  it.effect("an unmeasured probe is treated as failed, not as a fresh measurement", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ unmeasured: true });
      expect((yield* Queue.take(h.events))._tag).toBe("blocked");
      yield* completed(h.completions, 3);
      expect(h.state.probes).toEqual([[work]]);
      expect(h.state.switches).toEqual([]);
    }).pipe(Effect.scoped),
  );

  // S5: a healthy stay re-evaluates at the next weekly reset, which can make rotation worthwhile.
  it.effect("wakes at the active account's weekly reset and then rebalances", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ used: 10 });
      yield* completed(h.completions, 2);
      const weekly = (reset: number, used: number) => ({
        id: "weekly",
        label: "Weekly",
        kind: "weekly" as const,
        usedPercent: used,
        resetsAt: new Date(reset).toISOString(),
      });
      h.state.snapshot = {
        ...h.state.snapshot,
        group: {
          ...h.state.snapshot.group,
          accounts: h.state.snapshot.group.accounts.map((account) => ({
            ...account,
            usage: {
              ...account.usage!,
              windows: [
                ...account.usage!.windows,
                account.active ? weekly(3_600_000, 50) : weekly(5_400_000, 10),
              ],
            },
          })),
        },
      };
      yield* h.reactor.notify("codex");
      yield* completed(h.completions);
      expect(h.state.switches).toEqual([]);
      expect(h.reactor.getState("codex")).toMatchObject({
        state: "watching",
        wakeAt: new Date(3_660_000).toISOString(),
      });
      yield* TestClock.adjust(3_660_000);
      expect(yield* Queue.take(h.events)).toMatchObject({ _tag: "switched", trigger: "expiring" });
      expect(h.state.switches).toEqual([work]);
    }).pipe(Effect.scoped),
  );

  it.effect("a switch failure does not kill the worker", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ failSwitch: true });
      yield* completed(h.completions, 3);
      // S10: the reason names the target and the switch error, not a generic check failure.
      expect(h.reactor.getState("codex")).toEqual({
        state: "paused",
        message: "Couldn't switch to Work: Switch failed",
      });
      h.state.failSwitch = false;
      yield* h.reactor.notify("codex");
      expect((yield* Queue.take(h.events))._tag).toBe("switched");
      expect(h.state.switches).toEqual([work]);
      expect(h.state.persisted).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});
