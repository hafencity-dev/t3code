// fork: starts Claude 5-hour windows as soon as they can start; all service access is injected.
import type {
  ProviderAccount,
  ProviderAccountError,
  ProviderAccountGroup,
  ProviderAccountId,
  ProviderAccountWindowPrimer,
  ServerProvider,
} from "@t3tools/contracts";
import { Clock, DateTime, Effect, Fiber, Queue, Stream } from "effect";

/** A window counts as running until this long after its reset, so the reset has settled. */
export const WINDOW_PRIMER_GRACE_MS = 60_000;
/** At most one start per account in this interval; also the floor between stale-data probes. */
export const WINDOW_PRIMER_MIN_INTERVAL_MS = 5 * 60_000;
/** Retry delays after consecutive failed starts. */
export const WINDOW_PRIMER_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
const SESSION_WINDOW_MS = 5 * 60 * 60_000;

export type WindowPrimerPlan =
  | { readonly kind: "skip" }
  | { readonly kind: "wait"; readonly at: number }
  | { readonly kind: "probe" }
  | { readonly kind: "prime" };

export interface WindowPrimerAccountState {
  /** Last successful start; the account waits for the window it opened. */
  readonly primedAt?: number | undefined;
  /** Rate cap and failure backoff. */
  readonly nextAttemptAt?: number | undefined;
  readonly loginInProgress?: boolean | undefined;
}

const parseTime = (iso: string | undefined) => {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : undefined;
};

/**
 * What one account needs. A window needs starting when the latest usage has no session window
 * with a future reset, or the known reset has passed. When that is only inferred from data
 * measured before the reset (or before our own start), the account is probed first.
 */
export function planWindowPrime(
  account: ProviderAccount,
  now: number,
  state: WindowPrimerAccountState = {},
): WindowPrimerPlan {
  if (
    account.driver !== "claudeAgent" ||
    account.status !== "ready" ||
    account.duplicateOf !== undefined ||
    state.loginInProgress
  )
    return { kind: "skip" };
  const usage = account.usage;
  // API-key logins have no subscription windows to start.
  if (usage?.unavailable?.reason === "unsupported") return { kind: "skip" };
  const checkedAt = parseTime(usage?.checkedAt) ?? Number.NEGATIVE_INFINITY;
  let stale = !usage || usage.windows.length === 0;
  const weekly = usage?.windows.find((window) => window.id === "seven_day");
  if (weekly && weekly.usedPercent >= 100) {
    const resetsAt = parseTime(weekly.resetsAt);
    if (resetsAt === undefined) return { kind: "skip" };
    if (resetsAt + WINDOW_PRIMER_GRACE_MS > now)
      return { kind: "wait", at: resetsAt + WINDOW_PRIMER_GRACE_MS };
    if (checkedAt < resetsAt) stale = true;
  }
  const sessionReset = parseTime(
    usage?.windows.find((window) => window.kind === "session")?.resetsAt,
  );
  if (sessionReset !== undefined && sessionReset + WINDOW_PRIMER_GRACE_MS > now)
    return { kind: "wait", at: sessionReset + WINDOW_PRIMER_GRACE_MS };
  // Until usage reports the window a start opened, assume it runs a full five hours.
  if (
    state.primedAt !== undefined &&
    !(sessionReset !== undefined && sessionReset > state.primedAt) &&
    state.primedAt + SESSION_WINDOW_MS > now
  )
    return { kind: "wait", at: state.primedAt + SESSION_WINDOW_MS };
  if (state.nextAttemptAt !== undefined && state.nextAttemptAt > now)
    return { kind: "wait", at: state.nextAttemptAt };
  if (sessionReset !== undefined && checkedAt < sessionReset) stale = true;
  if (state.primedAt !== undefined && checkedAt < state.primedAt) stale = true;
  return stale ? { kind: "probe" } : { kind: "prime" };
}

export interface WindowPrimerRead {
  readonly enabled: boolean;
  /** Must come from list(), which masks the previous active account's usage after a switch. */
  readonly group: ProviderAccountGroup | undefined;
  readonly primedAt: ReadonlyMap<ProviderAccountId, number>;
  readonly loginInProgress: readonly ProviderAccountId[];
  /** When the usage gate admits a probe; `force` skips only the freshness TTL. */
  readonly probeAllowedAt: (accountId: ProviderAccountId, force: boolean) => number;
  /** A safe reason that pauses every start, such as an unfinished account switch. */
  readonly blocked?: string | undefined;
}

export type ProviderAccountWindowPrimerState = Pick<
  ProviderAccountWindowPrimer,
  "nextPrimeAt" | "nextPrimeAccountId" | "message"
>;

