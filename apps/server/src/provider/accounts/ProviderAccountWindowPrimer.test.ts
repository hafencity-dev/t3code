import { describe, expect, it } from "@effect/vitest";
import {
  ProviderAccountError,
  ProviderAccountGroup,
  ProviderAccountId,
  type ProviderAccount,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { Clock, Effect, Queue, Schema, Semaphore, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  makeProviderAccountWindowPrimer,
  planWindowPrime,
  type WindowPrimerRead,
} from "./ProviderAccountWindowPrimer.ts";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const personal = ProviderAccountId.make("personal");
const work = ProviderAccountId.make("work");
const decodeGroup = Schema.decodeUnknownSync(ProviderAccountGroup);
const iso = (at: number) => new Date(at).toISOString();

/** Usage measured at `checkedAt`; `sessionReset` undefined means no running 5-hour window. */
const usage = (
  checkedAt: number,
  sessionReset?: number,
  weeklyUsed = 20,
): ServerProviderUsageLimits => ({
  checkedAt: iso(checkedAt),
  windows: [
    ...(sessionReset === undefined
      ? []
      : [
          {
            id: "five_hour",
            label: "Session",
            kind: "session" as const,
            usedPercent: 10,
            resetsAt: iso(sessionReset),
          },
        ]),
    {
      id: "seven_day",
      label: "Weekly",
      kind: "weekly" as const,
      usedPercent: weeklyUsed,
      resetsAt: iso(72 * HOUR),
    },
  ],
});

const account = (
  id: ProviderAccountId,
  overrides: Partial<ProviderAccount> = {},
): ProviderAccount => ({
  id,
  driver: "claudeAgent",
  label: id === personal ? "Personal" : "Work",
  kind: id === personal ? "default" : "managed",
  status: "ready",
  active: id === personal,
  ...overrides,
});

const makeHarness = Effect.fnUntraced(function* (options: {
  accounts: ProviderAccount[];
  enabled?: boolean;
  failPrime?: boolean;
  loginInProgress?: ProviderAccountId[];
  /** Usage a refresh reports; `force` marks the refresh after a start. */
  refreshed?: (now: number, force: boolean) => ServerProviderUsageLimits;
}) {
  const evaluated = yield* Queue.unbounded<void>();
  const mutation = yield* Semaphore.make(1);
  const mutationRequests = yield* Queue.unbounded<void>();
  const state = {
    enabled: options.enabled ?? true,
    accounts: options.accounts,
    primedAt: new Map<ProviderAccountId, number>(),
    primes: [] as { id: ProviderAccountId; active: boolean; at: number; mutationFree: boolean }[],
    refreshes: [] as { id: ProviderAccountId; force: boolean; at: number }[],
    failPrime: options.failPrime ?? false,
  };
  const group = () =>
    decodeGroup({
      driver: "claudeAgent",
      switchMode: "hot",
      instanceId: "claudeAgent",
      activeAccountId: state.accounts.find((item) => item.active)!.id,
      autoSwitch: { enabled: false, thresholdPercent: 10, weeklyThresholdPercent: 2, state: "off" },
      accounts: state.accounts,
    });
  const read = (): Effect.Effect<WindowPrimerRead> =>
    Effect.sync(() => ({
      enabled: state.enabled,
      group: group(),
      primedAt: state.primedAt,
      loginInProgress: options.loginInProgress ?? [],
      probeAllowedAt: () => 0,
    }));
  const primer = yield* makeProviderAccountWindowPrimer({
    read,
    refresh: (target, force) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        state.refreshes.push({ id: target.id, force, at: now });
        state.accounts = state.accounts.map((item) =>
          item.id === target.id
            ? { ...item, usage: options.refreshed?.(now, force) ?? usage(now) }
            : item,
        );
      }),
    prime: (target) =>
      Effect.succeed(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          // The request runs outside the account mutation, under the account's own hold.
          const mutationFree = yield* mutation.takeIfAvailable(1);
          if (mutationFree) yield* mutation.release(1);
          state.primes.push({ id: target.id, active: target.active, at: now, mutationFree });
          if (state.failPrime)
            return yield* new ProviderAccountError({ message: "Claude returned an error." });
        }),
      ),
    persistPrimed: (id, at) => Effect.sync(() => state.primedAt.set(id, at)),
    // Receipt when a start asks for the account mutation, before it holds it.
    withMutation: (effect) =>
      Queue.offer(mutationRequests, undefined).pipe(Effect.andThen(mutation.withPermit(effect))),
    providerChanges: Stream.never as Stream.Stream<readonly ServerProvider[]>,
    publish: Effect.void,
    onEvaluated: Queue.offer(evaluated, undefined).pipe(Effect.asVoid),
  });
  return {
    primer,
    state,
    mutation,
    evaluated: Queue.take(evaluated),
    mutationRequested: Queue.take(mutationRequests),
    pending: Queue.size(evaluated),
  };
});

