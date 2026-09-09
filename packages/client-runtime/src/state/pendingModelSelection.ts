import type { ModelSelection, ScopedThreadRef, ServerProvider } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";
import type { EnvironmentThreadState } from "./threadState.ts";

const savesAtom = Atom.make<ReadonlyMap<string, ModelSelection>>(new Map()).pipe(Atom.keepAlive);
const keyOf = (ref: ScopedThreadRef) => JSON.stringify([ref.environmentId, ref.threadId]);
const pendingFamily = Atom.family((key: string) =>
  Atom.make((get) => get(savesAtom).get(key) ?? null),
);

/** Client-local and nonpersistent: content drafts never own an existing thread's model. */
export const pendingModelSelectionAtom = (ref: ScopedThreadRef | null) =>
  pendingFamily(ref ? keyOf(ref) : "");

export function isModelSelectionSaving(registry: AtomRegistry.AtomRegistry, ref: ScopedThreadRef) {
  return registry.get(savesAtom).has(keyOf(ref));
}

/** Hold the optimistic selection until the command receipt is applied, even if a remote
 * selection has already superseded it. A broken stream must not hold Send forever.
 * Success never writes model metadata locally. */
export async function saveThreadModelSelection<E>(input: {
  registry: AtomRegistry.AtomRegistry;
  threadRef: ScopedThreadRef;
  selection: ModelSelection;
  stateAtom: Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>;
  dispatch: () => Promise<{ readonly sequence: number }>;
}): Promise<void> {
  const { registry, threadRef, selection } = input;
  const key = keyOf(threadRef);
  if (isModelSelectionSaving(registry, threadRef)) return;
  registry.set(savesAtom, new Map(registry.get(savesAtom)).set(key, selection));
  let receipt: number | undefined;
  let finish: (error: Error | null) => void = () => {};
  const applied = new Promise<Error | null>((resolve) => {
    finish = resolve;
  });
  const check = () => {
    if (receipt === undefined) return;
    const result = registry.get(input.stateAtom);
    const state = Option.getOrNull(AsyncResult.value(result));
    if (AsyncResult.isFailure(result) || (state && Option.isSome(state.error))) {
      finish(
        new Error(
          "Could not confirm the model update because the thread connection failed. Please try again.",
        ),
      );
    } else if (state?.status === "deleted") {
      finish(new Error("The thread was deleted before the model update was confirmed."));
    } else if ((state?.appliedSequence ?? 0) >= receipt) {
      finish(null);
    }
  };
  let unsubscribe = () => {};
  try {
    unsubscribe = registry.subscribe(input.stateAtom, check);
    receipt = (await input.dispatch()).sequence;
    check();
    // Only bound stream confirmation: the RPC owns dispatch cancellation and its timeout.
    const error = await Effect.runPromise(
      Effect.promise(() => applied).pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () =>
            Effect.succeed(
              new Error(
                "The server saved the model update, but its confirmation did not arrive. Please check the model and try again.",
              ),
            ),
        }),
      ),
    );
    if (error) {
      // Reopen a stalled subscription before dropping the optimistic selection.
      registry.refresh(input.stateAtom);
      throw error;
    }
  } finally {
    unsubscribe();
    const next = new Map(registry.get(savesAtom));
    next.delete(key);
    registry.set(savesAtom, next);
  }
}

export function getStartedThreadModelChangeBlockReason(input: {
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "requiresNewThreadForModelChange">>;
  hasStartedSession: boolean;
  currentModelSelection: ModelSelection;
  currentProviderInstanceId?: ModelSelection["instanceId"] | null | undefined;
  nextModelSelection: ModelSelection;
}): { title: string; description: string } | null {
  if (!input.hasStartedSession) return null;
  const instanceId = input.currentProviderInstanceId ?? input.currentModelSelection.instanceId;
  if (
    instanceId === input.nextModelSelection.instanceId &&
    input.currentModelSelection.model === input.nextModelSelection.model
  )
    return null;
  if (
    !input.providers.some(
      (provider) =>
        (provider.instanceId === instanceId ||
          provider.instanceId === input.nextModelSelection.instanceId) &&
        provider.requiresNewThreadForModelChange === true,
    )
  )
    return null;
  return {
    title: "Start a new chat to change models",
    description: "This provider does not allow switching models after a conversation has started.",
  };
}
