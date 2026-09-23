import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderAccountAutoSwitchEvent,
  ProviderAccountDriver,
} from "@t3tools/contracts";
import { TriangleAlertIcon, UsersIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { ClaudeAI, OpenAI } from "../Icons";
import { Badge } from "../ui/badge";
import { Dialog } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AutoSwitchSubscription } from "./AutoSwitchSubscription";
import { AccountSwitcherDialog } from "./AccountSwitcherDialog";
import {
  ACCOUNT_DRIVERS,
  ACCOUNT_DRIVER_LABELS,
  accountTone,
  autoSwitchToastTitle,
  remainingPercent,
  providerAccountsUsageKey,
  shouldShowAccountBadge,
} from "./accounts.logic";
import { providerAccountsEnvironment } from "./state";

export function SidebarAccountSwitcherButton() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [selectedDevice, setSelectedDevice] = useState<EnvironmentId | null>(null);
  const [open, setOpen] = useState(false);
  const [autoEvents, setAutoEvents] = useState<
    ReadonlyMap<
      EnvironmentId,
      Partial<Record<ProviderAccountDriver, ProviderAccountAutoSwitchEvent>>
    >
  >(new Map());
  const lastAutoSwitch = useRef(new Map<string, string>());
  const connectedLabels = useRef(new Map<EnvironmentId, string>());
  const onAutoEvent = useCallback(
    (environmentId: EnvironmentId, event: ProviderAccountAutoSwitchEvent) => {
      // `changed` only invalidates the list in client-runtime. Future tags are not notifications.
      if (event._tag !== "switched" && event._tag !== "pending" && event._tag !== "blocked") return;
      if (event._tag === "switched") {
        const scope = `${environmentId}:${event.driver}`;
        const key = `${event.at}:${event.toAccountId}`;
        // Retain deduplication across disconnect/reconnect subscription remounts.
        if (lastAutoSwitch.current.get(scope) === key) return;
        lastAutoSwitch.current.set(scope, key);
        // More than one device: name the one that switched.
        const connected = connectedLabels.current;
        toastManager.add({
          type: "success",
          title: autoSwitchToastTitle(
            event.driver,
            event.toLabel,
            connected.size > 1 ? connected.get(environmentId) : undefined,
          ),
          description: event.reason,
        });
      }
      setAutoEvents((previous) =>
        new Map(previous).set(environmentId, {
          ...previous.get(environmentId),
          [event.driver]: event,
        }),
      );
    },
    [],
  );
  const connected = [...presentations].filter(
    ([, presentation]) =>
      presentation.connection.phase === "connected" && presentation.serverConfig !== null,
  );
  const connectedKey = JSON.stringify(
    connected.map(([id, presentation]) => [id, presentation.entry.target.label]),
  );
  useEffect(() => {
    connectedLabels.current = new Map(JSON.parse(connectedKey) as [EnvironmentId, string][]);
  }, [connectedKey]);
  // A device the user picked that went offline stays selected until it reconnects.
  const offline =
    selectedDevice && !connected.some(([id]) => id === selectedDevice)
      ? presentations.get(selectedDevice)
      : undefined;
  const selected = offline
    ? undefined
    : (connected.find(([id]) => id === selectedDevice) ?? connected[0]);
  const environmentId = selected?.[0] ?? null;
  const query = useEnvironmentQuery(
    environmentId ? providerAccountsEnvironment.list({ environmentId, input: {} }) : null,
  );
  const devices = connected.map(([id, presentation]) => ({
    id,
    label: presentation.entry.target.label,
  }));
  if (offline && selectedDevice)
    devices.push({ id: selectedDevice, label: offline.entry.target.label });
  const providers = selected?.[1].serverConfig?.providers ?? [];
  const usageKey = providerAccountsUsageKey(providers);
  const observedUsage = useRef<{ environmentId: EnvironmentId | null; key: string } | null>(null);
  const refreshAccounts = query.refresh;
  useEffect(() => {
    const previous = observedUsage.current;
    observedUsage.current = { environmentId, key: usageKey };
    // The initial query (and switching devices) already loads the snapshot.
    if (!environmentId || previous?.environmentId !== environmentId || previous.key === usageKey)
      return;
    const timer = setTimeout(refreshAccounts, 1_000);
    return () => clearTimeout(timer);
  }, [environmentId, usageKey, refreshAccounts, observedUsage]);
  const groups = query.data?.groups ?? [];
  const activeAccounts = ACCOUNT_DRIVERS.flatMap((driver) => {
    const group = groups.find((group) => group.driver === driver);
    if (!group || !shouldShowAccountBadge(group, providers)) return [];
    const active = group.accounts.find((account) => account.active);
    return [{ driver, active }];
  });
  const warning = activeAccounts.flatMap(({ driver, active }) => {
    if (!active || accountTone(active) === "secondary") return [];
    const remaining = remainingPercent(active);
    return [
      `${ACCOUNT_DRIVER_LABELS[driver]}: ${active.status !== "ready" ? "Not ready" : `${Math.round(remaining ?? 0)}% left`}`,
    ];
  });
  return (
    <>
      {connected.map(([id]) => (
        <AutoSwitchSubscription key={id} environmentId={id} onEvent={onAutoEvent} />
      ))}
      <div className="px-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <Tooltip>
              <TooltipTrigger
                render={
                  <SidebarMenuButton aria-haspopup="dialog" onClick={() => setOpen(true)}>
                    <UsersIcon />
                    <span className="shrink-0">Accounts</span>
                    <span className="ml-auto flex min-w-0 gap-1 group-data-[collapsible=icon]:hidden">
                      {groups.some((group) => group.autoSwitch.enabled) ? (
                        <Badge size="sm" variant="outline">
                          Auto
                        </Badge>
                      ) : null}
                      {activeAccounts.map(({ driver, active }) => {
                        const Mark = driver === "claudeAgent" ? ClaudeAI : OpenAI;
                        return (
                          <Badge
                            key={driver}
                            className="min-w-0 shrink"
                            size="sm"
                            variant={active ? accountTone(active) : "error"}
                          >
                            <Mark className="size-3" />
                            {!active || active.status !== "ready" ? (
                              <TriangleAlertIcon className="size-3" />
                            ) : null}
                            <span className="max-w-[12ch] truncate">
                              {active?.label || active?.email?.split("@")[0] || "Not ready"}
                            </span>
                          </Badge>
                        );
                      })}
                    </span>
                  </SidebarMenuButton>
                }
              />
              <TooltipPopup side="right">
                Switch Claude or Codex account{warning.length ? ` · ${warning.join(" · ")}` : ""}
              </TooltipPopup>
            </Tooltip>
          </SidebarMenuItem>
        </SidebarMenu>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <AccountSwitcherDialog
            key={(offline ? selectedDevice : environmentId) ?? "disconnected"}
            environmentId={offline ? selectedDevice : environmentId}
            offlineDeviceLabel={offline?.entry.target.label}
            devices={devices}
            onDeviceChange={setSelectedDevice}
            groups={groups}
            autoEvents={environmentId ? autoEvents.get(environmentId) : undefined}
            loading={query.isPending}
            error={query.error}
            onRetry={query.refresh}
          />
        ) : null}
      </Dialog>
    </>
  );
}