const primedIds = (state: { primes: readonly { id: ProviderAccountId }[] }) =>
  state.primes.map((prime) => prime.id);

describe("planWindowPrime", () => {
  it("skips accounts that can't or shouldn't start a window", () => {
    const fresh = usage(0);
    const skipped: ProviderAccount[] = [
      account(work, { status: "pending", usage: fresh }),
      account(work, { status: "signedOut", usage: fresh }),
      account(work, { status: "error", usage: fresh }),
      account(work, { duplicateOf: personal, usage: fresh }),
      account(work, {
        usage: { checkedAt: iso(0), windows: [], unavailable: { reason: "unsupported" } },
      }),
    ];
    for (const item of skipped) expect(planWindowPrime(item, 0)).toEqual({ kind: "skip" });
    expect(planWindowPrime(account(work, { usage: fresh }), 0, { loginInProgress: true })).toEqual({
      kind: "skip",
    });
    // No weekly quota left: wait for the weekly reset instead of starting a window.
    expect(planWindowPrime(account(work, { usage: usage(0, undefined, 100) }), 0)).toEqual({
      kind: "wait",
      at: 72 * HOUR + MINUTE,
    });
    expect(planWindowPrime(account(work, { usage: fresh }), 0)).toEqual({ kind: "prime" });
  });

  it("ignores a spent model-scoped weekly unless it is the only weekly reported", () => {
    const fable = {
      id: "seven_day_fable",
      label: "Weekly · Fable",
      kind: "weekly" as const,
      usedPercent: 100,
      resetsAt: iso(48 * HOUR),
    };
    const withFable = usage(0);
    expect(
      planWindowPrime(
        account(work, { usage: { ...withFable, windows: [...withFable.windows, fable] } }),
        0,
      ),
    ).toEqual({ kind: "prime" });
    expect(
      planWindowPrime(account(work, { usage: { ...withFable, windows: [fable] } }), 0),
    ).toEqual({ kind: "wait", at: 48 * HOUR + MINUTE });
  });

  it("probes before trusting data measured before the reset or before its own start", () => {
    expect(planWindowPrime(account(work, { usage: usage(-10 * MINUTE, HOUR) }), 2 * HOUR)).toEqual({
      kind: "probe",
    });
    expect(planWindowPrime(account(work), 0)).toEqual({ kind: "probe" });
    expect(
      planWindowPrime(account(work, { usage: usage(HOUR) }), 8 * HOUR, { primedAt: 2 * HOUR }),
    ).toEqual({ kind: "probe" });
  });
});

