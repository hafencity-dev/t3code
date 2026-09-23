import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderAccountAutoSwitchEvent,
  ProviderAccountGroup,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/usageLimits";
import { useId, useRef, useState } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ACCOUNT_DRIVER_LABELS, pendingAutoSwitchAccount } from "./accounts.logic";
import { providerAccountsEnvironment } from "./state";
import { SwitchAccountAction } from "./SwitchAccountAction";

export function AutoSwitchSettings({
  group,
  environmentId,
  event,
  now,
}: {
  group: ProviderAccountGroup;
  environmentId: EnvironmentId;
  event?: ProviderAccountAutoSwitchEvent | undefined;
  now: number;
}) {
  const { autoSwitch } = group;
  const labelId = useId();
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const setAutoSwitch = useAtomCommand(providerAccountsEnvironment.setAutoSwitch, {
    reportFailure: false,
  });
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
  const target = pendingAutoSwitchAccount(group);
  const message =
    group.switchMode === "hot" && autoSwitch.state === "pending" ? undefined : autoSwitch.message;
  const running =
    event?._tag === "pending" && event.toAccountId === target?.id ? event.runningTurnCount : null;
  const thresholds = [...new Set([5, 10, 15, 20, 25, autoSwitch.thresholdPercent])].sort(
    (a, b) => a - b,
  );
  const lastSwitch = autoSwitch.lastSwitch;
  const age = lastSwitch ? Math.max(0, now - Date.parse(lastSwitch.at)) : 0;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Tooltip>
          <TooltipTrigger render={<span className="flex items-center gap-2" />}>
            <Switch
              size="sm"
              checked={autoSwitch.enabled}
              disabled={saving}
              aria-labelledby={labelId}
              onCheckedChange={(enabled) => void update(enabled)}
            />
            <span id={labelId} className="text-xs">
              Auto-switch<span className="sr-only"> {ACCOUNT_DRIVER_LABELS[group.driver]}</span>
            </span>
          </TooltipTrigger>
          <TooltipPopup>
            Automatically switches when the active account runs low. Prefers accounts whose weekly
            limit resets soonest so no quota goes unused. Never interrupts a running turn.
          </TooltipPopup>
        </Tooltip>
        {autoSwitch.enabled ? (
          <Select
            value={autoSwitch.thresholdPercent}
            disabled={saving}
            items={thresholds.map((value) => ({ value, label: `at ${value}% left` }))}
            onValueChange={(value) => {
              if (value !== null) void update(true, value);
            }}
          >
            <SelectTrigger
              size="xs"
              aria-label={`${ACCOUNT_DRIVER_LABELS[group.driver]} auto-switch threshold`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {thresholds.map((value) => (
                <SelectItem key={value} value={value}>
                  at {value}% left
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        {saving ? <Spinner size="xs" /> : null}
      </div>
      {target ? (
        <div className="grid gap-2">
          <p className="text-xs text-muted-foreground">
            Will switch to {target.label} when{" "}
            {running === null
              ? "running turns finish"
              : `${running} running turn${running === 1 ? " finishes" : "s finish"}`}
            .
          </p>
          <div>
            <SwitchAccountAction
              environmentId={environmentId}
              switchMode={group.switchMode}
              accountId={target.id}
              label={target.label}
              stopRunning
            >
              Stop and switch
            </SwitchAccountAction>
          </div>
        </div>
      ) : message || lastSwitch ? (
        <p className="text-xs text-muted-foreground">
          {message ??
            `Last auto-switch ${age < 60_000 ? "just now" : `${formatDuration(age)} ago`}: ${lastSwitch?.reason}`}
        </p>
      ) : null}
    </div>
  );
}
