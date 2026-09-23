import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderAccount,
  type ProviderAccountDriver,
  type ProviderAccountGroup,
  type ProviderAccountAutoSwitchEvent,
  type ProviderAccountId,
} from "@t3tools/contracts";
import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { serverEnvironment } from "../../state/server";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { AutoSwitchSettings } from "./AutoSwitchSettings";
import { AccountRow } from "./AccountRow";
import { AddAccountPanel } from "./AddAccountPanel";
import {
  ACCOUNT_DRIVERS,
  ACCOUNT_DRIVER_LABELS,
  ACCOUNT_SWITCH_NOTES,
  autoRefreshAccountId,
  bestAccountId,
  sortedAccounts,
  isUsageRefreshCoolingDown,
  USAGE_REFRESH_COOLDOWN_MS,
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
  // Refresh is per account so a click never probes every saved account at once.
  const [manualRefreshedAt, setManualRefreshedAt] = useState<
    ReadonlyMap<ProviderAccountId, number>
  >(() => new Map());
  const [refreshingIds, setRefreshingIds] = useState<ReadonlySet<ProviderAccountId>>(
    () => new Set(),
  );
  const pendingIds = useRef(new Set<ProviderAccountId>());
  const autoPending = useRef(false);
  const nextAutoAt = useRef(0);
  const refreshUsage = useAtomCommand(providerAccountsEnvironment.refreshUsage, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const deviceLabelId = useId();
  const allAccounts = groups.flatMap((group) => group.accounts);
  const refreshAccount = async (account: ProviderAccount) => {
    // The row disables its button during the cooldown; the clock ticks when it expires.
    if (!environmentId || pendingIds.current.has(account.id)) return;
    pendingIds.current.add(account.id);
    setRefreshingIds(new Set(pendingIds.current));
    try {
      // The active account's usage is the live provider snapshot, not a saved-store probe.
      const result = account.active
        ? await refreshProviders({
            environmentId,
            input: {
              instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make(account.driver)),
            },
          })
        : await refreshUsage({
            environmentId,
            input: { accountIds: [account.id], force: true },
          });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Couldn't refresh usage",
          description: failure instanceof Error ? failure.message : "Please try again.",
        });
      }
    } finally {
      pendingIds.current.delete(account.id);
      setRefreshingIds(new Set(pendingIds.current));
      const completedAt = Date.now();
      setManualRefreshedAt((previous) => new Map(previous).set(account.id, completedAt));
      setNow(completedAt);
    }
  };
  // Background refresh probes at most one stale inactive account; the server gate decides.
  const autoRefresh = useEffectEvent((at: number) => {
    if (!environmentId || autoPending.current) return;
    const accountId = autoRefreshAccountId(allAccounts, at);
    if (!accountId || pendingIds.current.has(accountId)) return;
    autoPending.current = true;
    void refreshUsage({ environmentId, input: { accountIds: [accountId] } }).finally(() => {
      autoPending.current = false;
    });
  });
  // Opening the dialog, or a ready account appearing without usage, refreshes right away.
  const openTrigger =
    allAccounts.length === 0
      ? null
      : allAccounts
          .filter((account) => !account.active && account.status === "ready" && !account.usage)
          .map((account) => account.id)
          .join();
  useEffect(() => {
    if (openTrigger !== null) autoRefresh(Date.now());
  }, [openTrigger]);
  useEffect(() => {
    // One clock timer: minute ticks drive labels and the background refresh; an earlier
    // tick is inserted only when a manual refresh cooldown expires.
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const current = Date.now();
      if (nextAutoAt.current === 0) nextAutoAt.current = current + CLOCK_INTERVAL_MS;
      const cooldownEnds = [...manualRefreshedAt.values()]
        .map((at) => at + USAGE_REFRESH_COOLDOWN_MS)
        .filter((end) => end > current);
      timer = setTimeout(
        tick,
        Math.max(0, Math.min(nextAutoAt.current, ...cooldownEnds) - current),
      );
    };
    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (current >= nextAutoAt.current) {
        nextAutoAt.current = current + CLOCK_INTERVAL_MS;
        autoRefresh(current);
      }
      schedule();
    };
    schedule();
    return () => clearTimeout(timer);
  }, [manualRefreshedAt]);
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
            <span className="text-xs text-muted-foreground">
              {!checkedAt
                ? "Never checked"
                : minutes === 0
                  ? "Checked just now"
                  : `Checked ${minutes} min ago`}
            </span>
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
                              refreshing={refreshingIds.has(account.id)}
                              coolingDown={isUsageRefreshCoolingDown(
                                manualRefreshedAt.get(account.id),
                                now,
                              )}
                              {...(account.active || account.status === "ready"
                                ? { onRefreshUsage: () => void refreshAccount(account) }
                                : {})}
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
