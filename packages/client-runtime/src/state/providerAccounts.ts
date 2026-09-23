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
  runStreamInEnvironment,
} from "./runtime.ts";

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
  const loginEventsByEnvironment = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((key: string) => {
      const { attempt: _attempt, ...input } = JSON.parse(key) as ProviderAccountLoginRequest;
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
        .pipe(
          Atom.setIdleTTL(0),
          Atom.withLabel(`environment-data:provider-accounts:login:${environmentId}:${key}`),
        );
    }),
  );

  const onSettled = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => invalidate(environmentId, registry);

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
    loginEvents: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: ProviderAccountLoginRequest;
    }) => loginEventsByEnvironment(target.environmentId)(JSON.stringify(target.input)),
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
