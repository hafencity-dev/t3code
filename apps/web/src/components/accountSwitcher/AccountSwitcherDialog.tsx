import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderAccount,
  ProviderAccountDriver,
  ProviderAccountGroup,
  ProviderAccountAutoSwitchEvent,
} from "@t3tools/contracts";
import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import { ClaudeAI, OpenAI } from "../Icons";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AutoSwitchSettings } from "./AutoSwitchSettings";
import { AccountRow } from "./AccountRow";
import { AddAccountPanel } from "./AddAccountPanel";
import {
  ACCOUNT_DRIVERS,
  ACCOUNT_DRIVER_LABELS,
  ACCOUNT_SWITCH_NOTES,
  bestAccountId,
  sortedAccounts,
  isUsageRefreshCoolingDown,
} from "./accounts.logic";
import { providerAccountsEnvironment } from "./state";

const CLOCK_INTERVAL_MS = 60_000;

export function AccountSwitcherDialog({
  environmentId,
  devices,
  onDeviceChange,
  groups,
  autoEvents,
  loading,
  error,
  onRetry,
}: {
  environmentId: EnvironmentId | null;
  devices: readonly { id: EnvironmentId; label: string }[];
  onDeviceChange: (id: EnvironmentId) => void;
  groups: readonly ProviderAccountGroup[];
  autoEvents?: Partial<Record<ProviderAccountDriver, ProviderAccountAutoSwitchEvent>> | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const [login, setLogin] = useState<{
    driver: ProviderAccountDriver;
    switchMode: ProviderAccountGroup["switchMode"];
    account?: ProviderAccount;
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const coolingDown = isUsageRefreshCoolingDown(lastRefreshedAt, now);
  const refreshPending = useRef(false);
  const refreshUsage = useAtomCommand(providerAccountsEnvironment.refreshUsage, {
    reportFailure: false,
  });
  const deviceLabelId = useId();
  const refresh = async (force = false) => {
    if (
      !environmentId ||
      refreshPending.current ||
      isUsageRefreshCoolingDown(lastRefreshedAt, Date.now())
    )
      return;
    refreshPending.current = true;
    setRefreshing(true);
    try {
      const result = await refreshUsage({ environmentId, input: { force } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Couldn't refresh usage",
          description: failure instanceof Error ? failure.message : "Please try again.",
        });
      }
    } finally {
      refreshPending.current = false;
      setRefreshing(false);
      const completedAt = Date.now();
      setLastRefreshedAt(completedAt);
      setNow(completedAt);
    }
  };
  const refreshOnOpen = useEffectEvent(() => {
    void refresh();
  });
  useEffect(() => {
    refreshOnOpen();
  }, []);
  useEffect(() => {
    // One clock timer: align its next tick to cooldown expiry, then resume minute ticks.
    const nextTickAt = (lastRefreshedAt ?? Date.now()) + CLOCK_INTERVAL_MS;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      timer = setTimeout(tick, CLOCK_INTERVAL_MS);
    };
    timer = setTimeout(tick, Math.max(0, nextTickAt - Date.now()));
    return () => clearTimeout(timer);
  }, [lastRefreshedAt]);
  const checkedAt = Math.max(
    0,
    ...groups.flatMap((group) =>
      group.accounts.flatMap((account) =>
        account.usage ? [Date.parse(account.usage.checkedAt)] : [],
      ),
    ),
  );
  const minutes = Math.max(0, Math.floor((now - checkedAt) / 60_000));
  return (
    <DialogPopup className="sm:max-w-xl">
      {login && environmentId ? (
        <AddAccountPanel
          environmentId={environmentId}
          driver={login.driver}
          switchMode={login.switchMode}
          {...(login.account ? { account: login.account } : {})}
          onBack={() => setLogin(null)}
        />
      ) : (
        <>
          <DialogHeader>
            <DialogTitle>Accounts</DialogTitle>
            <DialogDescription>
              Switch the account new turns use. Threads keep their history and continue on the new
              account.
            </DialogDescription>
            <div className="flex flex-wrap items-center gap-2">
              <Tooltip>
                <TooltipTrigger render={<span />}>
                  <Button
                    variant="ghost-muted"
                    size="xs"
                    disabled={!environmentId || refreshing || coolingDown}
                    onClick={() => void refresh(true)}
                  >
                    <RefreshIcon refreshing={refreshing} />
                    Refresh usage
                  </Button>
                </TooltipTrigger>
                <TooltipPopup>
                  {coolingDown ? "Usage was refreshed moments ago" : "Refresh usage"}
                </TooltipPopup>
              </Tooltip>
              <span className="text-xs text-muted-foreground">
                {!checkedAt
                  ? "Never checked"
                  : minutes === 0
                    ? "Checked just now"
                    : `Checked ${minutes} min ago`}
              </span>
            </div>
          </DialogHeader>
          <DialogPanel>
            {devices.length > 1 ? (
              <div className="flex items-center gap-3">
                <span id={deviceLabelId} className="text-sm">
                  Device
                </span>
                <div className="min-w-0 flex-1">
                  <Select
                    value={environmentId}
                    items={devices.map((device) => ({ value: device.id, label: device.label }))}
                    onValueChange={(id) => {
                      if (id) onDeviceChange(id);
                    }}
                  >
                    <SelectTrigger aria-labelledby={deviceLabelId}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {devices.map((device) => (
                        <SelectItem key={device.id} value={device.id}>
                          {device.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>
            ) : null}
            {!environmentId ? (
              <Alert variant="warning">
                <TriangleAlertIcon />
                <AlertDescription>Connect to a device to manage accounts.</AlertDescription>
              </Alert>
            ) : (
              <>
                {error ? (
                  <div className="grid gap-2">
                    <Alert variant="error">
                      <TriangleAlertIcon />
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                    <div>
                      <Button variant="outline" size="xs" onClick={onRetry}>
                        Try again
                      </Button>
                    </div>
                  </div>
                ) : null}
                {loading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner size="sm" />
                    Loading accounts…
                  </div>
                ) : null}
                {ACCOUNT_DRIVERS.map((driver) => {
                  const group = groups.find((group) => group.driver === driver);
                  const accounts = group?.accounts ?? [];
                  const warning = group?.warning;
                  const best = bestAccountId(accounts);
                  const Mark = driver === "claudeAgent" ? ClaudeAI : OpenAI;
                  return (
                    <section
                      key={driver}
                      className="grid gap-3"
                      aria-label={ACCOUNT_DRIVER_LABELS[driver]}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Mark className="size-4" />
                        <h3 className="text-sm font-medium">{ACCOUNT_DRIVER_LABELS[driver]}</h3>
                        <Badge variant="outline" size="sm">
                          {accounts.length} accounts
                        </Badge>
                        <div className="ml-auto">
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={!group}
                            onClick={() => {
                              if (group) setLogin({ driver, switchMode: group.switchMode });
                            }}
                          >
                            <PlusIcon />
                            Add account
                          </Button>
                        </div>
                      </div>
                      {group ? (
                        <AutoSwitchSettings
                          group={group}
                          environmentId={environmentId}
                          event={autoEvents?.[driver]}
                          now={now}
                        />
                      ) : null}
                      {warning ? (
                        <Alert variant="warning">
                          <TriangleAlertIcon />
                          <AlertDescription>{warning}</AlertDescription>
                        </Alert>
                      ) : null}
                      {group
                        ? sortedAccounts(accounts).map((account) => (
                            <AccountRow
                              key={account.id}
                              account={account}
                              switchMode={group.switchMode}
                              environmentId={environmentId}
                              now={now}
                              best={best === account.id}
                              onSignIn={(account) =>
                                setLogin({ driver, account, switchMode: group.switchMode })
                              }
                            />
                          ))
                        : null}
                      {!loading && !error && accounts.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No {ACCOUNT_DRIVER_LABELS[driver]} accounts yet.
                        </p>
                      ) : null}
                      {group ? (
                        <p className="text-xs text-muted-foreground">
                          {ACCOUNT_SWITCH_NOTES[group.switchMode]}
                          {group.switchMode === "hot"
                            ? " On macOS, this may take up to 30 seconds."
                            : null}
                        </p>
                      ) : null}
                    </section>
                  );
                })}
              </>
            )}
          </DialogPanel>
          <DialogFooter>
            <p className="mr-auto text-xs text-muted-foreground">
              Accounts are stored on this device.
            </p>
            <DialogClose render={<Button variant="outline" size="sm" />}>Done</DialogClose>
          </DialogFooter>
        </>
      )}
    </DialogPopup>
  );
}
