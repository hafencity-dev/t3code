import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderAccountAutoSwitchEvent,
  ProviderAccountGroup,
  ProviderAccountId,
} from "@t3tools/contracts";
import { useId, useRef, useState } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ACCOUNT_DRIVER_LABELS, autoSwitchStatus, formatAgo } from "./accounts.logic";
import { providerAccountsEnvironment } from "./state";
import { SwitchAccountAction } from "./SwitchAccountAction";

/** Two fixed lines at the bottom of a provider card: the toggle and threshold, then status. */
export function AutoSwitchBar({
  group,
  environmentId,
  event,
  now,
  readyCount,
  onSwitchStart,
  onSwitchEnd,
}: {
  group: ProviderAccountGroup;
  environmentId: EnvironmentId;
  event?: ProviderAccountAutoSwitchEvent | undefined;
  now: number;
  readyCount: number;
  onSwitchStart: (accountId: ProviderAccountId) => void;
  onSwitchEnd: () => void;
}) {
  const { autoSwitch } = group;
  const labelId = useId();
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const setAutoSwitch = useAtomCommand(providerAccountsEnvironment.setAutoSwitch, {
    reportFailure: false,
  });
  const provider = ACCOUNT_DRIVER_LABELS[group.driver];
  const update = async (enabled: boolean, thresholdPercent = autoSwitch.thresholdPercent) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    try {
      const result = await setAutoSwitch({
        environmentId,
        input: { driver: group.driver, enabled, thresholdPercent },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Couldn't update auto-switch",
          description: error instanceof Error ? error.message : "Please try again.",
        });
      }
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  const status = autoSwitchStatus(group, event);
  // Turning it off is always allowed; only turning it on can be blocked.
  const enableBlockedReason = autoSwitch.enabled
    ? undefined
    : group.warning
      ? "Switching is paused. See the warning above."
      : readyCount < 2
        ? "Add a second signed-in account to use auto-switch."
        : undefined;
  const thresholds = [...new Set([5, 10, 15, 20, 25, autoSwitch.thresholdPercent])].sort(
    (a, b) => a - b,
  );
  const lastSwitch = status.showLastSwitch ? autoSwitch.lastSwitch : undefined;
  const labelOf = (id: ProviderAccountId) =>
    group.accounts.find((account) => account.id === id)?.label ?? "a removed account";
  const toggle = (
    <Switch
      size="sm"
      checked={autoSwitch.enabled}
      disabled={saving || Boolean(enableBlockedReason)}
      aria-labelledby={labelId}
      onCheckedChange={(enabled) => void update(enabled)}
    />
  );
  return (
    <div className="grid gap-1.5 bg-muted/30 px-3 py-2.5">
      <div className="flex min-h-6 min-w-0 items-center gap-2 text-xs">
        {enableBlockedReason ? (
          <Tooltip>
            <TooltipTrigger render={<span tabIndex={0} className="inline-flex" />}>
              {toggle}
            </TooltipTrigger>
            <TooltipPopup>{enableBlockedReason}</TooltipPopup>
          </Tooltip>
        ) : (
          toggle
        )}
        <Tooltip>
          <TooltipTrigger render={<span id={labelId} className="font-medium" />}>
            Auto-switch<span className="sr-only"> {provider}</span>
          </TooltipTrigger>
          <TooltipPopup>
            Switches when the active account runs low. Prefers accounts whose weekly limit resets
            soonest so no quota goes unused.
            {group.switchMode === "restart" ? " Never interrupts a running turn." : null}
          </TooltipPopup>
        </Tooltip>
        {autoSwitch.enabled ? (
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <span className="truncate">when the active account has</span>
            <Select
              value={autoSwitch.thresholdPercent}
              disabled={saving}
              items={thresholds.map((value) => ({ value, label: `${value}%` }))}
              onValueChange={(value) => {
                if (value !== null) void update(true, value);
              }}
            >
              <SelectTrigger size="xs" aria-label={`${provider} auto-switch threshold`}>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {thresholds.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}%
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <span>left</span>
          </span>
        ) : null}
        {status.badge ? (
          <span className="ml-auto shrink-0">
            <Badge variant={status.badge.variant} size="sm">
              {status.badge.label}
            </Badge>
          </span>
        ) : null}
      </div>
      <div className="flex min-h-6 min-w-0 items-center gap-3 text-xs text-muted-foreground">
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
            {status.text}
          </TooltipTrigger>
          <TooltipPopup>{status.text}</TooltipPopup>
        </Tooltip>
        {status.target ? (
          <span className="shrink-0">
            <SwitchAccountAction
              environmentId={environmentId}
              switchMode={group.switchMode}
              accountId={status.target.id}
              label={status.target.label}
              variant="outline"
              disabledReason={
                group.warning ? "Switching is paused. See the warning above." : undefined
              }
              onStart={onSwitchStart}
              onEnd={onSwitchEnd}
            >
              Switch now
            </SwitchAccountAction>
          </span>
        ) : lastSwitch ? (
          <Tooltip>
            <TooltipTrigger render={<span className="shrink-0" />}>
              Last switch {formatAgo(now - Date.parse(lastSwitch.at), true)}
            </TooltipTrigger>
            <TooltipPopup>
              {labelOf(lastSwitch.fromAccountId)} → {labelOf(lastSwitch.toAccountId)},{" "}
              {new Date(lastSwitch.at).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
              . {lastSwitch.reason}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
