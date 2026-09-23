// fork: provider accounts
import {
  WS_METHODS,
  type EnvironmentAuthorizationError,
  type ProviderAccountsRefreshUsageInput,
  type ProviderAccountsStartLoginInput,
  type ProviderAccountsSubmitLoginCodeInput,
  type ProviderAccountsCancelLoginInput,
  type ProviderAccountsSwitchInput,
  type ProviderAccountsRenameInput,
  type ProviderAccountsRemoveInput,
  type ProviderAccountsSetAutoSwitchInput,
} from "@t3tools/contracts";
import type { Effect, Stream } from "effect";
import type { ProviderAccountsService } from "./ProviderAccountsService.ts";

export function makeProviderAccountsRpcHandlers(deps: {
  readonly providerAccounts: ProviderAccountsService["Service"];
  readonly currentSessionId: string;
  readonly observeRpcEffect: <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    attributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
  readonly observeRpcStream: <A, E, R>(
    method: string,
    stream: Stream.Stream<A, E, R>,
    attributes?: Readonly<Record<string, unknown>>,
  ) => Stream.Stream<A, E | EnvironmentAuthorizationError, R>;
}) {
  const {
    providerAccounts: service,
    currentSessionId: owner,
    observeRpcEffect: observe,
    observeRpcStream,
  } = deps;
  return {
    [WS_METHODS.providerAccountsSetAutoSwitch]: (input: ProviderAccountsSetAutoSwitchInput) =>
      observe(WS_METHODS.providerAccountsSetAutoSwitch, service.setAutoSwitch(input)),
    [WS_METHODS.providerAccountsAutoSwitchEvents]: () =>
      observeRpcStream(WS_METHODS.providerAccountsAutoSwitchEvents, service.autoSwitchEvents),
    [WS_METHODS.providerAccountsList]: () =>
      observe(WS_METHODS.providerAccountsList, service.list()),
    [WS_METHODS.providerAccountsRefreshUsage]: (input: ProviderAccountsRefreshUsageInput) =>
      observe(WS_METHODS.providerAccountsRefreshUsage, service.refreshUsage(input)),
    [WS_METHODS.providerAccountsStartLogin]: (input: ProviderAccountsStartLoginInput) =>
      observeRpcStream(WS_METHODS.providerAccountsStartLogin, service.startLogin(owner, input)),
    [WS_METHODS.providerAccountsSubmitLoginCode]: (input: ProviderAccountsSubmitLoginCodeInput) =>
      observe(WS_METHODS.providerAccountsSubmitLoginCode, service.submitLoginCode(owner, input)),
    [WS_METHODS.providerAccountsCancelLogin]: (input: ProviderAccountsCancelLoginInput) =>
      observe(WS_METHODS.providerAccountsCancelLogin, service.cancelLogin(owner, input)),
    [WS_METHODS.providerAccountsSwitch]: (input: ProviderAccountsSwitchInput) =>
      observe(WS_METHODS.providerAccountsSwitch, service.switchAccount(input)),
    [WS_METHODS.providerAccountsRename]: (input: ProviderAccountsRenameInput) =>
      observe(WS_METHODS.providerAccountsRename, service.rename(input)),
    [WS_METHODS.providerAccountsRemove]: (input: ProviderAccountsRemoveInput) =>
      observe(WS_METHODS.providerAccountsRemove, service.remove(input)),
  };
}
