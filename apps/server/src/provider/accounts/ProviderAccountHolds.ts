// fork: provider accounts — per-account in-flight tracking for store probes and window starts.
import { Effect, Semaphore } from "effect";
import type * as Scope from "effect/Scope";

/** Far above the probe and window-start concurrency; a switch takes all of them. */
const SHARED_PERMITS = 1_024;

/**
 * Probes and window starts hold an account while their CLI runs. A credential switch takes
 * its source and target exclusively: it waits for their in-flight holds and blocks new ones
 * until it finishes. Only switches (which already own the account mutation) are exclusive.
 */
export function makeProviderAccountHolds() {
  const accounts = new Map<string, { gate: Semaphore.Semaphore; permits: Semaphore.Semaphore }>();
  const account = (id: string) => {
    let entry = accounts.get(id);
    if (!entry) {
      entry = { gate: Semaphore.makeUnsafe(1), permits: Semaphore.makeUnsafe(SHARED_PERMITS) };
      accounts.set(id, entry);
    }
    return entry;
  };
  // Passing the gate first means a waiting switch holds new holds back instead of starving.
  const enter = (id: string) => {
    const entry = account(id);
    return entry.gate.withPermit(Effect.void).pipe(Effect.andThen(entry.permits.take(1)));
  };
  return {
    /** Runs `effect` while holding the account; waits while a switch owns it. */
    shared:
      (id: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          enter(id),
          () => effect,
          () => account(id).permits.release(1),
        ),
    /** Holds the account until the surrounding scope closes. */
    sharedScoped: (id: string): Effect.Effect<void, never, Scope.Scope> =>
      Effect.acquireRelease(enter(id), () => account(id).permits.release(1)).pipe(Effect.asVoid),
    /** Runs `effect` once no hold is in flight on any of `ids`, blocking new ones meanwhile. */
    exclusive:
      (ids: ReadonlyArray<string>) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        // A fixed order keeps two exclusive holders from deadlocking.
        [...new Set(ids)].toSorted().reduceRight<Effect.Effect<A, E, R>>((inner, id) => {
          const entry = account(id);
          return entry.gate.withPermit(entry.permits.withPermits(SHARED_PERMITS)(inner));
        }, effect),
  };
}
export type ProviderAccountHolds = ReturnType<typeof makeProviderAccountHolds>;
