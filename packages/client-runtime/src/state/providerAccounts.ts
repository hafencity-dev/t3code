/** Saved-account queries and one-shot login streams, scoped to an environment. */
import {
  type EnvironmentId,
  type ProviderAccountsAutoSwitchEventsInput,
  type ProviderAccountsStartLoginInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { runStream, subscribe } from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
  environmentRpcKey,
  runStreamInEnvironment,
} from "./runtime.ts";

const COMMAND_SETTLE_TIMEOUT_MS = 10_000;

/** Increment attempt for an explicit retry; reconnecting never restarts a login. */
export interface ProviderAccountLoginRequest extends ProviderAccountsStartLoginInput {
  readonly attempt: number;
}

export function createProviderAccountsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:provider-accounts:list",
    tag: WS_METHODS.providerAccountsList,
  });

  const invalidate = (environmentId: EnvironmentId, registry: AtomRegistry.AtomRegistry) =>
    Effect.sync(() => registry.refresh(list({ environmentId, input: {} })));

  // Login is a command: following registry changes would replay its side effects.
  // Keep this family flat. Atom.family holds its values weakly, so a nested family's
  // inner lookup can be collected while its login atom is still mounted; the next
  // lookup would then build a second atom and start a second server login.
  const loginEventsFamily = Atom.family((key: string) => {
    const [environmentId, request] = JSON.parse(key) as [
      EnvironmentId,
      ProviderAccountLoginRequest,
    ];
    const { attempt: _attempt, ...input } = request;
    const refresh = Effect.flatMap(AtomRegistry.AtomRegistry, (registry) =>
      invalidate(environmentId, registry),
    );
    return runtime
      .atom(
        runStreamInEnvironment(
          environmentId,
          runStream(WS_METHODS.providerAccountsStartLogin, input),
        ).pipe(
          Stream.tap((event) =>
            event._tag === "started" || event._tag === "completed" || event._tag === "failed"
              ? refresh
              : Effect.void,
          ),
          Stream.ensuring(refresh),
        ),
      )
      .pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-data:provider-accounts:login:${key}`));
  });

  /**
   * Refreshes the mounted list and waits for its next settled result, so a command resolves
   * only once the UI can show its outcome: controls never re-enable over the old state. An
   * unmounted list has nothing on screen to catch up; the bound keeps a list that can't load
   * (a dropped connection) from holding the command open.
   */
  const onSettled = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.suspend(() => {
      const atom = list({ environmentId, input: {} });
      if (!registry.getNodes().has(atom)) return Effect.void;
      const before = registry.get(atom);
      registry.refresh(atom);
      const settled = (result: typeof before) =>
        result !== before && result._tag !== "Initial" && !result.waiting;
      return Effect.callback<void>((resume) => {
        if (settled(registry.get(atom))) return resume(Effect.void);
        const cancel = registry.subscribe(atom, (result) => {
          if (settled(result)) resume(Effect.void);
        });
        return Effect.sync(cancel);
      }).pipe(Effect.timeoutOption(COMMAND_SETTLE_TIMEOUT_MS), Effect.asVoid);
    });

  return {
    list,
    autoSwitchEvents: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:provider-accounts:auto-switch-events",
      idleTtlMs: 0,
      subscribe: (input: ProviderAccountsAutoSwitchEventsInput) =>
        subscribe(WS_METHODS.providerAccountsAutoSwitchEvents, input).pipe(
          Stream.tap(() =>
            Effect.gen(function* () {
              const supervisor = yield* EnvironmentSupervisor;
              const registry = yield* AtomRegistry.AtomRegistry;
              yield* invalidate(supervisor.target.environmentId, registry);
            }),
          ),
        ),
    }),
    setAutoSwitch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-accounts:set-auto-switch",
      tag: WS_METHODS.providerAccountsSetAutoSwitch,
      onSettled,
    }),
    setWindowPrimer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-accounts:set-window-primer",
      tag: WS_METHODS.providerAccountsSetWindowPrimer,
      onSettled,
    }),
    loginEvents: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: ProviderAccountLoginRequest;
    }) => loginEventsFamily(environmentRpcKey(target)),
    refreshUsage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-accounts:refresh-usage",
      tag: WS_METHODS.providerAccountsRefreshUsage,
      onSettled,
    }),
    submitLoginCode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-accounts:submit-login-code",
      tag: WS_METHODS.providerAccountsSubmitLoginCode,
      onSettled,
    }),
    cancelLogin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-accounts:cancel-login",
      tag: WS_METHODS.providerAccountsCancelLogin,
      onSettled,
    }),
    switchAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-accounts:switch",
      tag: WS_METHODS.providerAccountsSwitch,
      onSettled,
    }),
    rename: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-accounts:rename",
      tag: WS_METHODS.providerAccountsRename,
      onSettled,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-accounts:remove",
      tag: WS_METHODS.providerAccountsRemove,
      onSettled,
    }),
  };
}
