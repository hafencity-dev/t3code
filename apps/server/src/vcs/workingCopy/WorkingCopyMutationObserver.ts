// fork: installed by an authorized RPC, invoked only inside the service's
// guarded mutation lane. Containment failures and reads never reach this seam.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export class WorkingCopyMutationObserver extends Context.Reference<{
  readonly settled: (cwd: string, operation: string) => Effect.Effect<void>;
}>("t3/workingCopy/MutationObserver", {
  defaultValue: () => ({ settled: () => Effect.void }),
}) {}

export const notifyWorkingCopyMutation = (cwd: string, operation: string) =>
  Effect.flatMap(WorkingCopyMutationObserver, (observer) => observer.settled(cwd, operation));
