// fork: provider accounts
import {
  WS_METHODS,
  type ProviderAccountsRefreshUsageInput,
  type ProviderAccountsStartLoginInput,
  type ProviderAccountsSubmitLoginCodeInput,
  type ProviderAccountsCancelLoginInput,
  type ProviderAccountsSwitchInput,
  type ProviderAccountsRenameInput,
  type ProviderAccountsRemoveInput,
  type ProviderAccountsSetAutoSwitchInput,
  type ProviderAccountsSetWindowPrimerInput,
  type ProviderAccountsActivityInput,
  type ProviderAccountsSetAutoSwitchExcludedInput,
} from "@t3tools/contracts";
import type { ProviderAccountsService } from "./ProviderAccountsService.ts";

export function makeProviderAccountsRpcHandlers(deps: {
  readonly providerAccounts: ProviderAccountsService["Service"];
  readonly currentSessionId: string;
}) {
  const { providerAccounts: service, currentSessionId: owner } = deps;
  return {
    [WS_METHODS.providerAccountsSetAutoSwitch]: (input: ProviderAccountsSetAutoSwitchInput) =>
      service.setAutoSwitch(input),
    [WS_METHODS.providerAccountsSetWindowPrimer]: (input: ProviderAccountsSetWindowPrimerInput) =>
      service.setWindowPrimer(input),
    [WS_METHODS.providerAccountsAutoSwitchEvents]: () => service.autoSwitchEvents,
    [WS_METHODS.providerAccountsList]: () => service.list(),
    [WS_METHODS.providerAccountsRefreshUsage]: (input: ProviderAccountsRefreshUsageInput) =>
      service.refreshUsage(input),
    [WS_METHODS.providerAccountsStartLogin]: (input: ProviderAccountsStartLoginInput) =>
      service.startLogin(owner, input),
    [WS_METHODS.providerAccountsSubmitLoginCode]: (input: ProviderAccountsSubmitLoginCodeInput) =>
      service.submitLoginCode(owner, input),
    [WS_METHODS.providerAccountsCancelLogin]: (input: ProviderAccountsCancelLoginInput) =>
      service.cancelLogin(owner, input),
    [WS_METHODS.providerAccountsSwitch]: (input: ProviderAccountsSwitchInput) =>
      service.switchAccount(input),
    [WS_METHODS.providerAccountsRename]: (input: ProviderAccountsRenameInput) =>
      service.rename(input),
    [WS_METHODS.providerAccountsRemove]: (input: ProviderAccountsRemoveInput) =>
      service.remove(input),
    [WS_METHODS.providerAccountsActivity]: (input: ProviderAccountsActivityInput) =>
      service.activity(input),
    [WS_METHODS.providerAccountsSetAutoSwitchExcluded]: (
      input: ProviderAccountsSetAutoSwitchExcludedInput,
    ) => service.setAutoSwitchExcluded(input),
  };
}
