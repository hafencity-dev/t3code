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
import {
  ACCOUNT_DRIVER_LABELS,
  autoSwitchEndgameBadge,
  autoSwitchInput,
  autoSwitchNowBlockedReason,
  autoSwitchStatus,
  formatAgo,
} from "./accounts.logic";
import { providerAccountsEnvironment } from "./state";
import { SwitchAccountAction } from "./SwitchAccountAction";
import { WindowPrimerRow } from "./WindowPrimerRow";

const SESSION_THRESHOLDS = [5, 10, 15, 20, 25];
const WEEKLY_THRESHOLDS = [1, 2, 3, 5, 10];

/** A percent-left select; a value saved outside the presets still shows. */
function ThresholdSelect({
  value,
  options,
  disabled,
  label,
  onChange,
}: {
  value: number;
  options: readonly number[];
  disabled: boolean;
  label: string;
  onChange: (value: number) => void;
}) {
  const values = [...new Set([...options, value])].sort((a, b) => a - b);
  return (
    <Select
      value={value}
      disabled={disabled}
      items={values.map((item) => ({ value: item, label: `${item}%` }))}
      onValueChange={(next) => {
        if (next !== null && next !== value) onChange(next);
      }}
    >
      <SelectTrigger size="xs" className="w-24 min-w-24 shrink-0" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {values.map((item) => (
          <SelectItem key={item} value={item}>
            {item}%
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Two fixed lines at the bottom of a provider card: the toggle and thresholds, then status.
 * Claude cards add two more for starting 5-hour windows automatically.
 */
export function AutoSwitchBar({
  group,
  environmentId,
  event,
  now,
  readyCount,
  switchingId,
  onSwitchStart,
  onSwitchEnd,
}: {
  group: ProviderAccountGroup;
  environmentId: EnvironmentId;
  event?: ProviderAccountAutoSwitchEvent | undefined;
  now: number;
  readyCount: number;
  /** The account a switch started from anywhere in this section is moving to. */
  switchingId: ProviderAccountId | null;
  onSwitchStart: (accountId: ProviderAccountId) => void;
  onSwitchEnd: (accountId: ProviderAccountId) => void;
}) {
  const { autoSwitch } = group;
  const labelId = useId();
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const setAutoSwitch = useAtomCommand(providerAccountsEnvironment.setAutoSwitch, {
    reportFailure: false,
  });
  const provider = ACCOUNT_DRIVER_LABELS[group.driver];
  const update = async (enabled: boolean, thresholds?: Parameters<typeof autoSwitchInput>[3]) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    try {
      const result = await setAutoSwitch({
        environmentId,
        input: autoSwitchInput(group.driver, enabled, autoSwitch, thresholds),
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
  const endgameBadge = autoSwitchEndgameBadge(autoSwitch);
  // Turning it off is always allowed; only turning it on can be blocked.
  const enableBlockedReason = autoSwitch.enabled
    ? undefined
    : group.warning
      ? "Switching is paused. See the warning above."
      : readyCount < 2
        ? "Add a second signed-in account to use auto-switch."
        : undefined;
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
      {/* Wraps between whole label + select pairs, so a label never truncates. */}
      <div className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <span className="inline-flex shrink-0 items-center gap-2">
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
        </span>
        {autoSwitch.enabled ? (
          <>
            <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-muted-foreground">
              5-hour at
              <ThresholdSelect
                value={autoSwitch.thresholdPercent}
                options={SESSION_THRESHOLDS}
                disabled={saving}
                label={`${provider} 5-hour auto-switch threshold`}
                onChange={(thresholdPercent) => void update(true, { thresholdPercent })}
              />
            </span>
            <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-muted-foreground">
              <Tooltip>
                <TooltipTrigger render={<span />}>Weekly at</TooltipTrigger>
                <TooltipPopup>
                  Switches before the weekly limit runs out, so no chat stops mid-turn.
                </TooltipPopup>
              </Tooltip>
              <ThresholdSelect
                value={autoSwitch.weeklyThresholdPercent}
                options={WEEKLY_THRESHOLDS}
                disabled={saving}
                label={`${provider} weekly auto-switch threshold`}
                onChange={(weeklyThresholdPercent) => void update(true, { weeklyThresholdPercent })}
              />
            </span>
          </>
        ) : null}
        {status.badge ? (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1">
            {endgameBadge ? (
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex" />}>
                  <Badge variant={endgameBadge.variant} size="sm">
                    {endgameBadge.label}
                  </Badge>
                </TooltipTrigger>
                <TooltipPopup>
                  Every account is low, so each one runs down to 1% of its weekly limit before
                  switching, soonest weekly reset first.
                </TooltipPopup>
              </Tooltip>
            ) : null}
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
              busy={switchingId === status.target.id}
              disabledReason={autoSwitchNowBlockedReason(group, switchingId, status.target.id)}
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
      {group.windowPrimer ? (
        <WindowPrimerRow
          primer={group.windowPrimer}
          accounts={group.accounts}
          environmentId={environmentId}
          now={now}
        />
      ) : null}
    </div>
  );
}
