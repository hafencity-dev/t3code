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
import { MonitorIcon, TriangleAlertIcon, UnplugIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  ACCOUNT_DRIVERS,
  autoRefreshAccountId,
  USAGE_REFRESH_COOLDOWN_MS,
  usageResetKey,
} from "./accounts.logic";
import { ProviderAccountsSection } from "./ProviderAccountsSection";
import { providerAccountsEnvironment } from "./state";

const CLOCK_INTERVAL_MS = 60_000;

/**
 * Mounted only while the dialog is open. Owns the single clock timer and the refresh
 * bookkeeping; refreshes are always per account, never bulk.
 */
export function AccountSwitcherDialog({
  environmentId,
  devices,
  onDeviceChange,
  groups,
  autoEvents,
  loading,
  error,
  onRetry,
  offlineDeviceLabel,
}: {
  environmentId: EnvironmentId | null;
  devices: readonly { id: EnvironmentId; label: string }[];
  onDeviceChange: (id: EnvironmentId) => void;
  groups: readonly ProviderAccountGroup[];
  autoEvents?: Partial<Record<ProviderAccountDriver, ProviderAccountAutoSwitchEvent>> | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Set when the selected device went offline; only the selector stays usable. */
  offlineDeviceLabel?: string | undefined;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  // Refresh is per account so a click never probes every saved account at once.
  const [manualRefreshedAt, setManualRefreshedAt] = useState<
    ReadonlyMap<ProviderAccountId, number>
  >(() => new Map());
  // Manual and background refreshes both show `Checking…` on their row.
  const [refreshingIds, setRefreshingIds] = useState<ReadonlySet<ProviderAccountId>>(
    () => new Set(),
  );
  const pendingIds = useRef(new Set<ProviderAccountId>());
  // Reset keys the active account was already refreshed for: one live refresh per reset.
  const [resetChecksAttempted, setResetChecksAttempted] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const autoPending = useRef(false);
  const nextAutoAt = useRef(0);
  const refreshUsage = useAtomCommand(providerAccountsEnvironment.refreshUsage, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const allAccounts = groups.flatMap((group) => group.accounts);
  const track = (accountId: ProviderAccountId, pending: boolean) => {
    if (pending) pendingIds.current.add(accountId);
    else pendingIds.current.delete(accountId);
    setRefreshingIds(new Set(pendingIds.current));
  };
  // The active account's usage is the live provider snapshot, not a saved-store probe.
  const refreshActive = (target: EnvironmentId, account: ProviderAccount) =>
    refreshProviders({
      environmentId: target,
      input: { instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make(account.driver)) },
    });
  const refreshAccount = async (account: ProviderAccount) => {
    // The row disables its button during the cooldown; the clock ticks when it expires.
    if (!environmentId || pendingIds.current.has(account.id)) return;
    track(account.id, true);
    try {
      const result = account.active
        ? await refreshActive(environmentId, account)
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
      track(account.id, false);
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
    track(accountId, true);
    void refreshUsage({ environmentId, input: { accountIds: [accountId] } }).finally(() => {
      autoPending.current = false;
      track(accountId, false);
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
  // A window of the active account reset after its last measurement: refresh it once, so
  // `checking…` next to the reset is true. Failures fall back to `not checked yet`.
  const activeResetKeys = allAccounts.flatMap((account) => {
    const key = account.active ? usageResetKey(account, now) : null;
    return key === null || resetChecksAttempted.has(key) ? [] : [{ account, key }];
  });
  const activeResetTrigger = activeResetKeys.map(({ key }) => key).join();
  const refreshActiveResets = useEffectEvent(() => {
    if (!environmentId) return;
    const due = activeResetKeys.filter(({ account }) => !pendingIds.current.has(account.id));
    if (due.length === 0) return;
    setResetChecksAttempted((previous) => new Set([...previous, ...due.map(({ key }) => key)]));
    for (const { account } of due) {
      track(account.id, true);
      void refreshActive(environmentId, account).finally(() => track(account.id, false));
    }
  });
  useEffect(() => {
    if (activeResetTrigger) refreshActiveResets();
  }, [activeResetTrigger]);
  // Server gates (per-account backoff plus the global probe budget) end on their own clock.
  const gateEndsKey = allAccounts
    .map((account) => account.usageRefresh?.nextAllowedAt)
    .filter((at): at is string => at !== undefined)
    .join();
  useEffect(() => {
    // One clock timer: minute ticks drive labels and the background refresh; an earlier
    // tick is inserted only when a manual refresh cooldown expires.
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const current = Date.now();
      if (nextAutoAt.current === 0) nextAutoAt.current = current + CLOCK_INTERVAL_MS;
      const cooldownEnds = [
        ...[...manualRefreshedAt.values()].map((at) => at + USAGE_REFRESH_COOLDOWN_MS),
        ...(gateEndsKey ? gateEndsKey.split(",").map((at) => Date.parse(at)) : []),
      ].filter((end) => end > current);
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
  }, [manualRefreshedAt, gateEndsKey]);
  const cooldownUntil = new Map(
    [...manualRefreshedAt].map(([id, at]) => [id, at + USAGE_REFRESH_COOLDOWN_MS] as const),
  );
  const device = devices.find((candidate) => candidate.id === environmentId);
  const deviceLabel = device?.label ?? offlineDeviceLabel ?? "this device";
  const body = offlineDeviceLabel ? (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <UnplugIcon />
        </EmptyMedia>
        <EmptyTitle>{offlineDeviceLabel} is offline</EmptyTitle>
        <EmptyDescription>Accounts appear again when it reconnects.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : !environmentId ? (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <UnplugIcon />
        </EmptyMedia>
        <EmptyTitle>No device connected</EmptyTitle>
        <EmptyDescription>Connect to a T3 Code server to manage its accounts.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : groups.length === 0 && error ? (
    <Alert variant="error">
      <TriangleAlertIcon />
      <AlertTitle>Couldn't load accounts</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
      <AlertAction>
        <Button variant="outline" size="xs" onClick={onRetry}>
          Try again
        </Button>
      </AlertAction>
    </Alert>
  ) : groups.length === 0 && loading ? (
    <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
      <Spinner size="sm" />
      Loading accounts…
    </p>
  ) : (
    <div className="grid gap-6">
      {ACCOUNT_DRIVERS.map((driver) => (
        <ProviderAccountsSection
          key={driver}
          driver={driver}
          group={groups.find((group) => group.driver === driver)}
          environmentId={environmentId}
          deviceLabel={deviceLabel}
          now={now}
          refreshingIds={refreshingIds}
          cooldownUntil={cooldownUntil}
          resetChecksAttempted={resetChecksAttempted}
          onRefresh={(account) => void refreshAccount(account)}
          autoEvent={autoEvents?.[driver]}
        />
      ))}
    </div>
  );
  return (
    <DialogPopup ref={popupRef} initialFocus={popupRef} className="sm:max-w-4xl">
      <DialogHeader>
        <DialogTitle>Accounts</DialogTitle>
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <DialogDescription className="min-w-0 flex-1">
            Switch which account Claude Code and Codex use. Threads keep their history.
          </DialogDescription>
          {devices.length > 1 ? (
            <div className="w-56 shrink-0 max-sm:w-full">
              <Select
                value={environmentId ?? devices[0]?.id ?? null}
                items={devices.map((candidate) => ({
                  value: candidate.id,
                  label: candidate.label,
                }))}
                onValueChange={(id) => {
                  if (id) onDeviceChange(id);
                }}
              >
                <SelectTrigger size="sm" aria-label="Device">
                  <MonitorIcon aria-hidden />
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {devices.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
        </div>
      </DialogHeader>
      <DialogPanel>{body}</DialogPanel>
      <DialogFooter>
        {environmentId || offlineDeviceLabel ? (
          <p className="mr-auto text-xs text-muted-foreground">
            Logins are stored on {deviceLabel} and never leave it.
          </p>
        ) : null}
        <DialogClose render={<Button variant="outline" size="sm" />}>Done</DialogClose>
      </DialogFooter>
    </DialogPopup>
  );
}