export interface ProviderAccountWindowPrimerDependencies {
  readonly read: () => Effect.Effect<WindowPrimerRead, ProviderAccountError>;
  /** Gated usage refresh: the provider refresh for the active account, a store probe otherwise. */
  readonly refresh: (
    account: ProviderAccount,
    force: boolean,
  ) => Effect.Effect<unknown, ProviderAccountError>;
  /** Sends the request. Called while holding the account mutation, after a fresh re-check. */
  readonly prime: (account: ProviderAccount) => Effect.Effect<void, ProviderAccountError>;
  readonly persistPrimed: (
    accountId: ProviderAccountId,
    at: number,
  ) => Effect.Effect<unknown, ProviderAccountError>;
  readonly withMutation: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly providerChanges: Stream.Stream<readonly ServerProvider[]>;
  /** Tells clients the group's primer state changed. */
  readonly publish: Effect.Effect<void>;
  /** Receipt after every evaluation settles. */
  readonly onEvaluated?: Effect.Effect<void>;
}

const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));

export const makeProviderAccountWindowPrimer = Effect.fn("makeProviderAccountWindowPrimer")(
  function* (deps: ProviderAccountWindowPrimerDependencies) {
    const scope = yield* Effect.scope;
    const queue = yield* Queue.sliding<void>(1);
    let generation = 0;
    let state: ProviderAccountWindowPrimerState = {};
    /** Last failed start; cleared by the next successful one. */
    let failure: string | undefined;
    let timer: Fiber.Fiber<void> | undefined;
    let subscription: Fiber.Fiber<void> | undefined;
    const attempts = new Map<ProviderAccountId, { failures: number; nextAt: number }>();
    const staleProbedAt = new Map<ProviderAccountId, number>();
    const pendingRefresh = new Set<ProviderAccountId>();
    const notify = Queue.offer(queue, undefined).pipe(Effect.asVoid);
    const stopTimer = Effect.suspend(() => {
      const current = timer;
      timer = undefined;
      return current ? Fiber.interrupt(current) : Effect.void;
    });
    const setState = Effect.fnUntraced(function* (next: ProviderAccountWindowPrimerState) {
      const changed = JSON.stringify(next) !== JSON.stringify(state);
      state = next;
      if (changed) yield* deps.publish;
    });
    const subscribe = Effect.fnUntraced(function* (instanceId: string) {
      if (subscription) return;
      let lastKey: string | undefined;
      subscription = yield* deps.providerChanges.pipe(
        Stream.runForEach((providers) => {
          const provider = providers.find((item) => item.instanceId === instanceId);
          if (!provider) return Effect.void;
          const key = `${provider.usageLimits?.checkedAt ?? ""}:${provider.auth.status}`;
          if (key === lastKey) return Effect.void;
          lastKey = key;
          return notify;
        }),
        Effect.forkIn(scope),
      );
    });
    const unsubscribe = Effect.suspend(() => {
      const current = subscription;
      subscription = undefined;
      return current ? Fiber.interrupt(current) : Effect.void;
    });
    const accountState = (read: WindowPrimerRead, account: ProviderAccount) => ({
      primedAt: read.primedAt.get(account.id),
      nextAttemptAt: attempts.get(account.id)?.nextAt,
      loginInProgress: read.loginInProgress.includes(account.id),
    });
    // Probes for stale data honor the usage gate and this reactor's own floor.
    const staleProbeAt = (read: WindowPrimerRead, account: ProviderAccount) =>
      Math.max(
        read.probeAllowedAt(account.id, false),
        (staleProbedAt.get(account.id) ?? Number.NEGATIVE_INFINITY) + WINDOW_PRIMER_MIN_INTERVAL_MS,
      );

    /** Starts one account's window under the account mutation, or does nothing if it changed. */
    const primeOne = Effect.fnUntraced(function* (accountId: ProviderAccountId, owner: number) {
      return yield* deps.withMutation(
        Effect.gen(function* () {
          if (owner !== generation) return false;
          const read = yield* deps.read();
          const account = read.group?.accounts.find((item) => item.id === accountId);
          if (!read.enabled || read.blocked || !account || owner !== generation) return false;
          const now = yield* Clock.currentTimeMillis;
          if (planWindowPrime(account, now, accountState(read, account)).kind !== "prime")
            return false;
          const failures = attempts.get(accountId)?.failures ?? 0;
          // Reserve the attempt first: the cap holds even if this fiber is interrupted.
          attempts.set(accountId, { failures, nextAt: now + WINDOW_PRIMER_MIN_INTERVAL_MS });
          const result = yield* Effect.result(deps.prime(account));
          const finishedAt = yield* Clock.currentTimeMillis;
          if (result._tag === "Failure") {
            const next = failures + 1;
            attempts.set(accountId, {
              failures: next,
              nextAt:
                finishedAt +
                WINDOW_PRIMER_BACKOFF_MS[Math.min(next, WINDOW_PRIMER_BACKOFF_MS.length) - 1]!,
            });
            failure = `Couldn't start ${account.label}'s 5-hour window. ${result.failure.message}`;
            yield* setState({ ...state, message: failure });
            return true;
          }
          attempts.set(accountId, { failures: 0, nextAt: now + WINDOW_PRIMER_MIN_INTERVAL_MS });
          yield* deps
            .persistPrimed(accountId, now)
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("Could not record a Claude window start; it may repeat once."),
              ),
            );
          pendingRefresh.add(accountId);
          failure = undefined;
          const { message: _cleared, ...rest } = state;
          state = rest;
          // The snapshot's lastPrimedAt changed even when this state did not.
          yield* deps.publish;
          return true;
        }),
      );
    });

    const evaluate = Effect.fnUntraced(function* () {
      const owner = generation;
      const probed = new Set<ProviderAccountId>();
      const skipped = new Set<ProviderAccountId>();
      yield* stopTimer;
      // Each pass probes, starts or skips one account, so the loop ends; clear() ends it early.
      for (;;) {
        if (owner !== generation) return;
        const read = yield* deps.read();
        if (owner !== generation) return;
        if (!read.enabled || !read.group) {
          yield* unsubscribe;
          yield* setState({});
          return;
        }
        yield* subscribe(read.group.instanceId);
        if (read.blocked) {
          yield* setState({ message: read.blocked });
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        const accounts = read.group.accounts;
        for (const id of pendingRefresh)
          if (!accounts.some((account) => account.id === id)) pendingRefresh.delete(id);
        const plans = accounts.map((account) => ({
          account,
          plan: planWindowPrime(account, now, accountState(read, account)),
        }));
        // One post-start refresh per start (it shows the new window), then stale-data probes.
        const refreshAfterStart = accounts.find(
          (account) =>
            pendingRefresh.has(account.id) &&
            !probed.has(account.id) &&
            read.probeAllowedAt(account.id, true) <= now,
        );
        const staleProbe = plans.find(
          ({ account, plan }) =>
            plan.kind === "probe" && !probed.has(account.id) && staleProbeAt(read, account) <= now,
        )?.account;
        const probe = refreshAfterStart ?? staleProbe;
        if (probe) {
          probed.add(probe.id);
          const force = probe === refreshAfterStart;
          if (force) pendingRefresh.delete(probe.id);
          else staleProbedAt.set(probe.id, now);
          // Network probes deliberately do not own the mutation semaphore.
          yield* deps
            .refresh(probe, force)
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("Usage refresh for a Claude window start failed."),
              ),
            );
          continue;
        }
        const next = plans.find(
          ({ account, plan }) => plan.kind === "prime" && !skipped.has(account.id),
        );
        if (next) {
          // Changed under the mutation (switched, signed out, disabled): re-read, don't retry it.
          if (!(yield* primeOne(next.account.id, owner))) skipped.add(next.account.id);
          continue;
        }
        // Settle: one timer for the whole group, armed at the earliest wake.
        let nextPrime: { at: number; accountId: ProviderAccountId } | undefined;
        let wakeAt = Number.POSITIVE_INFINITY;
        for (const { account, plan } of plans) {
          const at =
            plan.kind === "wait"
              ? plan.at
              : plan.kind === "probe"
                ? staleProbeAt(read, account)
                : undefined;
          if (at === undefined) continue;
          wakeAt = Math.min(wakeAt, at);
          if (!nextPrime || at < nextPrime.at) nextPrime = { at, accountId: account.id };
        }
        for (const id of pendingRefresh) wakeAt = Math.min(wakeAt, read.probeAllowedAt(id, true));
        yield* setState({
          ...(nextPrime
            ? { nextPrimeAt: iso(nextPrime.at), nextPrimeAccountId: nextPrime.accountId }
            : {}),
          ...(failure ? { message: failure } : {}),
        });
        if (Number.isFinite(wakeAt)) {
          timer = yield* Effect.sleep(Math.max(1_000, wakeAt - now)).pipe(
            Effect.andThen(notify),
            Effect.forkIn(scope),
          );
        }
        return;
      }
    });

    yield* Queue.take(queue).pipe(
      Effect.andThen(
        evaluate().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Claude window start evaluation failed", cause),
          ),
          Effect.ensuring(deps.onEvaluated ?? Effect.void),
        ),
      ),
      Effect.forever,
      Effect.forkIn(scope),
    );
    yield* notify;
    return {
      getState: () => state,
      notify,
      /** Invalidate the running evaluation and timer, e.g. after the setting changed. */
      clear: Effect.gen(function* () {
        generation++;
        state = {};
        failure = undefined;
        yield* stopTimer;
      }),
    };
  },
);