describe("ProviderAccountWindowPrimer", () => {
  it.effect("never starts anything while disabled", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        enabled: false,
        accounts: [account(personal, { usage: usage(0) }), account(work, { usage: usage(0) })],
      });
      yield* h.evaluated;
      yield* TestClock.adjust(10 * HOUR);
      yield* h.primer.notify;
      yield* h.evaluated;
      expect(h.state.primes).toEqual([]);
      expect(h.state.refreshes).toEqual([]);
      expect(h.primer.getState()).toEqual({});
    }).pipe(Effect.scoped),
  );

  it.effect("arms one timer at the earliest reset and probes stale data before starting", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        accounts: [
          account(personal, { usage: usage(-10 * MINUTE, 2 * HOUR) }),
          account(work, { usage: usage(-10 * MINUTE, HOUR) }),
        ],
      });
      yield* h.evaluated;
      expect(h.primer.getState()).toEqual({
        nextPrimeAt: iso(HOUR + MINUTE),
        nextPrimeAccountId: work,
      });
      yield* TestClock.adjust(HOUR + MINUTE - 1);
      expect(yield* h.pending).toBe(0);
      yield* TestClock.adjust(1);
      yield* h.evaluated;
      // Usage from before the reset is only an inference: one probe, then the start.
      expect(h.state.refreshes).toEqual([{ id: work, force: false, at: HOUR + MINUTE }]);
      expect(h.state.primes).toEqual([
        { id: work, active: false, at: HOUR + MINUTE, mutationFree: true },
      ]);
      expect(h.state.primedAt.get(work)).toBe(HOUR + MINUTE);
      // One post-start refresh so the new window shows up.
      yield* TestClock.adjust(1_000);
      yield* h.evaluated;
      expect(h.state.refreshes.at(-1)).toEqual({
        id: work,
        force: true,
        at: HOUR + MINUTE + 1_000,
      });
      expect(h.primer.getState().nextPrimeAt).toBe(iso(2 * HOUR + MINUTE));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "starts the active account through the active home and inactive ones in their store",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          accounts: [account(personal, { usage: usage(0) }), account(work, { usage: usage(0) })],
        });
        yield* h.evaluated;
        expect(h.state.primes.map(({ id, active }) => ({ id, active }))).toEqual([
          { id: personal, active: true },
          { id: work, active: false },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("skips pending, signed-out, errored, duplicate and weekly-exhausted accounts", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        accounts: [
          account(personal, { usage: usage(0, undefined, 100) }),
          account(work, { status: "signedOut", usage: usage(0) }),
          account(ProviderAccountId.make("pending"), { status: "pending", usage: usage(0) }),
          account(ProviderAccountId.make("error"), { status: "error", usage: usage(0) }),
          account(ProviderAccountId.make("copy"), { duplicateOf: personal, usage: usage(0) }),
          account(ProviderAccountId.make("login"), { usage: usage(0) }),
        ],
        loginInProgress: [ProviderAccountId.make("login")],
      });
      yield* h.evaluated;
      expect(h.state.primes).toEqual([]);
      expect(h.state.refreshes).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("never starts the same account twice within its window", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        accounts: [
          account(personal, { usage: usage(0, 20 * HOUR) }),
          account(work, { usage: usage(0) }),
        ],
        // After the start, usage reports the window it opened; a stale probe finds none.
        refreshed: (now, force) => (force ? usage(now, now + 5 * HOUR) : usage(now)),
      });
      yield* h.evaluated;
      expect(primedIds(h.state)).toEqual([work]);
      // The post-start refresh ran in the same evaluation and reported the new window.
      expect(h.state.refreshes).toEqual([{ id: work, force: true, at: 0 }]);
      for (let step = 0; step < 4; step++) {
        yield* TestClock.adjust(HOUR);
        yield* h.primer.notify;
        yield* h.evaluated;
      }
      expect(primedIds(h.state)).toEqual([work]);
      // After the window ends the stale reading is probed first, then the next window starts.
      yield* TestClock.adjust(HOUR + MINUTE);
      yield* h.evaluated;
      expect(h.state.refreshes.filter((refresh) => !refresh.force).map(({ id }) => id)).toEqual([
        work,
      ]);
      expect(primedIds(h.state)).toEqual([work, work]);
    }).pipe(Effect.scoped),
  );

  it.effect("backs off failed starts by 5, 15 and 60 minutes", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        failPrime: true,
        accounts: [
          account(personal, { usage: usage(0, 20 * HOUR) }),
          account(work, { usage: usage(0) }),
        ],
      });
      yield* h.evaluated;
      expect(h.state.primes.map(({ at }) => at)).toEqual([0]);
      expect(h.primer.getState().message).toBe(
        "Couldn't start Work's 5-hour window. Claude returned an error.",
      );
      for (const [delay, expected] of [
        [5 * MINUTE, [0, 5 * MINUTE]],
        [15 * MINUTE, [0, 5 * MINUTE, 20 * MINUTE]],
        [60 * MINUTE, [0, 5 * MINUTE, 20 * MINUTE, 80 * MINUTE]],
        [60 * MINUTE, [0, 5 * MINUTE, 20 * MINUTE, 80 * MINUTE, 140 * MINUTE]],
      ] as const) {
        yield* TestClock.adjust(delay - 1);
        expect(yield* h.pending).toBe(0);
        yield* TestClock.adjust(1);
        yield* h.evaluated;
        expect(h.state.primes.map(({ at }) => at)).toEqual(expected);
      }
    }).pipe(Effect.scoped),
  );

  // S13: the CLI request never holds the global account mutation; the plan and the record do.
  it.effect("sends a start outside the account mutation, then records it under the mutation", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        accounts: [
          account(personal, { usage: usage(0, 20 * HOUR) }),
          account(work, { usage: usage(0) }),
        ],
      });
      yield* h.evaluated;
      expect(h.state.primes.map(({ id, mutationFree }) => ({ id, mutationFree }))).toEqual([
        { id: work, mutationFree: true },
      ]);
      expect(h.state.primedAt.get(work)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("waits for a running account switch and re-checks which home to use", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        enabled: false,
        accounts: [
          account(personal, { usage: usage(0, 20 * HOUR) }),
          account(work, { usage: usage(0) }),
        ],
      });
      yield* h.evaluated;
      // A hot switch holds the account mutation while it moves credentials.
      yield* h.mutation.take(1);
      h.state.enabled = true;
      yield* h.primer.notify;
      yield* h.mutationRequested;
      yield* Effect.yieldNow;
      expect(h.state.primes).toEqual([]);
      expect(yield* h.pending).toBe(0);
      // The switch checks Work out: its store is no longer primed, the active home is.
      h.state.accounts = h.state.accounts.map((item) => ({ ...item, active: item.id === work }));
      yield* h.mutation.release(1);
      yield* h.evaluated;
      expect(h.state.primes.map(({ id, active }) => ({ id, active }))).toEqual([
        { id: work, active: true },
      ]);
    }).pipe(Effect.scoped),
  );
});
