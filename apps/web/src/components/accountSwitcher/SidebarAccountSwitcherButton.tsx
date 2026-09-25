import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { TriangleAlertIcon, UsersIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { ClaudeAI, OpenAI } from "../Icons";
import { Badge } from "../ui/badge";
import { Dialog } from "../ui/dialog";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { autoSwitchEventsAtom } from "./AutoSwitchSubscription";
import { AccountSwitcherDialog } from "./AccountSwitcherDialog";
import {
  ACCOUNT_DRIVERS,
  ACCOUNT_DRIVER_LABELS,
  accountTone,
  remainingPercent,
  providerAccountsUsageKey,
  resolveAccountsDevice,
  shouldShowAccountBadge,
} from "./accounts.logic";
import { providerAccountsEnvironment } from "./state";

export function SidebarAccountSwitcherButton() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const autoEvents = useAtomValue(autoSwitchEventsAtom);
  const [selectedDevice, setSelectedDevice] = useState<EnvironmentId | null>(null);
  const [open, setOpen] = useState(false);
  const connected = [...presentations].filter(
    ([, presentation]) =>
      presentation.connection.phase === "connected" && presentation.serverConfig !== null,
  );
  // While the dialog is open a device that drops stays selected and reads as offline.
  const { environmentId, offlineId } = resolveAccountsDevice(
    selectedDevice,
    connected.map(([id]) => id),
    open,
  );
  const selected = connected.find(([id]) => id === environmentId);
  const offlineLabel = offlineId
    ? (presentations.get(offlineId)?.entry.target.label ?? "This device")
    : undefined;
  const query = useEnvironmentQuery(
    environmentId ? providerAccountsEnvironment.list({ environmentId, input: {} }) : null,
  );
  const devices = connected.map(([id, presentation]) => ({
    id,
    label: presentation.entry.target.label,
  }));
  if (offlineId && offlineLabel) devices.push({ id: offlineId, label: offlineLabel });
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
  // oxlint-disable-next-line react/purity -- No timer while the dialog is closed: tones are re-read on every list or provider update.
  const now = Date.now();
  const activeAccounts = ACCOUNT_DRIVERS.flatMap((driver) => {
    const group = groups.find((group) => group.driver === driver);
    if (!group || !shouldShowAccountBadge(group, providers, now)) return [];
    const active = group.accounts.find((account) => account.active);
    return [{ driver, active }];
  });
  const warning = activeAccounts.flatMap(({ driver, active }) => {
    if (!active || accountTone(active, now) === "secondary") return [];
    const remaining = remainingPercent(active, now);
    return [
      `${ACCOUNT_DRIVER_LABELS[driver]}: ${active.status !== "ready" ? "Not ready" : `${Math.round(remaining ?? 0)}% left`}`,
    ];
  });
  return (
    <>
      <div className="px-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <Tooltip>
              <TooltipTrigger
                render={
                  <SidebarMenuButton
                    aria-haspopup="dialog"
                    onClick={() => {
                      // Pin what the sidebar shows now; a drop while open reads as offline.
                      setSelectedDevice(environmentId);
                      setOpen(true);
                    }}
                  >
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
                            variant={active ? accountTone(active, now) : "error"}
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
            key={offlineId ?? environmentId ?? "disconnected"}
            environmentId={offlineId ?? environmentId}
            offlineDeviceLabel={offlineLabel}
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
